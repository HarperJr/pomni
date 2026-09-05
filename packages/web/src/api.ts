export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  current?: unknown;
  errors?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly problem: Problem,
    readonly status: number,
  ) {
    super(problem.title);
    this.name = 'ApiError';
  }
}

export type RepoStatus = 'linked' | 'cloning' | 'ready' | 'error' | 'missing';
export type RepoRole = 'web' | 'api' | 'mobile' | 'desktop' | 'lib' | 'infra' | 'docs' | 'other';

export const REPO_ROLES: RepoRole[] = [
  'web',
  'api',
  'mobile',
  'desktop',
  'lib',
  'infra',
  'docs',
  'other',
];

export interface LocalSource {
  kind: 'local';
  path: string;
}

export interface GitSource {
  kind: 'git';
  url: string;
  ref?: string;
  credential?: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
}

export type RepoSource = LocalSource | GitSource;

export interface Capability {
  cmd: string;
  origin: 'detected' | 'manual';
  background?: boolean;
  port?: number;
}

export interface Stack {
  adapter: string;
  detected: string[];
  detectedAt: string;
}

export interface VcsInfo {
  isRepo: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
  remote: string | null;
  head: string | null;
  dirty: boolean;
}

export interface Repo {
  id: string;
  projectId: string;
  name: string;
  role: RepoRole;
  source: RepoSource;
  status: RepoStatus;
  stack: Stack | null;
  capabilities: Record<string, Capability>;
  vcs: VcsInfo | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  addedAt: string;
  updatedAt: string;
  workingDir: string;
  workingDirExists: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  itemPrefix: string;
  gates: { default: string[]; land: string[] };
  policy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  repoCount: number;
  repos: Array<Pick<Repo, 'id' | 'name' | 'role' | 'status' | 'stack'>>;
}

export interface Credential {
  id: string;
  name: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
  host: string;
  username: string;
  secretRef: { kind: 'env'; var: string } | { kind: 'gh-cli' } | { kind: 'file' };
  hasSecret: boolean;
  /** Masked tail of the token, e.g. `••••4f2a`. Never the whole thing. */
  secretHint: string | null;
  createdAt: string;
}

export type ItemStatus =
  | 'backlog'
  | 'specced'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled';

export type ItemType = 'feature' | 'bug' | 'chore' | 'spike' | 'refactor' | 'docs';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Estimate = 'XS' | 'S' | 'M' | 'L' | 'XL';

