import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CredentialsPage, ProjectPage, ProjectsPage } from './pages';
import { ItemPage } from './items';
import { RunPage } from './runs';
import { ConsolePage } from './console';
import { ProvidersPage } from './providers';
import { ToolsPage } from './tools';
import { WorkflowPage, WorkflowsPage } from './workflows';
import { TrackerPage } from './tracker';
import { ChatPage } from './chat';
import './styles.css';

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

function Shell() {
  useServerEvents();
  const location = useLocation();
  const [chatting, setChatting] = useState(false);
  const [chatId, setChatId] = useState('');

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
          Pomni<span>project runtime</span>
        </div>
        <nav className="nav">
          <SectionLink section="projects">Projects</SectionLink>
          <SectionLink section="tracker">Tracker</SectionLink>
          <SectionLink section="workflows">Workflows</SectionLink>
          <SectionLink section="tools">Tools</SectionLink>
          <SectionLink section="providers">Providers</SectionLink>
          <SectionLink section="credentials">Credentials</SectionLink>
        </nav>
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

      {!chatting && (
        <button
          className="chat-fab"
          onClick={() => setChatting(true)}
          aria-expanded={false}
          aria-label="Open chat"
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
              aria-label="Close chat"
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
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}
