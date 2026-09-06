import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Repo, type Run, type RunStatus } from './api';
import { Alert, Dialog, errorMessage } from './components';

const ACTIVE: RunStatus[] = ['queued', 'running'];

export function isActive(run: Run): boolean {
  return ACTIVE.includes(run.status);
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const tone =
    status === 'passed'
      ? 'ready'
      : status === 'running' || status === 'queued'
        ? 'cloning'
        : status === 'cancelled'
          ? 'cloning'
          : 'error';

  return (
    <span className={`status status-${tone}`}>
      <span className={`dot${isActiveStatus(status) ? ' spin' : ''}`} />
      {status}
    </span>
  );
}

function isActiveStatus(status: RunStatus): boolean {
  return ACTIVE.includes(status);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Capability buttons on a repo row, plus the project-level gate button. */
export function RunControls({ projectId, repo }: { projectId: string; repo: Repo }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: (capability: string) => api.startRun({ project: projectId, capability, repoId: repo.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runs', projectId] }),
    onError: (caught) => setError(errorMessage(caught)),
  });

  const runnable = Object.entries(repo.capabilities)
    .filter(([, capability]) => !capability.background)
    .map(([name]) => name)
    .sort(byPreferredOrder);

  if (runnable.length === 0) return null;

  return (
    <div className="tags" style={{ marginTop: 8 }}>
      {runnable.slice(0, 6).map((capability) => (
        <button
          key={capability}
          className="ghost"
          style={{ padding: '2px 9px', fontSize: 12 }}
          disabled={start.isPending}
          onClick={() => start.mutate(capability)}
          title={repo.capabilities[capability]?.cmd}
        >
          ▸ {capability}
        </button>
      ))}
      {error && <span className="status-error" style={{ fontSize: 12 }}>{error}</span>}
    </div>
  );
}

const ORDER = ['test', 'typecheck', 'lint', 'build', 'e2e', 'install'];

function byPreferredOrder(a: string, b: string): number {
  const ai = ORDER.indexOf(a);
  const bi = ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

/** Recent runs for a project, shown under the repo list. */
export function RunList({ projectId, limit = 12 }: { projectId: string; limit?: number }) {
  const runs = useQuery({
    queryKey: ['runs', projectId],
    queryFn: () => api.listRuns({ project: projectId, limit }).then((result) => result.runs),
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 1000 : false),
  });

  if (runs.isError) return <Alert kind="error">{errorMessage(runs.error)}</Alert>;

  return (
    <div className="card">
      <div className="card-head">
        Runs
        <span className="dim" style={{ fontWeight: 400 }}>{runs.data?.length ?? 0}</span>
      </div>
      {(runs.data ?? []).length === 0 ? (
        <div className="empty">
          No runs yet. Press a capability button on a repo, or Verify to run the whole gate.
        </div>
      ) : (
        (runs.data ?? []).map((run) => (
          <Link key={run.id} className="row" to={`/p/${projectId}/runs/${run.id}`}>
            <div className="grow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RunStatusBadge status={run.status} />
                <strong>{run.repoId}</strong>
                <span className="tag">{run.capability}</span>
                <span className="dim">{run.summary ?? ''}</span>
              </div>
              <div className="mono dim truncate">{run.cmd}</div>
            </div>
            <span className="dim mono">{formatDuration(run.durationMs)}</span>
          </Link>
        ))
      )}
    </div>
  );
}

/** One run, with its log streamed from the server. */
export function RunPage() {
  const { projectId = '', runId = '' } = useParams();
  const [log, setLog] = useState('');
  const [live, setLive] = useState(true);
  const bottom = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.getRun(runId),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['run', runId] }),
  });

  // The log endpoint replays from the start, then follows — so a finished run renders the
  // whole thing and a live one keeps appending, through the same connection.
  useEffect(() => {
    setLog('');
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/log`);

    source.addEventListener('log', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { text: string };
      setLog((current) => current + data.text);
    });

    source.addEventListener('done', () => {
      setLive(false);
      source.close();
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
    });

    source.onerror = () => {
      setLive(false);
      source.close();
    };

    return () => source.close();
  }, [runId, queryClient]);

  useEffect(() => {
    if (live) bottom.current?.scrollIntoView({ block: 'end' });
  }, [log, live]);

  if (run.isError) return <Alert kind="error">{errorMessage(run.error)}</Alert>;
  if (!run.data) return <div className="dim">Loading…</div>;

  const { run: record, testResults } = run.data;
  const failures = testResults.filter((result) => result.status === 'failed');

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="crumb" to={`/p/${projectId}?block=checks`}>
            ← {projectId}
          </Link>
          <h1>
            {record.repoId} <span className="dim">{record.capability}</span>
          </h1>
        </div>
        <div className="spacer" />
        <RunStatusBadge status={record.status} />
        {isActive(record) && (
          <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel
          </button>
        )}
      </div>

      <div className="card">
        <div className="row">
          <div className="grow">
            <div className="mono">{record.cmd}</div>
            <div className="mono dim truncate">{record.cwd}</div>
          </div>
          <span className="dim mono">
            exit {record.exitCode ?? '—'} · {formatDuration(record.durationMs)}
          </span>
        </div>
        {record.summary && (
          <div className="row">
            <div className="grow">{record.summary}</div>
          </div>
        )}
      </div>

      {failures.length > 0 && (
        <div className="card">
          <div className="card-head">Failed tests<span className="dim" style={{ fontWeight: 400 }}>{failures.length}</span></div>
          {failures.slice(0, 25).map((failure, index) => (
            <div className="row" key={`${failure.suite}-${failure.name}-${index}`}>
              <div className="grow">
                <div>
                  <span className="dim">{failure.suite}</span> {failure.name}
                </div>
                {failure.message && <div className="mono dim">{failure.message.split('\n')[0]}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          Output
          <div className="spacer" />
          {live && <span className="dim" style={{ fontWeight: 400 }}>streaming…</span>}
        </div>
        <pre className="log">{log || '(no output yet)'}</pre>
        <div ref={bottom} />
      </div>
    </>
  );
}

/** Project-level gate button; shows the result inline. */
export function VerifyButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const verify = useMutation({
    mutationFn: (gate: 'default' | 'land') => api.verify(projectId, gate),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['runs', projectId] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <>
      <button onClick={() => setOpen(true)}>Verify</button>
      {open && (
        <Dialog
          title="Run the gate"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button onClick={() => setOpen(false)}>Cancel</button>
              <button className="primary" onClick={() => verify.mutate('default')} disabled={verify.isPending}>
                Run default gate
              </button>
            </>
          }
        >
          <Alert kind="error">{error}</Alert>
          <p className="dim">
            Runs each capability in the gate, in order, across every repo that declares it.
            It stops at the first failing capability — a red typecheck makes the test result moot.
          </p>
          <button onClick={() => verify.mutate('land')} disabled={verify.isPending}>
            Run land gate instead
          </button>
        </Dialog>
      )}
    </>
  );
}

/** Read-only doctor report. */
export function DoctorPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const report = useQuery({
    queryKey: ['doctor', projectId],
    queryFn: () => api.doctor(projectId).then((result) => result.report),
    enabled: open,
  });

  return (
    <>
      <button onClick={() => setOpen(true)}>Doctor</button>
      {open && (
        <Dialog
          title="Doctor"
          onClose={() => setOpen(false)}
          footer={<button onClick={() => setOpen(false)}>Close</button>}
        >
          {report.isLoading && <div className="dim">Checking…</div>}
          {report.isError && <Alert kind="error">{errorMessage(report.error)}</Alert>}
          {(report.data?.repos ?? []).map((repo) => (
            <div key={repo.repoId} style={{ marginBottom: 16 }}>
              <strong>{repo.repoId}</strong>
              {repo.checks.map((check) => (
                <div key={check.name} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                  <span
                    className={
                      check.status === 'ok'
                        ? 'status-ready'
                        : check.status === 'warn'
                          ? 'status-cloning'
                          : 'status-error'
                    }
                  >
                    {check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗'}
                  </span>
                  <span style={{ width: 120 }}>{check.name}</span>
                  <span className="dim truncate">{check.detail}</span>
                </div>
              ))}
            </div>
          ))}
        </Dialog>
      )}
    </>
  );
}
