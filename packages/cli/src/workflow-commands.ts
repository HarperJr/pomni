import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  AgentRoleSchema,
  since,
  HANDOVER_PROTOCOL,
  VERDICT_PROTOCOL,
  StruggleSchema,
  STRUGGLE,
  rosterFor,
  workLocation,
  type AgentRole,
  type Struggle,
  type PomniContainer,
} from '@pomni/core';
import type { Command } from 'commander';
import { style, table, visibleLength } from './format.js';

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
              agent.provider ?? style.dim('(run)'),
              agent.prompt ? style.green('prompt ✓') : style.red('no prompt'),
              agent.name,
            ]),
            ['', 'ID', 'ROLE', 'STRUGGLE', 'PROVIDER', 'PROMPT', 'NAME'],
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
    .command('lint <id>')
    .description('what each agent will carry on every turn, before a run pays for it')
    .option('-p, --project <id>', 'project whose promptBudget to measure against')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const found = await container.workflows.get(id);
      const projectId = flags.project ?? (await defaultProject());
      const budget = (await container.projects.getRef(projectId)).data.policy.promptBudget;

      // The fixed frame every turn carries whatever the agent is: the two protocols an agent
      // always ends with, plus the abilities block. The roster and the repo list vary per run
      // and per agent, so they are not counted here — this is the floor, not the bill.
      const scaffolding =
        Buffer.byteLength(HANDOVER_PROTOCOL, 'utf8') + Buffer.byteLength(VERDICT_PROTOCOL, 'utf8');

      const rows = lintReport(found.agents, scaffolding, budget);
      console.log(
        table(
          rows.map((row) => [
            style.bold(row.id),
            thousands(row.prompt),
            thousands(row.scaffolding),
            thousands(row.total),
            row.flags.length > 0 ? style.yellow(row.flags.join(', ')) : style.dim('—'),
          ]),
          ['AGENT', 'PROMPT', 'FRAME', 'PER TURN', 'FLAGS'],
        ),
      );
      console.log(
        style.dim(
          `budget ${thousands(budget)} bytes a turn (policy.promptBudget on '${projectId}').` +
            ' An orchestrator also carries the roster, and an agent that touches files carries' +
            ' the repo list — neither is counted above, because both depend on the run.',
        ),
      );
    });

  workflow
    .command('signals [id]')
    .description('what keeps going wrong in a workflow, from the runs that already happened')
    .option('-p, --project <id>', 'project')
    .option('--all', 'every signal, not only the ones that repeated')
    .action(async (id: string | undefined, flags: { project?: string; all?: boolean }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const { signals, findings } = await container.pipelines.signals(projectId, id);

      if (signals.length === 0) {
        console.log(style.dim('nothing to report — no runs, or nothing went wrong in them'));
        return;
      }

      if (findings.length === 0) {
        console.log(style.dim(`${signals.length} signals, none repeated across three runs yet`));
      } else {
        const workflows = id ? [await container.workflows.get(id)] : await container.workflows.list();
        const changedAt = new Map(
          workflows.flatMap((found) => found.agents.map((agent) => [agent.id, agent.updatedAt])),
        );
        const runs = (await container.pipelines.list({ projectId, limit: 200 })).map((run) => ({
          id: run.id,
          startedAt: run.startedAt,
        }));

        console.log(style.bold('what keeps happening'));
        for (const finding of findings) {
          // Measured against when the agent last changed. Not proof either way — the runs
          // since may simply not have exercised it — so the count of those runs is shown
          // beside the figure rather than a verdict in place of it.
          const edited = finding.agentId ? changedAt.get(finding.agentId) : undefined;
          const split = edited
            ? since(signals.filter((s) => s.kind === finding.kind && s.agentId === finding.agentId), runs, edited)
            : null;

          console.log(
            `   ${style.yellow(finding.kind.padEnd(13))} ${(finding.agentName ?? 'the run').padEnd(18)}` +
              ` ${finding.runIds.length} runs` +
              (split && split.runsAfter > 0
                ? style.dim(
                    `  · ${split.after} of them since this agent last changed` +
                      ` (${split.runsAfter} runs ago)`,
                  )
                : split
                  ? style.dim('  · no runs since this agent last changed')
                  : ''),
          );
          // The wording is the evidence, so one example is shown whole rather than summarised.
          console.log(`      ${style.dim(truncate(finding.details[0] ?? '', 96))}`);
        }
        console.log();
      }

      if (!flags.all) {
        console.log(style.dim(`${signals.length} signals in all — 'pomni workflow signals --all' lists them`));
        return;
      }

      console.log(style.bold('every signal'));
      for (const signal of signals) {
        console.log(
          `   ${style.dim(signal.runId.slice(-8))} ${signal.kind.padEnd(13)}` +
            ` ${(signal.agentName ?? '—').padEnd(18)} ${truncate(signal.detail, 70)}`,
        );
      }
    });

  workflow
    .command('amend <workflow> <agent>')
    .description('propose a spec change from what keeps going wrong, and never apply it silently')
    .option('-p, --project <id>', 'project whose runs are the evidence')
    .option('-k, --kind <kind>', 'which signal to answer, when an agent has more than one')
    .option('--apply', 'write the amended spec and regenerate the prompt from it')
    .action(
      async (
        workflowId: string,
        agentId: string,
        flags: { project?: string; kind?: string; apply?: boolean },
      ) => {
        const container = await open();
        const projectId = flags.project ?? (await defaultProject());
        const { findings } = await container.pipelines.signals(projectId, workflowId);

        const forAgent = findings.filter(
          (finding) => finding.agentId === agentId && (!flags.kind || finding.kind === flags.kind),
        );
        if (forAgent.length === 0) {
          console.log(style.dim(`nothing keeps happening to '${agentId}' — nothing to answer`));
          return;
        }
        if (forAgent.length > 1 && !flags.kind) {
          console.log(style.yellow(`'${agentId}' has more than one — name it with --kind:`));
          for (const finding of forAgent) {
            console.log(`   ${finding.kind.padEnd(13)} ${finding.runIds.length} runs`);
          }
          return;
        }

        const finding = forAgent[0] as (typeof forAgent)[number];
        console.log(style.bold(`${finding.kind} · ${finding.runIds.length} runs`));
        for (const detail of finding.details.slice(0, 3)) {
          console.log(`   ${style.dim(truncate(detail, 96))}`);
        }
        console.log();

        console.log(style.dim('asking for an amendment…'));
        const { current, proposed } = await container.workflows.proposeAmendment(
          workflowId,
          agentId,
          finding,
        );

        if (proposed.trim() === current.trim()) {
          // The model was told to say so rather than invent wording for a permissions bug.
          console.log(style.yellow('the model returned the spec unchanged — this is not a wording problem'));
          return;
        }

        console.log(style.bold('proposed spec'));
        console.log(proposed);
        console.log();

        if (!flags.apply) {
          console.log(
            style.dim(`nothing was written. Apply it with: pomni workflow amend ${workflowId} ${agentId} --apply`),
          );
          return;
        }

        await container.workflows.updateAgent(workflowId, agentId, { spec: proposed });
        console.log(style.dim('regenerating the prompt from it…'));
        await container.workflows.generatePrompt(workflowId, agentId);
        console.log(`${style.green('amended')} ${agentId} — the prompt is derived from the new spec`);
        console.log(
          style.dim(
            "the finding stays open: 'pomni workflow signals' will show whether it recurs in the runs after this",
          ),
        );
      },
    );

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
    .option('--provider <id>', "where this agent runs; empty string clears back to the run's provider")
    .option('-o, --outputs <text>', 'what it produces')
    .option('--delegates-to <ids>', 'comma-separated agent ids (orchestrator only)')
    .option('--tools <ids>', 'comma-separated tool ids this agent may use; empty string clears')
    .option('--files', 'let it read and write files')
    .option('--no-files', 'stop it touching files')
    .option('--run', 'let it run commands')
    .option('--verify', "let it run the repos' declared checks, and nothing else")
    .option('--no-verify', 'take that away')
    .option('--no-run', 'stop it running commands')
    .option('--web', 'let it search and fetch pages')
    .option('--no-web', 'take that away')
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
          provider?: string;
          outputs?: string;
          delegatesTo?: string;
          tools?: string;
          files?: boolean;
          run?: boolean;
          verify?: boolean;
          web?: boolean;
        },
      ) => {
        const container = await open();

        // A tool is named by id; which kind it is comes from the registry rather than from
        // the person typing, who should not have to remember whether Figma is MCP or a CLI.
        let granted: { mcp: string[]; cli: string[] } | undefined;
        let needsRun = false;

        // Refuse a bad provider id here, at edit time, rather than leaving it to be
        // discovered when the run starts.
        //
        // TODO: ProviderService is meant to grow a public `assertAgentCanRun(agent, providerId)`
        // that also checks the provider is enabled and can give this agent the tools it asks
        // for (only a claude-code provider has a tool loop at all — see `needsBuiltInTools`).
        // That method was not importable yet at the time this was written. Once it lands,
        // call it here instead of the bare existence check below, so this and the run-start
        // check enforce exactly the same rule rather than two hand-written copies of it.
        if (flags.provider !== undefined && flags.provider.trim()) {
          const providerId = flags.provider.trim();
          const provider = await container.providers.get(providerId).catch(() => null);
          if (!provider) {
            console.error(style.red(`no provider '${providerId}' — see \`pomni provider list\``));
            process.exitCode = 1;
            return;
          }
        }

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
          provider: flags.provider,
          outputs: flags.outputs,
          delegatesTo: split(flags.delegatesTo),
          tools: {
            ...granted,
            ...(flags.files === undefined ? {} : { files: flags.files }),
            ...(flags.verify === undefined ? {} : { verify: flags.verify }),
            ...(flags.web === undefined ? {} : { web: flags.web }),
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
            origin: 'attached' as const,
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
            console.log(
              `${indent}${style.cyan('▸')} ${style.bold(event.agentName)} ${style.dim(`${event.providerId} · ${event.model}`)}`,
            );
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
    .command('resume <id> [note...]')
    .description('carry on an interrupted run, keeping what it already did')
    .action(async (id: string, note: string[]) => {
      const container = await open();
      const { run, completion, reused } = await container.pipelines.resume(id, note.join(' '));

      console.log(`${style.cyan('resumed')} ${style.bold(run.id)}  ${run.workflowName}`);
      // Offered, not spent: the ledger answers a delegation only when the orchestrator asks
      // for it in the same words, so claiming these were reused would be a claim we cannot
      // make until the run is over.
      console.log(
        style.dim(
          `  ${reused ?? 0} step${reused === 1 ? '' : 's'} can be answered from the last attempt`,
        ),
      );
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
    .command('spend')
    .description('what the pipelines have been costing, run by run')
    .option('-p, --project <id>', 'project')
    .option('-n, --limit <n>', 'how many runs', '15')
    .option('--by-agent', 'break the total down by agent instead')
    .action(async (flags: { project?: string; limit: string; byAgent?: boolean }) => {
      const container = await open();
      const runs = (
        await container.pipelines.list({
          projectId: flags.project ?? (await defaultProject()),
          limit: Number(flags.limit),
        })
      ).reverse();

      if (runs.length === 0) {
        console.log(style.dim('nothing has run yet'));
        return;
      }

      const detailed = await Promise.all(runs.map((run) => container.pipelines.get(run.id)));

      if (flags.byAgent) {
        const byAgent = new Map<
          string,
          {
            tokens: number;
            cost: number;
            steps: number;
            turns: number;
            unmeasuredSteps: number;
            cacheReadTokens: number;
            freshInputTokens: number;
          }
        >();

        for (const run of detailed) {
          for (const step of run.steps) {
            const at = byAgent.get(step.agentName) ?? {
              tokens: 0,
              cost: 0,
              steps: 0,
              turns: 0,
              unmeasuredSteps: 0,
              cacheReadTokens: 0,
              freshInputTokens: 0,
            };
            at.tokens += step.inputTokens + step.outputTokens;
            at.cost += step.costUsd ?? 0;
            at.steps += 1;
            at.turns += step.turns;
            if (step.turns === 0) at.unmeasuredSteps += 1;
            at.cacheReadTokens += step.cacheReadTokens;
            at.freshInputTokens += step.freshInputTokens;
            byAgent.set(step.agentName, at);
          }
        }

        const rows = [...byAgent.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
        console.log(
          table(
            rows.map(([name, at]) => [
              name,
              String(at.steps),
              turnsLabel(at.turns, at.unmeasuredSteps, at.steps),
              thousands(at.tokens),
              cacheShareLabel(at.cacheReadTokens, at.freshInputTokens),
              at.cost ? `$${at.cost.toFixed(2)}` : style.dim('—'),
            ]),
            ['AGENT', 'STEPS', 'TURNS', 'TOKENS', 'CACHE', 'COST'],
          ),
        );
        return;
      }

      // A bar per run, scaled to the largest, so the shape of the spend is visible without
      // reading the numbers. This is the question people actually ask: is it getting worse?
      const totals = detailed.map((run) => ({
        run,
        tokens: run.steps.reduce((sum, step) => sum + step.inputTokens + step.outputTokens, 0),
        turns: run.steps.reduce((sum, step) => sum + step.turns, 0),
        unmeasuredSteps: run.steps.filter((step) => step.turns === 0).length,
      }));
      const peak = Math.max(...totals.map((entry) => entry.tokens), 1);

      for (const { run, tokens, turns, unmeasuredSteps } of totals) {
        const bar = '█'.repeat(Math.max(1, Math.round((tokens / peak) * 28)));
        const cost = run.costUsd ? `$${run.costUsd.toFixed(2)}` : style.dim('—');
        const runTurnsLabel = turnsLabel(turns, unmeasuredSteps, run.steps.length);
        console.log(
          `${style.dim(run.startedAt.slice(5, 16).replace('T', ' '))}  ${style.cyan(bar)} ` +
            `${padVisible(thousands(tokens), 9)}  ${padVisible(runTurnsLabel, 9)}  ${padVisible(cost, 7)}  ` +
            `${style.dim(run.steps.length + ' steps')}  ${truncate(run.task, 34)}`,
        );
      }

      const tokens = totals.reduce((sum, entry) => sum + entry.tokens, 0);
      const cost = detailed.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      console.log();
      console.log(
        `${style.bold(thousands(tokens))} tokens across ${totals.length} runs` +
          (cost ? `, ${style.bold('$' + cost.toFixed(2))}` : ''),
      );
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
          origin: 'attached' as const,
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
    .command('show <id>')
    .description('one run, broken down by agent — which one was expensive')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const runs = await container.pipelines.list({ projectId, limit: 200 });
      const match = runs.find((run) => run.id === id || run.id.endsWith(id.toUpperCase()));
      if (!match) {
        console.log(style.red(`no run here ends with '${id}'`));
        return;
      }

      const detail = await container.pipelines.get(match.id);
      console.log(`${style.bold(detail.id.slice(-8))}  ${detail.workflowName}  ${detail.status}`);
      if (detail.itemId) console.log(style.dim(`item ${detail.itemId}`));
      console.log();

      console.log(
        table(
          detail.steps.map((step) => [
            style.bold(step.agentName),
            step.role === 'orchestrator' ? style.cyan('lead') : '',
            thousands(step.inputTokens + step.outputTokens),
            cacheShareLabel(step.cacheReadTokens, step.freshInputTokens),
            step.promptBytes > 0 ? thousands(step.promptBytes) : style.dim('—'),
            perTurn(step),
            // Null and zero are different facts. A provider that reports no cost did not run
            // for free, and printing $0.00 would say it did.
            step.costUsd === null ? style.dim('not reported') : `$${step.costUsd.toFixed(2)}`,
          ]),
          ['AGENT', '', 'TOKENS', 'CACHE', 'PROMPT', 'PER TURN', 'COST'],
        ),
      );

      console.log();
      const spent = detail.costUsd === null ? style.dim('not reported') : `$${detail.costUsd.toFixed(2)}`;
      console.log(
        `${thousands(detail.inputTokens + detail.outputTokens)} tokens · ${spent} · ${detail.steps.length} steps`,
      );
      console.log(carried(detail.steps));

      if (detail.itemId) {
        const item = await container.pipelines.itemSpend(projectId, detail.itemId);
        if (item.runs > 1) {
          const total = item.costUsd === null ? style.dim('not reported') : `$${item.costUsd.toFixed(2)}`;
          // The number that answers whether the agents were worth it. One run's figure
          // flatters every task that needed more than one attempt.
          console.log(
            style.dim(
              `${detail.itemId} across ${item.runs} runs: ${thousands(item.inputTokens + item.outputTokens)} tokens · ${total}`,
            ),
          );
        }
      }
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

      // Which branch a run is working on, from the worktree register rather than guessed
      // from its id: a run that could not take a worktree is working in the repo itself, and
      // printing a branch it does not have would send someone looking for it.
      const worktrees = await container.worktrees.list({});
      const branchOf = new Map(worktrees.map((worktree) => [worktree.runId, worktree.branch]));
      // A run in flight has no totals yet — they are summed when it ends — and that is
      // exactly when someone wants to know what it is costing. Few runs are live, so
      // adding up their steps here is cheap.
      const live = await Promise.all(
        runs
          .filter((run) => run.status === 'running')
          .map(async (run) => [run.id, await container.pipelines.get(run.id)] as const),
      );
      const soFar = new Map(
        live.map(([id, detail]) => [
          id,
          detail.steps.reduce((sum, step) => sum + step.inputTokens + step.outputTokens, 0),
        ]),
      );

      console.log(
        table(
          runs.map((run) => [
            style.dim(run.id.slice(-8)),
            run.status === 'passed' ? style.green(run.status) : style.red(run.status),
            run.workflowName,
            run.itemId ?? '',
            branchLabel(run, branchOf.get(run.id)),
            spent(run, soFar.get(run.id)),
            truncate(run.task, 34),
          ]),
          ['ID', 'STATUS', 'WORKFLOW', 'ITEM', 'BRANCH', 'SPENT', 'TASK'],
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

/** Tokens and cost for one run, or a dash while it has spent nothing yet. */
function spent(
  run: { inputTokens: number; outputTokens: number; costUsd: number | null },
  soFar?: number,
): string {
  const tokens = run.inputTokens + run.outputTokens || (soFar ?? 0);
  if (tokens === 0) return style.dim('—');

  const cost = run.costUsd ? ` $${run.costUsd.toFixed(2)}` : '';
  return `${thousands(tokens)}${style.dim(cost)}`;
}

/**
 * Tokens a turn of this step was billed for.
 *
 * The number that says why a run costs what it does, and it is not the one anybody guesses.
 * Measured over the 20 recorded steps on this board: a step takes 26 turns at the median and
 * as many as 82, and each turn is billed for around 79,000 tokens — of which about 2,500 are
 * fresh and the rest is the session re-reading its own cached context.
 *
 * Unknown for a step from before turns were counted; `0` there means "not measured", and
 * dividing by it would invent a number.
 */
function perTurn(step: { inputTokens: number; outputTokens: number; turns: number }): string {
  if (step.turns <= 0) return style.dim('—');
  return thousands(Math.round((step.inputTokens + step.outputTokens) / step.turns));
}

/**
 * How much of what a run was billed for it was actually handed.
 *
 * Two numbers that should be close and are not. `sentBytes` is every byte Pomni put on the
 * wire — system prompt plus the whole conversation, on every call. The tokens are what came
 * back on the bill. A provider running its own tool loop re-sends everything it has read on
 * each internal turn, and that reading never passes through here, so the gap is the size of
 * what the sessions went and fetched for themselves.
 *
 * Deliberately not a ratio. Bytes and tokens are different units and dividing them would
 * produce a figure that looks like a measurement; these are two facts side by side, and the
 * reader can see which one is large.
 */
function carried(steps: Array<{ sentBytes: number; inputTokens: number; turns: number }>): string {
  const sent = steps.reduce((total, step) => total + step.sentBytes, 0);
  if (sent === 0) return style.dim('what each turn carried was not measured on this run');

  const turns = steps.reduce((total, step) => total + step.turns, 0);
  const input = steps.reduce((total, step) => total + step.inputTokens, 0);
  const each = turns > 0 ? ` · ${thousands(Math.round(input / turns))} input tokens per turn` : '';

  return style.dim(
    `Pomni handed over ${thousands(Math.round(sent / 1024))} kB across ${steps.length} steps${each}` +
      ' — the rest of what was billed is what the sessions read themselves',
  );
}

/** 1234567 -> 1 234 567. Long token counts are unreadable without it. */
function thousands(value: number): string {
  return value.toLocaleString('en-US').replace(/,/g, ' ');
}

/**
 * Where a run's work is, in one cell.
 *
 * The precedence is `workLocation`'s, in core, so that the table and the browser cannot come
 * to different conclusions about the same run. All this adds is how a terminal says it:
 * dimmed for the two answers that are not a branch, because neither is somewhere to go.
 */
function branchLabel(run: { branch: string | null; unmet: string[] }, live?: string): string {
  const where = workLocation(run, live);
  if (where.kind === 'branch') return where.branch;
  if (where.kind === 'repo') return style.dim('in repo');
  return style.dim('—');
}

/**
 * `turns` summed across steps, some of which may predate the field and record `0` (not
 * measured, not "zero turns"). If none of the contributing steps were measured, the total is
 * unknown. If some were and some were not, the sum is a floor, not a measurement — marked
 * `N+ turns` rather than printed as if it were exact.
 */
function turnsLabel(turns: number, unmeasuredSteps: number, totalSteps: number): string {
  if (totalSteps === 0 || unmeasuredSteps === totalSteps) return style.dim('—');
  if (unmeasuredSteps > 0) return `${turns}+ turns`;
  return `${turns} turn${turns === 1 ? '' : 's'}`;
}

/**
 * Cache share is cacheReadTokens / (cacheReadTokens + freshInputTokens), never over
 * inputTokens and never over input+output — rows written before these columns existed
 * contribute inputTokens with both halves at 0, so summing over inputTokens would understate
 * the share of what was actually measured.
 */
function cacheShareLabel(cacheReadTokens: number, freshInputTokens: number): string {
  const measured = cacheReadTokens + freshInputTokens;
  if (measured === 0) return style.dim('—');
  return `${Math.round((cacheReadTokens / measured) * 100)}%`;
}

/** Pad by visible width, since a dim `—` or colored cell carries invisible ANSI codes. */
function padVisible(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleLength(text))) + text;}

/**
 * What each agent in a workflow will carry on every turn, before a run pays for it.
 *
 * A run tells you afterwards; this tells you first. The number that matters is not the prompt
 * but the ratio: an agent whose frame is larger than its own instructions is paying for
 * scaffolding on every round, and the fix is usually to write the prompt properly rather than
 * to trim the frame.
 */
export function lintReport(
  agents: Array<{ id: string; name: string; role: string; prompt: string }>,
  scaffolding: number,
  budget: number,
): Array<{ id: string; prompt: number; scaffolding: number; total: number; flags: string[] }> {
  return agents.map((agent) => {
    const prompt = Buffer.byteLength(agent.prompt, 'utf8');
    const total = prompt + scaffolding;
    const flags: string[] = [];

    if (prompt === 0) flags.push('no prompt');
    // The comparison the item asks for, and the one worth acting on.
    else if (scaffolding > prompt) flags.push('frame larger than prompt');
    if (total > budget) flags.push('over budget');

    return { id: agent.id, prompt, scaffolding, total, flags };
  });
}
