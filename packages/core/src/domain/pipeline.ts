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

export const PipelineRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  providerId: z.string(),
  /** Backlog item this run is for, when it was started from one. */
  itemId: z.string().nullable(),
  task: z.string(),
  status: PipelineStatusSchema,
  result: z.string().nullable(),
  error: z.string().nullable(),
  /** Outcome of the project's gate, run after the pipeline finished. */
  gateStatus: z.enum(['skipped', 'passed', 'failed']).default('skipped'),
  gateSummary: z.string().nullable().default(null),
  /** What happened to the backlog item, if the run was started from one. */
  itemStatus: z.string().nullable().default(null),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  costUsd: z.number().nullable(),
});

export type PipelineRun = z.infer<typeof PipelineRunSchema>;

export interface PipelineRunDetail extends PipelineRun {
  steps: PipelineStep[];
  artifacts: Artifact[];
}

export interface PipelineFilter {
  projectId?: string;
  workflowId?: string;
  itemId?: string;
  status?: PipelineStatus;
  limit?: number;
}

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

You do not do the work yourself. To have an agent do something, reply with **only** a fenced
json block, and nothing else:

\`\`\`json
{"delegate": [{"agent": "agent-id", "task": "what you want done, in full"}]}
\`\`\`

List several entries to run them together — do that whenever they do not depend on each
other, because they run in parallel. Write each task as if the agent has no other context:
it cannot see this conversation, the original request, or what the other agents returned.

You will then receive each agent's result, and can delegate again.

When you have everything you need, reply with your final answer as ordinary prose — no json
block. That ends the run, so make it the complete answer rather than a note that you are
finished.`;

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
