import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type LogEntry, type LogLevel } from './api';
import { useLanguage } from './i18n';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * What Pomni has been saying about itself.
 *
 * Not a run's log — those belong to a run and are read on its page. This is the server
 * talking: a sync that refused, a credential that would not resolve. It used to go to
 * whichever terminal started `serve`, which for a detached process is nobody.
 *
 * Reachable from the topbar rather than from inside a project, because the reason to open it
 * is usually that you do not yet know which project, or whether a project is involved at all.
 */
export function LogsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [level, setLevel] = useState<LogLevel>('info');
  const [q, setQ] = useState('');

  const logs = useQuery({
    queryKey: ['logs', level, q],
    queryFn: () => api.logs({ level, q: q.trim() || undefined }).then((result) => result.entries),
    // Only while it is open. The query is unmounted with the panel, so a closed panel costs
    // nothing — which is the whole of the "cheap when nobody is looking" requirement.
    refetchInterval: 3000,
  });

  const entries = logs.data ?? [];

  return (
    <aside className="logs-drawer" aria-label={t('logs.title')}>
      <div className="logs-head">
        <strong className="grow">{t('logs.title')}</strong>
        <select value={level} onChange={(event) => setLevel(event.target.value as LogLevel)}>
          {LEVELS.map((entry) => (
            <option key={entry} value={entry}>
              {t(`logs.level.${entry}` as never)}
            </option>
          ))}
        </select>
        <input
          value={q}
          placeholder={t('logs.search')}
          onChange={(event) => setQ(event.target.value)}
        />
        <button className="ghost" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>

      <div className="logs-body">
        {logs.isLoading ? (
          <p className="dim">{t('common.loading')}</p>
        ) : entries.length === 0 ? (
          <p className="dim">{t('logs.none')}</p>
        ) : (
          <ol className="logs-list">
            {entries.map((entry, index) => (
              <LogRow key={`${entry.at}-${index}`} entry={entry} />
            ))}
          </ol>
        )}
      </div>

      <RunLogs />
    </aside>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <li className={`log-row log-${entry.level}`}>
      <span className="dim mono log-at">{entry.at.slice(11, 19)}</span>
      <span className={`tag log-level-${entry.level}`}>{entry.level}</span>
      <span className="log-message">
        {entry.message}
        {entry.detail && <span className="dim mono log-detail"> {entry.detail}</span>}
      </span>
    </li>
  );
}

/**
 * A way through to the logs that are not this one.
 *
 * A run's output belongs to that run and already has a console that streams it — linking is
 * the point, not reimplementing it here. Only running runs are listed: a finished one is
 * reached from its project, and a list of every run that ever ran would bury the thing this
 * panel exists to show.
 */
function RunLogs() {
  const { t } = useLanguage();
  const running = useQuery({
    queryKey: ['logs-running-pipelines'],
    queryFn: () => api.listRunningPipelines().then((result) => result.runs),
    refetchInterval: 5000,
  });

  const runs = running.data ?? [];

  return (
    <div className="logs-foot dim">
      <div>{t('logs.about')}</div>
      {runs.length > 0 && (
        <div className="logs-runs">
          {t('logs.running')}:{' '}
          {runs.map((run, index) => (
            <span key={run.id}>
              {index > 0 && ', '}
              <Link to={`/p/${run.projectId}/console/${run.id}`}>
                {run.workflowName} <span className="mono">{run.id.slice(-8)}</span>
              </Link>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
