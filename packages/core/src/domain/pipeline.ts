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
  /**
   * Which provider actually ran this step. Not derivable from the run any more: an agent may
   * name its own, so a run can span three providers and only the step knows which was used.
   *
   * Null on steps recorded before the column existed. Those ran on the run's provider — there
   * was no other option — so a reader may safely fall back to `PipelineRun.providerId`.
   * Everything written from now on sets it.
   */
  providerId: z.string().nullable().default(null),
  model: z.string(),
  /** What this step was asked to do. For the entry step, the task itself. */
  task: z.string(),
  status: StepStatusSchema,
  /** What it returned. */
  output: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * Bytes of the assembled system prompt this step was sent.
   *
   * Zero means not measured — a step recorded before this existed — never "an empty prompt".
   * A turn pays for this in full every time it takes one, so it is the number that says
   * whether an agent is expensive because of what it does or because of what it carries.
   */
  /**
   * Tokens written into the cache on this step, as the provider reported them.
   *
   * Kept apart from `cacheReadTokens` because they are priced apart and mean opposite things:
   * a creation is an investment the next turn collects on, a read is the collection. Summing
   * them would hide which of the two a run is actually doing.
   */
  cacheCreationTokens: z.number().default(0),
  promptBytes: z.number().default(0),
  /**
   * Bytes this step actually handed the provider: the system prompt plus the whole
   * conversation as it stood, summed over every call the step made.
   *
   * `promptBytes` is the system prompt once. This is what went over the wire, and the two
   * differ by the conversation — which is the part that grows while a step runs, and the part
   * nothing was counting.
   *
   * It is a floor on what a turn carried, never the whole of it. A provider that runs its own
   * tool loop re-sends everything it has read on every internal turn, and none of that passes
   * through here. That gap is the point of measuring this: `inputTokens` divided by `turns`
   * says what a turn was billed for, this says how much of it we handed over, and the
   * difference is the session reading on its own account.
   */
  sentBytes: z.number().default(0),
  /**
   * Where those bytes went. Measured at assembly, not estimated afterwards: the parts are
   * joined into the prompt in the same breath, so the breakdown cannot drift from the total.
   */
  promptParts: z
    .object({
      agent: z.number().default(0),
      protocol: z.number().default(0),
      roster: z.number().default(0),
      tools: z.number().default(0),
      repos: z.number().default(0),
      context: z.number().default(0),
    })
    .default({}),
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
  /**
   * Turns the provider reported for this session. For an orchestrator, summed over the rounds
   * it took: each round opens its own session, and what is being measured is the whole step.
   *
   * This is what tells a 6.5M-token step that read the repository forty times apart from one
   * that took a single enormous turn. Those have opposite fixes, and without this they are
   * the same shape in every view — one is simply bigger.
   *
   * **0 means not measured. It never means one turn.** A provider that reports no count
   * records 0, and no reader or writer may substitute 1 for a missing figure: an absent
   * measurement that reads as a measured one is worse than no column at all, because it
   * averages into the number someone will act on. Steps written before this field existed
   * read back 0 for exactly that reason — they were not measured either.
   */
  turns: z.number().int().nonnegative().default(0),
  /** Every input token this step spent, cache included. The total; the two fields below are its halves. */
  inputTokens: z.number(),
  /**
   * How much of `inputTokens` came back from the prompt cache, and how much the model read
   * fresh. Two numbers with opposite readings: a step that is 95% cache read is a long
   * session on a warm prompt, a step that is 95% fresh is a prompt being rebuilt every turn.
   *
   * `inputTokens` keeps the meaning it has today — the total, cache included — and stays the
   * number every existing reader sums. These are its parts, not a replacement, and for every
   * step written from now on `cacheReadTokens + freshInputTokens === inputTokens`. Fresh is
   * real input plus cache *creation*: tokens the model read for the first time, whichever
   * side of the cache they were written to.
   *
   * Both 0 on steps recorded before the columns existed, where the split is simply unknown.
   * So the identity above does not hold backwards, and neither half may be derived by
   * subtracting the other from `inputTokens` — on an old row that yields a whole confident
   * number out of nothing.
   */
  cacheReadTokens: z.number().int().nonnegative().default(0),
  freshInputTokens: z.number().int().nonnegative().default(0),
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
  /**
   * Where this came from, and therefore how much it is worth.
   *
   * `attached` is a person's: they chose it, and it is as true on the third attempt as the
   * first. `handover` is an agent's, decided inside one run — carrying it into a later attempt
   * presents a conclusion from a run that did not finish as if it were source material, which
   * is how a wrong decision outlives the reasoning that produced it.
   *
   * Optional, and absent means attached. Every run recorded before this field was attached —
   * nothing else could put a file here — and leaving it optional keeps every caller that
   * builds a file from a path unchanged. Only a handover has to say what it is.
   */
  origin: z.enum(['attached', 'handover']).optional(),
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
  /**
   * What asked for this run, when it was not asked for directly.
   *
   * `flow:ready` means the project's own flow started it because an item entered that state.
   * Null means a person or an agent asked for it in as many words — which is every run before
   * this field existed, and is why null is the default rather than an unknown.
   *
   * Recorded because a run that starts itself is the one somebody will want to explain, and
   * "why is this costing me money" is not a question a log line answers three days later.
   */
  startedBy: z.string().nullable().default(null),
  /**
   * The branch, or branches, this run's work was committed on.
   *
   * On the run rather than derived from its worktree rows. A row exists if and only if its
   * directory does — that is the design — so the moment a run started delivering cleanly, the
   * directory went away and the branch went with it. The listing then fell back to saying
   * `in repo`, which is not merely absent but wrong: it claims the run worked in the shared
   * repo directory, the one thing that did not happen.
   *
   * Null means "not recorded" — a run from before this field, or one that committed nothing.
   * It never means the run worked in the repo directory; `unmet` says that in words.
   */
  branch: z.string().nullable().default(null),
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
  /** Every token this run spent, cache included. The sum of its steps. */
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  costUsd: z.number().nullable(),
});

