import { z } from 'zod';
import { ValidationError } from './errors.js';
import {
  DEFAULT_FLOW,
  EMPTY_EVIDENCE,
  activeStates,
  boardColumns,
  describeUnmetList,
  evaluate,
  targetsFrom,
} from './flow.js';
import type { Evidence, Flow, FlowState, TransitionOffer, UnmetRequirement } from './flow.js';

export * from './flow.js';

/**
 * A unit of work on a project. Stored as Markdown with YAML frontmatter so a human can read
 * it in a PR diff and an agent can edit it with ordinary file tools — the body is carried
 * around as an opaque string, which is what makes the round-trip lossless.
 */

/**
 * The statuses the built-in flow uses. Still the vocabulary of every project that has not
 * declared its own flow, and still what a UI should have labels for.
 */
export const CORE_STATUSES = [
  'backlog',
  'specced',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
] as const;
export type CoreItemStatus = (typeof CORE_STATUSES)[number];

/**
 * A status is whatever its project's flow calls a state — so this is a string, not an enum.
 * `CoreItemStatus | (string & {})` keeps autocomplete for the built-in eight while accepting
 * a project's own names.
 *
 * Deliberately permissive on read: a status the current flow does not declare must still
 * parse, because the alternative is that editing a flow makes the items standing in the
 * dropped state unreadable. Validation moved to the flow, where it can say something useful.
 */
export type ItemStatus = CoreItemStatus | (string & {});

export const ItemStatusSchema = z.string().min(1);

export const ItemTypeSchema = z.enum(['feature', 'bug', 'chore', 'spike', 'refactor', 'docs']);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const PrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof PrioritySchema>;

export const EstimateSchema = z.enum(['XS', 'S', 'M', 'L', 'XL']);
export type Estimate = z.infer<typeof EstimateSchema>;

export const BacklogItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  type: ItemTypeSchema.default('feature'),
  status: ItemStatusSchema.default('backlog'),
  priority: PrioritySchema.default('P2'),
  estimate: EstimateSchema.nullable().default(null),
  /** Repos this item touches. Empty means "the whole project". */
  repos: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  /** Items that must reach `done` before this one may start. */
  dependsOn: z.array(z.string()).default([]),
  /**
   * Rank within its board column. Sparse (10, 20, 30) so a drag-drop insert rewrites one
   * item instead of renumbering its neighbours.
   */
  order: z.number().default(0),
  branch: z.string().nullable().default(null),
  /**
   * Definition-of-done boxes a human has ticked, as `checklist key -> ISO timestamp`.
   * Presence is the tick; unticking deletes the key. Keys come from the project flow's
   * `checklist` requirements, so a key left behind by an edited flow is inert, not an error.
   *
   * Kept in frontmatter rather than as body checkboxes on purpose: a human rewrites the body
   * freely and a tick is a claim with a time on it, not prose. The item's Log still records
   * the moment a checklist was completed, so the paper trail stays in the Markdown.
   */
  checklist: z.record(z.string(), z.string()).default({}),
  /** Set when status is `blocked`; restored on unblock. */
  blockedReason: z.string().nullable().default(null),
  statusBefore: ItemStatusSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Everything below the frontmatter, verbatim. */
  body: z.string().default(''),
});

export type BacklogItem = z.infer<typeof BacklogItemSchema>;

/**
 * Reverse dependency edges are derived, never stored — storing both directions means two
 * places to keep in sync and one of them will be wrong.
 */
export interface BacklogItemDetail extends BacklogItem {
  /**
   * Every move a UI should draw, each with whether it will work and, when it will not, the
   * unmet requirements behind it — so a button can be disabled with the reason beside it.
   * Was `ItemStatus[]`; a caller that wants the old shape reads `.map((offer) => offer.to)`.
   */
  allowedTransitions: TransitionOffer[];
  /** The item's state as its project's flow describes it, or null when it is off-flow. */
  flowState: FlowState | null;
  /**
   * True when the stored status is not a state in the project's flow. The item is readable
   * and listed; the only moves offered are the flow's recovery states.
   */
  offFlow: boolean;
  /** Dependencies that are not yet done. Non-empty means this item cannot start. */
  blockedBy: string[];
  /** Items that depend on this one. */
  blocking: string[];
  sections: Record<string, string>;
  acceptance: { total: number; checked: number };
}

