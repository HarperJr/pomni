import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CredentialsPage, ProjectPage, ProjectsPage } from './pages';
import { ItemPage } from './items';
import { RunPage } from './runs';
import { ConsolePage } from './console';
import { ProvidersPage } from './providers';
import { WorkflowPage, WorkflowsPage } from './workflows';
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
      'pipeline.started',
      'pipeline.finished',
    ]) {
      source.addEventListener(type, refresh as EventListener);
    }

    return () => source.close();
  }, [client]);
}

/**
 * Which top-level section a path belongs to. The nav highlights by section, not by exact
 * path, so a project page still shows Projects as current.
 */
type Section = 'projects' | 'workflows' | 'providers' | 'credentials';

function sectionOf(pathname: string): Section {
  if (pathname === '/w' || pathname.startsWith('/w/')) return 'workflows';
  if (pathname.startsWith('/providers')) return 'providers';
  if (pathname.startsWith('/credentials')) return 'credentials';
  return 'projects';
}

const SECTION_ROOT: Record<Section, string> = {
  projects: '/',
  workflows: '/w',
  providers: '/providers',
  credentials: '/credentials',
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
          <SectionLink section="workflows">Workflows</SectionLink>
          <SectionLink section="providers">Providers</SectionLink>
          <SectionLink section="credentials">Credentials</SectionLink>
        </nav>
      </div>

      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/p/:projectId" element={<ProjectPage />} />
        <Route path="/p/:projectId/runs/:runId" element={<RunPage />} />
        <Route path="/p/:projectId/items/:itemId" element={<ItemPage />} />
        <Route path="/w" element={<WorkflowsPage />} />
        <Route path="/w/:workflowId" element={<WorkflowPage />} />
        <Route path="/p/:projectId/console/:runId" element={<ConsolePage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/credentials" element={<CredentialsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
