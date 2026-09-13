import { z } from 'zod';
import {
  CHAT_ACTION_GROUPS,
  ChatActionGroupSchema,
  type ChatActionGroup,
} from '../domain/chat.js';
import { ValidationError } from '../domain/errors.js';
import type { BacklogService } from './backlog-service.js';
import type { CommentService } from './comment-service.js';
import type { CredentialService } from './credential-service.js';
import type { DiscoveryService } from './discovery-service.js';
import type { DoctorService } from './doctor-service.js';
import type { ProviderService } from './provider-service.js';
import type { WorktreeService } from './worktree-service.js';
import type { PipelineService } from './pipeline-service.js';
import type { ProjectService } from './project-service.js';
import type { RepoService } from './repo-service.js';
import type { RunService } from './run-service.js';
import type { ToolService } from './tool-service.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * What the assistant in a chat is allowed to do, and how.
 *
 * Every entry calls exactly one existing service method. Nothing here re-implements a rule:
 * `backlog.move` reaches `BacklogService.transition`, which is the same method the CLI, the
 * HTTP routes and the pipeline's automatic moves all arrive at, so the guards, the item log
 * and the events happen once and identically.
 *
 * `writes` is fixed here and nowhere else. The model names an action; it never declares what
 * that action does. A model that could label its own write as a read would route straight past
 * the confirmation the whole feature exists to keep in the way.
 */

/** The services an action may dispatch to. Assembled by `ChatService` from its own fields. */
export interface ChatActionServices {
  projects: ProjectService;
  repos: RepoService;
  backlog: BacklogService;
  workflows: WorkflowService;
  tools: ToolService;
  runs: RunService;
  pipelines: PipelineService;
  credentials: CredentialService;
  providers: ProviderService;
  worktrees: WorktreeService;
  discovery: DiscoveryService;
  doctor: DoctorService;
  comments: CommentService;
}

/**
 * One callable action, with its arguments erased.
 *
 * The catalogue is a heterogeneous list — every entry has a different argument schema — so the
 * list holds this erased shape and {@link define} restores the link between schema and handler
 * for the entry being written. Callers always go through `parseActionArgs`, which is the only
 * thing that turns `unknown` back into the handler's type.
 */
export interface ChatAction {
  /** `service.method` form, matching the method it calls. */
  name: string;
  /**
   * The group this action is listed under, or null for one that is always visible.
   *
   * Only `actions.expand` is ungrouped: it is how a group gets opened, so hiding it inside a
   * group would make the catalogue unreachable from itself.
   */
  group: ChatActionGroup | null;
  /** What the model reads to decide whether this is the action it wants. */
  description: string;
  args: z.ZodTypeAny;
  writes: boolean;
  /** The one-sentence confirm prompt: "Move backlog item POMN-21 to in_review". */
  describe(args: never): string;
  run(services: ChatActionServices, args: never): Promise<unknown>;
}

interface ChatActionDefinition<S extends z.ZodTypeAny> {
  name: string;
  group: ChatActionGroup | null;
  description: string;
  args: S;
  writes: boolean;
  describe(args: z.output<S>): string;
  run(services: ChatActionServices, args: z.output<S>): Promise<unknown>;
}

/**
 * Author one entry with its schema and handler typed together.
 *
 * The cast is the erasure: `describe` and `run` accept a concrete argument type, and a list of
 * entries with different argument types has no common supertype that keeps them callable. It
 * is sound because every call site parses through the entry's own `args` schema first.
 */
function define<S extends z.ZodTypeAny>(definition: ChatActionDefinition<S>): ChatAction {
  return definition as unknown as ChatAction;
}

const project = z.string().min(1).describe('project id, e.g. pomni');

/**
 * What is deliberately **not** here, so the next reader does not take it for an oversight:
 *
 * - `init` — makes a workspace. There is no chat before there is a workspace to chat in.
 * - `serve` and `mcp` — start this process. A chat running inside it cannot start it again.
 * - `editor` — opens a file on the machine running the server, which is not necessarily the
 *   machine the person is looking at. `task.show` and the run's artifacts are the honest way
 *   to see a file from a browser.
 * - `cred add --token` — a literal secret. The conversation is stored; see `cred.add`.
 *
 * Everything else the CLI can do has an entry.
 */
