import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DetectorRegistry } from '@pomni/adapters';
import {
  BacklogService,
  ChatService,
  CredentialService,
  CommentService,
  DiscoveryService,
  DoctorService,
  NotInitializedError,
  ProjectService,
  PipelineService,
  ProviderService,
  RepoService,
  RunService,
  SystemService,
  ToolService,
  WorkflowService,
  WorkspaceService,
  WorktreeService,
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
  Desktop,
  ForgeClient,
  GitCli,
  HttpProviderProbe,
  InMemoryEventBus,
  NodeFsProbe,
  NodeRestartAdapter,
  ProcessExecutor,
  SqliteChatStore,
  SqlitePipelineStore,
  SqliteRunStore,
  SqliteCommentStore,
  SqliteWorktreeStore,
  SystemClock,
  findWorkspaceRoot,
  type LogLevel,
} from '@pomni/infra';

/**
 * The Pomni checkout this CLI's code was loaded from — what a restart rebuilds.
 *
 * Walks up from the compiled bundle (not `process.cwd()`, which is wherever the command was
 * typed) looking for the root `package.json`, identified by its `workspaces` field, which is
 * the one thing actually true of this repo and not of an arbitrary ancestor directory. Null
 * when there is no such ancestor — a global npm install with no checkout — and callers must
 * treat that as "cannot self-restart" rather than guess a directory.
 */
function findSelfRepoDir(fromFileUrl: string): string | null {
  let dir = dirname(fileURLToPath(fromFileUrl));
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // Not readable as JSON — keep walking up rather than treating it as a match.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
  const desktop = new Desktop();
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

  // Shares pomni.db with the pipeline store, so it is constructed here rather than beside
  // the other worktree wiring below.
  const pipelineStore = new SqlitePipelineStore(docs.absolute(layout.database));
  const worktreeStore = new SqliteWorktreeStore(docs.absolute(layout.database));
  const commentStore = new SqliteCommentStore(docs.absolute(layout.database));
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
  const backlog = new BacklogService(docs, projects, runStore, lock, clock, events, worktrees, logger);
  const providerService = new ProviderService(docs, new DefaultLlmFactory(), clock, events);
  const workflows = new WorkflowService(docs, projects, providerService, clock, events);
  const tools = new ToolService(docs, projects, credentials, executor, clock, events, logger);
  const discovery = new DiscoveryService(repos, workflows, fs);
  const comments = new CommentService(commentStore, clock, events, logger);
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
    new ForgeClient(),
    comments,
    fs,
    workspace,
    desktop,
  );
  // Empty rather than `process.cwd()` on purpose: a fallback directory that happens to look
  // like a project would let the adapter rebuild and replace this process with the wrong
  // code, silently. An empty path has no `package.json`, so `supervision()` has no honest
  // answer but "unsupported" — which is the failure mode this exists to surface, not hide.
  const selfRepoDir = findSelfRepoDir(import.meta.url);
  if (selfRepoDir === null) {
    logger.warn(
      'could not locate the Pomni checkout this process is running from; restart is unsupported',
    );
  }
  const restart = new NodeRestartAdapter({
    repoDir: selfRepoDir ?? '',
    logger,
  });
  const system = new SystemService(
    selfRepoDir ?? '',
    restart,
    pipelines,
    runs,
    workspace,
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
    discovery,
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
    worktrees,
    system,
    detection,
    executor,
    runStore,
    events,
    fs,
    git,
    desktop,
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