export type PipelineRun = z.infer<typeof PipelineRunSchema>;

/**
 * What `WorktreeService` says when it could not cut a worktree and the run used the repo
 * directory itself.
 *
 * Shared so that the reader of the sentence and its writer cannot drift apart. It is a
 * sentence rather than a flag because it is also what a person reads in `unmet`, and a run
 * that shared a repo directory needs to say which repo and why, not merely that it happened.
 */
export const SHARED_REPO_NOTE = 'working in the repo directory';

/** Where a run's work is. Rendered differently by each surface; decided in one place. */
export type WorkLocation =
  /** On a branch. `live` distinguishes a worktree still standing from work already committed. */
  | { kind: 'branch'; branch: string; live: boolean }
  /** In the shared repo directory, because no worktree could be cut. */
  | { kind: 'repo' }
  /** Not known. Said by showing nothing. */
  | { kind: 'unknown' };

/**
 * Three sources, in the order they are trustworthy.
 *
 * The run's own `branch` is what `deliver()` wrote when it committed, and it outlives
 * everything else. The live worktree row covers a run still in flight, which has not
 * committed yet and so has nothing on the run. Only a run that actually fell back to a shared
 * repo directory is `repo` — and that is decided by what the run says in `unmet`, never by a
 * missing worktree row.
 *
 * That last distinction is the bug this exists for. A worktree row lives exactly as long as
 * its directory, so a run that delivered cleanly has none — and reading that absence as "it
 * worked in the repo" told people the one thing that had not happened, at the moment the
 * branch was the only thing that mattered.
 */
export function workLocation(
  run: { branch: string | null; unmet: string[] },
  live?: string | null,
): WorkLocation {
  if (run.branch) return { kind: 'branch', branch: run.branch, live: false };
  if (live) return { kind: 'branch', branch: live, live: true };
  if (run.unmet.some((note) => note.includes(SHARED_REPO_NOTE))) return { kind: 'repo' };
  return { kind: 'unknown' };
}

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

/**
 * Where a file can be read on the forge, at a particular branch.
 *
 * Built from the remote url rather than by calling the forge, for the same reasons
 * `mergeRequestUrl` is: no token, works against a self-hosted instance, and it is the page a
 * person would have navigated to themselves. Null whenever the shape is not known — a link
 * that goes somewhere wrong is worse than no link, because a link is followed.
 */
export function fileUrl(remote: string | null, branch: string | null, path: string): string | null {
  if (!remote || !branch) return null;

  const base = remote.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;

  // Every one of the three spells it the same way, which is why this is a lookup of hosts
  // rather than of shapes: `/blob/<ref>/<path>` on GitHub and Bitbucket, `/-/blob/` on GitLab.
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const file = path.split(/[\\/]/).map(encodeURIComponent).join('/');

  if (base.includes('github.com') || base.includes('bitbucket.org')) {
    return `${base}/blob/${ref}/${file}`;
  }
  return `${base}/-/blob/${ref}/${file}`;
}

