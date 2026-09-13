export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  current?: unknown;
  errors?: unknown;
  unmet?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly problem: Problem,
    readonly status: number,
  ) {
    super(problem.title);
    this.name = 'ApiError';
  }

  /** Set on a 422 from a refused transition — which requirements were not met, machine-readable. */
  get unmet(): UnmetRequirement[] | undefined {
    return this.problem.unmet as UnmetRequirement[] | undefined;
  }
}

export type SupervisionMode = 'supervised' | 'self' | 'unsupported';

export interface Supervision {
  mode: SupervisionMode;
  detail: string;
}

export interface BuildStepResult {
  cmd: string;
  exitCode: number | null;
  output: string;
}

export interface BuildOutcome {
  ok: boolean;
  steps: BuildStepResult[];
}

export interface ServerIdentity {
  startedAtCommit: string | null;
  headCommit: string | null;
  behindRepo: boolean;
  startedAt: string;
  supervision: Supervision;
}

export interface SystemHealth {
  ok: true;
  build: string | null;
  root: string;
  git: boolean;
  initialized: boolean;
  server: ServerIdentity;
}

export interface InFlightRun {
  kind: 'pipeline' | 'capability';
  id: string;
  projectId: string;
  itemId: string | null;
  what: string;
  startedAt: string;
}

export type RestartResult =
  | { outcome: 'unsupported'; supervision: Supervision }
  | { outcome: 'runs-in-flight'; runs: InFlightRun[] }
  | { outcome: 'build-failed'; build: BuildOutcome }
  | { outcome: 'restarting'; build: BuildOutcome; cancelled: InFlightRun[] };

export type RepoStatus = 'linked' | 'cloning' | 'ready' | 'error' | 'missing';
export type RepoRole = 'web' | 'api' | 'mobile' | 'desktop' | 'lib' | 'infra' | 'docs' | 'other';

export const REPO_ROLES: RepoRole[] = [
  'web',
  'api',
  'mobile',
  'desktop',
  'lib',
  'infra',
  'docs',
  'other',
];

export interface LocalSource {
  kind: 'local';
  path: string;
}

export interface GitSource {
  kind: 'git';
  url: string;
  ref?: string;
  credential?: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
}

export type RepoSource = LocalSource | GitSource;

export interface Capability {
  cmd: string;
  origin: 'detected' | 'manual';
  background?: boolean;
  port?: number;
}

export interface Stack {
  adapter: string;
  detected: string[];
  detectedAt: string;
}

export interface VcsInfo {
  isRepo: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
  remote: string | null;
  head: string | null;
  dirty: boolean;
}

export interface Repo {
  id: string;
  projectId: string;
  name: string;
  role: RepoRole;
  source: RepoSource;
  status: RepoStatus;
  stack: Stack | null;
  capabilities: Record<string, Capability>;
  worktrees: 'auto' | 'always' | 'never';
  vcs: VcsInfo | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  addedAt: string;
  updatedAt: string;
  workingDir: string;
  workingDirExists: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  itemPrefix: string;
  gates: { default: string[]; land: string[] };
  policy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  repoCount: number;
  repos: Array<Pick<Repo, 'id' | 'name' | 'role' | 'status' | 'stack'>>;
}

export interface Credential {
  id: string;
  name: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
  host: string;
  username: string;
  secretRef: { kind: 'env'; var: string } | { kind: 'gh-cli' } | { kind: 'file' };
  hasSecret: boolean;
  /** Masked tail of the token, e.g. `••••4f2a`. Never the whole thing. */
  secretHint: string | null;
  createdAt: string;
}

/**
 * A status is whatever a project's flow calls a state, so this is a plain string, not a
 * closed union — a project may declare states beyond the built-in eight. `ITEM_STATUSES`
 * below is only the built-in vocabulary, for callers that need a default list (a project
 * with no `taskFlow` behaves exactly as this list describes).
 */
export type ItemStatus = string;

export type ItemType = 'feature' | 'bug' | 'chore' | 'spike' | 'refactor' | 'docs';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Estimate = 'XS' | 'S' | 'M' | 'L' | 'XL';

export const ITEM_STATUSES: ItemStatus[] = [
  'backlog',
  'specced',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
];
export const ITEM_TYPES: ItemType[] = ['feature', 'bug', 'chore', 'spike', 'refactor', 'docs'];
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export interface FlowState {
  name: string;
  label: string;
  board: boolean;
  active: boolean;
}

/** One box in a definition of done. `key` is what is stored ticked; `label` is what a human reads. */
export interface ChecklistEntry {
  key: string;
  label: string;
}

export interface Requirements {
  acceptance: boolean;
  gate: string | null;
  checklist: ChecklistEntry[];
  fields: string[];
  sections: string[];
  spec: { sections: string[]; minCriteria: number } | null;
  dependencies: boolean;
}

export interface FlowTransition {
  from: string;
  to: string;
  requires: Requirements;
  /** A headline for a refusal on this arrow, led with by `RequirementsNotMetError`. */
  message?: string;
}

export interface Flow {
  states: FlowState[];
  initial: string;
  recover: string[];
  transitions: FlowTransition[];
}

/** One capability of one gate, on one repo, as the run store reported it. */
export interface GateShortfall {
  repo: string;
  capability: string;
  runId: string | null;
  finishedAt: string | null;
}

