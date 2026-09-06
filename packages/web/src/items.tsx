import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  ITEM_TYPES,
  PRIORITIES,
  type BacklogItem,
  type ChecklistEntry,
  type Flow,
  type ItemStatus,
  type ItemType,
  type Priority,
  type TransitionOffer,
  type UnmetRequirement,
} from './api';
import { Alert, Dialog, errorMessage } from './components';

const COLUMN_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  specced: 'Specced',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

/** A project-defined state has no entry above — fall back to its name, made readable. */
function columnLabel(status: ItemStatus): string {
  return COLUMN_LABEL[status] ?? status.replace(/_/g, ' ');
}

const DEFAULT_ORDER: ItemStatus[] = [
  'in_progress',
  'in_review',
  'ready',
  'specced',
  'backlog',
  'blocked',
  'done',
  'cancelled',
];

export function ItemStatusBadge({ status, label }: { status: ItemStatus; label?: string }) {
  const tone =
    status === 'done'
      ? 'ready'
      : status === 'blocked' || status === 'cancelled'
        ? 'error'
        : status === 'in_progress' || status === 'in_review'
          ? 'cloning'
          : status === 'backlog' || status === 'specced' || status === 'ready'
            ? 'linked'
            : 'neutral';

  return (
    <span className={`status status-${tone}`}>
      <span className="dot" />
      {label ?? columnLabel(status)}
    </span>
  );
}

/**
 * The wording for a refused requirement, letter for letter what
 * `describeUnmet` in `packages/core/src/domain/flow.ts` renders — the web package has no
 * dependency on `@pomni/core` (see the comment on `UnmetRequirement` in `api.ts`), so the
 * sentences are re-implemented here by hand and must be kept in sync manually.
 */
/** Joins as `'A'`, `'A' and 'B'`, `'A', 'B' and 'C'` — pass already-quoted/plain strings as needed. */
function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

function describeUnmet(unmet: UnmetRequirement): string {
  switch (unmet.kind) {
    case 'acceptance': {
      if (unmet.total === 0) return 'no acceptance criteria are written in the item body';
      const noun = unmet.unchecked === 1 ? 'criterion' : 'criteria';
      return `${unmet.unchecked} of ${unmet.total} acceptance ${noun} unticked`;
    }

    case 'gate': {
      const pending = unmet.pending.filter((entry) => entry.repo !== '*');
      if (unmet.failing.length === 0 && pending.length === 0) {
        return `gate \`${unmet.gate}\` has not run for any repo this item touches`;
      }
      const clauses: string[] = [];
      if (unmet.failing.length > 0) {
        clauses.push(
          `gate \`${unmet.gate}\` has not passed for ${unmet.failing.map((entry) => `${entry.repo} (${entry.capability})`).join(', ')}`,
        );
      }
      if (pending.length > 0) {
        clauses.push(
          `gate \`${unmet.gate}\` has not run for ${pending.map((entry) => `${entry.repo} (${entry.capability})`).join(', ')}`,
        );
      }
      return clauses.join('; ');
    }

    case 'checklist': {
      const unticked = unmet.total - unmet.ticked;
      return `${unticked} of ${unmet.total} checklist items unticked: ${unmet.missing.map((entry) => entry.label).join(', ')}`;
    }

    case 'fields': {
      const verb = unmet.missing.length === 1 ? 'is' : 'are';
      return `${andList(unmet.missing)} ${verb} empty`;
    }

    case 'sections': {
      if (unmet.missing.length === 0) return 'a required section is missing from the item body';
      const noun = unmet.missing.length === 1 ? 'section is' : 'sections are';
      const names = andList(unmet.missing.map((name) => `'${name}'`));
      return `no ${names} ${noun} written in the item body`;
    }

    case 'dependencies': {
      if (unmet.unfinished.length === 0) return 'the dependencies of this item have not been checked';
      const verb = unmet.unfinished.length === 1 ? 'is' : 'are';
      return `depends on ${unmet.unfinished.join(', ')}, which ${verb} not done`;
    }
  }
}

