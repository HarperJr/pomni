import { z } from 'zod';

/**
 * One execution of a workflow against a task.
 *
 * A run is a tree, not a list: the entry orchestrator delegates, and what it delegates to may
 * delegate again. Each node is a step, and `parentStepId` is the edge — which is exactly the
 * data a live view needs to show who activated whom.
 */

export const StepStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'cancelled']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const PipelineStatusSchema = z.enum(['running', 'passed', 'failed', 'cancelled']);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

/**
 * Whether the work actually happened, as the agent that did it reports.
 *
 * Separate from the step's `status`, which only says the model returned without throwing.
 * An agent that explains at length why it could not do the job has still `done` its turn;
 * conflating the two is what makes a run green when nothing was delivered.
 */
export const OutcomeSchema = z.enum(['done', 'partial', 'blocked', 'unknown']);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const PipelineStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** Null for the entry orchestrator; otherwise the step that delegated this one. */
  parentStepId: z.string().nullable(),
  agentId: z.string(),
  agentName: z.string(),
  role: z.string(),
  model: z.string(),
  /** What this step was asked to do. For the entry step, the task itself. */
  task: z.string(),
  status: StepStatusSchema,
  /** What it returned. */
  output: z.string().nullable(),
  error: z.string().nullable(),
  /** Commands run, files touched, skills and MCP tools called, in order. */
  actions: z.array(z.object({ tool: z.string(), detail: z.string() })).default([]),
  /** What the agent says it achieved. `status` says it finished; this says whether it worked. */
  outcome: OutcomeSchema.default('unknown'),
  /** What it was asked for and did not deliver. */
  unmet: z.array(z.string()).default([]),
  /** How deep in the delegation tree, for laying the view out. */
  depth: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
});

export type PipelineStep = z.infer<typeof PipelineStepSchema>;

/**
 * A file handed to a run as context.
 *
 * Content, not a path: the files worth attaching are often a spec, a log or a screenshot
 * transcript that lives outside the repo, and half the agents in a workflow have no working
 * directory to resolve a path against anyway.
 */
export const ContextFileSchema = z.object({
  /** How the file is named to the agents. A basename, not the path it came from. */
  name: z.string().min(1).max(200),
  content: z.string().min(1),
});
export type ContextFile = z.infer<typeof ContextFileSchema>;

/** Per file, and for all of them together. A run pays for this text once per agent. */
export const MAX_CONTEXT_FILE_BYTES = 256_000;
export const MAX_CONTEXT_BYTES = 512_000;

export const PipelineRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  providerId: z.string(),
  /** Backlog item this run is for, when it was started from one. */
  itemId: z.string().nullable(),
  /** The run this one is a second attempt at, so a retry is traceable to what it retried. */
  rerunOf: z.string().nullable().default(null),
  task: z.string(),
  status: PipelineStatusSchema,
  /**
   * OS pid of the process running the pipeline while it runs, null once it has ended. Mirrors
   * `Run.pid`. It is the second opinion on whether a run claiming `running` really is — a
   * process that dies without calling `cancel()` leaves the row saying `running` forever.
   */
  pid: z.number().int().positive().nullable().default(null),
  result: z.string().nullable(),
  error: z.string().nullable(),
  /** Outcome of the project's gate, run after the pipeline finished. */
  gateStatus: z.enum(['skipped', 'passed', 'failed']).default('skipped'),
  gateSummary: z.string().nullable().default(null),
  /** What happened to the backlog item, if the run was started from one. */
  itemStatus: z.string().nullable().default(null),
  /** The entry orchestrator's verdict on the whole run. */
  outcome: OutcomeSchema.default('unknown'),
  unmet: z.array(z.string()).default([]),
  /** Files attached when the run was started. Every agent is given them. */
  context: z.array(ContextFileSchema).default([]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  costUsd: z.number().nullable(),
});

export type PipelineRun = z.infer<typeof PipelineRunSchema>;

