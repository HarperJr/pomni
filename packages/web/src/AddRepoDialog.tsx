import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, REPO_ROLES, type BrowseResult, type RepoRole } from './api';
import { Alert, Dialog, errorMessage } from './components';

type Tab = 'local' | 'git';

export function AddRepoDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('git');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Shared fields
  const [name, setName] = useState('');
  const [role, setRole] = useState<RepoRole>('other');

  // Local tab
  const [path, setPath] = useState('');

  // Git tab
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [credential, setCredential] = useState('');
  const [provider, setProvider] = useState<'' | 'github' | 'gitlab' | 'bitbucket' | 'generic'>('');

  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api.listCredentials().then((result) => result.credentials),
  });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.addRepo(projectId, {
        source:
          tab === 'local'
            ? { kind: 'local', path }
            : {
                kind: 'git',
                url,
                ref: ref || undefined,
                credential: credential || undefined,
                provider: provider || undefined,
              },
        name: name || undefined,
        role,
      });
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = tab === 'local' ? path.trim().length > 0 : url.trim().length > 0;

  return (
    <Dialog
      title="Add a repo"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? 'Adding…' : tab === 'git' ? 'Clone and add' : 'Add'}
          </button>
        </>
      }
    >
      <div className="tabs">
        <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>
          Clone from git
        </button>
        <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>
          Link a local folder
        </button>
      </div>

      <Alert kind="error">{error}</Alert>

      {tab === 'git' ? (
        <>
          <label>
            <span className="lab">Repository URL</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git"
              autoFocus
            />
            <span className="hint">
              Cloned into the project workspace. Use an https url to authenticate with a token.
            </span>
          </label>

          <div className="field-row">
            <label>
              <span className="lab">Branch or tag</span>
              <input
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                placeholder="default branch"
              />
            </label>
            <label>
              <span className="lab">Credential</span>
              <select value={credential} onChange={(event) => setCredential(event.target.value)}>
                <option value="">Match by host / public repo</option>
                {(credentials.data ?? []).map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.hasSecret}>
                    {item.id} ({item.host}){item.hasSecret ? '' : ' — no secret'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label>
            <span className="lab">Forge</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as typeof provider)}
            >
              <option value="">Detect automatically</option>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="bitbucket">Bitbucket</option>
              <option value="generic">Other</option>
            </select>
            <span className="hint">
              Detected from the hostname, and for a self-hosted forge by asking the server.
              Set it explicitly if the guess is wrong — it decides the username a token is
              sent with.
            </span>
          </label>
        </>
      ) : (
        <LocalPathField path={path} onChange={setPath} />
      )}

      <div className="field-row">
        <label>
          <span className="lab">Display name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="derived from the source"
          />
        </label>
        <label>
          <span className="lab">Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as RepoRole)}>
            {REPO_ROLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  );
}

function LocalPathField({ path, onChange }: { path: string; onChange: (value: string) => void }) {
  const [browsing, setBrowsing] = useState(false);

  const detection = useQuery({
    queryKey: ['detect', path],
    queryFn: () => api.detect(path),
    enabled: path.trim().length > 0,
    retry: false,
  });

  return (
    <>
      <label>
        <span className="lab">Folder</span>
        <input
          value={path}
          onChange={(event) => onChange(event.target.value)}
          placeholder="C:\dev\my-app"
          autoFocus
        />
        <span className="hint">
          Linked in place — Pomni never moves or copies your code.{' '}
          <button
            className="ghost"
            style={{ padding: '0 4px', textDecoration: 'underline' }}
            onClick={() => setBrowsing((value) => !value)}
          >
            {browsing ? 'hide browser' : 'browse…'}
          </button>
        </span>
      </label>

      {browsing && <DirectoryPicker current={path} onPick={onChange} />}

      {detection.data?.detection && (
        <div className="detect-box" style={{ marginBottom: 14 }}>
          <strong>{detection.data.detection.adapter}</strong>{' '}
          <span className="dim">{detection.data.detection.detected.join(', ')}</span>
          <div className="dim" style={{ marginTop: 4 }}>
            {Object.keys(detection.data.detection.capabilities).sort().join(' · ') || 'no commands found'}
          </div>
        </div>
      )}
      {detection.isError && <Alert kind="error">{errorMessage(detection.error)}</Alert>}
    </>
  );
}

function DirectoryPicker({
  current,
  onPick,
}: {
  current: string;
  onPick: (path: string) => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>(current || undefined);

  const browse = useQuery<BrowseResult>({
    queryKey: ['browse', cursor ?? ''],
    queryFn: () => api.browse(cursor),
    retry: false,
  });

  // Start at the home directory rather than an empty root listing.
  useEffect(() => {
    if (!cursor && browse.data?.home) setCursor(browse.data.home);
  }, [browse.data?.home, cursor]);

  if (browse.isError) return <Alert kind="error">{errorMessage(browse.error)}</Alert>;

  const data = browse.data;
  const directories = (data?.entries ?? []).filter((entry) => entry.isDirectory);

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="mono dim truncate" style={{ marginBottom: 6 }}>
        {data?.path ?? 'loading…'}
      </div>
      <div className="picker">
        {data?.parent && (
          <button onClick={() => setCursor(data.parent ?? undefined)}>
            <span className="dim">↑</span> ..
          </button>
        )}
        {directories.map((entry) => (
          <button
            key={entry.path}
            onClick={() => setCursor(entry.path)}
            onDoubleClick={() => onPick(entry.path)}
          >
            <span className="dim">{entry.isGitRepo ? '◆' : '▸'}</span>
            <span className="grow truncate">{entry.name}</span>
            {entry.isGitRepo && <span className="tag">git</span>}
          </button>
        ))}
        {directories.length === 0 && <div className="empty">no subfolders</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={() => data?.path && onPick(data.path)} disabled={!data?.path}>
          Use this folder
        </button>
        {data?.roots.map((root) => (
          <button key={root} className="ghost" onClick={() => setCursor(root)}>
            {root}
          </button>
        ))}
      </div>
    </div>
  );
}
