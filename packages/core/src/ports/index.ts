import type { ZodType, ZodTypeDef } from 'zod';
import type { Capability, CapabilityMap } from '../domain/capability.js';
import type { Chat, ChatFilter, ChatMessage } from '../domain/chat.js';
import type { Comment, CommentAuthor, CommentFilter } from '../domain/comment.js';
import type { Credential } from '../domain/credential.js';
import type { VcsInfo } from '../domain/repo.js';
import type {
  Artifact,
  PipelineFilter,
  PipelineRun,
  PipelineStep,
  Question,
} from '../domain/pipeline.js';
import type { Run, RunFilter, TestResult } from '../domain/run.js';
import type { Worktree, WorktreeFilter } from '../domain/worktree.js';

/**
 * Ports: the only things the application layer is allowed to depend on.
 * Implementations live in @pomni/infra and @pomni/adapters and are injected at
 * composition time (packages/cli/src/container.ts).
 */

// ---------------------------------------------------------------------------
// Doc store
// ---------------------------------------------------------------------------

export interface DocRef<T> {
  data: T;
  /** Hash of the file bytes. Derived, never stored inside the document. */
  rev: string;
}

export interface WriteOptions {
  /** Fail with StaleRevisionError unless the file still has this rev. */
  ifMatch?: string;
  /** Fail with ConflictError if the file already exists. */
  mustNotExist?: boolean;
}

export interface DocStore {
  root: string;
  /**
   * The third type argument is the schema's *input* type, which differs from its output
   * whenever the schema uses `.default()`. Widening it here lets callers pass a schema
   * with defaults and still get the parsed (fully populated) type back.
   */
  read<T>(relPath: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<DocRef<T> | null>;
  /** Returns the new rev. Writes are atomic (temp file + rename). */
  write<T>(relPath: string, data: T, options?: WriteOptions): Promise<string>;
  delete(relPath: string): Promise<void>;
  /** File names (not paths) directly inside relDir. Empty array if it does not exist. */
  list(relDir: string): Promise<string[]>;
  exists(relPath: string): Promise<boolean>;
  removeDir(relDir: string): Promise<void>;
  ensureDir(relDir: string): Promise<void>;
  absolute(relPath: string): string;
}

// ---------------------------------------------------------------------------
// Filesystem probing (reading the user's machine, outside .pomni)
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** Contains a .git directory — worth surfacing in a directory picker. */
  isGitRepo: boolean;
}