export interface PipelineRunDetail extends PipelineRun {
  steps: PipelineStep[];
  artifacts: Artifact[];
  questions: Question[];
}

export interface PipelineFilter {
  projectId?: string;
  workflowId?: string;
  itemId?: string;
  status?: PipelineStatus;
  limit?: number;
}

/**
 * The id an orchestrator delegates to when only a person can answer.
 *
 * Not an agent in any workflow: it is a reserved target, so asking a human costs the
 * orchestrator nothing new to learn — it is the same delegation it already knows how to
 * write, and the answer arrives where an agent's answer would.
 */

/** An agent handing a problem upwards, because it cannot settle it alone. */
const EscalationSchema = z.object({
  question: z.string().min(1),
  /**
   * True when the work cannot go on until a person answers. False means the orchestrator
   * should hear about it and decide — most escalations are that, not this.
   */
  critical: z.boolean().default(false),
});

const VerdictSchema = z.object({
  outcome: z.enum(['done', 'partial', 'blocked']),
  unmet: z.array(z.string()).default([]),
  escalate: EscalationSchema.optional(),
});

export interface Escalation {
  question: string;
  critical: boolean;
}

export interface Verdict {
  outcome: Outcome;
  unmet: string[];
  escalate?: Escalation;
}

/**
 * What every agent is told to end its answer with.
 *
 * The block is small on purpose. Asking for prose about success gets prose about success;
 * asking for one of three words gets an answer a machine can act on.
 */
export const VERDICT_PROTOCOL = `## End your answer with

\`\`\`json
{"outcome": "done|partial|blocked", "unmet": ["what you were asked for and did not deliver"]}
\`\`\`

Say \`done\` only if it is true: nobody re-checks a green run, so a false one is found later
by someone who trusted it. Be exact in \`unmet\` — "could not read the wireframes, no file
open" is useful, "some issues" is not.

Add \`"escalate": {"question": "...", "critical": true}\` when you cannot settle something
yourself. \`critical\` stops the run and asks a person, and you get another turn with their
reply; otherwise your orchestrator sees it and decides.`;

/**
 * Read an agent's verdict, and the prose without it.
 *
 * A missing block is `unknown` rather than `done`. Absence of a claim is not a claim of
 * success — which is the whole failure this exists to prevent.
 */
export function parseVerdict(text: string): { verdict: Verdict; prose: string } {
  for (const candidate of jsonBlocks(text)) {
    const parsed = VerdictSchema.safeParse(candidate);
    if (parsed.success) {
      return {
        verdict: {
          outcome: parsed.data.outcome,
          unmet: parsed.data.unmet,
          ...(parsed.data.escalate ? { escalate: parsed.data.escalate } : {}),
        },
        prose: stripVerdict(text),
      };
    }
  }
  return { verdict: { outcome: 'unknown', unmet: [] }, prose: text };
}

