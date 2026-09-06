import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  type McpTransport,
  type ToolBody,
  type ToolCheckResult,
  type ToolKind,
  type ToolStatus,
} from './api';
import { Alert, Dialog, errorMessage } from './components';

const KIND_NOTE: Record<ToolKind, string> = {
  cli: 'A program on this machine. The agent runs it through its shell, and may run only this one binary.',
  mcp: 'An MCP server. Its tools appear in the session directly, named mcp__<id>__*.',
};

/**
 * Tools an agent can be given: MCP servers and command-line programs.
 *
 * Two gates stand between a registered tool and an agent using it — the project has to be
 * given the tool, and the agent has to ask for it. This page is the first gate; the second
 * is on the agent, in its workflow. Both are shown here so a tool that will never reach
 * anyone is visible as such rather than looking configured.
 */
export function ToolsPage() {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ToolStatus | null>(null);
  const [checks, setChecks] = useState<Record<string, ToolCheckResult>>({});
  const queryClient = useQueryClient();

  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api.listTools() });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects().then((result) => result.projects),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tools'] });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeTool(id),
    onSuccess: refresh,
  });

  const check = useMutation({
    mutationFn: (ids?: string[]) => api.checkTools(ids),
    onSuccess: (result) =>
      setChecks((current) => ({
        ...current,
        ...Object.fromEntries(result.results.map((entry) => [entry.id, entry])),
      })),
  });

  const attach = useMutation({
    mutationFn: (input: { projectId: string; toolId: string; on: boolean }) =>
      input.on
        ? api.attachTool(input.projectId, input.toolId)
        : api.detachTool(input.projectId, input.toolId),
    onSuccess: refresh,
  });

  const list = tools.data?.tools ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Tools</h1>
        <div className="spacer" />
        <button
          className="ghost"
          onClick={() => check.mutate(undefined)}
          disabled={check.isPending || list.length === 0}
        >
          {check.isPending ? 'Checking…' : 'Check all'}
        </button>
        <button className="primary" onClick={() => setAdding(true)}>
          Add tool
        </button>
      </div>

      <Alert kind="info">
        A tool reaches an agent through two gates: the project is given it here, and the agent
        asks for it in its workflow. Only agents on a Claude Code provider can be given one —
        the API providers have no tool loop to hand it to.
      </Alert>

      {tools.isError && <Alert kind="error">{errorMessage(tools.error)}</Alert>}
      {check.isError && <Alert kind="error">{errorMessage(check.error)}</Alert>}

      {list.length === 0 && !tools.isLoading ? (
        <div className="card">
          <div className="row dim">
            Nothing registered yet. A tool is an MCP server or a command-line program — the
            Figma MCP, or a CLI an agent should be allowed to run.
          </div>
        </div>
      ) : (
        <div className="card">
          {list.map((tool) => (
            <div className="row" key={tool.id}>
              <div className="grow">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <strong>{tool.name}</strong>
                  <span className="tag">{tool.kind}</span>
                  <span className={`status status-${state(tool)}`}>
                    <span className="dot" />
                    {label(tool)}
                  </span>
                  {checks[tool.id] && (
                    <span
                      className={`status status-${
                        checks[tool.id]?.status === 'ok'
                          ? 'ready'
                          : checks[tool.id]?.status === 'failed'
                            ? 'error'
                            : 'linked'
                      }`}
                    >
                      <span className="dot" />
                      {checks[tool.id]?.detail}
                    </span>
                  )}
                </div>

                <div className="dim mono truncate">{points(tool)}</div>
                {tool.description && <div className="dim truncate">{tool.description}</div>}

                <div className="tags" style={{ marginTop: 6 }}>
                  {(projects.data ?? []).map((project) => {
                    const on = tool.projects.includes(project.id);
                    return (
                      <button
                        key={project.id}
                        className={`tag toggle${on ? ' on' : ''}`}
                        title={on ? `Take ${tool.id} away from ${project.id}` : `Give ${tool.id} to ${project.id}`}
                        onClick={() =>
                          attach.mutate({ projectId: project.id, toolId: tool.id, on: !on })
                        }
                      >
                        {on ? '✓ ' : '+ '}
                        {project.name}
                      </button>
                    );
                  })}
                  {!tool.usage && (
                    <span className="tag warn" title="Agents are told the tool exists but not how to drive it">
                      no usage written
                    </span>
                  )}
                </div>
              </div>

              <button className="ghost" onClick={() => check.mutate([tool.id])}>
                Check
              </button>
              <button className="ghost" onClick={() => setEditing(tool)}>
                Edit
              </button>
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`Remove "${tool.name}"? It is detached from every project.`)) {
                    remove.mutate(tool.id);
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && <ToolDialog onClose={() => setAdding(false)} />}
      {editing && <ToolDialog tool={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/**
 * Add and edit are the same form.
 *
 * The fields that matter change with the kind — a CLI has a binary, an MCP server has a
 * transport and an address — so the form follows the kind rather than showing every field
 * and letting most of them be wrong.
 */
function ToolDialog({ tool, onClose }: { tool?: ToolStatus; onClose: () => void }) {
  const [name, setName] = useState(tool?.name ?? '');
  const [kind, setKind] = useState<ToolKind>(tool?.kind ?? 'cli');
  const [description, setDescription] = useState(tool?.description ?? '');
  const [usage, setUsage] = useState(tool?.usage ?? '');
  const [bin, setBin] = useState(tool?.bin ?? '');
  const [transport, setTransport] = useState<McpTransport>(tool?.transport ?? 'stdio');
  const [command, setCommand] = useState(tool?.command ?? '');
  const [args, setArgs] = useState((tool?.args ?? []).join(' '));
  const [url, setUrl] = useState(tool?.url ?? '');
  const [credential, setCredential] = useState(tool?.credential ?? '');
  const [credentialEnv, setCredentialEnv] = useState(tool?.credentialEnv ?? '');
  const [check, setCheck] = useState(tool?.check ?? '');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api.listCredentials().then((result) => result.credentials),
  });

  const body = (): ToolBody => ({
    name,
    kind,
    description,
    usage,
    bin: kind === 'cli' ? bin : null,
    transport: kind === 'mcp' ? transport : null,
    command: kind === 'mcp' && transport === 'stdio' ? command : null,
    args: kind === 'mcp' && transport === 'stdio' ? args.split(' ').filter(Boolean) : [],
    url: kind === 'mcp' && transport !== 'stdio' ? url : null,
    credential: credential || null,
    credentialEnv: credential ? credentialEnv || null : null,
    check: check || null,
  });

  const save = useMutation({
    mutationFn: () => (tool ? api.updateTool(tool.id, body()) : api.createTool(body())),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tools'] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title={tool ? `Edit ${tool.name}` : 'Add a tool'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => save.mutate()}
            disabled={!name.trim() || save.isPending}
          >
            {tool ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <label>
          <span className="lab">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Figma CLI"
            autoFocus
          />
        </label>
        <label>
          <span className="lab">Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as ToolKind)}
            disabled={Boolean(tool)}
          >
            <option value="cli">Command-line program</option>
            <option value="mcp">MCP server</option>
          </select>
        </label>
      </div>
      <span className="hint" style={{ display: 'block', marginTop: -8, marginBottom: 14 }}>
        {KIND_NOTE[kind]}
      </span>

      {kind === 'cli' ? (
        <label>
          <span className="lab">Binary</span>
          <input
            value={bin}
            onChange={(event) => setBin(event.target.value)}
            placeholder="figma-cli"
          />
          <span className="hint">
            As it is spelled on PATH. The agent is permitted this one program and no other.
          </span>
        </label>
      ) : (
        <>
          <label>
            <span className="lab">Transport</span>
            <select
              value={transport}
              onChange={(event) => setTransport(event.target.value as McpTransport)}
            >
              <option value="stdio">stdio — Pomni spawns it</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>

          {transport === 'stdio' ? (
            <div className="field-row">
              <label>
                <span className="lab">Command</span>
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="npx"
                />
              </label>
              <label>
                <span className="lab">Arguments</span>
                <input
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="-y @some/mcp-server"
                />
              </label>
            </div>
          ) : (
            <label>
              <span className="lab">URL</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://mcp.figma.com/mcp"
              />
            </label>
          )}
        </>
      )}

      <label>
        <span className="lab">What it is for</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Drives Figma Desktop: variables, components, layout."
        />
      </label>

      <label>
        <span className="lab">How to drive it</span>
        <textarea
          rows={8}
          value={usage}
          onChange={(event) => setUsage(event.target.value)}
          placeholder={
            'Always start with `figma-cli status`…\n\nThe commands worth knowing, and the order a task uses them.'
          }
        />
        <span className="hint">
          Goes into the prompt of every agent granted this tool. An agent allowed to run a
          program but never told how will not use it well — this is the part worth writing.
        </span>
      </label>

      <div className="field-row">
        <label>
          <span className="lab">Credential</span>
          <select value={credential} onChange={(event) => setCredential(event.target.value)}>
            <option value="">None</option>
            {(credentials.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <span className="hint">The token stays where it lives; only its id is stored here.</span>
        </label>
        <label>
          <span className="lab">…goes in</span>
          <input
            value={credentialEnv}
            onChange={(event) => setCredentialEnv(event.target.value)}
            placeholder={transport === 'stdio' ? 'FIGMA_TOKEN' : 'Authorization'}
            disabled={!credential}
          />
          <span className="hint">
            {transport === 'stdio' || kind === 'cli'
              ? 'An environment variable on the process.'
              : 'A request header.'}
          </span>
        </label>
      </div>

      <label>
        <span className="lab">Check command</span>
        <input
          value={check}
          onChange={(event) => setCheck(event.target.value)}
          placeholder="figma-cli status"
        />
        <span className="hint">
          Run by Check. Exit zero means working — the last line of its output is shown.
        </span>
      </label>
    </Dialog>
  );
}

function state(tool: ToolStatus): string {
  if (!tool.enabled) return 'linked';
  return tool.usable ? 'ready' : 'error';
}

function label(tool: ToolStatus): string {
  if (!tool.enabled) return 'disabled';
  return tool.usable ? 'ready' : (tool.problems[0] ?? 'broken');
}

/** Where the tool points, in one line: a binary, a command, or an address. */
function points(tool: ToolStatus): string {
  if (tool.kind === 'cli') return tool.bin ?? '(no binary)';
  if (tool.transport === 'stdio') return [tool.command, ...tool.args].filter(Boolean).join(' ');
  return tool.url ?? '(no url)';
}
