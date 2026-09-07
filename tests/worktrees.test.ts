import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ORPHAN_GRACE_MS,
  PipelineRunSchema,
  RepoSchema,
  assertPomniOwned,
  isPomniOwned,
  isRunBranch,
  isolatesRuns,
  itemBranch,
  itemIdFromBranch,
  runBranch,
  runIdFromBranch,
  worktreeEligibility,
  worktreeState,
  type PipelineRun,
  type Repo,
  type Worktree,
  type WorktreeProbe,
} from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

/** A real ULID: the run-only branch shape only matches 26 characters of Crockford base32. */
const RUN_ULID = '01M1XW7C6760ET09HMM7H81A80';

/** One orchestrator that is allowed to touch files, so it is told where the repos are. */
async function seed(): Promise<void> {
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
}

/** The fields that are nullable but not defaulted — every run row has always carried them. */
const RUN_NULLS = {
  itemId: null,
  result: null,
  error: null,
  endedAt: null,
  durationMs: null,
  costUsd: null,
};

/**
 * A linked repo. `track` is what makes it a git repository as far as the fake is concerned;
 * without it the repo is correctly ineligible, which is the fallback case rather than this one.
 */
async function attachRepo(
  name: string,
  options: { track?: boolean; worktrees?: 'auto' | 'always' | 'never' } = {},
): Promise<{ id: string; dir: string }> {
  const dir = await makeNodeRepo(join(harness.dir, name));
  if (options.track) harness.git.trackRepo(dir);

  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    role: 'lib',
  });
  await completion;

  if (options.worktrees) {
    await harness.repos.update('acme', repo.id, { worktrees: options.worktrees });
  }
  return { id: repo.id, dir };
}

const askHuman = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'human', task }] }), '```'].join('\n');

/** Hold here until `count` runs are actually blocked on a person — i.e. genuinely running. */
async function waitForQuestions(count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const open = await harness.pipelines.openQuestions();
    if (open.length >= count) return open.map((question) => question.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`only ${(await harness.pipelines.openQuestions()).length} of ${count} runs asked`);
}

/** The session an agent on this run was given — found by the run id in its repo briefing. */
function briefingFor(runId: string): string | undefined {
  return harness.llm.calls.find((call) => call.system?.includes(runId))?.system;
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------------------

describe('two runs on the same repo at once', () => {
  it('gives each run its own directory, and neither can see the other files', async () => {
    // The criterion the whole change exists for. `always` is the consent a linked repo needs;
    // under `auto` this repo would share its directory and the two runs would collide.
    const repo = await attachRepo('web', { track: true, worktrees: 'always' });

    harness.llm.replies = [askHuman('hold'), askHuman('hold'), 'Done.', 'Done.'];

    const first = await harness.pipelines.start({ projectId: 'acme', task: 'Change the API' });
    const second = await harness.pipelines.start({ projectId: 'acme', task: 'Change the app' });

    // Both are blocked on a person, so both are running with their worktrees held.
    const questions = await waitForQuestions(2);

    const [oneRow] = await harness.worktrees.list({ runId: first.run.id });
    const [twoRow] = await harness.worktrees.list({ runId: second.run.id });

    expect(oneRow?.path).toBeTruthy();
    expect(twoRow?.path).toBeTruthy();
    expect(oneRow?.path).not.toBe(twoRow?.path);
    expect(oneRow?.branch).toBe(runBranch(first.run.id));
    expect(twoRow?.branch).toBe(runBranch(second.run.id));
    expect(oneRow?.branch).not.toBe(twoRow?.branch);
    expect(oneRow?.repoId).toBe(repo.id);

    const one = oneRow?.path as string;
    const two = twoRow?.path as string;
    expect(existsSync(one)).toBe(true);
    expect(existsSync(two)).toBe(true);

    // The thing that used to be impossible: a file one run writes is invisible to the other.
    await writeFile(join(one, 'only-in-the-first-run.txt'), 'mine');
    expect(existsSync(join(one, 'only-in-the-first-run.txt'))).toBe(true);
    expect(existsSync(join(two, 'only-in-the-first-run.txt'))).toBe(false);
    expect(existsSync(join(repo.dir, 'only-in-the-first-run.txt'))).toBe(false);

    // And each run's agents were told about their own directory, not the repo's or each other's.
    const firstBriefing = briefingFor(first.run.id);
    const secondBriefing = briefingFor(second.run.id);
    expect(firstBriefing).toContain(one);
    expect(firstBriefing).not.toContain(two);
    expect(secondBriefing).toContain(two);
    expect(secondBriefing).not.toContain(one);

    for (const id of questions) await harness.pipelines.answer(id, 'Carry on.');
    await Promise.all([first.completion, second.completion]);
  });
});

describe('the gate', () => {
  it('runs the project capabilities inside the run own worktree, not the repo directory', async () => {
    const repo = await attachRepo('web', { track: true, worktrees: 'always' });

    // The worktree is removed when the run ends, so its path is caught as it is taken.
    const taken: string[] = [];
    harness.events.subscribe((event) => {
      if (event.type === 'worktree.taken') taken.push(event.path);
    });

    harness.llm.replies = ['Done.'];
    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Change something' })
    ).completion;

    expect(run.status).toBe('passed');
    expect(run.gateStatus).toBe('passed');
    expect(taken).toHaveLength(1);

    // The default gate is typecheck, lint, test — every one of them against this run's copy.
    // Run in the shared directory it would grade whatever happened to be on disk instead.
    expect(harness.executor.calls.length).toBeGreaterThan(0);
    for (const call of harness.executor.calls) {
      expect(call.cwd).toBe(taken[0]);
      expect(call.cwd).not.toBe(repo.dir);
    }
  });
});

