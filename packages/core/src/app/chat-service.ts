import {
  parseAddresses,
  stripAddresses,
  type MessageAddress,
  type ParsedAddress,
  type ParsedMessage,
} from '../domain/address.js';
import type { Agent } from '../domain/agent.js';
import {
  ChatMessageSchema,
  ChatSchema,
  MAX_EXPANSION_ROUNDS,
  assertExecutable,
  assertTransition,
  deriveChatTitle,
  isChatActionGroup,
  openGroup,
  initialStatus,
  needsConfirmation,
  rollUpUsage,
  type Chat,
  type ChatDetail,
  type ChatFilter,
  type ChatActionGroup,
  type ChatMessage,
  type ProposedAction,
} from '../domain/chat.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { resolveModel, type Provider } from '../domain/provider.js';
import { ulid } from '../domain/ulid.js';
import { findAgent } from '../domain/workflow.js';
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
  actionKey,
  describeAction,
  findAction,
  parseActionArgs,
  parseActionCalls,
  type ChatActionCall,
  type ChatActionServices,
} from './chat-actions.js';
import type { BacklogService } from './backlog-service.js';
import type { CommentService } from './comment-service.js';
import type { CredentialService } from './credential-service.js';
import type { DoctorService } from './doctor-service.js';
import type { WorktreeService } from './worktree-service.js';
import type { DiscoveryService } from './discovery-service.js';
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
 * The first thing a person types, which is also the thing that creates the chat.
 *
 * Provider and model are optional because the whole point is that nobody was asked. When they
 * are given it is because the composer offered a change before the first send, not because a
 * dialog demanded one.
 */
export interface FirstMessageInput {
  text: string;
  providerId?: string;
  model?: string;
}

/** Re-pinning a chat. Both halves move together: a model belongs to the provider offering it. */
export interface ModelChoice {
  providerId: string;
  model: string;
}

/** What the composer offers on `#`, `@` and `/`. Everything here actually exists. */
export interface Addressables {
  projects: Array<{ id: string; name: string }>;
  agents: Array<{
    workflowId: string;
    workflowName: string;
    agentId: string;
    agentName: string;
  }>;
  skills: Array<{ name: string; description?: string }>;
}

/**
 * What the addresses in one message turned out to mean.
 *
 * `notes` is the whole reason this is not a throw. A candidate that names nothing was never
 * an address — `#include <stdio.h>` is the parser's own example — so the message still sends,
 * the candidate stays in the prose where the person put it, and the reply says what does
 * exist. Only `accepted` is stripped, and only `accepted` is recorded.
 */
interface ResolvedAddresses {
  /** The project in force for this turn: the addressed one, else the chat's standing one. */
  projectId: string | null;
  agent: { workflowId: string; agent: Agent } | null;
  skill: { name: string; body: string } | null;
  accepted: ParsedAddress[];
  notes: string[];
}

