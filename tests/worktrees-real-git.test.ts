import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBranch } from '@pomni/core';
import { GitCli } from '@pomni/infra';
import { createHarness, gitAvailable, makeGitRepo, type TestHarness } from './harness.js';

/**
 * The same flows as `worktrees.test.ts`, against a real `git` and a real repository.
 *
 * A fake that models worktrees can agree perfectly with an implementation that is wrong about
 * git — the refusal to remove a dirty tree, the branch already being checked out, what a
 * second checkout of the same commit actually contains. These are the assertions that only
 * real git can settle. Skipped, loudly, on a machine with no git on PATH.
 */
const HAS_GIT = await gitAvailable();

let harness: TestHarness<GitCli>;

async function seed(): Promise<{ id: string; dir: string }> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the work.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('discovery', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.updateAgent('discovery', 'lead', { tools: { files: true } });
  await harness.workflows.attach('acme', 'discovery');

  const dir = await makeGitRepo(join(harness.dir, 'web'));
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    role: 'lib',
  });
  await completion;
  // A linked repo: `always` is the per-repo consent to write a worktree entry into its `.git/`.
  await harness.repos.update('acme', repo.id, { worktrees: 'always' });

  return { id: repo.id, dir };
}

const askHuman = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'human', task }] }), '```'].join('\n');

async function waitForQuestions(count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const open = await harness.pipelines.openQuestions();
    if (open.length >= count) return open.map((question) => question.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`only ${(await harness.pipelines.openQuestions()).length} of ${count} runs asked`);
}

describe.skipIf(!HAS_GIT)('real git', () => {
  beforeEach(async () => {
    harness = await createHarness({ git: new GitCli() });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('gives two concurrent runs two real checkouts of one repository', async () => {
    const repo = await seed();

    harness.llm.replies = [askHuman('hold'), askHuman('hold'), 'Done.', 'Done.'];
    const first = await harness.pipelines.start({ projectId: 'acme', task: 'Change the API' });
    const second = await harness.pipelines.start({ projectId: 'acme', task: 'Change the app' });
    const questions = await waitForQuestions(2);

    const [oneRow] = await harness.worktrees.list({ runId: first.run.id });
    const [twoRow] = await harness.worktrees.list({ runId: second.run.id });
    const one = oneRow?.path as string;
    const two = twoRow?.path as string;

    expect(one).toBeTruthy();
    expect(two).toBeTruthy();
    expect(one).not.toBe(two);
    expect(oneRow?.branch).toBe(runBranch(first.run.id));
    expect(twoRow?.branch).toBe(runBranch(second.run.id));

    // Real checkouts: the committed file is in both, and git knows each as a working tree.
    expect(existsSync(join(one, 'package.json'))).toBe(true);
    expect(existsSync(join(two, 'package.json'))).toBe(true);
    expect(await harness.git.isRepo(one)).toBe(true);
    expect((await harness.git.info(one))?.currentBranch).toBe(runBranch(first.run.id));
    expect((await harness.git.info(two))?.currentBranch).toBe(runBranch(second.run.id));

    // git itself lists all three, and it agrees with what Pomni wrote down.
    const listed = (await harness.git.listWorktrees(repo.dir)).map((ref) => ref.branch);
    expect(listed).toContain(runBranch(first.run.id));
    expect(listed).toContain(runBranch(second.run.id));

    await writeFile(join(one, 'only-in-the-first-run.txt'), 'mine');
    expect(existsSync(join(two, 'only-in-the-first-run.txt'))).toBe(false);
    expect(existsSync(join(repo.dir, 'only-in-the-first-run.txt'))).toBe(false);
    // And the second run's git does not see it either — separate index, not just separate files.
    expect(await harness.git.changes(two)).toEqual([]);
    expect((await harness.git.changes(one)).map((change) => change.path)).toContain(
      'only-in-the-first-run.txt',
    );

    for (const id of questions) await harness.pipelines.answer(id, 'Carry on.');
    await Promise.all([first.completion, second.completion]);
  });

  it('keeps a worktree real git refuses to remove, and removes a clean one', async () => {
    const repo = await seed();

    const taken: string[] = [];
    harness.events.subscribe((event) => {
      if (event.type === 'worktree.taken') taken.push(event.path);
    });

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Write something',
    });
    const [questionId] = await waitForQuestions(1);

    const path = taken[0] as string;
    await writeFile(join(path, 'work-in-progress.ts'), 'export const half = true;\n');

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    const finished = await completion;

    // `git worktree remove` without --force is what refuses here. Nothing else is.
    expect(existsSync(join(path, 'work-in-progress.ts'))).toBe(true);
    const [row] = await harness.worktrees.list({ runId: run.id });
    expect(row?.status).toBe('kept');
    expect(row?.keptReason).toContain('work-in-progress.ts');
    // In `unmet`, not `result`: see the same assertion in worktrees.test.ts.
    expect(finished.result).not.toContain(path);
    expect(existsSync(join(repo.dir, 'package.json'))).toBe(true);

    // A second run that changes nothing has its worktree taken away, and its branch with it.
    harness.llm.replies = ['Done.'];
    const clean = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Change nothing' })
    ).completion;

    const cleanPath = taken[1] as string;
    expect(cleanPath).toBeTruthy();
    expect(existsSync(cleanPath)).toBe(false);
    expect(await harness.worktrees.list({ runId: clean.id })).toEqual([]);
    expect((await harness.git.listWorktrees(repo.dir)).map((ref) => ref.path)).not.toContain(
      cleanPath,
    );
  });
});

describe.skipIf(HAS_GIT)('real git', () => {
  it.skip('is not on PATH on this machine, so the real-git worktree tests did not run', () => {});
});
