import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DetectorRegistry } from '@pomni/adapters';
import { tempRoot } from './temp-root.js';
import {
  BacklogService,
  ChatService,
  CommentService,
  CredentialService,
  DiscoveryService,
  DoctorService,
  GitError,
  ProjectService,
  RepoService,
  RunService,
  PipelineService,
  ProviderService,
  ToolService,
  WorkflowService,
  WorkspaceService,
  WorktreeService,
  layout,
  type CloneOptions,
  type CommitResult,
  type ExecRequest,
  type ExecResult,
  type Executor,
  type FastForwardResult,
  type DesktopPort,
  type ForgePort,
  type GitAuth,
  type GitPort,
  type BranchRef,
  type MergeRequestRef,
  type MergeResult,
  type OpenMergeRequestInput,
  type LlmFactory,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type LlmToolCall,
  type LlmToolSpec,
  type LlmUsage,
  type LogSink,
  type PomniContainer,
  type Provider,
  type ToolGrant,
  type ToolLoopHooks,
  type VcsInfo,
  type WorktreeRef,
  SystemService,
  type BuildOutcome,
  type RestartPort,
  type Supervision,
} from '@pomni/core';
import {
  DefaultCredentialStore,
  DefaultOutputAnalyzer,
  FileDocStore,
  FixedClock,
  InMemoryEventBus,
  NodeFsProbe,
  NoProviderProbe,
  NoopLock,
  SqliteChatStore,
  SqliteCommentStore,
  SqlitePipelineStore,
  SqliteWorktreeStore,
  SilentLogger,
  SqliteRunStore,
} from '@pomni/infra';

const run = promisify(execFile);

/**
 * One key per directory, so a path a test wrote with `\` and one git reported with `/` are
 * the same directory. Windows is the machine this suite is developed on; anything less
 * would make the fake disagree with the filesystem it is pretending to be.
 */
function dirKey(path: string): string {
  return resolve(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Every file under `dir` by relative path, with its contents. `.git` and installs skipped. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      files.set(relative(dir, full).replace(/\\/g, '/'), await readFile(full, 'utf8'));
    }
  }

  await walk(dir);
  return files;
}

/**
 * A git that records what it was asked to do and creates a plausible directory, so repo
 * flows can be tested without a network or a real remote.
 */
interface FakeWorktreeEntry {
  repoKey: string;
  path: string;
  branch: string;
  head: string;
  /** The files as they were when the worktree was cut. Anything else is uncommitted work. */
  base: Map<string, string>;
}

export class FakeGit implements GitPort {
  clones: CloneOptions[] = [];
  fetched: string[] = [];
  failNextClone: string | null = null;
  authSeen: Array<GitAuth | undefined> = [];

  /** Directories a test has declared to be git repositories, keyed by `dirKey`. */
  private readonly tracked = new Map<
    string,
    { branch: string | null; head: string; remote: string | null }
  >();
  /** Live worktrees, keyed by `dirKey` of their own path. */
  private readonly worktrees = new Map<string, FakeWorktreeEntry>();

  /** Flip to model a git too old for `worktree`. */
  worktreeSupport = true;
  /** One-shot failure, to model "the branch already exists" and friends. */
  failNextAddWorktree: string | null = null;

