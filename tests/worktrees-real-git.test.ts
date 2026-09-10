import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBranch } from '@pomni/core';
import { GitCli } from '@pomni/infra';
import { createHarness, gitAvailable, makeGitRepo, type TestHarness } from './harness.js';
import { tempRoot } from './temp-root.js';

/**
 * The same flows as `worktrees.test.ts`, against a real `git` and a real repository.
 *
 * A fake that models worktrees can agree perfectly with an implementation that is wrong about
 * git — the refusal to remove a dirty tree, the branch already being checked out, what a
 * second checkout of the same commit actually contains. These are the assertions that only
 * real git can settle. Skipped, loudly, on a machine with no git on PATH.
 */
const HAS_GIT = await gitAvailable();

/** Raw git, for the setup these tests need and the service deliberately does not expose. */
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });

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
    // Only an uncommitted tree is one git will refuse. With committing on — the default — the
    // work goes onto the branch and the directory comes away, which the next test covers.
    await harness.projects.update('acme', { policy: { autoCommit: false } });

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

  it('commits what a run wrote onto a branch named after the item it delivers', async () => {
    const repo = await seed();
    const item = await harness.backlog.create('acme', { title: 'Rewrite the checkout', type: 'bug' });

    const taken: string[] = [];
    harness.events.subscribe((event) => {
      if (event.type === 'worktree.taken') taken.push(event.path);
    });

    harness.llm.replies = [askHuman('hold'), 'Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Rewrite the checkout',
      itemId: item.id,
    });
    const [questionId] = await waitForQuestions(1);

    const path = taken[0] as string;
    // A branch a person can read, and one that says what kind of change this is. `bug` is the
    // backlog's word for it; `fix` is the branch list's.
    const branch = (await harness.worktrees.list({ runId: run.id }))[0]?.branch as string;
    expect(branch).toBe(`fix/${item.id}/main`);
    expect((await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe(branch);

    await writeFile(join(path, 'delivered.ts'), 'export const whole = true;\n');
    await harness.pipelines.answer(questionId as string, 'Carry on.');
    await completion;

    // The whole point, against real git: the branch is one commit ahead of where it started,
    // and the file is in that commit. Before this, every run branch was 0 commits ahead of the
    // base and the work existed only as loose files in a gitignored directory.
    const ahead = (await git(repo.dir, 'rev-list', '--count', `main..${branch}`)).stdout.trim();
    expect(ahead).toBe('1');

    const files = (await git(repo.dir, 'show', '--name-only', '--format=', branch)).stdout;
    expect(files).toContain('delivered.ts');
    const message = (await git(repo.dir, 'log', '-1', '--format=%B', branch)).stdout;
    expect(message).toContain(item.id);
    expect(message).toContain(run.id);

    // Committed means clean, so git no longer refuses the directory — but `branch -d` refuses
    // an unmerged branch, which is what keeps the work after the directory is gone.
    expect(existsSync(path)).toBe(false);
    const branches = (await git(repo.dir, 'branch', '--list', branch as string)).stdout;
    expect(branches.trim()).toContain(branch);

    // And the item points at where its work is, instead of leaving you to find the branch.
    expect((await harness.backlog.get('acme', item.id)).branch).toBe(branch);
  });
});

