import { z } from 'zod';

/**
 * What one agent turn actually sends, measured and assembled in one place.
 *
 * An agent's own prompt is usually the small part. Around it every turn re-sends the same
 * scaffolding — the orchestration protocol, the roster, the tool briefing, the repo list —
 * and the attached context files. Nothing measured that until this module existed, so
 * scaffolding grew without anybody paying attention to the bill it was writing.
 *
 * The one surprising thing here, said plainly so no reader files it as a bug: `bytes` counts
 * `context` but `text` does not contain it, because the context files ride in the first user
 * message (`withContext`) rather than in the system prompt — they are paid for every turn all
 * the same, and a size that omitted them would understate what the turn costs.
 *
 * Pure by construction: strings in, numbers and strings out. Nothing here reads a file,
 * a workflow or a run — callers pass in text that is already assembled elsewhere.
 */

/**
 * The six pieces of a turn, in the order the service assembles them.
 *
 * `context` is last because it is not part of the system prompt at all; it is here so one
 * number can describe the whole turn.
 */
export interface PromptParts {
  /** The agent's own system prompt. Never trimmed. */
  agent?: string;
  /** The orchestration or verdict protocol. Never trimmed. */
  protocol?: string;
  /** Who an orchestrator may delegate to. Not trimmable: without it, it cannot delegate. */
  roster?: string;
  /** Tool usage notes. First to go when the budget is exceeded. */
  tools?: string;
  /** The repo list. Second to go. */
  repos?: string;
  /** Attached files. Sent in the user message, counted here, never trimmed. */
  context?: string;
}

export type PromptPart = keyof PromptParts;

/** Assembly order of the system prompt, then `context`, which is not in the text. */
export const PROMPT_PART_ORDER: PromptPart[] = [
  'agent',
  'protocol',
  'roster',
  'tools',
  'repos',
  'context',
];

/** The parts of the system prompt, in the order they are joined into `text`. */
const SYSTEM_PART_ORDER: PromptPart[] = ['agent', 'protocol', 'roster', 'tools', 'repos'];

/**
 * What a budget may drop, in the order it drops it.
 *
 * `agent`, `protocol` and `context` are the turn's job, its output contract and its source
 * of truth; a prompt missing any of them is not a smaller prompt but a broken one. `roster`
 * is not here either: an orchestrator whose roster was trimmed cannot name a single agent to
 * delegate to, so trimming it turns a costly run into a failed one.
 */
export const TRIMMABLE_PARTS: PromptPart[] = ['tools', 'repos'];

/** How the parts are joined. Each included part after the first is charged these bytes. */
const PART_SEPARATOR = '\n\n';

/** Human names for the trim notice, so the line reads as a sentence. */
const PART_LABELS: Record<PromptPart, string> = {
  agent: 'the agent prompt',
  protocol: 'the protocol',
  roster: 'the roster',
  tools: 'the tool notes',
  repos: 'the repo list',
  context: 'the attached context',
};

/**
 * Bytes per part, and they sum exactly to `PromptSize.bytes`.
 *
 * `notice` is the trim notice appended to `text`; it is its own key rather than folded into
 * another part, so "what did the budget cost us" stays answerable after the fact.
 */
export interface PromptBreakdown {
  agent: number;
  protocol: number;
  roster: number;
  tools: number;
  repos: number;
  context: number;
  notice: number;
}

export interface PromptSize {
  /** The system prompt, plus the trim notice when something was dropped. Excludes `context`. */
  text: string;
  /** Every part's bytes including `context` and the notice. Sums `breakdown` exactly. */
  bytes: number;
  breakdown: PromptBreakdown;
  /** Which parts the budget dropped, in the order they were dropped. Empty when none were. */
  trimmed: PromptPart[];
}

const EMPTY_BREAKDOWN: PromptBreakdown = {
  agent: 0,
  protocol: 0,
  roster: 0,
  tools: 0,
  repos: 0,
  context: 0,
  notice: 0,
};

/** A fresh zeroed breakdown. The constant itself is never handed out, so nobody can mutate it. */
export function emptyBreakdown(): PromptBreakdown {
  return { ...EMPTY_BREAKDOWN };
}

const encoder = new TextEncoder();

/**
 * UTF-8 bytes, not characters.
 *
 * These prompts are full of em dashes and backticks, and the thing being measured is a bill
 * charged in bytes. `String.length` would quietly undercount every one of them.
 */
export function utf8Bytes(text: string | undefined | null): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}

/**
 * The breakdown schema as it is stored and returned.
 *
 * Six named parts plus the notice rather than an open record: the parts are a closed set
 * decided here, and a fixed shape means the web console can render a labelled bar without
 * guessing what a key means, while an old row — a missing column, an empty object, JSON that
 * no longer parses — reads back as zeros instead of throwing.
 */
export const PromptBreakdownSchema = z
  .object({
    agent: z.number().nonnegative().default(0),
    protocol: z.number().nonnegative().default(0),
    roster: z.number().nonnegative().default(0),
    tools: z.number().nonnegative().default(0),
    repos: z.number().nonnegative().default(0),
    context: z.number().nonnegative().default(0),
    notice: z.number().nonnegative().default(0),
  })
  .default({})
  .catch(() => emptyBreakdown());