/**
 * One file's change, on its way to a browser.
 *
 * `source` is not decoration: a `worktree` diff is what is sitting uncommitted in a run still
 * going, and a `branch` diff is what a finished run committed. They can differ, and a reader
 * deciding whether to merge something needs to know which one they are looking at.
 */
export interface ArtifactDiff {
  path: string;
  /** `added`, `modified`, `deleted` — whatever the run recorded when it captured the file. */
  change: string | null;
  source: 'worktree' | 'branch';
  /** Unified diff text. Empty means the file is genuinely unchanged in this source. */
  text: string;
  /** True when `text` is the first part of a longer diff rather than the whole of it. */
  truncated: boolean;
  /**
   * Where to read this file on the forge, at the branch the run delivered on. Null for an ssh
   * remote, a host with no known shape, or a run with no branch — a wrong link is worse than
   * none, because a link is followed.
   */
  url: string | null;
  /**
   * The editor that would open it locally, or null when there is none to be found.
   *
   * Answered here so a button can say what it will do rather than failing when it is pressed.
   */
  editor: string | null;
}

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

/**
 * Files an agent published for the rest of the run.
 *
 * The digest carries what an agent said; this carries what it wants the others to *have* —
 * the field names it settled, the signature it chose, the shape it decided on. Fenced rather
 * than JSON because the content is usually code, and code inside a JSON string arrives
 * mangled or not at all.
 *
 *     ```handover field-names.md
 *     turns, cacheReadTokens, freshInputTokens
 *     ```
 */
export function parseHandover(text: string): ContextFile[] {
  const files: ContextFile[] = [];
  const pattern = /^[ \t]*```handover[ \t]+(\S+)[ \t]*$/gm;

  for (;;) {
    const opened = pattern.exec(text);
    if (!opened) break;

    const from = opened.index + opened[0].length + 1;
    const closed = text.indexOf('```', from);
    if (closed === -1) continue;

    const name = (opened[1] ?? '').trim();
    const content = text.slice(from, closed).trimEnd();
    if (!name || !content.trim()) continue;

    files.push({ name, content });
    pattern.lastIndex = closed;
  }

  return files;
}

/** Told to every agent, because any of them may have something the next one needs. */
export const HANDOVER_PROTOCOL = `## Handing something to the agents after you

If you settle something the rest of this change depends on — the names of fields, a signature,
the shape of a stored record — publish it, and every agent asked for anything after you gets it
without having to find it:

\`\`\`handover the-name.md
what you decided, in as few lines as it takes
\`\`\`

Only what others must match. Not your reasoning, not a summary of your work — that is what your
answer is for.`;

/** One agent's answer, as the next agent needs to receive it. */
export interface AgentReport {
  agentId: string;
  agentName: string;
  task: string;
  answer: string;
}

/** How much of a delegate's prompt the other agents' findings may take. */
export const MAX_SIBLING_BYTES = 3000;
/** How much of any one answer is carried. Enough for a decision, not for a transcript. */
export const MAX_SIBLING_ANSWER_BYTES = 700;
/** How many are carried at all: a run of twenty must not put nineteen in the twentieth. */
export const MAX_SIBLING_REPORTS = 6;

/**
 * What the agents before this one already established.
 *
 * Six agents changing one feature across six layers used to derive the same field names from
 * the same spec, separately, each paying to read the store and the service to find out what
 * was actually written. The orchestrator was holding every one of those answers and handing
 * them to nobody.
 *
 * Newest first and hard-bounded, because this is added to every delegate's prompt and a
 * digest that grows with the run would cost more than the rediscovery it replaces.
 */
export function withSiblings(task: string, reports: AgentReport[]): string {
  if (reports.length === 0) return task;

  const blocks: string[] = [];
  let budget = MAX_SIBLING_BYTES;

  for (const report of reports.slice(-MAX_SIBLING_REPORTS).reverse()) {
    const answer = clipBytes(report.answer.trim(), MAX_SIBLING_ANSWER_BYTES);
    if (!answer) continue;

    const block = [
      `### ${report.agentName} (\`${report.agentId}\`) — asked for: ${summarise(report.task, 120)}`,
      '',
      answer,
    ].join('\n');

    const size = Buffer.byteLength(block, 'utf8');
    if (size > budget) break;
    budget -= size;
    blocks.push(block);
  }

  if (blocks.length === 0) return task;

  return [
    task,
    '',
    '## What the other agents have already decided',
    '',
    'These ran before you, on this same change. Their decisions hold: use the names, fields and',
    'signatures they chose rather than picking your own, and do not go looking for what is',
    'already written here. If one of them is wrong, say so in your answer instead of quietly',
    'doing something different.',
    '',
    `Abridged on purpose: the ${MAX_SIBLING_REPORTS} most recent answers at most, trimmed to`,
    `${MAX_SIBLING_BYTES} bytes in total, newest first. Older agents in this run may have decided`,
    'things that are not here, and an answer shown here may be cut short — ask your orchestrator',
    'rather than assuming what is missing was never decided.',
    '',
    ...blocks,
  ].join('\n');
}

