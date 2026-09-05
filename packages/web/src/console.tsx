import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type Artifact,
  type PipelineRunDetail,
  type PipelineStep,
  type StepStatus,
  type WorkflowDetail,
} from './api';
import { Alert, Dialog, errorMessage } from './components';

const ACTIVE: StepStatus[] = ['pending', 'running'];

function isLive(step: PipelineStep): boolean {
  return ACTIVE.includes(step.status);
}

/** Start a run, and see the ones that already happened. */
export function PipelinePanel({ projectId }: { projectId: string }) {
  const [starting, setStarting] = useState(false);

  const runs = useQuery({
    queryKey: ['pipelines', projectId],
    queryFn: () => api.listPipelines(projectId).then((result) => result.runs),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'running') ? 2000 : false,
  });

  const workflows = useQuery({
    queryKey: ['project-workflows', projectId],
    queryFn: () => api.projectWorkflows(projectId).then((result) => result.workflows),
  });

  const runnable = (workflows.data ?? []).filter((workflow) => workflow.runnable);

  return (
    <div className="card">
      <div className="card-head">
        Agent runs
        <span className="dim" style={{ fontWeight: 400 }}>{runs.data?.length ?? 0}</span>
        <div className="spacer" />
        <button
          className="primary"
          disabled={runnable.length === 0}
          onClick={() => setStarting(true)}
          title={runnable.length === 0 ? 'no attached workflow is ready to run' : undefined}
        >
          Run a task
        </button>
      </div>

      {(runs.data ?? []).length === 0 ? (
        <div className="empty">
          {runnable.length === 0
            ? 'Attach a workflow whose agents all have prompts, then a task can be run through it.'
            : 'Nothing has run yet. Give the pipeline a task and watch it work.'}
        </div>
      ) : (
        (runs.data ?? []).map((run) => (
          <Link key={run.id} className="row" to={`/p/${projectId}/console/${run.id}`}>
            <div className="grow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RunBadge status={run.status} />
                <span className="tag">{run.workflowName}</span>
                <span className="truncate">{run.task}</span>
              </div>
              <div className="dim mono truncate">{run.result ?? run.error ?? ''}</div>
            </div>
            <span className="dim mono">{duration(run.durationMs)}</span>
          </Link>
        ))
      )}

      {starting && (
        <StartRunDialog
          projectId={projectId}
          workflows={runnable}
          onClose={() => setStarting(false)}
        />
      )}
    </div>
  );
}