export const ITEM_STATUSES: ItemStatus[] = [
  'backlog',
  'specced',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
];
export const ITEM_TYPES: ItemType[] = ['feature', 'bug', 'chore', 'spike', 'refactor', 'docs'];
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export interface BacklogItem {
  id: string;
  projectId: string;
  title: string;
  type: ItemType;
  status: ItemStatus;
  priority: Priority;
  estimate: Estimate | null;
  repos: string[];
  labels: string[];
  dependsOn: string[];
  order: number;
  branch: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface BacklogItemDetail extends BacklogItem {
  blockedBy: string[];
  blocking: string[];
  sections: Record<string, string>;
  acceptance: { total: number; checked: number };
}

export type AgentRole = 'orchestrator' | 'agent';
export const AGENT_ROLES: AgentRole[] = ['orchestrator', 'agent'];
export type Struggle = 'low' | 'medium' | 'high' | 'max';

export const STRUGGLE_LEVELS: Struggle[] = ['low', 'medium', 'high', 'max'];

export const STRUGGLE_NOTE: Record<Struggle, string> = {
  low: 'Quick and cheap. Extraction, formatting, narrow lookups.',
  medium: 'The working default. Most agents belong here.',
  high: 'Planning, judgement, anything where being wrong is expensive.',
  max: 'Longest thinking on the strongest model. Reserve it for genuinely hard work.',
};

export type ProviderKind = 'claude-code' | 'anthropic' | 'openai';

export interface ModelMap {
  low?: string;
  medium?: string;
  high?: string;
  max?: string;
  fast?: string;
  balanced?: string;
  deep?: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: ModelMap;
  enabled: boolean;
  available: boolean;
  detail: string;
}

export type PipelineStatus = 'running' | 'passed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface PipelineStep {
  id: string;
  runId: string;
  parentStepId: string | null;
  agentId: string;
  agentName: string;
  role: string;
  model: string;
  task: string;
  status: StepStatus;
  output: string | null;
  error: string | null;
  depth: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface PipelineRun {
  id: string;
  projectId: string;
  workflowId: string;
  workflowName: string;
  providerId: string;
  itemId: string | null;
  task: string;
  status: PipelineStatus;
  result: string | null;
  error: string | null;
  gateStatus: 'skipped' | 'passed' | 'failed';
  gateSummary: string | null;
  itemStatus: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
}

export interface Artifact {
  id: string;
  runId: string;
  stepId: string | null;
  name: string;
  kind: 'answer' | 'file' | 'report';
  path: string | null;
  change: string | null;
  bytes: number;
  createdAt: string;
}

export interface PipelineRunDetail extends PipelineRun {
  steps: PipelineStep[];
  artifacts: Artifact[];
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  spec: string;
  prompt: string;
  promptGeneratedAt: string | null;
  struggle: Struggle;
  delegatesTo: string[];
  outputs: string;
  tools: { files: boolean; run: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowProblem {
  agentId: string | null;
  message: string;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string;
  handoffTo?: string | null;
  agents: Agent[];
  entry: string | null;
  suits: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  problems: WorkflowProblem[];
  runnable: boolean;
}

export type AssetKind = 'agent' | 'skill' | 'command' | 'rules';

export interface DiscoveredAsset {
  kind: AssetKind;
  id: string;
  name: string;
  description: string;
  repoId: string;
  path: string;
  struggle: Struggle | null;
  tools: string[];
  body: string;
}

export interface DiscoveryReport {
  projectId: string;
  scanned: Array<{ repoId: string; workingDir: string; found: number }>;
  assets: DiscoveredAsset[];
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled';

export interface Run {
  id: string;
  projectId: string;
  repoId: string;
  itemId: string | null;
  capability: string;
  cmd: string;
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  logPath: string;
  summary: string | null;
}

export interface TestResult {
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number | null;
  message: string | null;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorReport {
  projectId: string;
  status: CheckStatus;
  repos: Array<{
    repoId: string;
    name: string;
    status: CheckStatus;
    checks: Array<{ name: string; status: CheckStatus; detail: string }>;
  }>;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string | null;
  parent: string | null;
  home: string;
  roots: string[];
  entries: DirEntry[];
}

export interface DetectResult {
  path: string;
  detection: { adapter: string; detected: string[]; capabilities: Record<string, Capability> } | null;
  vcs: VcsInfo | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const problem = (body as Problem | null) ?? {
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
    };
    throw new ApiError(problem, response.status);
  }

  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; root: string; git: boolean }>('/api/health'),

  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),

  getProject: (id: string) =>
    request<{ project: Project & { repos: Repo[] }; rev: string }>(
      `/api/projects/${encodeURIComponent(id)}`,
    ),

  createProject: (body: { name: string; id?: string; description?: string }) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteProject: (id: string, purge: boolean) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}?purge=${purge}`, { method: 'DELETE' }),

  addRepo: (
    projectId: string,
    body: {
      source:
        | { kind: 'local'; path: string }
        | {
            kind: 'git';
            url: string;
            ref?: string;
            credential?: string;
            provider?: 'github' | 'gitlab' | 'bitbucket' | 'generic';
          };
      id?: string;
      name?: string;
      role?: RepoRole;
    },
  ) =>
    request<{ repo: Repo }>(`/api/projects/${encodeURIComponent(projectId)}/repos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  syncRepo: (projectId: string, repoId: string) =>
    request<{ repo: Repo }>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}/sync`,
      { method: 'POST' },
    ),

  updateRepo: (
    projectId: string,
    repoId: string,
    body: {
      name?: string;
      role?: RepoRole;
      url?: string;
      ref?: string | null;
      credential?: string | null;
      provider?: 'github' | 'gitlab' | 'bitbucket' | 'generic';
      reclone?: boolean;
    },
  ) =>
    request<{ repo: Repo }>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  removeRepo: (projectId: string, repoId: string, purge: boolean) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}?purge=${purge}`,
      { method: 'DELETE' },
    ),

  listCredentials: () => request<{ credentials: Credential[] }>('/api/credentials'),

  createCredential: (body: {
    name: string;
    provider?: string;
    host?: string;
    username?: string;
    secretRef: { kind: 'env'; var: string } | { kind: 'gh-cli' } | { kind: 'file' };
    secret?: string;
  }) =>
    request<{ credential: Credential }>('/api/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateCredential: (
    id: string,
    body: {
      name?: string;
      provider?: string;
      host?: string;
      username?: string;
      secretRef?: { kind: 'env'; var: string } | { kind: 'gh-cli' } | { kind: 'file' };
      secret?: string;
    },
  ) =>
    request<{ credential: Credential }>(`/api/credentials/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  testCredential: (id: string, url?: string) =>
    request<{ ok: boolean; message: string }>(`/api/credentials/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  removeCredential: (id: string) =>
    request<void>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listItems: (projectId: string, status?: string) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<{ items: BacklogItem[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/items${query}`,
    );
  },

  getItem: (projectId: string, itemId: string) =>
    request<{ item: BacklogItemDetail; rev: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
    ),

  createItem: (
    projectId: string,
    body: { title: string; type?: ItemType; priority?: Priority; repos?: string[] },
  ) =>
    request<{ item: BacklogItem }>(`/api/projects/${encodeURIComponent(projectId)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  transitionItem: (
    projectId: string,
    itemId: string,
    body: { to: ItemStatus; reason?: string; force?: boolean },
  ) =>
    request<{ item: BacklogItem }>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/transition`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  removeItem: (projectId: string, itemId: string) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),

  listWorkflows: () =>
    request<{ workflows: WorkflowDetail[]; scales: { struggle: Struggle; label: string; note: string }[] }>('/api/workflows'),

  getWorkflow: (id: string) =>
    request<{ workflow: WorkflowDetail; rev: string }>(`/api/workflows/${encodeURIComponent(id)}`),

  createWorkflow: (body: { name: string; description?: string; suits?: string[] }) =>
    request<{ workflow: WorkflowDetail }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateWorkflow: (
    id: string,
    body: { name?: string; description?: string; suits?: string[]; handoffTo?: string | null },
  ) =>
    request<{ workflow: WorkflowDetail }>(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteWorkflow: (id: string) =>
    request<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  importWorkflow: (content: string) =>
    request<{ workflow: WorkflowDetail }>('/api/workflows/import', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  addAgent: (workflowId: string, body: { name: string; role?: AgentRole }) =>
    request<{ agent: Agent }>(`/api/workflows/${encodeURIComponent(workflowId)}/agents`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateAgent: (
    workflowId: string,
    agentId: string,
    body: {
      name?: string;
      role?: AgentRole;
      spec?: string;
      prompt?: string;
      outputs?: string;
      struggle?: Struggle;
      delegatesTo?: string[];
    },
  ) =>
    request<{ agent: Agent }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  removeAgent: (workflowId: string, agentId: string) =>
    request<void>(
      `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' },
    ),

  generatePrompt: (workflowId: string, agentId: string) =>
    request<{ agent: Agent }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}/prompt`,
      { method: 'POST' },
    ),

  projectWorkflows: (projectId: string) =>
    request<{ workflows: WorkflowDetail[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows`,
    ),

  attachWorkflow: (projectId: string, workflowId: string) =>
    request<{ workflows: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    }),

  detachWorkflow: (projectId: string, workflowId: string) =>
    request<{ workflows: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
      { method: 'DELETE' },
    ),

  discover: (projectId: string) =>
    request<{ report: DiscoveryReport }>(
      `/api/projects/${encodeURIComponent(projectId)}/discover`,
    ),

  importDiscovered: (projectId: string, body: { workflowId: string; assetId: string }) =>
    request<{ imported: { agentId: string } }>(
      `/api/projects/${encodeURIComponent(projectId)}/discover/import`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  listProviders: () =>
    request<{ default: string | null; providers: ProviderStatus[] }>('/api/providers'),

  providerPresets: () =>
    request<{ presets: Array<{ id: string; label: string; kind: ProviderKind; baseUrl?: string; apiKeyEnv?: string; models: ModelMap; note: string }> }>(
      '/api/providers/presets',
    ),

  providerModels: (id: string) =>
    request<{ models: string[] }>(`/api/providers/${encodeURIComponent(id)}/models`),

  createProvider: (body: {
    label: string;
    kind: ProviderKind;
    baseUrl?: string;
    apiKeyEnv?: string;
    models?: Partial<Record<Struggle, string>>;
  }) =>
    request<{ provider: ProviderStatus }>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateProvider: (
    id: string,
    body: {
      label?: string;
      kind?: ProviderKind;
      baseUrl?: string;
      apiKeyEnv?: string;
      models?: Partial<Record<Struggle, string>>;
    },
  ) =>
    request<{ provider: ProviderStatus }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  removeProvider: (id: string) =>
    request<void>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  setDefaultProvider: (id: string) =>
    request<{ default: string }>(`/api/providers/${encodeURIComponent(id)}/default`, {
      method: 'POST',
    }),

  listPipelines: (projectId: string) =>
    request<{ runs: PipelineRun[] }>(`/api/projects/${encodeURIComponent(projectId)}/pipelines`),

  getPipeline: (runId: string) =>
    request<{ run: PipelineRunDetail }>(`/api/pipelines/${encodeURIComponent(runId)}`),

  startPipeline: (
    projectId: string,
    body: { task: string; workflowId?: string; itemId?: string },
  ) =>
    request<{ run: PipelineRun }>(`/api/projects/${encodeURIComponent(projectId)}/pipelines`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cancelPipeline: (runId: string) =>
    request<{ run: PipelineRun }>(`/api/pipelines/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
    }),

  llmStatus: () => request<{ configured: boolean; auth: string }>('/api/llm/status'),

  listRuns: (params: { project?: string; repo?: string; capability?: string; failed?: boolean; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.project) query.set('project', params.project);
    if (params.repo) query.set('repo', params.repo);
    if (params.capability) query.set('capability', params.capability);
    if (params.failed) query.set('failed', 'true');
    query.set('limit', String(params.limit ?? 30));
    return request<{ runs: Run[] }>(`/api/runs?${query.toString()}`);
  },

  getRun: (id: string) =>
    request<{ run: Run; testResults: TestResult[] }>(`/api/runs/${encodeURIComponent(id)}`),

  startRun: (body: { project: string; capability: string; repoId?: string }) =>
    request<{ accepted: boolean; capability: string; repos: string[] }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cancelRun: (id: string) =>
    request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  verify: (projectId: string, gate: 'default' | 'land' = 'default') =>
    request<{ accepted: boolean; gate: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/verify`,
      { method: 'POST', body: JSON.stringify({ gate }) },
    ),

  doctor: (projectId: string) =>
    request<{ report: DoctorReport }>(`/api/projects/${encodeURIComponent(projectId)}/doctor`),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  detect: (path: string) => request<DetectResult>(`/api/fs/detect?path=${encodeURIComponent(path)}`),
};
