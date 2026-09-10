import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * What a run actually did to a file.
 *
 * The artifact list has always said which files were touched and nothing else, so "what did
 * this run change" could not be answered from the UI at all. It is fetched a file at a time,
 * because a run that touched forty files must not put forty diffs on the wire to render a
 * list of forty names.
 */

let harness: TestHarness;

async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the question.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('discovery', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.attach('acme', 'discovery');
}

async function attachRepo(name: string): Promise<string> {
  const dir = await makeNodeRepo(join(harness.dir, name));
  harness.git.trackRepo(dir);
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    role: 'lib',
  });
  await completion;
  await harness.repos.update('acme', repo.id, { worktrees: 'always' });
  return repo.id;
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('the diff for one file a run changed', () => {
  it('comes from the worktree while the run still has one', async () => {
    await attachRepo('web');
    // The gate holds the run open, so the worktree is still standing when the diff is asked
    // for. That is the case this branch of the lookup exists for: a resumed run has artifacts
    // from its first attempt and a live directory to read them out of.
    let release = () => {};
    harness.llm.gate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Add a column',
    });

    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    await writeFile(join(path, 'added.ts'), 'export const added = true;\n');

    // Artifacts are captured when a run ends, so an earlier attempt's are what a live run has.
    await harness.pipelineStore.putArtifacts([
      {
        id: 'from-the-first-attempt',
        runId: run.id,
        stepId: null,
        name: 'added.ts',
        kind: 'file',
        path: 'added.ts',
        change: 'added',
        bytes: 0,
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ]);

    const diff = await harness.pipelines.diff(run.id, 'from-the-first-attempt');

    // Uncommitted, in the directory — not a range, because there is nothing on a branch yet.
    expect(diff.source).toBe('worktree');
    expect(diff.text).toContain('+export const added = true;');
    expect(harness.git.diffs.at(-1)?.range).toBeUndefined();
    expect(harness.git.diffs.at(-1)?.dir).toBe(path);

    release();
    harness.llm.gate = undefined;
    await completion;
  });

  it('comes from the run’s branch once the worktree is gone', async () => {
    await attachRepo('web');

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Add a column',
    });

    const [held] = await harness.worktrees.list({ runId: run.id });
    await writeFile(join(held?.path as string, 'added.ts'), 'export const added = true;\n');
    const finished = await completion;

    // Delivered: committed, and the directory taken away with it. The branch is the only copy.
    expect(await harness.worktrees.list({ runId: run.id })).toEqual([]);
    expect(finished.branch).toBeTruthy();

    const detail = await harness.pipelines.get(run.id);
    const file = detail.artifacts.find((artifact) => artifact.path === 'added.ts');
    const diff = await harness.pipelines.diff(run.id, file?.id as string);

    expect(diff.source).toBe('branch');
    expect(diff.path).toBe('added.ts');
    // Three dots: what this branch added, not everything the base has done since.
    expect(harness.git.diffs.at(-1)?.range).toContain('...');
    expect(harness.git.diffs.at(-1)?.range).toContain(finished.branch as string);
  });

  it('refuses an artifact that is not a file, and one that is not on the run', async () => {
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;

    const detail = await harness.pipelines.get(run.id);
    const answer = detail.artifacts.find((artifact) => artifact.kind === 'answer');

    await expect(harness.pipelines.diff(run.id, answer?.id as string)).rejects.toThrow(
      /is not a file/,
    );
    await expect(harness.pipelines.diff(run.id, 'nothing-like-it')).rejects.toThrow(/not found/);
  });

  it('says so when a run kept no worktree and committed nothing', async () => {
    // No repo attached, so nothing was ever cut and nothing was ever committed. An empty diff
    // would read as "this file did not change", which is a different and untrue statement.
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;

    await harness.pipelineStore.putArtifacts([
      {
        id: 'made-up',
        runId: run.id,
        stepId: null,
        name: 'ghost.ts',
        kind: 'file',
        path: 'ghost.ts',
        change: 'modified',
        bytes: 0,
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ]);

    await expect(harness.pipelines.diff(run.id, 'made-up')).rejects.toThrow(
      /no worktree left and committed nothing/,
    );
  });
});
