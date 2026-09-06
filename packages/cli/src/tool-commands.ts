import type { PomniContainer, Tool, ToolStatus } from '@pomni/core';
import type { Command } from 'commander';
import { style, table } from './format.js';

/**
 * `pomni tool` — the registry of things an agent can use besides a model.
 *
 * Two kinds, one registry. An MCP server is dialled or spawned by the agent's session; a CLI
 * tool is a program the session is allowed to run. Both are attached to a project and then
 * opted into per agent, so registering a tool never silently widens what any agent can do.
 */
export function registerToolCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const tool = program.command('tool').description('MCP servers and CLI programs agents can use');

  tool
    .command('list')
    .alias('ls')
    .description('every registered tool')
    .action(async () => {
      const container = await open();
      const tools = await container.tools.list();

      if (tools.length === 0) {
        console.log(style.dim('no tools yet — add one with `pomni tool add`'));
        return;
      }

      console.log(
        table(
          tools.map((entry) => [
            entry.id,
            entry.kind,
            describe(entry),
            entry.projects.join(', ') || style.dim('—'),
            health(entry),
          ]),
          ['ID', 'KIND', 'WHERE IT POINTS', 'PROJECTS', 'STATE'],
        ),
      );
    });

  tool
    .command('show <id>')
    .description('everything about one tool')
    .action(async (id: string) => {
      const container = await open();
      const entry = await container.tools.get(id);

      console.log(`${style.bold(entry.name)} ${style.dim(`(${entry.id})`)}  ${entry.kind}`);
      if (entry.description) console.log(entry.description);
      console.log();
      console.log(`${style.dim('points at')}  ${describe(entry)}`);
      console.log(`${style.dim('projects')}   ${entry.projects.join(', ') || '—'}`);
      console.log(`${style.dim('check')}      ${entry.check ?? '—'}`);
      if (entry.credential) {
        console.log(`${style.dim('credential')} ${entry.credential} → ${entry.credentialEnv}`);
      }
      if (entry.envFrom.length > 0) {
        console.log(`${style.dim('env from')}   ${entry.envFrom.join(', ')}`);
      }
      if (entry.problems.length > 0) {
        console.log();
        for (const problem of entry.problems) console.log(style.red(`  ! ${problem}`));
      }
      if (entry.usage) {
        console.log();
        console.log(style.dim('usage given to agents:'));
        console.log(entry.usage);
      }
    });

  tool
    .command('add <name>')
    .description('register an MCP server or a CLI program')
    .option('--id <id>', 'id to use instead of one derived from the name')
    .option('--cli', 'a command-line program the agent may run')
    .option('--mcp', 'an MCP server')
    .option('--bin <name>', 'cli: the executable, as spelled on PATH')
    .option('--command <cmd>', 'mcp/stdio: the command to spawn')
    .option('--arg <value>', 'mcp/stdio: an argument; repeat for several', collect, [] as string[])
    .option('--http <url>', 'mcp: an http endpoint')
    .option('--sse <url>', 'mcp: an sse endpoint')
    .option('-d, --description <text>', 'one line: what it is for')
    .option('-u, --usage <text>', 'how to drive it — the part agents actually need')
    .option('--usage-file <path>', 'read the usage text from a file')
    .option('--env <KEY=VALUE>', 'literal env var; repeat', collect, [] as string[])
    .option('--env-from <NAME>', "forward this var from Pomni's environment; repeat", collect, [] as string[])
    .option('--credential <id>', 'credential whose secret the tool needs')
    .option('--credential-env <NAME>', 'variable (or header) to put that secret in')
    .option('--check <cmd>', 'a command that proves it works, e.g. "figma-cli status"')
    .option('-p, --project <id>', 'attach it to this project straight away')
    .action(async (name: string, flags: AddFlags) => {
      const container = await open();
      const created = await container.tools.create({
        name,
        id: flags.id,
        kind: flags.mcp ? 'mcp' : 'cli',
        description: flags.description,
        usage: await usageText(flags),
        bin: flags.bin,
        transport: flags.mcp ? (flags.http ? 'http' : flags.sse ? 'sse' : 'stdio') : undefined,
        command: flags.command,
        args: flags.arg,
        url: flags.http ?? flags.sse,
        env: pairs(flags.env),
        envFrom: flags.envFrom,
        credential: flags.credential ?? null,
        credentialEnv: flags.credentialEnv ?? null,
        check: flags.check ?? null,
      });

      console.log(`${style.green('added')} ${style.bold(created.id)}  ${describe(created)}`);

      if (flags.project) {
        await container.tools.attach(flags.project, created.id);
        console.log(style.dim(`  attached to ${flags.project}`));
      }

      const problems = (await container.tools.get(created.id)).problems;
      for (const problem of problems) console.log(style.red(`  ! ${problem}`));
      console.log(
        style.dim('  give it to an agent: `pomni workflow agent edit <wf> <agent> --tools ' + created.id + '`'),
      );
    });

  tool
    .command('edit <id>')
    .description('change a registered tool')
    .option('-n, --name <name>', 'name')
    .option('-d, --description <text>', 'one line: what it is for')
    .option('-u, --usage <text>', 'how to drive it')
    .option('--usage-file <path>', 'read the usage text from a file')
    .option('--bin <name>', 'cli: the executable')
    .option('--command <cmd>', 'mcp/stdio: the command to spawn')
    .option('--http <url>', 'mcp: an http endpoint')
    .option('--sse <url>', 'mcp: an sse endpoint')
    .option('--check <cmd>', 'health command')
    .option('--credential <id>', 'credential whose secret the tool needs')
    .option('--credential-env <NAME>', 'variable (or header) to put that secret in')
    .option('--enable', 'enable it')
    .option('--disable', 'disable it without removing it')
    .action(async (id: string, flags: EditFlags) => {
      const container = await open();
      const updated = await container.tools.update(id, {
        name: flags.name,
        description: flags.description,
        usage: await usageText(flags),
        bin: flags.bin,
        command: flags.command,
        url: flags.http ?? flags.sse,
        ...(flags.http ? { transport: 'http' as const } : {}),
        ...(flags.sse ? { transport: 'sse' as const } : {}),
        check: flags.check,
        credential: flags.credential,
        credentialEnv: flags.credentialEnv,
        enabled: flags.enable ? true : flags.disable ? false : undefined,
      });

      console.log(`${style.green('updated')} ${updated.id}`);
    });

  tool
    .command('rm <id>')
    .description('remove a tool, and detach it from every project')
    .action(async (id: string) => {
      const container = await open();
      await container.tools.remove(id);
      console.log(`${style.green('removed')} ${id}`);
    });

  tool
    .command('attach <id>')
    .description('make a tool available to a project')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const attached = await container.tools.attach(projectId, id);
      console.log(`${style.green('attached')} ${id} → ${projectId}`);
      console.log(style.dim(`  ${projectId} now has: ${attached.join(', ')}`));
    });

  tool
    .command('detach <id>')
    .description('take a tool away from a project')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      await container.tools.detach(projectId, id);
      console.log(`${style.green('detached')} ${id} from ${projectId}`);
    });

  tool
    .command('check [ids...]')
    .description('run each tool’s check command')
    .action(async (ids: string[]) => {
      const container = await open();
      const results = await container.tools.check(ids);

      if (results.length === 0) {
        console.log(style.dim('nothing to check'));
        return;
      }

      for (const result of results) {
        const mark =
          result.status === 'ok'
            ? style.green('ok')
            : result.status === 'failed'
              ? style.red('failed')
              : style.dim('skipped');
        console.log(`${mark}  ${style.bold(result.id)}  ${style.dim(result.detail)}`);
      }
      if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
    });
}