  /**
   * Declare a directory to be a git repo with a commit in it. `makeNodeRepo` only writes a
   * `package.json`, so without this a linked repo is correctly reported as "not a git
   * repository" — which is the fallback case, not the isolated one.
   */
  trackRepo(
    dir: string,
    info: { branch?: string | null; head?: string; remote?: string | null } = {},
  ): string {
    this.tracked.set(dirKey(dir), {
      branch: info.branch === undefined ? 'main' : info.branch,
      head: info.head ?? 'abc123',
      // A checkout someone linked is still a clone of something. Modelling it without an
      // origin made every merge-request path unreachable in tests for the wrong reason.
      remote: info.remote === undefined ? 'https://forge.test/acme/web.git' : info.remote,
    });
    return dir;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async isRepo(dir: string): Promise<boolean> {
    const key = dirKey(dir);
    return (
      this.tracked.has(key) ||
      this.worktrees.has(key) ||
      this.clones.some((clone) => dirKey(clone.dir) === key)
    );
  }

  async clone(options: CloneOptions): Promise<void> {
    this.authSeen.push(options.auth);
    if (this.failNextClone) {
      const message = this.failNextClone;
      this.failNextClone = null;
      throw new Error(message);
    }
    options.onProgress?.('Receiving objects: 100%');
    await mkdir(options.dir, { recursive: true });
    await writeFile(join(options.dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    this.clones.push(options);
  }

  async info(dir: string): Promise<VcsInfo | null> {
    const key = dirKey(dir);

    const worktree = this.worktrees.get(key);
    if (worktree) {
      return {
        isRepo: true,
        currentBranch: worktree.branch,
        defaultBranch: 'main',
        remote: null,
        head: worktree.head,
        dirty: (await this.changes(dir)).length > 0,
      };
    }

    const declared = this.tracked.get(key);
    if (declared) {
      return {
        isRepo: true,
        currentBranch: declared.branch,
        defaultBranch: 'main',
        remote: declared.remote,
        head: declared.head,
        dirty: false,
      };
    }

    if (!(await this.isRepo(dir))) return null;
    return {
      isRepo: true,
      currentBranch: 'main',
      defaultBranch: 'main',
      remote: 'https://example.test/o/r.git',
      head: 'abc123',
      dirty: false,
    };
  }

  async fetch(dir: string): Promise<void> {
    this.fetched.push(dir);
  }

  /** Every `diff` asked for, so a test can assert which range was used. */
  diffs: Array<{ dir: string; path: string; range: string | undefined }> = [];

  async testRemote(): Promise<void> {}

  /**
   * What the directory differs by. For a worktree that is a real comparison against the files
   * it was cut with, so a test that writes a file into one makes it genuinely dirty rather
   * than setting a flag that says it is.
   */
  async changes(dir: string): Promise<Array<{ path: string; change: string }>> {
    const entry = this.worktrees.get(dirKey(dir));
    if (!entry) return [];

    const now = await snapshot(dir);
    const changes: Array<{ path: string; change: string }> = [];

    for (const [path, content] of now) {
      const before = entry.base.get(path);
      if (before === undefined) changes.push({ path, change: 'added' });
      else if (before !== content) changes.push({ path, change: 'modified' });
    }
    for (const path of entry.base.keys()) {
      if (!now.has(path)) changes.push({ path, change: 'deleted' });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * A unified diff for one file, built from the same before-and-after this fake already keeps.
   *
   * Real enough for the things a caller decides on — the `+++`/`---` headers, `+` and `-`
   * lines, an empty answer for a file that did not change, and truncation — without being a
   * diff algorithm. Every line of the old file is removed and every line of the new one added,
   * which is what git produces anyway when a small file changes throughout.
   *
   * `range` is accepted and ignored: this fake has one version of a directory, and a test that
   * cares which range was asked for should read `diffs` instead.
   */
  async diff(
    dir: string,
    path: string,
    options: { range?: string; maxBytes?: number } = {},
  ): Promise<{ text: string; truncated: boolean }> {
    this.diffs.push({ dir, path, range: options.range });

    const entry = this.worktrees.get(dirKey(dir));
    const before = entry?.base.get(path);
    const now = await snapshot(dir);
    const after = now.get(path);

    if (before === after) return { text: '', truncated: false };

    const lines = [
      `diff --git a/${path} b/${path}`,
      `--- ${before === undefined ? '/dev/null' : `a/${path}`}`,
      `+++ ${after === undefined ? '/dev/null' : `b/${path}`}`,
      '@@',
      ...(before ?? '').split('\n').filter(Boolean).map((line) => `-${line}`),
      ...(after ?? '').split('\n').filter(Boolean).map((line) => `+${line}`),
    ];

    const text = lines.join('\n');
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };

    const kept: string[] = [];
    let size = 0;
    for (const line of lines) {
      const cost = Buffer.byteLength(line, 'utf8') + 1;
      if (size + cost > maxBytes) break;
      kept.push(line);
      size += cost;
    }
    return { text: kept.join('\n'), truncated: true };
  }

  async supportsWorktrees(): Promise<boolean> {
    return this.worktreeSupport;
  }

  async addWorktree(
    repoDir: string,
    options: { path: string; branch: string; baseRef: string },
  ): Promise<{ head: string }> {
    if (this.failNextAddWorktree) {
      const message = this.failNextAddWorktree;
      this.failNextAddWorktree = null;
      throw new GitError(`git worktree add failed: ${message}`);
    }
    if (!this.worktreeSupport) {
      throw new GitError("git worktree add failed: unknown subcommand 'worktree'");
    }
    if (this.worktrees.has(dirKey(options.path))) {
      throw new GitError(`git worktree add failed: '${options.path}' already exists`);
    }
    const repoKey = dirKey(repoDir);
    for (const entry of this.worktrees.values()) {
      if (entry.repoKey === repoKey && entry.branch === options.branch) {
        throw new GitError(
          `git worktree add failed: '${options.branch}' is already checked out at '${entry.path}'`,
        );
      }
    }

    // git makes the leaf directory and checks the base ref out into it. Copying is the
    // closest a fake gets to a checkout, and it is what makes the two directories independent.
    await mkdir(options.path, { recursive: true });
    await cp(repoDir, options.path, {
      recursive: true,
      filter: (source) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(source),
    });

    const head = (await this.info(repoDir))?.head ?? 'abc123';
    this.worktrees.set(dirKey(options.path), {
      repoKey,
      path: options.path,
      branch: options.branch,
      head,
      base: await snapshot(options.path),
    });
    return { head };
  }

  /**
   * The same directory, back on a branch it already has — what a resumed run needs.
   *
   * Missing entirely until the test suite was first type-checked: the resume tests run against
   * real git, so nothing at runtime ever asked the fake for it, and `implements GitPort` was
   * never verified by a build. A fake that is quietly narrower than its port is a fake that
   * agrees with whatever the implementation does.
   *
   * No `-b` and no "already checked out" check, matching the real verb: the branch is the
   * run's own and exists, and re-creating it is the bug this method was added to avoid.
   */
  async attachWorktree(
    repoDir: string,
    options: { path: string; branch: string },
  ): Promise<{ head: string }> {
    if (!this.worktreeSupport) {
      throw new GitError("git worktree add failed: unknown subcommand 'worktree'");
    }
    if (this.worktrees.has(dirKey(options.path))) {
      throw new GitError(`git worktree add failed: '${options.path}' already exists`);
    }

    await mkdir(options.path, { recursive: true });
    await cp(repoDir, options.path, {
      recursive: true,
      filter: (source) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(source),
    });

    const head = (await this.info(repoDir))?.head ?? 'abc123';
    this.worktrees.set(dirKey(options.path), {
      repoKey: dirKey(repoDir),
      path: options.path,
      branch: options.branch,
      head,
      base: await snapshot(options.path),
    });
    return { head };
  }

  /**
   * Never forces, exactly as the port says. A worktree with uncommitted work in it is refused,
   * which is the mechanism the whole feature rests on.
   */
  async removeWorktree(repoDir: string, path: string, _options?: { deleteBranch?: string }): Promise<void> {
    const entry = this.worktrees.get(dirKey(path));
    if (!entry) {
      throw new GitError(`git worktree remove failed: '${path}' is not a working tree`);
    }
    if ((await this.changes(path)).length > 0) {
      throw new GitError(
        `git worktree remove failed: '${path}' contains modified or untracked files, use --force to delete it`,
      );
    }
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.worktrees.delete(dirKey(path));
  }

  async listWorktrees(repoDir: string): Promise<WorktreeRef[]> {
    const repoKey = dirKey(repoDir);
    const info = await this.info(repoDir);
    const refs: WorktreeRef[] = [
      { path: repoDir, branch: info?.currentBranch ?? null, head: info?.head ?? null, prunable: false },
    ];

    for (const entry of this.worktrees.values()) {
      if (entry.repoKey !== repoKey) continue;
      refs.push({
        path: entry.path,
        branch: entry.branch,
        head: entry.head,
        prunable: !(await exists(entry.path)),
      });
    }
    return refs;
  }

  async pruneWorktrees(repoDir: string): Promise<void> {
    const repoKey = dirKey(repoDir);
    for (const [key, entry] of [...this.worktrees]) {
      if (entry.repoKey !== repoKey) continue;
      if (!(await exists(entry.path))) this.worktrees.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /** Branches a test has declared to exist, beyond the ones worktrees are on. */
  readonly declaredBranches = new Set<string>();
  commits: Array<{ dir: string; message: string }> = [];
  pushes: Array<{ dir: string; branch: string; remote: string }> = [];
  failNextCommit: string | null = null;
  failNextPush: string | null = null;
  /** What `fastForward` answers. Left null, it reports the branch as already current. */
  fastForwardResult: FastForwardResult | null = null;

  /**
   * What merging the base into a worktree finds. `already` by default, which is true of every
   * test whose base does not move; a test that wants the interesting case scripts it.
   */
  mergeResult: MergeResult | null = null;
  merges: Array<{ dir: string; ref: string }> = [];

  async mergeInto(dir: string, ref: string): Promise<MergeResult> {
    this.merges.push({ dir, ref });
    return (
      this.mergeResult ?? {
        status: 'already',
        conflicts: [],
        detail: `already up to date with ${ref}`,
      }
    );
  }

  /** Branches a test has declared unmerged — work that exists on no other ref. */
  unmergedBranches: string[] = [];

  async branches(dir: string, _mergedInto: string): Promise<BranchRef[]> {
    const repoKey = dirKey(dir);
    const names = new Set(this.declaredBranches);
    for (const entry of this.worktrees.values()) {
      if (entry.repoKey === repoKey || dirKey(entry.path) === repoKey) names.add(entry.branch);
    }
    for (const name of this.unmergedBranches) names.add(name);

    return [...names].map((name) => ({ name, merged: !this.unmergedBranches.includes(name) }));
  }

  async branchExists(dir: string, branch: string): Promise<boolean> {
    if (this.declaredBranches.has(branch)) return true;
    const repoKey = dirKey(dir);
    for (const entry of this.worktrees.values()) {
      if (entry.repoKey === repoKey && entry.branch === branch) return true;
      // A worktree is asked about its own directory as often as about the repo it came from.
      if (dirKey(entry.path) === repoKey && entry.branch === branch) return true;
    }
    return false;
  }

  /**
   * Commits by re-baselining the worktree: after this the directory no longer differs by
   * anything, which is precisely what makes `removeWorktree` stop refusing it.
   */
  async commit(dir: string, options: { message: string }): Promise<CommitResult> {
    if (this.failNextCommit) {
      const message = this.failNextCommit;
      this.failNextCommit = null;
      throw new GitError(`git commit failed: ${message}`);
    }

    if ((await this.changes(dir)).length === 0) {
      return { committed: false, head: (await this.info(dir))?.head ?? null };
    }

    const entry = this.worktrees.get(dirKey(dir));
    if (entry) {
      entry.base = await snapshot(dir);
      entry.head = `commit${this.commits.length + 1}`;
      // The branch outlives the directory, which is the whole point of committing: the
      // worktree row is deleted the moment the tree comes away, and the work is still there.
      this.declaredBranches.add(entry.branch);
    }
    this.commits.push({ dir, message: options.message });
    return { committed: true, head: entry?.head ?? 'committed' };
  }

  async push(
    dir: string,
    options: { branch: string; remote?: string; setUpstream?: boolean; auth?: GitAuth },
  ): Promise<void> {
    this.authSeen.push(options.auth);
    if (this.failNextPush) {
      const message = this.failNextPush;
      this.failNextPush = null;
      throw new GitError(`git push failed: ${message}`);
    }
    this.pushes.push({ dir, branch: options.branch, remote: options.remote ?? 'origin' });
    this.declaredBranches.add(options.branch);
  }

  async fastForward(dir: string, options: { branch?: string } = {}): Promise<FastForwardResult> {
    if (this.fastForwardResult) return this.fastForwardResult;
    const info = await this.info(dir);
    const branch = options.branch ?? info?.currentBranch ?? null;
    return {
      status: 'current',
      branch,
      upstream: branch ? `origin/${branch}` : null,
      from: info?.head ?? null,
      to: info?.head ?? null,
      detail: `'${branch}' is already at origin/${branch}`,
    };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A forge that records what it was asked to open. Answers null until a test says otherwise,
 * which is the ordinary case — no token, or a project that did not ask for merge requests.
 */
/**
 * A stand-in for the machine Pomni is running on.
 *
 * Records what would have been launched instead of launching it, which is the only way to test
 * this at all — a passing test must not open an editor on the machine running the suite.
 *
 * `installed` is what pretends to be on PATH, and it is empty by default: a machine with no
 * editor is the case the button has to handle gracefully, and defaults should make the awkward
 * case the one you see first.
 */
export class FakeDesktop implements DesktopPort {
  installed = new Set<string>();
  opened: Array<{ command: string; path: string }> = [];
  revealed: string[] = [];

  async canRun(command: string): Promise<boolean> {
    return this.installed.has(command);
  }

  async open(command: string, path: string): Promise<void> {
    if (!this.installed.has(command)) throw new Error(`'${command}' is not on PATH`);
    this.opened.push({ command, path });
  }

  async reveal(path: string): Promise<void> {
    this.revealed.push(path);
  }
}

export class FakeForge implements ForgePort {
  asked: OpenMergeRequestInput[] = [];
  /** What to answer. Null models a forge that could not be reached or does not know this host. */
  answer: MergeRequestRef | null = null;
  failNext: string | null = null;

  async openMergeRequest(input: OpenMergeRequestInput): Promise<MergeRequestRef | null> {
    this.asked.push(input);
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    return this.answer;
  }
}

/** Scripted process runner: match a command, decide the exit code and the output. */
export class FakeExecutor implements Executor {
  calls: ExecRequest[] = [];
  killed: number[] = [];
  script: Array<{ match: RegExp; exitCode: number; output?: string; delayMs?: number }> = [];
  missing = new Set<string>();
  /** Pids a test has declared gone, for `isAlive`. */
  dead = new Set<number>();

  async run(request: ExecRequest): Promise<ExecResult> {
    this.calls.push(request);
    request.onStart?.(4242);

    const entry = this.script.find((item) => item.match.test(request.cmd));
    if (entry?.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
    if (entry?.output) request.onOutput?.(entry.output);

    return { exitCode: entry?.exitCode ?? 0, timedOut: false, cancelled: false, pid: 4242 };
  }

  async kill(pid: number): Promise<boolean> {
    this.killed.push(pid);
    return true;
  }

  async which(command: string): Promise<string | null> {
    return this.missing.has(command) ? null : `/usr/bin/${command}`;
  }

  /**
   * Every pid is alive unless a test says otherwise — a run this process started really is
   * running, and the interesting case is the one whose process is gone.
   */
  async isAlive(pid: number): Promise<boolean> {
    return !this.dead.has(pid);
  }
}

/**
 * A restart port that never spawns a process, never runs a real build, and never lets a
 * successor come up mid-test. `replace()` records that it was called and then hangs, exactly
 * as the real port does on success — the caller never awaits it, only checks whether it fired.
 */
export class FakeRestartPort implements RestartPort {
  supervisionResult: Supervision = { mode: 'self', detail: 'fake: no supervisor, can self-replace' };
  buildResult: BuildOutcome = { ok: true, steps: [] };
  supervisionCalls = 0;
  buildCalls = 0;
  replaceCalls: Array<{ graceMs?: number } | undefined> = [];

  async supervision(): Promise<Supervision> {
    this.supervisionCalls += 1;
    return this.supervisionResult;
  }

  async build(): Promise<BuildOutcome> {
    this.buildCalls += 1;
    return this.buildResult;
  }

  async replace(options?: { graceMs?: number }): Promise<never> {
    this.replaceCalls.push(options);
    // Never resolves — a real successful replace never returns either, because this process
    // is gone by the time it would. A test that cares reads `replaceCalls`, not the promise.
    return new Promise<never>(() => {});
  }
}

/** Keeps run output in memory so tests can assert on it without touching disk. */
export class MemoryLogSink implements LogSink {
  logs = new Map<string, string>();

  async open(runId: string): Promise<void> {
    this.logs.set(runId, '');
  }

  write(runId: string, chunk: string): void {
    this.logs.set(runId, (this.logs.get(runId) ?? '') + chunk);
  }

  async close(): Promise<void> {}
}

/**
 * A model that answers with whatever the test set, and records what it was asked. Keeps the
 * suite free of network calls and of credentials.
 */
export class FakeLlm implements LlmPort {
  calls: Array<LlmRequest & { tools?: LlmToolSpec[] }> = [];
  /** Answers handed out in order, one per call. Falls back to `reply` once empty. */
  replies: string[] = [];
  reply = 'generated prompt';
  configured = true;
  /** Tool calls to emit, in order, before finishing. Each entry is one turn. */
  toolPlan: LlmToolCall[][] = [];
  toolResults: string[] = [];
  /**
   * Make `complete` throw for the calls whose system prompt matches.
   *
   * Matched on the prompt rather than counted, because a service may make more calls than a
   * test is thinking about — chat title generation is one — and "the third call fails" would
   * then be a different call tomorrow. The prompt says which job is failing.
   */
  failCompleteWhen: RegExp | null = null;

  /**
   * What each answer costs, when a test cares. Null by default, which is what a provider that
   * does not report a price says — the run then has no total, exactly as today.
   */
  costUsd: number | null = null;

  /**
   * Turns reported per call, shifted in call order across every agent sharing this fake —
   * the same order `calls` records them in. Falls back to `1` once empty, so a test that
   * never sets this sees the same "one turn per call" every other test relies on.
   */
  turnsQueue: number[] = [];

  /**
   * Usage reported per call, shifted the same way as `turnsQueue`. Falls back to the fixed
   * usage below, so a test caring only about turns need not also supply usage.
   */
  usageQueue: LlmUsage[] = [];

  /**
   * Usage to report turn by turn *inside* one call, so a caller's mid-session check can be
   * exercised.
   *
   * Each entry is one turn's own usage; the fake accumulates them the way a streaming
   * provider's frames do and consults `onTurn` after each. A caller that stops gets what a
   * real stopped session looks like — the text so far, `stoppedBy` set, and no cost, because
   * the frame carrying the cost is the one that never arrives.
   *
   * Empty by default, so every other test sees a call that reports its usage once at the end.
   */
  turnUsage: LlmUsage[] = [];

  /** What a session stopped part-way had already said. */
  partialText = 'as far as it got';

  /**
   * Awaited before every answer. A test that needs to see a run while it is still `running`
   * holds this open, does its asserting, then releases it. Unset by default, so every other
   * test stays synchronous.
   */
  gate?: () => Promise<void>;

  async complete(request: LlmRequest): Promise<LlmResult> {
    if (this.failCompleteWhen?.test(request.system ?? '')) {
      this.calls.push({ ...request, messages: [...request.messages] });
      throw new Error('the provider is unavailable');
    }

    // A copy: callers keep appending to the same conversation, and a recording that changes
    // after the fact cannot show what this call was actually given.
    this.calls.push({ ...request, messages: [...request.messages] });
    if (this.gate) await this.gate();

    if (request.onTurn && this.turnUsage.length > 0) {
      const used = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
      };

      for (const turn of this.turnUsage) {
        used.inputTokens += turn.inputTokens;
        used.outputTokens += turn.outputTokens;
        used.cacheReadTokens += turn.cacheReadTokens;
        used.cacheCreationTokens += turn.cacheCreationTokens;
        used.turns += 1;

        const stopped = request.onTurn(used);
        if (!stopped) continue;

        const { turns, ...usage } = used;
        return { text: this.partialText, stopReason: 'stopped', stoppedBy: stopped, usage, turns };
      }
    }

    return {
      text: this.replies.shift() ?? this.reply,
      stopReason: 'end_turn',
      usage:
        this.usageQueue.shift() ??
        { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      turns: this.turnsQueue.shift() ?? 1,
      ...(this.costUsd === null ? {} : { costUsd: this.costUsd }),
    };
  }

  async runWithTools(
    request: LlmRequest & { tools: LlmToolSpec[] },
    hooks: ToolLoopHooks,
  ): Promise<LlmResult> {
    this.calls.push(request);

    let turns = 0;
    for (const batch of this.toolPlan) {
      turns += 1;
      for (const call of batch) {
        this.toolResults.push(await hooks.onTool(call));
      }
    }

    hooks.onText?.(this.reply);
    return {
      text: this.reply,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      turns: turns + 1,
    };
  }

  async isConfigured(): Promise<boolean> {
    return this.configured;
  }

  async describeAuth(): Promise<string> {
    return 'fake';
  }
}

export interface SessionOptions {
  cwd?: string;
  dirs?: string[];
  tools?: ToolGrant[];
  files?: boolean;
  run?: boolean;
  web?: boolean;
  verify?: string[];
}

/**
 * Hands the same fake model back for every provider, so tests never reach a network.
 *
 * It records *which* provider each session was built for, not only the last set of options.
 * Once an agent can name its own provider, "the same fake for everyone" hides the only thing
 * a mixed-provider run is about: a factory that forgets its argument cannot tell a run that
 * spanned three providers from one that spanned none.
 */
export class FakeLlmFactory implements LlmFactory {
  /** The options the last session was built with — how a test sees what an agent was given. */
  lastOptions: SessionOptions = {};
  /** Every session opened, in order, with the provider it was opened for. */
  created: Array<{ providerId: string; options: SessionOptions }> = [];

  constructor(private readonly llm: FakeLlm) {}

  create(provider: Provider, options: SessionOptions = {}): LlmPort {
    this.lastOptions = options;
    this.created.push({ providerId: provider.id, options });
    return this.llm;
  }

  /** Provider ids of every session opened, in order. `status()` probes are not sessions. */
  providersUsed(): string[] {
    return this.created.map((entry) => entry.providerId);
  }
}

export interface TestHarness<G extends GitPort = FakeGit> extends PomniContainer {
  llm: FakeLlm;
  llmFactory: FakeLlmFactory;
  pipelineStore: SqlitePipelineStore;
  worktreeStore: SqliteWorktreeStore;
  chatStore: SqliteChatStore;
  commentStore: SqliteCommentStore;
  comments: CommentService;
  git: G;
  executor: FakeExecutor;
  forge: FakeForge;
  desktop: FakeDesktop;
  restart: FakeRestartPort;
  logs: MemoryLogSink;
  clock: FixedClock;
  dir: string;
  cleanup(): Promise<void>;
}

export interface HarnessOptions<G extends GitPort = FakeGit> {
  /**
   * The git every service is wired to. Defaults to `FakeGit`. Real worktree behaviour is
   * subtle enough that a fake agreeing with an implementation proves nothing on its own, so
   * this seam exists to run the same flows against `GitCli` and a real repository.
   */
  git?: G;
}

export async function createHarness<G extends GitPort = FakeGit>(
  options: HarnessOptions<G> = {},
): Promise<TestHarness<G>> {
  const dir = await mkdtemp(join(tempRoot(), 'pomni-test-'));
  const root = join(dir, '.pomni');

  const docs = new FileDocStore(root);
  const fs = new NodeFsProbe();
  const git = (options.git ?? (new FakeGit() as unknown as G)) as G;
  const clock = new FixedClock();
  const events = new InMemoryEventBus();
  const logger = new SilentLogger();
  const detection = new DetectorRegistry(fs);
  const secrets = new DefaultCredentialStore(docs);

  const executor = new FakeExecutor();
  const logs = new MemoryLogSink();
  const forge = new FakeForge();
  const desktop = new FakeDesktop();
  const runStore = new SqliteRunStore(docs.absolute(layout.database));

  const workspace = new WorkspaceService(docs, fs);
  const projects = new ProjectService(docs, clock, events);
  const credentials = new CredentialService(docs, secrets, git, clock);
  const repos = new RepoService(
    docs,
    projects,
    workspace,
    credentials,
    git,
    fs,
    detection,
    new NoProviderProbe(),
    clock,
    events,
    logger,
  );

  const runs = new RunService(
    docs,
    runStore,
    projects,
    repos,
    executor,
    logs,
    new DefaultOutputAnalyzer(),
    clock,
    events,
    logger,
  );
  // Shares pomni.db with the pipeline store, as the real container does.
  const pipelineStore = new SqlitePipelineStore(docs.absolute(layout.database));
  const worktreeStore = new SqliteWorktreeStore(docs.absolute(layout.database));
  const worktrees = new WorktreeService(
    docs,
    worktreeStore,
    pipelineStore,
    git,
    fs,
    executor,
    clock,
    events,
    logger,
  );

  const doctor = new DoctorService(projects, repos, executor, git, worktrees);
  // Tests are single-process: the lock adds latency without exercising anything.
  const commentStore = new SqliteCommentStore(docs.absolute(layout.database));
  const backlog = new BacklogService(
    docs,
    projects,
    runStore,
    new NoopLock(),
    clock,
    events,
    worktrees,
    logger,
    // Without this the item's activity is its transitions alone, and every test about a
    // comment sitting next to a move reads as unimplemented rather than unwired.
    commentStore,
  );
  const llm = new FakeLlm();
  const llmFactory = new FakeLlmFactory(llm);
  const providerService = new ProviderService(docs, llmFactory, clock, events);
  const workflows = new WorkflowService(docs, projects, providerService, clock, events);
  const tools = new ToolService(docs, projects, credentials, executor, clock, events, logger);
  const discovery = new DiscoveryService(repos, workflows, fs);

  // Shares pomni.db with the pipeline store, same as chat — one file, one set of connections.
  const comments = new CommentService(commentStore, clock, events, logger);

  // `comments` is new: PipelineService reads an item's comments into a run's context and lets
  // an agent write one mid-run (see comments-context.test.ts / comments-agent.test.ts). Passed
  // last so this line breaks loudly — a TypeError on the constructor's arity — until the
  // authors add the parameter, rather than silently binding to the wrong existing one.
  const pipelines = new PipelineService(
    docs,
    pipelineStore,
    projects,
    workflows,
    repos,
    providerService,
    tools,
    backlog,
    runs,
    git,
    clock,
    events,
    logger,
    worktrees,
    forge,
    comments,
    fs,
    workspace,
    desktop,
  );

  const chatStore = new SqliteChatStore(docs.absolute(layout.database));
  const chat = new ChatService(
    chatStore,
    providerService,
    projects,
    repos,
    backlog,
    workflows,
    tools,
    runs,
    pipelines,
    clock,
    events,
    logger,
    discovery,
  );

  await workspace.init();

  const restart = new FakeRestartPort();
  // The checkout `system` reports on. Not tracked as a git repo by default, matching a
  // tarball install — a test that wants `behindRepo` calls `git.trackRepo(dir, ...)` itself.
  const system = new SystemService(dir, restart, pipelines, runs, workspace, git, clock, events, logger);

  return {
    root,
    dir,
    workspace,
    projects,
    repos,
    credentials,
    backlog,
    workflows,
    discovery,
    providers: providerService,
    tools,
    pipelines,
    chat,
    runs,
    worktrees,
    doctor,
    system,
    detection,
    executor,
    forge,
    desktop,
    restart,
    llm,
    llmFactory,
    pipelineStore,
    worktreeStore,
    chatStore,
    commentStore,
    comments,
    runStore,
    logs,
    clock,
    events,
    fs,
    git,
    logger,
    cleanup: async () => {
      runStore.close();
      pipelineStore.close();
      worktreeStore.close();
      chatStore.close();
      commentStore.close();
      // The directory is not deleted here. Closing the handles is what a test needs to be
      // finished with its workspace; removing the bytes is housekeeping, and doing it six
      // hundred times in the middle of a run is what made a hook occasionally outlast its
      // thirty-second timeout. The whole tree goes at once in `tests/temp-root.ts`.
    },
  };
}

/**
 * Whether a real `git` is on PATH. Tests that drive `GitCli` skip rather than fail without
 * one — a machine with no git is a fact about the machine, not a broken change.
 */
export async function gitAvailable(): Promise<boolean> {
  try {
    await run('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * A real git repository with one real commit, for the tests that drive `GitCli`.
 *
 * `makeNodeRepo` writes a `package.json` and nothing else, which is enough for stack
 * detection and wrong for anything involving `git worktree add`.
 */
export async function makeGitRepo(
  dir: string,
  pkg: Record<string, unknown> = {},
): Promise<string> {
  await makeNodeRepo(dir, pkg);

  await run('git', ['init', '--initial-branch=main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'tests@pomni.invalid'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Pomni Tests'], { cwd: dir });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

/** Create a throwaway Node project on disk for detection and linking tests. */
export async function makeNodeRepo(
  dir: string,
  pkg: Record<string, unknown> = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'sample',
        scripts: { build: 'next build', test: 'vitest run', lint: 'eslint .', dev: 'next dev' },
        dependencies: { next: '^15.0.0' },
        devDependencies: { typescript: '^5.6.0', vitest: '^2.1.0' },
        ...pkg,
      },
      null,
      2,
    ),
  );
  return dir;
}