/** Whole lines up to a byte budget: half a sentence reads as a mistake rather than a limit. */
function clipBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text;

  const kept: string[] = [];
  let size = 0;

  for (const line of text.split(/\r?\n/)) {
    size += Buffer.byteLength(line, 'utf8') + 1;
    if (size > bytes) break;
    kept.push(line);
  }

  // One long paragraph has no line to cut on, and returning nothing would drop the whole
  // report — the agent that wrote the most useful answer would be the one nobody heard.
  if (kept.length === 0) return `${cutBytes(text, bytes)}\n\n(trimmed)`;

  return `${kept.join('\n')}\n\n(trimmed)`;
}

/** A hard cut on a byte budget, without splitting a character in half. */
function cutBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;

  return new TextDecoder('utf-8', { fatal: false })
    .decode(buffer.subarray(0, bytes))
    .replace(/\uFFFD$/, '');
}

/**
 * What the touched-files context file is called, on the run and on the console chip.
 *
 * A constant because two sides must agree on it: the service composes a file under this name
 * at `start`, and a resumed run must recognise the one it already stored rather than adding a
 * second copy beside it.
 */
export const TOUCHED_FILES_CONTEXT_NAME = 'touched-files.md';

/**
 * The files an item says it changes, as a context file every agent is given.
 *
 * `touches` was read only by the scheduler, to decide which items may run at the same time; no
 * agent had ever seen one. An agent that is not told where the work is pays to find it — one
 * measured here spent 2.4M tokens adding a column to a row, almost none of it writing.
 *
 * Returns `undefined` — not an empty file, not a file saying "none" — when the item declares
 * nothing. An item with an empty `touches` must add no section and no chip, and a heading
 * followed by nothing reads as "this change touches no files", which is never what it means:
 * it means nobody wrote the list down.
 */
export function touchedFilesContext(touches: readonly string[] | undefined): ContextFile | undefined {
  const paths = (touches ?? []).map((path) => path.trim()).filter((path) => path.length > 0);
  if (paths.length === 0) return undefined;

  return {
    name: TOUCHED_FILES_CONTEXT_NAME,
    content: [
      'The item says this change is about these paths:',
      '',
      ...paths.map((path) => `- \`${path}\``),
      '',
      'Start there rather than searching for them. This is a starting point, not a fence:',
      'if the work genuinely needs a file that is not listed, open it and say in your answer',
      'which one and why.',
      '',
      'If you are planning this change rather than making it: this list is why you do not need',
      'to send anyone to find out where the work is. Hand each path to the agent that owns that',
      'part of the tree. A scout that returns this list has been paid to tell you what you were',
      'already told.',
      '',
      'The list is the whole change, not your part of it. Open what your own job needs and',
      'leave the rest to whoever owns it.',
    ].join('\n'),
  };
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

Match the team to the change before you start. Every agent you add is a whole session that
reads the code again from nothing: a one-file fix wants one author and one check, not the
roster. Measured here, the same task cost $0.09 done by six steps and $23 done by seventeen.
Add an agent when you cannot answer without it, not because it exists.

Several entries run in parallel, so ask for everything that does not depend on something
else at once. Every agent is already given the run's brief, so write only what *this* agent
must do and what it needs that the brief does not say. Do not restate the background. It
cannot see this conversation or what the other agents returned.

You then get their results and may delegate again.

A delegate does not start from nothing. It arrives already holding the run's brief, the files
this item says it changes, a digest of what the delegates before it in this run concluded, and
anything an agent has handed over. So do not re-explain what a sibling established, do not
retype the field names or signatures another agent chose, and do not send anyone to find out
which files the work is in — they have been told. Delegating a task that has already been
answered returns you the earlier answer instead of running it again, so re-asking buys nothing
and costs a whole session; ask for what is still open.

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

/** Where a step's prompt bytes went, part by part. */
export interface PromptParts {
  agent: number;
  protocol: number;
  roster: number;
  tools: number;
  repos: number;
  context: number;
}

/**
 * Bytes, not characters. A prompt is billed and transmitted as bytes, and on a prompt full of
 * em-dashes and Cyrillic the two numbers differ by enough to change a decision.
 */
export function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
