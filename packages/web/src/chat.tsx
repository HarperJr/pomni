import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type ActionStatus,
  type ChatMessage,
  type ModelMap,
  type ProposedAction,
  type ProviderStatus,
} from './api';
import { Alert, errorMessage } from './components';
import { Markdown } from './markdown';
import { useLanguage } from './i18n';

// ---------------------------------------------------------------------------
// Conversation list + shell
// ---------------------------------------------------------------------------

export function ChatPage({
  chatId: chosen,
  onChoose,
}: {
  /** Set when the chat is shown as an overlay; otherwise the route decides. */
  chatId?: string;
  onChoose?: (chatId: string) => void;
} = {}) {
  const { t } = useLanguage();
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const routed = chosen === undefined;
  const chatId = routed ? (params.chatId ?? '') : chosen;
  const choose = (id: string) => (routed ? navigate(id ? `/chat/${id}` : '/chat') : onChoose?.(id));

  const chats = useQuery({
    queryKey: ['chats'],
    queryFn: () => api.listChats().then((result) => result.chats),
  });

  const llmStatus = useQuery({
    queryKey: ['llm-status'],
    queryFn: () => api.llmStatus(),
  });

  const usable = usableProviders(llmStatus.data?.providers ?? []);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChat(id),
    onSuccess: async (_result, id) => {
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      if (id === chatId) choose('');
    },
  });

  const sorted = [...(chats.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <>
      <div className="page-head">
        {routed && <h1>{t('chat.title')}</h1>}
        <div className="spacer" />
        <button className="primary" onClick={() => choose('')}>
          {t('chat.new')}
        </button>
      </div>

      {chats.isError && <Alert kind="error">{errorMessage(chats.error)}</Alert>}

      <div className="chat-layout">
        <div className="card chat-list">
          {sorted.length === 0 ? (
            <div className="empty">{t('chat.empty')}</div>
          ) : (
            sorted.map((chat) => (
              <div
                className={`row chat-list-row${chat.id === chatId ? ' selected' : ''}`}
                key={chat.id}
              >
                {routed ? (
                  <Link className="grow truncate" to={`/chat/${chat.id}`}>
                    {chat.title || t('chat.untitled')}
                  </Link>
                ) : (
                  <button className="grow truncate link" onClick={() => choose(chat.id)}>
                    {chat.title || t('chat.untitled')}
                  </button>
                )}
                <button
                  className="ghost danger"
                  onClick={() => {
                    if (confirm(t('chat.confirmDelete', { title: chat.title || t('chat.untitled') }))) {
                      remove.mutate(chat.id);
                    }
                  }}
                >
                  {t('chat.delete')}
                </button>
              </div>
            ))
          )}
        </div>

        <div className="chat-detail">
          {chatId ? (
            <ChatThread chatId={chatId} providers={usable} />
          ) : (
            <ChatDraft
              providers={usable}
              defaultModel={llmStatus.data?.defaultModel ?? null}
              onCreated={(id) => choose(id)}
            />
          )}
        </div>
      </div>
    </>
  );
}

function usableProviders(providers: ProviderStatus[]): ProviderStatus[] {
  return providers.filter((provider) => provider.enabled && provider.available);
}

/** The distinct, non-empty model names a provider's struggle map names. */
function distinctModels(models: ModelMap): string[] {
  return Array.from(new Set(Object.values(models).filter((model): model is string => Boolean(model))));
}

/**
 * Provider and model, always visible and always changeable — no dialog. Picking a provider
 * resets the model to that provider's first offered one, since the old model rarely still
 * applies.
 */