describe('a worktree with uncommitted work in it', () => {
  it('is kept rather than deleted, and the run says where it is', async () => {
    const repo = await attachRepo('web', { track: true, worktrees: 'always' });
    // With committing off, a run's output stays as files — which is the only way a worktree
    // is still dirty when it is given back, and so the only way git still refuses to remove
    // it. That refusal is the mechanism this test is about, and it has not changed.
    await harness.projects.update('acme', { policy: { autoCommit: false } });

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Write something',
    });
    const [questionId] = await waitForQuestions(1);

    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    await writeFile(join(path, 'work-in-progress.ts'), 'export const half = true;\n');

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    const finished = await completion;

    // git refuses to remove it, and that refusal is the mechanism, not an error to route around.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'work-in-progress.ts'))).toBe(true);

    const [row] = await harness.worktrees.list({ runId: run.id });
    expect(row?.status).toBe('kept');
    expect(row?.keptReason).toBeTruthy();
    expect(row?.keptReason).toContain('work-in-progress.ts');

    // Told to the person who has to go and look at it, not only to a log file. It belongs in
    // `unmet` rather than `result`: `result` is what the agents said, and a directory git
    // refused to remove is not something they said.
    expect(finished.unmet.join('\n')).toContain(path);
    expect(finished.result).not.toContain(path);
    expect(existsSync(repo.dir)).toBe(true);
    // And it says why it is there rather than only that it is: the project turned committing
    // off, so what would have been a commit is a directory instead.
    expect(finished.unmet.join('\n')).toContain('autoCommit off');
  });

  it('is committed on the run branch, so the work outlives the directory', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Write something',
    });
    const [questionId] = await waitForQuestions(1);

    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    const branch = held?.branch as string;
    await writeFile(join(path, 'delivered.ts'), 'export const whole = true;\n');

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    const finished = await completion;

    // One commit, carrying the run id, so a commit can be traced back to what made it.
    expect(harness.git.commits).toHaveLength(1);
    expect(harness.git.commits[0]?.message).toContain(run.id);

    // Committed, so the tree is clean, so git no longer refuses — the directory comes away
    // and the work is on the branch instead of in a folder nobody can review.
    expect(existsSync(path)).toBe(false);
    expect(await harness.worktrees.list({ runId: run.id })).toEqual([]);

    // Nothing was pushed: the project did not ask for that, and the run says so rather than
    // offering a merge-request link to a branch the remote has never heard of.
    expect(harness.git.pushes).toEqual([]);
    expect(finished.unmet.join('\n')).toContain(`committed on ${branch} but not pushed`);
    const artifacts = (await harness.pipelines.get(run.id)).artifacts;
    expect(artifacts.some((artifact) => artifact.change === 'merge request')).toBe(false);
  });

  it('pushes the branch when the project asks, and only then offers the merge request', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });
    await harness.projects.update('acme', { policy: { autoPush: true } });

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Write something',
    });
    const [questionId] = await waitForQuestions(1);

    const [held] = await harness.worktrees.list({ runId: run.id });
    await writeFile(join(held?.path as string, 'delivered.ts'), 'export const whole = true;\n');
    const branch = held?.branch as string;

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    await completion;

    expect(harness.git.pushes).toEqual([
      { dir: held?.path, branch, remote: 'origin' },
    ]);

    const artifacts = (await harness.pipelines.get(run.id)).artifacts;
    expect(artifacts.some((artifact) => artifact.name === branch)).toBe(true);
  });

  it('opens the merge request with the item as its description', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });
    await harness.projects.update('acme', {
      policy: { autoPush: true, autoMergeRequest: true },
    });
    const item = await harness.backlog.create('acme', { title: 'Rewrite the checkout' });
    await harness.backlog.update('acme', item.id, {
      body: '## Problem\n\nThe checkout drops the cart.\n\n## Acceptance criteria\n\n- [ ] It does not.\n',
    });
    harness.forge.answer = { url: 'https://forge.test/mr/7', created: true, number: 7 };

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Rewrite the checkout',
      itemId: item.id,
    });
    const [questionId] = await waitForQuestions(1);

    const [held] = await harness.worktrees.list({ runId: run.id });
    await writeFile(join(held?.path as string, 'delivered.ts'), 'export const whole = true;\n');

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    const finished = await completion;

    // What a reviewer wants first is what the item already says — not a sentence retyped into
    // a form, different every time.
    const [asked] = harness.forge.asked;
    expect(asked?.sourceBranch).toBe(`feature/${item.id}/main`);
    expect(asked?.title).toContain(item.id);
    expect(asked?.description).toContain('The checkout drops the cart.');
    expect(asked?.description).toContain(run.id);

    const artifacts = (await harness.pipelines.get(run.id)).artifacts;
    expect(artifacts.map((artifact) => artifact.path)).toContain('https://forge.test/mr/7');
    expect(finished.unmet.join('\n')).toContain('https://forge.test/mr/7');
  });

  it('falls back to the link when the forge refuses, without failing the run', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });
    await harness.projects.update('acme', {
      policy: { autoPush: true, autoMergeRequest: true },
    });
    harness.forge.failNext = 'the token has no api scope';

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Write something',
    });
    const [questionId] = await waitForQuestions(1);

    const [held] = await harness.worktrees.list({ runId: run.id });
    await writeFile(join(held?.path as string, 'delivered.ts'), 'export const whole = true;\n');

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    const finished = await completion;

    // Nothing about opening a merge request may fail a run that produced working code.
    expect(finished.status).toBe('passed');
    expect(harness.git.pushes).toHaveLength(1);
    expect((await harness.pipelines.get(run.id)).artifacts.some((a) => a.name === held?.branch)).toBe(
      true,
    );
  });

  it('keeps a run alive when the push is refused, and says which branch to push', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });
    await harness.projects.update('acme', { policy: { autoPush: true } });
    harness.git.failNextPush = 'the remote refused: protected branch';

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Write something',
    });
    const [questionId] = await waitForQuestions(1);

    const [held] = await harness.worktrees.list({ runId: run.id });
    await writeFile(join(held?.path as string, 'delivered.ts'), 'export const whole = true;\n');
    const branch = held?.branch as string;

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    const finished = await completion;

    // The commit is the durable part. A push that the remote would not take is a sentence to
    // read, not a reason to call finished work a failed run.
    expect(finished.status).toBe('passed');
    expect(harness.git.commits).toHaveLength(1);
    expect(finished.unmet.join('\n')).toContain(branch);
    expect(finished.unmet.join('\n')).toContain('protected branch');
  });

  it('removes a clean worktree and deletes its row', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });

    const taken: string[] = [];
    harness.events.subscribe((event) => {
      if (event.type === 'worktree.taken') taken.push(event.path);
    });

    harness.llm.replies = ['Done.'];
    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Change nothing' })
    ).completion;

    expect(taken).toHaveLength(1);
    expect(existsSync(taken[0] as string)).toBe(false);
    // A record exists if and only if a directory exists.
    expect(await harness.worktrees.list({ runId: run.id })).toEqual([]);
  });
});

