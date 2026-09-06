import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DetectorRegistry } from '@pomni/adapters';
import {
  BacklogService,
  ChatService,
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
  type ExecRequest,
  type ExecResult,
  type Executor,
  type GitAuth,
  type GitPort,
  type LlmFactory,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type LlmToolCall,
  type LlmToolSpec,
  type LogSink,
  type PomniContainer,
  type Provider,
  type ToolGrant,
  type ToolLoopHooks,
  type VcsInfo,
  type WorktreeRef,
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
  private readonly tracked = new Map<string, { branch: string | null; head: string }>();
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
  trackRepo(dir: string, info: { branch?: string | null; head?: string } = {}): string {
    this.tracked.set(dirKey(dir), {
      branch: info.branch === undefined ? 'main' : info.branch,
      head: info.head ?? 'abc123',
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
        remote: null,
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
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
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
    return {
      text: this.replies.shift() ?? this.reply,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      turns: 1,
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

/** Hands the same fake model back for every provider, so tests never reach a network. */
class FakeLlmFactory implements LlmFactory {
  /** The options the last session was built with — how a test sees what an agent was given. */
  lastOptions: { cwd?: string; dirs?: string[]; tools?: ToolGrant[]; files?: boolean } = {};

  constructor(private readonly llm: FakeLlm) {}

  create(
    _provider: Provider,
    options: { cwd?: string; dirs?: string[]; tools?: ToolGrant[]; files?: boolean } = {},
  ): LlmPort {
    this.lastOptions = options;
    return this.llm;
  }
}

export interface TestHarness<G extends GitPort = FakeGit> extends PomniContainer {
  llm: FakeLlm;
  llmFactory: FakeLlmFactory;
  pipelineStore: SqlitePipelineStore;
  worktreeStore: SqliteWorktreeStore;
  chatStore: SqliteChatStore;
  git: G;
  executor: FakeExecutor;
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
  const dir = await mkdtemp(join(tmpdir(), 'pomni-test-'));
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
  const backlog = new BacklogService(
    docs,
    projects,
    runStore,
    new NoopLock(),
    clock,
    events,
    worktrees,
  );
  const llm = new FakeLlm();
  const llmFactory = new FakeLlmFactory(llm);
  const providerService = new ProviderService(docs, llmFactory, clock, events);
  const workflows = new WorkflowService(docs, projects, providerService, clock, events);
  const tools = new ToolService(docs, projects, credentials, executor, clock, events, logger);
  const discovery = new DiscoveryService(repos, workflows, fs);
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
    detection,
    executor,
    llm,
    llmFactory,
    pipelineStore,
    worktreeStore,
    chatStore,
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
      // Windows holds handles briefly after close; retry rather than fail the suite.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