/**
 * Assemble the system prompt for one turn, and measure what the turn sends.
 *
 * Separator charging, so that `breakdown` sums to `bytes` exactly rather than nearly: parts
 * are joined with a blank line, and each included part is charged the separator that
 * *precedes* it. The first included part is charged none. `context` is joined to nothing and
 * so is charged none either. Every byte of `text` therefore belongs to exactly one part.
 *
 * With a `budget` in bytes, an over-budget turn drops `tools`, then `repos`, and stops there:
 * if it is still over budget, the prompt is returned over budget rather than mutilated. The
 * trim decision is made on the size before the notice is appended, so a prompt trimmed to
 * just inside the budget can end up a notice-line over it. That is deliberate — the notice
 * is the record of what happened, and dropping it to hit a number would hide the trim.
 */
export function assemblePrompt(parts: PromptParts, budget?: number): PromptSize {
  const present = new Set<PromptPart>(
    SYSTEM_PART_ORDER.filter((part) => utf8Bytes(parts[part]) > 0),
  );

  const trimmed: PromptPart[] = [];
  const limit = typeof budget === 'number' && budget > 0 ? budget : undefined;

  if (limit !== undefined) {
    for (const part of TRIMMABLE_PARTS) {
      if (size(parts, present).bytes <= limit) break;
      if (!present.has(part)) continue;
      present.delete(part);
      trimmed.push(part);
    }
  }

  const notice =
    trimmed.length > 0
      ? `> Dropped ${listed(trimmed)} to fit this project's promptBudget of ${limit} bytes.`
      : '';

  const { text, breakdown, bytes } = size(parts, present, notice);

  return { text, bytes, breakdown, trimmed };
}

/** The text and the arithmetic for one choice of included parts. */
function size(
  parts: PromptParts,
  present: Set<PromptPart>,
  notice = '',
): { text: string; bytes: number; breakdown: PromptBreakdown } {
  const breakdown = emptyBreakdown();
  const pieces: string[] = [];

  for (const part of SYSTEM_PART_ORDER) {
    if (!present.has(part)) continue;
    const body = parts[part] ?? '';
    // The separator that precedes this part belongs to it; the first one has none.
    breakdown[part] = utf8Bytes(body) + (pieces.length > 0 ? utf8Bytes(PART_SEPARATOR) : 0);
    pieces.push(body);
  }

  if (notice) {
    breakdown.notice = utf8Bytes(notice) + (pieces.length > 0 ? utf8Bytes(PART_SEPARATOR) : 0);
    pieces.push(notice);
  }

  // Not in the text: the attached files are sent in the user message, not the system prompt.
  breakdown.context = utf8Bytes(parts.context);

  const bytes = PROMPT_PART_ORDER.reduce((total, part) => total + breakdown[part], 0) + breakdown.notice;

  return { text: pieces.join(PART_SEPARATOR), bytes, breakdown };
}

/** "the tool notes and the repo list" — for the notice line. */
function listed(parts: PromptPart[]): string {
  const labels = parts.map((part) => PART_LABELS[part]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Linting a workflow before it is run
// ---------------------------------------------------------------------------

/**
 * When a turn is large enough to be worth saying out loud.
 *
 * The same number as `policy.promptBudget`'s default, on purpose: lint should warn about
 * exactly the prompts the budget would start trimming, so the two do not disagree about what
 * "too big" means. The CLI takes it as a default rather than hardcoding it.
 */
export const PROMPT_LINT_THRESHOLD_BYTES = 8000;

/** One agent, with the scaffolding it will carry, already rendered by the caller. */
export interface PromptLintInput {
  agentId: string;
  agentName: string;
  parts: PromptParts;
}

export interface PromptLintResult {
  agentId: string;
  agentName: string;
  /** The agent's own prompt. */
  promptBytes: number;
  /** Everything else this turn carries: protocol, roster, tools, repos, context. */
  scaffoldingBytes: number;
  /** What one turn sends in total. Equals `PromptSize.bytes`. */
  totalBytes: number;
  breakdown: PromptBreakdown;
  /** The turn spends more on scaffolding than on the job it was written for. */
  scaffoldingHeavy: boolean;
  /** Over the threshold it was linted against. */
  overThreshold: boolean;
}

/**
 * What `pomni workflow lint <id>` reports, without a CLI and without a run.
 *
 * No budget is applied: lint says how big each turn *is*, and a budget that silently trimmed
 * the answer would report the size of a prompt nobody is complaining about.
 */
export function lintPrompts(
  agents: PromptLintInput[],
  threshold: number = PROMPT_LINT_THRESHOLD_BYTES,
): PromptLintResult[] {
  return agents.map((entry) => {
    const { bytes, breakdown } = assemblePrompt(entry.parts);
    const promptBytes = breakdown.agent;
    return {
      agentId: entry.agentId,
      agentName: entry.agentName,
      promptBytes,
      scaffoldingBytes: bytes - promptBytes,
      totalBytes: bytes,
      breakdown,
      scaffoldingHeavy: bytes - promptBytes > promptBytes,
      overThreshold: bytes > threshold,
    };
  });
}
