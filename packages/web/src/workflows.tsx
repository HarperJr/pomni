import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  AGENT_ROLES,
  STRUGGLE_LEVELS,
  STRUGGLE_NOTE,
  type Agent,
  type AgentRole,
  type Struggle,
  type WorkflowDetail,
} from './api';
import { Alert, Dialog, errorMessage } from './components';
import { HandoffPicker, WorkflowGraph, WorkflowMap } from './graph';

export function WorkflowsPage() {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.listWorkflows().then((result) => result.workflows),
  });

  const llm = useQuery({ queryKey: ['llm'], queryFn: () => api.llmStatus() });

  return (
    <>
      <div className="page-head">
        <h1>Workflows</h1>
        <div className="spacer" />
        <button onClick={() => setImporting(true)}>Import</button>
        <button className="primary" onClick={() => setCreating(true)}>
          New workflow
        </button>
      </div>

      {llm.data && !llm.data.configured && (
        <Alert kind="error">
          No model credentials — {llm.data.auth}. Agents can be authored without them, but
          generating a prompt or running a pipeline needs them.
        </Alert>
      )}

      {workflows.isError && <Alert kind="error">{errorMessage(workflows.error)}</Alert>}

      {workflows.data?.length === 0 && (
        <div className="card">
          <div className="empty">
            No pipelines yet. A workflow is one orchestrator that plans and delegates, plus the
            agents it can call.
          </div>
        </div>
      )}

      {(workflows.data ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            How they connect
            <div className="spacer" />
            <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>
              an arrow is a handoff — what the next pipeline picks up
            </span>
          </div>
          <div style={{ padding: '4px 12px' }}>
            <WorkflowMap workflows={workflows.data ?? []} />
          </div>
        </div>
      )}

      <div className="grid">
        {(workflows.data ?? []).map((workflow) => (
          <Link key={workflow.id} className="project-card" to={`/w/${workflow.id}`}>
            <h3>{workflow.name}</h3>
            <div className="dim mono">{workflow.id}</div>
            {workflow.description && (
              <div className="dim" style={{ marginTop: 6, fontSize: 13 }}>
                {workflow.description}
              </div>
            )}
            <div className="tags" style={{ marginTop: 12 }}>
              {workflow.agents.length === 0 && <span className="dim">no agents</span>}
              {workflow.agents.map((agent) => (
                <span key={agent.id} className="tag">
                  {agent.role === 'orchestrator' ? '◆ ' : ''}
                  {agent.name}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <span className={`status status-${workflow.runnable ? 'ready' : 'cloning'}`}>
                <span className="dot" />
                {workflow.runnable ? 'ready' : `${workflow.problems.length} to fix`}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {creating && <NewWorkflowDialog onClose={() => setCreating(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}

function NewWorkflowDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [suits, setSuits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createWorkflow({
        name,
        description: description || undefined,
        suits: suits ? suits.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/w/${result.workflow.id}`);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="New workflow"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </label>
      <label>
        <span className="lab">What it is for</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>
        <span className="lab">Suits</span>
        <input
          value={suits}
          onChange={(event) => setSuits(event.target.value)}
          placeholder="bug, regression, hotfix"
        />
        <span className="hint">
          Comma-separated hints. When a task does not name a workflow, these are matched
          against the task text to pick one.
        </span>
      </label>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const load = async (file: File) => setContent(await file.text());

  const run = useMutation({
    mutationFn: () => api.importWorkflow(content),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/w/${result.workflow.id}`);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="Import a workflow"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!content.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            Import
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">File</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void load(file);
          }}
        />
        <span className="hint">
          A file written by Export. If the id is taken, the import is renamed rather than
          refused.
        </span>
      </label>
      <label>
        <span className="lab">Or paste it</span>
        <textarea
          rows={8}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="mono"
        />
      </label>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// One workflow
// ---------------------------------------------------------------------------

export function WorkflowPage() {
  const { workflowId = '' } = useParams();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workflow = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => api.getWorkflow(workflowId).then((result) => result.workflow),
  });

  const all = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.listWorkflows().then((result) => result.workflows),
  });

  const handoff = useMutation({
    mutationFn: (handoffTo: string | null) => api.updateWorkflow(workflowId, { handoffTo }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteWorkflow(workflowId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate('/w');
    },
  });

  if (workflow.isError) return <Alert kind="error">{errorMessage(workflow.error)}</Alert>;
  if (!workflow.data) return <div className="dim">Loading…</div>;

  const data = workflow.data;
  const orchestrators = data.agents.filter((agent) => agent.role === 'orchestrator');
  const workers = data.agents.filter((agent) => agent.role === 'agent');

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="crumb" to="/w">
            ← Workflows
          </Link>
          <h1>{data.name}</h1>
        </div>
        <div className="spacer" />
        <a className="button-link" href={`/api/workflows/${workflowId}/export`} download>
          <button>Export</button>
        </a>
        <button className="primary" onClick={() => setAdding(true)}>
          Add agent
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete workflow "${data.name}"?`)) remove.mutate();
          }}
        >
          Delete
        </button>
      </div>

      {data.description && <p className="dim">{data.description}</p>}

      <div className="card">
        <div className="card-head">
          How it runs
          <div className="spacer" />
          <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>
            the entry orchestrator delegates downwards · click a node to edit it
          </span>
        </div>
        <div style={{ padding: '4px 12px' }}>
          <WorkflowGraph workflow={data} onSelect={setEditing} />
        </div>
        <div className="row">
          <div className="grow">
            <HandoffPicker
              workflow={data}
              workflows={all.data ?? []}
              onChange={(handoffTo) => handoff.mutate(handoffTo)}
            />
          </div>
        </div>
      </div>

      {data.problems.length > 0 && (
        <div className="card">
          <div className="card-head">To fix before this can run</div>
          {data.problems.map((problem, index) => (
            <div className="row" key={index}>
              <span className="status-error">!</span>
              <div className="grow">{problem.message}</div>
            </div>
          ))}
        </div>
      )}

      <AgentGroup
        title="Orchestrator"
        hint="Plans the task, delegates to the agents below, and synthesises what comes back."
        agents={orchestrators}
        workflow={data}
        onEdit={setEditing}
      />

      <AgentGroup
        title="Agents"
        hint="Each does one job and returns. They do not call each other."
        agents={workers}
        workflow={data}
        onEdit={setEditing}
      />

      {adding && <AddAgentDialog workflowId={workflowId} onClose={() => setAdding(false)} />}
      {editing && (
        <AgentEditor
          workflowId={workflowId}
          agent={data.agents.find((agent) => agent.id === editing)!}
          workflow={data}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function AgentGroup({
  title,
  hint,
  agents,
  workflow,
  onEdit,
}: {
  title: string;
  hint: string;
  agents: Agent[];
  workflow: WorkflowDetail;
  onEdit: (id: string) => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        {title}
        <span className="dim" style={{ fontWeight: 400 }}>{agents.length}</span>
      </div>
      {agents.length === 0 ? (
        <div className="empty">{hint}</div>
      ) : (
        agents.map((agent) => (
          <div className="row" key={agent.id}>
            <div className="grow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{agent.name}</strong>
                {workflow.entry === agent.id && <span className="tag">entry</span>}
                <span className="tag">{agent.struggle}</span>
                <span className={`status status-${agent.prompt ? 'ready' : 'error'}`}>
                  <span className="dot" />
                  {agent.prompt ? 'prompted' : 'no prompt'}
                </span>
              </div>
              <div className="dim truncate">{firstLine(agent.spec) || 'no spec yet'}</div>
            </div>
            <button className="ghost" onClick={() => onEdit(agent.id)}>
              Edit
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function AddAgentDialog({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('agent');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.addAgent(workflowId, { name, role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title="Add an agent"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Add
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </label>
      <label>
        <span className="lab">Role</span>
        <select value={role} onChange={(event) => setRole(event.target.value as AgentRole)}>
          {AGENT_ROLES.map((option: AgentRole) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span className="hint">
          An <strong>orchestrator</strong> plans and delegates to the others. An{' '}
          <strong>agent</strong> is a single node that does one job and returns.
        </span>
      </label>
    </Dialog>
  );
}

/** Spec on the left, generated prompt on the right, with the button between them. */
function AgentEditor({
  workflowId,
  agent,
  workflow,
  onClose,
}: {
  workflowId: string;
  agent: Agent;
  workflow: WorkflowDetail;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [spec, setSpec] = useState(agent.spec);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [outputs, setOutputs] = useState(agent.outputs);
  const [struggle, setStruggle] = useState<Struggle>(agent.struggle);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const queryClient = useQueryClient();

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });

  const save = useMutation({
    mutationFn: () =>
      api.updateAgent(workflowId, agent.id, { name, role, spec, prompt, outputs, struggle }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const remove = useMutation({
    mutationFn: () => api.removeAgent(workflowId, agent.id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  /**
   * Generating needs the spec that is on screen, not the one last saved — otherwise you
   * write a spec, press Generate, and get a prompt for the previous version.
   */
  const generate = useMutation({
    mutationFn: async () => {
      await api.updateAgent(workflowId, agent.id, { spec });
      return api.generatePrompt(workflowId, agent.id);
    },
    onSuccess: async (result) => {
      setPrompt(result.agent.prompt);
      setError(null);
      await refresh();
      promptRef.current?.scrollTo({ top: 0 });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  useEffect(() => {
    setPrompt(agent.prompt);
  }, [agent.prompt]);

  const stale = Boolean(agent.prompt) && spec !== agent.spec;

  return (
    <Dialog
      title={`${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Remove "${agent.name}" from this workflow?`)) remove.mutate();
            }}
          >
            Remove
          </button>
          <div className="spacer" style={{ marginRight: 'auto' }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <label>
          <span className="lab">Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span className="lab">Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as AgentRole)}>
            {AGENT_ROLES.map((option: AgentRole) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        <span className="lab">Model scale</span>
        <select
          value={struggle}
          onChange={(event) => setStruggle(event.target.value as Struggle)}
        >
          {STRUGGLE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <span className="hint">
          {STRUGGLE_NOTE[struggle]} Which model that is comes from the provider.
        </span>
      </label>

      <label>
        <span className="lab">What it produces</span>
        <input
          value={outputs}
          onChange={(event) => setOutputs(event.target.value)}
          placeholder="A unified diff / the cause with file references"
        />
        <span className="hint">
          Shown to the orchestrator when it decides what to delegate here.
        </span>
      </label>

      <label>
        <span className="lab">Spec — what this agent does, in your words</span>
        <textarea
          rows={7}
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          placeholder="Given a failing test and a repo, find the cause. Read the test, read the code it exercises, and report the specific line at fault. Do not propose a fix."
        />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button
          className="primary"
          onClick={() => generate.mutate()}
          disabled={!spec.trim() || generate.isPending}
        >
          {generate.isPending ? 'Writing the prompt…' : 'Generate prompt'}
        </button>
        {stale && !generate.isPending && (
          <span className="status-cloning" style={{ fontSize: 12 }}>
            the spec changed since this prompt was written
          </span>
        )}
        {role === 'orchestrator' && (
          <span className="dim" style={{ fontSize: 12 }}>
            written knowing it can delegate to{' '}
            {workflow.agents
              .filter((other) => other.id !== agent.id)
              .map((other) => other.name)
              .join(', ') || 'nobody yet'}
          </span>
        )}
      </div>

      <label>
        <span className="lab">System prompt — what the model receives</span>
        <textarea
          ref={promptRef}
          rows={14}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="mono"
          placeholder="Generated from the spec, or write it yourself."
        />
        <span className="hint">
          Edit it freely — generating again replaces it, but nothing else does.
        </span>
      </label>
    </Dialog>
  );
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

/** Attached pipelines, shown on the project page. */
export function ProjectWorkflows({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);

  const attached = useQuery({
    queryKey: ['project-workflows', projectId],
    queryFn: () => api.projectWorkflows(projectId).then((result) => result.workflows),
  });

  const all = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.listWorkflows().then((result) => result.workflows),
    enabled: picking,
  });

  const attach = useMutation({
    mutationFn: (workflowId: string) => api.attachWorkflow(projectId, workflowId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-workflows', projectId] });
      setPicking(false);
    },
  });

  const detach = useMutation({
    mutationFn: (workflowId: string) => api.detachWorkflow(projectId, workflowId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-workflows', projectId] }),
  });

  const available = (all.data ?? []).filter(
    (workflow) => !(attached.data ?? []).some((item) => item.id === workflow.id),
  );

  return (
    <div className="card">
      <div className="card-head">
        Workflows
        <span className="dim" style={{ fontWeight: 400 }}>{attached.data?.length ?? 0}</span>
        <div className="spacer" />
        <button onClick={() => setPicking(true)}>Attach</button>
      </div>

      {(attached.data ?? []).length === 0 ? (
        <div className="empty">
          No agent pipelines attached. Attach one or more — a task picks whichever fits.
        </div>
      ) : (
        (attached.data ?? []).map((workflow) => (
          <div className="row" key={workflow.id}>
            <div className="grow">
              <Link to={`/w/${workflow.id}`}>
                <strong>{workflow.name}</strong>
              </Link>
              <div className="dim mono">
                {workflow.agents.length} agents
                {workflow.suits.length > 0 ? ` · suits ${workflow.suits.join(', ')}` : ''}
              </div>
            </div>
            <span className={`status status-${workflow.runnable ? 'ready' : 'cloning'}`}>
              <span className="dot" />
              {workflow.runnable ? 'ready' : 'incomplete'}
            </span>
            <button className="ghost danger" onClick={() => detach.mutate(workflow.id)}>
              Detach
            </button>
          </div>
        ))
      )}

      {picking && (
        <Dialog
          title="Attach a workflow"
          onClose={() => setPicking(false)}
          footer={<button onClick={() => setPicking(false)}>Close</button>}
        >
          {available.length === 0 ? (
            <div className="empty">Nothing left to attach.</div>
          ) : (
            available.map((workflow) => (
              <div className="row" key={workflow.id}>
                <div className="grow">
                  <strong>{workflow.name}</strong>
                  <div className="dim">{workflow.description}</div>
                </div>
                <button onClick={() => attach.mutate(workflow.id)}>Attach</button>
              </div>
            ))
          )}
        </Dialog>
      )}
    </div>
  );
}