function StartRunDialog({
  projectId,
  workflows,
  onClose,
}: {
  projectId: string;
  workflows: WorkflowDetail[];
  onClose: () => void;
}) {
  const [source, setSource] = useState<'item' | 'text'>('item');
  const [itemId, setItemId] = useState('');
  const [task, setTask] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Only what is actually open — running a done item is almost never what was meant.
  const items = useQuery({
    queryKey: ['items', projectId, false],
    queryFn: () => api.listItems(projectId, 'active').then((result) => result.items),
  });

  const chosen = (items.data ?? []).find((item) => item.id === itemId);

  const start = useMutation({
    mutationFn: () =>
      api.startPipeline(projectId, {
        // The item's spec is the task: an orchestrator given only a title has to invent the
        // requirements, and will.
        task: source === 'item' && chosen ? `${chosen.title}\n\n${chosen.body}` : task,
        itemId: source === 'item' ? itemId : undefined,
        workflowId: workflowId || undefined,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['pipelines', projectId] });
      onClose();
      // Straight into the console — watching it is the point.
      window.location.assign(`/p/${projectId}/console/${result.run.id}`);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="Run a task"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={(source === 'item' ? !itemId : !task.trim()) || start.isPending}
            onClick={() => start.mutate()}
          >
            Start
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="tabs">
        <button className={source === 'item' ? 'active' : ''} onClick={() => setSource('item')}>
          From the backlog
        </button>
        <button className={source === 'text' ? 'active' : ''} onClick={() => setSource('text')}>
          Describe it
        </button>
      </div>

      {source === 'item' ? (
        <label>
          <span className="lab">Item</span>
          <select value={itemId} onChange={(event) => setItemId(event.target.value)}>
            <option value="">Choose an item…</option>
            {(items.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.priority} · {item.title}
              </option>
            ))}
          </select>
          <span className="hint">
            Its problem and acceptance criteria become the task. The item moves to{' '}
            <strong>in progress</strong> when the run starts, and to <strong>in review</strong>{' '}
            if the gate passes afterwards.
          </span>
        </label>
      ) : (
        <label>
          <span className="lab">Task</span>
          <textarea
            rows={5}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="Users cannot reset their password when their email has changed. Work out what we should build."
            autoFocus
          />
          <span className="hint">
            Written for the orchestrator, which decides who to involve. Give it the problem,
            not the plan.
          </span>
        </label>
      )}

      {chosen && (
        <pre className="log" style={{ maxHeight: 180, marginBottom: 14 }}>
          {chosen.body.trim()}
        </pre>
      )}
      <label>
        <span className="lab">Workflow</span>
        <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
          <option value="">Choose from the task</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
        <span className="hint">
          Left automatic, the workflow whose hints match the task wins.
        </span>
      </label>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

interface LogLine {
  stepId: string;
  agentName: string;
  text: string;
  at: string;
}

/**
 * Watching a pipeline work.
 *
 * Two halves: the delegation tree on the left, where an agent lights up while it is running,
 * and the transcript on the right. Both are driven by the same event stream the CLI sees, so
 * the console shows what happened rather than a reconstruction of it.
 */
export function ConsolePage() {
  const { projectId = '', runId = '' } = useParams();
  const [log, setLog] = useState<LogLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  const run = useQuery({
    queryKey: ['pipeline', runId],
    queryFn: () => api.getPipeline(runId).then((result) => result.run),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelPipeline(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipeline', runId] }),
  });

  // Live events. The polling above keeps the tree honest even if a frame is missed; this is
  // what makes it feel immediate.
  useEffect(() => {
    const source = new EventSource('/api/events');

    const onStep = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as {
        runId?: string;
        stepId?: string;
        agentName?: string;
        chunk?: string;
        task?: string;
        type?: string;
      };
      if (data.runId !== runId) return;

      void queryClient.invalidateQueries({ queryKey: ['pipeline', runId] });

      if (data.chunk) {
        setLog((current) => [
          ...current,
          {
            stepId: data.stepId ?? '',
            agentName: data.agentName ?? '',
            text: data.chunk ?? '',
            at: new Date().toISOString(),
          },
        ]);
      }
    };

    for (const type of [
      'pipeline.step.started',
      'pipeline.step.output',
      'pipeline.step.finished',
      'pipeline.flow',
      'pipeline.finished',
    ]) {
      source.addEventListener(type, onStep as EventListener);
    }

    return () => source.close();
  }, [runId, queryClient]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'end' });
  }, [log, follow]);

  if (run.isError) return <Alert kind="error">{errorMessage(run.error)}</Alert>;
  if (!run.data) return <div className="dim">Loading…</div>;

  const data = run.data;
  const active = data.steps.filter(isLive).length;
  const shown = selected
    ? log.filter((line) => line.stepId === selected)
    : log;

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="crumb" to={`/p/${projectId}`}>
            ← {projectId}
          </Link>
          <h1>{data.workflowName}</h1>
        </div>
        <div className="spacer" />
        <RunBadge status={data.status} />
        {data.status === 'running' && (
          <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Stop
          </button>
        )}
      </div>

      <div className="card">
        <div className="row">
          <div className="grow">{data.task}</div>
          <span className="dim mono">
            {data.steps.length} step{data.steps.length === 1 ? '' : 's'}
            {active > 0 ? ` · ${active} running` : ''}
            {data.costUsd ? ` · $${data.costUsd.toFixed(3)}` : ''}
          </span>
        </div>
      </div>

      <div className="console">
        <div className="card console-tree">
          <div className="card-head">
            Agents
            {selected && (
              <button className="ghost" onClick={() => setSelected(null)}>
                Show all
              </button>
            )}
          </div>
          {data.steps.length === 0 ? (
            <div className="empty">Waiting for the orchestrator…</div>
          ) : (
            data.steps.map((step) => (
              <button
                key={step.id}
                className={`step-row${selected === step.id ? ' selected' : ''}`}
                style={{ paddingLeft: 12 + step.depth * 18 }}
                onClick={() => setSelected(selected === step.id ? null : step.id)}
              >
                <span className={`dot step-${step.status}${isLive(step) ? ' spin' : ''}`} />
                <span className="grow">
                  <span className="step-name">{step.agentName}</span>
                  {step.role === 'orchestrator' && <span className="tag">orch</span>}
                  <div className="dim truncate step-task">{step.task}</div>
                </span>
                <span className="dim mono step-meta">{duration(step.durationMs)}</span>
              </button>
            ))
          )}
        </div>

        <div className="card console-log">
          <div className="card-head">
            {selected
              ? data.steps.find((step) => step.id === selected)?.agentName
              : 'Transcript'}
            <div className="spacer" />
            <label className="dim" style={{ margin: 0, display: 'flex', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
                style={{ width: 'auto' }}
              />
              follow
            </label>
          </div>

          <div className="log-body">
            {shown.length === 0 && !selected && (
              <div className="empty">
                Output appears here as each agent replies. Click an agent to see only its turn.
              </div>
            )}

            {selected && shown.length === 0 && (
              <pre className="log">
                {data.steps.find((step) => step.id === selected)?.output ??
                  'This agent has not replied yet.'}
              </pre>
            )}

            {shown.map((line, index) => (
              <div className="log-entry" key={index}>
                <div className="log-agent">{line.agentName || agentFor(data, line.stepId)}</div>
                <pre className="log">{line.text}</pre>
              </div>
            ))}
            <div ref={bottom} />
          </div>
        </div>
      </div>

      {(data.gateStatus !== 'skipped' || data.itemStatus) && (
        <div className="card">
          <div className="row">
            <div className="grow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  className={`status status-${data.gateStatus === 'passed' ? 'ready' : 'error'}`}
                >
                  <span className="dot" />
                  gate {data.gateStatus}
                </span>
                {data.itemId && (
                  <Link to={`/p/${projectId}/items/${data.itemId}`}>
                    <span className="tag">
                      {data.itemId} → {data.itemStatus ?? 'unchanged'}
                    </span>
                  </Link>
                )}
              </div>
              {data.gateSummary && <div className="dim mono">{data.gateSummary}</div>}
            </div>
          </div>
        </div>
      )}

      {data.artifacts.length > 0 && <Artifacts artifacts={data.artifacts} />}

      {(data.result || data.error) && (
        <div className="card">
          <div className="card-head">{data.error ? 'Failed' : 'Result'}</div>
          <pre className="log" style={{ maxHeight: 'none' }}>
            {data.error ?? data.result}
          </pre>
        </div>
      )}
    </>
  );
}