export interface ItemFilter {
  projectId?: string;
  status?: ItemStatus | ItemStatus[];
  type?: ItemType;
  priority?: Priority;
  label?: string;
  repo?: string;
  /** Case-insensitive substring match on the title. */
  query?: string;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The lifecycle now lives in `flow.ts` and is per-project. Everything below takes a `Flow`
 * and defaults to `DEFAULT_FLOW`, so a caller that has not been taught about flows yet keeps
 * the behaviour it had — but a caller holding a project must pass that project's flow.
 */

/** Statuses that count as live work for board and "next item" purposes, in the built-in flow. */
export const ACTIVE_STATUSES: ItemStatus[] = activeStates(DEFAULT_FLOW);

export const BOARD_COLUMNS: ItemStatus[] = boardColumns(DEFAULT_FLOW);

export function activeStatuses(flow: Flow = DEFAULT_FLOW): ItemStatus[] {
  return activeStates(flow);
}

export function boardColumnsOf(flow: Flow = DEFAULT_FLOW): ItemStatus[] {
  return boardColumns(flow);
}

/** Where an item can legally go from here, requirements aside. */
export function allowedFrom(status: ItemStatus, flow: Flow = DEFAULT_FLOW): ItemStatus[] {
  return targetsFrom(flow, status);
}

/** Whether the arrow exists. Says nothing about whether its requirements are satisfied. */
export function canTransition(
  from: ItemStatus,
  to: ItemStatus,
  flow: Flow = DEFAULT_FLOW,
): boolean {
  if (from === to) return true;
  return targetsFrom(flow, from).includes(to);
}

/** The graph refuses the move: there is no such arrow, or no such state. */
export class InvalidTransitionError extends ValidationError {
  constructor(id: string, from: ItemStatus, to: ItemStatus, allowed: ItemStatus[] = []) {
    super(
      `${id} cannot move from '${from}' to '${to}' — allowed from here: ${
        allowed.join(', ') || 'nothing'
      }`,
    );
  }
}

/**
 * The arrow exists but the work behind it does not. Carries the machine-readable shortfall in
 * `details` so a surface can render counts and repo names rather than re-parse a sentence.
 *
 * The message is a headline and then one line per unmet requirement, indented. `headline` is
 * the arrow's own `message` when the flow gave it one — which is how a default project still
 * reads "cannot go to review — the gate is not green" — and the generic
 * "cannot move from 'x' to 'y' yet" when it did not.
 */
export class RequirementsNotMetError extends ValidationError {
  readonly unmet: UnmetRequirement[];
  /** The leading sentence, without the item id. Surfaces that write their own may ignore it. */
  readonly headline: string;

  constructor(
    id: string,
    from: ItemStatus,
    to: ItemStatus,
    unmet: UnmetRequirement[],
    message?: string,
  ) {
    const headline = message ?? `cannot move from '${from}' to '${to}' yet`;
    const lines = describeUnmetList(unmet);
    super(`${id} ${headline}:\n  ${lines.join('\n  ')}`, { id, from, to, unmet, headline });
    this.unmet = unmet;
    this.headline = headline;
  }
}

/**
 * Guard one move. `evidence` defaults to nothing, which fails every requirement — omitting it
 * on an arrow that has requirements refuses the move rather than waving it through.
 */
export function assertTransition(
  id: string,
  from: ItemStatus,
  to: ItemStatus,
  flow: Flow = DEFAULT_FLOW,
  evidence: Evidence = EMPTY_EVIDENCE,
): void {
  const check = evaluate({ id, status: from }, flow, to, evidence);
  if (check.ok) return;
  if (check.reason === 'requirements') {
    throw new RequirementsNotMetError(id, from, to, check.unmet, check.message);
  }
  throw new InvalidTransitionError(id, from, to, check.allowed);
}

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

export const SECTION_PROBLEM = 'Problem';
export const SECTION_ACCEPTANCE = 'Acceptance criteria';
export const SECTION_PLAN = 'Plan';
export const SECTION_DECISIONS = 'Decisions';
export const SECTION_LOG = 'Log';

/** Split a body into `## Heading` sections. Content before the first heading is ignored. */
export function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split(/\r?\n/);

  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) sections[current] = buffer.join('\n').trim();
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1] as string;
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+/;

export function countAcceptance(body: string): { total: number; checked: number } {
  const section = parseSections(body)[SECTION_ACCEPTANCE] ?? '';
  let total = 0;
  let checked = 0;

  for (const line of section.split(/\r?\n/)) {
    const match = CHECKBOX.exec(line);
    if (!match) continue;
    total += 1;
    if (match[1] !== ' ') checked += 1;
  }

  return { total, checked };
}

/** Append a dated line to the Log section, creating it if it is missing. */
export function appendLog(body: string, entry: string, date: string): string {
  const line = `- ${date} ${entry}`;
  const heading = `## ${SECTION_LOG}`;

  if (!body.includes(heading)) {
    return `${body.replace(/\s*$/, '')}\n\n${heading}\n${line}\n`;
  }

  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((value) => value.trim() === heading);

  // Insert at the end of the Log section, before whatever heading follows it.
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }

  while (end > index + 1 && (lines[end - 1] as string).trim() === '') end -= 1;
  lines.splice(end, 0, line);
  return lines.join('\n');
}

export function newItemBody(title: string): string {
  return `## ${SECTION_PROBLEM}

_Why does this matter? What is broken or missing?_

## ${SECTION_ACCEPTANCE}

- [ ] ${title}

## ${SECTION_PLAN}

_Filled in by \`pomni feature plan\`, or by hand._

## ${SECTION_LOG}
`;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export const ORDER_STEP = 10;

/** Next rank at the end of a column. */
export function nextOrder(existing: BacklogItem[]): number {
  const max = existing.reduce((highest, item) => Math.max(highest, item.order), 0);
  return max + ORDER_STEP;
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Board order: explicit rank first, then priority, then age. */
export function compareItems(a: BacklogItem, b: BacklogItem): number {
  if (a.order !== b.order) return a.order - b.order;
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

/** The item `pomni feature next` should pick up. */
export function pickNext(items: BacklogItem[]): BacklogItem | null {
  const ready = items
    .filter((item) => item.status === 'ready')
    .sort((a, b) => {
      const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      return priority !== 0 ? priority : a.order - b.order;
    });
  return ready[0] ?? null;
}