/**
 * A requirement that is not satisfied. No English lives here by design — the wording comes
 * from `describeUnmet`/`describeUnmetList` in `packages/core/src/domain/flow.ts`. The web
 * package cannot import core today (see `getItemFlow` below), so this shape is re-implemented
 * in prose on this side; keep it in sync with that file by hand. For the record, that file's
 * wording for the two section/dependency kinds is: `no 'Problem' section is written in the
 * item body` (`no 'Problem' and 'Plan' sections are written in the item body` for several) and
 * `depends on ACME-1, which is not done` (`, which are not done` for several).
 */
export type SpecGap =
  | { section: string; reason: 'missing' }
  | { section: string; reason: 'empty' }
  | { section: string; reason: 'placeholder' }
  | {
      section: string;
      reason: 'criteria';
      found: number;
      usable: number;
      needed: number;
      echoesTitle: number;
      placeholders: number;
    };

export type UnmetRequirement =
  | { kind: 'acceptance'; total: number; checked: number; unchecked: number }
  | { kind: 'gate'; gate: string; failing: GateShortfall[]; pending: GateShortfall[] }
  | { kind: 'checklist'; total: number; ticked: number; missing: ChecklistEntry[] }
  | { kind: 'fields'; missing: string[] }
  | { kind: 'sections'; missing: string[] }
  | { kind: 'dependencies'; total: number; unfinished: string[] }
  | { kind: 'spec'; gap: SpecGap };

/** One button a UI may draw: where to, what it says, whether it works and why not. */
export interface TransitionOffer {
  to: string;
  label: string;
  ok: boolean;
  /** Empty when `ok`. */
  unmet: UnmetRequirement[];
  /** `recovery` means the item's current status is not in the flow and this is a way out. */
  via: 'arrow' | 'recovery';
}

/** Who presses the button. `auto` means the item moves itself once its requirements are met. */
export type TransitionMode = 'auto' | 'manual';

/**
 * A pointer at one requirement on one arrow — what a checklist tick, a passed gate or a written
 * section *is*, not a sentence about it. Mirrors `RequirementRef` in
 * `packages/core/src/domain/flow.ts`.
 */
export type RequirementRef =
  | { kind: 'acceptance' }
  | { kind: 'gate'; gate: string }
  | { kind: 'checklist'; key: string }
  | { kind: 'field'; field: string }
  | { kind: 'section'; section: string }
  | { kind: 'spec'; section: string }
  | { kind: 'dependencies' };

/** One satisfied requirement and, where it is dated on disk, when it became true. */
export interface SatisfiedRequirement {
  requirement: RequirementRef;
  at: string | null;
}

/** A move an item could make right now, with everything a UI needs to offer or badge it. */
export interface EligibleMove {
  to: string;
  label: string;
  mode: TransitionMode;
  requires: Requirements;
  /** The last requirement to become true, or null when none of the satisfied ones is dated. */
  because: SatisfiedRequirement | null;
}

/** One move an item has made, recorded structurally. Mirrors `TransitionRecord`. */
export interface TransitionRecord {
  at: string;
  from: string;
  to: string;
  mode: TransitionMode;
  /** What a person typed when they made the move. Null for an automatic move. */
  comment: string | null;
  /** The requirement that completed an automatic move. Null for a manual move. */
  because: RequirementRef | null;
  forced: boolean;
}

