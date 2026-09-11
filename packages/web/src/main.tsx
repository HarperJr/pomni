import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, type RestartResult, type SystemHealth } from './api';
import { CredentialsPage, ProjectPage, ProjectsPage } from './pages';
import { RUNNING_PIPELINES_KEY } from './components';
import { ItemPage } from './items';
import { RunPage } from './runs';
import { ConsolePage } from './console';
import { ProvidersPage } from './providers';
import { ToolsPage } from './tools';
import { WorkflowPage, WorkflowsPage } from './workflows';
import { TrackerPage } from './tracker';
import { ChatPage } from './chat';
import './styles.css';
import { LanguagePicker, LanguageProvider, useLanguage } from './i18n';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, retry: false, refetchOnWindowFocus: true } },
});

/**
 * Live updates. The CLI and a Claude session write the same files this UI reads, so the
 * server pushes bus events over SSE and we invalidate rather than poll.
 */
function useServerEvents() {
  const client = useQueryClient();

  useEffect(() => {
    const source = new EventSource('/api/events');

    const refresh = (event: MessageEvent<string>) => {
      let projectId: string | undefined;
      try {
        projectId = (JSON.parse(event.data) as { projectId?: string }).projectId;
      } catch {
        // A malformed frame is not worth breaking the stream over.
      }
      void client.invalidateQueries({ queryKey: ['projects'] });
      void client.invalidateQueries({ queryKey: ['tools'] });
      if (projectId) {
        void client.invalidateQueries({ queryKey: ['project', projectId] });
        void client.invalidateQueries({ queryKey: ['runs', projectId] });
        void client.invalidateQueries({ queryKey: ['items', projectId] });
      }
    };

    for (const type of [
      'project.created',
      'project.updated',
      'project.removed',
      'repo.added',
      'repo.updated',
      'repo.removed',
      'run.started',
      'run.finished',
      'item.created',
      'item.changed',
      'item.transitioned',
      'item.removed',
      'workflow.changed',
      'tool.changed',
      'pipeline.started',
      'pipeline.question.asked',
      'pipeline.question.answered',
      'pipeline.finished',
    ]) {
      source.addEventListener(type, refresh as EventListener);
    }

    // Chat carries its own id, not a project's, so it gets a handler of its own rather than
    // being folded into `refresh` above.
    const refreshChat = (event: MessageEvent<string>) => {
      let chatId: string | undefined;
      try {
        chatId = (JSON.parse(event.data) as { chatId?: string }).chatId;
      } catch {
        // A malformed frame is not worth breaking the stream over.
      }
      void client.invalidateQueries({ queryKey: ['chats'] });
      if (chatId) void client.invalidateQueries({ queryKey: ['chat', chatId] });
    };

    for (const type of [
      'chat.changed',
      'chat.removed',
      'chat.message.chunk',
      'chat.action.started',
      'chat.action.finished',
      'chat.turn.finished',
    ]) {
      source.addEventListener(type, refreshChat as EventListener);
    }

    // The tracker's wave overlay (packages/web/src/tracker.tsx) needs its own query
    // invalidated on exactly the events that can change a wave: an item's lifecycle, or
    // the project's repo set. It is deliberately not folded into `refresh` above, which
    // also fires on run.* and pipeline.* — a wave recompute shells out to git per repo,
    // so it must not refetch on every one of those.
    const refreshWaves = (event: MessageEvent<string>) => {
      let projectId: string | undefined;
      try {
        projectId = (JSON.parse(event.data) as { projectId?: string }).projectId;
      } catch {
        // A malformed frame is not worth breaking the stream over.
      }
      if (projectId) void client.invalidateQueries({ queryKey: ['waves', projectId] });
    };

    for (const type of [
      'item.created',
      'item.changed',
      'item.transitioned',
      'item.removed',
      'repo.added',
      'repo.updated',
      'repo.removed',
    ]) {
      source.addEventListener(type, refreshWaves as EventListener);
    }

    // The running-pipelines badge (Projects grid, Tracker cards) needs refreshing on exactly
    // the two events that flip a run in or out of "running" — not the full list above, which
    // also fires on chat-adjacent project/tool changes that never change who is running.
    const refreshRunning = () => {
      void client.invalidateQueries({ queryKey: RUNNING_PIPELINES_KEY });
    };

    source.addEventListener('pipeline.started', refreshRunning as EventListener);
    source.addEventListener('pipeline.finished', refreshRunning as EventListener);

    return () => source.close();
  }, [client]);
}

