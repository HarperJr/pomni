import { useEffect, type ReactNode } from 'react';
import type { PipelineRun, RepoStatus } from './api';
import { useLanguage } from './i18n';

/**
 * Shared by the Projects grid and the Tracker cards, so the two screens make one request for
 * "what is running anywhere" instead of each polling their own.
 */
export const RUNNING_PIPELINES_KEY = ['pipelines', 'running'] as const;

export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          {title}
          <span style={{ marginLeft: 'auto' }}>
            <button className="ghost" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </span>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<RepoStatus, string> = {
  ready: 'ready',
  linked: 'linked',
  cloning: 'cloning',
  error: 'error',
  missing: 'missing',
};

export function StatusBadge({ status }: { status: RepoStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className={`dot${status === 'cloning' ? ' spin' : ''}`} />
      {STATUS_TEXT[status]}
    </span>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'ok';
  children: ReactNode;
}) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

/**
 * A pulsing dot plus a count, shown on a project card or a tracker task card when a pipeline
 * is running for it. Always mounted — even with no runs — so its reserved height keeps the
 * grid from reflowing as runs start and finish.
 */
export function RunningBadge({ runs }: { runs: PipelineRun[] }) {
  const { plural } = useLanguage();
  if (runs.length === 0) return <div className="running-badge" />;

  const only = runs.length === 1 ? runs[0] : undefined;

  return (
    <div className="running-badge running-badge-active">
      <span className="dot spin" />
      {/* Through `plural`, not `n + ' running'`: Russian needs three forms where English
          needs one, and this is the first count the interface renders. */}
      {plural('projects.nRunning', runs.length)}
      {only ? ` · ${only.workflowName}` : ''}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'problem' in error) {
    const problem = (error as { problem: { title: string; detail?: string } }).problem;
    return problem.detail ? `${problem.title} — ${problem.detail}` : problem.title;
  }
  return error instanceof Error ? error.message : String(error);
}
