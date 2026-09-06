import { z } from 'zod';
import { MessageAddressSchema } from './address.js';
import { ConflictError, ValidationError } from './errors.js';

/**
 * A conversation with Pomni itself.
 *
 * Distinct from a pipeline run: a run is a workflow executing against a task and ends when the
 * orchestrator returns; a chat is open-ended and outlives any single answer. What they share is
 * that a chat can *start* a run — so a chat carries run ids, not steps.
 *
 * The other thing a chat carries is proposed actions. A model answering "move POMN-4 to done"
 * does not move it; it proposes an action, and a person confirms. Every write in this file
 * exists to keep that gap open, because a model that can silently mutate the backlog is a model
 * whose mistakes are only discoverable after the fact.
 */

export const ChatRoleSchema = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * Where a proposed action is in its life.
 *
 * `proposed` is the model's suggestion and nothing more. `confirmed` is a person saying yes.
 * `running` means it is executing — reads enter here directly, since there is nothing to confirm.
 * `executed` and `failed` are terminal and say what actually happened, which is deliberately not
 * the same claim as "the model said it would".
 */
export const ActionStatusSchema = z.enum([
  'proposed',
  'confirmed',
  'rejected',
  'running',
  'executed',
  'failed',
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/**
 * The only legal moves. Terminal states have no exits: an executed action is never re-run in
 * place, because its `result` is the record of one execution and a second would overwrite it.
 * Re-running means proposing again, which leaves both attempts in the transcript.
 */
export const ACTION_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  proposed: ['confirmed', 'rejected'],
  confirmed: ['running', 'rejected'],
  rejected: [],
  running: ['executed', 'failed'],
  executed: [],
  failed: [],
};

/**
 * Something the assistant wants done, recorded on the message that proposed it.
 *
 * Stored with the message rather than in its own table: an action has no meaning apart from the
 * turn that produced it, and reading a chat should never need a second query to know what the
 * assistant offered to do.
 */
export const ProposedActionSchema = z.object({
  id: z.string(),
  /** 'service.method' form, e.g. 'backlog.move'. */
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  /**
   * Whether running this changes state. Set by the service from its own catalogue of callable
   * methods, never taken from the model — a model that could declare its own writes to be reads
   * would route straight past the confirmation it is meant to wait for.
   */
  writes: z.boolean().default(false),
  /** One sentence naming exactly what will change. Shown in the confirm prompt. */
  description: z.string().default(''),
  status: ActionStatusSchema.default('proposed'),
  /** JSON-encoded service return value. */
  result: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /** The pipeline run this action started, if any. */
  runId: z.string().nullable().default(null),
  createdAt: z.string(),
  /** When a person confirmed or rejected it. Null while still proposed. */
  decidedAt: z.string().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/** One turn. The transcript is these, in `createdAt` order. */
export const ChatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: ChatRoleSchema,
  text: z.string(),
  /**
   * Which provider and model answered, recorded per message rather than only on the chat: the
   * chat's pinned model can be changed mid-conversation, and a transcript that claims the
   * current model wrote every earlier turn is wrong about its own history.
   */
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  /** The project in force when this turn ran, addressed or inherited. */
  projectId: z.string().nullable().default(null),
  /**
   * What this message was aimed at, as resolved. Stored so a chip re-renders without
   * re-parsing — and without re-guessing, since a candidate that named nothing was never an
   * address and must not become one later when a project by that name is created.
   */
  addresses: z.array(MessageAddressSchema).default([]),
  actions: z.array(ProposedActionSchema).default([]),
  createdAt: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  /** Null when the provider reports no cost — see `rollUpUsage` for why that is not zero. */
  costUsd: z.number().nullable().default(null),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** The conversation itself, without its transcript. What a list renders. */
export const ChatSchema = z.object({
  id: z.string(),
  /** Derived from the first user message; see `deriveChatTitle`. */
  title: z.string().default(''),
  providerId: z.string(),
  model: z.string(),
  /**
   * The project this conversation is about, set by `#project` and held until changed. Null
   * is a real answer — a chat about nothing in particular addresses no project.
   */
  projectId: z.string().nullable().default(null),
  /**
   * When the title stopped being provisional — generated, or fallen back, or renamed by
   * hand. Non-null means nothing may overwrite it, which is how a late generation loses a
   * race against a person who has already named the thing.
   */
  titleGeneratedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  /** Bumped on every message. Chat lists sort by this, not `createdAt`. */
  updatedAt: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  costUsd: z.number().nullable().default(null),
});
export type Chat = z.infer<typeof ChatSchema>;

/**
 * A chat with everything a view needs, assembled by the service.
 *
 * Not a schema: none of the extra fields are stored. `providerLabel` and `providerAvailable` are
 * resolved against the provider config at read time, because a chat pinned to a provider that
 * has since been removed must still open — read-only, and saying so.
 */
export interface ChatDetail extends Chat {
  messages: ChatMessage[];
  /** The provider's label, or the raw id when it is no longer configured. */
  providerLabel: string;
  /** False when the pinned provider is gone or disabled. */
  providerAvailable: boolean;
  /** Every run this chat started, oldest first. */
  runIds: string[];
  /** Actions still awaiting a decision, across every message. */
  pendingActions: ProposedAction[];
}

export interface ChatFilter {
  query?: string;
  providerId?: string;
  limit?: number;
}

export const NEW_CHAT_TITLE = 'New chat';
export const MAX_CHAT_TITLE = 60;

/**
 * A chat's name, taken from its first user message.
 *
 * Asking a model to name the conversation costs a round trip and can fail; the first line the
 * person typed is what they would have called it anyway.
 */
export function deriveChatTitle(firstMessage: string): string {
  const line = firstMessage
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return NEW_CHAT_TITLE;

  const collapsed = line.replace(/\s+/g, ' ');
  return collapsed.length <= MAX_CHAT_TITLE
    ? collapsed
    : `${collapsed.slice(0, MAX_CHAT_TITLE - 1)}…`;
}

/**
 * Whether a person has to say yes before this runs.
 *
 * The rule is the whole safety story of chat, and it is one line so that it cannot drift: it
 * is exactly "does this write". Not a list of dangerous method names, which would need editing
 * every time a service gains one and would fail open when someone forgot.
 */
export function needsConfirmation(action: ProposedAction): boolean {
  return action.writes;
}

/**
 * Where an action starts. Reads skip straight to `running` — pausing to confirm
 * `backlog.list` would train people to click through the prompt without reading it, which is
 * precisely what must not happen to the write prompts.
 */
export function initialStatus(writes: boolean): ActionStatus {
  return writes ? 'proposed' : 'running';
}

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

/**
 * Guard a status change. Throws rather than returning false because every caller is a mutation
 * that must not proceed — a double-confirm arriving from two browser tabs is a conflict, and
 * silently accepting the second would run the action twice.
 */
export function assertTransition(action: ProposedAction, to: ActionStatus): void {
  if (!canTransition(action.status, to)) {
    throw new ConflictError(
      `action '${action.name}' cannot move from '${action.status}' to '${to}'`,
      { actionId: action.id, from: action.status, to },
    );
  }
}

/**
 * The last check before an action actually runs.
 *
 * Separate from `assertTransition` on purpose. A transition check asks whether the state machine
 * allows the move; this asks whether a person authorised the effect. An executor that only
 * checked transitions would happily run a write that reached `running` some other way.
 */
export function assertExecutable(action: ProposedAction): void {
  if (action.writes && action.status !== 'confirmed') {
    throw new ValidationError(
      `action '${action.name}' writes and has not been confirmed (status '${action.status}')`,
      { actionId: action.id, status: action.status },
    );
  }
  if (!action.writes && action.status !== 'running' && action.status !== 'confirmed') {
    throw new ValidationError(
      `action '${action.name}' is not ready to run (status '${action.status}')`,
      { actionId: action.id, status: action.status },
    );
  }
}

/**
 * A chat's totals, from its messages.
 *
 * `costUsd` stays null until some message reports one, and then sums only the non-null ones.
 * Substituting 0 for "the provider did not tell us" would render a chat that cost real money as
 * free, and the two are not the same claim — the same distinction `PipelineRun.costUsd` makes.
 */
export function rollUpUsage(messages: ChatMessage[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;

  for (const message of messages) {
    inputTokens += message.inputTokens;
    outputTokens += message.outputTokens;
    if (message.costUsd !== null) costUsd = (costUsd ?? 0) + message.costUsd;
  }

  return { inputTokens, outputTokens, costUsd };
}
