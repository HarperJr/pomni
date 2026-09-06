import { join, resolve } from 'node:path';
import { DetectorRegistry } from '@pomni/adapters';
import {
  BacklogService,
  ChatService,
  CredentialService,
  DiscoveryService,
  DoctorService,
  NotInitializedError,
  ProjectService,
  PipelineService,
  ProviderService,
  RepoService,
  RunService,
  ToolService,
  WorkflowService,
  WorkspaceService,
  layout,
  type PomniContainer,
} from '@pomni/core';
import {
  ConsoleLogger,
  DefaultCredentialStore,
  DefaultOutputAnalyzer,
  FileLock,
  FileDocStore,
  FileEventSink,
  FileLogSink,
  DefaultLlmFactory,
  GitCli,
  HttpProviderProbe,
  InMemoryEventBus,
  NodeFsProbe,
  ProcessExecutor,
  SqliteChatStore,
  SqlitePipelineStore,
  SqliteRunStore,
  SystemClock,
  findWorkspaceRoot,
  type LogLevel,
} from '@pomni/infra';

export interface ContainerOptions {
  /** Explicit workspace root (the directory *containing* `.pomni`, or `.pomni` itself). */
  root?: string;
  cwd?: string;
  logLevel?: LogLevel;
}

/**
 * The composition root. This is the only place in the codebase that knows which concrete
 * adapter backs each port — everything else takes the container.
 */
export function createContainer(root: string, logLevel: LogLevel = 'warn'): PomniContainer {
  const docs = new FileDocStore(root);
  const fs = new NodeFsProbe();
  const git = new GitCli();
  const clock = new SystemClock();
  const events = new InMemoryEventBus();
  const logger = new ConsoleLogger(logLevel);
  const detection = new DetectorRegistry(fs);
  const secrets = new DefaultCredentialStore(docs);
  const executor = new ProcessExecutor();
  const runStore = new SqliteRunStore(docs.absolute(layout.database));
  const lock = new FileLock(docs.absolute(layout.lock));

  // Lifecycle events reach `.pomni/events.ndjson`, which is how a run started here becomes
  // visible to a server running in another process.
  new FileEventSink(events, docs.absolute(layout.events));

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
    new HttpProviderProbe(),
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
    new FileLogSink(),
    new DefaultOutputAnalyzer(),
    clock,
    events,
    logger,
  );
  const doctor = new DoctorService(projects, repos, executor, git);
  const backlog = new BacklogService(docs, projects, runStore, lock, clock, events);
  const providerService = new ProviderService(docs, new DefaultLlmFactory(), clock, events);
  const workflows = new WorkflowService(docs, projects, providerService, clock, events);
  const tools = new ToolService(docs, projects, credentials, executor, clock, events, logger);
  const discovery = new DiscoveryService(repos, workflows, fs);
  const pipelineStore = new SqlitePipelineStore(docs.absolute(layout.database));
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
  );

  return {
    root,
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
    doctor,
    detection,
    executor,
    runStore,
    events,
    fs,
    git,
    logger,
  };
}

/** Where `pomni init` would create the workspace. */
export function rootForInit(options: ContainerOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  if (!options.root) return join(resolve(cwd), '.pomni');
  const base = resolve(cwd, options.root);
  return base.endsWith('.pomni') ? base : join(base, '.pomni');
}

/**
 * Find an existing workspace, searching upward from the cwd the way git finds `.git`,
 * so the CLI works from any subdirectory of the harness repo.
 */
export async function openContainer(options: ContainerOptions = {}): Promise<PomniContainer> {
  const cwd = options.cwd ?? process.cwd();

  const root = options.root
    ? rootForInit(options)
    : ((await findWorkspaceRoot(cwd)) ?? join(resolve(cwd), '.pomni'));

  const container = createContainer(root, options.logLevel);
  if (!(await container.workspace.isInitialized())) {
    throw new NotInitializedError(root);
  }
  return container;
}
