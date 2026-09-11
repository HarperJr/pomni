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
  type ProviderStatus,
  type Struggle,
  type WorkflowDetail,
} from './api';
import { Alert, Dialog, errorMessage } from './components';
import { WorkflowGraph } from './graph';
import { useLanguage } from './i18n';

export function WorkflowsPage() {
  const { t } = useLanguage();
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
        <h1>{t('workflows.title')}</h1>
        <div className="spacer" />
        <button onClick={() => setImporting(true)}>{t('workflows.import')}</button>
        <button className="primary" onClick={() => setCreating(true)}>
          {t('workflows.new')}
        </button>
      </div>

      {llm.data && !llm.data.configured && (
        <Alert kind="error">
          {t('workflows.noCredentials', { auth: llm.data.auth })}
        </Alert>
      )}

      {workflows.isError && <Alert kind="error">{errorMessage(workflows.error)}</Alert>}

      {workflows.data?.length === 0 && (
        <div className="card">
          <div className="empty">
            {t('workflows.empty')}
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
            <Connections workflow={workflow} all={workflows.data ?? []} />

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

/**
 * What feeds a workflow, and what it feeds.
 *
 * Only the Out edge is stored. In is everyone whose Out points here, so the two halves can
 * never contradict each other — and a workflow from another project appearing in your In is
 * exactly the signal that the pipe crosses projects.
 */
function inboundOf(workflow: WorkflowDetail, all: WorkflowDetail[]): WorkflowDetail[] {
  return all.filter((candidate) => candidate.handoffTo === workflow.id);
}

/** Where a handed-off run would land. */
function projectOf(workflow: WorkflowDetail): string {
  return workflow.projects.length > 0 ? ` · ${workflow.projects.join(', ')}` : '';
}

function Connections({ workflow, all }: { workflow: WorkflowDetail; all: WorkflowDetail[] }) {
  const { t } = useLanguage();
  const inbound = inboundOf(workflow, all);
  const out = all.find((candidate) => candidate.id === workflow.handoffTo);
  if (inbound.length === 0 && !out) return null;

  return (
    <div className="connections dim">
      {inbound.length > 0 && (
        <span>
          <strong>{t('workflows.in')}</strong> {inbound.map((source) => source.name).join(', ')}
        </span>
      )}
      {out && (
        <span>
          <strong>{t('workflows.out')}</strong> {out.name}
          {projectOf(out)}
        </span>
      )}
    </div>
  );
}

function NewWorkflowDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
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
      title={t('workflows.newTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('projects.create')}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">{t('workflows.name')}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </label>
      <label>
        <span className="lab">{t('workflows.purpose')}</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>
        <span className="lab">{t('workflows.suits')}</span>
        <input
          value={suits}
          onChange={(event) => setSuits(event.target.value)}
          placeholder={t('workflows.suitsPlaceholder')}
        />
        <span className="hint">{t('workflows.suitsHint')}</span>
      </label>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
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
      title={t('workflows.importTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!content.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            {t('workflows.import')}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">{t('workflows.file')}</span>
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
        <span className="lab">{t('workflows.orPaste')}</span>
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
  const { t } = useLanguage();
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
  if (!workflow.data) return <div className="dim">{t('common.loading')}</div>;

  const data = workflow.data;
  const inbound = inboundOf(data, all.data ?? []);
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
          <button>{t('workflows.export')}</button>
        </a>
        <button className="primary" onClick={() => setAdding(true)}>
          {t('workflows.addAgent')}
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete workflow "${data.name}"?`)) remove.mutate();
          }}
        >
          {t('workflows.delete')}
        </button>
      </div>

      {data.description && <p className="dim">{data.description}</p>}

      <div className="card">
        <div className="card-head">
          {t('workflows.howItRuns')}
          <div className="spacer" />
          <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>
            the entry orchestrator delegates downwards · click a node to edit it
          </span>
        </div>
        <div style={{ padding: '4px 12px' }}>
          <WorkflowGraph workflow={data} onSelect={setEditing} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          {t('workflows.inAndOut')}
          <div className="spacer" />
          <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>
            optional — where work arrives from, and where it goes next
          </span>
        </div>
        <div className="row">
          <div className="grow">
            <span className="lab">{t('workflows.in')}</span>
            <div className="dim">
              {inbound.length > 0
                ? inbound.map((source) => `${source.name}${projectOf(source)}`).join(', ')
                : 'nothing hands off to this workflow'}
            </div>
          </div>
          <div className="grow">
            <label style={{ margin: 0 }}>
              <span className="lab">{t('workflows.out')}</span>
              <select
                value={data.handoffTo ?? ''}
                onChange={(event) => handoff.mutate(event.target.value || null)}
              >
                <option value="">{t('workflows.outNothing')}</option>
                {(all.data ?? [])
                  .filter((candidate) => candidate.id !== data.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {projectOf(candidate)}
                    </option>
                  ))}
              </select>
              <span className="hint">{t('workflows.outHint')}</span>
            </label>
          </div>
        </div>
      </div>

      {data.problems.length > 0 && (
        <div className="card">
          <div className="card-head">{t('workflows.toFix')}</div>
          {data.problems.map((problem, index) => (
            <div className="row" key={index}>
              <span className="status-error">!</span>
              <div className="grow">{problem.message}</div>
            </div>
          ))}
        </div>
      )}

      <AgentGroup
        title={t('workflows.orchestrator')}
        hint="Plans the task, delegates to the agents below, and synthesises what comes back."
        agents={orchestrators}
        workflow={data}
        onEdit={setEditing}
      />

      <AgentGroup
        title={t('workflows.agents')}
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
  const { t } = useLanguage();
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
              {t('common.edit')}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function AddAgentDialog({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { t } = useLanguage();
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
      title={t('workflows.addAgentTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('common.add')}
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
        <span className="lab">{t('workflows.role')}</span>
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
  const { t } = useLanguage();
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [spec, setSpec] = useState(agent.spec);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [outputs, setOutputs] = useState(agent.outputs);
  const [struggle, setStruggle] = useState<Struggle>(agent.struggle);
  const [provider, setProvider] = useState<string>(agent.provider ?? '');
  const [granted, setGranted] = useState<string[]>([...agent.tools.mcp, ...agent.tools.cli]);
  const [files, setFiles] = useState(agent.tools.files);
  const [run, setRun] = useState(agent.tools.run);
  const [web, setWeb] = useState(agent.tools.web);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const queryClient = useQueryClient();

  const registry = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.listTools().then((result) => result.tools),
  });

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.listProviders(),
  });

  const needsClaudeCode = files || run || web || granted.length > 0;
  const runDefaultId = providers.data?.default ?? null;
  const runDefault = (providers.data?.providers ?? []).find((item) => item.id === runDefaultId);
  const selectedProvider = provider
    ? (providers.data?.providers ?? []).find((item) => item.id === provider)
    : runDefault;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });

  const save = useMutation({
    mutationFn: () =>
      api.updateAgent(workflowId, agent.id, {
        name,
        role,
        spec,
        prompt,
        outputs,
        struggle,
        provider,
        tools: {
          files,
          // A CLI tool is run through the shell, so granting one without that grants
          // nothing. Turn it on rather than saving a setting that cannot work.
          run: run || (registry.data ?? []).some(
            (tool) => granted.includes(tool.id) && tool.kind === 'cli',
          ),
          web,
          mcp: (registry.data ?? [])
            .filter((tool) => granted.includes(tool.id) && tool.kind === 'mcp')
            .map((tool) => tool.id),
          cli: (registry.data ?? [])
            .filter((tool) => granted.includes(tool.id) && tool.kind === 'cli')
            .map((tool) => tool.id),
        },
      }),
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
            {t('common.remove')}
          </button>
          <div className="spacer" style={{ marginRight: 'auto' }} />
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <label>
          <span className="lab">{t('workflows.name')}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span className="lab">{t('workflows.role')}</span>
          <select value={role} onChange={(event) => setRole(event.target.value as AgentRole)}>
            {AGENT_ROLES.map((option: AgentRole) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label>
          <span className="lab">{t('workflows.modelScale')}</span>
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
        </label>
        <label>
          <span className="lab">{t('workflows.provider')}</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">
              Run's provider{runDefault ? ` (${runDefault.label})` : ''}
            </option>
            {(providers.data?.providers ?? []).map((item) => {
              const incompatible = needsClaudeCode && item.kind !== 'claude-code';
              const disabled = !item.enabled || incompatible;
              return (
                <option key={item.id} value={item.id} disabled={disabled}>
                  {item.label}
                  {!item.enabled ? ' — disabled' : ''}
                  {item.enabled && incompatible ? ' — no tool loop, cannot run this agent' : ''}
                </option>
              );
            })}
          </select>
        </label>
      </div>
      <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        {STRUGGLE_NOTE[struggle]}{' '}
        {selectedProvider
          ? (() => {
              const model = resolveModel(selectedProvider, struggle);
              return model
                ? t('workflows.resolvesTo', {
                    provider: selectedProvider.label,
                    level: struggle,
                    model,
                  })
                : t('workflows.noModelConfigured', { provider: selectedProvider.label });
            })()
          : t('workflows.pickProvider')}
        {needsClaudeCode &&
          t('workflows.needsClaudeCode')}
      </div>

      <label>
        <span className="lab">{t('workflows.produces')}</span>
        <input
          value={outputs}
          onChange={(event) => setOutputs(event.target.value)}
          placeholder={t('workflows.producesPlaceholder')}
        />
        <span className="hint">
          Shown to the orchestrator when it decides what to delegate here.
        </span>
      </label>

      <label>
        <span className="lab">{t('workflows.mayUse')}</span>
        <div className="tags" style={{ marginTop: 2 }}>
          <button className={`tag toggle${files ? ' on' : ''}`} onClick={() => setFiles(!files)}>
            {files ? '✓ ' : '+ '}
            {t('workflows.useFiles')}
          </button>
          <button className={`tag toggle${run ? ' on' : ''}`} onClick={() => setRun(!run)}>
            {run ? '✓ ' : '+ '}
            {t('workflows.useRun')}
          </button>
          <button className={`tag toggle${web ? ' on' : ''}`} onClick={() => setWeb(!web)}>
            {web ? '✓ ' : '+ '}
            {t('workflows.useWeb')}
          </button>
          {(registry.data ?? []).map((tool) => {
            const on = granted.includes(tool.id);
            return (
              <button
                key={tool.id}
                className={`tag toggle${on ? ' on' : ''}`}
                title={tool.description || tool.id}
                onClick={() =>
                  setGranted(
                    on ? granted.filter((id) => id !== tool.id) : [...granted, tool.id],
                  )
                }
              >
                {on ? '✓ ' : '+ '}
                {tool.name}
              </button>
            );
          })}
        </div>
        <span className="hint">
          A tool also has to be attached to the project the run belongs to, on the Tools page.
          Its usage notes are added to this agent's prompt when the run starts.
        </span>
      </label>

      <label>
        <span className="lab">{t('workflows.spec')}</span>
        <textarea
          rows={7}
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          placeholder={t('workflows.specPlaceholder')}
        />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button
          className="primary"
          onClick={() => generate.mutate()}
          disabled={!spec.trim() || generate.isPending}
        >
          {generate.isPending ? t('workflows.generating') : t('workflows.generate')}
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
        <span className="lab">{t('workflows.prompt')}</span>
        <textarea
          ref={promptRef}
          rows={14}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="mono"
          placeholder={t('workflows.promptPlaceholder')}
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

/** Legacy struggle keys a provider may still carry, for the level each maps onto. */
const LEGACY_KEY: Record<Struggle, 'fast' | 'balanced' | 'deep' | 'max'> = {
  low: 'fast',
  medium: 'balanced',
  high: 'deep',
  max: 'max',
};

/**
 * Mirrors `resolveModel` in `packages/core/src/domain/provider.ts` — reimplemented here
 * because the web package hand-mirrors core's types rather than importing them.
 */
function resolveModel(provider: ProviderStatus, struggle: Struggle): string | null {
  const at = (level: Struggle): string | undefined =>
    provider.models[level] ?? provider.models[LEGACY_KEY[level]];

  const exact = at(struggle);
  if (exact) return exact;

  const index = STRUGGLE_LEVELS.indexOf(struggle);
  for (let distance = 1; distance < STRUGGLE_LEVELS.length; distance += 1) {
    for (const candidate of [STRUGGLE_LEVELS[index - distance], STRUGGLE_LEVELS[index + distance]]) {
      const model = candidate ? at(candidate) : undefined;
      if (model) return model;
    }
  }
  return null;
}

/** Attached pipelines, shown on the project page. */
export function ProjectWorkflows({ projectId }: { projectId: string }) {
  const { t } = useLanguage();
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
        {t('workflows.title')}
        <span className="dim" style={{ fontWeight: 400 }}>{attached.data?.length ?? 0}</span>
        <div className="spacer" />
        <button onClick={() => setPicking(true)}>{t('workflows.attach')}</button>
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
              {t('workflows.detach')}
            </button>
          </div>
        ))
      )}

      {picking && (
        <Dialog
          title={t('workflows.attachTitle')}
          onClose={() => setPicking(false)}
          footer={<button onClick={() => setPicking(false)}>{t('common.close')}</button>}
        >
          {available.length === 0 ? (
            <div className="empty">{t('workflows.nothingToAttach')}</div>
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