/**
 * What the run produced: files it changed, and the merge request those changes are waiting
 * for. Agent answers are already in the transcript, so they are not repeated here.
 */
function Artifacts({ artifacts }: { artifacts: Artifact[] }) {
  const files = artifacts.filter((artifact) => artifact.kind === 'file');
  const reports = artifacts.filter((artifact) => artifact.kind === 'report');
  const links = reports.filter((artifact) => artifact.change === 'merge request');

  if (files.length === 0 && links.length === 0) return null;

  return (
    <div className="card">
      <div className="card-head">
        Artifacts
        <span className="dim" style={{ fontWeight: 400 }}>{files.length + links.length}</span>
      </div>

      {links.map((link) => (
        <div className="row" key={link.id}>
          <div className="grow">
            <a href={link.path ?? '#'} target="_blank" rel="noreferrer">
              <strong>Open a merge request</strong>
            </a>
            <div className="dim mono truncate">branch {link.name}</div>
          </div>
          <span className="tag">merge request</span>
        </div>
      ))}

      {files.map((file) => (
        <div className="row" key={file.id}>
          <div className="grow">
            <span className="mono">{file.path}</span>
          </div>
          <span className="tag">{file.change}</span>
        </div>
      ))}
    </div>
  );
}

function agentFor(run: PipelineRunDetail, stepId: string): string {
  return run.steps.find((step) => step.id === stepId)?.agentName ?? '';
}

function RunBadge({ status }: { status: string }) {
  const tone =
    status === 'passed'
      ? 'ready'
      : status === 'running'
        ? 'cloning'
        : status === 'cancelled'
          ? 'cloning'
          : 'error';

  return (
    <span className={`status status-${tone}`}>
      <span className={`dot${status === 'running' ? ' spin' : ''}`} />
      {status}
    </span>
  );
}

function duration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