export interface BacklogItem {
  id: string;
  projectId: string;
  title: string;
  type: ItemType;
  status: ItemStatus;
  priority: Priority;
  estimate: Estimate | null;
  repos: string[];
  labels: string[];
  dependsOn: string[];
  /** Optional frontmatter override for which paths this item edits. */
  touches: string[];
  order: number;
  branch: string | null;
  /** Definition-of-done boxes a human has ticked: checklist key -> ISO timestamp. */
  checklist: Record<string, string>;
  blockedReason: string | null;
  /** What it was doing before it was blocked — where unblocking puts it back. */
  statusBefore: ItemStatus | null;
  /** Every move this item has made since structured history existed, oldest first. */
  history: TransitionRecord[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

/**
 * Mirrors `packages/core/src/domain/schedule.ts`. The web package cannot import core today
 * (see `getItemFlow` above), so these shapes are re-implemented here; keep them in sync by hand.
 */
export type PathScope =
  | { kind: 'paths'; paths: string[]; source: 'touches' | 'plan' }
  | { kind: 'whole-repo' };

export type ConflictReason =
  | { kind: 'depends_on'; from: string; to: string; via: string[] }
  | { kind: 'shared_repo'; repo: string }
  | { kind: 'path_overlap'; path: string; otherPath: string };

export interface ConflictEdge {
  a: string;
  b: string;
  reasons: ConflictReason[];
}

export interface Wave {
  index: number;
  itemIds: string[];
}

export interface BlockedItem {
  itemId: string;
  waitingOn: string[];
}

export interface WavePlan {
  waves: Wave[];
  conflicts: ConflictEdge[];
  blocked: BlockedItem[];
  scopes: Record<string, PathScope>;
}

/**
 * A note on an item or a run.
 *
 * Mirrors `Comment` in `packages/core/src/domain/comment.ts`. The author is a discriminated
 * union on purpose: an agent's note must never render as a person's, and a single `author`
 * string would make that distinction a matter of what the writer typed.
 */
export type CommentAuthor =
  | { kind: 'person'; name: string }
  | { kind: 'agent'; agentId: string; agentName: string; runId: string };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line Pomni wrote about itself. Mirrors `LogEntry` in `packages/core/src/domain/log.ts`. */
export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
  detail: string;
}

export interface Comment {
  id: string;
  subject: 'item' | 'run';
  subjectId: string;
  projectId: string;
  author: CommentAuthor;
  text: string;
  attachments: { name: string; content: string; origin: string }[];
  addressedTo: string | null;
  resolvedAt: string | null;
  resolvedBy: CommentAuthor | null;
  createdAt: string;
  deletedAt: string | null;
  deletedBy: CommentAuthor | null;
}

export interface BacklogItemDetail extends BacklogItem {
  /**
   * Every move a UI should draw, each with whether it will work and, when it will not, the
   * unmet requirements behind it.
   */
  allowedTransitions: TransitionOffer[];
  /**
   * Moves this item could make right now with nothing outstanding — "ready to move to X". A
   * non-empty `auto` entry means the move has not been performed yet, not that it will not be.
   */
  eligible: EligibleMove[];
  /** The item's state as its project's flow describes it, or null when it is off-flow. */
  flowState: FlowState | null;
  /** True when the stored status is not a state in the project's flow. */
  offFlow: boolean;
  blockedBy: string[];
  blocking: string[];
  sections: Record<string, string>;
  acceptance: { total: number; checked: number };
}

/**
 * One card on the board, and every move it could be asked to make.
 *
 * Mirrors `BoardMoves` in `packages/core/src/app/backlog-service.ts`. Only the id: the board
 * already has the items, having drawn its columns from them.
 */
export interface BoardMoves {
  itemId: string;
  transitions: TransitionOffer[];
}

/** One item that could move right now, with the moves it could make. Never empty `moves`. */
export interface EligibleItem {
  item: BacklogItem;
  moves: EligibleMove[];
}

export type AgentRole = 'orchestrator' | 'agent';
export const AGENT_ROLES: AgentRole[] = ['orchestrator', 'agent'];
export type Struggle = 'low' | 'medium' | 'high' | 'max';

export const STRUGGLE_LEVELS: Struggle[] = ['low', 'medium', 'high', 'max'];

export const STRUGGLE_NOTE: Record<Struggle, string> = {
  low: 'Quick and cheap. Extraction, formatting, narrow lookups.',
  medium: 'The working default. Most agents belong here.',
  high: 'Planning, judgement, anything where being wrong is expensive.',
  max: 'Longest thinking on the strongest model. Reserve it for genuinely hard work.',
};

export type ProviderKind = 'claude-code' | 'anthropic' | 'openai';

export interface ModelMap {
  low?: string;
  medium?: string;
  high?: string;
  max?: string;
  fast?: string;
  balanced?: string;
  deep?: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: ModelMap;
  enabled: boolean;
  available: boolean;
  detail: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';
export type ActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'running' | 'executed' | 'failed';

/** Mirrors `AddressKind` in `packages/core/src/domain/address.ts`. */
export type AddressKind = 'project' | 'agent' | 'skill';

/**
 * A resolved address as recorded on a message. Mirrors `MessageAddress` in
 * `packages/core/src/domain/address.ts` — deliberately without offsets, which are draft-only
 * and never persisted.
 */
export interface MessageAddress {
  kind: AddressKind;
  /** The name after the sigil, lowercased. For an agent, the agent id alone. */
  name: string;
  /** `@workflow/agent` only. Null for the bare `@agent` form, and for every other kind. */
  workflowId: string | null;
}

export interface ProposedAction {
  id: string;
  /** 'service.method' form, e.g. 'backlog.move'. */
  name: string;
  args: Record<string, unknown>;
  writes: boolean;
  /** One sentence naming exactly what will change. Shown in the confirm prompt. */
  description: string;
  status: ActionStatus;
  /** JSON-encoded service return value. */
  result: string | null;
  error: string | null;
  runId: string | null;
  createdAt: string;
  decidedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  /** The project this message is addressed at, or the chat's own project. Null when neither. */
  projectId: string | null;
  role: ChatRole;
  text: string;
  providerId: string | null;
  model: string | null;
  actions: ProposedAction[];
  /** `#`, `@` and `/` addresses resolved on this message. */
  addresses: MessageAddress[];
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface Chat {
  id: string;
  title: string;
  /** Set by `#project` and held until changed; null for a chat that has never been addressed. */
  projectId: string | null;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** When the generated title was written, or null if it is still the first line fallback. */
  titleGeneratedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface ChatDetail extends Chat {
  messages: ChatMessage[];
  providerLabel: string;
  providerAvailable: boolean;
  runIds: string[];
  pendingActions: ProposedAction[];
}

/** Payloads for the `chat.*` events published on the shared `/api/events` SSE stream. */
export interface ChatChangedEvent {
  chatId: string;
}
export interface ChatRemovedEvent {
  chatId: string;
}
export interface ChatMessageChunkEvent {
  chatId: string;
  messageId: string;
  text: string;
}
export interface ChatActionStartedEvent {
  chatId: string;
  messageId: string;
  actionId: string;
  name: string;
  writes: boolean;
}
export interface ChatActionFinishedEvent {
  chatId: string;
  messageId: string;
  actionId: string;
  name: string;
  status: ActionStatus;
  error: string | null;
}
export interface ChatTurnFinishedEvent {
  chatId: string;
  messageId: string;
}

export type PipelineStatus = 'running' | 'passed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
/** What the agent says it achieved — separate from whether its turn finished. */
export type Outcome = 'done' | 'partial' | 'blocked' | 'unknown';

export interface PipelineStep {
  id: string;
  runId: string;
  parentStepId: string | null;
  agentId: string;
  agentName: string;
  role: string;
  providerId: string | null;
  model: string;
  task: string;
  status: StepStatus;
  output: string | null;
  error: string | null;
  outcome: Outcome;
  unmet: string[];
  /** What the session actually did: commands, files, skills, MCP calls. */
  actions: Array<{
    tool: string;
    detail: string;
    /** Absent on steps recorded before refusals were kept; read it as `ok`. */
    outcome?: 'ok' | 'refused' | 'failed';
    note?: string;
  }>;
  depth: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /**
   * Turns the provider reported for this session, summed over an orchestrator's rounds.
   * 0 means not measured — never one turn.
   */
  turns: number;
  /** Every input token this step spent, cache included. The total; the two fields below are its halves. */
  inputTokens: number;
  /** How much of `inputTokens` came back from the prompt cache. Both 0 on steps recorded before this existed, where the split is unknown. */
  cacheReadTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface ContextFile {
  name: string;
  content: string;
}

export interface PipelineRun {
  id: string;
  projectId: string;
  workflowId: string;
  workflowName: string;
  providerId: string;
  itemId: string | null;
  /** The run this one retried, when it is a second attempt. */
  rerunOf: string | null;
  task: string;
  /** Files attached when the run was started; every agent was given them. */
  context: ContextFile[];
  status: PipelineStatus;
  /**
   * The branch this run's work was committed on, written when it delivered. Null means "not
   * recorded" — a run from before the field, or one that committed nothing. It never means
   * the run worked in the repo directory; `unmet` says that in words.
   */
  branch: string | null;
  pid: number | null;
  result: string | null;
  error: string | null;
  gateStatus: 'skipped' | 'passed' | 'failed';
  gateSummary: string | null;
  itemStatus: string | null;
  outcome: Outcome;
  unmet: string[];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Everything this run spent, cache included. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Where a run's work is. Mirrors `WorkLocation` in `packages/core/src/domain/pipeline.ts`. */
export type WorkLocation =
  | { kind: 'branch'; branch: string; live: boolean }
  | { kind: 'repo' }
  | { kind: 'unknown' };

/**
 * Which of the three answers applies to this run.
 *
 * A hand-kept copy of `workLocation` in `packages/core/src/domain/pipeline.ts`, because the
 * web package cannot import core (see `SpecGap` above). The precedence and the sentence
 * matched below are that function's; keep them in step with it.
 *
 * The part worth not getting wrong: a run with no worktree row has not necessarily worked in
 * the repo directory. A row lives exactly as long as its directory, so a run that delivered
 * cleanly has none, and reading that absence as "in repo" tells people the one thing that did
 * not happen — at the moment the branch is the only thing that matters.
 */
export function workLocation(
  run: { branch: string | null; unmet: string[] },
  live?: string | null,
): WorkLocation {
  if (run.branch) return { kind: 'branch', branch: run.branch, live: false };
  if (live) return { kind: 'branch', branch: live, live: true };
  if (run.unmet.some((note) => note.includes('working in the repo directory'))) {
    return { kind: 'repo' };
  }
  return { kind: 'unknown' };
}

/**
 * One file's change, on its way to the panel.
 *
 * `source` is not decoration: a `worktree` diff is what is sitting uncommitted in a run still
 * going, and a `branch` diff is what a finished run committed. They can differ, and a reader
 * deciding whether to merge needs to know which one they are looking at.
 */
export interface ArtifactDiff {
  path: string;
  change: string | null;
  source: 'worktree' | 'branch';
  text: string;
  truncated: boolean;
  /** Where to read this file on the forge, at the run's branch. Null when there is no such page. */
  url: string | null;
  /** The editor that would open it on the machine running Pomni, or null when there is none. */
  editor: string | null;
}

export interface Artifact {
  id: string;
  runId: string;
  stepId: string | null;
  name: string;
  kind: 'answer' | 'file' | 'report';
  path: string | null;
  change: string | null;
  bytes: number;
  createdAt: string;
}

export interface Question {
  id: string;
  runId: string;
  stepId: string;
  agentId: string;
  agentName: string;
  question: string;
  answer: string | null;
  /** Files handed over with the answer. */
  attachments: ContextFile[];
  status: 'open' | 'answered' | 'abandoned';
  askedAt: string;
  answeredAt: string | null;
}

export interface PipelineRunDetail extends PipelineRun {
  steps: PipelineStep[];
  artifacts: Artifact[];
  /** What this run stopped to ask a person. */
  questions: Question[];
}

export type ToolKind = 'mcp' | 'cli';
export type McpTransport = 'stdio' | 'http' | 'sse';

export interface Tool {
  id: string;
  name: string;
  kind: ToolKind;
  description: string;
  /** How to drive it. Handed to every agent granted the tool. */
  usage: string;
  bin: string | null;
  transport: McpTransport | null;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
  envFrom: string[];
  credential: string | null;
  credentialEnv: string | null;
  check: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolStatus extends Tool {
  problems: string[];
  usable: boolean;
  /** Projects this tool is attached to. */
  projects: string[];
}

export interface ToolCheckResult {
  id: string;
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
}

export type ToolBody = Partial<Omit<Tool, 'id' | 'createdAt' | 'updatedAt'>> & {
  name?: string;
  kind?: ToolKind;
  id?: string;
};

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  spec: string;
  prompt: string;
  promptGeneratedAt: string | null;
  struggle: Struggle;
  provider: string | null;
  delegatesTo: string[];
  outputs: string;
  tools: { files: boolean; run: boolean; web: boolean; mcp: string[]; cli: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowProblem {
  agentId: string | null;
  message: string;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string;
  /** The workflow this one hands off to: its Out. In is derived from everyone else's Out. */
  handoffTo?: string | null;
  /** Projects this workflow is attached to — where a handoff to it would land. */
  projects: string[];
  agents: Agent[];
  entry: string | null;
  suits: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  problems: WorkflowProblem[];
  runnable: boolean;
}

export type AssetKind = 'agent' | 'skill' | 'command' | 'rules';

export interface DiscoveredAsset {
  kind: AssetKind;
  id: string;
  name: string;
  description: string;
  repoId: string;
  path: string;
  struggle: Struggle | null;
  tools: string[];
  body: string;
}

export interface DiscoveryReport {
  projectId: string;
  scanned: Array<{ repoId: string; workingDir: string; found: number }>;
  assets: DiscoveredAsset[];
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled';

export interface Run {
  id: string;
  projectId: string;
  repoId: string;
  itemId: string | null;
  capability: string;
  cmd: string;
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  logPath: string;
  summary: string | null;
}

export interface TestResult {
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number | null;
  message: string | null;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Worktree {
  id: string;
  projectId: string;
  repoId: string;
  runId: string;
  path: string;
  branch: string;
  baseBranch: string | null;
  baseCommit: string | null;
  ownerPid: number | null;
  status: 'active' | 'kept';
  keptReason: string | null;
  createdAt: string;
  endedAt: string | null;
}

export type WorktreeState = 'live' | 'kept' | 'orphaned' | 'missing';

export interface WorktreeCheck {
  id: string;
  repoId: string;
  runId: string;
  path: string;
  branch: string;
  state: WorktreeState;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  projectId: string;
  status: CheckStatus;
  repos: Array<{
    repoId: string;
    name: string;
    status: CheckStatus;
    checks: Array<{ name: string; status: CheckStatus; detail: string }>;
  }>;
  worktrees: WorktreeCheck[];
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string | null;
  parent: string | null;
  home: string;
  roots: string[];
  entries: DirEntry[];
}

export interface DetectResult {
  path: string;
  detection: { adapter: string; detected: string[]; capabilities: Record<string, Capability> } | null;
  vcs: VcsInfo | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const problem = (body as Problem | null) ?? {
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
    };
    throw new ApiError(problem, response.status);
  }

  return body as T;
}

export const api = {
  listComments: (subject: 'item' | 'run', subjectId: string, includeDeleted = false) =>
    request<{ comments: Comment[] }>(
      `/api/comments/${subject}/${encodeURIComponent(subjectId)}?includeDeleted=${includeDeleted}`,
    ),

  writeComment: (
    projectId: string,
    subject: 'item' | 'run',
    subjectId: string,
    body: { text: string; author?: string; addressedTo?: string | null },
  ) =>
    request<{ comment: Comment }>(
      `/api/projects/${encodeURIComponent(projectId)}/comments/${subject}/${encodeURIComponent(subjectId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteComment: (commentId: string, author?: string) =>
    request<{ comment: Comment }>(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ author }),
    }),

  logs: (filter: { level?: LogLevel; q?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (filter.level) params.set('level', filter.level);
    if (filter.q) params.set('q', filter.q);
    if (filter.limit) params.set('limit', String(filter.limit));
    const query = params.toString();
    return request<{ entries: LogEntry[] }>(`/api/logs${query ? `?${query}` : ''}`);
  },

  health: () => request<SystemHealth>('/api/health'),

  restartServer: (opts?: { cancelInFlight?: boolean }) =>
    request<RestartResult>('/api/restart', {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }),

  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),

  getProject: (id: string) =>
    request<{ project: Project & { repos: Repo[] }; rev: string }>(
      `/api/projects/${encodeURIComponent(id)}`,
    ),

  createProject: (body: { name: string; id?: string; description?: string }) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteProject: (id: string, purge: boolean) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}?purge=${purge}`, { method: 'DELETE' }),

  addRepo: (
    projectId: string,
    body: {
      source:
        | { kind: 'local'; path: string }
        | {
            kind: 'git';
            url: string;
            ref?: string;
            credential?: string;
            provider?: 'github' | 'gitlab' | 'bitbucket' | 'generic';
          };
      id?: string;
      name?: string;
      role?: RepoRole;
    },
  ) =>
    request<{ repo: Repo }>(`/api/projects/${encodeURIComponent(projectId)}/repos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  syncRepo: (projectId: string, repoId: string) =>
    request<{ repo: Repo }>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}/sync`,
      { method: 'POST' },
    ),

  updateRepo: (
    projectId: string,
    repoId: string,
    body: {
      name?: string;
      role?: RepoRole;
      url?: string;
      ref?: string | null;
      credential?: string | null;
      provider?: 'github' | 'gitlab' | 'bitbucket' | 'generic';
      reclone?: boolean;
    },
  ) =>
    request<{ repo: Repo }>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  removeRepo: (projectId: string, repoId: string, purge: boolean) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}?purge=${purge}`,
      { method: 'DELETE' },
    ),

  listTools: () => request<{ tools: ToolStatus[] }>('/api/tools'),

  createTool: (body: ToolBody) =>
    request<{ tool: Tool }>('/api/tools', { method: 'POST', body: JSON.stringify(body) }),

  updateTool: (id: string, body: ToolBody & { enabled?: boolean }) =>
    request<{ tool: Tool }>(`/api/tools/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  removeTool: (id: string) =>
    request<void>(`/api/tools/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  checkTools: (ids?: string[]) =>
    request<{ results: ToolCheckResult[] }>('/api/tools/check', {
      method: 'POST',
      body: JSON.stringify(ids?.length ? { ids } : {}),
    }),

  attachTool: (projectId: string, toolId: string) =>
    request<{ tools: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tools/${encodeURIComponent(toolId)}`,
      { method: 'PUT' },
    ),

  detachTool: (projectId: string, toolId: string) =>
    request<{ tools: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tools/${encodeURIComponent(toolId)}`,
      { method: 'DELETE' },
    ),

  listCredentials: () => request<{ credentials: Credential[] }>('/api/credentials'),

  createCredential: (body: {
    name: string;
    provider?: string;
    host?: string;
    username?: string;
    secretRef: { kind: 'env'; var: string } | { kind: 'gh-cli' } | { kind: 'file' };
    secret?: string;
  }) =>
    request<{ credential: Credential }>('/api/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateCredential: (
    id: string,
    body: {
      name?: string;
      provider?: string;
      host?: string;
      username?: string;
      secretRef?: { kind: 'env'; var: string } | { kind: 'gh-cli' } | { kind: 'file' };
      secret?: string;
    },
  ) =>
    request<{ credential: Credential }>(`/api/credentials/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  testCredential: (id: string, url?: string) =>
    request<{ ok: boolean; message: string }>(`/api/credentials/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  removeCredential: (id: string) =>
    request<void>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listItems: (projectId: string, status?: string) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<{ items: BacklogItem[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/items${query}`,
    );
  },

  getItem: (projectId: string, itemId: string) =>
    request<{ item: BacklogItemDetail; rev: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
    ),

  /**
   * `etag` is `getItem`'s `rev`. Optional because a caller that never fetched a rev (e.g. a
   * fresh create) has nothing to send; omitting it means a concurrent-edit conflict on this
   * item will not be detected server-side.
   */
  updateItem: (
    projectId: string,
    itemId: string,
    patch: { body?: string; title?: string },
    etag?: string,
  ) =>
    request<{ item: BacklogItem }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: etag ? { 'If-Match': etag } : undefined,
      },
    ),

  previewTransitions: (projectId: string, itemId: string, body: string) =>
    request<{ allowedTransitions: TransitionOffer[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/transitions/preview`,
      { method: 'POST', body: JSON.stringify({ body }) },
    ),

  createItem: (
    projectId: string,
    body: { title: string; type?: ItemType; priority?: Priority; repos?: string[] },
  ) =>
    request<{ item: BacklogItem }>(`/api/projects/${encodeURIComponent(projectId)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Put a blocked item back where it was. Not the same as moving it by hand: the server
   * knows which status it came from, and records it as an unblock rather than a move.
   */
  unblockItem: (projectId: string, itemId: string) =>
    request<{ item: BacklogItem }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/unblock`,
      { method: 'POST' },
    ),

  transitionItem: (
    projectId: string,
    itemId: string,
    body: { to: ItemStatus; comment?: string; reason?: string; force?: boolean },
  ) =>
    request<{ item: BacklogItem }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/transition`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  removeItem: (projectId: string, itemId: string) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),

  /** Every move every card could make, in one request. See `BoardMoves`. */
  boardMoves: (projectId: string, status?: string) =>
    request<{ board: BoardMoves[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/items-board${
        status ? `?status=${encodeURIComponent(status)}` : ''
      }`,
    ).then((result) => result.board),

  getItemFlow: (projectId: string) =>
    request<{ flow: Flow }>(`/api/projects/${encodeURIComponent(projectId)}/items-flow`).then(
      (result) => result.flow,
    ),

  listWaves: (projectId: string) =>
    request<{ plan: WavePlan }>(
      `/api/projects/${encodeURIComponent(projectId)}/items-waves`,
    ).then((result) => result.plan),

  /** What the board badges "ready to move" and `pomni backlog list --eligible` answers. */
  eligibleItems: (
    projectId: string,
    params?: { status?: string; type?: ItemType; priority?: Priority; label?: string; repo?: string; q?: string },
  ) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    if (params?.priority) query.set('priority', params.priority);
    if (params?.label) query.set('label', params.label);
    if (params?.repo) query.set('repo', params.repo);
    if (params?.q) query.set('q', params.q);
    const qs = query.toString();
    return request<{ eligible: EligibleItem[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/items-eligible${qs ? `?${qs}` : ''}`,
    ).then((result) => result.eligible);
  },

  tickChecklist: (projectId: string, itemId: string, body: { key: string; ticked: boolean }) =>
    request<{ item: BacklogItemDetail }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/checklist`,
      { method: 'POST', body: JSON.stringify(body) },
    ).then((result) => result.item),

  listWorkflows: () =>
    request<{ workflows: WorkflowDetail[]; scales: { struggle: Struggle; label: string; note: string }[] }>('/api/workflows'),

  getWorkflow: (id: string) =>
    request<{ workflow: WorkflowDetail; rev: string }>(`/api/workflows/${encodeURIComponent(id)}`),

  createWorkflow: (body: { name: string; description?: string; suits?: string[] }) =>
    request<{ workflow: WorkflowDetail }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateWorkflow: (
    id: string,
    body: { name?: string; description?: string; suits?: string[]; handoffTo?: string | null },
  ) =>
    request<{ workflow: WorkflowDetail }>(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteWorkflow: (id: string) =>
    request<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  importWorkflow: (content: string) =>
    request<{ workflow: WorkflowDetail }>('/api/workflows/import', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  addAgent: (workflowId: string, body: { name: string; role?: AgentRole; provider?: string | null }) =>
    request<{ agent: Agent }>(`/api/workflows/${encodeURIComponent(workflowId)}/agents`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateAgent: (
    workflowId: string,
    agentId: string,
    body: {
      name?: string;
      role?: AgentRole;
      spec?: string;
      prompt?: string;
      outputs?: string;
      struggle?: Struggle;
      provider?: string | null;
      delegatesTo?: string[];
      tools?: { files?: boolean; run?: boolean; web?: boolean; mcp?: string[]; cli?: string[] };
    },
  ) =>
    request<{ agent: Agent }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  removeAgent: (workflowId: string, agentId: string) =>
    request<void>(
      `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' },
    ),

  generatePrompt: (workflowId: string, agentId: string) =>
    request<{ agent: Agent }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}/prompt`,
      { method: 'POST' },
    ),

  projectWorkflows: (projectId: string) =>
    request<{ workflows: WorkflowDetail[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows`,
    ),

  attachWorkflow: (projectId: string, workflowId: string) =>
    request<{ workflows: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    }),

  detachWorkflow: (projectId: string, workflowId: string) =>
    request<{ workflows: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
      { method: 'DELETE' },
    ),

  discover: (projectId: string) =>
    request<{ report: DiscoveryReport }>(
      `/api/projects/${encodeURIComponent(projectId)}/discover`,
    ),

  importDiscovered: (projectId: string, body: { workflowId: string; assetId: string }) =>
    request<{ imported: { agentId: string } }>(
      `/api/projects/${encodeURIComponent(projectId)}/discover/import`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  listProviders: () =>
    request<{ default: string | null; providers: ProviderStatus[] }>('/api/providers'),

  providerPresets: () =>
    request<{ presets: Array<{ id: string; label: string; kind: ProviderKind; baseUrl?: string; apiKeyEnv?: string; models: ModelMap; note: string }> }>(
      '/api/providers/presets',
    ),

  providerModels: (id: string) =>
    request<{ models: string[] }>(`/api/providers/${encodeURIComponent(id)}/models`),

  createProvider: (body: {
    label: string;
    kind: ProviderKind;
    baseUrl?: string;
    apiKeyEnv?: string;
    models?: Partial<Record<Struggle, string>>;
  }) =>
    request<{ provider: ProviderStatus }>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateProvider: (
    id: string,
    body: {
      label?: string;
      kind?: ProviderKind;
      baseUrl?: string;
      apiKeyEnv?: string;
      models?: Partial<Record<Struggle, string>>;
    },
  ) =>
    request<{ provider: ProviderStatus }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  removeProvider: (id: string) =>
    request<void>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  setDefaultProvider: (id: string) =>
    request<{ default: string }>(`/api/providers/${encodeURIComponent(id)}/default`, {
      method: 'POST',
    }),

  listPipelines: (
    projectId: string,
    params?: { limit?: number; workflowId?: string; status?: PipelineStatus },
  ) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.workflowId !== undefined) query.set('workflow', params.workflowId);
    if (params?.status !== undefined) query.set('status', params.status);
    const qs = query.toString();
    return request<{ runs: PipelineRun[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/pipelines${qs ? `?${qs}` : ''}`,
    );
  },

  getPipeline: (runId: string) =>
    request<{ run: PipelineRunDetail }>(`/api/pipelines/${encodeURIComponent(runId)}`),

  startPipeline: (
    projectId: string,
    body: {
      task: string;
      workflowId?: string;
      itemId?: string;
      context?: ContextFile[];
    },
  ) =>
    request<{ run: PipelineRun }>(`/api/projects/${encodeURIComponent(projectId)}/pipelines`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  openQuestions: (projectId?: string) =>
    request<{ questions: Question[] }>(
      `/api/questions${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`,
    ),

  answerQuestion: (questionId: string, answer: string, files?: ContextFile[]) =>
    request<{ question: Question }>(`/api/questions/${encodeURIComponent(questionId)}`, {
      method: 'POST',
      body: JSON.stringify({ answer, files }),
    }),

  listRunningPipelines: () =>
    request<{ runs: PipelineRun[] }>('/api/pipelines?status=running'),

  rerunPipeline: (runId: string) =>
    request<{ run: PipelineRun }>(`/api/pipelines/${encodeURIComponent(runId)}/rerun`, {
      method: 'POST',
    }),

  resumePipeline: (runId: string, note?: string) =>
    request<{ run: PipelineRun; reused: number }>(
      `/api/pipelines/${encodeURIComponent(runId)}/resume`,
      { method: 'POST', body: JSON.stringify({ note: note ?? '' }) },
    ),

  cancelPipeline: (runId: string) =>
    request<{ run: PipelineRun }>(`/api/pipelines/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
    }),

  llmStatus: () =>
    request<{
      configured: boolean;
      auth: string;
      default: string | null;
      defaultModel: { providerId: string; model: string } | null;
      providers: ProviderStatus[];
    }>('/api/llm/status'),

  listRuns: (params: { project?: string; repo?: string; capability?: string; failed?: boolean; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.project) query.set('project', params.project);
    if (params.repo) query.set('repo', params.repo);
    if (params.capability) query.set('capability', params.capability);
    if (params.failed) query.set('failed', 'true');
    query.set('limit', String(params.limit ?? 30));
    return request<{ runs: Run[] }>(`/api/runs?${query.toString()}`);
  },

  getRun: (id: string) =>
    request<{ run: Run; testResults: TestResult[] }>(`/api/runs/${encodeURIComponent(id)}`),

  startRun: (body: { project: string; capability: string; repoId?: string }) =>
    request<{ accepted: boolean; capability: string; repos: string[] }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cancelRun: (id: string) =>
    request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  verify: (projectId: string, gate: 'default' | 'land' = 'default') =>
    request<{ accepted: boolean; gate: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/verify`,
      { method: 'POST', body: JSON.stringify({ gate }) },
    ),

  doctor: (projectId: string) =>
    request<{ report: DoctorReport }>(`/api/projects/${encodeURIComponent(projectId)}/doctor`),

  artifactDiff: (runId: string, artifactId: string) =>
    request<{ diff: ArtifactDiff }>(
      `/api/pipelines/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/diff`,
    ),

  /**
   * Open one of a run's files on the machine running Pomni.
   *
   * An artifact id, and a mode. There is deliberately no way to name a path here: the server
   * resolves one from the run's own record and refuses anything outside a repo it owns.
   */
  openArtifact: (runId: string, artifactId: string, mode: 'editor' | 'reveal') =>
    request<{ opened: string }>(
      `/api/pipelines/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/open`,
      { method: 'POST', body: JSON.stringify({ mode }) },
    ),

  listWorktrees: (projectId: string) =>
    request<{ worktrees: Array<{ worktree: Worktree; state: WorktreeState; detail: string }> }>(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
    ),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  detect: (path: string) => request<DetectResult>(`/api/fs/detect?path=${encodeURIComponent(path)}`),

  listChats: (params: { query?: string; providerId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.query) query.set('query', params.query);
    if (params.providerId) query.set('providerId', params.providerId);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<{ chats: Chat[] }>(`/api/chats${qs ? `?${qs}` : ''}`);
  },

  /** The first message creates the chat and runs the first turn in one call. */
  startChat: (body: { text: string; providerId?: string; model?: string }) =>
    request<{ chat: ChatDetail }>('/api/chats', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getChat: (id: string) => request<{ chat: ChatDetail }>(`/api/chats/${encodeURIComponent(id)}`),

  deleteChat: (id: string) =>
    request<void>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  setChatModel: (id: string, body: { providerId: string; model: string }) =>
    request<{ chat: Chat }>(`/api/chats/${encodeURIComponent(id)}/model`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  renameChat: (id: string, title: string) =>
    request<{ chat: Chat }>(`/api/chats/${encodeURIComponent(id)}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  chatAddressables: (projectId?: string | null) =>
    request<{
      projects: Array<{ id: string; name: string }>;
      agents: Array<{ workflowId: string; workflowName: string; agentId: string; agentName: string }>;
      skills: Array<{ name: string; description?: string }>;
    }>(`/api/chats/addressables${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),

  sendChatMessage: (id: string, text: string) =>
    request<{ message: ChatMessage }>(`/api/chats/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  confirmChatAction: (id: string, messageId: string, actionId: string) =>
    request<{ message: ChatMessage }>(
      `/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/actions/${encodeURIComponent(actionId)}/confirm`,
      { method: 'POST' },
    ),

  rejectChatAction: (id: string, messageId: string, actionId: string) =>
    request<{ message: ChatMessage }>(
      `/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/actions/${encodeURIComponent(actionId)}/reject`,
      { method: 'POST' },
    ),
};
