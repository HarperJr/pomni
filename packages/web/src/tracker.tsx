import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Alert, RUNNING_PIPELINES_KEY, RunningBadge, errorMessage } from './components';
import { Board } from './board';
import { useLanguage } from './i18n';

/**
 * What is open, everywhere: every project on the left with its open count, the selected
 * project's backlog as cards on the right. One screen instead of clicking into each project.
 */
export function TrackerPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { t } = useLanguage();

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
  // the cards render exactly as they would without it. Its query key is deliberately not
  // a prefix of ['items', projectId] — that key gets invalidated by the SSE handler in
  // main.tsx on every run/pipeline event, and each refetch here shells out to git across
  // every in-scope repo. Kept fresh instead by a targeted invalidation in that same
  // app-wide handler, for exactly the events that can change a wave: an item's lifecycle,
  // or the project's repo set.
  const waves = useQuery({
    queryKey: ['waves', selected ?? ''],
    queryFn: () => api.listWaves(selected!),
    enabled: selected !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const running = useQuery({
    queryKey: RUNNING_PIPELINES_KEY,
    queryFn: () => api.listRunningPipelines().then((result) => result.runs),
    refetchInterval: false,
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
        <h1>{t('tracker.title')}</h1>
        <div className="spacer" />
      </div>

      {projects.isError && <Alert kind="error">{errorMessage(projects.error)}</Alert>}

      <div className="tracker">
        <div className="card tracker-projects">
          {list.length === 0 && !projects.isLoading && !projects.isError ? (
            <div className="row dim">
              {t('projects.empty')}
            </div>
          ) : (
            list.map((project, index) => (
              <button
                key={project.id}
                className={`tracker-project-row${project.id === selected ? ' selected' : ''}`}
                onClick={() => setSelected(project.id)}
              >
                <span className="grow truncate">{project.name}</span>
                <span className="dim mono tracker-count" title={t('projects.repoCount')}>
                  {project.repoCount}
                </span>
                <span className="dim mono tracker-count" title={t('projects.openCount')}>
                  {counts[index]?.data?.length ?? '—'}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="tracker-items">
          <div className="row" style={{ border: 'none', padding: '0 0 12px' }}>
            <strong className="grow truncate">
              {selectedProject ? selectedProject.name : t('tracker.backlog')}
            </strong>
            <button className="ghost" onClick={() => setShowAll((value) => !value)}>
              {showAll ? t('common.onlyActive') : t('common.showAll')}
            </button>
          </div>

          {items.isError && <Alert kind="error">{errorMessage(items.error)}</Alert>}

          {!selected ? (
            projects.isLoading ? (
              <div className="dim">{t('common.loading')}</div>
            ) : projects.isError ? null : (
              <div className="card">
                <div className="empty">{t('tracker.noProjects')}</div>
              </div>
            )
          ) : itemsData.length === 0 && !items.isLoading && !items.isError ? (
            <div className="card">
              <div className="empty">
                {showAll ? t('tracker.emptyAll') : t('tracker.emptyActive')}
              </div>
            </div>
          ) : (
            <Board
              projectId={selected}
              items={itemsData}
              running={running.data ?? []}
              waves={waveByItem}
              waitingOn={waitingOnByItem}
            />
          )}
        </div>
      </div>
    </>
  );
}
