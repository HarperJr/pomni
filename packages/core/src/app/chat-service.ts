import {
  ChatMessageSchema,
  ChatSchema,
  assertExecutable,
  assertTransition,
  deriveChatTitle,
  initialStatus,
  needsConfirmation,
  rollUpUsage,
  type Chat,
  type ChatDetail,
  type ChatFilter,
  type ChatMessage,
  type ProposedAction,
} from '../domain/chat.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { Provider } from '../domain/provider.js';
import { ulid } from '../domain/ulid.js';
import type {
  ChatStore,
  Clock,
  EventBus,
  LlmMessage,
  Logger,
  PomniEvent,
} from '../ports/index.js';
import {
  CHAT_ACTION_PROTOCOL,
  actionBriefing,
  describeAction,
  findAction,
  parseActionArgs,
  parseActionCalls,
  type ChatActionCall,
  type ChatActionServices,
} from './chat-actions.js';
import type { BacklogService } from './backlog-service.js';
import type { PipelineService } from './pipeline-service.js';
import type { ProjectService } from './project-service.js';
import type { ProviderService } from './provider-service.js';
import type { RepoService } from './repo-service.js';
import type { RunService } from './run-service.js';
import type { ToolService } from './tool-service.js';
import type { WorkflowService } from './workflow-service.js';

export interface CreateChatInput {
  providerId: string;
  model: string;
  title?: string;
}

/**
 * What a chat tells the world it is doing.
 *
 * Narrowed out of `PomniEvent` rather than restated, so the two cannot drift: the port owns the
 * shapes, this alias only names the chat slice of them for routes and the UI.
 *
 * `chat.message.chunk` fires once per turn today because `LlmPort.complete` returns the whole
 * string at once; a provider that later streams calls it per chunk and nothing above it changes.
 */
export type ChatEvent = Extract<PomniEvent, { type: `chat.${string}` }>;

/** How much of a read's result is worth sending back to the model on the next turn. */
const MAX_RESULT_CHARS = 4000;

/**
 * Talking to Pomni.
 *
 * Everything the assistant can do goes through the catalogue in `chat-actions.ts`, which calls
 * the same service methods every other surface calls. That is the whole design: this service
 * decides *when* something runs and *who authorised it*, and never what the rules are.
 *
 * The gap it keeps open is the confirmation. A read runs the moment the model asks for it,
 * because pausing on `backlog.list` would teach people to click through prompts without
 * reading them — which is exactly what must not happen to the write prompts.
 */
export class ChatService {
  private readonly services: ChatActionServices;

  constructor(
    private readonly store: ChatStore,
    private readonly providers: ProviderService,
    private readonly projects: ProjectService,
    private readonly repos: RepoService,
    private readonly backlog: BacklogService,
    private readonly workflows: WorkflowService,
    private readonly tools: ToolService,
    private readonly runs: RunService,
    private readonly pipelines: PipelineService,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {
    this.services = {
      projects: this.projects,
      repos: this.repos,
      backlog: this.backlog,
      workflows: this.workflows,
      tools: this.tools,
      runs: this.runs,
      pipelines: this.pipelines,
    };
  }

  async create(input: CreateChatInput): Promise<Chat> {
    const provider = await this.enabledProvider(input.providerId);
    assertModel(provider, input.model);

    const now = this.clock.iso();
    const chat = ChatSchema.parse({
      id: ulid(this.clock.now().getTime()),
      // Left empty on purpose when nobody named it: the first message names it, once.
      title: input.title?.trim() ?? '',
      providerId: provider.id,
      model: input.model,
      createdAt: now,
      updatedAt: now,
    });

    await this.store.createChat(chat);
    this.announce({ type: 'chat.changed', chatId: chat.id });
    return chat;
  }

  async list(filter: ChatFilter = {}): Promise<Chat[]> {
    return this.store.listChats(filter);
  }

  /**
   * A chat with its transcript.
   *
   * Resolving the pinned provider must not throw: a chat pinned to a provider that has since
   * been removed still has a transcript worth reading, and `providerAvailable` is how it says
   * so instead of 404ing on its own history.
   */
  async get(id: string): Promise<ChatDetail> {
    const chat = await this.require(id);
    const messages = await this.store.listMessages(id);
    const provider = (await this.providers.list()).find(
      (candidate) => candidate.id === chat.providerId,
    );

    const actions = messages.flatMap((message) => message.actions);

    return {
      ...chat,
      messages,
      providerLabel: provider?.label ?? chat.providerId,
      providerAvailable: provider?.enabled ?? false,
      runIds: actions
        .map((action) => action.runId)
        .filter((runId): runId is string => runId !== null),
      pendingActions: actions.filter((action) => action.status === 'proposed'),
    };
  }

  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.store.deleteChat(id);
    this.announce({ type: 'chat.removed', chatId: id });
  }

