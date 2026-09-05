import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ItemStatusSchema,
  ItemTypeSchema,
  PomniError,
  PrioritySchema,
  describeSource,
  type PomniContainer,
} from '@pomni/core';

/**
 * Pomni as MCP tools, so a Claude session — in this repo or in any other MCP client — drives
 * the same services the CLI does. The tools are thin: they parse arguments, call a service,
 * and render text. Every rule they appear to enforce actually lives in the application layer.
 *
 * Read tools are cheap and side-effect free. Write tools say plainly what they changed.
 * There is deliberately no tool that runs an arbitrary shell command: `pomni_run` executes
 * only capabilities the repo already declared.
 */
export function createMcpServer(container: PomniContainer): McpServer {
  const server = new McpServer({ name: 'pomni', version: '0.1.0' });

  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
  const fail = (error: unknown) => ({
    content: [
      {
        type: 'text' as const,
        text: error instanceof PomniError ? error.message : String(error),
      },
    ],
    isError: true,
  });

  const guard = <T>(fn: () => Promise<T>, render: (value: T) => string) => async () => {
    try {
      return text(render(await fn()));
    } catch (error) {
      return fail(error);
    }
  };

  // -- projects and repos ---------------------------------------------------

  server.registerTool(
    'pomni_project_list',
    {
      title: 'List projects',
      description: 'Every project in this Pomni workspace, with its repos.',
      inputSchema: {},
    },
    guard(
      () => container.projects.list(),
      (projects) =>
        projects.length === 0
          ? 'No projects yet.'
          : projects
              .map(
                (project) =>
                  `${project.id}  ${project.name}  repos: ${
                    project.repos.map((repo) => repo.id).join(', ') || 'none'
                  }`,
              )
              .join('\n'),
    ),
  );

  server.registerTool(
    'pomni_repo_list',
    {
      title: 'List repos',
      description:
        'Repos in a project, with the working directory each one resolves to and the commands it declares. Use this to find out where the code actually is before editing it.',
      inputSchema: { project: z.string() },
    },
    async ({ project }) => {
      try {
        const repos = await container.repos.listResolved(project);
        if (repos.length === 0) return text(`Project '${project}' has no repos.`);

        return text(
          repos
            .map((repo) =>
              [
                `${repo.id} (${repo.role}, ${repo.status})`,
                `  path: ${repo.workingDir}${repo.workingDirExists ? '' : '  [MISSING]'}`,
                `  source: ${describeSource(repo.source)}`,
                `  stack: ${repo.stack?.detected.join(', ') ?? 'unknown'}`,
                `  capabilities: ${Object.keys(repo.capabilities).sort().join(', ') || 'none'}`,
              ].join('\n'),
            )
            .join('\n\n'),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  // -- backlog --------------------------------------------------------------

  server.registerTool(
    'pomni_backlog_list',
    {
      title: 'List backlog items',
      description:
        "Backlog items for a project. Status 'active' excludes done and cancelled, which is usually what you want.",
      inputSchema: {
        project: z.string(),
        status: z.string().optional(),
        repo: z.string().optional(),
      },
    },
    async ({ project, status, repo }) => {
      try {
        const items = await container.backlog.list({
          projectId: project,
          status:
            status === 'active'
              ? ['backlog', 'specced', 'ready', 'in_progress', 'in_review', 'blocked']
              : (ItemStatusSchema.safeParse(status).data ?? undefined),
          repo,
        });

        if (items.length === 0) return text('No matching items.');
        return text(
          items
            .map(
              (item) =>
                `${item.id}  [${item.status}]  ${item.priority}  ${item.title}${
                  item.repos.length > 0 ? `  (${item.repos.join(', ')})` : ''
                }`,
            )
            .join('\n'),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_backlog_show',
    {
      title: 'Show a backlog item',
      description:
        'The full item: frontmatter, dependency state, acceptance progress and the whole spec body.',
      inputSchema: { project: z.string(), item: z.string() },
    },
    async ({ project, item }) => {
      try {
        const found = await container.backlog.get(project, item.toUpperCase());
        const lines = [
          `${found.id}  ${found.title}`,
          `status: ${found.status}  priority: ${found.priority}  type: ${found.type}`,
          found.repos.length > 0 ? `repos: ${found.repos.join(', ')}` : null,
          found.blockedBy.length > 0 ? `WAITING ON: ${found.blockedBy.join(', ')}` : null,
          found.blocking.length > 0 ? `blocks: ${found.blocking.join(', ')}` : null,
          found.blockedReason ? `BLOCKED: ${found.blockedReason}` : null,
          found.acceptance.total > 0
            ? `acceptance: ${found.acceptance.checked}/${found.acceptance.total}`
            : null,
          '',
          found.body.trimEnd(),
        ].filter((line): line is string => line !== null);

        return text(lines.join('\n'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_backlog_add',
    {
      title: 'Capture a backlog item',
      description:
        'Create an item. It starts in `backlog` with a spec template; fill in the Problem and Acceptance criteria sections before moving it on.',
      inputSchema: {
        project: z.string(),
        title: z.string(),
        type: ItemTypeSchema.optional(),
        priority: PrioritySchema.optional(),
        repos: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const created = await container.backlog.create(args.project, {
          title: args.title,
          type: args.type,
          priority: args.priority,
          repos: args.repos,
          labels: args.labels,
        });
        return text(
          `Created ${created.id}: ${created.title}\nFile: ${container.root}/projects/${args.project}/backlog/${created.id}.md`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_backlog_move',
    {
      title: 'Move a backlog item',
      description:
        'Run a state-machine transition. Guards apply: specced needs a Problem and acceptance criteria, ready needs a Plan, in_progress needs its dependencies done, in_review needs the gate green. Use force only when you mean to override, and say why.',
      inputSchema: {
        project: z.string(),
        item: z.string(),
        to: ItemStatusSchema,
        reason: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const moved = await container.backlog.transition(args.project, args.item.toUpperCase(), args.to, {
          reason: args.reason,
          force: args.force,
        });
        return text(`${moved.id} is now ${moved.status}.`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_backlog_edit',
    {
      title: 'Edit a backlog item',
      description:
        'Change fields, or replace the spec body wholesale. To edit prose incrementally, read the item file and use ordinary file tools instead — the body round-trips byte-exactly.',
      inputSchema: {
        project: z.string(),
        item: z.string(),
        title: z.string().optional(),
        priority: PrioritySchema.optional(),
        repos: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        body: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const updated = await container.backlog.update(args.project, args.item.toUpperCase(), {
          title: args.title,
          priority: args.priority,
          repos: args.repos,
          labels: args.labels,
          body: args.body,
        });
        return text(`Updated ${updated.id}.`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // -- execution ------------------------------------------------------------

  server.registerTool(
    'pomni_run',
    {
      title: 'Run a capability',
      description:
        'Execute a command the repo already declared (test, build, lint, typecheck, e2e). Fans out across every repo declaring it unless a repo is named. This cannot run arbitrary shell commands.',
      inputSchema: {
        project: z.string(),
        capability: z.string(),
        repo: z.string().optional(),
        item: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const runs = await container.runs.run(args.project, args.capability, {
          repoId: args.repo,
          itemId: args.item,
        });
        return text(
          runs
            .map(
              (run) =>
                `${run.status.toUpperCase()}  ${run.repoId} ${run.capability}  ${
                  run.summary ?? ''
                }\n  ${run.cmd}  (run ${run.id})`,
            )
            .join('\n'),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_verify',
    {
      title: 'Run the gate',
      description:
        "Run the project's gate — each capability in order across every repo that declares it, stopping at the first failure. This is the evidence an item needs to reach review.",
      inputSchema: {
        project: z.string(),
        gate: z.enum(['default', 'land']).optional(),
        repo: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const report = await container.runs.gate(args.project, args.gate ?? 'default', {
          repoId: args.repo,
        });
        const lines = report.results.map((result) => {
          const detail =
            result.status === 'skipped'
              ? 'no repo declares it'
              : result.runs.map((run) => `${run.repoId}: ${run.summary ?? run.status}`).join('; ');
          return `${result.status.toUpperCase().padEnd(8)} ${result.capability}  ${detail}`;
        });
        return text(
          [...lines, '', report.passed ? 'GATE PASSED' : 'GATE FAILED'].join('\n'),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_runs_list',
    {
      title: 'Recent runs',
      description: 'Run history, newest first. Use failedOnly to see what is currently broken.',
      inputSchema: {
        project: z.string().optional(),
        repo: z.string().optional(),
        capability: z.string().optional(),
        failedOnly: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (args) => {
      try {
        const runs = await container.runs.list({
          projectId: args.project,
          repoId: args.repo,
          capability: args.capability,
          failedOnly: args.failedOnly,
          limit: args.limit ?? 20,
        });
        if (runs.length === 0) return text('No runs recorded.');
        return text(
          runs
            .map(
              (run) =>
                `${run.id}  ${run.status}  ${run.projectId}/${run.repoId} ${run.capability}  ${
                  run.summary ?? ''
                }`,
            )
            .join('\n'),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'pomni_run_log',
    {
      title: 'Read a run log',
      description: 'The tail of a run log — what you need to explain why something failed.',
      inputSchema: { runId: z.string(), lines: z.number().int().positive().max(500).optional() },
    },
    async ({ runId, lines }) => {
      try {
        const run = await container.runs.get(runId);
        const { readLogFrom } = await import('@pomni/infra');
        const { text: log } = await readLogFrom(run.logPath, 0);
        const all = log.split(/\r?\n/);
        const tail = all.slice(-(lines ?? 80));
        return text(
          `${run.status} ${run.projectId}/${run.repoId} ${run.capability}\n${run.cmd}\n\n${tail.join('\n')}`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

/** Run the server over stdio, which is how Claude Code connects to it. */
export async function startStdioServer(container: PomniContainer): Promise<void> {
  const server = createMcpServer(container);
  await server.connect(new StdioServerTransport());
}
