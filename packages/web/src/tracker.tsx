import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Alert, errorMessage } from './components';
import { ItemStatusBadge } from './items';

/**
 * What is open, everywhere: every project on the left with its open count, the selected
 * project's backlog as cards on the right. One screen instead of clicking into each project.
 */
export function TrackerPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects().then((result) => result.projects),
  });

  const list = projects.data ?? [];

  // Pick a first project once the list arrives, and re-pick if the current selection
  // disappears (project removed) — but never stomp a selection the user already made.
  useEffect(() => {
    if (list.length === 0) {
      setSelected(null);
      return;
    }
    if (selected === null || !list.some((project) => project.id === selected)) {
      const first = list[0];
      if (!first) return;
      setSelected(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.data]);

  const counts = useQueries({
    queries: list.map((project) => ({
      queryKey: ['items', project.id, 'active'],
      queryFn: () => api.listItems(project.id, 'active').then((result) => result.items),
    })),
  });

  const items = useQuery({
    queryKey: ['items', selected ?? '', showAll ? 'all' : 'active'],
    queryFn: () =>
      api.listItems(selected!, showAll ? undefined : 'active').then((result) => result.items),
    enabled: selected !== null,
  });

  // A nice-to-have overlay on top of the item list above: if it is loading or errors,
  // the cards render exactly as they would without it.
  const waves = useQuery({
    queryKey: ['items', selected ?? '', 'waves'],
    queryFn: () => api.listWaves(selected!),
    enabled: selected !== null,
  });

  const waveByItem = new Map<string, number>();
  const waitingOnByItem = new Map<string, string[]>();
  for (const wave of waves.data?.waves ?? []) {
    for (const itemId of wave.itemIds) waveByItem.set(itemId, wave.index);
  }
  for (const blocked of waves.data?.blocked ?? []) {
    waitingOnByItem.set(blocked.itemId, blocked.waitingOn);
  }

  const selectedProject = list.find((project) => project.id === selected);
  const itemsData = items.data ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Tracker</h1>
        <div className="spacer" />
      </div>

      {projects.isError && <Alert kind="error">{errorMessage(projects.error)}</Alert>}

      <div className="tracker">
        <div className="card tracker-projects">
          {list.length === 0 && !projects.isLoading && !projects.isError ? (
            <div className="row dim">
              No projects yet. Add one to start tracking its backlog here.
            </div>
          ) : (
            list.map((project, index) => (
              <button
                key={project.id}
                className={`tracker-project-row${project.id === selected ? ' selected' : ''}`}
                onClick={() => setSelected(project.id)}
              >
                <span className="grow truncate">{project.name}</span>
                <span className="dim mono tracker-count" title="repos">{project.repoCount}</span>
                <span className="dim mono tracker-count" title="open items">
                  {counts[index]?.data?.length ?? '—'}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="tracker-items">
          <div className="row" style={{ border: 'none', padding: '0 0 12px' }}>
            <strong className="grow truncate">
              {selectedProject ? selectedProject.name : 'Backlog'}
            </strong>
            <button className="ghost" onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Only active' : 'Show all'}
            </button>
          </div>

          {items.isError && <Alert kind="error">{errorMessage(items.error)}</Alert>}

          {!selected ? (
            projects.isLoading ? (
              <div className="dim">Loading…</div>
            ) : projects.isError ? null : (
              <div className="card">
                <div className="empty">Nothing to track until a project exists.</div>
              </div>
            )
          ) : itemsData.length === 0 && !items.isLoading && !items.isError ? (
            <div className="card">
              <div className="empty">
                {showAll
                  ? 'This project has nothing in its backlog yet.'
                  : 'This project has nothing open right now.'}
              </div>
            </div>
          ) : (
            <div className="grid">
              {itemsData.map((item) => (
                <Link
                  key={item.id}
                  className="project-card"
                  to={`/p/${item.projectId}/items/${item.id}`}
                >
                  <h3>{item.title}</h3>
                  <div className="dim mono">{item.id}</div>
                  <div className="tags" style={{ marginTop: 8 }}>
                    <ItemStatusBadge status={item.status} />
                    <span className="tag">{item.priority}</span>
                    <span className="tag">{item.type}</span>
                    {item.repos.map((repo) => (
                      <span key={repo} className="tag">{repo}</span>
                    ))}
                    {waveByItem.has(item.id) && (
                      <span className="tag">wave {waveByItem.get(item.id)}</span>
                    )}
                    {waitingOnByItem.has(item.id) && (
                      <span
                        className="tag warn"
                        title={`waiting on ${waitingOnByItem.get(item.id)!.join(', ')}`}
                      >
                        blocked
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