  /**
   * Re-pin the chat to another provider and model.
   *
   * Only the next turn is affected. Earlier messages keep the provider and model that actually
   * wrote them, and the change itself is recorded as a `system` message so the transcript does
   * not silently claim one model said everything in it.
   */
  async setModel(id: string, providerId: string, model: string): Promise<Chat> {
    const chat = await this.require(id);
    const provider = await this.enabledProvider(providerId);
    assertModel(provider, model);

    const now = this.clock.iso();
    const next = ChatSchema.parse({ ...chat, providerId: provider.id, model, updatedAt: now });
    await this.store.updateChat(next);

    await this.store.appendMessage(
      ChatMessageSchema.parse({
        id: ulid(this.clock.now().getTime()),
        chatId: id,
        role: 'system',
        text: `Model changed to ${model} on ${provider.label}. Everything above was answered by what was pinned before.`,
        providerId: provider.id,
        model,
        createdAt: now,
      }),
    );

    this.announce({ type: 'chat.changed', chatId: id });
    return next;
  }

  /**
   * One turn: the person's message in, the assistant's answer out.
   *
   * Reads asked for in that answer run before this returns, so the message the caller receives
   * is already the settled one. Writes do not — they are left `proposed` and the turn ends
   * with them waiting, which is the point.
   */
  async sendMessage(id: string, text: string): Promise<ChatMessage> {
    const chat = await this.require(id);
    const body = text.trim();
    if (!body) throw new ValidationError('a message needs some words in it');

    const provider = await this.pinnedProvider(chat);
    const now = this.clock.iso();

    await this.store.appendMessage(
      ChatMessageSchema.parse({
        id: ulid(this.clock.now().getTime()),
        chatId: id,
        role: 'user',
        text: body,
        createdAt: now,
      }),
    );

    // Named once, from the first thing the person said. A later message never renames it.
    await this.store.updateChat(
      ChatSchema.parse({ ...chat, title: chat.title || deriveChatTitle(body), updatedAt: now }),
    );
    this.announce({ type: 'chat.changed', chatId: id });

    const history = this.history(await this.store.listMessages(id));
    const { port } = await this.providers.portFor('medium', { provider: chat.providerId });

    const result = await port.complete({
      model: chat.model,
      system: this.systemPrompt(),
      messages: history,
      // Claude Code drives its own thinking; the flag is for the direct API path.
      adaptiveThinking: provider.kind !== 'claude-code',
      effort: 'medium',
      maxTokens: 8000,
    });

    const { prose, calls } = parseActionCalls(result.text);
    const messageId = ulid(this.clock.now().getTime());
    const { actions, rejected } = this.plan(calls);

    const message = ChatMessageSchema.parse({
      id: messageId,
      chatId: id,
      role: 'assistant',
      // A reply that was nothing but a block has no prose, and rendering the raw json at the
      // person would be showing them the plumbing. The action cards are the message.
      text: [prose || (calls.length > 0 ? '' : result.text), ...rejected]
        .filter((line) => line.length > 0)
        .join('\n\n'),
      providerId: chat.providerId,
      model: chat.model,
      actions,
      createdAt: this.clock.iso(),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      // Nothing in this repo converts tokens to money, and inventing a price would report a
      // number nobody could check. Null means "the provider did not say", not "free".
      costUsd: null,
    });

    await this.store.appendMessage(message);
    this.announce({
      type: 'chat.message.chunk',
      chatId: id,
      messageId,
      text: message.text,
    });

    let settled = message;
    for (const action of message.actions) {
      if (needsConfirmation(action)) continue;
      settled = await this.execute(settled, action.id);
    }

    await this.rollUp(id);
    this.announce({ type: 'chat.turn.finished', chatId: id, messageId });
    return settled;
  }