interface AddFlags {
  id?: string;
  cli?: boolean;
  mcp?: boolean;
  bin?: string;
  command?: string;
  arg: string[];
  http?: string;
  sse?: string;
  description?: string;
  usage?: string;
  usageFile?: string;
  env: string[];
  envFrom: string[];
  credential?: string;
  credentialEnv?: string;
  check?: string;
  project?: string;
}

interface EditFlags {
  name?: string;
  description?: string;
  usage?: string;
  usageFile?: string;
  bin?: string;
  command?: string;
  http?: string;
  sse?: string;
  check?: string;
  credential?: string;
  credentialEnv?: string;
  enable?: boolean;
  disable?: boolean;
}

function collect(value: string, all: string[]): string[] {
  return [...all, value];
}

/** `KEY=VALUE` pairs from the command line. */
function pairs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    if (at > 0) result[value.slice(0, at)] = value.slice(at + 1);
  }
  return result;
}

/**
 * Usage prose is the part worth writing properly, and a long one does not belong on a
 * command line — so it can come from a file instead.
 */
async function usageText(flags: { usage?: string; usageFile?: string }): Promise<string | undefined> {
  if (flags.usageFile) {
    const { readFile } = await import('node:fs/promises');
    return readFile(flags.usageFile, 'utf8');
  }
  return flags.usage;
}

function describe(tool: Tool): string {
  if (tool.kind === 'cli') return tool.bin ?? '(no binary)';
  if (tool.transport === 'stdio') return [tool.command, ...tool.args].filter(Boolean).join(' ');
  return tool.url ?? '(no url)';
}

function health(tool: ToolStatus): string {
  if (!tool.enabled) return style.dim('disabled');
  return tool.problems.length === 0 ? style.green('ready') : style.red(tool.problems[0] ?? 'broken');
}