describe('a repo that cannot have a worktree', () => {
  it('runs in its own directory and says so, instead of failing the run', async () => {
    // Linked and left on `auto`: the user's own tree, and linking it was not consent.
    const repo = await attachRepo('web');

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Change something',
    });
    const finished = await completion;

    expect(finished.status).toBe('passed');
    expect(finished.unmet.join('\n')).toContain('repo you linked');
    expect(finished.unmet.join('\n')).toContain('--worktrees always');
    expect(await harness.worktrees.list({ runId: run.id })).toEqual([]);

    // The agents worked in the repo itself — the degraded behaviour, done openly.
    expect(briefingFor(run.id) ?? '').toBe('');
    const briefing = harness.llm.calls[0]?.system ?? '';
    expect(briefing).toContain(repo.dir);
  });

  it('falls back when git cannot do worktrees at all', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });
    harness.git.worktreeSupport = false;

    harness.llm.replies = ['Done.'];
    const finished = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Change something' })
    ).completion;

    expect(finished.status).toBe('passed');
    expect(finished.unmet.join('\n')).toContain('too old for worktrees');
  });

  it('falls back when git refuses to make one, rather than failing the run', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });
    harness.git.failNextAddWorktree = "a branch named 'pomni/run/X' already exists";

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Change something',
    });
    const finished = await completion;

    expect(finished.status).toBe('passed');
    expect(finished.unmet.join('\n')).toContain('could not create a worktree');
    expect(finished.unmet.join('\n')).toContain('already exists');
    expect(await harness.worktrees.list({ runId: run.id })).toEqual([])
  });
});