/** Backlog list on the project page. The kanban board proper is M2. */
export function ItemList({ projectId }: { projectId: string }) {
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const items = useQuery({
    queryKey: ['items', projectId, showDone],
    queryFn: () =>
      api.listItems(projectId, showDone ? undefined : 'active').then((result) => result.items),
  });

  const flow = useQuery({
    queryKey: ['items-flow', projectId],
    queryFn: () => api.getItemFlow(projectId),
  });

  const grouped = groupByStatus(items.data ?? [], flow.data);
  const flowLabel = (status: ItemStatus) => flow.data?.states.find((s) => s.name === status)?.label;

  return (
    <div className="card">
      <div className="card-head">
        Backlog
        <span className="dim" style={{ fontWeight: 400 }}>{items.data?.length ?? 0}</span>
        <div className="spacer" />
        <button className="ghost" onClick={() => setShowDone((value) => !value)}>
          {showDone ? 'Hide done' : 'Show all'}
        </button>
        <button onClick={() => setAdding(true)}>Add item</button>
      </div>

      {items.isError && (
        <div className="row">
          <Alert kind="error">{errorMessage(items.error)}</Alert>
        </div>
      )}

      {(items.data ?? []).length === 0 ? (
        <div className="empty">
          Nothing captured yet. An item is a Markdown file in the repo — readable in a diff,
          editable by an agent.
        </div>
      ) : (
        grouped.map(([status, group]) => (
          <div key={status}>
            <div className="row" style={{ paddingTop: 8, paddingBottom: 8 }}>
              <ItemStatusBadge status={status} label={flowLabel(status)} />
              <span className="dim">{group.length}</span>
            </div>
            {group.map((item) => (
              <ItemRow key={item.id} projectId={projectId} item={item} />
            ))}
          </div>
        ))
      )}

      {adding && <NewItemDialog projectId={projectId} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ItemRow({ projectId, item }: { projectId: string; item: BacklogItem }) {
  return (
    <Link className="row" to={`/p/${projectId}/items/${item.id}`} style={{ paddingLeft: 32 }}>
      <span className="mono dim" style={{ width: 84 }}>{item.id}</span>
      <span className="tag">{item.priority}</span>
      <div className="grow truncate">{item.title}</div>
      {item.repos.map((repo) => (
        <span key={repo} className="tag">{repo}</span>
      ))}
      {item.blockedReason && <span className="status-error" style={{ fontSize: 12 }}>blocked</span>}
    </Link>
  );
}

function NewItemDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ItemType>('feature');
  const [priority, setPriority] = useState<Priority>('P2');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createItem(projectId, { title, type, priority }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['items', projectId] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="New item"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!title.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <span className="hint">
          Captured as a Markdown file with a spec template. Fill in the problem and acceptance
          criteria before moving it past Backlog.
        </span>
      </label>
      <div className="field-row">
        <label>
          <span className="lab">Type</span>
          <select value={type} onChange={(event) => setType(event.target.value as ItemType)}>
            {ITEM_TYPES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="lab">Priority</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
            {PRIORITIES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  );
}

/** One offer in the move-to row: a button that either works, or says why it doesn't. */
function TransitionRow({
  projectId,
  itemId,
  offer,
  checklist,
  flow,
  fromStatus,
  movePending,
  onMove,
}: {
  projectId: string;
  itemId: string;
  offer: TransitionOffer;
  checklist: Record<string, string>;
  flow: Flow | undefined;
  fromStatus: ItemStatus;
  movePending: boolean;
  onMove: () => void;
}) {
  const queryClient = useQueryClient();
  const [tickError, setTickError] = useState<string | null>(null);

  const tick = useMutation({
    mutationFn: (body: { key: string; ticked: boolean }) =>
      api.tickChecklist(projectId, itemId, body),
    onSuccess: async () => {
      setTickError(null);
      await queryClient.invalidateQueries({ queryKey: ['item', projectId, itemId] });
      await queryClient.invalidateQueries({ queryKey: ['items', projectId] });
    },
    onError: (caught) => setTickError(errorMessage(caught)),
  });

  const checklistUnmet = offer.unmet.find(
    (u): u is Extract<UnmetRequirement, { kind: 'checklist' }> => u.kind === 'checklist',
  );

  // The full definition of done, ticked entries included, comes from the flow's arrow — the
  // unmet requirement itself only lists what is still missing.
  const transition = flow?.transitions.find((t) => t.from === fromStatus && t.to === offer.to);
  const entries: ChecklistEntry[] = transition?.requires.checklist ?? checklistUnmet?.missing ?? [];

  return (
    <div className="transition-row">
      <div className="row" style={{ gap: 8 }}>
        <button
          className="ghost"
          style={{ padding: '2px 9px', fontSize: 12 }}
          disabled={!offer.ok || movePending}
          onClick={onMove}
        >
          {offer.label}
        </button>
        {offer.via === 'recovery' && <span className="tag warn">recovery</span>}
      </div>

      {!offer.ok && (
        <div className="hint transition-reason">{offer.unmet.map(describeUnmet).join('; ')}</div>
      )}

      {checklistUnmet && entries.length > 0 && (
        <div className="tags checklist-row">
          {entries.map((entry) => {
            const ticked = Boolean(checklist[entry.key]);
            return (
              <button
                key={entry.key}
                type="button"
                className={`tag toggle${ticked ? ' on' : ''}`}
                disabled={tick.isPending}
                title={checklist[entry.key] ?? undefined}
                onClick={() => tick.mutate({ key: entry.key, ticked: !ticked })}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      )}

      {tickError && <div className="hint status-error">{tickError}</div>}
    </div>
  );
}

/** One item: its spec, its state, and the transitions it can legally make. */
export function ItemPage() {
  const { projectId = '', itemId = '' } = useParams();
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const item = useQuery({
    queryKey: ['item', projectId, itemId],
    queryFn: () => api.getItem(projectId, itemId).then((result) => result.item),
  });

  const flow = useQuery({
    queryKey: ['items-flow', projectId],
    queryFn: () => api.getItemFlow(projectId),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['item', projectId, itemId] });
    await queryClient.invalidateQueries({ queryKey: ['items', projectId] });
  };

  const move = useMutation({
    mutationFn: (to: ItemStatus) => api.transitionItem(projectId, itemId, { to }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.unmet && caught.unmet.length > 0) {
        setError(`${errorMessage(caught)} — ${caught.unmet.map(describeUnmet).join('; ')}`);
      } else {
        setError(errorMessage(caught));
      }
    },
  });

  const unblock = useMutation({
    mutationFn: () => api.unblockItem(projectId, itemId),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (item.isError) return <Alert kind="error">{errorMessage(item.error)}</Alert>;
  if (!item.data) return <div className="dim">Loading…</div>;

  const data = item.data;

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="crumb" to={`/p/${projectId}?block=backlog`}>← {projectId}</Link>
          <h1>
            <span className="dim mono" style={{ fontSize: 16 }}>{data.id}</span> {data.title}
          </h1>
        </div>
        <div className="spacer" />
        <ItemStatusBadge status={data.status} label={data.flowState?.label ?? data.flowState?.name} />
      </div>

      <Alert kind="error">{error}</Alert>

      {data.offFlow && (
        <Alert kind="info">
          This item's status ({columnLabel(data.status)}) is not a state in this project's
          current flow — only recovery moves are offered below.
        </Alert>
      )}

      <div className="card">
        <div className="row">
          <div className="grow">
            <span className="tag">{data.type}</span> <span className="tag">{data.priority}</span>
            {data.estimate && <span className="tag">{data.estimate}</span>}
            {data.repos.map((repo) => (
              <span key={repo} className="tag">{repo}</span>
            ))}
            {data.labels.map((label) => (
              <span key={label} className="tag">{label}</span>
            ))}
          </div>
          {data.acceptance.total > 0 && (
            <span className="dim mono">
              {data.acceptance.checked}/{data.acceptance.total} criteria
            </span>
          )}
        </div>

        {(data.blockedBy.length > 0 || data.blocking.length > 0 || data.blockedReason) && (
          <div className="row">
            <div className="grow" style={{ fontSize: 13 }}>
              {data.blockedReason && (
                <div className="status-error">blocked — {data.blockedReason}</div>
              )}
              {data.blockedBy.length === 0 && data.status === 'blocked' && (
                <div style={{ marginTop: 6 }}>
                  <button
                    className="primary"
                    style={{ padding: '3px 12px', fontSize: 12 }}
                    disabled={unblock.isPending}
                    onClick={() => unblock.mutate()}
                  >
                    {unblock.isPending ? 'Unblocking…' : 'Unblock'}
                  </button>
                  <span className="dim" style={{ marginLeft: 8, fontSize: 12 }}>
                    puts it back to{' '}
                    <strong>{columnLabel(data.statusBefore ?? 'backlog')}</strong>
                  </span>
                </div>
              )}
              {data.blockedBy.length > 0 && (
                <div className="status-error">waiting on {data.blockedBy.join(', ')}</div>
              )}
              {data.blocking.length > 0 && (
                <div className="dim">blocks {data.blocking.join(', ')}</div>
              )}
            </div>
          </div>
        )}

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <span className="dim" style={{ paddingTop: 5 }}>Move to</span>
          <div className="grow transition-list">
            {data.allowedTransitions.length === 0 && (
              <span className="dim" style={{ fontSize: 12 }}>no moves are offered from here</span>
            )}
            {data.allowedTransitions.map((offer) => (
              <TransitionRow
                key={offer.to}
                projectId={projectId}
                itemId={itemId}
                offer={offer}
                checklist={data.checklist}
                flow={flow.data}
                fromStatus={data.status}
                movePending={move.isPending}
                onMove={() => move.mutate(offer.to)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Spec</div>
        <pre className="log" style={{ maxHeight: 'none' }}>{data.body.trimEnd()}</pre>
      </div>
    </>
  );
}

function groupByStatus(items: BacklogItem[], flow?: Flow): Array<[ItemStatus, BacklogItem[]]> {
  const order = flow ? flow.states.map((s) => s.name) : DEFAULT_ORDER;
  const known = new Set(order);
  const extra = Array.from(new Set(items.map((item) => item.status))).filter(
    (status) => !known.has(status),
  );

  return [...order, ...extra]
    .map((status) => [status, items.filter((item) => item.status === status)] as [ItemStatus, BacklogItem[]])
    .filter(([, group]) => group.length > 0);
}
