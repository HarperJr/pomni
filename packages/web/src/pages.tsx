import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AddRepoDialog } from './AddRepoDialog';
import { api, REPO_ROLES, type Credential, type Repo, type RepoRole } from './api';
import { Alert, Dialog, StatusBadge, errorMessage } from './components';
import { ItemList } from './items';
import { DoctorPanel, RunControls, RunList, VerifyButton } from './runs';
import { PipelinePanel } from './console';
import { DiscoveryPanel } from './discovery';
import { ProjectWorkflows } from './workflows';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects().then((result) => result.projects),
  });

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        <div className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          New project
        </button>
      </div>

      {projects.isError && <Alert kind="error">{errorMessage(projects.error)}</Alert>}

      {projects.data?.length === 0 && (
        <div className="card">
          <div className="empty">
            No projects yet. A project is a container — create one, then add the repos it is
            built from.
          </div>
        </div>
      )}

      <div className="grid">
        {(projects.data ?? []).map((project) => (
          <Link key={project.id} className="project-card" to={`/p/${project.id}`}>
            <h3>{project.name}</h3>
            <div className="dim mono">{project.id}</div>
            <div style={{ marginTop: 12 }} className="tags">
              {project.repos.length === 0 && <span className="dim">no repos</span>}
              {project.repos.map((repo) => (
                <span key={repo.id} className="tag">
                  {repo.id}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createProject({ name, description: description || undefined }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/p/${result.project.id}`);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        <span className="hint">The id is derived from the name and never changes.</span>
      </label>
      <label>
        <span className="lab">Description</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Project detail
// ---------------------------------------------------------------------------

/**
 * The blocks of a project, in the order you meet them: what the code is, what is planned,
 * what the agents are doing, and the machinery behind that.
 */
const SECTIONS = [
  { id: 'repos', label: 'Repos' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'runs', label: 'Agent runs' },
  { id: 'checks', label: 'Checks' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'discovery', label: 'Discovery' },
] as const;

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const [adding, setAdding] = useState(false);
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // In the URL, so a section can be linked to and survives a reload — and so the nav's
  // remember/recall brings you back to the block you were reading, not the project's top.
  const requested = params.get('block') ?? '';
  const active = SECTIONS.some((section) => section.id === requested) ? requested : 'repos';
  const select = (id: string) => setParams(id === 'repos' ? {} : { block: id }, { replace: true });

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId).then((result) => result.project),
    // A clone is in flight: poll until every repo has settled.
    refetchInterval: (query) =>
      query.state.data?.repos.some((repo) => repo.status === 'cloning') ? 1200 : false,
  });

  // The keys are the panels' own, so opening a block reuses what the count already fetched
  // rather than asking again. The old page rendered every panel at once, so this is fewer
  // requests than before, not more.
  const items = useQuery({
    queryKey: ['items', projectId, false],
    queryFn: () => api.listItems(projectId, 'active').then((result) => result.items),
  });

  const pipelines = useQuery({
    queryKey: ['pipelines', projectId],
    queryFn: () => api.listPipelines(projectId).then((result) => result.runs),
  });

  const counts: Record<string, number | string> = {
    repos: project.data?.repos.length ?? '',
    backlog: items.data?.length ?? '',
    runs: pipelines.data?.length ?? '',
  };

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId, true),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate('/');
    },
  });

  if (project.isError) return <Alert kind="error">{errorMessage(project.error)}</Alert>;
  if (!project.data) return <div className="dim">Loading…</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="crumb" to="/">
            ← Projects
          </Link>
          <h1>{project.data.name}</h1>
        </div>
        <div className="spacer" />
        <VerifyButton projectId={projectId} />
        <DoctorPanel projectId={projectId} />
        <button className="primary" onClick={() => setAdding(true)}>
          Add repo
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Remove project "${project.data.name}"? Cloned copies are deleted; linked folders are not.`)) {
              remove.mutate();
            }
          }}
        >
          Delete
        </button>
      </div>

      {project.data.description && <p className="dim">{project.data.description}</p>}

      <div className="project-layout">
        <div className="card project-nav">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              className={`project-nav-row${section.id === active ? ' selected' : ''}`}
              aria-current={section.id === active}
              onClick={() => select(section.id)}
            >
              <span className="grow truncate">{section.label}</span>
              <span className="dim mono">{counts[section.id] ?? ''}</span>
            </button>
          ))}
        </div>

        <div className="project-section">
          {active === 'repos' && (
            <div className="card">
              <div className="card-head">
                Repos
                <span className="dim" style={{ fontWeight: 400 }}>
                  {project.data.repos.length}
                </span>
              </div>
              {project.data.repos.length === 0 ? (
                <div className="empty">
                  No repos yet. Clone one from git, or link a folder that is already on this
                  machine.
                </div>
              ) : (
                project.data.repos.map((repo) => (
                  <RepoRow key={repo.id} projectId={projectId} repo={repo} />
                ))
              )}
            </div>
          )}

          {active === 'runs' && <PipelinePanel projectId={projectId} />}
          {active === 'workflows' && <ProjectWorkflows projectId={projectId} />}
          {active === 'discovery' && <DiscoveryPanel projectId={projectId} />}
          {active === 'backlog' && <ItemList projectId={projectId} />}
          {active === 'checks' && <RunList projectId={projectId} />}
        </div>
      </div>

      {adding && <AddRepoDialog projectId={projectId} onClose={() => setAdding(false)} />}
    </>
  );
}

