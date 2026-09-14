import { z } from 'zod';

/**
 * The three moments a run needs a person, plus the sample kind `pomni notify test` sends.
 *
 * `question`: an agent asked and is waiting. `gate_failed`: a run's gate went red. `in_review`:
 * an item landed as a merge request waiting on review. Each maps to one line of prose and one
 * link; nothing here decides how loudly it is delivered — that is the channel's job.
 */
export const NotificationKindSchema = z.enum(['question', 'gate_failed', 'in_review', 'test']);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** A reason line is read at a glance, never scrolled — cut well before it wraps a toast. */
export const REASON_MAX_CHARS = 160;

/** Bumped only if the webhook body's shape changes in a way a receiver must branch on. */
export const WEBHOOK_BODY_VERSION = 1 as const;

export const NotificationEventSchema = z.object({
  kind: NotificationKindSchema,
  projectId: z.string(),
  /** Null only for `test`, which has no run behind it. */
  runId: z.string().nullable(),
  itemId: z.string().nullable(),
  /** One line, already trimmed to `REASON_MAX_CHARS` by `reasonLine`. */
  reason: z.string(),
  url: z.string(),
  ts: z.string(),
  /** Set only for `question`. */
  questionId: z.string().nullable(),
  /** Set only for `in_review`. */
  mergeRequestUrl: z.string().nullable(),
});
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

/**
 * One line, safe to put in a toast or a chat message.
 *
 * Collapses whatever whitespace a gate summary or a question carries — several lines of test
 * output is the common case for `gate_failed` — and cuts it short rather than truncating mid
 * word wherever it lands, so what is shown never ends on half a token.
 */
export function reasonLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= REASON_MAX_CHARS) return collapsed;

  const cut = collapsed.slice(0, REASON_MAX_CHARS - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed}…`;
}

/**
 * What `PipelineStore.markNotified` dedupes on.
 *
 * A question is identified by the question itself — the same run can ask more than one over
 * its life, and each deserves its own notification. The other kinds happen at most once per
 * run, so the kind alone is enough to tell a resend from a repeat.
 */
export function notificationKey(event: Pick<NotificationEvent, 'kind' | 'questionId'>): string {
  return event.kind === 'question' && event.questionId ? `question:${event.questionId}` : event.kind;
}

/**
 * The page a person should land on: the item if there is one, else the run, else the project.
 * An item is more specific than the run that happened to produce this event, and it is where
 * the merge request and the gate result are both shown.
 */
export function notificationUrl(
  base: string,
  projectId: string,
  runId: string | null,
  itemId: string | null,
): string {
  const origin = base.replace(/\/+$/, '');
  if (itemId) return `${origin}/p/${projectId}/items/${itemId}`;
  if (runId) return `${origin}/p/${projectId}/runs/${runId}`;
  return `${origin}/p/${projectId}`;
}