function ModelPicker({
  providers,
  providerId,
  model,
  onChange,
}: {
  providers: ProviderStatus[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
}) {
  const { t } = useLanguage();
  const provider = providers.find((entry) => entry.id === providerId);

  const live = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => api.providerModels(providerId).then((result) => result.models),
    enabled: Boolean(providerId) && provider?.kind === 'openai' && Boolean(provider?.baseUrl),
    retry: false,
  });

  const options = live.data && live.data.length > 0 ? live.data : distinctModels(provider?.models ?? {});

  return (
    <div className="chat-model-picker">
      <select
        value={providerId}
        onChange={(event) => {
          const nextProviderId = event.target.value;
          const nextOptions = distinctModels(
            providers.find((entry) => entry.id === nextProviderId)?.models ?? {},
          );
          onChange(nextProviderId, nextOptions[0] ?? '');
        }}
      >
        <option value="">{t('chat.pickProvider')}</option>
        {providers.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <select value={model} onChange={(event) => onChange(providerId, event.target.value)} disabled={!providerId}>
        <option value="">{t('chat.pickModel')}</option>
        {options.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A chat that does not exist yet
// ---------------------------------------------------------------------------

/**
 * The empty conversation opening chat gives you: no dialog, no title, no model choice — just
 * the composer, pre-filled with the default provider's medium model, changeable before or
 * after the first word is typed. The first send is what creates the chat.
 */
function ChatDraft({
  providers,
  defaultModel,
  onCreated,
}: {
  providers: ProviderStatus[];
  defaultModel: { providerId: string; model: string } | null;
  onCreated: (id: string) => void;
}) {
  const { t } = useLanguage();
  const [providerId, setProviderId] = useState(defaultModel?.providerId ?? '');
  const [model, setModel] = useState(defaultModel?.model ?? '');
  // Whether the header's picker has been touched — while it hasn't, the server's own default is
  // what actually runs, so the request omits providerId/model rather than send back a guess.
  const [touched, setTouched] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // The default resolves once the status query lands; adopt it if nothing has been picked.
  useEffect(() => {
    if (!touched && !providerId && defaultModel) {
      setProviderId(defaultModel.providerId);
      setModel(defaultModel.model);
    }
  }, [defaultModel?.providerId, defaultModel?.model, providerId, touched]);

  const create = useMutation({
    mutationFn: () =>
      api.startChat(touched ? { text, providerId: providerId || undefined, model: model || undefined } : { text }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      onCreated(result.chat.id);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <>
      <div className="card chat-header">
        <div className="grow">
          <strong>{t('chat.new')}</strong>
          <div className="dim mono">{t('chat.startIt')}</div>
        </div>
        {providers.length > 0 && (
          <div className="chat-model-block">
            <ModelPicker
              providers={providers}
              providerId={providerId}
              model={model}
              onChange={(nextProvider, nextModel) => {
                setTouched(true);
                setProviderId(nextProvider);
                setModel(nextModel);
              }}
            />
            <span className="chat-hint">{t('chat.nextTurn')}</span>
          </div>
        )}
      </div>

      <div className="card chat-composer">
        <Alert kind="error">{error}</Alert>
        {providers.length === 0 ? (
          <div className="empty">
            No enabled, available provider is configured — add one on the Providers page first.
          </div>
        ) : (
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => providerId && model && create.mutate()}
            disabled={create.isPending || !providerId || !model}
            placeholder={t('chat.placeholder')}
            projectId={null}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

function ChatThread({ chatId, providers }: { chatId: string; providers: ProviderStatus[] }) {
  const { t } = useLanguage();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  const chat = useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => api.getChat(chatId).then((result) => result.chat),
  });

  const send = useMutation({
    mutationFn: (value: string) => api.sendChatMessage(chatId, value),
    onSuccess: async () => {
      setText('');
      await queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const setModel = useMutation({
    mutationFn: (body: { providerId: string; model: string }) => api.setChatModel(chatId, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.data?.messages.length]);

  // The backstop poll stays off on purpose: `chat.changed`, `chat.action.*` and
  // `chat.turn.finished` on the shared bus are what make a reply, a running action or a model
  // change show up without a manual refetch. A missed frame just waits for the next one.
  useEffect(() => {
    const source = new EventSource('/api/events');
    const onEvent = (event: MessageEvent<string>) => {
      let data: { chatId?: string };
      try {
        data = JSON.parse(event.data) as { chatId?: string };
      } catch {
        return;
      }
      if (data.chatId !== chatId) return;
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    };

    for (const type of [
      'chat.changed',
      'chat.message.chunk',
      'chat.action.started',
      'chat.action.finished',
      'chat.turn.finished',
    ]) {
      source.addEventListener(type, onEvent as EventListener);
    }

    return () => source.close();
  }, [chatId, queryClient]);

  if (chat.isError) return <Alert kind="error">{errorMessage(chat.error)}</Alert>;
  if (!chat.data) return <div className="dim">{t('common.loading')}</div>;

  const data = chat.data;
  const messages = data.messages;
  // In flight from the moment a message is sent until the assistant's reply is persisted —
  // `chat.turn.finished` is what makes that reply show up here, via the shared event stream.
  const turnPending = send.isPending || messages[messages.length - 1]?.role === 'user';

  return (
    <>
      <div className="card chat-header">
        <div className="grow">
          <ChatTitle chatId={chatId} title={data.title} />
          <div className="dim mono">
            {data.projectId ? `about #${data.projectId} — until changed` : 'no project addressed yet'}
            {!data.providerAvailable && ' · provider unavailable'}
          </div>
        </div>
        <span className="dim mono">
          {data.inputTokens + data.outputTokens} tokens ·{' '}
          {data.costUsd !== null ? `$${data.costUsd.toFixed(3)}` : 'cost unknown'}
        </span>
        <div className="chat-model-block">
          <ModelPicker
            providers={providers}
            providerId={data.providerId}
            model={data.model}
            onChange={(providerId, model) => {
              if (providerId && model) setModel.mutate({ providerId, model });
            }}
          />
          <span className="chat-hint">{t('chat.nextTurn')}</span>
        </div>
      </div>

      <div className="card chat-thread">
        {messages.length === 0 && <div className="empty">{t('chat.saySomething')}</div>}

        {messages.map((message) => (
          <MessageRow key={message.id} chatId={chatId} message={message} providers={providers} />
        ))}

        {turnPending && (
          <div className="chat-system">
            <span className="dot spin" style={{ background: 'var(--warn)' }} />
            thinking…
          </div>
        )}

        <div ref={bottom} />
      </div>

      <div className="card chat-composer">
        <Alert kind="error">{error}</Alert>

        {!data.providerAvailable ? (
          <div className="empty">
            {data.providerLabel} is no longer configured. Pick another provider and model above
            to keep talking — the transcript is unaffected.
          </div>
        ) : (
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => send.mutate(text)}
            disabled={turnPending}
            placeholder={t('chat.placeholder')}
            projectId={data.projectId}
          />
        )}
      </div>
    </>
  );
}

/** The chat's title, renamed in place — click it, type, Enter or blur to save, Escape to cancel. */
function ChatTitle({ chatId, title }: { chatId: string; title: string }) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const rename = useMutation({
    mutationFn: (value: string) => api.renameChat(chatId, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });

  if (editing) {
    return (
      <input
        className="chat-title-input"
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = draft.trim();
          if (next && next !== title) rename.mutate(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(title);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="link chat-title"
      title={t('chat.rename')}
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
    >
      {title || t('chat.untitled')}
    </button>
  );
}

function MessageRow({
  chatId,
  message,
  providers,
}: {
  chatId: string;
  message: ChatMessage;
  providers: ProviderStatus[];
}) {
  const { t } = useLanguage();

  if (message.role === 'system') {
    return <div className="chat-system">{message.text}</div>;
  }

  const providerLabel = providers.find((entry) => entry.id === message.providerId)?.label ?? message.providerId;

  return (
    <div className={`chat-message chat-message-${message.role}`}>
      <div className="chat-message-head">
        <strong>{t(message.role === 'user' ? 'chat.you' : 'chat.assistant')}</strong>
        {message.role === 'assistant' && message.model && (
          <span className="tag">{providerLabel ? `${providerLabel} · ${message.model}` : message.model}</span>
        )}
        <span className="dim mono">{time(message.createdAt)}</span>
      </div>

      {message.addresses.length > 0 && (
        <div className="chips address-chips">
          {message.addresses.map((address, index) => (
            <span key={index} className="chip address-chip">
              <span className="mono">
                {ADDRESS_SIGILS[address.kind]}
                {address.workflowId ? `${address.workflowId}/${address.name}` : address.name}
              </span>
            </span>
          ))}
        </div>
      )}

      {message.text && <Markdown className="chat-message-text" source={message.text} />}

      {message.actions.map((action) => (
        <ActionCard key={action.id} chatId={chatId} messageId={message.id} action={action} />
      ))}
    </div>
  );
}

/**
 * One action a message proposed or already ran. A `writes` action still `proposed` is a
 * confirm prompt — loud on purpose, since nothing runs until a person presses one of its two
 * buttons. Anything else, read or already decided, is a record of what happened.
 */
function ActionCard({
  chatId,
  messageId,
  action,
}: {
  chatId: string;
  messageId: string;
  action: ProposedAction;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['chat', chatId] });

  const confirm = useMutation({
    mutationFn: () => api.confirmChatAction(chatId, messageId, action.id),
    onSuccess: invalidate,
  });

  const reject = useMutation({
    mutationFn: () => api.rejectChatAction(chatId, messageId, action.id),
    onSuccess: invalidate,
  });

  const pendingWrite = action.writes && action.status === 'proposed';

  return (
    <div className={`action-card${pendingWrite ? ' action-pending' : ''}`}>
      <div className="action-card-head">
        <span className="mono">{action.name}</span>
        {pendingWrite && <span className="tag warn">change to your workspace</span>}
        <ActionStatusBadge status={action.status} />
        {action.runId && <RunLink runId={action.runId} />}
      </div>

      <div className="action-description">{action.description}</div>

      {pendingWrite && (
        <div className="action-buttons">
          <button
            className="primary"
            onClick={() => confirm.mutate()}
            disabled={confirm.isPending || reject.isPending}
          >
            {t('chat.confirm')}
          </button>
          <button
            className="danger"
            onClick={() => reject.mutate()}
            disabled={confirm.isPending || reject.isPending}
          >
            {t('chat.reject')}
          </button>
        </div>
      )}

      {action.status === 'running' && (
        <div className="dim" style={{ marginTop: 6 }}>
          <span className="dot spin" style={{ background: 'var(--warn)' }} /> running…
        </div>
      )}
      {action.status === 'executed' && action.result && (
        <pre className="log action-result">{formatResult(action.result)}</pre>
      )}
      {action.status === 'failed' && action.error && (
        <div className="status-error" style={{ marginTop: 6, fontSize: 12 }}>
          {action.error}
        </div>
      )}
      {action.status === 'rejected' && (
        <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
          Declined — nothing ran.
        </div>
      )}
    </div>
  );
}

const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  proposed: 'proposed',
  confirmed: 'confirmed',
  rejected: 'rejected',
  running: 'running',
  executed: 'done',
  failed: 'failed',
};

function ActionStatusBadge({ status }: { status: ActionStatus }) {
  const tone =
    status === 'executed'
      ? 'ready'
      : status === 'failed' || status === 'rejected'
        ? 'error'
        : 'cloning';

  return (
    <span className={`status status-${tone}`}>
      <span className={`dot${status === 'running' ? ' spin' : ''}`} />
      {ACTION_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Resolves an action's run to the console that shows it. `PipelineRun` already carries its
 * own `projectId`, so fetching the run is all a `runId` needs to become a working link — no
 * separate lookup exists or is needed.
 */
function RunLink({ runId }: { runId: string }) {
  const run = useQuery({
    queryKey: ['pipeline', runId],
    queryFn: () => api.getPipeline(runId).then((result) => result.run),
  });

  if (!run.data) return <span className="dim mono">run {runId}</span>;

  return (
    <Link className="tag" to={`/p/${run.data.projectId}/console/${run.data.id}`}>
      view run
    </Link>
  );
}

function formatResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

function time(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Addressing: #project, @agent, /skill
//
// This mirrors `packages/core/src/domain/address.ts` — same rule, same regex, same offsets —
// but is not imported from it: the web package has no dependency on `@pomni/core` (see the
// note on `describeUnmet` in `items.tsx` for the same constraint elsewhere in this file's
// neighbourhood), so this pure parser is kept here by hand and must be kept in sync manually.
// ---------------------------------------------------------------------------

type AddressKind = 'project' | 'agent' | 'skill';

const ADDRESS_SIGILS: Record<AddressKind, string> = { project: '#', agent: '@', skill: '/' };
const KIND_BY_SIGIL: Record<string, AddressKind | undefined> = { '#': 'project', '@': 'agent', '/': 'skill' };

interface ParsedAddress {
  kind: AddressKind;
  /** The name after the sigil, lowercased. For an agent, the agent id alone. */
  name: string;
  /** `@workflow/agent` only. Null for the bare `@agent` form, and for every other kind. */
  workflowId: string | null;
  /** Exactly as typed, sigil included. What a chip labels itself with. */
  raw: string;
  start: number;
  end: number;
}

/** A second `#project` in the same message, ignored. The first wins; this says what dropped. */
interface AddressConflict {
  kind: AddressKind;
  kept: ParsedAddress;
  dropped: ParsedAddress[];
}

interface ParsedMessage {
  addresses: ParsedAddress[];
  project: ParsedAddress | null;
  agents: ParsedAddress[];
  skills: ParsedAddress[];
  conflicts: AddressConflict[];
  prose: string;
}

const CANDIDATE = /([#@/])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)((?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)/gi;
const MAX_SEGMENT = 40;

/** Find every address in a draft. Total and pure: no throw, no I/O, no knowledge of what exists. */
function parseAddresses(raw: string): ParsedMessage {
  const masked = codeRanges(raw);
  const addresses: ParsedAddress[] = [];

  CANDIDATE.lastIndex = 0;
  for (let match = CANDIDATE.exec(raw); match !== null; match = CANDIDATE.exec(raw)) {
    const start = match.index;
    const text = match[0] as string;
    const sigil = match[1] ?? '';
    const head = match[2] ?? '';
    const tail = match[3] ?? '';
    const end = start + text.length;

    // At the start of a word, and not inside code.
    if (start > 0 && !/\s/.test(raw.charAt(start - 1))) continue;
    if (masked.some((range) => start >= range.start && start < range.end)) continue;
    if (/[A-Za-z0-9_]/.test(raw.charAt(end))) continue;

    const kind = KIND_BY_SIGIL[sigil];
    if (!kind) continue;

    const segments = [head, ...(tail ? tail.slice(1).split('/') : [])].map((part) => part.toLowerCase());
    if (segments.some((part) => part.length > MAX_SEGMENT)) continue;

    const limit = kind === 'agent' ? 2 : 1;
    if (segments.length > limit) continue;
    if (kind === 'skill' && raw.charAt(end) === '.') continue;

    const [first = '', second] = segments;
    addresses.push({ kind, name: second ?? first, workflowId: second ? first : null, raw: text, start, end });
  }

  const { project, conflicts } = pickProject(addresses);

  return {
    addresses,
    project,
    agents: addresses.filter((entry) => entry.kind === 'agent'),
    skills: addresses.filter((entry) => entry.kind === 'skill'),
    conflicts,
    prose: stripAddresses(raw, addresses),
  };
}

/** First `#project` wins; repeats of the same one are not a conflict. */
function pickProject(addresses: ParsedAddress[]): { project: ParsedAddress | null; conflicts: AddressConflict[] } {
  const projects = addresses.filter((entry) => entry.kind === 'project');
  const kept = projects[0] ?? null;
  if (!kept) return { project: null, conflicts: [] };

  const dropped = projects.slice(1).filter((entry) => entry.name !== kept.name);
  return { project: kept, conflicts: dropped.length > 0 ? [{ kind: 'project', kept, dropped }] : [] };
}

function stripAddresses(raw: string, remove: ParsedAddress[]): string {
  if (remove.length === 0) return raw.trim();

  const ordered = [...remove].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const entry of ordered) {
    if (entry.start < cursor) continue;
    out += raw.slice(cursor, entry.start);
    cursor = entry.end;
  }
  out += raw.slice(cursor);

  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\n]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Range {
  start: number;
  end: number;
}

/** Spans that are code, and so hold no addresses — fenced blocks, then inline backticks. */
function codeRanges(raw: string): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  let open: { marker: string; start: number } | null = null;

  for (const line of raw.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!open && fence) {
      open = { marker: (fence[1] as string).charAt(0), start: offset };
    } else if (open && fence && (fence[1] as string).charAt(0) === open.marker) {
      ranges.push({ start: open.start, end: offset + line.length });
      open = null;
    }
    offset += line.length + 1;
  }
  if (open) ranges.push({ start: open.start, end: raw.length });

  const inline = /(`+)[\s\S]*?\1/g;
  for (let match = inline.exec(raw); match !== null; match = inline.exec(raw)) {
    const span = { start: match.index, end: match.index + match[0].length };
    const inFence = ranges.some((range) => span.start >= range.start && span.start < range.end);
    if (!inFence) ranges.push(span);
  }

  return ranges;
}

// ---------------------------------------------------------------------------
// What an address can resolve to — real projects, the agents of the workflows attached to the
// addressed project, and the skills discovered in that project's repos. `chatAddressables`
// already scopes agents and skills to the project it is given; passing `null` is what makes it
// near-empty for those two, and is also how the full project list is fetched.
// ---------------------------------------------------------------------------

interface ProjectAddress {
  id: string;
  label: string;
}

interface AgentAddress {
  workflowId: string;
  agentId: string;
  agentName: string;
  label: string;
}

interface SkillAddress {
  id: string;
  label: string;
}

function useAddressables(projectId: string | null): {
  projects: ProjectAddress[];
  agents: AgentAddress[];
  skills: SkillAddress[];
} {
  const query = useQuery({
    queryKey: ['chat-addressables', projectId],
    queryFn: () => api.chatAddressables(projectId),
  });

  const data = query.data;
  return {
    projects: (data?.projects ?? []).map((entry) => ({ id: entry.id, label: entry.name || entry.id })),
    agents: (data?.agents ?? []).map((entry) => ({
      workflowId: entry.workflowId,
      agentId: entry.agentId,
      agentName: entry.agentName,
      label: `${entry.workflowId}/${entry.agentId}`,
    })),
    skills: (data?.skills ?? []).map((entry) => ({ id: entry.name, label: entry.name })),
  };
}

type Resolved = { ok: true; label: string } | { ok: false; suggestions: string[] };

function resolveAddress(
  addr: ParsedAddress,
  projects: ProjectAddress[],
  agents: AgentAddress[],
  skills: SkillAddress[],
): Resolved {
  if (addr.kind === 'project') {
    const hit = projects.find((entry) => entry.id.toLowerCase() === addr.name);
    return hit
      ? { ok: true, label: hit.label }
      : { ok: false, suggestions: near(addr.name, projects.map((entry) => entry.id)) };
  }

  if (addr.kind === 'agent') {
    // The server resolves a bare `@agent` to the first match across the attached workflows —
    // the same first-wins rule as `#project` — so an ambiguous name must be labelled with the
    // workflow it will actually hit, not reported as unresolved.
    const candidates = addr.workflowId
      ? agents.filter(
          (entry) => entry.workflowId.toLowerCase() === addr.workflowId && entry.agentId.toLowerCase() === addr.name,
        )
      : agents.filter((entry) => entry.agentId.toLowerCase() === addr.name);
    const hit = candidates[0];
    return hit
      ? { ok: true, label: hit.label }
      : { ok: false, suggestions: near(addr.name, agents.map((entry) => entry.agentId)) };
  }

  const hit = skills.find((entry) => entry.id.toLowerCase() === addr.name);
  return hit ? { ok: true, label: hit.label } : { ok: false, suggestions: near(addr.name, skills.map((entry) => entry.id)) };
}

function near(name: string, pool: string[]): string[] {
  const lower = name.toLowerCase();
  return pool
    .filter((entry) => entry.toLowerCase().includes(lower) || lower.includes(entry.toLowerCase()))
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// The composer: addressing, chips, autocomplete
// ---------------------------------------------------------------------------

interface ActiveToken {
  kind: AddressKind;
  start: number;
  end: number;
  query: string;
}

/** The address being typed right at the caret, if any — for autocomplete, not for sending. */
function activeToken(text: string, caret: number): ActiveToken | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s\n])([#@/])([a-z0-9][a-z0-9\-/]*)?$/i.exec(before);
  if (!match) return null;

  const sigil = match[2] ?? '';
  const kind = KIND_BY_SIGIL[sigil];
  if (!kind) return null;

  const query = (match[3] ?? '').toLowerCase();
  const start = caret - (sigil.length + query.length);
  return { kind, start, end: caret, query };
}

function suggestionsFor(
  active: ActiveToken,
  projects: ProjectAddress[],
  agents: AgentAddress[],
  skills: SkillAddress[],
): Array<{ value: string; hint?: string }> {
  const query = active.query;

  if (active.kind === 'project') {
    return projects
      .filter((entry) => entry.id.toLowerCase().startsWith(query))
      .slice(0, 6)
      .map((entry) => ({ value: entry.id, hint: entry.label !== entry.id ? entry.label : undefined }));
  }

  if (active.kind === 'agent') {
    return agents
      .filter((entry) => entry.label.toLowerCase().startsWith(query) || entry.agentId.toLowerCase().startsWith(query))
      .slice(0, 6)
      .map((entry) => ({ value: entry.label, hint: entry.agentName }));
  }

  return skills
    .filter((entry) => entry.id.toLowerCase().startsWith(query))
    .slice(0, 6)
    .map((entry) => ({ value: entry.id }));
}

/**
 * The message box, shared by a draft that has no chat yet and a thread that already does.
 *
 * `#project` sets the context for the rest of the conversation until changed; `@agent` and
 * `/skill` apply to this message only. An address that does not resolve is never deleted from
 * the prose — it is shown, unresolved, alongside what it might have meant.
 */
function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  projectId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
  /** The project already in force for this conversation, if any — narrows `@`/`/` before typing. */
  projectId: string | null;
}) {
  const { t } = useLanguage();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const { projects } = useAddressables(null);
  const parsed = useMemo(() => parseAddresses(value), [value]);

  const draftProject = parsed.project
    ? projects.find((entry) => entry.id.toLowerCase() === parsed.project!.name)
    : undefined;
  const effectiveProjectId = draftProject?.id ?? projectId;
  const { agents, skills } = useAddressables(effectiveProjectId ?? null);

  const active = activeToken(value, caret);
  // Identifies the token being typed, not just its kind — used to reset the highlight and to
  // remember an Escape dismissal so it doesn't reappear until the token actually changes.
  const activeKey = active ? `${active.kind}-${active.start}-${active.query}` : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    setHighlight(0);
  }, [activeKey]);

  const suggestions = active && activeKey !== dismissed ? suggestionsFor(active, projects, agents, skills) : [];

  const applySuggestion = (suggestion: string) => {
    if (!active) return;
    const sigil = ADDRESS_SIGILS[active.kind];
    const next = `${value.slice(0, active.start)}${sigil}${suggestion} ${value.slice(active.end)}`;
    onChange(next);
    const pos = active.start + sigil.length + suggestion.length + 1;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(pos, pos);
      textareaRef.current?.focus();
    });
  };

  return (
    <div className="chat-composer-block">
      {parsed.addresses.length > 0 && (
        <div className="chips address-chips">
          {parsed.addresses.map((addr) => {
            const result = resolveAddress(addr, projects, agents, skills);
            const dropped = parsed.conflicts.some((conflict) => conflict.dropped.includes(addr));
            return (
              <span
                key={`${addr.start}-${addr.end}`}
                className={`chip address-chip${result.ok ? '' : ' address-chip-unresolved'}${dropped ? ' address-chip-dropped' : ''}`}
              >
                <span className="mono">{addr.raw}</span>
                {result.ok && <span className="dim">{result.label}</span>}
                {addr === parsed.project && !dropped && <span className="tag">context</span>}
                {dropped && <span className="tag warn">dropped — already about {parsed.project?.raw}</span>}
                {!result.ok && (
                  <span className="dim">
                    not found
                    {result.suggestions.length > 0
                      ? ` — try ${result.suggestions.map((entry) => ADDRESS_SIGILS[addr.kind] + entry).join(', ')}`
                      : ''}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className="chat-composer-row">
        <textarea
          ref={textareaRef}
          rows={2}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (suggestions.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                setHighlight((current) => (current + delta + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                applySuggestion(suggestions[highlight]!.value);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissed(activeKey);
                return;
              }
            }

            if (event.key === 'Enter' && !event.shiftKey && value.trim() && !disabled) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <button className="primary" onClick={onSubmit} disabled={!value.trim() || disabled}>
          {disabled ? t('chat.sending') : t('chat.send')}
        </button>
      </div>

      {active && suggestions.length > 0 && (
        <div className="address-suggestions">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.value}
              type="button"
              className={`ghost${index === highlight ? ' address-suggestion-active' : ''}`}
              onClick={() => applySuggestion(suggestion.value)}
            >
              {ADDRESS_SIGILS[active.kind]}
              {suggestion.value}
              {suggestion.hint && <span className="dim"> — {suggestion.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {/* The rule, whole. Keep it one sentence — that is the point of printing it here. */}
      <div className="chat-hint">{t('chat.addressRule')}</div>
      <div className="chat-hint">
        <code>#project</code> sets the context for the rest of this conversation until changed —{' '}
        <code>@agent</code> and <code>/skill</code> apply only to this message.
      </div>
    </div>
  );
}