  /**
   * A person says yes to a write.
   *
   * `proposed` → `confirmed` is persisted before anything runs: if the process dies mid-action
   * the record says a person authorised it, which is the fact that cannot be reconstructed
   * afterwards.
   */
  async confirmAction(chatId: string, messageId: string, actionId: string): Promise<ChatMessage> {
    const message = await this.messageIn(chatId, messageId);
    const action = actionIn(message, actionId);

    assertTransition(action, 'confirmed');
    const confirmed = await this.persist(message, {
      ...action,
      status: 'confirmed',
      decidedAt: this.clock.iso(),
    });

    return this.execute(confirmed, actionId);
  }

  async rejectAction(chatId: string, messageId: string, actionId: string): Promise<ChatMessage> {
    const message = await this.messageIn(chatId, messageId);
    const action = actionIn(message, actionId);

    assertTransition(action, 'rejected');
    const now = this.clock.iso();
    const rejected = await this.persist(message, {
      ...action,
      status: 'rejected',
      decidedAt: now,
      endedAt: now,
    });

    this.announce({
      type: 'chat.action.finished',
      chatId,
      messageId,
      actionId,
      name: action.name,
      status: 'rejected',
      error: null,
    });
    return rejected;
  }

  // -------------------------------------------------------------------------

  /**
   * Run one action and record what actually happened.
   *
   * The two guards do different jobs and both are needed: `assertExecutable` asks whether a
   * person authorised the effect, `assertTransition` asks whether the state machine allows the
   * move. An action that reached `running` some other way fails the first and never gets here.
   */
  private async execute(message: ChatMessage, actionId: string): Promise<ChatMessage> {
    let current = message;
    let action = actionIn(current, actionId);

    assertExecutable(action);

    // A read is created `running`; a write has just been confirmed and moves now.
    if (action.status !== 'running') {
      assertTransition(action, 'running');
      current = await this.persist(current, { ...action, status: 'running' });
      action = actionIn(current, actionId);
    }

    this.announce({
      type: 'chat.action.started',
      chatId: current.chatId,
      messageId: current.id,
      actionId,
      name: action.name,
      writes: action.writes,
    });

    const startedAt = Date.now();
    let settled: ProposedAction;

    try {
      const entry = findAction(action.name);
      const args = parseActionArgs(entry, action.args);
      const value = await (
        entry.run as (services: ChatActionServices, args: unknown) => Promise<unknown>
      )(this.services, args);

      assertTransition(action, 'executed');
      settled = {
        ...action,
        status: 'executed',
        result: encode(value),
        error: null,
        runId: runIdOf(value),
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.debug(`chat action ${action.name} failed`, detail);

      assertTransition(action, 'failed');
      settled = {
        ...action,
        status: 'failed',
        // Mutually exclusive: a failure has no result, and saying otherwise would let a reader
        // believe half of something happened.
        result: null,
        error: detail,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedAt,
      };
    }

    const done = await this.persist(current, settled);
    this.announce({
      type: 'chat.action.finished',
      chatId: done.chatId,
      messageId: done.id,
      actionId,
      name: settled.name,
      status: settled.status,
      error: settled.error,
    });
    return done;
  }

  /**
   * What the model asked for, turned into actions.
   *
   * `writes` comes from the catalogue and only from the catalogue. A call the catalogue does
   * not know, or arguments it cannot use, is dropped and said out loud in the reply — a
   * silently missing action reads as one the assistant chose not to take.
   */
  private plan(calls: ChatActionCall[]): { actions: ProposedAction[]; rejected: string[] } {
    const actions: ProposedAction[] = [];
    const rejected: string[] = [];

    for (const call of calls) {
      try {
        const entry = findAction(call.name);
        parseActionArgs(entry, call.args);

        actions.push({
          id: ulid(this.clock.now().getTime()),
          name: entry.name,
          args: call.args,
          writes: entry.writes,
          description: describeAction(entry, call.args),
          status: initialStatus(entry.writes),
          result: null,
          error: null,
          runId: null,
          createdAt: this.clock.iso(),
          decidedAt: null,
          endedAt: null,
          durationMs: null,
        });
      } catch (error) {
        rejected.push(`_Pomni could not run that: ${
          error instanceof Error ? error.message : String(error)
        }_`);
      }
    }

    return { actions, rejected };
  }

  /** Write one changed action back onto its message, and move the chat's clock. */
  private async persist(message: ChatMessage, action: ProposedAction): Promise<ChatMessage> {
    const next: ChatMessage = {
      ...message,
      actions: message.actions.map((other) => (other.id === action.id ? action : other)),
    };
    await this.store.updateMessage(next);

    const chat = await this.store.getChat(message.chatId);
    if (chat) {
      await this.store.updateChat({ ...chat, updatedAt: this.clock.iso() });
      this.announce({ type: 'chat.changed', chatId: chat.id });
    }
    return next;
  }

  /** The chat's totals, recomputed from its messages so the two can never disagree. */
  private async rollUp(chatId: string): Promise<void> {
    const chat = await this.store.getChat(chatId);
    if (!chat) return;

    await this.store.updateChat({
      ...chat,
      ...rollUpUsage(await this.store.listMessages(chatId)),
      updatedAt: this.clock.iso(),
    });
    this.announce({ type: 'chat.changed', chatId });
  }

  /**
   * The transcript as the model sees it.
   *
   * What a read returned comes back as a following user message, the same shape delegation
   * results take in a pipeline — an assistant that asked for `backlog.list` and was never told
   * the answer would ask again next turn. `system` messages are bookkeeping for the person
   * reading the chat and are left out; the model is already being run on the current model.
   */
  private history(messages: ChatMessage[]): LlmMessage[] {
    const turns: LlmMessage[] = [];

    for (const message of messages) {
      if (message.role === 'system') continue;

      if (message.role === 'user') {
        turns.push({ role: 'user', content: message.text });
        continue;
      }

      turns.push({ role: 'assistant', content: message.text || '(proposed an action)' });

      const reported = message.actions
        .map((action) => renderOutcome(action))
        .filter((line): line is string => line !== null);
      if (reported.length > 0) {
        turns.push({ role: 'user', content: ['What came back:', '', ...reported].join('\n') });
      }
    }

    // Some backends refuse two messages in a row from the same role, and an action report
    // followed by the person's next line is exactly that.
    return turns.reduce<LlmMessage[]>((collapsed, turn) => {
      const last = collapsed[collapsed.length - 1];
      if (last && last.role === turn.role) {
        collapsed[collapsed.length - 1] = {
          role: turn.role,
          content: `${last.content}\n\n${turn.content}`,
        };
        return collapsed;
      }
      return [...collapsed, turn];
    }, []);
  }

  private systemPrompt(): string {
    return [
      'You are Pomni, talking to the person who runs this workspace.',
      '',
      'Pomni manages other projects: their repos, their backlog, the commands that build and',
      'test them, and the agent workflows that do work on them. A **project** holds a backlog,',
      'gates and policy; a **repo** is one codebase inside it; a **capability** is a command a',
      'repo declares; a **gate** is capabilities that must pass before an item moves on; a',
      '**workflow** is an agent pipeline a task run uses.',
      '',
      'Answer from what you have looked up, not from what is plausible. Ids carry their project',
      "prefix, so 'POMN-21' says which project it is in. Be brief: this is a conversation, not a",
      'report.',
      '',
      actionBriefing(),
      '',
      CHAT_ACTION_PROTOCOL,
    ].join('\n');
  }

  private async require(id: string): Promise<Chat> {
    const chat = await this.store.getChat(id);
    if (!chat) throw new NotFoundError('chat', id);
    return chat;
  }

  private async messageIn(chatId: string, messageId: string): Promise<ChatMessage> {
    await this.require(chatId);
    const message = await this.store.getMessage(messageId);
    // A message id from another chat is not a message of this one, however real it is.
    if (!message || message.chatId !== chatId) throw new NotFoundError('message', messageId);
    return message;
  }

  private async enabledProvider(id: string): Promise<Provider> {
    const provider = (await this.providers.list()).find((candidate) => candidate.id === id);
    if (!provider) {
      throw new ValidationError(
        `there is no provider '${id}' — add one on the Providers page first`,
      );
    }
    if (!provider.enabled) {
      throw new ValidationError(`provider '${id}' is disabled — enable it or pick another`);
    }
    return provider;
  }

  /** The provider this chat is pinned to, which a turn cannot proceed without. */
  private async pinnedProvider(chat: Chat): Promise<Provider> {
    const provider = (await this.providers.list()).find(
      (candidate) => candidate.id === chat.providerId,
    );
    if (!provider) {
      throw new ValidationError(
        `this chat is pinned to provider '${chat.providerId}', which is no longer configured — pick another model to carry on`,
      );
    }
    if (!provider.enabled) {
      throw new ValidationError(
        `this chat is pinned to '${provider.label}', which is disabled — enable it or pick another model`,
      );
    }
    assertModel(provider, chat.model);
    return provider;
  }

  /**
   * Put a chat event on the bus.
   *
   * These events are not durable: chat runs in the process the browser is talking to, so the
   * in-memory bus already reaches it. Writing every assistant chunk into `.pomni/events.ndjson`
   * would duplicate the transcript into the event log for no reader.
   */
  private announce(event: ChatEvent): void {
    this.events.emit(event);
  }
}

function actionIn(message: ChatMessage, actionId: string): ProposedAction {
  const action = message.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new NotFoundError('action', actionId);
  return action;
}

/** The chat's pinned model has to be one the provider actually defines. */
function assertModel(provider: Provider, model: string): void {
  const offered = Object.values(provider.models).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  if (!offered.includes(model)) {
    throw new ValidationError(
      offered.length === 0
        ? `provider '${provider.id}' has no models mapped — map at least one on the Providers page`
        : `provider '${provider.id}' does not offer '${model}' — it offers: ${[
            ...new Set(offered),
          ].join(', ')}`,
      { providerId: provider.id, model },
    );
  }
}

/**
 * An action that started a run says so by returning something carrying a `runId`. Read here
 * rather than listed per action, so adding a run-starting action needs nothing in this file.
 */
function runIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : null;
}

function encode(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    // A service returning something cyclic is still a service that succeeded.
    return JSON.stringify(String(value));
  }
}

/** What one action did, written for the model. Null while it has not done anything yet. */
function renderOutcome(action: ProposedAction): string | null {
  if (action.status === 'executed') {
    const result = action.result ?? 'null';
    const body =
      result.length > MAX_RESULT_CHARS
        ? `${result.slice(0, MAX_RESULT_CHARS)}… (truncated; narrow the arguments if you need the rest)`
        : result;
    return `- \`${action.name}\` returned: ${body}`;
  }
  if (action.status === 'failed') return `- \`${action.name}\` failed: ${action.error}`;
  if (action.status === 'rejected') {
    return `- \`${action.name}\` was declined by the person. Do not propose it again unless they ask.`;
  }
  if (action.status === 'proposed') {
    return `- \`${action.name}\` is still waiting for the person to confirm it.`;
  }
  return null;
}
