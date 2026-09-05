import { readFile, writeFile } from 'node:fs/promises';
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
        },
      ) => {
        const container = await open();
        const updated = await container.workflows.updateAgent(workflowId, agentId, {
          name: flags.name,
          role: flags.role ? (AgentRoleSchema.parse(flags.role) as AgentRole) : undefined,
          spec: flags.specFile ? await readFile(flags.specFile, 'utf8') : flags.spec,
          prompt: flags.promptFile ? await readFile(flags.promptFile, 'utf8') : undefined,
          struggle: flags.struggle ? (StruggleSchema.parse(flags.struggle) as Struggle) : undefined,
          outputs: flags.outputs,
          delegatesTo: split(flags.delegatesTo),
        });
        console.log(`${style.green('updated')} ${updated.id}`);
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