/** One reply, and who produced it. Both paths return this so the transcript records the same. */
interface Turn {
  text: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
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
    private readonly discovery: DiscoveryService,
    // POMN-68: the rest of Pomni, so chat can reach every verb the CLI has. Appended rather
    // than woven in, so a caller that has not grown these yet still passes the earlier ones
    // in the order it always did.
    private readonly credentials: CredentialService,
    private readonly doctor: DoctorService,
    private readonly comments: CommentService,
    private readonly worktrees: WorktreeService,
  ) {
    this.services = {
      projects: this.projects,
      repos: this.repos,
      backlog: this.backlog,
      workflows: this.workflows,
      tools: this.tools,
      runs: this.runs,
      pipelines: this.pipelines,
      credentials: this.credentials,
      providers: this.providers,
      worktrees: this.worktrees,
      discovery: this.discovery,
      doctor: this.doctor,
      comments: this.comments,
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

  /**
   * The way a chat actually begins: someone typed something and pressed send.
   *
   * Nobody is asked for a provider, a model or a title, because every one of those has a
   * reasonable default and none of them is what the person came here to do. The default
   * provider's medium model is used, and the header can change it afterwards.
   *
   * The provider is resolved *before* the row is written. A chat whose `model` is empty is not
   * a chat anybody can carry on, so it must not be storable — which is why `providerId` and
   * `model` stayed non-nullable when 'no dialog' arrived.
   */
  async createFromFirstMessage(input: FirstMessageInput): Promise<ChatDetail> {
    const body = input.text.trim();
    if (!body) throw new ValidationError('a message needs some words in it');

    const provider = input.providerId
      ? await this.enabledProvider(input.providerId)
      : await this.providers.resolve();
    const model = input.model ?? resolveModel(provider, 'medium');

    const chat = await this.create({ providerId: provider.id, model });

    // The row exists before the turn can run, so a turn that throws — the provider being down,
    // or a refusal like an agent this project may not address — would otherwise leave an empty
    // untitled chat in the list, and one more for every retry. The error is the answer; the
    // chat is not, so it goes and the error carries on to the caller unchanged.
    try {
      await this.sendMessage(chat.id, body);
    } catch (error) {
      try {
        await this.store.deleteChat(chat.id);
        this.announce({ type: 'chat.removed', chatId: chat.id });
      } catch (cleanup) {
        // Reported, never rethrown: the failure worth telling the caller about is the first one.
        this.logger.debug('could not remove the chat a first message failed in', cleanup);
      }
      throw error;
    }

    // After the reply, and never in front of it. A title nobody is waiting for is worth one
    // cheap completion; a title the answer waits on is worth nothing.
    void this.nameChat(chat.id, body, provider);

    return this.get(chat.id);
  }

  /**
   * Name a chat by hand.
   *
   * Settles the title as well as changing it: a generation still in flight checks
   * `titleGeneratedAt` before it writes, so the person's name wins whichever lands last.
   */
  async rename(chatId: string, title: string): Promise<Chat> {
    const chat = await this.require(chatId);
    if (!title.trim()) throw new ValidationError('a chat needs a name — or leave the one it has');

    const next = ChatSchema.parse({
      ...chat,
      // Same shaping a derived title gets: one line, collapsed, and short enough for the list.
      title: deriveChatTitle(title),
      titleGeneratedAt: this.clock.iso(),
    });
    await this.store.updateChat(next);
    this.announce({ type: 'chat.changed', chatId });
    return next;
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
   *
   * The provider moves with the model because the two are one choice: a model id means nothing
   * apart from the provider that offers it, and the header shows both.
   */
  async setModel(id: string, choice: ModelChoice): Promise<Chat>;
  /** @deprecated Pass a `ModelChoice`. Kept so existing call sites keep compiling. */
  async setModel(id: string, providerId: string, model: string): Promise<Chat>;
  async setModel(id: string, choice: ModelChoice | string, legacyModel?: string): Promise<Chat> {
    const { providerId, model } =
      typeof choice === 'string' ? { providerId: choice, model: legacyModel ?? '' } : choice;

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

    const parsed = parseAddresses(body);
    const addressed = await this.resolveAddresses(chat, parsed);
    // Only what resolved. A `#include` that named no project stays where the person put it,
    // because deleting it would change the question they asked.
    const asked = stripAddresses(body, addressed.accepted) || body;

    await this.store.appendMessage(
      ChatMessageSchema.parse({
        id: ulid(this.clock.now().getTime()),
        chatId: id,
        // Stored as typed, chips and all: the transcript should read as what was sent, and
        // `forModel` takes the addresses back out on the way to the provider.
        role: 'user',
        text: body,
        projectId: addressed.projectId,
        addresses: addressed.accepted.map(toMessageAddress),
        createdAt: now,
      }),
    );

    // Named once, from the first thing the person said. A later message never renames it,
    // and `nameChat` replaces this with something better if the generation lands.
    let current = ChatSchema.parse({
      ...chat,
      title: chat.title || deriveChatTitle(asked),
      // `#project` holds until changed; that is what makes it context rather than a filter.
      projectId: addressed.projectId,
      updatedAt: now,
    });
    await this.store.updateChat(current);
    this.announce({ type: 'chat.changed', chatId: id });

    let answer = addressed.agent
      ? // One agent, its own prompt, its own tools, no delegation. Deliberately not the chat's
        // pinned model: an agent says what struggle its work deserves, and honouring the
        // header here would run it on something it never asked for.
        await this.askAgent(chat, addressed, asked)
      : await this.askPomni(current, provider, addressed);

    let reply = parseActionCalls(answer.text);

    // Reading the catalogue is not answering. A turn whose whole reply is `actions.expand`
    // has told the person nothing, so the groups are opened and the model is asked again —
    // bounded, because each round is another model call and another spinner.
    for (let round = 0; !addressed.agent && round < MAX_EXPANSION_ROUNDS; round += 1) {
      const groups = onlyExpansions(reply.calls);
      if (groups === null) break;

      let opened = current.openedGroups;
      for (const group of groups) opened = openGroup(opened, group);
      current = ChatSchema.parse({ ...current, openedGroups: opened, updatedAt: this.clock.iso() });
      await this.store.updateChat(current);

      answer = await this.askPomni(current, provider, addressed);
      reply = parseActionCalls(answer.text);
    }

    const { prose, calls } = reply;
    const messageId = ulid(this.clock.now().getTime());
    // Every turn, addressed or not. An agent's answer will rarely contain an action block,
    // but a turn that could skip the confirmation because of how it was addressed would be a
    // way round the one gap this service exists to keep open.
    const { actions, rejected } = this.plan(calls, await this.declinedKeys(id));

    const message = ChatMessageSchema.parse({
      id: messageId,
      chatId: id,
      role: 'assistant',
      // A reply that was nothing but a block has no prose, and rendering the raw json at the
      // person would be showing them the plumbing. The action cards are the message.
      text: [
        ...addressed.notes.map((note) => `_${note}_`),
        prose || (calls.length > 0 ? '' : answer.text),
        ...rejected,
      ]
        .filter((line) => line.length > 0)
        .join('\n\n'),
      providerId: answer.providerId,
      model: answer.model,
      projectId: addressed.projectId,
      actions,
      createdAt: this.clock.iso(),
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      // Nothing in this repo converts tokens to money, and inventing a price would report a
      // number nobody could check. Null means "the provider did not say", not "free".
      costUsd: answer.costUsd,
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

  /**
   * What the composer may offer on `#`, `@` and `/`.
   *
   * Every list is the same one the resolver reads, so what autocomplete shows and what an
   * address resolves against cannot disagree. Agents and skills are per-project because that
   * is where the authority is: the agents of the workflows attached to the addressed project,
   * and the skills checked into that project's own repos.
   */
  async addressables(projectId: string | null): Promise<Addressables> {
    const projects = (await this.projects.list()).map((project) => ({
      id: project.id,
      name: project.name,
    }));

    if (!projectId) return { projects, agents: [], skills: [] };

    const workflows = await this.workflows.forProject(projectId);
    const agents = workflows.flatMap((workflow) =>
      workflow.agents.map((agent) => ({
        workflowId: workflow.id,
        workflowName: workflow.name,
        agentId: agent.id,
        agentName: agent.name,
      })),
    );

    const scan = await this.discovery.scan(projectId);
    const skills = scan.assets
      .filter((asset) => asset.kind === 'skill')
      .map((asset) => ({ name: asset.id, description: asset.description }));

    return { projects, agents, skills };
  }

  // -------------------------------------------------------------------------

  /** A turn, whoever took it. The chat records who answered, so both paths report it. */
  private async askPomni(
    chat: Chat,
    provider: Provider,
    addressed: ResolvedAddresses,
  ): Promise<Turn> {
    const history = this.history(await this.store.listMessages(chat.id));
    const { port } = await this.providers.portFor('medium', { provider: chat.providerId });

    const result = await port.complete({
      model: chat.model,
      system: this.systemPrompt(addressed, chat.openedGroups),
      messages: history,
      // Claude Code drives its own thinking; the flag is for the direct API path.
      adaptiveThinking: provider.kind !== 'claude-code',
      effort: 'medium',
      maxTokens: 8000,
    });

    return {
      text: result.text,
      providerId: chat.providerId,
      model: chat.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: null,
    };
  }

  /**
   * Put the message to one agent instead of to Pomni.
   *
   * One session, its own tools, no delegation — `runOneAgent` is where that is guaranteed.
   * The chat's provider carries over so the header still governs what this costs, but the
   * model does not: an agent declares what struggle its work deserves, and running it on
   * whatever the header happened to say would be giving it a model it never asked for.
   */
  private async askAgent(
    chat: Chat,
    addressed: ResolvedAddresses,
    task: string,
  ): Promise<Turn> {
    const target = addressed.agent;
    if (!target || !addressed.projectId) {
      throw new ValidationError('an agent can only be addressed inside a project');
    }

    const result = await this.pipelines.runOneAgent({
      projectId: addressed.projectId,
      workflowId: target.workflowId,
      agentId: target.agent.id,
      task,
      skillPrompt: addressed.skill?.body,
      providerId: chat.providerId,
    });

    return {
      // Said out loud: an answer from one agent reads differently from Pomni's own, and a
      // transcript that does not say which is which invites the reader to trust the wrong one.
      text: [`**${target.agent.name}** (\`${result.workflowId}/${target.agent.id}\`):`, '', result.text].join(
        '\n',
      ),
      providerId: result.providerId,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
    };
  }

  /**
   * Turn the candidates in a message into the things they name.
   *
   * Resolution is where knowledge of what exists lives, and it answers rather than refuses:
   * an address that names nothing leaves the text alone and adds a line saying what does
   * exist. The single exception is an agent that is real and is not this project's to run —
   * that is a permission answer, and a note dressed as a suggestion would read as though the
   * chat simply had not found it.
   */
  private async resolveAddresses(
    chat: Chat,
    parsed: ParsedMessage,
  ): Promise<ResolvedAddresses> {
    const accepted: ParsedAddress[] = [];
    const notes: string[] = [];

    for (const conflict of parsed.conflicts) {
      notes.push(
        `A message is about one project, so I took ${conflict.kept.raw} and left ${conflict.dropped
          .map((entry) => entry.raw)
          .join(', ')} in the text.`,
      );
    }

    let projectId = chat.projectId;
    if (parsed.project) {
      const projects = await this.projects.list();
      const match = projects.find((project) => project.id === parsed.project?.name);
      if (match) {
        projectId = match.id;
        accepted.push(parsed.project);
      } else {
        notes.push(
          `There is no project '${parsed.project.name}'. ${suggest(
            projects.map((project) => project.id),
            parsed.project.name,
            'Projects here',
            'There are no projects yet',
          )}`,
        );
      }
    }

    let agent: ResolvedAddresses['agent'] = null;
    for (const candidate of parsed.agents) {
      if (agent) {
        notes.push(
          `One message runs one agent, so ${candidate.raw} was left in the text. Ask it in its own message.`,
        );
        continue;
      }
      if (!projectId) {
        notes.push(
          `${candidate.raw} needs a project — say #project in the same message, and I will put it to that project's agents.`,
        );
        continue;
      }

      const outcome = await this.resolveAgent(projectId, candidate);
      if (!outcome.agent) {
        notes.push(outcome.note);
        continue;
      }
      agent = outcome.agent;
      accepted.push(candidate);
    }

    let skill: ResolvedAddresses['skill'] = null;
    if (parsed.skills.length > 0) {
      // Scanned once even when the message is full of slashes: a URL in a question would
      // otherwise cost one filesystem walk per segment.
      const available = projectId
        ? (await this.discovery.scan(projectId)).assets.filter((asset) => asset.kind === 'skill')
        : [];

      for (const candidate of parsed.skills) {
        if (skill) continue;
        if (!projectId) {
          notes.push(
            `${candidate.raw} needs a project — a skill is checked into a project's own repos, so say #project too.`,
          );
          continue;
        }

        const match = available.find((asset) => asset.id === candidate.name);
        if (!match) {
          notes.push(
            `There is no skill '${candidate.name}' in '${projectId}'. ${suggest(
              available.map((asset) => asset.id),
              candidate.name,
              'Its repos have',
              'Its repos have no .claude/skills',
            )}`,
          );
          continue;
        }
        skill = { name: match.id, body: match.body };
        accepted.push(candidate);
      }
    }

    return { projectId, agent, skill, accepted, notes };
  }

  /**
   * Which agent `@name` or `@workflow/name` means, in the project that is in force.
   *
   * Authority comes from the project, never from the address. An agent is addressable here
   * only through a workflow this project has attached — the same rule a task run obeys — so
   * naming a workflow in the address narrows the search and can never widen it.
   */
  private async resolveAgent(
    projectId: string,
    address: ParsedAddress,
  ): Promise<
    | { agent: { workflowId: string; agent: Agent }; note?: undefined }
    | { agent?: undefined; note: string }
  > {
    const attached = await this.workflows.forProject(projectId);
    const searched = address.workflowId
      ? attached.filter((workflow) => workflow.id === address.workflowId)
      : attached;

    for (const workflow of searched) {
      const found = findAgent(workflow, address.name);
      if (found) return { agent: { workflowId: workflow.id, agent: found } };
    }

    const available = attached.flatMap((workflow) =>
      workflow.agents.map((entry) => `@${workflow.id}/${entry.id}`),
    );
    const here =
      available.length > 0
        ? `Here you can address: ${available.join(', ')}.`
        : `No workflow attached to '${projectId}' has any agents yet.`;

    // The refusal the acceptance criteria ask for, and the only one. The agent exists; it is
    // not this project's to run, and saying "no such agent" would be untrue as well as
    // unhelpful — the person would go looking for a typo that is not there.
    const elsewhere = (await this.workflows.list()).find(
      (workflow) =>
        !attached.some((candidate) => candidate.id === workflow.id) &&
        findAgent(workflow, address.name) !== null,
    );
    if (elsewhere) {
      throw new ValidationError(
        `'${address.name}' is in the workflow '${elsewhere.name}', which is not attached to ` +
          `'${projectId}' — an agent only runs in a project whose workflow contains it. ${here}`,
        { projectId, agentId: address.name, workflowId: elsewhere.id },
      );
    }

    return { note: `There is no agent '${address.name}' in '${projectId}'. ${here}` };
  }

  /**
   * Name the chat from what was actually said, on the cheapest model the provider has.
   *
   * Never on the request path: this is started after the reply is committed and its result is
   * written only if nothing has settled the title in the meantime. A failure is not retried —
   * it falls back to the first line of the first message, which is what the person would have
   * called it anyway, and settles that.
   */
  private async nameChat(chatId: string, firstMessage: string, provider: Provider): Promise<void> {
    let generated = '';

    try {
      const { port, model } = await this.providers.portFor('low', { provider: provider.id });
      const result = await port.complete({
        model,
        system:
          'Give this conversation a title: at most eight words, no quotes, no full stop, ' +
          'naming the subject rather than describing the message. Reply with the title alone.',
        messages: [{ role: 'user', content: firstMessage.slice(0, 2000) }],
        adaptiveThinking: false,
        effort: 'low',
        maxTokens: 64,
      });
      generated = deriveChatTitle(result.text.replace(/^["'`]|["'`]$/g, ''));
    } catch (error) {
      this.logger.debug('could not generate a chat title', error);
    }

    try {
      // Two fields, and only those two. A read-modify-write here would take a copy of the chat
      // from before this completion started and put it back afterwards — reverting whatever
      // turn landed in between, including its `updatedAt`, the project a `#project` set on it
      // and its token totals. `settleTitle` also makes the `titleGeneratedAt` guard real: the
      // check is in the same statement as the write, so a hand rename cannot be clobbered by a
      // generation that read the row before it.
      //
      // `updatedAt` is deliberately untouched — naming a chat is not a turn in it, and bumping
      // it would reorder the list under someone reading it.
      const settled = await this.store.settleTitle(
        chatId,
        // Set either way: the fallback is a settled title, not a standing invitation to try
        // again on the next turn.
        generated || deriveChatTitle(firstMessage),
        this.clock.iso(),
      );
      // False means a rename or another generation got there first, and it won.
      if (settled) this.announce({ type: 'chat.changed', chatId });
    } catch (error) {
      this.logger.debug('could not store the generated chat title', error);
    }
  }

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
  /**
   * Every proposal the person has already declined in this chat.
   *
   * Read from the transcript rather than held in memory: the rule has to survive a restart,
   * and the transcript is the only record of what a person actually said no to.
   */
  private async declinedKeys(chatId: string): Promise<Set<string>> {
    const messages = await this.store.listMessages(chatId);
    const keys = new Set<string>();
    for (const message of messages) {
      for (const action of message.actions) {
        if (action.status === 'rejected') keys.add(actionKey(action.name, action.args));
      }
    }
    return keys;
  }

  private plan(
    calls: ChatActionCall[],
    declined: Set<string> = new Set(),
  ): { actions: ProposedAction[]; rejected: string[] } {
    const actions: ProposedAction[] = [];
    const rejected: string[] = [];

    for (const call of calls) {
      try {
        const entry = findAction(call.name);
        parseActionArgs(entry, call.args);

        // Declined stays declined until the person says otherwise. The model can override
        // this, but only by saying it means to — see `again` on the call.
        if (!call.again && declined.has(actionKey(entry.name, call.args))) {
          rejected.push(
            `_You declined this earlier, so Pomni did not re-propose it: ${describeAction(
              entry,
              call.args,
            )}. Ask again and it will._`,
          );
          continue;
        }

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
        turns.push({ role: 'user', content: forModel(message) });
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

  private systemPrompt(addressed: ResolvedAddresses, opened: ChatActionGroup[] = []): string {
    const base = [
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
      ...(addressed.projectId
        ? [
            '',
            `This conversation is about the project '${addressed.projectId}'. Unless the person`,
            'names another, that is the project every backlog item, repo and workflow refers to,',
            'and it is what you pass as the project argument without asking which one they mean.',
          ]
        : []),
      '',
      actionBriefing(opened),
      '',
      CHAT_ACTION_PROTOCOL,
    ].join('\n');

    // A skill goes above everything: it is the frame this turn was asked for, not an extra
    // instruction added to a job description Pomni already has.
    return addressed.skill
      ? [`# Skill: ${addressed.skill.name}`, '', addressed.skill.body, '', '---', '', base].join(
          '\n',
        )
      : base;
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

/** The stored form of an address: what it aimed at, without the offsets of one draft. */
function toMessageAddress(address: ParsedAddress): MessageAddress {
  return { kind: address.kind, name: address.name, workflowId: address.workflowId };
}

/**
 * A stored message as the model should read it, with its chips taken back out.
 *
 * The offsets died with the draft, so the text is parsed again and only the candidates that
 * match what was actually recorded are removed. An unresolved `#include` was never an address
 * and is not one now, however many projects have been created since.
 */
function forModel(message: ChatMessage): string {
  if (message.addresses.length === 0) return message.text;

  const resolved = parseAddresses(message.text).addresses.filter((candidate) =>
    message.addresses.some(
      (recorded) =>
        recorded.kind === candidate.kind &&
        recorded.name === candidate.name &&
        recorded.workflowId === candidate.workflowId,
    ),
  );
  return stripAddresses(message.text, resolved) || message.text;
}

/**
 * What exists, when what was typed does not.
 *
 * Near matches first — a typo is the common case and the person can see their own word in the
 * answer — then the whole list, capped. An empty list gets its own sentence, because "Projects
 * here: " with nothing after it reads like a bug.
 */
function suggest(available: string[], typed: string, lead: string, empty: string): string {
  if (available.length === 0) return `${empty}.`;

  const near = available.filter(
    (entry) => entry.startsWith(typed) || typed.startsWith(entry) || entry.includes(typed),
  );
  const shown = (near.length > 0 ? near : available).slice(0, 12);
  return `${lead}: ${shown.join(', ')}${
    shown.length < (near.length > 0 ? near.length : available.length) ? ', …' : ''
  }.`;
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

/**
 * The groups a reply asked to open, when opening groups is *all* it asked for.
 *
 * Null when the reply did anything else — proposed a real action, or said nothing at all —
 * because then the turn has content and must not be spent on another model call.
 */
function onlyExpansions(calls: ChatActionCall[]): ChatActionGroup[] | null {
  if (calls.length === 0) return null;
  const groups: ChatActionGroup[] = [];
  for (const call of calls) {
    if (call.name !== 'actions.expand') return null;
    const group = (call.args as { group?: unknown }).group;
    if (!isChatActionGroup(group)) return null;
    groups.push(group);
  }
  return groups;
}
