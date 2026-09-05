import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DetectorRegistry } from '@pomni/adapters';
import {
  BacklogService,
  CredentialService,
  DoctorService,
  ProjectService,
  RepoService,
  RunService,
  PipelineService,
  ProviderService,
  WorkflowService,
  WorkspaceService,
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
  type ToolLoopHooks,
  type VcsInfo,
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
  SqlitePipelineStore,
  SilentLogger,
  SqliteRunStore,
} from '@pomni/infra';

/**
 * A git that records what it was asked to do and creates a plausible directory, so repo
 * flows can be tested without a network or a real remote.
 */
export class FakeGit implements GitPort {
  clones: CloneOptions[] = [];
  fetched: string[] = [];
  failNextClone: string | null = null;
  authSeen: Array<GitAuth | undefined> = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async isRepo(dir: string): Promise<boolean> {
    return this.clones.some((clone) => clone.dir === dir);
  }

  async clone(options: CloneOptions): Promise<void> {
    this.authSeen.push(options.auth);
    if (this.failNextClone) {
      const message = this.failNextClone;
      this.failNextClone = null;
      throw new Error(message);
    }
    options.onProgress?.('Receiving objects: 100%');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(options.dir, { recursive: true });
    await writeFile(join(options.dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    this.clones.push(options);
  }

  async info(dir: string): Promise<VcsInfo | null> {
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
}

/** Scripted process runner: match a command, decide the exit code and the output. */
export class FakeExecutor implements Executor {
  calls: ExecRequest[] = [];
  killed: number[] = [];
  script: Array<{ match: RegExp; exitCode: number; output?: string; delayMs?: number }> = [];
  missing = new Set<string>();

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
  reply = 'generated prompt';
  configured = true;
  /** Tool calls to emit, in order, before finishing. Each entry is one turn. */
  toolPlan: LlmToolCall[][] = [];
  toolResults: string[] = [];

  async complete(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request);
    return {
      text: this.reply,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 },
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
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 },
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
  constructor(private readonly llm: FakeLlm) {}

  create(): LlmPort {
    return this.llm;
  }
}

export interface TestHarness extends PomniContainer {
  llm: FakeLlm;
  git: FakeGit;
  executor: FakeExecutor;
  logs: MemoryLogSink;
  dir: string;
  cleanup(): Promise<void>;
}

export async function createHarness(): Promise<TestHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'pomni-test-'));
  const root = join(dir, '.pomni');

  const docs = new FileDocStore(root);
  const fs = new NodeFsProbe();
  const git = new FakeGit();
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
  const doctor = new DoctorService(projects, repos, executor, git);
  // Tests are single-process: the lock adds latency without exercising anything.
  const backlog = new BacklogService(docs, projects, runStore, new NoopLock(), clock, events);
  const llm = new FakeLlm();
  const providerService = new ProviderService(docs, new FakeLlmFactory(llm), clock, events);
  const workflows = new WorkflowService(docs, projects, providerService, clock, events);
  const pipelineStore = new SqlitePipelineStore(docs.absolute(layout.database));
  const pipelines = new PipelineService(
    docs,
    pipelineStore,
    projects,
    workflows,
    repos,
    providerService,
    clock,
    events,
    logger,
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
    providers: providerService,
    pipelines,
    runs,
    doctor,
    detection,
    executor,
    llm,
    runStore,
    logs,
    events,
    fs,
    git,
    logger,
    cleanup: async () => {
      runStore.close();
      pipelineStore.close();
      // Windows holds handles briefly after close; retry rather than fail the suite.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Create a throwaway Node project on disk for detection and linking tests. */
export async function makeNodeRepo(
  dir: string,
  pkg: Record<string, unknown> = {},
): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
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
