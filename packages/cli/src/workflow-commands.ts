import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  AgentRoleSchema,
  StruggleSchema,
  STRUGGLE,
  rosterFor,
  type AgentRole,
  type Struggle,
  type PomniContainer,
} from '@pomni/core';
import type { Command } from 'commander';
import { style, table } from './format.js';

export function registerWorkflowCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const workflow = program
    .command('workflow')
    .alias('wf')
    .description('author agent pipelines');

  workflow
    .command('create <name>')
    .description('create a workflow')
    .option('--id <id>', 'explicit id')
    .option('-d, --description <text>', 'what this pipeline is for')
    .option('--suits <hints>', 'comma-separated hints for picking it automatically')
    .action(async (name: string, flags: { id?: string; description?: string; suits?: string }) => {
      const container = await open();
      const created = await container.workflows.create({
        name,
        id: flags.id,
        description: flags.description,
        suits: split(flags.suits),
      });
      console.log(`${style.green('created')} workflow ${style.bold(created.id)}`);
      console.log(style.dim(`  add an orchestrator:  pomni workflow agent add ${created.id} "Planner" --role orchestrator`));
    });

  workflow
    .command('list')
    .alias('ls')
    .description('list workflows')
    .action(async () => {
      const container = await open();
      const workflows = await container.workflows.list();
      if (workflows.length === 0) {
        console.log(style.dim("none yet — create one with 'pomni workflow create <name>'"));
        return;
      }
      console.log(
        table(
          workflows.map((item) => [
            style.bold(item.id),
            item.name,
            `${item.agents.length} agent${item.agents.length === 1 ? '' : 's'}`,
            item.runnable ? style.green('ready') : style.yellow(`${item.problems.length} problem(s)`),
          ]),
          ['ID', 'NAME', 'AGENTS', 'STATUS'],
        ),
      );
    });

  workflow
    .command('show <id>')
    .description('show a workflow and its agents')
    .action(async (id: string) => {
      const container = await open();
      const found = await container.workflows.get(id);

      console.log(`${style.bold(found.name)}  ${style.dim(`(${found.id})`)}`);
      if (found.description) console.log(found.description);
      if (found.suits.length > 0) console.log(style.dim(`suits: ${found.suits.join(', ')}`));
      console.log();

      if (found.agents.length === 0) {
        console.log(style.dim('no agents yet'));
      } else {
        console.log(
          table(
            found.agents.map((agent) => [
              agent.id === found.entry ? style.cyan('▸') : ' ',
              style.bold(agent.id),
              agent.role === 'orchestrator' ? style.cyan('orchestrator') : 'agent',
              STRUGGLE[agent.struggle].label,
              agent.prompt ? style.green('prompt ✓') : style.red('no prompt'),
              agent.name,
            ]),
            ['', 'ID', 'ROLE', 'MODEL', 'PROMPT', 'NAME'],
          ),
        );
      }

      if (found.problems.length > 0) {
        console.log();
        for (const problem of found.problems) {
          console.log(`${style.yellow('!')} ${problem.message}`);
        }
      }
    });

  workflow
    .command('remove <id>')
    .alias('rm')
    .description('delete a workflow')
    .action(async (id: string) => {
      const container = await open();
      await container.workflows.remove(id);
      console.log(`${style.green('removed')} workflow ${id}`);
    });

  // -- agents ---------------------------------------------------------------

  const agent = workflow.command('agent').description('agents inside a workflow');

  agent
    .command('add <workflow> <name>')
    .description('add an agent')
    .option('-r, --role <role>', 'orchestrator | agent', 'agent')
    .option('-s, --spec <text>', 'what this agent does, in prose')
    .option('--spec-file <path>', 'read the spec from a file')
    .option('-m, --struggle <level>', `${StruggleSchema.options.join(' | ')}`)
    .option('-o, --outputs <text>', 'what it produces')
    .option('--generate', 'generate the prompt from the spec straight away')
    .action(
      async (
        workflowId: string,
        name: string,
        flags: {
          role: string;
          spec?: string;
          specFile?: string;
          struggle?: string;
          outputs?: string;
          generate?: boolean;
        },
      ) => {
        const container = await open();
        const spec = flags.specFile ? await readFile(flags.specFile, 'utf8') : flags.spec;

        const created = await container.workflows.addAgent(workflowId, {
          name,
          role: AgentRoleSchema.parse(flags.role) as AgentRole,
          spec,
          struggle: flags.struggle ? (StruggleSchema.parse(flags.struggle) as Struggle) : undefined,
          outputs: flags.outputs,
        });

        console.log(
          `${style.green('added')} ${style.bold(created.id)}  ${created.role}  ${STRUGGLE[created.struggle].label}`,
        );

        if (flags.generate) {
          console.log(style.dim('generating the prompt…'));
          const withPrompt = await container.workflows.generatePrompt(workflowId, created.id);
          console.log();
          console.log(withPrompt.prompt);
        } else if (spec) {
          console.log(
            style.dim(`  generate its prompt:  pomni workflow agent prompt ${workflowId} ${created.id}`),
          );
        }
      },
    );

  agent
    .command('prompt <workflow> <agent>')
    .description("generate the agent's system prompt from its spec")
    .action(async (workflowId: string, agentId: string) => {
      const container = await open();

      const check = await assertProvider(container);
      if (!check) return;

      console.log(style.dim(`generating via ${check}…`));
      const updated = await container.workflows.generatePrompt(workflowId, agentId);
      console.log();
      console.log(updated.prompt);
    });

  agent
    .command('edit <workflow> <agent>')
    .description('change an agent')
    .option('-n, --name <name>', 'display name')
    .option('-r, --role <role>', 'orchestrator | agent')
    .option('-s, --spec <text>', 'spec')
    .option('--spec-file <path>', 'read the spec from a file')
    .option('--prompt-file <path>', 'set the system prompt from a file')
    .option('-m, --struggle <level>', StruggleSchema.options.join(' | '))
    .option('-o, --outputs <text>', 'what it produces')
    .option('--delegates-to <ids>', 'comma-separated agent ids (orchestrator only)')
    .option('--tools <ids>', 'comma-separated tool ids this agent may use; empty string clears')
    .option('--files', 'let it read and write files')
    .option('--no-files', 'stop it touching files')
    .option('--run', 'let it run commands')
    .option('--no-run', 'stop it running commands')
    .action(
      async (
        workflowId: string,
        agentId: string,
        flags: {
          name?: string;
          role?: string;
          spec?: string;
          specFile?: string;
          promptFile?: string;
          struggle?: string;
          outputs?: string;
          delegatesTo?: string;
          tools?: string;
          files?: boolean;
          run?: boolean;
        },
      ) => {
        const container = await open();

        // A tool is named by id; which kind it is comes from the registry rather than from
        // the person typing, who should not have to remember whether Figma is MCP or a CLI.
        let granted: { mcp: string[]; cli: string[] } | undefined;
        let needsRun = false;

        if (flags.tools !== undefined) {
          const ids = split(flags.tools) ?? [];
          const registry = await container.tools.list();
          granted = { mcp: [], cli: [] };

          for (const id of ids) {
            const found = registry.find((entry) => entry.id === id);
            if (!found) {
              console.error(style.red(`no tool '${id}' — see \`pomni tool list\``));
              process.exitCode = 1;
              return;
            }
            granted[found.kind].push(id);
            if (found.kind === 'cli') needsRun = true;
          }
        }

        const updated = await container.workflows.updateAgent(workflowId, agentId, {
          name: flags.name,
          role: flags.role ? (AgentRoleSchema.parse(flags.role) as AgentRole) : undefined,
          spec: flags.specFile ? await readFile(flags.specFile, 'utf8') : flags.spec,
          prompt: flags.promptFile ? await readFile(flags.promptFile, 'utf8') : undefined,
          struggle: flags.struggle ? (StruggleSchema.parse(flags.struggle) as Struggle) : undefined,
          outputs: flags.outputs,
          delegatesTo: split(flags.delegatesTo),
          tools: {
            ...granted,
            ...(flags.files === undefined ? {} : { files: flags.files }),
            // A CLI tool is run through the shell. Granting one without that is granting
            // nothing, so turn it on and say so rather than leaving a silent no-op.
            ...(flags.run === undefined ? (needsRun ? { run: true } : {}) : { run: flags.run }),
          },
        });

        console.log(`${style.green('updated')} ${updated.id}`);
        if (updated.tools.mcp.length > 0 || updated.tools.cli.length > 0) {
          console.log(
            style.dim(`  tools: ${[...updated.tools.mcp, ...updated.tools.cli].join(', ')}`),
          );
        }
        if (needsRun && flags.run === undefined) {
          console.log(style.dim('  enabled `run` — a CLI tool is useless without it'));
        }
      },
    );

  agent
    .command('show <workflow> <agent>')
    .description('show an agent and its prompt')
    .action(async (workflowId: string, agentId: string) => {
      const container = await open();
      const found = await container.workflows.get(workflowId);
      const target = found.agents.find((item) => item.id === agentId);
      if (!target) {
        console.error(style.red(`no agent '${agentId}' in '${workflowId}'`));
        process.exitCode = 1;
        return;
      }

      console.log(`${style.bold(target.name)}  ${style.dim(`(${target.id})`)}`);
      console.log(`role     ${target.role}`);
      console.log(`effort   ${STRUGGLE[target.struggle].label}  ${style.dim(STRUGGLE[target.struggle].note)}`);
      if (target.outputs) console.log(`outputs  ${target.outputs}`);
      if (target.role === 'orchestrator') {
        const roster = rosterFor(found, target);
        console.log(`roster   ${roster.map((item) => item.id).join(', ') || style.dim('(none)')}`);
      }

      if (target.spec) {
        console.log();
        console.log(style.dim('— spec —'));
        console.log(target.spec.trim());
      }
      console.log();
      console.log(style.dim('— prompt —'));
      console.log(target.prompt.trim() || style.dim('(not generated yet)'));
    });

  agent
    .command('remove <workflow> <agent>')
    .alias('rm')
    .description('remove an agent')
    .action(async (workflowId: string, agentId: string) => {
      const container = await open();
      await container.workflows.removeAgent(workflowId, agentId);
      console.log(`${style.green('removed')} ${agentId}`);
    });

  workflow
    .command('generate <id>')
    .description('generate the system prompt for every agent that has a spec but no prompt')
    .option('--all', 'regenerate every agent, not just the ones missing a prompt')
    .action(async (id: string, flags: { all?: boolean }) => {
      const container = await open();

      const check = await assertProvider(container);
      if (!check) return;

      const found = await container.workflows.get(id);
      const targets = found.agents.filter(
        (agent) => agent.spec.trim() && (flags.all || !agent.prompt.trim()),
      );

      if (targets.length === 0) {
        console.log(style.dim('nothing to generate — every agent with a spec already has a prompt'));
        return;
      }

      console.log(style.dim(`generating ${targets.length} prompt(s)…`));
      let failed = 0;

      // Sequential on purpose: a burst of parallel calls is the fastest way to get rate
      // limited, and this runs once per workflow.
      for (const agent of targets) {
        process.stdout.write(`  ${agent.id.padEnd(24)} `);
        try {
          const updated = await container.workflows.generatePrompt(id, agent.id);
          console.log(style.green(`${updated.prompt.length} chars`));
        } catch (error) {
          failed += 1;
          console.log(style.red(error instanceof Error ? error.message : String(error)));
        }
      }

      console.log();
      const after = await container.workflows.get(id);
      console.log(
        after.runnable
          ? style.green(`${found.name} is ready to run`)
          : style.yellow(`${after.problems.length} thing(s) still to fix — pomni workflow show ${id}`),
      );
      if (failed > 0) process.exitCode = 1;
    });

  // -- portability ----------------------------------------------------------

  workflow
    .command('export <id>')
    .description('write a workflow to a portable file')
    .option('-o, --out <path>', 'output path (default: <id>.pomni.json)')
    .action(async (id: string, flags: { out?: string }) => {
      const container = await open();
      const content = await container.workflows.export(id);
      const path = flags.out ?? `${id}.pomni.json`;
      await writeFile(path, content, 'utf8');
      console.log(`${style.green('exported')} ${path}`);
    });

  workflow
    .command('import <path>')
    .description('import a workflow file')
    .option('--id <id>', 'import under a different id')
    .action(async (path: string, flags: { id?: string }) => {
      const container = await open();
      const imported = await container.workflows.import(await readFile(path, 'utf8'), {
        id: flags.id,
      });
      console.log(`${style.green('imported')} ${style.bold(imported.id)}  ${imported.name}`);
    });

  workflow
    .command('attach <id>')
    .description('attach a workflow to a project')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const attached = await container.workflows.attach(projectId, id);
      console.log(`${style.green('attached')} ${id} → ${projectId}`);
      console.log(style.dim(`  ${projectId} now has: ${attached.join(', ')}`));
    });

  workflow
    .command('detach <id>')
    .description('detach a workflow from a project')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      await container.workflows.detach(projectId, id);
      console.log(`${style.green('detached')} ${id} from ${projectId}`);
    });
}