function RepoRow({ projectId, repo }: { projectId: string; repo: Repo }) {
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] });

  const sync = useMutation({
    mutationFn: () => api.syncRepo(projectId, repo.id),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.removeRepo(projectId, repo.id, repo.source.kind === 'git'),
    onSuccess: invalidate,
  });

  return (
    <div className="row">
      <div className="grow">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{repo.name}</strong>
          <span className="tag">{repo.role}</span>
          <StatusBadge status={repo.status} />
        </div>

        <div className="mono dim truncate" title={repo.workingDir}>
          {repo.source.kind === 'git' ? repo.source.url : repo.source.path}
          {repo.vcs?.currentBranch ? ` · ${repo.vcs.currentBranch}` : ''}
          {repo.vcs?.dirty ? ' · dirty' : ''}
          {repo.lastSyncedAt ? ` · synced ${sinceText(repo.lastSyncedAt)}` : ' · never synced'}
        </div>

        {repo.stack && (
          <div className="tags" style={{ marginTop: 6 }}>
            {repo.stack.detected.map((marker) => (
              <span key={marker} className="tag">
                {marker}
              </span>
            ))}
          </div>
        )}

        {repo.lastError && (
          <div className="status-error" style={{ marginTop: 6, fontSize: 12 }}>
            {repo.lastError}
            {needsCredential(repo) && (
              <>
                {' '}
                <button
                  className="ghost"
                  style={{ padding: '0 4px', fontSize: 12, textDecoration: 'underline' }}
                  onClick={() => setEditing(true)}
                >
                  attach a credential
                </button>
              </>
            )}
          </div>
        )}

        <RunControls projectId={projectId} repo={repo} />
      </div>

      <button className="ghost" onClick={() => setEditing(true)}>
        Edit
      </button>
      <button className="ghost" onClick={() => sync.mutate()} disabled={sync.isPending}>
        {sync.isPending ? 'Syncing…' : 'Sync'}
      </button>
      {editing && (
        <EditRepoDialog projectId={projectId} repo={repo} onClose={() => setEditing(false)} />
      )}
      <button
        className="ghost danger"
        onClick={() => {
          const what =
            repo.source.kind === 'git'
              ? 'This deletes the cloned working copy.'
              : 'Your folder is left untouched.';
          if (confirm(`Remove "${repo.name}"? ${what}`)) remove.mutate();
        }}
      >
        Remove
      </button>
    </div>
  );
}