/** The answer without its verdict block — what a person reads. */
function stripVerdict(text: string): string {
  return text
    .replace(/\`\`\`(?:json)?[^\`\`\`]*"outcome"[\s\S]*?\`\`\`/g, '')
    .trim();
}

export const HUMAN_AGENT_ID = 'human';

export const QuestionStatusSchema = z.enum(['open', 'answered', 'abandoned']);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/** Something a run stopped to ask a person. */
export const QuestionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** The step that asked — an orchestrator, mid-round. */
  stepId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  /** Files handed over with the answer — a screenshot, a spec, an export. */
  attachments: z.array(ContextFileSchema).default([]),
  status: QuestionStatusSchema,
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;

/** A file an agent produced during a run. */
export const ArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** Null for things produced by the run as a whole rather than one agent. */
  stepId: z.string().nullable(),
  name: z.string(),
  /**
   * `answer` is what an agent returned; `file` is something changed in a repo; `report` is
   * the run's own output, such as the gate result.
   */
  kind: z.enum(['answer', 'file', 'report']),
  /** Repo-relative path, for `file`. */
  path: z.string().nullable(),
  /** For a file: whether it was added, modified or deleted. */
  change: z.string().nullable(),
  bytes: z.number(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** How much text a set of context files adds to every agent's prompt. */
export function contextBytes(files: ContextFile[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
}

/**
 * The task an agent is actually given: its own instruction, then the attached files.
 *
 * Every agent gets them, not only the orchestrator. The protocol tells an orchestrator to
 * write each delegation as if the agent can see nothing else, so context reaching only the
 * top of the tree would have to be retyped into every delegation to survive — and would not.
 */
/**
 * One agent's instruction, with the brief the whole run shares.
 *
 * The protocol used to tell an orchestrator that a delegated agent can see nothing else, so
 * every delegation repeated the entire background. It is cheaper and more reliable to hand
 * the brief to every agent once than to have a model retype it each time — and a retyped
 * brief drifts from the original, which a copied one cannot.
 */
export function withBrief(task: string, brief: string): string {
  const trimmed = brief.trim();
  if (!trimmed || task.includes(trimmed)) return task;

  return [
    '## What this run is about',
    '',
    trimmed,
    '',
    '## Your task',
    '',
    task,
  ].join('\n');
}

export function withContext(task: string, files: ContextFile[]): string {
  if (files.length === 0) return task;

  const fence = '```';

  return [
    task,
    '',
    '## Attached context',
    '',
    'Files attached to this task. They are the source of truth about it; prefer them over',
    'what you would otherwise assume.',
    '',
    ...files.flatMap((file) => ['### ' + file.name, '', fence, file.content.trim(), fence, '']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The orchestration protocol
// ---------------------------------------------------------------------------

export const DelegationSchema = z.object({
  agent: z.string(),
  task: z.string(),
});
export type Delegation = z.infer<typeof DelegationSchema>;

const DelegateBlockSchema = z.object({
  delegate: z.array(DelegationSchema).min(1),
});

/**
 * How an orchestrator asks for work.
 *
 * Native tool-calling would be the obvious mechanism, but the most useful provider —
 * the Claude Code CLI — runs its own tool loop internally and cannot hand individual calls
 * back to us. A fenced JSON block works identically on every provider, and it makes each
 * delegation an observable event rather than something buried in a session transcript.
 */
export const ORCHESTRATOR_PROTOCOL = `## How to delegate

You do not do the work. To have something done, reply with **only** a fenced json block:

\`\`\`json
{"delegate": [{"agent": "agent-id", "task": "what you want done, in full"}]}
\`\`\`

Several entries run in parallel, so ask for everything that does not depend on something
else at once. Every agent is already given the run's brief, so write only what *this* agent
must do and what it needs that the brief does not say. Do not restate the background. It
cannot see this conversation or what the other agents returned.

You then get their results and may delegate again.

\`human\` is not an agent: it puts the question to the person who started the run, and the run
waits until they answer. Use it for a decision that is theirs — a trade-off, a preference,
permission for something irreversible — never for anything an agent could find out.

When you have what you need, answer in prose with no json block. That ends the run, so make
it the whole answer.`;

/**
 * Read an orchestrator's reply. Returns the delegations it asked for, or null when the reply
 * is the final answer.
 */
export function parseDelegations(text: string): Delegation[] | null {
  for (const candidate of jsonBlocks(text)) {
    const parsed = DelegateBlockSchema.safeParse(candidate);
    if (parsed.success) return parsed.data.delegate;
  }
  return null;
}

/** Every fenced or bare JSON object in a reply, most likely first. */
function jsonBlocks(text: string): unknown[] {
  const found: unknown[] = [];

  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    const parsed = tryParse(match[1] ?? '');
    if (parsed !== undefined) found.push(parsed);
  }

  // Some models skip the fence entirely when the whole reply is the object.
  if (found.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = tryParse(trimmed);
      if (parsed !== undefined) found.push(parsed);
    }
  }

  return found;
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A one-line summary of a step's output, for lists and the run header. */
export function summarise(text: string | null, max = 140): string {
  if (!text) return '';
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('```'));
  if (!line) return '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