/**
 * Confirms something can actually run a model, and says which. Returns null (having already
 * printed why) when nothing can, so callers can bail without duplicating the message.
 */
async function assertProvider(container: PomniContainer): Promise<string | null> {
  try {
    const provider = await container.providers.resolve();
    const { port } = await container.providers.portFor('high', { provider: provider.id });

    if (!(await port.isConfigured())) {
      console.error(style.red(`'${provider.label}' is not usable — ${await port.describeAuth()}`));
      console.error(style.dim('  see what is available:  pomni provider list'));
      process.exitCode = 1;
      return null;
    }
    return provider.label;
  } catch (error) {
    console.error(style.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return null;
  }
}

export function registerTaskCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const task = program.command('task').description('run a task through an agent workflow');

  task
    .command('run [text...]')
    .description('run a task, or a backlog item, through a workflow')
    .option('-p, --project <id>', 'project')
    .option('-w, --workflow <id>', 'workflow (default: chosen from the task)')
    .option('-i, --item <ID>', 'backlog item to run; its spec becomes the task')
    .option('-r, --repo <id>', 'repo the agents work in')
    .option(
      '-f, --file <path>',
      'attach a file as context; repeat for several',
      (value: string, all: string[]) => [...all, value],
      [] as string[],
    )
    .action(
      async (
        text: string[],
        flags: {
          project?: string;
          workflow?: string;
          item?: string;
          repo?: string;
          file: string[];
        },
      ) => {
        const container = await open();
        const projectId = flags.project ?? (await defaultProject());

        let description = text.join(' ').trim();
        if (flags.item) {
          const item = await container.backlog.get(projectId, flags.item.toUpperCase());
          description = `${item.title}

${item.body}`;
        }

        // Read here rather than in the service: the paths are the user's, relative to the
        // terminal they typed them in, and only this process knows that directory.
        const context = await Promise.all(
          flags.file.map(async (path) => ({
            name: basename(path),
            content: await readFile(resolve(path), 'utf8'),
          })),
        );

        const { run, completion } = await container.pipelines.start({
          projectId,
          task: description,
          workflowId: flags.workflow,
          itemId: flags.item?.toUpperCase(),
          repoId: flags.repo,
          context,
        });

        console.log(`${style.cyan('run')} ${style.bold(run.id)}  ${run.workflowName}`);
        if (run.context.length > 0) {
          console.log(
            style.dim(`  context:   ${run.context.map((file) => file.name).join(', ')}`),
          );
        }
        console.log(style.dim(`  watch it:  http://localhost:7777/p/${projectId}/console/${run.id}`));
        console.log();

        // Live progress, so a terminal run is as watchable as the console.
        container.events.subscribe((event) => {
          if (event.type === 'pipeline.step.started') {
            const indent = '  '.repeat(event.depth);
            console.log(`${indent}${style.cyan('▸')} ${style.bold(event.agentName)} ${style.dim(event.model)}`);
          }
          if (event.type === 'pipeline.step.finished') {
            console.log(
              `  ${event.status === 'done' ? style.green('✓') : style.red('✗')} ${style.dim(event.summary)}`,
            );
          }
        });

        const finished = await completion;
        console.log();
        console.log(
          finished.status === 'passed'
            ? style.green(`finished in ${Math.round((finished.durationMs ?? 0) / 1000)}s`)
            : style.red(`${finished.status}: ${finished.error ?? ''}`),
        );
        if (finished.gateStatus !== 'skipped') {
          console.log(`gate ${finished.gateStatus}: ${finished.gateSummary ?? ''}`);
        }
        if (finished.result) {
          console.log();
          console.log(finished.result);
        }
        if (finished.status !== 'passed') process.exitCode = 1;
      },
    );

  task
    .command('rerun <id>')
    .description('run a finished run again, telling the agents why the last one ended')
    .action(async (id: string) => {
      const container = await open();
      const { run, completion } = await container.pipelines.rerun(id);

      console.log(`${style.cyan('rerun')} ${style.bold(run.id)}  ${run.workflowName}`);
      console.log(style.dim(`  retrying ${run.rerunOf}`));
      console.log(
        style.dim(`  watch it:  http://localhost:7777/p/${run.projectId}/console/${run.id}`),
      );

      const finished = await completion;
      console.log(
        finished.status === 'passed'
          ? style.green(`finished ${finished.outcome}`)
          : style.red(`${finished.status}: ${finished.error ?? ''}`),
      );
      if (finished.status !== 'passed') process.exitCode = 1;
    });

  task
    .command('questions')
    .description('what the running pipelines are waiting to be told')
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const questions = await container.pipelines.openQuestions(flags.project);

      if (questions.length === 0) {
        console.log(style.dim('nothing is waiting on you'));
        return;
      }

      for (const question of questions) {
        console.log(`${style.cyan(question.id.slice(-8))}  ${style.bold(question.agentName)}`);
        console.log(`  ${question.question}`);
        console.log(style.dim(`  answer it:  pomni task answer ${question.id} "…"`));
        console.log();
      }
    });

  task
    .command('answer <questionId> [text...]')
    .description('answer a question a run is waiting on')
    .option(
      '-f, --file <path>',
      'attach a file with the answer; repeat for several',
      (value: string, all: string[]) => [...all, value],
      [] as string[],
    )
    .action(async (questionId: string, text: string[], flags: { file: string[] }) => {
      const container = await open();

      const files = await Promise.all(
        flags.file.map(async (path) => ({
          name: basename(path),
          content: await readFile(resolve(path), 'utf8'),
        })),
      );

      // The id is long; accept the tail the questions list prints.
      const open_ = await container.pipelines.openQuestions();
      const match = open_.find(
        (question) => question.id === questionId || question.id.endsWith(questionId),
      );

      const answered = await container.pipelines.answer(
        match?.id ?? questionId,
        text.join(' '),
        files,
      );
      console.log(`${style.green('answered')} ${answered.id.slice(-8)}`);
      if (answered.attachments.length > 0) {
        console.log(
          style.dim(`  attached: ${answered.attachments.map((file) => file.name).join(', ')}`),
        );
      }
      console.log(style.dim('  the run picks it up within a second'));
    });

  task
    .command('cancel <id>')
    .description('stop a run, or close out one whose process is gone')
    .action(async (id: string) => {
      const container = await open();
      const run = await container.pipelines.cancel(id);
      console.log(
        run.status === 'cancelled'
          ? `${style.green('cancelled')} ${run.id}  ${style.dim(run.error ?? '')}`
          : `${style.dim('asked to stop')} ${run.id} — in-flight agents will finish`,
      );
    });

  task
    .command('list')
    .description('recent pipeline runs')
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const runs = await container.pipelines.list({
        projectId: flags.project ?? (await defaultProject()),
      });

      if (runs.length === 0) {
        console.log(style.dim('nothing has run yet'));
        return;
      }

      console.log(
        table(
          runs.map((run) => [
            style.dim(run.id.slice(-8)),
            run.status === 'passed' ? style.green(run.status) : style.red(run.status),
            run.workflowName,
            run.itemId ?? '',
            truncate(run.task, 46),
          ]),
          ['ID', 'STATUS', 'WORKFLOW', 'ITEM', 'TASK'],
        ),
      );
    });
}

