import type {
  EventBus,
  Executor,
  DesktopPort,
  FsProbe,
  GitPort,
  Logger,
  RunStore,
  StackDetection,
} from '../ports/index.js';
import type { CredentialService } from './credential-service.js';
import type { BacklogService } from './backlog-service.js';
import type { ChatService } from './chat-service.js';
import type { CommentService } from './comment-service.js';
import type { DoctorService } from './doctor-service.js';
import type { NotificationService } from './notification-service.js';
import type { RunService } from './run-service.js';
import type { DiscoveryService } from './discovery-service.js';
import type { PipelineService } from './pipeline-service.js';
import type { ProviderService } from './provider-service.js';
import type { ToolService } from './tool-service.js';
import type { WorkflowService } from './workflow-service.js';
import type { ProjectService } from './project-service.js';
import type { RepoService } from './repo-service.js';
import type { SystemService } from './system-service.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorktreeService } from './worktree-service.js';

/**
 * Everything a surface needs, assembled once at composition time.
 *
 * Surfaces receive a container; they never construct adapters themselves. That is what
 * lets the same services back the CLI, the HTTP server and (later) the MCP server without
 * any of them knowing which DocStore or GitPort implementation is in play.
 */
export interface PomniContainer {
  /** Absolute path to the `.pomni` directory this container is bound to. */
  root: string;
  workspace: WorkspaceService;
  projects: ProjectService;
  repos: RepoService;
  credentials: CredentialService;
  backlog: BacklogService;
  /** Notes on items and runs, written by people and by agents. */
  comments: CommentService;
  workflows: WorkflowService;
  discovery: DiscoveryService;
  providers: ProviderService;
  tools: ToolService;
  pipelines: PipelineService;
  chat: ChatService;
  runs: RunService;
  worktrees: WorktreeService;
  doctor: DoctorService;
  /** Tells a person when a run needs one: a question, a red gate, a merge request. */
  notifications: NotificationService;
  /** What this server is running, and replacing it with what was merged. */
  system: SystemService;
  detection: StackDetection;
  executor: Executor;
  runStore: RunStore;
  events: EventBus;
  fs: FsProbe;
  git: GitPort;
  /** Launching a program on this machine. The one port whose mistakes are visible on a screen. */
  desktop: DesktopPort;
  logger: Logger;
}