describe.skipIf(!HAS_GIT)('putting a resumed run back where it was', () => {
  beforeEach(async () => {
    harness = await createHarness({ git: new GitCli() });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /**
   * The failure this covers is silent, which is what makes it expensive. `take` only ever
   * creates, so on a second attempt the path and the branch both exist, `git worktree add -b`
   * fails, and the catch hands back the shared repo directory. The run then replays answers
   * that describe files sitting on another branch entirely.
   */
  it('reuses the very worktree the run left behind', async () => {
    const repo = await seed();
    const repos = await harness.repos.listResolved('acme');
    const runId = '01M1RESUMEREUSE000000000AA';

    const taken = await harness.worktrees.take('acme', runId, repos);
    const path = taken.dirs[repo.id] as string;
    await writeFile(join(path, 'half-done.ts'), 'export const half = true;\n');

    // Dirty, so git refuses to remove it and the row is kept rather than deleted.
    await harness.worktrees.release(runId);
    expect((await harness.worktrees.list({ runId }))[0]?.status).toBe('kept');

    const back = await harness.worktrees.reclaim('acme', runId, repos);

    expect(back.dirs[repo.id]).toBe(path);
    expect(back.reclaimed).toEqual([repo.id]);
    expect(back.lost).toEqual([]);
    expect(back.fallbacks).toEqual([]);
    expect(existsSync(join(path, 'half-done.ts'))).toBe(true);
    expect((await harness.worktrees.list({ runId }))[0]?.status).toBe('active');
  });

  it('rebuilds a deleted worktree from the run branch, not from the base', async () => {
    const repo = await seed();
    const repos = await harness.repos.listResolved('acme');
    const runId = '01M1RESUMEREBUILD0000000BB';

    const taken = await harness.worktrees.take('acme', runId, repos);
    const path = taken.dirs[repo.id] as string;
    await writeFile(join(path, 'committed.ts'), 'export const kept = true;\n');
    await git(path, 'add', '-A');
    await git(path, 'commit', '-m', 'work');

    await rm(path, { recursive: true, force: true });

    const back = await harness.worktrees.reclaim('acme', runId, repos);

    expect(back.dirs[repo.id]).toBe(path);
    expect(back.reclaimed).toEqual([repo.id]);
    expect(back.lost).toEqual([]);
    // From the branch: the commit the run made is there. From the base ref it would not be.
    expect(existsSync(join(path, 'committed.ts'))).toBe(true);
  });

  it('goes back to the branch when the row is gone, not to the base', async () => {
    const repo = await seed();
    const repos = await harness.repos.listResolved('acme');
    const runId = '01M1RESUMENOROW000000000DD';
    const branch = 'fix/ACME-9/main';

    const taken = await harness.worktrees.take('acme', runId, repos, { branch });
    const path = taken.dirs[repo.id] as string;
    await writeFile(join(path, 'first-pass.ts'), 'export const kept = true;\n');
    await git(path, 'add', '-A');
    await git(path, 'commit', '-m', 'the first pass');

    // A clean release: the work is committed, so git lets the directory go and the row is
    // deleted with it. This is what a failed-then-committed run leaves behind now, and it
    // used to be indistinguishable from a repo that never had a worktree at all.
    await harness.worktrees.release(runId);
    expect(await harness.worktrees.list({ runId })).toEqual([]);

    const back = await harness.worktrees.reclaim('acme', runId, repos, { branch });

    expect(back.reclaimed).toEqual([repo.id]);
    expect(back.fallbacks).toEqual([]);
    // The first pass's commit is here. Cut from the base it would not be, and the resume would
    // have replayed its answers against files that were not there.
    expect(existsSync(join(back.dirs[repo.id] as string, 'first-pass.ts'))).toBe(true);
    expect((await harness.worktrees.list({ runId }))[0]?.branch).toBe(branch);
  });

  it('says which repo lost its tree instead of quietly using the shared one', async () => {
    const repo = await seed();
    const repos = await harness.repos.listResolved('acme');
    const runId = '01M1RESUMELOST000000000CC';

    const taken = await harness.worktrees.take('acme', runId, repos);
    const path = taken.dirs[repo.id] as string;
    await rm(path, { recursive: true, force: true });
    // The branch is what makes the work reachable; without it there is nothing to go back to.
    await git(repo.dir, 'worktree', 'prune');
    await git(repo.dir, 'branch', '-D', runBranch(runId));

    const back = await harness.worktrees.reclaim('acme', runId, repos);

    expect(back.lost).toEqual([repo.id]);
    expect(back.dirs[repo.id]).toBe(repo.dir);
    expect(back.fallbacks[0]?.reason).toContain(runBranch(runId));
  });
});

/**
 * Advancing a clone onto what was merged.
 *
 * Only real git can settle these: what counts as a fast-forward, what `--ff-only` refuses, and
 * whether a dirty tree is one it will move. A fake that agreed with a wrong implementation here
 * would leave every run starting from stale code, which is the failure this exists to prevent.
 */
describe.skipIf(!HAS_GIT)('advancing a clone to its upstream', () => {
  let dir: string;
  let origin: string;
  let clone: string;
  const cli = new GitCli();

  beforeEach(async () => {
    dir = await mkdtemp(join(tempRoot(), 'pomni-ff-'));
    origin = await makeGitRepo(join(dir, 'origin'));
    clone = join(dir, 'clone');
    await exec('git', ['clone', origin, clone]);
    await git(clone, 'config', 'user.email', 'tests@pomni.invalid');
    await git(clone, 'config', 'user.name', 'Pomni Tests');
    await git(clone, 'config', 'commit.gpgsign', 'false');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A commit on the origin, as a merge into its default branch would leave one. */
  async function commitUpstream(name: string): Promise<void> {
    await writeFile(join(origin, name), 'merged\n');
    await git(origin, 'add', '-A');
    await git(origin, 'commit', '-m', `add ${name}`);
  }

  it('moves the clone onto what the remote gained, which fetching alone never did', async () => {
    await commitUpstream('merged.txt');
    await cli.fetch(clone);

    // Fetching is where this used to stop: origin/main knew about the commit, main did not,
    // and every worktree was cut from main.
    expect(existsSync(join(clone, 'merged.txt'))).toBe(false);

    const result = await cli.fastForward(clone, { branch: 'main' });
    expect(result.status).toBe('advanced');
    expect(result.upstream).toBe('origin/main');
    expect(result.from).not.toBe(result.to);
    expect(existsSync(join(clone, 'merged.txt'))).toBe(true);

    // Asked twice, it says so rather than reporting a second advance.
    expect((await cli.fastForward(clone, { branch: 'main' })).status).toBe('current');
  });

  it('refuses a clone that has commits of its own, rather than merging or resetting', async () => {
    await commitUpstream('theirs.txt');
    await writeFile(join(clone, 'mine.txt'), 'local\n');
    await git(clone, 'add', '-A');
    await git(clone, 'commit', '-m', 'mine');
    await cli.fetch(clone);

    const result = await cli.fastForward(clone, { branch: 'main' });
    expect(result.status).toBe('diverged');
    expect(result.from).toBe(result.to);
    // The local commit is still the only copy of itself, which is the whole reason to refuse.
    expect(existsSync(join(clone, 'mine.txt'))).toBe(true);
    expect(existsSync(join(clone, 'theirs.txt'))).toBe(false);
  });

  it('leaves a dirty clone alone and names what it found', async () => {
    await commitUpstream('merged.txt');
    await cli.fetch(clone);
    await writeFile(join(clone, 'package.json'), '{"name":"edited"}');

    const result = await cli.fastForward(clone, { branch: 'main' });
    expect(result.status).toBe('dirty');
    expect(result.detail).toContain('package.json');
    expect(existsSync(join(clone, 'merged.txt'))).toBe(false);
  });

  it('commits and pushes a branch the remote did not have', async () => {
    await git(clone, 'checkout', '-b', 'feature/ACME-1/main');
    await writeFile(join(clone, 'delivered.ts'), 'export const whole = true;\n');

    const committed = await cli.commit(clone, { message: 'ACME-1: deliver\n\nPomni-Run: 01X' });
    expect(committed.committed).toBe(true);

    // A clean tree makes no commit rather than an empty one: an empty commit is a claim that
    // a run did work when it did not.
    expect((await cli.commit(clone, { message: 'again' })).committed).toBe(false);

    await cli.push(clone, { branch: 'feature/ACME-1/main', setUpstream: true });

    // The branch is on the remote — the thing that was missing, and without which there is
    // nothing to open a merge request against.
    const remoteBranches = (await git(origin, 'branch', '--list')).stdout;
    expect(remoteBranches).toContain('feature/ACME-1/main');
    const files = (
      await git(origin, 'show', '--name-only', '--format=', 'feature/ACME-1/main')
    ).stdout;
    expect(files).toContain('delivered.ts');
  });

  it('says what the remote said when it refuses a push', async () => {
    await git(clone, 'checkout', '-b', 'feature/ACME-2/main');
    await writeFile(join(clone, 'a.txt'), 'a\n');
    await cli.commit(clone, { message: 'first' });
    await cli.push(clone, { branch: 'feature/ACME-2/main' });

    // The remote moves on, and this clone does not know. A push that would lose that commit
    // has to be refused with words a person can act on.
    await git(origin, 'checkout', 'feature/ACME-2/main');
    await writeFile(join(origin, 'b.txt'), 'b\n');
    await git(origin, 'add', '-A');
    await git(origin, 'commit', '-m', 'theirs');
    await git(origin, 'checkout', 'main');

    await writeFile(join(clone, 'c.txt'), 'c\n');
    await cli.commit(clone, { message: 'second' });

    await expect(cli.push(clone, { branch: 'feature/ACME-2/main' })).rejects.toThrow(
      /fetch and rebase/i,
    );
  });

  it('merges the base in, and leaves no half-merged tree when it cannot', async () => {
    // A branch that changed a file the base then changed too — the ordinary way three green
    // branches turn into a red master.
    await git(clone, 'checkout', '-b', 'feature/ACME-3/main');
    await writeFile(join(clone, 'shared.txt'), 'mine\n');
    await cli.commit(clone, { message: 'mine' });

    await git(clone, 'checkout', 'main');
    await writeFile(join(clone, 'shared.txt'), 'theirs\n');
    await cli.commit(clone, { message: 'theirs' });
    await git(clone, 'checkout', 'feature/ACME-3/main');

    const conflicted = await cli.mergeInto(clone, 'main');
    expect(conflicted.status).toBe('conflict');
    expect(conflicted.conflicts).toContain('shared.txt');

    // Aborted, not left mid-merge. The gate is about to run in this directory, and a tree full
    // of conflict markers would fail it for a reason that has nothing to do with the code.
    expect((await git(clone, 'status', '--porcelain')).stdout.trim()).toBe('');
    // Trimmed: git's autocrlf rewrites the line ending on checkout, and which one landed is
    // not what this test is about.
    expect((await readFile(join(clone, 'shared.txt'), 'utf8')).trim()).toBe('mine');
    expect(existsSync(join(clone, '.git', 'MERGE_HEAD'))).toBe(false);

    // A branch that does not collide merges, and the tree afterwards has both sides in it.
    await git(clone, 'checkout', '-b', 'feature/ACME-4/main', 'main~1');
    await writeFile(join(clone, 'ours-only.txt'), 'ours\n');
    await cli.commit(clone, { message: 'ours' });

    const merged = await cli.mergeInto(clone, 'main');
    expect(merged.status).toBe('merged');
    expect((await readFile(join(clone, 'shared.txt'), 'utf8')).trim()).toBe('theirs');
    expect(existsSync(join(clone, 'ours-only.txt'))).toBe(true);

    // Asked again, it says nothing moved rather than making an empty merge.
    expect((await cli.mergeInto(clone, 'main')).status).toBe('already');
  });

  it('says so when a branch tracks nothing at all', async () => {
    await git(clone, 'checkout', '-b', 'orphan');
    const result = await cli.fastForward(clone, { branch: 'orphan' });
    expect(result.status).toBe('no-upstream');
    expect(result.detail).toContain('orphan');
  });
});

describe.skipIf(!HAS_GIT)('a file’s diff, from real git', () => {
  let dir: string;
  const cli = new GitCli();

  beforeEach(async () => {
    dir = await mkdtemp(join(tempRoot(), 'pomni-diff-'));
    await makeGitRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('shows a file the agent created, which has nothing to be different from', async () => {
    await writeFile(join(dir, 'added.ts'), 'export const added = true;\n');

    const diff = await cli.diff(dir, 'added.ts');

    // The case the plain command answers with silence — which reads as "unchanged" for the
    // one kind of change that is entirely new.
    expect(diff.text).toContain('+export const added = true;');
    expect(diff.truncated).toBe(false);
  });

  it('shows a file the agent edited, and says nothing about one it did not touch', async () => {
    await writeFile(join(dir, 'kept.ts'), 'export const kept = 1;\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'first');
    await writeFile(join(dir, 'kept.ts'), 'export const kept = 2;\n');

    const changed = await cli.diff(dir, 'kept.ts');
    expect(changed.text).toContain('-export const kept = 1;');
    expect(changed.text).toContain('+export const kept = 2;');

    const untouched = await cli.diff(dir, 'README.md');
    expect(untouched.text).toBe('');
    expect(untouched.truncated).toBe(false);
  });

  it('cuts an oversized diff on a line boundary and says it was cut', async () => {
    const generated = Array.from({ length: 400 }, (_, line) => `export const n${line} = ${line};`);
    await writeFile(join(dir, 'generated.ts'), `${generated.join('\n')}\n`);

    const whole = await cli.diff(dir, 'generated.ts');
    expect(whole.truncated).toBe(false);

    const cut = await cli.diff(dir, 'generated.ts', { maxBytes: 400 });
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(400);

    // Whole lines only. Half a line of a unified diff renders as a change nobody made — a cut
    // `-` line reads as the deletion of something else.
    const last = cut.text.split('\n').at(-1) as string;
    expect(whole.text.split('\n')).toContain(last);
  });

  it('shows what a branch added, when asked for a range', async () => {
    // `makeGitRepo` leaves a committed repository, so there is already a base to branch from.
    const base = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();

    await git(dir, 'checkout', '-b', 'feature/POMN-1/main');
    await writeFile(join(dir, 'on-branch.ts'), 'export const onBranch = true;\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'on the branch');
    await git(dir, 'checkout', base);

    // Read from the repository with the branch not checked out — which is where a finished
    // run's work is, once its worktree has been taken away.
    const diff = await cli.diff(dir, 'on-branch.ts', { range: `${base}...feature/POMN-1/main` });
    expect(diff.text).toContain('+export const onBranch = true;');
  });
});

describe.skipIf(HAS_GIT)('real git', () => {
  it.skip('is not on PATH on this machine, so the real-git worktree tests did not run', () => {});
});