describe('eligibility, in the order it is decided', () => {
  const repo = (over: Partial<Repo> = {}): Repo => ({
    id: 'web',
    projectId: 'acme',
    name: 'web',
    role: 'lib',
    source: { kind: 'local', path: '/home/someone/web' },
    status: 'linked',
    stack: null,
    capabilities: {},
    worktrees: 'auto',
    vcs: null,
    lastError: null,
    lastSyncedAt: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const probe = (over: Partial<WorktreeProbe> = {}): WorktreeProbe => ({
    workingDirExists: true,
    isGitRepo: true,
    gitSupportsWorktrees: true,
    currentBranch: 'main',
    head: 'abc123',
    ...over,
  });

  it('reports never before linked, when a repo is both', () => {
    // Both rules apply. The one the user actually set is the one they should be told about.
    const result = worktreeEligibility(
      repo({ worktrees: 'never', source: { kind: 'local', path: '/w' } }),
      probe(),
    );
    expect(result.eligible).toBe(false);
    expect(result.eligible === false && result.reason).toContain('worktrees: never');
    expect(result.eligible === false && result.reason).not.toContain('repo you linked');
  });

  it('leaves a linked repo alone under auto, and takes one under always', () => {
    const linked = worktreeEligibility(repo(), probe());
    expect(linked.eligible).toBe(false);
    expect(linked.eligible === false && linked.reason).toContain('repo you linked');

    const consented = worktreeEligibility(repo({ worktrees: 'always' }), probe());
    expect(consented.eligible).toBe(true);
  });

  it('isolates a cloned repo under auto', () => {
    const cloned = repo({ source: { kind: 'git', url: 'https://example.test/o/r.git' }, status: 'ready' });
    expect(isolatesRuns(cloned, probe())).toBe(true);
  });

  it('reports a repo still cloning before it looks at the disk', () => {
    const result = worktreeEligibility(
      repo({ worktrees: 'always', status: 'cloning' }),
      probe({ workingDirExists: false }),
    );
    expect(result.eligible === false && result.reason).toContain('still cloning');
  });

  it('walks the remaining reasons in order', () => {
    const always = { worktrees: 'always' as const };
    const reason = (p: Partial<WorktreeProbe>) => {
      const result = worktreeEligibility(repo(always), probe(p));
      return result.eligible === false ? result.reason : '';
    };

    expect(reason({ workingDirExists: false })).toContain('no working directory');
    // A missing directory is reported before "not a git repository", even though both hold.
    expect(reason({ workingDirExists: false, isGitRepo: false })).toContain('no working directory');
    expect(reason({ isGitRepo: false })).toContain('not a git repository');
    expect(reason({ gitSupportsWorktrees: false })).toContain('too old for worktrees');
    expect(reason({ head: null })).toContain('no commits yet');
  });

  it('cuts from the branch when there is one, and from HEAD when detached', () => {
    const onBranch = worktreeEligibility(repo({ worktrees: 'always' }), probe());
    expect(onBranch).toMatchObject({ eligible: true, baseRef: 'main', baseBranch: 'main' });

    const detached = worktreeEligibility(
      repo({ worktrees: 'always' }),
      probe({ currentBranch: null, head: 'deadbeef' }),
    );
    expect(detached).toMatchObject({ eligible: true, baseRef: 'deadbeef', baseBranch: null });
  });

  it('names a branch after the item it delivers, and the type it is', () => {
    expect(itemBranch('feature', 'POMN-1')).toBe('feature/POMN-1/main');
    // The one place the two vocabularies differ: a backlog has bugs, a branch list has fixes.
    expect(itemBranch('bug', 'POMN-43')).toBe('fix/POMN-43/main');
    expect(itemBranch('release', 'ACME-9')).toBe('release/ACME-9/main');
    expect(itemBranch('feature', 'POMN-1', '6760et09')).toBe('feature/POMN-1/6760et09');
    // A type nobody declared still has to produce a valid ref.
    expect(itemBranch('nonsense', 'POMN-1')).toBe('chore/POMN-1/main');
    expect(itemIdFromBranch('fix/POMN-43/main')).toBe('POMN-43');
    expect(itemIdFromBranch('feature/some-work')).toBeNull();
  });

  it('names a run with no item after the run, and reads the run back out of it', () => {
    expect(runBranch(RUN_ULID)).toBe(`chore/run-${RUN_ULID}/main`);
    expect(runIdFromBranch(`chore/run-${RUN_ULID}/main`)).toBe(RUN_ULID);
    expect(runIdFromBranch('main')).toBeNull();
    expect(runIdFromBranch('feature/POMN-1/main')).toBeNull();
  });

  it('still recognises the branches it cut before the rename', () => {
    // This predicate guards `git branch -d` and `worktree prune`. Branches in the old shape
    // exist on disk, and forgetting them would take away Pomni's right to clean up after
    // itself — so the old prefix is understood forever.
    expect(isRunBranch(`pomni/run/${RUN_ULID}`)).toBe(true);
    expect(runIdFromBranch(`pomni/run/${RUN_ULID}`)).toBe(RUN_ULID);
    expect(isRunBranch('feature/POMN-1/main')).toBe(true);
    expect(isRunBranch(`chore/run-${RUN_ULID}/main`)).toBe(true);
  });

  it('does not claim a branch a person wrote by hand', () => {
    // All three segments together are the signature. Matching `feature/*` would hand Pomni
    // authority to delete branches it never made.
    expect(isRunBranch('feature/checkout-rewrite')).toBe(false);
    expect(isRunBranch('main')).toBe(false);
    expect(isRunBranch('fix/POMN-43')).toBe(false);
    expect(isRunBranch('release/2026-09-07')).toBe(false);
  });
});

describe('two runs sharing a repo', () => {
  it('is refused when the repo cannot be isolated', async () => {
    await attachRepo('web');

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const first = await harness.pipelines.start({ projectId: 'acme', task: 'First' });
    const [questionId] = await waitForQuestions(1);

    await expect(
      harness.pipelines.start({ projectId: 'acme', task: 'Second' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await expect(
      harness.pipelines.start({ projectId: 'acme', task: 'Second' }),
    ).rejects.toThrow(/already working in/);

    await harness.pipelines.answer(questionId as string, 'Carry on.');
    await first.completion;
  });

  it('is allowed when the repo can be isolated — which is the point', async () => {
    await attachRepo('web', { track: true, worktrees: 'always' });

    harness.llm.replies = [askHuman('hold'), askHuman('hold'), 'Done.', 'Done.'];
    const first = await harness.pipelines.start({ projectId: 'acme', task: 'First' });
    const second = await harness.pipelines.start({ projectId: 'acme', task: 'Second' });

    const questions = await waitForQuestions(2);
    expect(await harness.worktrees.list({ runId: first.run.id })).toHaveLength(1);
    expect(await harness.worktrees.list({ runId: second.run.id })).toHaveLength(1);

    for (const id of questions) await harness.pipelines.answer(id, 'Carry on.');
    const [a, b] = await Promise.all([first.completion, second.completion]);
    expect(a?.status).toBe('passed');
    expect(b?.status).toBe('passed');
  });
});

describe('what a worktree actually is right now', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');

  const worktree = (over: Partial<Worktree> = {}): Worktree => ({
    id: 'wt-1',
    projectId: 'acme',
    repoId: 'web',
    runId: 'run-1',
    path: '/w/.pomni/worktrees/acme/web/run-1',
    branch: 'pomni/run/run-1',
    baseBranch: 'main',
    baseCommit: 'abc123',
    ownerPid: 4242,
    status: 'active',
    keptReason: null,
    createdAt: at.toISOString(),
    endedAt: null,
    ...over,
  });

  const run = (status: string): PipelineRun => ({ status } as unknown as PipelineRun);
  const present = { dirExists: true, ownerAlive: true };

  it('is missing when the directory has gone, whatever the row says', () => {
    expect(worktreeState(worktree(), run('running'), { dirExists: false, ownerAlive: true }, at)).toBe(
      'missing',
    );
    // Even a kept one: the record outliving the directory is the missing case, not the kept one.
    expect(
      worktreeState(worktree({ status: 'kept' }), null, { dirExists: false, ownerAlive: false }, at),
    ).toBe('missing');
  });

  it('is kept before anything else is considered', () => {
    expect(worktreeState(worktree({ status: 'kept' }), null, present, at)).toBe('kept');
    expect(
      worktreeState(worktree({ status: 'kept' }), run('passed'), { dirExists: true, ownerAlive: false }, at),
    ).toBe('kept');
  });

  it('is orphaned when the run row is gone or finished', () => {
    const pastGrace = new Date(at.getTime() + ORPHAN_GRACE_MS + 1);
    expect(worktreeState(worktree(), null, present, pastGrace)).toBe('orphaned');

    // Inside the grace window it is not an orphan: a worktree exists for a moment before its
    // run row does, and reaping it there would remove the directory about to be worked in.
    expect(worktreeState(worktree(), null, present, at)).toBe('live');
    for (const status of ['passed', 'failed', 'cancelled']) {
      expect(worktreeState(worktree(), run(status), present, at)).toBe('orphaned');
    }
  });

  it('trusts a live pid over the row, and distrusts a dead one', () => {
    // A process that dies without cancelling leaves the row at `running` for ever, so the
    // row alone is never enough.
    expect(worktreeState(worktree(), run('running'), present, at)).toBe('live');
    expect(
      worktreeState(worktree(), run('running'), { dirExists: true, ownerAlive: false }, at),
    ).toBe('orphaned');
  });

  it('gives a worktree with no pid the grace window, and no longer', () => {
    const inside = new Date(at.getTime() + ORPHAN_GRACE_MS);
    const outside = new Date(at.getTime() + ORPHAN_GRACE_MS + 1);

    expect(worktreeState(worktree({ ownerPid: null }), run('running'), present, at)).toBe('live');
    expect(worktreeState(worktree({ ownerPid: null }), run('running'), present, inside)).toBe('live');
    expect(worktreeState(worktree({ ownerPid: null }), run('running'), present, outside)).toBe(
      'orphaned',
    );
  });
});

describe('orphans, end to end', () => {
  /** The state a run whose process died leaves behind: a directory, a row, and nothing alive. */
  async function leaveBehind(
    repoDir: string,
    runId: string,
    over: Partial<Worktree> = {},
  ): Promise<Worktree> {
    const path = join(harness.worktrees.root, 'acme', 'web', runId);
    await harness.git.addWorktree(repoDir, {
      path,
      branch: `pomni/run/${runId}`,
      baseRef: 'main',
    });

    const row: Worktree = {
      id: `wt-${runId}`,
      projectId: 'acme',
      repoId: 'web',
      runId,
      path,
      branch: `pomni/run/${runId}`,
      baseBranch: 'main',
      baseCommit: 'abc123',
      ownerPid: 999_999,
      status: 'active',
      keptReason: null,
      createdAt: harness.clock.iso(),
      endedAt: null,
      ...over,
    };
    await harness.worktreeStore.insert(row);
    return row;
  }

  it('reports one in doctor, prunes it, and leaves a kept one exactly where it is', async () => {
    const repo = await attachRepo('web', { track: true, worktrees: 'always' });
    // Nothing is behind the pid these rows name.
    harness.executor.dead.add(999_999);

    // Its run row still claims `running` — the state a killed process leaves.
    await harness.pipelineStore.insertRun(
      PipelineRunSchema.parse({
        id: 'dead-run',
        projectId: 'acme',
        workflowId: 'discovery',
        workflowName: 'Discovery',
        providerId: 'claude-code',
        task: 'something from a session that is gone',
        status: 'running',
        pid: 999_999,
        startedAt: harness.clock.iso(),
        ...RUN_NULLS,
      }),
    );

    const orphan = await leaveBehind(repo.dir, 'dead-run');
    const kept = await leaveBehind(repo.dir, 'kept-run', {
      status: 'kept',
      keptReason: '1 uncommitted change on branch pomni/run/kept-run',
    });
    // Real uncommitted work, so pruning it would destroy something.
    await writeFile(join(kept.path, 'unfinished.ts'), 'export const half = true;\n');

    const report = await harness.doctor.check('acme');
    const seen = new Map(report.worktrees.map((check) => [check.id, check]));

    expect(seen.get(orphan.id)).toMatchObject({ state: 'orphaned', status: 'warn' });
    expect(seen.get(orphan.id)?.detail).toContain('whose process is gone');
    expect(seen.get(kept.id)).toMatchObject({ state: 'kept', status: 'ok' });
    expect(report.status).toBe('warn');

    const pruned = await harness.worktrees.prune({ projectId: 'acme' });

    expect(pruned.removed.map((entry) => entry.id)).toEqual([orphan.id]);
    expect(pruned.kept.map((entry) => entry.id)).toEqual([kept.id]);
    expect(pruned.failed).toEqual([]);

    expect(existsSync(orphan.path)).toBe(false);
    expect(await harness.worktreeStore.get(orphan.id)).toBeNull();

    // Reaping this one would delete the uncommitted work the feature exists to protect.
    expect(existsSync(kept.path)).toBe(true);
    expect(existsSync(join(kept.path, 'unfinished.ts'))).toBe(true);
    expect(await harness.worktreeStore.get(kept.id)).not.toBeNull();
  });

  it('refuses to remove a kept worktree by hand without --force', async () => {
    const repo = await attachRepo('web', { track: true, worktrees: 'always' });
    const kept = await leaveBehind(repo.dir, 'kept-run', {
      status: 'kept',
      keptReason: 'uncommitted changes',
    });

    await expect(harness.worktrees.removeOne(kept.id, { force: false })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(existsSync(kept.path)).toBe(true);
  });
});

describe('Pomni removes only what Pomni made', () => {
  const root = 'C:/tmp/.pomni/worktrees';

  it('accepts a directory inside the worktrees root, however it is spelled', () => {
    expect(isPomniOwned('C:/tmp/.pomni/worktrees/acme/web/01', root)).toBe(true);
    expect(isPomniOwned('C:\\tmp\\.pomni\\worktrees\\acme\\web\\01', root)).toBe(true);
    expect(isPomniOwned('C:\\tmp\\.pomni\\worktrees\\acme\\web\\01\\', root)).toBe(true);
    expect(isPomniOwned('C:/TMP/.pomni/WORKTREES/acme/web/01', root)).toBe(true);
    expect(isPomniOwned('C:/tmp/.pomni/worktrees/./acme/../acme/web/01', root)).toBe(true);
    expect(isPomniOwned('C:/tmp/.pomni/worktrees/acme/web/01', 'C:\\tmp\\.pomni\\worktrees\\')).toBe(
      true,
    );
  });

  it('refuses anything outside it', () => {
    // A sibling whose name merely starts the same way. Prefix matching without the separator
    // is how a directory next door gets deleted.
    expect(isPomniOwned('C:/tmp/.pomni/worktrees-old/acme/web/01', root)).toBe(false);
    expect(isPomniOwned('C:/tmp/.pomni/worktreesold', root)).toBe(false);
    // A `..` that climbs back out again.
    expect(isPomniOwned('C:/tmp/.pomni/worktrees/../workspace/acme/web', root)).toBe(false);
    expect(isPomniOwned('C:/tmp/.pomni/worktrees/acme/../../../home/someone/web', root)).toBe(false);
    // The user's own repo, and the root itself.
    expect(isPomniOwned('C:/Users/someone/code/web', root)).toBe(false);
    expect(isPomniOwned(root, root)).toBe(false);
    expect(isPomniOwned('', root)).toBe(false);
  });

  it('throws with the path it refused', () => {
    expect(() => assertPomniOwned('C:/tmp/.pomni/worktrees/acme/web/01', root)).not.toThrow();
    expect(() => assertPomniOwned('C:/Users/someone/code/web', root)).toThrow(
      /refusing to remove .*C:\/Users\/someone\/code\/web/,
    );
    expect(() => assertPomniOwned('C:/tmp/.pomni/worktrees-old/x', root)).toThrow(
      /only directories it created/,
    );
  });

  it('leaves a linked repo directory untouched by a run that fell back to it', async () => {
    const repo = await attachRepo('web');
    const before = (await readdir(repo.dir)).sort();

    harness.llm.replies = ['Done.'];
    await (await harness.pipelines.start({ projectId: 'acme', task: 'Change something' }))
      .completion;

    expect(existsSync(repo.dir)).toBe(true);
    expect((await readdir(repo.dir)).sort()).toEqual(before);
    expect(existsSync(join(repo.dir, 'package.json'))).toBe(true);
  });
});

describe('records written before this change', () => {
  it('reads a repo with no worktrees key as auto', () => {
    const parsed = RepoSchema.parse({
      id: 'web',
      projectId: 'acme',
      name: 'web',
      source: { kind: 'local', path: '/home/someone/web' },
      status: 'linked',
      addedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.worktrees).toBe('auto');
  });

  it('reads a repos/*.yaml written before the field existed', async () => {
    const dir = await makeNodeRepo(join(harness.dir, 'legacy'));
    await writeFile(
      join(harness.root, 'projects', 'acme', 'repos', 'legacy.yaml'),
      [
        'id: legacy',
        'projectId: acme',
        'name: legacy',
        'role: lib',
        'source:',
        '  kind: local',
        `  path: '${dir}'`,
        'status: linked',
        "addedAt: '2026-01-01T00:00:00.000Z'",
        "updatedAt: '2026-01-01T00:00:00.000Z'",
        '',
      ].join('\n'),
      'utf8',
    );

    const repo = await harness.repos.get('acme', 'legacy');
    expect(repo.worktrees).toBe('auto');
    expect(repo.workingDir).toBe(dir);
  });

  it('reads a pipeline run with no pid as null', () => {
    const parsed = PipelineRunSchema.parse({
      id: 'old-run',
      projectId: 'acme',
      workflowId: 'discovery',
      workflowName: 'Discovery',
      providerId: 'claude-code',
      task: 'something from before',
      status: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      ...RUN_NULLS,
    });
    expect(parsed.pid).toBeNull();
  });
});
