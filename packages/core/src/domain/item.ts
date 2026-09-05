import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * A unit of work on a project. Stored as Markdown with YAML frontmatter so a human can read
 * it in a PR diff and an agent can edit it with ordinary file tools — the body is carried
 * around as an opaque string, which is what makes the round-trip lossless.
 */

export const ItemStatusSchema = z.enum([
  'backlog',
  'specced',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

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

/** Statuses that count as live work for board and "next item" purposes. */
export const ACTIVE_STATUSES: ItemStatus[] = [
  'backlog',
  'specced',
  'ready',
  'in_progress',
  'in_review',
  'blocked',
];

export const BOARD_COLUMNS: ItemStatus[] = [
  'backlog',
  'specced',
  'ready',
  'in_progress',
  'in_review',
  'done',
];

const TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  backlog: ['specced', 'ready', 'blocked', 'cancelled'],
  specced: ['ready', 'backlog', 'blocked', 'cancelled'],
  ready: ['in_progress', 'specced', 'backlog', 'blocked', 'cancelled'],
  in_progress: ['in_review', 'ready', 'blocked', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  // Reopening is a real workflow, not an error.
  done: ['in_progress'],
  // Unblocking restores the previous status, so any active one is reachable.
  blocked: ['backlog', 'specced', 'ready', 'in_progress', 'in_review', 'cancelled'],
  cancelled: ['backlog'],
};

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends ValidationError {
  constructor(id: string, from: ItemStatus, to: ItemStatus) {
    super(
      `${id} cannot move from '${from}' to '${to}' — allowed from here: ${
        TRANSITIONS[from].join(', ') || 'nothing'
      }`,
    );
  }
}

export function assertTransition(id: string, from: ItemStatus, to: ItemStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new InvalidTransitionError(id, from, to);
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