/**
 * Which top-level section a path belongs to. The nav highlights by section, not by exact
 * path, so a project page still shows Projects as current.
 */
type Section = 'projects' | 'tracker' | 'workflows' | 'tools' | 'providers' | 'credentials' | 'chat';

function sectionOf(pathname: string): Section {
  if (pathname.startsWith('/tracker')) return 'tracker';
  if (pathname === '/w' || pathname.startsWith('/w/')) return 'workflows';
  if (pathname.startsWith('/tools')) return 'tools';
  if (pathname.startsWith('/providers')) return 'providers';
  if (pathname.startsWith('/credentials')) return 'credentials';
  if (pathname.startsWith('/chat')) return 'chat';
  return 'projects';
}

const SECTION_ROOT: Record<Section, string> = {
  projects: '/',
  tracker: '/tracker',
  workflows: '/w',
  tools: '/tools',
  providers: '/providers',
  credentials: '/credentials',
  chat: '/chat',
};

const storageKey = (section: Section) => `pomni:lastPath:${section}`;

function remember(section: Section, path: string): void {
  try {
    localStorage.setItem(storageKey(section), path);
  } catch {
    // Private windows and blocked site data: navigation still works, it just forgets.
  }
}

function recall(section: Section): string {
  try {
    return localStorage.getItem(storageKey(section)) ?? SECTION_ROOT[section];
  } catch {
    return SECTION_ROOT[section];
  }
}

/**
 * Nav that returns you to where you were.
 *
 * Clicking Projects after opening one should go back to that project, not to the list —
 * losing your place every time you glance at another tab is a small thing that gets
 * irritating fast.
 */
function SectionLink({ section, children }: { section: Section; children: ReactNode }) {
  const location = useLocation();
  const current = sectionOf(location.pathname);
  const target = current === section ? SECTION_ROOT[section] : recall(section);

  return (
    <Link to={target} className={current === section ? 'active' : ''}>
      {children}
    </Link>
  );
}

type RunsInFlightResult = Extract<RestartResult, { outcome: 'runs-in-flight' }>;
type BuildFailedResult = Extract<RestartResult, { outcome: 'build-failed' }>;

/** What the footer shows below its strip while a restart needs a decision or is under way. */
type RestartPanel =
  | { kind: 'confirm'; runs: RunsInFlightResult['runs'] }
  | { kind: 'build-failed'; build: BuildFailedResult['build'] }
  | { kind: 'unsupported'; detail: string }
  | { kind: 'timed-out' };

const RESTART_POLL_TIMEOUT_MS = 90_000;
const RESTART_POLL_INTERVAL_MS = 2_000;

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : 'unknown';
}

/**
 * A quiet strip for the state of the tool itself.
 *
 * Its first job is the reload: Pomni rebuilds its own web while you are looking at it, and
 * until now the instruction was "press Ctrl+Shift+R" — a keyboard shortcut standing in for a
 * missing button. It has room for whatever belongs here next.
 *
 * There are two kinds of stale, and only one of them fixes with a browser reload: the tab
 * can be behind the bundle the server is serving, or the server itself can be behind the repo
 * because nothing rebuilt and relaunched it since the last merge. The footer says which.
 */