export function registerProviderCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
): void {
  const provider = program
    .command('provider')
    .description('where models run: Claude Code, an API key, or a local endpoint');

  provider
    .command('list', { isDefault: true })
    .description('providers and whether each one works right now')
    .action(async () => {
      const container = await open();
      const status = await container.providers.status();

      console.log(
        table(
          status.providers.map((item) => [
            item.id === status.default ? style.cyan('*') : ' ',
            style.bold(item.id),
            item.kind,
            item.available ? style.green('ready') : style.red('unavailable'),
            item.detail,
          ]),
          ['', 'ID', 'KIND', 'STATUS', 'DETAIL'],
        ),
      );
    });

  provider
    .command('add <label>')
    .description('add a provider')
    .requiredOption('-k, --kind <kind>', 'claude-code | anthropic | openai')
    .option('--id <id>', 'explicit id')
    .option('-u, --base-url <url>', 'for openai-compatible endpoints, including /v1')
    .option('--api-key-env <VAR>', 'env var holding the key (never the key itself)')
    .option('--low <model>', 'model for the low level')
    .option('--medium <model>', 'model for the medium level')
    .option('--high <model>', 'model for the high level')
    .option('--max <model>', 'model for the max level')
    .action(
      async (
        label: string,
        flags: {
          kind: string;
          id?: string;
          baseUrl?: string;
          apiKeyEnv?: string;
          low?: string;
          medium?: string;
          high?: string;
          max?: string;
        },
      ) => {
        const container = await open();
        const created = await container.providers.create({
          label,
          kind: flags.kind as 'claude-code' | 'anthropic' | 'openai',
          id: flags.id,
          baseUrl: flags.baseUrl,
          apiKeyEnv: flags.apiKeyEnv,
          models: {
            low: flags.low,
            medium: flags.medium,
            high: flags.high,
            max: flags.max,
          },
        });
        console.log(`${style.green('added')} provider ${style.bold(created.id)}`);
      },
    );

  provider
    .command('use <id>')
    .description('make this the default provider')
    .action(async (id: string) => {
      const container = await open();
      await container.providers.setDefault(id);
      console.log(`${style.green('default provider')} ${style.bold(id)}`);
    });

  provider
    .command('models <id>')
    .description('ask an openai-compatible endpoint what models it serves')
    .action(async (id: string) => {
      const container = await open();
      const found = await container.providers.get(id);
      if (found.kind !== 'openai') {
        console.log(style.dim('only openai-compatible providers can be asked'));
        return;
      }

      const { OpenAiCompatibleLlm } = await import('@pomni/infra');
      const client = new OpenAiCompatibleLlm({
        baseUrl: found.baseUrl ?? '',
        apiKey: found.apiKeyEnv ? process.env[found.apiKeyEnv] : undefined,
        label: found.label,
      });

      const models = await client.listModels();
      console.log(models.length > 0 ? models.join(String.fromCharCode(10)) : style.dim('none reported'));
    });

  provider
    .command('remove <id>')
    .alias('rm')
    .description('remove a provider')
    .action(async (id: string) => {
      const container = await open();
      await container.providers.remove(id);
      console.log(`${style.green('removed')} provider ${id}`);
    });
}

