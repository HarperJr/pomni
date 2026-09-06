import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type Artifact,
  type ContextFile,
  type Question,
  type PipelineRun,
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

/**
 * The dot's colour: what the agent achieved, not merely that its turn ended.
 *
 * A step that finished while explaining it could not do the job used to look exactly like
 * one that did it. Green now means the agent said `done` and nothing less.
 */
function dotClass(step: PipelineStep): string {
  if (isLive(step) || step.status !== 'done') return `step-${step.status}`;
  return `outcome-${step.outcome}`;
}

const OUTCOME_NOTE: Record<string, string> = {
  partial: 'did some of it',
  blocked: 'could not do it',
  unknown: 'did not say whether it worked',
};

/** Start a run, and see the ones that already happened. */
export function PipelinePanel({ projectId }: { projectId: string }) {
  const [starting, setStarting] = useState(false);
  const queryClient = useQueryClient();

  const rerun = useMutation({
    mutationFn: (runId: string) => api.rerunPipeline(runId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['pipelines', projectId] }),
  });

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

      <Spend runs={runs.data ?? []} />

      {(runs.data ?? []).length === 0 ? (
        <div className="empty">
          {runnable.length === 0
            ? 'Attach a workflow whose agents all have prompts, then a task can be run through it.'
            : 'Nothing has run yet. Give the pipeline a task and watch it work.'}
        </div>
      ) : (
        (runs.data ?? []).map((run) => (
          <div className="run-entry" key={run.id}>
            <Link className="row" to={`/p/${projectId}/console/${run.id}`}>
              <div className="grow">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <RunBadge status={run.status} />
                  <span className="tag">{run.workflowName}</span>
                  <span className="truncate grow">{firstLine(run.task)}</span>
                </div>
                <div className="dim mono truncate">{run.result ?? run.error ?? ''}</div>
              </div>
              <span className="dim mono">{duration(run.durationMs)}</span>
            </Link>
            {/* A run that stopped without finishing the job is the one you came here to
                restart, so the button is on the row rather than a click away. */}
            {run.status !== 'running' && (run.status !== 'passed' || run.outcome !== 'done') && (
              <button
                className="ghost rerun"
                disabled={rerun.isPending}
                onClick={() => rerun.mutate(run.id)}
                title="Run it again, telling the agents how this attempt ended"
              >
                Run again
              </button>
            )}
            {run.status === 'running' && <LiveFlow runId={run.id} />}
          </div>
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

/**
 * The delegation tree of a run that is happening now, unfolded under its row.
 *
 * The console shows the same tree beside the transcript. Here it answers the one question
 * worth asking from the project page - who is working, on what, right now - without
 * leaving the page for it.
 */
function LiveFlow({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const scroller = useRef<HTMLDivElement | null>(null);

  const run = useQuery({
    queryKey: ['pipeline', runId],
    queryFn: () => api.getPipeline(runId).then((result) => result.run),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });

  // Polling keeps the tree honest if a frame is missed; the event stream is what makes an
  // agent light up the moment it starts.
  useEffect(() => {
    const source = new EventSource('/api/events');

    const onStep = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { runId?: string };
      if (data.runId !== runId) return;
      void queryClient.invalidateQueries({ queryKey: ['pipeline', runId] });
    };

    for (const type of [
      'pipeline.step.started',
      'pipeline.step.finished',
      'pipeline.flow',
      'pipeline.question.asked',
      'pipeline.question.answered',
      'pipeline.finished',
    ]) {
      source.addEventListener(type, onStep as EventListener);
    }

    return () => source.close();
  }, [runId, queryClient]);

  const asking = (run.data?.questions ?? []).filter((question) => question.status === 'open');
  const steps = run.data?.steps ?? [];
  const live = steps.filter(isLive);
  const done = steps.filter((step) => step.status === 'done').length;
  const working = live.map((step) => step.agentName).join(', ');

  // Follow the work as it moves down the tree, so the active agent stays in view.
  useEffect(() => {
    scroller.current?.querySelector('.flow-step.live')?.scrollIntoView({ block: 'nearest' });
  }, [working]);

  if (steps.length === 0 && asking.length === 0) {
    return <div className="flow dim">Waiting for the orchestrator to plan the work...</div>;
  }

  return (
    <div className="flow">
      {/* Asked here as well as in the console: this row is where you are looking when a run
          you started goes quiet, and the answer is what unblocks it. */}
      {asking.map((question) => (
        <QuestionBox key={question.id} question={question} runId={runId} />
      ))}

      <div className="flow-note">
        {live.length > 0 ? (
          <>
            <span className="dot spin" style={{ background: 'var(--warn)' }} />
            <strong>{working}</strong>
          </>
        ) : (
          <span className="dim">no agent is working - an orchestrator is deciding</span>
        )}
        <div className="spacer" />
        <span className="dim mono">
          {done}/{steps.length} done
        </span>
      </div>

      <div className="flow-steps" ref={scroller}>
        {steps.map((step) => (
          <div
            key={step.id}
            className={`flow-step${isLive(step) ? ' live' : ''}`}
            style={{ paddingLeft: 6 + step.depth * 16 }}
          >
            <span className={`dot ${dotClass(step)}${isLive(step) ? ' spin' : ''}`} />
            <span className="step-name">{step.agentName}</span>
            {step.role === 'orchestrator' && <span className="tag">orch</span>}
            <span className="dim truncate grow">{firstLine(step.task)}</span>
            <span className="dim mono step-meta">{duration(step.durationMs)}</span>
          </div>
        ))}
      </div>
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
  const [context, setContext] = useState<Array<{ name: string; content: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /** Read the picked files here; the browser is the only thing that can. */
  const attach = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;

    try {
      const read = await Promise.all(
        [...picked].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      setContext((current) => [...current, ...read]);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

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
        context: context.length > 0 ? context : undefined,
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

      <label>
        <span className="lab">Context files</span>
        <input
          type="file"
          multiple
          onChange={(event) => {
            void attach(event.target.value ? event.target.files : null);
            event.target.value = '';
          }}
        />
        {context.length > 0 && (
          <div className="chips">
            {context.map((file, index) => (
              <span className="chip" key={`${file.name}-${index}`}>
                <span className="mono">{file.name}</span>
                <span className="dim">{kb(file.content)}</span>
                <button
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setContext(context.filter((_, at) => at !== index))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <span className="hint">
          Text files — a spec, a log, a schema. Every agent in the workflow is given them, so
          attach what the work needs and not the whole repo.
        </span>
      </label>
    </Dialog>
  );
}

/** Size of an attachment as the agents will see it, not as it sits on disk. */
function kb(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  return bytes < 1000 ? `${bytes} B` : `${Math.round(bytes / 100) / 10} kB`;
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

  const rerun = useMutation({
    mutationFn: () => api.rerunPipeline(runId),
    // Straight into the new run: the old one is history the moment this starts.
    onSuccess: (result) => window.location.assign(`/p/${projectId}/console/${result.run.id}`),
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
      'pipeline.question.asked',
      'pipeline.question.answered',
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
          <Link className="crumb" to={`/p/${projectId}?block=runs`}>
            ← {projectId}
          </Link>
          <h1>{data.workflowName}</h1>
        </div>
        <div className="spacer" />
        <RunBadge status={data.status} />
        {data.status === 'running' ? (
          <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Stop
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => rerun.mutate()}
            disabled={rerun.isPending}
            title="Start again, telling the agents how this attempt ended"
          >
            {rerun.isPending ? 'Starting…' : 'Run again'}
          </button>
        )}
      </div>

      <div className="card">
        <div className="row">
          <div className="grow wrap">{data.task}</div>
          <span className="dim mono">
            {data.steps.length} step{data.steps.length === 1 ? '' : 's'}
            {active > 0 ? ` · ${active} running` : ''}
            {data.costUsd ? ` · $${data.costUsd.toFixed(3)}` : ''}
          </span>
        </div>

        {data.questions
          .filter((question) => question.status === 'open')
          .map((question) => (
            <QuestionBox key={question.id} question={question} runId={data.id} />
          ))}

        {data.context.length > 0 && (
          <div className="chips" style={{ marginTop: 10 }}>
            {data.context.map((file) => (
              <details className="chip attached" key={file.name}>
                <summary>
                  <span className="mono">{file.name}</span>
                  <span className="dim">{kb(file.content)}</span>
                </summary>
                <pre className="log">{file.content}</pre>
              </details>
            ))}
          </div>
        )}
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
                <span className={`dot ${dotClass(step)}${isLive(step) ? ' spin' : ''}`} />
                <span className="grow">
                  <span className="step-name">{step.agentName}</span>
                  {step.role === 'orchestrator' && <span className="tag">orch</span>}
                  {step.status === 'done' && step.outcome !== 'done' && (
                    <span className={`tag outcome-${step.outcome}`}>
                      {OUTCOME_NOTE[step.outcome]}
                    </span>
                  )}
                  <div className="dim truncate step-task">{firstLine(step.task)}</div>
                  <StepActions step={step} />
                  {step.unmet.map((entry, index) => (
                    <div className="unmet" key={index}>
                      {entry}
                    </div>
                  ))}
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
/**
 * What an agent did on the way to its answer.
 *
 * The transcript is what it said; this is what it ran. A session that spent ten minutes and
 * reported one paragraph is unreadable without it — you cannot tell whether it looked.
 */
/**
 * What one agent ran, folded into that agent.
 *
 * It used to be one list of everything, under everything, which grew with the run until the
 * page was mostly other agents' shell history. Each agent's own commands belong to it.
 */
function StepActions({ step }: { step: PipelineStep }) {
  if (step.actions.length === 0) return null;

  return (
    <details className="step-actions">
      <summary className="dim">
        {step.actions.length} command{step.actions.length === 1 ? '' : 's'}
      </summary>
      {step.actions.map((action, index) => (
        <div className="action" key={index}>
          <span className={`tag action-${kindOf(action.tool)}`}>{action.tool}</span>
          <span className="mono dim truncate grow">{action.detail}</span>
        </div>
      ))}
    </details>
  );
}

/** Tokens, in the shape a person reads: 1 234 567. */
function tokens(value: number): string {
  return value.toLocaleString('en-US').replace(/,/g, ' ');
}

/**
 * How much each recent run cost, as a bar against the heaviest.
 *
 * The question is not what one run cost, it is whether they are getting worse — so the shape
 * of the column matters more than any single number.
 */
function Spend({ runs }: { runs: PipelineRun[] }) {
  const recent = runs.filter((run) => run.inputTokens + run.outputTokens > 0).slice(0, 10);
  if (recent.length === 0) return null;

  const peak = Math.max(...recent.map((run) => run.inputTokens + run.outputTokens));
  const total = recent.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0);
  const cost = recent.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);

  return (
    <details className="spend">
      <summary>
        <strong>{tokens(total)}</strong> tokens over {recent.length} runs
        {cost > 0 && <span className="dim"> · ${cost.toFixed(2)}</span>}
      </summary>
      {[...recent].reverse().map((run) => {
        const spent = run.inputTokens + run.outputTokens;
        return (
          <div className="spend-row" key={run.id}>
            <span className="dim mono spend-when">{run.startedAt.slice(5, 16).replace('T', ' ')}</span>
            <span className="spend-bar" style={{ width: `${Math.max(2, (spent / peak) * 100)}%` }} />
            <span className="dim mono spend-n">{tokens(spent)}</span>
            <span className="dim truncate grow">{firstLine(run.task)}</span>
          </div>
        );
      })}
    </details>
  );
}


/** Shell, file, or something the agent reached for outside itself. */
function kindOf(tool: string): string {
  if (tool === 'Bash') return 'shell';
  if (tool.startsWith('mcp__') || tool === 'Skill') return 'reach';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'write';
  return 'read';
}

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

/**
 * A question the run is stopped on, and the box to answer it in.
 *
 * The run is polling for this answer, so the reply goes straight back into the agent's
 * conversation — there is nothing else to press afterwards.
 */
export function QuestionBox({ question, runId }: { question: Question; runId: string }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const attach = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    try {
      const read = await Promise.all(
        [...picked].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      setFiles((current) => [...current, ...read]);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const answer = useMutation({
    mutationFn: () => api.answerQuestion(question.id, text, files.length > 0 ? files : undefined),
    onSuccess: async () => {
      setText('');
      setFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['pipeline', runId] });
      await queryClient.invalidateQueries({ queryKey: ['questions'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <div className="question">
      <div className="question-head">
        <span className="dot spin" style={{ background: 'var(--warn)' }} />
        <strong>{question.agentName} is asking you</strong>
        <div className="spacer" />
        <span className="dim mono">the run is waiting</span>
      </div>

      <div className="question-text">{question.question}</div>

      <Alert kind="error">{error}</Alert>

      <div className="question-reply">
        <textarea
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Your answer — a sentence is usually enough."
          onKeyDown={(event) => {
            // Enter sends; the box is for a sentence, not an essay.
            if (event.key === 'Enter' && !event.shiftKey && text.trim()) {
              event.preventDefault();
              answer.mutate();
            }
          }}
          autoFocus
        />
        <button
          className="primary"
          onClick={() => answer.mutate()}
          disabled={(!text.trim() && files.length === 0) || answer.isPending}
        >
          {answer.isPending ? 'Sending…' : 'Answer'}
        </button>
      </div>

      <div className="question-files">
        <label className="attach">
          <input
            type="file"
            multiple
            onChange={(event) => {
              void attach(event.target.value ? event.target.files : null);
              event.target.value = '';
            }}
          />
        </label>
        {files.map((file, index) => (
          <span className="chip" key={`${file.name}-${index}`}>
            <span className="mono">{file.name}</span>
            <span className="dim">{kb(file.content)}</span>
            <button
              aria-label={`Remove ${file.name}`}
              onClick={() => setFiles(files.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </span>
        ))}
        <span className="hint" style={{ margin: 0 }}>
          A file answers as well as words — the agent that asked gets it now, and every agent
          after it gets it too.
        </span>
      </div>
    </div>
  );
}

/** A task is a whole spec; a one-line row shows its first line, not its first paragraph. */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? text;
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
