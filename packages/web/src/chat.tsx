import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type ActionStatus,
  type Chat,
  type ChatMessage,
  type ModelMap,
  type ProposedAction,
  type ProviderStatus,
} from './api';
import { Alert, Dialog, errorMessage } from './components';

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
  const params = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const routed = chosen === undefined;
  const chatId = routed ? (params.chatId ?? '') : chosen;
  const choose = (id: string) => (routed ? navigate(`/chat/${id}`) : onChoose?.(id));

  const chats = useQuery({
    queryKey: ['chats'],
    queryFn: () => api.listChats().then((result) => result.chats),
  });

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.listProviders(),
  });

  const usable = usableProviders(providers.data?.providers ?? []);

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
        {routed && <h1>Chat</h1>}
        <div className="spacer" />
        <button
          className="primary"
          onClick={() => setCreating(true)}
          disabled={usable.length === 0}
          title={usable.length === 0 ? 'no enabled, available provider is configured' : undefined}
        >
          New chat
        </button>
      </div>

      {chats.isError && <Alert kind="error">{errorMessage(chats.error)}</Alert>}

      <div className="chat-layout">
        <div className="card chat-list">
          {sorted.length === 0 ? (
            <div className="empty">No conversations yet. Start one to talk to Pomni.</div>
          ) : (
            sorted.map((chat) => (
              <div
                className={`row chat-list-row${chat.id === chatId ? ' selected' : ''}`}
                key={chat.id}
              >
                {routed ? (
                  <Link className="grow truncate" to={`/chat/${chat.id}`}>
                    {chat.title || 'Untitled chat'}
                  </Link>
                ) : (
                  <button className="grow truncate link" onClick={() => choose(chat.id)}>
                    {chat.title || 'Untitled chat'}
                  </button>
                )}
                <button
                  className="ghost danger"
                  onClick={() => {
                    if (confirm(`Delete chat "${chat.title || 'Untitled chat'}"?`)) {
                      remove.mutate(chat.id);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <div className="chat-detail">
          {chatId ? (
            <ChatThread chatId={chatId} providers={usable} />
          ) : (
            <div className="card">
              <div className="empty">Choose a conversation, or start a new one.</div>
            </div>
          )}
        </div>
      </div>

      {creating && (
        <NewChatDialog
          providers={usable}
          onClose={() => setCreating(false)}
          onCreated={(id) => choose(id)}
        />
      )}
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

function NewChatDialog({
  providers,
  onClose,
  onCreated,
}: {
  providers: ProviderStatus[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createChat({ providerId, model, title: title.trim() || undefined }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      onClose();
      onCreated(result.chat.id);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="New chat"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!providerId || !model || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Starting…' : 'Start'}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <label>
        <span className="lab">Title (optional)</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What's this about?"
          autoFocus
        />
      </label>

      <ProviderModelFields
        providers={providers}
        providerId={providerId}
        setProviderId={setProviderId}
        model={model}
        setModel={setModel}
      />
    </Dialog>
  );
}

function ChangeModelDialog({
  chat,
  providers,
  onClose,
}: {
  chat: Chat;
  providers: ProviderStatus[];
  onClose: () => void;
}) {
  const [providerId, setProviderId] = useState(chat.providerId);
  const [model, setModel] = useState(chat.model);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: () => api.setChatModel(chat.id, { providerId, model }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['chat', chat.id] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="Change model"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!providerId || !model || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <span className="hint" style={{ marginTop: -6, marginBottom: 14, display: 'block' }}>
        The transcript stays as it is — a note is added recording the change.
      </span>

      <ProviderModelFields
        providers={providers}
        providerId={providerId}
        setProviderId={setProviderId}
        model={model}
        setModel={setModel}
      />
    </Dialog>
  );
}

/**
 * Provider, then model. A provider whose kind is `openai` with a base url reports its own
 * live catalogue, which is usually larger than the four struggle slots — offered when it
 * answers, otherwise falling back to whatever struggle slots the provider names.
 */
function ProviderModelFields({
  providers,
  providerId,
  setProviderId,
  model,
  setModel,
}: {
  providers: ProviderStatus[];
  providerId: string;
  setProviderId: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
}) {
  const provider = providers.find((entry) => entry.id === providerId);

  const live = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => api.providerModels(providerId).then((result) => result.models),
    enabled: Boolean(providerId) && provider?.kind === 'openai' && Boolean(provider?.baseUrl),
    retry: false,
  });

  const options = live.data && live.data.length > 0 ? live.data : distinctModels(provider?.models ?? {});

  return (
    <>
      <label>
        <span className="lab">Provider</span>
        <select
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
            setModel('');
          }}
        >
          <option value="">Choose a provider…</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="lab">Model</span>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={!providerId}
        >
          <option value="">Choose a model…</option>
          {options.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

function ChatThread({ chatId, providers }: { chatId: string; providers: ProviderStatus[] }) {
  const [text, setText] = useState('');
  const [changingModel, setChangingModel] = useState(false);
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

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.data?.messages.length]);

  if (chat.isError) return <Alert kind="error">{errorMessage(chat.error)}</Alert>;
  if (!chat.data) return <div className="dim">Loading…</div>;

  const data = chat.data;
  const messages = data.messages;
  // In flight from the moment a message is sent until the assistant's reply is persisted —
  // `chat.turn.finished` is what makes that reply show up here, via the shared event stream.
  const turnPending = send.isPending || messages[messages.length - 1]?.role === 'user';

  return (
    <>
      <div className="card chat-header">
        <div className="grow">
          <strong>{data.title || 'Untitled chat'}</strong>
          <div className="dim mono">
            {data.providerLabel} · {data.model}
            {!data.providerAvailable && ' · provider unavailable'}
          </div>
        </div>
        <span className="dim mono">
          {data.inputTokens + data.outputTokens} tokens ·{' '}
          {data.costUsd !== null ? `$${data.costUsd.toFixed(3)}` : 'cost unknown'}
        </span>
        <button className="ghost" onClick={() => setChangingModel(true)}>
          Change model
        </button>
      </div>

      <div className="card chat-thread">
        {messages.length === 0 && <div className="empty">Say something to get started.</div>}

        {messages.map((message) => (
          <MessageRow key={message.id} chatId={chatId} message={message} />
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
          <div className="chat-composer-row">
            <textarea
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Message Pomni…"
              disabled={turnPending}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && text.trim() && !turnPending) {
                  event.preventDefault();
                  send.mutate(text);
                }
              }}
            />
            <button
              className="primary"
              onClick={() => send.mutate(text)}
              disabled={!text.trim() || turnPending}
            >
              {turnPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        )}
      </div>

      {changingModel && (
        <ChangeModelDialog chat={data} providers={providers} onClose={() => setChangingModel(false)} />
      )}
    </>
  );
}

function MessageRow({ chatId, message }: { chatId: string; message: ChatMessage }) {
  if (message.role === 'system') {
    return <div className="chat-system">{message.text}</div>;
  }

  return (
    <div className={`chat-message chat-message-${message.role}`}>
      <div className="chat-message-head">
        <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
        {message.role === 'assistant' && message.model && (
          <span className="tag">{message.model}</span>
        )}
        <span className="dim mono">{time(message.createdAt)}</span>
      </div>

      {message.text && <div className="chat-message-text wrap">{message.text}</div>}

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
            Confirm
          </button>
          <button
            className="danger"
            onClick={() => reject.mutate()}
            disabled={confirm.isPending || reject.isPending}
          >
            Reject
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