/** "3m ago" — enough to tell whether a sync is stale without reading a timestamp. */
function sinceText(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A git repo that has not cloned is almost always waiting on auth. */
function needsCredential(repo: Repo): boolean {
  return (
    repo.source.kind === 'git' &&
    (repo.status === 'error' || repo.status === 'missing') &&
    !repo.source.credential
  );
}

function EditRepoDialog({
  projectId,
  repo,
  onClose,
}: {
  projectId: string;
  repo: Repo;
  onClose: () => void;
}) {
  // Narrowed once: a boolean flag does not let the compiler follow the union.
  const gitSource = repo.source.kind === 'git' ? repo.source : null;
  const localSource = repo.source.kind === 'local' ? repo.source : null;

  const [name, setName] = useState(repo.name);
  const [role, setRole] = useState<RepoRole>(repo.role);
  const [url, setUrl] = useState(gitSource?.url ?? '');
  const [ref, setRef] = useState(gitSource?.ref ?? '');
  const [credential, setCredential] = useState(gitSource?.credential ?? '');
  const [provider, setProvider] = useState<string>(gitSource?.provider ?? 'generic');
  const [reclone, setReclone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api.listCredentials().then((result) => result.credentials),
  });

  const save = useMutation({
    mutationFn: () =>
      api.updateRepo(projectId, repo.id, {
        name,
        role,
        ...(gitSource
          ? {
              url,
              ref: ref || null,
              credential: credential || null,
              provider: provider as 'github' | 'gitlab' | 'bitbucket' | 'generic',
              reclone,
            }
          : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const urlChanged = gitSource !== null && url !== gitSource.url;

  return (
    <Dialog
      title={`Edit ${repo.id}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <label>
          <span className="lab">Display name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span className="lab">Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as RepoRole)}>
            {REPO_ROLES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      </div>

      {gitSource ? (
        <>
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
            <span className="hint">
              After attaching one, press Sync — that retries the clone.
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
              <span className="lab">Forge</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as typeof provider)}
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
                <option value="bitbucket">Bitbucket</option>
                <option value="generic">Other</option>
              </select>
            </label>
          </div>

          <label>
            <span className="lab">Repository URL</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>

          {urlChanged && repo.workingDirExists && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={reclone}
                onChange={(event) => setReclone(event.target.checked)}
                style={{ width: 'auto', marginTop: 3 }}
              />
              <span className="hint" style={{ margin: 0 }}>
                Delete the existing working copy and clone the new url. Required, because the
                clone on disk came from the old one.
              </span>
            </label>
          )}
        </>
      ) : (
        <div className="detect-box">
          Linked from <span className="mono">{localSource?.path}</span>. To point at a git url
          instead, remove this repo and add it again — your folder is left untouched.
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function CredentialsPage() {
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();

  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api.listCredentials().then((result) => result.credentials),
  });

  return (
    <>
      <div className="page-head">
        <h1>Credentials</h1>
        <div className="spacer" />
        <button className="primary" onClick={() => setAdding(true)}>
          Add credential
        </button>
      </div>

      <Alert kind="info">
        Tokens are never written to a tracked file and are never returned by the API. Pomni stores
        a pointer — an environment variable, the GitHub CLI, or a gitignored file — and resolves it
        only when git needs it.
      </Alert>

      <div className="card">
        {(credentials.data ?? []).length === 0 ? (
          <div className="empty">No credentials. Public repos work without one.</div>
        ) : (
          (credentials.data ?? []).map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              onChanged={() => queryClient.invalidateQueries({ queryKey: ['credentials'] })}
            />
          ))
        )}
      </div>

      {adding && <AddCredentialDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function CredentialRow({
  credential,
  onChanged,
}: {
  credential: Credential;
  onChanged: () => void;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [editing, setEditing] = useState(false);

  const test = useMutation({
    mutationFn: () => api.testCredential(credential.id),
    onSuccess: setResult,
  });

  const remove = useMutation({
    mutationFn: () => api.removeCredential(credential.id),
    onSuccess: onChanged,
  });

  const source =
    credential.secretRef.kind === 'env'
      ? `env: ${credential.secretRef.var}`
      : credential.secretRef.kind === 'gh-cli'
        ? 'GitHub CLI'
        : 'stored in Pomni';

  return (
    <div className="row">
      <div className="grow">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{credential.name}</strong>
          <span className="tag">{credential.host}</span>
          <span className={`status status-${credential.hasSecret ? 'ready' : 'error'}`}>
            <span className="dot" />
            {credential.hasSecret ? 'resolves' : 'no secret'}
          </span>
        </div>
        <div className="dim mono">
          {credential.id} · {source} · user {credential.username}
          {credential.secretHint ? ` · ${credential.secretHint}` : ''}
        </div>
        {result && (
          <div
            className={result.ok ? 'status-ready' : 'status-error'}
            style={{ marginTop: 6, fontSize: 12 }}
          >
            {result.message}
          </div>
        )}
      </div>
      <button className="ghost" onClick={() => setEditing(true)}>
        Edit
      </button>
      <button className="ghost" onClick={() => test.mutate()} disabled={test.isPending}>
        Test
      </button>
      {editing && (
        <CredentialDialog
          credential={credential}
          onClose={() => setEditing(false)}
          onSaved={onChanged}
        />
      )}
      <button
        className="ghost danger"
        onClick={() => {
          if (confirm(`Remove credential "${credential.id}"?`)) remove.mutate();
        }}
      >
        Remove
      </button>
    </div>
  );
}

/**
 * Token input with a reveal toggle.
 *
 * Masked by default because these get typed with people watching. `existingHint` is the
 * masked tail the server reports for a token already stored — enough to recognise which one
 * it is without the server ever sending it back.
 */
function SecretField({
  label,
  value,
  onChange,
  placeholder,
  existingHint,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  existingHint?: string | null;
  hint?: ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <label>
      <span className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {label}
        {existingHint && (
          <span className="tag mono" title="the token currently stored">
            {existingHint}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            className="ghost"
            style={{ padding: '0 6px', fontSize: 11, fontWeight: 600 }}
            onClick={() => setRevealed((current) => !current)}
            aria-pressed={revealed}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </span>
      </span>
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

const DEFAULT_HOST: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  generic: '',
};

/** The username a token is sent with. Wrong here means auth fails with a valid token. */
const DEFAULT_USERNAME: Record<string, string> = {
  github: 'pomni',
  gitlab: 'oauth2',
  bitbucket: 'x-token-auth',
  generic: 'pomni',
};

function CredentialDialog({
  credential,
  onClose,
  onSaved,
}: {
  credential: Credential;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(credential.name);
  const [provider, setProvider] = useState<string>(credential.provider);
  const [host, setHost] = useState(credential.host);
  const [username, setUsername] = useState(credential.username);
  const [kind, setKind] = useState<'gh-cli' | 'env' | 'file'>(credential.secretRef.kind);
  const [envVar, setEnvVar] = useState(
    credential.secretRef.kind === 'env' ? credential.secretRef.var : 'GITLAB_TOKEN',
  );
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const keepsExistingToken = kind === 'file' && credential.secretRef.kind === 'file';

  const save = useMutation({
    mutationFn: () =>
      api.updateCredential(credential.id, {
        name,
        provider,
        host,
        username,
        secretRef:
          kind === 'env'
            ? { kind: 'env', var: envVar }
            : kind === 'gh-cli'
              ? { kind: 'gh-cli' }
              : { kind: 'file' },
        secret: kind === 'file' && token ? token : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
      onSaved();
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title={`Edit ${credential.id}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <label>
          <span className="lab">Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label>
          <span className="lab">Provider</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="github">github</option>
            <option value="gitlab">gitlab</option>
            <option value="bitbucket">bitbucket</option>
            <option value="generic">generic</option>
          </select>
        </label>
      </div>

      <label>
        <span className="lab">Host</span>
        <input value={host} onChange={(event) => setHost(event.target.value)} />
        <span className="hint">
          Include the port if the repo url has one
          (<span className="mono">git.example.com:3380</span>).
        </span>
      </label>

      <label>
        <span className="lab">Username</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder={DEFAULT_USERNAME[provider] ?? 'pomni'}
        />
        <span className="hint">
          <span className="mono">oauth2</span> for GitLab tokens. A deploy token needs its own
          username, like <span className="mono">gitlab+deploy-token-42</span>.
        </span>
      </label>

      <label>
        <span className="lab">Where the token comes from</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="gh-cli" disabled={provider !== 'github'}>
            GitHub CLI (gh auth token) — nothing stored
          </option>
          <option value="env">Environment variable — nothing stored</option>
          <option value="file">Store in Pomni (gitignored file)</option>
        </select>
        {kind !== 'file' && credential.secretRef.kind === 'file' && (
          <span className="hint">The token Pomni was storing will be forgotten.</span>
        )}
      </label>

      {kind === 'env' && (
        <label>
          <span className="lab">Variable name</span>
          <input value={envVar} onChange={(event) => setEnvVar(event.target.value)} />
          <span className="hint">
            Read by the server process, so set it before starting{' '}
            <span className="mono">pomni serve</span>.
          </span>
        </label>
      )}

      {kind === 'file' && (
        <SecretField
          label={keepsExistingToken ? 'Replace token' : 'Token'}
          value={token}
          onChange={setToken}
          placeholder={keepsExistingToken ? 'leave blank to keep the current one' : 'glpat-…'}
          existingHint={keepsExistingToken ? credential.secretHint : null}
          hint="Written to .pomni/credentials.secret.json, which is gitignored. The server never sends a token back — only the masked tail above."
        />
      )}

      {kind !== 'file' && credential.hasSecret && credential.secretHint && (
        <div className="detect-box">
          Currently resolving to <span className="mono">{credential.secretHint}</span> from{' '}
          {credential.secretRef.kind === 'env'
            ? `$${credential.secretRef.var}`
            : 'the GitHub CLI'}
          .
        </div>
      )}
    </Dialog>
  );
}

function AddCredentialDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('github');
  // Tracked so switching provider can update the default without discarding a typed host.
  const [host, setHost] = useState(DEFAULT_HOST.github ?? '');
  const [hostEdited, setHostEdited] = useState(false);
  const [username, setUsername] = useState('');
  const [kind, setKind] = useState<'gh-cli' | 'env' | 'file'>('gh-cli');
  const [envVar, setEnvVar] = useState('GITHUB_TOKEN');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const chooseProvider = (next: string) => {
    setProvider(next);
    if (!hostEdited) setHost(DEFAULT_HOST[next] ?? '');
    if (next !== 'github' && kind === 'gh-cli') setKind('env');
  };

  const create = useMutation({
    mutationFn: () =>
      api.createCredential({
        name,
        provider,
        host: host || undefined,
        username: username || undefined,
        secretRef:
          kind === 'env'
            ? { kind: 'env', var: envVar }
            : kind === 'gh-cli'
              ? { kind: 'gh-cli' }
              : { kind: 'file' },
        secret: kind === 'file' ? token : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="Add credential"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Add
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <label>
          <span className="lab">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="GitHub personal"
            autoFocus
          />
        </label>
        <label>
          <span className="lab">Provider</span>
          <select value={provider} onChange={(event) => chooseProvider(event.target.value)}>
            <option value="github">github</option>
            <option value="gitlab">gitlab</option>
            <option value="bitbucket">bitbucket</option>
            <option value="generic">generic</option>
          </select>
        </label>
      </div>

      <label>
        <span className="lab">Host</span>
        <input
          value={host}
          onChange={(event) => {
            setHost(event.target.value);
            setHostEdited(true);
          }}
          placeholder="git.example.com"
        />
        <span className="hint">
          Self-hosted? Put the real host here, including a port if the url has one
          (<span className="mono">git.example.com:3380</span>). A credential is matched to a
          repo by host, and the port is ignored when nothing matches exactly.
        </span>
      </label>

      <label>
        <span className="lab">Where the token comes from</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="gh-cli" disabled={provider !== 'github'}>
            GitHub CLI (gh auth token) — nothing stored
          </option>
          <option value="env">Environment variable — nothing stored</option>
          <option value="file">Store in Pomni (gitignored file)</option>
        </select>
      </label>

      <label>
        <span className="lab">Username (optional)</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder={DEFAULT_USERNAME[provider] ?? 'pomni'}
        />
        <span className="hint">
          Leave blank for a personal or project access token. A GitLab <em>deploy token</em> is
          the exception — it needs its own username, like{' '}
          <span className="mono">gitlab+deploy-token-42</span>.
        </span>
      </label>

      {kind === 'env' && (
        <label>
          <span className="lab">Variable name</span>
          <input value={envVar} onChange={(event) => setEnvVar(event.target.value)} />
          <span className="hint">
            Read when git needs it. The server must be able to see the variable, so set it
            before starting <span className="mono">pomni serve</span>.
          </span>
        </label>
      )}

      {kind === 'file' && (
        <SecretField
          label="Token"
          value={token}
          onChange={setToken}
          placeholder="glpat-… / ghp_…"
          hint="Written to .pomni/credentials.secret.json, which is gitignored. The server never sends it back."
        />
      )}
    </Dialog>
  );
}
