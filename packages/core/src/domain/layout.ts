/**
 * Every path inside `.pomni/`, in one place. Pure string math — the doc store joins these
 * against the workspace root, so nothing here touches the filesystem.
 *
 * There is deliberately no registry file: the project list is derived by scanning
 * `projects/*&#47;project.yaml`. One less file to keep in sync, and creating a project
 * becomes a single-file write that needs no lock.
 */
export const layout = {
  config: 'config.yaml',
  credentials: 'credentials.yaml',
  secrets: 'credentials.secret.json',

  projectsDir: 'projects',
  projectDir: (projectId: string) => `projects/${projectId}`,
  project: (projectId: string) => `projects/${projectId}/project.yaml`,

  reposDir: (projectId: string) => `projects/${projectId}/repos`,
  repo: (projectId: string, repoId: string) => `projects/${projectId}/repos/${repoId}.yaml`,

  backlogDir: (projectId: string) => `projects/${projectId}/backlog`,
  backlogItem: (projectId: string, itemId: string) =>
    `projects/${projectId}/backlog/${itemId}.md`,

  /** Advisory lock for the few operations that write more than one file. */
  lock: '.lock',

  /** Pipelines. Outside `projects/` so one workflow can be attached to several. */
  providers: 'providers.yaml',

  workflowsDir: 'workflows',
  workflow: (workflowId: string) => `workflows/${workflowId}.yaml`,

  /** Run logs, one directory per run. Gitignored. */
  runsDir: 'runs',
  pipelineDir: (runId: string) => `runs/pipeline/${runId}`,
  pipelineStepLog: (runId: string, stepId: string) => `runs/pipeline/${runId}/${stepId}.md`,
  runDir: (runId: string) => `runs/${runId}`,
  runLog: (runId: string) => `runs/${runId}/output.log`,

  /** Append-only cross-process event stream. Gitignored. */
  events: 'events.ndjson',

  database: 'pomni.db',

  /** Clones live here. Gitignored — the workspace is derived state, never committed. */
  workspaceDir: 'workspace',
  workspaceProject: (projectId: string) => `workspace/${projectId}`,
  workspaceRepo: (projectId: string, repoId: string) => `workspace/${projectId}/${repoId}`,
} as const;

export const POMNI_DIR = '.pomni';
