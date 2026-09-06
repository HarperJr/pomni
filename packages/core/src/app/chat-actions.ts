import { z } from 'zod';
import { ValidationError } from '../domain/errors.js';
import type { BacklogService } from './backlog-service.js';
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

export const CHAT_ACTIONS: ChatAction[] = [
  // -- reads ----------------------------------------------------------------

  define({
    name: 'project.list',
    description: 'Every project in this workspace, with its repos. Start here when unsure.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the projects',
    run: (services) => services.projects.list(),
  }),

  define({
    name: 'project.show',
    description: 'One project in full: its repos, gates, policy and attached workflows.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `Show project ${args.project}`,
    run: (services, args) => services.projects.get(args.project),
  }),

  define({
    name: 'repo.list',
    description:
      'Repos in a project, with the working directory each resolves to and the capabilities it declares. Use this to find where the code actually is.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `List the repos in ${args.project}`,
    run: (services, args) => services.repos.listResolved(args.project),
  }),

  define({
    name: 'backlog.list',
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
    description:
      'One backlog item in full: frontmatter, dependency state, which moves are legal from here, and the whole spec body.',
    args: z.object({ project, item: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show backlog item ${args.item.toUpperCase()}`,
    run: (services, args) => services.backlog.get(args.project, args.item.toUpperCase()),
  }),

  define({
    name: 'backlog.flow',
    description:
      'The task flow this project runs on: its states, the moves between them and what each move requires. Read this before proposing a move you are not sure exists.',
    args: z.object({ project }),
    writes: false,
    describe: (args) => `Show the task flow for ${args.project}`,
    run: (services, args) => services.backlog.flow(args.project),
  }),

  define({
    name: 'workflow.list',
    description:
      'Every agent workflow, with the agents in it, whether it is runnable, and the projects it is attached to.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the agent workflows',
    run: (services) => services.workflows.list(),
  }),

  define({
    name: 'workflow.show',
    description: 'One workflow: its agents, their roles and prompts, and anything wrong with it.',
    args: z.object({ workflow: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show workflow ${args.workflow}`,
    run: (services, args) => services.workflows.get(args.workflow),
  }),

  define({
    name: 'tool.list',
    description: 'Every registered tool — MCP servers and CLI programs an agent can be granted.',
    args: z.object({}),
    writes: false,
    describe: () => 'List the tools',
    run: (services) => services.tools.list(),
  }),

  define({
    name: 'run.list',
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
    description: 'One capability run: what was executed, how it ended, and its summary.',
    args: z.object({ run: z.string().min(1) }),
    writes: false,
    describe: (args) => `Show run ${args.run}`,
    run: (services, args) => services.runs.get(args.run),
  }),

  define({
    name: 'question.list',
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
    description: 'Attach a workflow to a project, so runs in that project can use it.',
    args: z.object({ project, workflow: z.string().min(1) }),
    writes: true,
    describe: (args) => `Attach workflow ${args.workflow} to project ${args.project}`,
    run: (services, args) => services.workflows.attach(args.project, args.workflow),
  }),

  define({
    name: 'tool.attach',
    description: "Attach a tool to a project, so the project's agents can be granted it.",
    args: z.object({ project, tool: z.string().min(1) }),
    writes: true,
    describe: (args) => `Attach tool ${args.tool} to project ${args.project}`,
    run: (services, args) => services.tools.attach(args.project, args.tool),
  }),

  define({
    name: 'question.answer',
    description:
      'Answer a question an agent run is waiting on. The run is holding until this arrives, so answer only what you actually know.',
    args: z.object({ question: z.string().min(1), answer: z.string().min(1) }),
    writes: true,
    describe: (args) => `Answer question ${args.question}: "${args.answer}"`,
    run: (services, args) => services.pipelines.answer(args.question, args.answer),
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
build on each other — the second cannot see the result of the first until it is confirmed.`;

/** The catalogue as the model reads it. Regenerated from the entries, never hand-maintained. */
export function actionBriefing(): string {
  const render = (writes: boolean) =>
    CHAT_ACTIONS.filter((action) => action.writes === writes)
      .map((action) => {
        const shape = action.args instanceof z.ZodObject ? Object.keys(action.args.shape) : [];
        return `- \`${action.name}\`(${shape.join(', ')}) — ${action.description}`;
      })
      .join('\n');

  return [
    '## Actions',
    '',
    'These run immediately:',
    '',
    render(false),
    '',
    'These are proposed and wait for the person to confirm:',
    '',
    render(true),
  ].join('\n');
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

  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    const block = ActionBlockSchema.safeParse(tryParse(match[1] ?? ''));
    if (!block.success) continue;
    calls.push(...block.data.actions);
    prose = prose.replace(match[0], '');
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
