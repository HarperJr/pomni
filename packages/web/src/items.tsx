import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  ITEM_STATUSES,
  ITEM_TYPES,
  PRIORITIES,
  type BacklogItem,
  type ItemStatus,
  type ItemType,
  type Priority,
} from './api';
import { Alert, Dialog, errorMessage } from './components';

const COLUMN_LABEL: Record<ItemStatus, string> = {
  backlog: 'Backlog',
  specced: 'Specced',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  const tone =
    status === 'done'
      ? 'ready'
      : status === 'blocked' || status === 'cancelled'
        ? 'error'
        : status === 'in_progress' || status === 'in_review'
          ? 'cloning'
          : 'linked';

  return (
    <span className={`status status-${tone}`}>
      <span className="dot" />
      {COLUMN_LABEL[status]}
    </span>
  );
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

  const grouped = groupByStatus(items.data ?? []);

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
              <ItemStatusBadge status={status} />
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

/** One item: its spec, its state, and the transitions it can legally make. */
export function ItemPage() {
  const { projectId = '', itemId = '' } = useParams();
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const item = useQuery({
    queryKey: ['item', projectId, itemId],
    queryFn: () => api.getItem(projectId, itemId).then((result) => result.item),
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
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (item.isError) return <Alert kind="error">{errorMessage(item.error)}</Alert>;
  if (!item.data) return <div className="dim">Loading…</div>;

  const data = item.data;

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="crumb" to={`/p/${projectId}`}>← {projectId}</Link>
          <h1>
            <span className="dim mono" style={{ fontSize: 16 }}>{data.id}</span> {data.title}
          </h1>
        </div>
        <div className="spacer" />
        <ItemStatusBadge status={data.status} />
      </div>

      <Alert kind="error">{error}</Alert>

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
              {data.blockedBy.length > 0 && (
                <div className="status-error">waiting on {data.blockedBy.join(', ')}</div>
              )}
              {data.blocking.length > 0 && (
                <div className="dim">blocks {data.blocking.join(', ')}</div>
              )}
            </div>
          </div>
        )}

        <div className="row">
          <span className="dim">Move to</span>
          <div className="tags grow">
            {ITEM_STATUSES.filter((status) => status !== data.status).map((status) => (
              <button
                key={status}
                className="ghost"
                style={{ padding: '2px 9px', fontSize: 12 }}
                disabled={move.isPending}
                onClick={() => move.mutate(status)}
              >
                {COLUMN_LABEL[status]}
              </button>
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

function groupByStatus(items: BacklogItem[]): Array<[ItemStatus, BacklogItem[]]> {
  const order: ItemStatus[] = [
    'in_progress',
    'in_review',
    'ready',
    'specced',
    'backlog',
    'blocked',
    'done',
    'cancelled',
  ];

  return order
    .map((status) => [status, items.filter((item) => item.status === status)] as [ItemStatus, BacklogItem[]])
    .filter(([, group]) => group.length > 0);
}