export interface FsProbe {
  exists(absPath: string): Promise<boolean>;
  isDirectory(absPath: string): Promise<boolean>;
  readText(absPath: string): Promise<string | null>;
  /** Shallow listing, directories first, hidden entries omitted unless asked. */
  listDir(absPath: string, options?: { includeHidden?: boolean }): Promise<DirEntry[]>;
  /** Names of entries directly inside absPath. Cheap existence checks for detectors. */
  listNames(absPath: string): Promise<string[]>;
  remove(absPath: string): Promise<void>;
  /** Filesystem roots: drive letters on Windows, '/' elsewhere. */
  roots(): Promise<string[]>;
  home(): string;
  resolve(input: string): string;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitAuth {
  username: string;
  secret: string;
}

export interface CloneOptions {
  url: string;
  dir: string;
  ref?: string;
  auth?: GitAuth;
  depth?: number;
  onProgress?: (line: string) => void;
}

export interface WorktreeRef {
  /** Absolute path git reports. */
  path: string;
  /** Null when the worktree is on a detached HEAD. */
  branch: string | null;
  head: string | null;
  /** git's own flag: the directory is gone but the admin entry survives. */
  prunable: boolean;
}

/**
 * What a fast-forward found. Every arm is a fact about the repository, not an error:
 * a diverged or dirty clone is a normal state that has to be reported rather than resolved.
 */
export interface FastForwardResult {
  status: 'advanced' | 'current' | 'diverged' | 'dirty' | 'no-upstream' | 'unavailable';
  branch: string | null;
  upstream: string | null;
  /** HEAD before and after. Equal whenever `status` is not `advanced`. */
  from: string | null;
  to: string | null;
  /** One sentence a person reads. Always set; the status alone does not explain itself. */
  detail: string;
}

/**
 * What merging the base into a run's branch found.
 *
 * `already` means the branch was up to date and nothing moved — the common case, and the one
 * where the gate that follows is answering the same question either way. `conflict` is a fact
 * about the two branches, never an error: it says the work needs a person before it can land,
 * which is exactly what a reviewer needs to be told before they read it.
 */
export interface MergeResult {
  status: 'merged' | 'already' | 'conflict' | 'unavailable';
  /** Files git could not reconcile. Empty unless `status` is `conflict`. */
  conflicts: string[];
  detail: string;
}

export interface BranchRef {
  name: string;
  /** Contained in the ref it was compared against, so its commits are not the only copy. */
  merged: boolean;
}

export interface CommitResult {
  /** False when the tree was clean — an empty commit is never made. */
  committed: boolean;
  head: string | null;
  /** Set when git had no identity of its own and Pomni supplied one. */
  identityBorrowed?: boolean;
}

export interface GitPort {
  isAvailable(): Promise<boolean>;
  isRepo(dir: string): Promise<boolean>;
  clone(options: CloneOptions): Promise<void>;
  /** Null when dir is not a git repo. */
  info(dir: string): Promise<VcsInfo | null>;
  fetch(dir: string, auth?: GitAuth): Promise<void>;
  /** Verify credentials against a remote without cloning. */
  testRemote(url: string, auth?: GitAuth): Promise<void>;
  /** Files changed in the working copy, as `{ path, change }`. Empty when clean. */
  changes(dir: string): Promise<Array<{ path: string; change: string }>>;
  /** True when `refs/heads/<branch>` exists in this repository. */
  branchExists(dir: string, branch: string): Promise<boolean>;
  /**
   * Local branches, and whether each is already contained in `mergedInto`.
   *
   * The second half is the whole point: a branch that is merged is work you can find in the
   * history, and a branch that is not is work that exists nowhere else.
   */
  branches(dir: string, mergedInto: string): Promise<BranchRef[]>;
  /**
   * Merge `ref` into whatever `dir` has checked out, so the gate can be run on the result.
   *
   * Never leaves a half-merged tree: a conflict is aborted before returning, because the
   * caller's next move is to run a build here and a tree full of conflict markers would fail
   * it for the wrong reason. Never throws — every outcome is a `MergeResult` to report.
   */
  mergeInto(dir: string, ref: string): Promise<MergeResult>;
  /**
   * Stage everything and commit it. Returns `committed: false` on a clean tree rather than
   * making an empty commit — an empty commit is a claim that a run did work when it did not.
   * Throws GitError when git refuses for any other reason.
   */
  commit(dir: string, options: { message: string }): Promise<CommitResult>;
  /**
   * `git push` one branch. Throws GitError with the forge's own words on rejection, so a
   * caller can report it without guessing why.
   */
  push(
    dir: string,
    options: { branch: string; remote?: string; setUpstream?: boolean; auth?: GitAuth },
  ): Promise<void>;
  /**
   * Advance a branch to its upstream, and only ever that.
   *
   * Never merges, never resets: a diverged clone holds commits that exist nowhere else, and
   * being out of date is the cheaper of the two failures. Never throws — every outcome is a
   * `FastForwardResult` the caller reports.
   */
  fastForward(dir: string, options?: { branch?: string }): Promise<FastForwardResult>;
  /** True when this git can do worktrees at all (2.5+). Implementations may cache per process. */
  supportsWorktrees(): Promise<boolean>;
  /** `git -C repoDir worktree add -b <branch> <path> <baseRef>`. Throws GitError. */
  addWorktree(
    repoDir: string,
    options: { path: string; branch: string; baseRef: string },
  ): Promise<{ head: string }>;
  /**
   * `git -C repoDir worktree add <path> <branch>` — the same directory, back on the branch it
   * already has. Attaching rather than creating is what lets a resumed run carry on in its own
   * tree; `addWorktree` always passes `-b` and so can only ever be a first attempt.
   */
  attachWorktree(repoDir: string, options: { path: string; branch: string }): Promise<{ head: string }>;
  /**
   * `git -C repoDir worktree remove <path>`, then delete `options.deleteBranch` if given.
   * Never uses --force: git refusing on a dirty tree is the mechanism by which uncommitted
   * work is kept, not an obstacle to route around. Throws GitError.
   */
  removeWorktree(repoDir: string, path: string, options?: { deleteBranch?: string }): Promise<void>;
  listWorktrees(repoDir: string): Promise<WorktreeRef[]>;
  /** `git -C repoDir worktree prune` — clears admin entries for directories already gone. */
  pruneWorktrees(repoDir: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Forge detection
// ---------------------------------------------------------------------------

/**
 * Works out which forge hosts a url when the hostname does not say. Only consulted for
 * hosts that are not one of the well-known ones, and always allowed to answer 'generic'.
 */
export interface ProviderProbe {
  probe(url: string): Promise<'github' | 'gitlab' | 'bitbucket' | 'generic'>;
}

// ---------------------------------------------------------------------------
// Forge
// ---------------------------------------------------------------------------

export interface OpenMergeRequestInput {
  /** The repository's remote url. What the API host and the project path are derived from. */
  remote: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
  auth?: GitAuth;
  sourceBranch: string;
  /** Null asks the forge for its own default branch, rather than guessing at `main`. */
  targetBranch: string | null;
  title: string;
  description: string;
}

export interface MergeRequestRef {
  url: string;
  /** True when this call created it; false when one for the branch already existed. */
  created: boolean;
  /** The forge's own number, when it has one. */
  number: number | null;
}

/**
 * Opens a merge request through a forge's API.
 *
 * Allowed to answer null for a forge it does not know, a remote it cannot parse, or a
 * credential that is missing — every one of which is an ordinary case with a good fallback
 * (the url a person opens themselves), not an error. Throws only when the forge answered and
 * the answer was a refusal worth reporting.
 */
export interface ForgePort {
  openMergeRequest(input: OpenMergeRequestInput): Promise<MergeRequestRef | null>;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface CredentialStore {
  /** Resolve to a token. Null when the source is configured but empty. */
  resolve(credential: Credential): Promise<string | null>;
  /** Only meaningful for `file` secret refs; throws otherwise. */
  put(credentialId: string, secret: string): Promise<void>;
  forget(credentialId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stack detection
// ---------------------------------------------------------------------------

export interface DetectionResult {
  adapter: string;
  detected: string[];
  capabilities: CapabilityMap;
}

export interface StackDetector {
  name: string;
  /** Null when this detector does not recognise the directory. */
  detect(dir: string, fs: FsProbe): Promise<DetectionResult | null>;
}

export interface StackDetection {
  detect(dir: string): Promise<DetectionResult | null>;
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

export interface ExecRequest {
  /** Shell command line, exactly as declared on the capability. */
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Called once the child exists, so a caller can record the pid and cancel later. */
  onStart?: (pid: number) => void;
  /** stdout and stderr interleaved in arrival order. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  pid: number | null;
}

export interface Executor {
  run(request: ExecRequest): Promise<ExecResult>;
  /** Kill a process tree started by any Pomni process, by pid. */
  kill(pid: number): Promise<boolean>;
  /** Whether a command's executable resolves on PATH — used by `repo doctor`. */
  which(command: string, cwd: string): Promise<string | null>;
  /** Whether a pid is a live process. `process.kill(pid, 0)` semantics. */
  isAlive(pid: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------

export interface RunStore {
  insert(run: Run): Promise<void>;
  update(id: string, patch: Partial<Run>): Promise<void>;
  get(id: string): Promise<Run | null>;
  list(filter: RunFilter): Promise<Run[]>;
  /** Most recent run per (repo, capability) — what a gate consults. */
  latest(projectId: string, capability: string): Promise<Run[]>;
  putTestResults(runId: string, results: TestResult[]): Promise<void>;
  testResults(runId: string): Promise<TestResult[]>;
  close(): void;
}

export * from './llm.js';
export * from './restart.js';

// ---------------------------------------------------------------------------
// Pipeline store
// ---------------------------------------------------------------------------

export interface PipelineStore {
  insertRun(run: PipelineRun): Promise<void>;
  updateRun(id: string, run: PipelineRun): Promise<void>;
  getRun(id: string): Promise<PipelineRun | null>;
  listRuns(filter: PipelineFilter): Promise<PipelineRun[]>;
  insertStep(step: PipelineStep): Promise<void>;
  updateStep(id: string, step: PipelineStep): Promise<void>;
  steps(runId: string): Promise<PipelineStep[]>;
  putArtifacts(artifacts: Artifact[]): Promise<void>;
  artifacts(runId: string): Promise<Artifact[]>;
  insertQuestion(question: Question): Promise<void>;
  updateQuestion(id: string, question: Question): Promise<void>;
  getQuestion(id: string): Promise<Question | null>;
  questions(runId: string): Promise<Question[]>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Worktree store
// ---------------------------------------------------------------------------

/**
 * The per-run worktrees that exist right now. A row exists if and only if a directory
 * exists — a cleanly removed worktree is deleted here in the same step, which is why there
 * is no `released` status to query for.
 */
export interface WorktreeStore {
  insert(worktree: Worktree): Promise<void>;
  update(id: string, worktree: Worktree): Promise<void>;
  get(id: string): Promise<Worktree | null>;
  /** The one a run holds for a repo, or null. */
  forRun(runId: string, repoId: string): Promise<Worktree | null>;
  list(filter: WorktreeFilter): Promise<Worktree[]>;
  delete(id: string): Promise<void>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Chat store
// ---------------------------------------------------------------------------

/**
 * Chats and their transcripts. SQLite, alongside the run and pipeline stores — a chat is an
 * append-heavy log that nobody edits by hand, which is the opposite of what `.pomni/**.yaml` is
 * for. Messages are never rewritten except to settle an action on them, so `updateMessage`
 * takes the whole message rather than a patch.
 */
export interface ChatStore {
  createChat(chat: Chat): Promise<void>;
  /** Newest `updatedAt` first. */
  listChats(filter?: ChatFilter): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | null>;
  updateChat(chat: Chat): Promise<void>;
  /**
   * Settle the title, and nothing else on the row.
   *
   * A whole-row `updateChat` cannot do this: the title is generated off the request path, so a
   * turn can land between reading the chat and writing it back, and writing the row back would
   * revert that turn's `updatedAt`, its `#project` and its token totals. It also makes the
   * `titleGeneratedAt` guard real rather than advisory — the check and the write are one
   * statement, so a hand rename cannot be clobbered by a generation that read before it.
   *
   * `UPDATE chats SET title = ?, titleGeneratedAt = ? WHERE id = ? AND titleGeneratedAt IS NULL`.
   * True when it wrote a row, false when a title was already settled.
   */
  settleTitle(chatId: string, title: string, at: string): Promise<boolean>;
  /** Cascades to its messages. */
  deleteChat(id: string): Promise<void>;
  appendMessage(message: ChatMessage): Promise<void>;
  updateMessage(message: ChatMessage): Promise<void>;
  /** `createdAt` ascending. */
  listMessages(chatId: string): Promise<ChatMessage[]>;
  getMessage(id: string): Promise<ChatMessage | null>;
}

// ---------------------------------------------------------------------------
// Comment store
// ---------------------------------------------------------------------------

/**
 * Notes on items and runs. SQLite beside the pipeline and chat stores — an append-only log
 * nobody edits by hand, which is the opposite of what `.pomni/**.yaml` is for.
 *
 * There is no `update`, deliberately. A comment's text is immutable: what an agent was told is
 * part of the record of why it did what it did, so the only writes after an insert are the
 * three fields that settle it — resolved, and deleted, each with its own method saying so.
 */
export interface CommentStore {
  insert(comment: Comment): Promise<void>;
  get(id: string): Promise<Comment | null>;
  /** Ordered by `id`. Tombstones hidden unless `includeDeleted`. */
  list(filter: CommentFilter): Promise<Comment[]>;
  /**
   * An item's live comments, oldest first — what a run started from it is given as context.
   * Never returns a deleted one, `includeDeleted` or not: there is no reader of this that
   * would want a retracted note put in front of an agent.
   */
  forRunContext(itemId: string): Promise<Comment[]>;
  /** Addressed to somebody and still unanswered. What the item shows as waiting on a person. */
  outstanding(itemId: string): Promise<Comment[]>;
  /** Every comment an agent wrote from this run, wherever it landed. */
  byAuthorRun(runId: string): Promise<Comment[]>;
  /** No-op when already resolved; refuses a comment that was never addressed to anyone. */
  markResolved(
    id: string,
    resolution: { at: string; by: CommentAuthor; byCommentId: string | null },
  ): Promise<void>;
  /** A tombstone: the text stays on the row and no reader shows it. */
  markDeleted(id: string, deletion: { at: string; by: CommentAuthor }): Promise<void>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

/**
 * Held only for the handful of operations that write more than one file — creating an item
 * bumps a counter in `project.yaml` as well as writing the item. Single-file writes rely on
 * `rev` instead and take no lock at all.
 */
export interface Lock {
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Ambient
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
  iso(): string;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export type PomniEvent =
  | { type: 'project.created'; projectId: string }
  | { type: 'project.updated'; projectId: string }
  | { type: 'project.removed'; projectId: string }
  | { type: 'repo.added'; projectId: string; repoId: string }
  | { type: 'repo.updated'; projectId: string; repoId: string; status: string }
  | { type: 'repo.removed'; projectId: string; repoId: string }
  | { type: 'repo.progress'; projectId: string; repoId: string; line: string }
  | { type: 'run.started'; projectId: string; repoId: string; runId: string; capability: string }
  | { type: 'run.output'; projectId: string; runId: string; chunk: string }
  | { type: 'workflow.changed'; workflowId: string }
  | { type: 'provider.changed' }
  | { type: 'tool.changed'; toolId: string }
  | { type: 'pipeline.started'; runId: string; projectId: string; workflowId: string; task: string }
  | {
      type: 'pipeline.step.started';
      runId: string;
      stepId: string;
      parentStepId: string | null;
      agentId: string;
      agentName: string;
      role: string;
      /** Where this step is running. An agent may name its own, so a run can span several. */
      providerId: string;
      model: string;
      depth: number;
      task: string;
    }
  | { type: 'pipeline.step.output'; runId: string; stepId: string; chunk: string }
  | {
      type: 'pipeline.step.finished';
      runId: string;
      stepId: string;
      agentId: string;
      status: string;
      summary: string;
    }
  | {
      type: 'pipeline.flow';
      runId: string;
      fromStepId: string;
      fromAgentId: string;
      toAgentId: string;
      task: string;
    }
  | {
      type: 'pipeline.question.asked';
      runId: string;
      questionId: string;
      agentName: string;
      question: string;
    }
  | { type: 'pipeline.question.answered'; runId: string; questionId: string }
  | {
      type: 'pipeline.escalated';
      runId: string;
      stepId: string;
      agentName: string;
      question: string;
    }
  | { type: 'pipeline.cancelling'; runId: string }
  | {
      type: 'pipeline.finished';
      runId: string;
      projectId: string;
      status: string;
      summary: string;
    }
  | { type: 'item.created'; projectId: string; itemId: string }
  | { type: 'item.changed'; projectId: string; itemId: string }
  | { type: 'item.transitioned'; projectId: string; itemId: string; from: string; to: string }
  | { type: 'item.removed'; projectId: string; itemId: string }
  | {
      type: 'run.finished';
      projectId: string;
      repoId: string;
      runId: string;
      capability: string;
      status: string;
      summary: string | null;
    }
  /**
   * A note was written, or withdrawn. The comment itself is not on the event: the store is
   * where a comment lives, and a browser told which one changed re-reads the list it is
   * showing. Putting the text here would copy every note into `.pomni/events.ndjson` as well.
   */
  | {
      type: 'comment.added';
      commentId: string;
      subject: string;
      subjectId: string;
      projectId: string;
      /** So a badge can say "an agent wrote this" without reading the comment first. */
      authorKind: string;
      /** Set when the note asks a named person something. Null otherwise. */
      addressedTo: string | null;
    }
  | {
      type: 'comment.deleted';
      commentId: string;
      subject: string;
      subjectId: string;
      projectId: string;
    }
  | { type: 'chat.changed'; chatId: string }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'chat.message.chunk'; chatId: string; messageId: string; text: string }
  | {
      type: 'chat.action.started';
      chatId: string;
      messageId: string;
      actionId: string;
      name: string;
      writes: boolean;
    }
  | {
      type: 'chat.action.finished';
      chatId: string;
      messageId: string;
      actionId: string;
      name: string;
      status: string;
      error: string | null;
    }
  | { type: 'chat.turn.finished'; chatId: string; messageId: string }
  /**
   * This process is about to be replaced. Deliberately not durable: it is a fact about one
   * process, and replaying it out of `.pomni/events.ndjson` into a server that just started
   * would tell that server it is going away.
   */
  | { type: 'system.restarting' }
  /** The successor could not be started, so this process is still the one serving. */
  | { type: 'system.restart.failed'; detail: string }
  | { type: 'worktree.taken'; projectId: string; repoId: string; runId: string; path: string }
  | {
      type: 'worktree.released';
      projectId: string;
      repoId: string;
      runId: string;
      path: string;
      kept: boolean;
      reason: string | null;
    };

export interface EmittedEvent {
  ts: string;
  /**
   * `remote` marks an event replayed from another process via `.pomni/events.ndjson`.
   * The file sink ignores those, which is what stops the two from looping.
   */
  origin: 'local' | 'remote';
}

export interface EventBus {
  emit(event: PomniEvent & { ts?: string }): void;
  /** Replay an event that originated in another process. Never written back to the file. */
  emitRemote(event: PomniEvent & { ts: string }): void;
  subscribe(handler: (event: PomniEvent & EmittedEvent) => void): () => void;
}

/**
 * Only these reach `.pomni/events.ndjson`. Output chunks are deliberately excluded — the
 * per-run log file is the output store, and duplicating it would make the stream unusable.
 */
export const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'project.created',
  'project.updated',
  'project.removed',
  'repo.added',
  'repo.updated',
  'repo.removed',
  'run.started',
  'run.finished',
  'workflow.changed',
  'provider.changed',
  'tool.changed',
  'pipeline.started',
  'pipeline.step.started',
  'pipeline.step.finished',
  'pipeline.flow',
  'pipeline.escalated',
  'pipeline.question.asked',
  'pipeline.question.answered',
  'pipeline.finished',
  'item.created',
  'item.changed',
  'item.transitioned',
  'item.removed',
  'comment.added',
  'comment.deleted',
  'worktree.taken',
  'worktree.released',
]);

export type { Capability, CapabilityMap, Run, RunFilter, TestResult };