export function registerDiscoveryCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const discover = program
    .command('discover')
    .description('find agents, skills and rules already inside a project\'s repos');

  discover
    .command('list', { isDefault: true })
    .description('scan the repos and list what is there')
    .option('-p, --project <id>', 'project')
    .option('-r, --repo <id>', 'one repo only')
    .option('-k, --kind <kind>', 'agent | skill | command | rules')
    .action(async (flags: { project?: string; repo?: string; kind?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const report = await container.discovery.scan(projectId, { repoId: flags.repo });

      for (const entry of report.scanned) {
        console.log(style.dim(`scanned ${entry.repoId}: ${entry.found} found`));
      }
      console.log();

      const assets = flags.kind
        ? report.assets.filter((asset) => asset.kind === flags.kind)
        : report.assets;

      if (assets.length === 0) {
        console.log(style.dim('nothing found'));
        return;
      }

      console.log(
        table(
          assets.map((asset) => [
            style.dim(asset.kind),
            style.bold(asset.id),
            asset.repoId,
            truncate(asset.description, 68),
          ]),
          ['KIND', 'ID', 'REPO', 'DESCRIPTION'],
        ),
      );
      console.log();
      console.log(
        style.dim(`import one:  pomni discover import <id> --into <workflow> -p ${projectId}`),
      );
    });

  discover
    .command('show <assetId>')
    .description('print a discovered asset in full')
    .option('-p, --project <id>', 'project')
    .action(async (assetId: string, flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const report = await container.discovery.scan(projectId);
      const asset = report.assets.find((candidate) => candidate.id === assetId);

      if (!asset) {
        console.error(style.red(`nothing called '${assetId}' was found`));
        process.exitCode = 1;
        return;
      }

      console.log(`${style.bold(asset.name)}  ${style.dim(`(${asset.kind})`)}`);
      console.log(style.dim(`${asset.repoId}:${asset.path}`));
      if (asset.description) console.log(asset.description);
      if (asset.tools.length > 0) console.log(style.dim(`tools: ${asset.tools.join(', ')}`));
      console.log();
      console.log(asset.body);
    });

  discover
    .command('import <assetId>')
    .description('add a discovered agent to a workflow, prompt and all')
    .requiredOption('--into <workflow>', 'workflow to add it to')
    .option('-p, --project <id>', 'project')
    .action(async (assetId: string, flags: { into: string; project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const result = await container.discovery.importAgent(projectId, flags.into, assetId);
      console.log(`${style.green('imported')} ${assetId} → ${flags.into}/${result.agentId}`);
      console.log(style.dim('  its own text became the prompt; edit the spec to regenerate'));
    });
}

function truncate(text: string, max: number): string {
  const line = text.split('\n')[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}\u2026`;
}

function split(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