function Footer() {
  const [loaded] = useState(() => document.querySelector('script[src*="assets/"]')?.getAttribute('src') ?? '');
  const [panel, setPanel] = useState<RestartPanel | null>(null);
  const [pollingSince, setPollingSince] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const pollGeneration = useRef(0);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    refetchInterval: pollingSince ? false : 30_000,
  });

  useEffect(() => {
    if (pollingSince === null) return;

    const generation = ++pollGeneration.current;
    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;

    const tick = async () => {
      if (pollGeneration.current !== generation) return;
      try {
        const response = await fetch('/api/health');
        if (response.ok) {
          const data = (await response.json()) as SystemHealth;
          if (data.server.startedAt !== pollingSince) {
            window.location.reload();
            return;
          }
        }
      } catch {
        // The old process is gone and the new one has not opened its port yet. Expected —
        // keep polling rather than treating it as failure.
      }
      if (pollGeneration.current !== generation) return;
      if (Date.now() >= deadline) {
        setPollingSince(null);
        setPanel({ kind: 'timed-out' });
        return;
      }
      setTimeout(() => void tick(), RESTART_POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      pollGeneration.current++;
    };
  }, [pollingSince]);

  const build = health.data?.build ?? null;
  const server = health.data?.server ?? null;
  const tabStale = Boolean(build && loaded && !loaded.includes(build));
  const serverBehind = Boolean(server?.behindRepo);
  const unsupported = server?.supervision.mode === 'unsupported';

  const reload = async () => {
    // A plain reload can be served the cached document, which is the one case that matters
    // here. Re-fetch it first, then reload onto the fresh copy.
    try {
      await fetch(window.location.href, { cache: 'reload' });
    } catch {
      // Offline, or the server is restarting: reload anyway and let the browser say so.
    }
    window.location.reload();
  };

  const requestRestart = async (cancelInFlight?: boolean) => {
    if (!server) return;
    setPanel(null);
    setRestarting(true);
    const startedAt = server.startedAt;
    try {
      const result = await api.restartServer(cancelInFlight ? { cancelInFlight: true } : undefined);
      switch (result.outcome) {
        case 'unsupported':
          setPanel({ kind: 'unsupported', detail: result.supervision.detail });
          return;
        case 'runs-in-flight':
          setPanel({ kind: 'confirm', runs: result.runs });
          return;
        case 'build-failed':
          setPanel({ kind: 'build-failed', build: result.build });
          return;
        case 'restarting':
          setPollingSince(startedAt);
          return;
      }
    } finally {
      setRestarting(false);
    }
  };

  const statusLabel = (() => {
    if (pollingSince !== null) return 'waiting for the server to come back';
    if (tabStale && serverBehind) return 'your tab is behind the server, and the server is behind the repo';
    if (tabStale) return 'your tab is behind the server';
    if (serverBehind) return 'the server is behind the repo';
    return null;
  })();

  return (
    <div className="footer-wrap">
      {panel && (
        <div className="footer-panel">
          {panel.kind === 'confirm' && (
            <>
              <p>
                Restarting would kill {panel.runs.length === 1 ? 'a run' : 'these runs'} mid-step, leaving its
                worktree owned by a process that no longer exists:
              </p>
              <ul className="footer-runs">
                {panel.runs.map((run) => (
                  <li key={run.id}>
                    <span className="tag">{run.kind}</span> {run.what}
                    <span className="dim"> — started {new Date(run.startedAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
              <div className="footer-panel-actions">
                <button className="ghost" onClick={() => setPanel(null)}>
                  Never mind
                </button>
                <button className="danger" onClick={() => void requestRestart(true)}>
                  Cancel {panel.runs.length === 1 ? 'that run' : 'those runs'} and restart
                </button>
              </div>
            </>
          )}
          {panel.kind === 'build-failed' && (
            <>
              <p>
                The build failed, so the old server is still the one running. Nothing was restarted.
              </p>
              {panel.build.steps
                .filter((step) => step.exitCode !== 0)
                .map((step, index) => (
                  <div key={index}>
                    <div className="dim mono">
                      {step.cmd} — exit {step.exitCode ?? 'unknown'}
                    </div>
                    <pre className="log">{step.output}</pre>
                  </div>
                ))}
              <div className="footer-panel-actions">
                <button className="ghost" onClick={() => setPanel(null)}>
                  Dismiss
                </button>
              </div>
            </>
          )}
          {panel.kind === 'unsupported' && (
            <>
              <p>{panel.detail}</p>
              <div className="footer-panel-actions">
                <button className="ghost" onClick={() => setPanel(null)}>
                  Dismiss
                </button>
              </div>
            </>
          )}
          {panel.kind === 'timed-out' && (
            <>
              <p>The server did not come back within 90 seconds. It may still be starting, or it may need a look.</p>
              <div className="footer-panel-actions">
                <button className="ghost" onClick={() => setPanel(null)}>
                  Dismiss
                </button>
                <button className="primary" onClick={() => void reload()}>
                  Reload anyway
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="footer">
        <span className="dim mono">{build ?? 'build unknown'}</span>
        {server && (
          <span className="dim mono">
            running {shortCommit(server.startedAtCommit)}
            {serverBehind && <> — repo is at {shortCommit(server.headCommit)}</>}
          </span>
        )}
        {statusLabel && <span className="tag warn">{statusLabel}</span>}
        <div className="spacer" />
        {pollingSince !== null ? (
          <span className="dim">restarting…</span>
        ) : (
          <>
            {tabStale && (
              <button className={serverBehind ? 'ghost' : 'primary'} onClick={() => void reload()}>
                Reload
              </button>
            )}
            {serverBehind && !unsupported && (
              <button className="primary" disabled={restarting} onClick={() => void requestRestart()}>
                {restarting ? 'Restarting…' : 'Restart'}
              </button>
            )}
            {serverBehind && unsupported && !panel && (
              <span className="dim">{server?.supervision.detail}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Shell() {
  useServerEvents();
  const location = useLocation();
  const [chatting, setChatting] = useState(false);
  const [chatId, setChatId] = useState('');
  const { t } = useLanguage();

  // Escape closes it, as any modal should. Nothing about the page underneath changes, which
  // is the whole point: you ask a question without losing your place.
  useEffect(() => {
    if (!chatting) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChatting(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatting]);

  // Record every visit, so the nav can come back to the last page of each section.
  useEffect(() => {
    remember(sectionOf(location.pathname), location.pathname + location.search);
  }, [location.pathname, location.search]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          Pomni<span>{t('brand.tagline')}</span>
        </div>
        <nav className="nav">
          <SectionLink section="projects">{t('nav.projects')}</SectionLink>
          <SectionLink section="tracker">{t('nav.tracker')}</SectionLink>
          <SectionLink section="workflows">{t('nav.workflows')}</SectionLink>
          <SectionLink section="tools">{t('nav.tools')}</SectionLink>
          <SectionLink section="providers">{t('nav.providers')}</SectionLink>
          <SectionLink section="credentials">{t('nav.credentials')}</SectionLink>
        </nav>
        <LanguagePicker />
      </div>

      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/p/:projectId" element={<ProjectPage />} />
        <Route path="/p/:projectId/runs/:runId" element={<RunPage />} />
        <Route path="/p/:projectId/items/:itemId" element={<ItemPage />} />
        <Route path="/tracker" element={<TrackerPage />} />
        <Route path="/w" element={<WorkflowsPage />} />
        <Route path="/w/:workflowId" element={<WorkflowPage />} />
        <Route path="/p/:projectId/console/:runId" element={<ConsolePage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/credentials" element={<CredentialsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:chatId" element={<ChatPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <Footer />

      {!chatting && (
        <button
          className="chat-fab"
          onClick={() => setChatting(true)}
          aria-expanded={false}
          aria-label={t('chat.open')}
          title="Talk to Pomni"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
            <path
              d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.7A.75.75 0 0 1 4 19.1z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {chatting && (
        <div
          className="chat-backdrop"
          onMouseDown={(event) => {
            // Only a click on the backdrop itself: a drag that began inside the dialog and
            // ended out here is a text selection, not a dismissal.
            if (event.target === event.currentTarget) setChatting(false);
          }}
        >
        <div className="chat-overlay" role="dialog" aria-modal="true" aria-label="Chat">
          <div className="chat-overlay-head">
            <button
              className="chat-close"
              onClick={() => setChatting(false)}
              aria-label={t('chat.close')}
              title="Close"
            >
              <span aria-hidden="true">×</span>
            </button>
            <strong>Chat</strong>
            <span className="dim">Ask Pomni to do something, or to explain something</span>
            <div className="spacer" />
          </div>
          <div className="chat-overlay-body">
            <ChatPage chatId={chatId} onChoose={setChatId} />
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </LanguageProvider>
    </QueryClientProvider>,
  );
}