export const CHAT_ACTIONS: ChatAction[] = [
  // -- always visible -------------------------------------------------------

  define({
    name: 'actions.expand',
    group: null,
    description:
      'Open a group so its actions are listed in full on the next turn. Opening a third group drops the one you opened longest ago.',
    args: z.object({ group: ChatActionGroupSchema.describe('group id from the list above') }),
    writes: false,
    describe: (args) => `Open the '${args.group}' actions`,
    run: async (_services, args) => ({
      group: args.group,
      about: CHAT_ACTION_GROUP_INFO[args.group],
      actions: CHAT_ACTIONS.filter((action) => action.group === args.group).map((action) => ({
        name: action.name,
        writes: action.writes,
        description: action.description,
      })),
    }),
  }),
  // -- reads ----------------------------------------------------------------

  define({
    name: 'project.list',
    group: 'project',
    description: 'Every project in this workspace, with its repos. Start here when unsure.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the projects',
    run: (services) => services.projects.list(),
  }),

  define({
    name: 'project.show',
    group: 'project',
    description: 'One project in full: its repos, gates, policy and attached workflows.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `Show project ${args.project}`,
    run: (services, args) => services.projects.get(args.project),
  }),

  define({
    name: 'repo.list',
    group: 'repo',
    description:
      'Repos in a project, with the working directory each resolves to and the capabilities it declares. Use this to find where the code actually is.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `List the repos in ${args.project}`,
    run: (services, args) => services.repos.listResolved(args.project),
  }),

  define({
    name: 'backlog.list',
    group: 'backlog',
    description:
      "Backlog items for a project. Status 'active' excludes done and cancelled, which is usually what you want.",
    args: z.object({
      project,
      status: z.string().optional(),
      repo: z.string().optional(),
      query: z.string().optional(),
    }),
    writes: false,
    describe: (args) =>
      `List ${args.status ? `${args.status} ` : ''}backlog items in ${args.project}`,
    run: (services, args) =>
      services.backlog.list({
        projectId: args.project,
        // 'active' is not a status; it is the shorthand every other surface offers for
        // "everything still open", and a model asking for it means that.
        status:
          args.status === 'active'
            ? ['backlog', 'specced', 'ready', 'in_progress', 'in_review', 'blocked']
            : args.status,
        repo: args.repo,
        query: args.query,
      }),
  }),

  define({
    name: 'backlog.show',
    group: 'backlog',
    description:
      'One backlog item in full: frontmatter, dependency state, which moves are legal from here, and the whole spec body.',
    args: z.object({ project, item: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show backlog item ${args.item.toUpperCase()}`,
    run: (services, args) => services.backlog.get(args.project, args.item.toUpperCase()),
  }),

  define({
    name: 'backlog.flow',
    group: 'backlog',
    description:
      'The task flow this project runs on: its states, the moves between them and what each move requires. Read this before proposing a move you are not sure exists.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `Show the task flow for ${args.project}`,
    run: (services, args) => services.backlog.flow(args.project),
  }),

  define({
    name: 'workflow.list',
    group: 'workflow',
    description:
      'Every agent workflow, with the agents in it, whether it is runnable, and the projects it is attached to.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the agent workflows',
    run: (services) => services.workflows.list(),
  }),

  define({
    name: 'workflow.show',
    group: 'workflow',
    description: 'One workflow: its agents, their roles and prompts, and anything wrong with it.',
    args: z.object({ workflow: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show workflow ${args.workflow}`,
    run: (services, args) => services.workflows.get(args.workflow),
  }),

  define({
    name: 'tool.list',
    group: 'tool',
    description: 'Every registered tool — MCP servers and CLI programs an agent can be granted.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the tools',
    run: (services) => services.tools.list(),
  }),

  define({
    name: 'run.list',
    group: 'run',
    description:
      'Capability run history, newest first. Use failedOnly to see what is currently broken.',
    args: z.object({
      project: z.string().optional(),
      repo: z.string().optional(),
      capability: z.string().optional(),
      failedOnly: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    writes: false,
    describe: (args) =>
      `List ${args.failedOnly ? 'failed ' : ''}runs${args.project ? ` in ${args.project}` : ''}`,
    run: (services, args) =>
      services.runs.list({
        projectId: args.project,
        repoId: args.repo,
        capability: args.capability,
        failedOnly: args.failedOnly,
        limit: args.limit ?? 20,
      }),
  }),

  define({
    name: 'run.show',
    group: 'run',
    description: 'One capability run: what was executed, how it ended, and its summary.',
    args: z.object({ run: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show run ${args.run}`,
    run: (services, args) => services.runs.get(args.run),
  }),

  define({
    name: 'question.list',
    group: 'question',
    description:
      'Questions agent runs are currently waiting on a person to answer. Read this before answering one.',
    args: z.object({ project: z.string().optional() }),
    writes: false,
    describe: (args) =>
      `List open questions${args.project ? ` in ${args.project}` : ''}`,
    run: (services, args) => services.pipelines.openQuestions(args.project),
  }),

  // -- writes ---------------------------------------------------------------

  define({
    name: 'backlog.create',
    group: 'backlog',
    description:
      'Capture a new backlog item. It starts in the flow\'s initial state with a spec template; the Problem and Acceptance criteria still have to be written before it can move on.',
    args: z.object({
      project,
      title: z.string().min(1),
      type: z.enum(['feature', 'bug', 'chore', 'spike', 'refactor', 'docs']).optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      repos: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
    }),
    writes: true,
    describe: (args) =>
      `Create a ${args.priority ? `${args.priority} ` : ''}${args.type ?? 'feature'} in ${
        args.project
      }: "${args.title}"`,
    run: (services, args) =>
      services.backlog.create(args.project, {
        title: args.title,
        type: args.type,
        priority: args.priority,
        repos: args.repos,
        labels: args.labels,
      }),
  }),

  define({
    name: 'backlog.move',
    group: 'backlog',
    description:
      "Move a backlog item to another state. The flow's guards apply and a refused move is reported rather than overridden — say why with `reason`.",
    args: z.object({
      project,
      item: z.string().min(1),
      to: z.string().min(1),
      reason: z.string().optional(),
    }),
    writes: true,
    describe: (args) =>
      `Move backlog item ${args.item.toUpperCase()} to ${args.to}${
        args.reason ? ` — ${args.reason}` : ''
      }`,
    // Deliberately no `force`. Waiving a guard is a person taking responsibility for work they
    // say is done, and there is nobody to hold responsible when a model ticks that box.
    run: (services, args) =>
      services.backlog.transition(args.project, args.item.toUpperCase(), args.to, {
        reason: args.reason,
      }),
  }),

  define({
    name: 'task.start',
    group: 'task',
    description:
      'Start an agent run: a workflow works on a task in a project. Returns the run id; the run then proceeds on its own and is watched on the run page.',
    args: z.object({
      project,
      task: z.string().min(1),
      workflow: z.string().optional(),
      item: z.string().optional(),
      repo: z.string().optional(),
    }),
    writes: true,
    describe: (args) =>
      `Start an agent run in ${args.project}${args.item ? ` for ${args.item.toUpperCase()}` : ''}: "${
        args.task
      }"`,
    run: async (services, args) => {
      const { run, completion } = await services.pipelines.start({
        projectId: args.project,
        task: args.task,
        workflowId: args.workflow,
        itemId: args.item?.toUpperCase(),
        repoId: args.repo,
      });

      // The run outlives this turn by design, so its completion is not awaited. It is still
      // observed: an unhandled rejection here would take the server down for a failure the
      // run record already describes.
      void completion.catch(() => undefined);

      return { runId: run.id, status: run.status, workflowId: run.workflowId, task: run.task };
    },
  }),

  define({
    name: 'workflow.attach',
    group: 'workflow',
    description: 'Attach a workflow to a project, so runs in that project can use it.',
    args: z.object({ project, workflow: z.string().min(1) }),
    writes: true,
    describe: (args) => `Attach workflow ${args.workflow} to project ${args.project}`,
    run: (services, args) => services.workflows.attach(args.project, args.workflow),
  }),

  define({
    name: 'tool.attach',
    group: 'tool',
    description: "Attach a tool to a project, so the project's agents can be granted it.",
    args: z.object({ project, tool: z.string().min(1) }),
    writes: true,
    describe: (args) => `Attach tool ${args.tool} to project ${args.project}`,
    run: (services, args) => services.tools.attach(args.project, args.tool),
  }),

  define({
    name: 'question.answer',
    group: 'question',
    description:
      'Answer a question an agent run is waiting on. The run is holding until this arrives, so answer only what you actually know.',
    args: z.object({ question: z.string().min(1), answer: z.string().min(1) }),
    writes: true,
    describe: (args) => `Answer question ${args.question}: "${args.answer}"`,
    run: (services, args) => services.pipelines.answer(args.question, args.answer),
  }),

  // -- project --------------------------------------------------------------

  define({
    name: 'project.create',
    group: 'project',
    description: 'Create a project. The id is derived from the name unless one is given.',
    args: z.object({
      name: z.string().min(1),
      id: z.string().min(1).optional(),
      description: z.string().optional(),
    }),
    writes: true,
    describe: (args) => `Create project '${args.name}'`,
    run: (services, args) => services.projects.create(args),
  }),

  define({
    name: 'project.edit',
    group: 'project',
    description:
      "Change a project's name, description, item prefix, or its cost and turn ceilings.",
    args: z.object({
      project,
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      itemPrefix: z.string().min(1).optional(),
      maxCostUsd: z.number().positive().optional(),
      maxTurns: z.number().int().positive().optional(),
    }),
    writes: true,
    describe: (args) => {
      const changed = Object.keys(args).filter((key) => key !== 'project');
      return `Change ${changed.join(', ') || 'nothing'} on project '${args.project}'`;
    },
    run: async (services, args) => {
      const { project: id, maxCostUsd, maxTurns, ...rest } = args;
      const patch: Record<string, unknown> = { ...rest };
      if (maxCostUsd !== undefined || maxTurns !== undefined) {
        const current = await services.projects.get(id);
        patch.policy = {
          ...current.policy,
          ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
          ...(maxTurns === undefined ? {} : { maxTurns }),
        };
      }
      return services.projects.update(id, patch);
    },
  }),

  define({
    name: 'project.remove',
    group: 'project',
    description:
      'Delete a project. With purge, its cloned working copies go too; linked local repositories are never deleted.',
    args: z.object({ project, purge: z.boolean().optional() }),
    writes: true,
    describe: (args) =>
      args.purge
        ? `Remove project '${args.project}' and delete its cloned working copies. Its backlog, repo records and settings are deleted along with every clone under the workspace; linked local repositories are never deleted.`
        : `Remove project '${args.project}'. Its backlog, repo records and settings are deleted; cloned working copies and linked local repositories stay on disk.`,
    run: async (services, args) => {
      await services.projects.remove(args.project, { purge: args.purge });
      return { removed: args.project, purged: args.purge ?? false };
    },
  }),

  // -- repo -----------------------------------------------------------------

  define({
    name: 'repo.add',
    group: 'repo',
    description:
      'Add a codebase to a project: source {kind:"git", url} to clone one, or {kind:"local", path} to link a folder already on disk.',
    args: z.object({
      project,
      source: z.union([
        z.object({
          kind: z.literal('local'),
          path: z.string().min(1),
        }),
        z.object({
          kind: z.literal('git'),
          url: z.string().min(1),
          ref: z.string().min(1).optional(),
          credential: z.string().min(1).optional(),
        }),
      ]),
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      role: z.string().min(1).optional(),
    }),
    writes: true,
    describe: (args) =>
      args.source.kind === 'git'
        ? `Clone ${args.source.url} into project '${args.project}'`
        : `Link the folder ${args.source.path} into project '${args.project}'. The folder itself is not moved or copied.`,
    run: (services, args) =>
      services.repos.add(args.project, {
        source: args.source,
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.role === undefined ? {} : { role: args.role as never }),
      }),
  }),

  define({
    name: 'repo.sync',
    group: 'repo',
    description:
      'Fetch a repo, fast-forward its base branch, and re-detect its stack and commands. A run does not do this by itself.',
    args: z.object({ project, repo: z.string().min(1) }),
    writes: true,
    describe: (args) => `Sync repo '${args.repo}' in project '${args.project}'`,
    run: (services, args) => services.repos.sync(args.project, args.repo),
  }),

  define({
    name: 'repo.doctor',
    group: 'repo',
    description:
      'Check that each repo and each command it declares can actually run, and report what cannot.',
    args: z.object({ project, repo: z.string().min(1).optional() }),
    writes: false,
    describe: (args) => `Check the repos in '${args.project}'`,
    run: (services, args) => services.doctor.check(args.project, args.repo),
  }),

  define({
    name: 'repo.remove',
    group: 'repo',
    description:
      'Remove a repo from a project. With purge, its clone under the workspace is deleted too; a linked local repository is never deleted.',
    args: z.object({ project, repo: z.string().min(1), purge: z.boolean().optional() }),
    writes: true,
    describe: (args) =>
      args.purge
        ? `Remove repo '${args.repo}' from project '${args.project}' and delete its cloned working copy. Pomni's record and the clone under the workspace are deleted; a linked local repository is never deleted.`
        : `Remove repo '${args.repo}' from project '${args.project}'. Pomni's record of it is deleted; the files on disk are kept.`,
    run: async (services, args) => {
      await services.repos.remove(args.project, args.repo, { purge: args.purge });
      return { removed: args.repo, purged: args.purge ?? false };
    },
  }),

  // -- cred -----------------------------------------------------------------

  define({
    name: 'cred.list',
    group: 'cred',
    description:
      'Credentials by id, with where each secret comes from and whether it resolves. Never the secret itself.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the credentials',
    run: (services) => services.credentials.list(),
  }),

  define({
    name: 'cred.add',
    group: 'cred',
    description:
      'Register a credential reading its secret from an environment variable or the GitHub CLI. A literal token is not accepted here.',
    args: z.object({
      id: z.string().min(1),
      host: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      env: z.string().min(1).optional().describe('environment variable holding the token'),
      gh: z.boolean().optional().describe('delegate to the GitHub CLI'),
    }),
    writes: true,
    describe: (args) =>
      `Register credential '${args.id}'${args.env ? ` reading $${args.env}` : args.gh ? ' via the GitHub CLI' : ''}`,
    run: (services, args) => {
      // Rule 3, at the one surface where breaking it is easiest: a chat is stored, and a
      // secret typed into one cannot be unsaid. Only pointers to a secret are accepted.
      if (!args.env && !args.gh) {
        throw new ValidationError(
          'cred.add takes env or gh — a literal token is never accepted over chat, because the' +
            ' conversation is stored and a secret written into one cannot be unsaid',
        );
      }
      return services.credentials.create({
        id: args.id,
        ...(args.host === undefined ? {} : { host: args.host }),
        ...(args.username === undefined ? {} : { username: args.username }),
        secret: args.gh ? { kind: 'gh-cli' } : { kind: 'env', var: args.env as string },
      } as never);
    },
  }),

  define({
    name: 'cred.edit',
    group: 'cred',
    description:
      "Change a credential's host or username. The secret reference is not changed here.",
    args: z.object({
      id: z.string().min(1),
      host: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
    }),
    writes: true,
    describe: (args) => `Change credential '${args.id}'`,
    run: (services, args) => {
      const { id, ...patch } = args;
      return services.credentials.update(id, patch as never);
    },
  }),

  define({
    name: 'cred.test',
    group: 'cred',
    description: 'Check that a credential resolves, and with a url, that the remote accepts it.',
    args: z.object({ id: z.string().min(1), url: z.string().min(1).optional() }),
    writes: false,
    describe: (args) => `Test credential '${args.id}'`,
    run: (services, args) => services.credentials.test(args.id, args.url),
  }),

  define({
    name: 'cred.remove',
    group: 'cred',
    description: 'Delete a credential record. Any repo referring to it stops authenticating.',
    args: z.object({ id: z.string().min(1) }),
    writes: true,
    describe: (args) =>
      `Remove credential '${args.id}'. Any repo that refers to it will stop authenticating.`,
    run: async (services, args) => {
      await services.credentials.remove(args.id);
      return { removed: args.id };
    },
  }),

  // -- provider -------------------------------------------------------------

  define({
    name: 'provider.list',
    group: 'provider',
    description:
      'Where models can run, which are enabled and reachable, and which one is the default.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the providers',
    run: (services) => services.providers.status(),
  }),

  define({
    name: 'provider.add',
    group: 'provider',
    description:
      'Add a provider: the Claude Code CLI, an API key, or an OpenAI-compatible endpoint.',
    args: z.object({
      id: z.string().min(1),
      kind: z.string().min(1).describe('claude-code | anthropic | openai'),
      label: z.string().min(1).optional(),
      baseUrl: z.string().min(1).optional(),
      credential: z.string().min(1).optional(),
    }),
    writes: true,
    describe: (args) => `Add provider '${args.id}' (${args.kind})`,
    run: (services, args) => services.providers.create(args as never),
  }),

  define({
    name: 'provider.use',
    group: 'provider',
    description: 'Make this provider the default for new runs and chats.',
    args: z.object({ id: z.string().min(1) }),
    writes: true,
    describe: (args) => `Make '${args.id}' the default provider`,
    run: async (services, args) => {
      await services.providers.setDefault(args.id);
      return { default: args.id };
    },
  }),

  define({
    name: 'provider.remove',
    group: 'provider',
    description:
      'Delete a provider. An agent pinned to it will not run until it is pointed at another.',
    args: z.object({ id: z.string().min(1) }),
    writes: true,
    describe: (args) =>
      `Remove provider '${args.id}'. Any agent pinned to it will not run until it is pointed at another.`,
    run: async (services, args) => {
      await services.providers.remove(args.id);
      return { removed: args.id };
    },
  }),

  // -- backlog (the rest) ---------------------------------------------------

  define({
    name: 'backlog.edit',
    group: 'backlog',
    description:
      "Change an item's fields, or replace its prose body — the Problem, Acceptance criteria and Plan.",
    args: z.object({
      project,
      item: z.string().min(1),
      title: z.string().min(1).optional(),
      type: z.string().min(1).optional(),
      priority: z.string().min(1).optional(),
      repos: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      touches: z.array(z.string()).optional(),
      body: z.string().optional(),
    }),
    writes: true,
    describe: (args) => {
      const changed = Object.keys(args).filter((key) => key !== 'project' && key !== 'item');
      return `Change ${changed.join(', ') || 'nothing'} on ${args.item}`;
    },
    run: (services, args) => {
      const { project: id, item, ...patch } = args;
      return services.backlog.update(id, item, patch as never);
    },
  }),

  define({
    name: 'backlog.block',
    group: 'backlog',
    description: 'Mark an item blocked, with the reason recorded in its log.',
    args: z.object({ project, item: z.string().min(1), reason: z.string().min(1) }),
    writes: true,
    describe: (args) => `Block ${args.item}: ${args.reason}`,
    run: (services, args) => services.backlog.block(args.project, args.item, args.reason),
  }),

  define({
    name: 'backlog.unblock',
    group: 'backlog',
    description: 'Return a blocked item to whatever it was doing before.',
    args: z.object({ project, item: z.string().min(1) }),
    writes: true,
    describe: (args) => `Unblock ${args.item}`,
    run: (services, args) => services.backlog.unblock(args.project, args.item),
  }),

  define({
    name: 'backlog.link',
    group: 'backlog',
    description: 'Record that an item depends on others, which gates it moving into progress.',
    args: z.object({
      project,
      item: z.string().min(1),
      dependsOn: z.array(z.string().min(1)).min(1),
    }),
    writes: true,
    describe: (args) => `Make ${args.item} depend on ${args.dependsOn.join(', ')}`,
    run: async (services, args) => {
      // Merged, not replaced, the way the CLI's `link` does it: recording a new dependency is
      // not a statement that the earlier ones are gone.
      const current = await services.backlog.get(args.project, args.item);
      const merged = Array.from(new Set([...current.dependsOn, ...args.dependsOn]));
      return services.backlog.update(args.project, args.item, { dependsOn: merged });
    },
  }),

  define({
    name: 'backlog.remove',
    group: 'backlog',
    description: 'Delete an item. Its spec and its log go with it.',
    args: z.object({ project, item: z.string().min(1) }),
    writes: true,
    describe: (args) =>
      `Delete item ${args.item} from '${args.project}'. Its spec and its log are deleted with it.`,
    run: async (services, args) => {
      await services.backlog.remove(args.project, args.item);
      return { removed: args.item };
    },
  }),

  define({
    name: 'backlog.next',
    group: 'backlog',
    description: 'The highest-priority item that is ready to be worked on.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `What is next in '${args.project}'`,
    run: (services, args) => services.backlog.next(args.project),
  }),

  define({
    name: 'backlog.waves',
    group: 'backlog',
    description: 'Ready items grouped into waves that can safely run at the same time.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `Plan the waves for '${args.project}'`,
    run: (services, args) => services.backlog.waves(args.project),
  }),

  define({
    name: 'backlog.comment',
    group: 'backlog',
    description:
      'Write a note on an item. A run started from it is given these, so this is how the next attempt is told something.',
    args: z.object({
      project,
      item: z.string().min(1),
      text: z.string().min(1),
      addressedTo: z.string().min(1).optional(),
    }),
    writes: true,
    describe: (args) => `Write a note on ${args.item}`,
    run: (services, args) =>
      services.comments.add({
        subject: 'item',
        subjectId: args.item,
        projectId: args.project,
        author: { kind: 'person', name: 'someone' },
        text: args.text,
        addressedTo: args.addressedTo ?? null,
      }),
  }),

  // -- task -----------------------------------------------------------------

  define({
    name: 'task.list',
    group: 'task',
    description: 'Recent agent pipeline runs, newest first.',
    args: z.object({ project, limit: z.number().int().positive().max(50).optional() }),
    writes: false,
    describe: (args) => `List the runs in '${args.project}'`,
    run: (services, args) =>
      services.pipelines.list({ projectId: args.project, limit: args.limit ?? 20 }),
  }),

  define({
    name: 'task.show',
    group: 'task',
    description: 'One run in full: its steps, what each agent did, and what each one cost.',
    args: z.object({ run: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show run ${args.run}`,
    run: (services, args) => services.pipelines.get(args.run),
  }),

  define({
    name: 'task.cancel',
    group: 'task',
    description: 'Stop a running pipeline, or close out one whose process is gone.',
    args: z.object({ run: z.string().min(1) }),
    writes: true,
    describe: (args) => `Stop run ${args.run}`,
    run: (services, args) => services.pipelines.cancel(args.run),
  }),

  define({
    name: 'task.resume',
    group: 'task',
    description:
      'Carry on an interrupted run in the same run, keeping the steps it already paid for.',
    args: z.object({ run: z.string().min(1), note: z.string().optional() }),
    writes: true,
    describe: (args) => `Resume run ${args.run}`,
    run: async (services, args) => {
      const { run } = await services.pipelines.resume(args.run, args.note);
      return run;
    },
  }),

  define({
    name: 'task.rerun',
    group: 'task',
    description: 'Run a finished run again from the start, telling the agents why the last one ended.',
    args: z.object({ run: z.string().min(1) }),
    writes: true,
    describe: (args) => `Run ${args.run} again from the start`,
    run: async (services, args) => {
      const { run } = await services.pipelines.rerun(args.run);
      return run;
    },
  }),

  define({
    name: 'task.comment',
    group: 'task',
    description: 'Write a note on a run.',
    args: z.object({
      project,
      run: z.string().min(1),
      text: z.string().min(1),
      addressedTo: z.string().min(1).optional(),
    }),
    writes: true,
    describe: (args) => `Write a note on run ${args.run}`,
    run: (services, args) =>
      services.comments.add({
        subject: 'run',
        subjectId: args.run,
        projectId: args.project,
        author: { kind: 'person', name: 'someone' },
        text: args.text,
        addressedTo: args.addressedTo ?? null,
      }),
  }),

  define({
    name: 'task.spend',
    group: 'task',
    description: 'What the pipelines have cost, run by run, with the totals.',
    args: z.object({ project, limit: z.number().int().positive().max(50).optional() }),
    writes: false,
    describe: (args) => `What the runs in '${args.project}' have cost`,
    run: async (services, args) => {
      const runs = await services.pipelines.list({
        projectId: args.project,
        limit: args.limit ?? 20,
      });
      const totals = runs.reduce(
        (sum, run) => ({
          runs: sum.runs + 1,
          inputTokens: sum.inputTokens + run.inputTokens,
          outputTokens: sum.outputTokens + run.outputTokens,
          costUsd: sum.costUsd + (run.costUsd ?? 0),
        }),
        { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      );
      return {
        runs: runs.map((run) => ({
          id: run.id,
          item: run.itemId,
          status: run.status,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costUsd: run.costUsd,
        })),
        totals,
      };
    },
  }),

  // -- run ------------------------------------------------------------------

  define({
    name: 'run.run',
    group: 'run',
    description:
      'Run one declared capability — test, build, lint, typecheck — across the repos that declare it.',
    args: z.object({ project, capability: z.string().min(1), repo: z.string().min(1).optional() }),
    writes: true,
    describe: (args) => `Run '${args.capability}' in project '${args.project}'`,
    run: (services, args) =>
      services.runs.run(args.project, args.capability, args.repo ? { repoId: args.repo } : {}),
  }),

  define({
    name: 'run.verify',
    group: 'run',
    description: "Run the project's whole gate, every capability in order, and report what failed.",
    args: z.object({ project }),
    writes: true,
    describe: (args) => `Run the gate for '${args.project}'`,
    run: (services, args) => services.runs.gate(args.project, 'default'),
  }),

  // -- workflow (the rest) --------------------------------------------------

  define({
    name: 'workflow.create',
    group: 'workflow',
    description: 'Create an agent pipeline, which agents are then added to.',
    args: z.object({ name: z.string().min(1), id: z.string().min(1).optional() }),
    writes: true,
    describe: (args) => `Create workflow '${args.name}'`,
    run: (services, args) => services.workflows.create(args),
  }),

  define({
    name: 'workflow.remove',
    group: 'workflow',
    description: 'Delete a workflow and every agent in it.',
    args: z.object({ workflow: z.string().min(1) }),
    writes: true,
    describe: (args) => `Delete workflow '${args.workflow}' and every agent in it`,
    run: async (services, args) => {
      await services.workflows.remove(args.workflow);
      return { removed: args.workflow };
    },
  }),

  define({
    name: 'workflow.detach',
    group: 'workflow',
    description: 'Stop offering a workflow on a project. The workflow itself is kept.',
    args: z.object({ project, workflow: z.string().min(1) }),
    writes: true,
    describe: (args) => `Detach workflow '${args.workflow}' from '${args.project}'`,
    run: (services, args) => services.workflows.detach(args.project, args.workflow),
  }),

  define({
    name: 'workflow.agentAdd',
    group: 'workflow',
    description:
      'Add an agent to a workflow: its role, what it is for, and the provider it runs on.',
    args: z.object({
      workflow: z.string().min(1),
      name: z.string().min(1),
      role: z.string().min(1).optional().describe('orchestrator | agent'),
      spec: z.string().optional(),
      prompt: z.string().optional(),
      provider: z.string().optional(),
    }),
    writes: true,
    describe: (args) => `Add agent '${args.name}' to workflow '${args.workflow}'`,
    run: (services, args) => {
      const { workflow, ...input } = args;
      return services.workflows.addAgent(workflow, input as never);
    },
  }),

  define({
    name: 'workflow.agentEdit',
    group: 'workflow',
    description: "Change an agent's spec, prompt, role or provider.",
    args: z.object({
      workflow: z.string().min(1),
      agent: z.string().min(1),
      name: z.string().min(1).optional(),
      role: z.string().min(1).optional(),
      spec: z.string().optional(),
      prompt: z.string().optional(),
      provider: z.string().optional(),
    }),
    writes: true,
    describe: (args) => `Change agent '${args.agent}' in workflow '${args.workflow}'`,
    run: (services, args) => {
      const { workflow, agent, ...patch } = args;
      return services.workflows.updateAgent(workflow, agent, patch as never);
    },
  }),

  define({
    name: 'workflow.agentRemove',
    group: 'workflow',
    description: 'Remove an agent from a workflow.',
    args: z.object({ workflow: z.string().min(1), agent: z.string().min(1) }),
    writes: true,
    describe: (args) => `Remove agent '${args.agent}' from workflow '${args.workflow}'`,
    run: async (services, args) => {
      await services.workflows.removeAgent(args.workflow, args.agent);
      return { removed: args.agent };
    },
  }),

  define({
    name: 'workflow.signals',
    group: 'workflow',
    description:
      'What has been going wrong across a project runs, collected as findings a prompt could be amended for.',
    args: z.object({ project, workflow: z.string().min(1).optional() }),
    writes: false,
    describe: (args) => `What keeps going wrong in '${args.project}'`,
    run: (services, args) => services.pipelines.signals(args.project, args.workflow),
  }),

  define({
    name: 'workflow.amend',
    group: 'workflow',
    description:
      "Propose a change to an agent's spec from a finding. The proposal is returned, not applied.",
    args: z.object({
      workflow: z.string().min(1),
      agent: z.string().min(1),
      kind: z.string().min(1),
      runIds: z.array(z.string()).default([]),
      details: z.array(z.string()).default([]),
    }),
    writes: true,
    describe: (args) => `Propose an amendment to agent '${args.agent}'`,
    run: (services, args) =>
      services.workflows.proposeAmendment(args.workflow, args.agent, {
        kind: args.kind,
        runIds: args.runIds,
        details: args.details,
      }),
  }),

  // -- tool (the rest) ------------------------------------------------------

  define({
    name: 'tool.add',
    group: 'tool',
    description: 'Register an MCP server or a CLI program that agents may be granted.',
    args: z.object({
      name: z.string().min(1),
      kind: z.string().min(1).describe('mcp | cli'),
      id: z.string().min(1).optional(),
      description: z.string().optional(),
      command: z.string().optional(),
      bin: z.string().optional(),
      url: z.string().optional(),
    }),
    writes: true,
    describe: (args) => `Register ${args.kind} tool '${args.name}'`,
    run: (services, args) => services.tools.create(args as never),
  }),

  define({
    name: 'tool.edit',
    group: 'tool',
    description: "Change a tool's command, url, description or usage notes.",
    args: z.object({
      tool: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      command: z.string().optional(),
      bin: z.string().optional(),
      url: z.string().optional(),
      usage: z.string().optional(),
    }),
    writes: true,
    describe: (args) => `Change tool '${args.tool}'`,
    run: (services, args) => {
      const { tool, ...patch } = args;
      return services.tools.update(tool, patch as never);
    },
  }),

  define({
    name: 'tool.check',
    group: 'tool',
    description: 'Check that the registered tools can actually be reached or run.',
    args: z.object({ tools: z.array(z.string()).optional() }),
    writes: false,
    describe: () => 'Check the tools',
    run: (services, args) => services.tools.check(args.tools),
  }),

  define({
    name: 'tool.detach',
    group: 'tool',
    description: 'Stop offering a tool on a project. The tool itself is kept.',
    args: z.object({ project, tool: z.string().min(1) }),
    writes: true,
    describe: (args) => `Detach tool '${args.tool}' from '${args.project}'`,
    run: (services, args) => services.tools.detach(args.project, args.tool),
  }),

  define({
    name: 'tool.remove',
    group: 'tool',
    description: 'Delete a tool registration. Every project offering it stops offering it.',
    args: z.object({ tool: z.string().min(1) }),
    writes: true,
    describe: (args) =>
      `Delete tool '${args.tool}'. Every project that offers it stops offering it.`,
    run: async (services, args) => {
      await services.tools.remove(args.tool);
      return { removed: args.tool };
    },
  }),

  // -- worktree -------------------------------------------------------------

  define({
    name: 'worktree.list',
    group: 'worktree',
    description: 'The per-run checkouts on disk, and which run each one belongs to.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `List the worktrees in '${args.project}'`,
    run: (services, args) => services.worktrees.list({ projectId: args.project }),
  }),

  define({
    name: 'worktree.prune',
    group: 'worktree',
    description:
      'Remove worktrees nothing owns any more. A worktree holding uncommitted work is kept.',
    args: z.object({ project }),
    writes: true,
    describe: (args) =>
      `Prune orphaned worktrees in '${args.project}'. Worktrees with uncommitted work are kept.`,
    run: (services, args) => services.worktrees.prune({ projectId: args.project }),
  }),

  define({
    name: 'worktree.remove',
    group: 'worktree',
    description: 'Remove one worktree by id, even if it still holds uncommitted work.',
    args: z.object({ worktree: z.string().min(1), force: z.boolean().optional() }),
    writes: true,
    describe: (args) =>
      args.force
        ? `Remove worktree ${args.worktree}, discarding any uncommitted work in it.`
        : `Remove worktree ${args.worktree}`,
    run: async (services, args) => {
      await services.worktrees.removeOne(args.worktree, { force: args.force ?? false });
      return { removed: args.worktree };
    },
  }),

  // -- discover -------------------------------------------------------------

  define({
    name: 'discover.list',
    group: 'discover',
    description: 'Agents, skills and rules already sitting in a project repos, ready to import.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `Scan '${args.project}' for agents and skills already there`,
    run: (services, args) => services.discovery.scan(args.project),
  }),

  define({
    name: 'discover.show',
    group: 'discover',
    description: 'What one repo holds, when the whole-project scan is more than you asked for.',
    args: z.object({ project, repo: z.string().min(1) }),
    writes: false,
    describe: (args) => `Scan repo '${args.repo}' in '${args.project}'`,
    run: (services, args) => services.discovery.scan(args.project, { repoId: args.repo }),
  }),
];

const BY_NAME = new Map(CHAT_ACTIONS.map((action) => [action.name, action]));

/**
 * The action with this name.
 *
 * A name that is not in the catalogue is a `ValidationError` rather than a shrug: it is either
 * a model inventing a capability or a stale client, and both are worth saying out loud.
 */
export function findAction(name: string): ChatAction {
  const found = BY_NAME.get(name);
  if (!found) {
    throw new ValidationError(
      `'${name}' is not something Pomni can do — pick one of: ${CHAT_ACTIONS.map(
        (action) => action.name,
      ).join(', ')}`,
      { name },
    );
  }
  return found;
}

/** Arguments checked against the action's own schema. Never trust what the model wrote. */
export function parseActionArgs(action: ChatAction, args: unknown): unknown {
  const parsed = action.args.safeParse(args ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      `'${action.name}' was called with arguments it cannot use: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'} ${issue.message.toLowerCase()}`)
        .join('; ')}`,
      { name: action.name, issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

/**
 * What makes two proposals the same proposal, for deciding whether one repeats a declined one.
 *
 * Name and arguments, with the argument keys sorted so a model that writes them in another
 * order does not slip a repeat past the check.
 */
export function actionKey(name: string, args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const sorted = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as const);
  return `${name}:${JSON.stringify(sorted)}`;
}

/** The confirm prompt for a call, or a fallback when the arguments do not parse. */
export function describeAction(action: ChatAction, args: unknown): string {
  try {
    return (action.describe as (value: unknown) => string)(parseActionArgs(action, args));
  } catch {
    return action.name;
  }
}

// ---------------------------------------------------------------------------
// The wire protocol
// ---------------------------------------------------------------------------

const ActionCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  /**
   * Deliberately proposing again something the person already declined.
   *
   * A flag rather than a guess at intent from the prose: a person who said no and is asked
   * the same question next turn has been overruled by a model that forgot, and reading
   * "go ahead anyway" as consent is exactly the mistake this protects against. The model has
   * to say it is doing it on purpose.
   */
  again: z.boolean().optional(),
});
export type ChatActionCall = z.infer<typeof ActionCallSchema>;

const ActionBlockSchema = z.object({ actions: z.array(ActionCallSchema).min(1) });

/**
 * How the assistant asks for an action.
 *
 * A fenced JSON block rather than native function-calling, for the same reason the
 * orchestrator protocol uses one: no adapter in this repo implements the tool loop, and the
 * most useful provider — the Claude Code CLI — runs its own loop internally and cannot hand
 * individual calls back. One convention, working on every provider.
 */
export const CHAT_ACTION_PROTOCOL = `## Doing things

You can act on this workspace. To do so, end your reply with a fenced json block naming the
actions you want, and nothing after it:

\`\`\`json
{"actions": [{"name": "backlog.list", "args": {"project": "pomni", "status": "active"}}]}
\`\`\`

Write your prose answer first and the block last. The prose is what the person reads; the
block is what runs.

Reads run immediately and their results come back to you on the next turn — so ask for what
you need rather than guessing, and do not claim a fact you have not looked up.

Writes do **not** run when you propose them. They are shown to the person as a confirm
prompt and happen only if they say yes, which may be never. So describe a write as something
you are offering to do, not something you have done, and propose one at a time when they
build on each other — the second cannot see the result of the first until it is confirmed.

An action the person declined is not proposed again. If they ask for it a second time in so
many words, propose it with \`"again": true\` in the call; without that flag a repeat is
dropped and they are told it was.`;

/**
 * What each group is for, in one line, as the model reads it when the group is closed.
 *
 * This is the whole basis on which a group gets opened, so it names the *questions* the group
 * answers rather than its verbs — a model choosing between twelve nouns needs to know which
 * one holds "what did this cost", not that `task` has seven actions in it.
 */
export const CHAT_ACTION_GROUP_INFO: Record<ChatActionGroup, string> = {
  project: 'projects themselves: what exists, creating one, its settings and budgets',
  repo: 'the codebases in a project: adding, syncing, and whether their commands actually run',
  backlog: 'items: listing, reading, writing specs, moving, blocking, ordering and commenting',
  task: 'agent pipeline runs: starting, watching, stopping, resuming and what they cost',
  question: 'what a running pipeline is waiting to be told, and answering it',
  run: 'capability runs — test, build, lint, typecheck — and the whole gate',
  workflow: 'agent pipelines: authoring them, their agents, and attaching them to a project',
  tool: 'MCP servers and CLI programs agents may use',
  cred: 'git credentials by id — never the secret itself',
  provider: 'where models run: Claude Code, an API key, a local endpoint',
  worktree: 'the per-run checkouts on disk, and cleaning up the ones nothing owns',
  discover: 'agents, skills and rules already sitting inside a project’s repos',
};

/**
 * Bytes the rest of a chat turn needs, which the catalogue may not spend.
 *
 * The protocol is measured rather than guessed; the allowance on top is for the chat's own
 * system preamble and the workspace summary it carries. Kept as one named number so the
 * budget tests fail loudly if either side grows into the other.
 */
export const CHAT_PROMPT_RESERVE_BYTES =
  Buffer.byteLength(CHAT_ACTION_PROTOCOL, 'utf8') + 1200;

/** The `(a, b, c)` an action takes, for the catalogue line. */
function argNames(action: ChatAction): string {
  return action.args instanceof z.ZodObject ? Object.keys(action.args.shape).join(', ') : '';
}

function actionLine(action: ChatAction): string {
  const confirm = action.writes ? ' [confirm]' : '';
  return `- \`${action.name}\`(${argNames(action)})${confirm} — ${action.description}`;
}

/**
 * The catalogue as the model reads it, with only the opened groups spelled out.
 *
 * At ~120 bytes an action, seventy actions are more than `policy.promptBudget` on their own,
 * so a closed group costs one line naming what it is for and how many actions it holds. The
 * model opens what it needs with `actions.expand` and pays for that group only.
 */
export function actionBriefing(opened: readonly ChatActionGroup[] = []): string {
  const isOpen = new Set(opened);
  const ungrouped = CHAT_ACTIONS.filter((action) => action.group === null);

  const closed = CHAT_ACTION_GROUPS.filter((group) => !isOpen.has(group)).map((group) => {
    const count = CHAT_ACTIONS.filter((action) => action.group === group).length;
    const plural = count === 1 ? 'action' : 'actions';
    return `- \`${group}\` — ${CHAT_ACTION_GROUP_INFO[group]} (${count} ${plural})`;
  });

  const expanded = opened
    .filter((group) => CHAT_ACTION_GROUPS.includes(group))
    .map((group) =>
      [
        `### ${group}`,
        '',
        ...CHAT_ACTIONS.filter((action) => action.group === group).map(actionLine),
      ].join('\n'),
    );

  return [
    '## Actions',
    '',
    'Always available:',
    '',
    ...ungrouped.map(actionLine),
    '',
    ...(closed.length > 0
      ? [
          'Groups you have not opened. Each costs one `actions.expand` to see inside:',
          '',
          ...closed,
          '',
        ]
      : []),
    ...(expanded.length > 0 ? ['Opened:', '', ...expanded] : []),
  ]
    .join('\n')
    .trimEnd();
}

/**
 * What the catalogue costs with these groups open.
 *
 * Separate from `actionBriefing` so the budget can be checked without assembling a prompt,
 * and so the number in a test is the number the turn actually carries.
 */
export function measureActionPrompt(opened: readonly ChatActionGroup[] = []): {
  bytes: number;
  withReserve: number;
} {
  const bytes = Buffer.byteLength(actionBriefing(opened), 'utf8');
  return { bytes, withReserve: bytes + CHAT_PROMPT_RESERVE_BYTES };
}

/**
 * Read an assistant reply: the prose it said, and the actions it asked for.
 *
 * Unlike a delegation — where the whole reply is the block — a chat turn is prose *and*
 * possibly a block, so the block is lifted out and the rest is what the person sees.
 */
export function parseActionCalls(text: string): { prose: string; calls: ChatActionCall[] } {
  const calls: ChatActionCall[] = [];
  let prose = text;

  // Fences are paired by walking the lines, for the reason `jsonBlocks` in domain/pipeline.ts
  // is: a regex looking for an opening fence cannot tell one from a closing fence, so a reply
  // carrying any labelled block before its json one pairs the wrong pair and the block is
  // never read. That silently swallowed a delegation and ended two runs after two steps
  // (POMN-67). The same regex was here, and chat is about to become the main way to work.
  const lines = text.split(/\r?\n/);
  let info: string | null = null;
  let body: string[] = [];
  let opener = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = /^\s{0,3}```(.*)$/.exec(line);
    if (fence) {
      if (info === null) {
        info = (fence[1] ?? '').trim().toLowerCase();
        body = [];
        opener = index;
        continue;
      }
      if (info === '' || info === 'json') {
        const block = ActionBlockSchema.safeParse(tryParse(body.join('\n')));
        if (block.success) {
          calls.push(...block.data.actions);
          prose = prose.replace(lines.slice(opener, index + 1).join('\n'), '');
        }
      }
      info = null;
      continue;
    }
    if (info !== null) body.push(line);
  }

  // Some models skip the fence when the block is the whole reply.
  if (calls.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const block = ActionBlockSchema.safeParse(tryParse(trimmed));
      if (block.success) return { prose: '', calls: block.data.actions };
    }
  }

  return { prose: prose.trim(), calls };
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
