import { WELL_KNOWN_CAPABILITIES, type PomniContainer, type Run } from '@pomni/core';
import { readLogFrom } from '@pomni/infra';
import type { Command } from 'commander';
import { style, table } from './format.js';

interface RunFlags {
  project?: string;
  repo?: string;
  quiet?: boolean;
  bail?: boolean;
}

export function registerRunCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const execute = async (capability: string, flags: RunFlags): Promise<void> => {
    const container = await open();
    const projectId = flags.project ?? (await defaultProject());

    const runs = await container.runs.run(projectId, capability, {
      repoId: flags.repo,
      bail: flags.bail,
      onRunStart: (run) => {
        console.log(
          `${style.cyan('▸')} ${style.bold(run.repoId)} ${style.dim(run.cmd)}`,
        );
      },
      onOutput: flags.quiet ? undefined : (_id, chunk) => process.stdout.write(chunk),
      onRunFinish: (run) => {
        console.log(finishLine(run));
      },
    });

    if (runs.length > 1) {
      console.log();
      console.log(
        table(
          runs.map((run) => [
            statusText(run),
            style.bold(run.repoId),
            run.summary ?? style.dim('—'),
            style.dim(duration(run)),
          ]),
        ),
      );
    }

    if (runs.some((run) => run.status !== 'passed')) process.exitCode = 1;
  };

  const runCommand = program
    .command('run <capability>')
    .description('run a declared capability across a project')
    .option('-p, --project <id>', 'project (defaults to the only project, or config)')
    .option('-r, --repo <id>', 'restrict to one repo')
    .option('-q, --quiet', 'do not stream output')
    .option('--bail', 'stop at the first failing repo')
    .action((capability: string, flags: RunFlags) => execute(capability, flags));

  runCommand.addHelpText(
    'after',
    `\nWell-known capabilities: ${WELL_KNOWN_CAPABILITIES.join(', ')}`,
  );

  // Shorthands, so the common case is `pomni test`.
  for (const capability of ['test', 'build', 'lint', 'typecheck', 'e2e', 'install'] as const) {
    program
      .command(capability)
      .description(`run the '${capability}' capability across a project`)
      .option('-p, --project <id>', 'project')
      .option('-r, --repo <id>', 'restrict to one repo')
      .option('-q, --quiet', 'do not stream output')
      .option('--bail', 'stop at the first failing repo')
      .action((flags: RunFlags) => execute(capability, flags));
  }

  program
    .command('verify')
    .description("run a project's gate: every capability, across every repo that declares it")
    .option('-p, --project <id>', 'project')
    .option('-r, --repo <id>', 'restrict to one repo')
    .option('--land', 'use the land gate instead of the default gate')
    .option('-q, --quiet', 'do not stream output')
    .action(async (flags: RunFlags & { land?: boolean }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());

      const report = await container.runs.gate(projectId, flags.land ? 'land' : 'default', {
        repoId: flags.repo,
        onRunStart: (run) =>
          console.log(`${style.cyan('▸')} ${style.bold(run.repoId)} ${run.capability}`),
        onOutput: flags.quiet ? undefined : (_id, chunk) => process.stdout.write(chunk),
        onRunFinish: (run) => console.log(finishLine(run)),
      });

      console.log();
      for (const result of report.results) {
        const mark =
          result.status === 'passed'
            ? style.green('✓')
            : result.status === 'skipped'
              ? style.dim('–')
              : style.red('✗');
        const detail =
          result.status === 'skipped'
            ? style.dim('no repo declares it')
            : result.runs.map((run) => `${run.repoId}: ${run.summary ?? run.status}`).join('  ');
        console.log(`${mark} ${result.capability.padEnd(10)} ${detail}`);
      }

      console.log();
      console.log(
        report.passed
          ? style.green(`gate '${report.gate}' passed`)
          : style.red(`gate '${report.gate}' failed`),
      );
      if (!report.passed) process.exitCode = 1;
    });

  // -- runs ----------------------------------------------------------------

  const runs = program.command('runs').description('inspect run history');

  runs
    .command('list')
    .alias('ls')
    .description('recent runs')
    .option('-p, --project <id>', 'project')
    .option('-r, --repo <id>', 'repo')
    .option('-c, --capability <name>', 'capability')
    .option('--failed', 'only runs that did not pass')
    .option('-n, --limit <n>', 'how many', '20')
    .action(
      async (flags: {
        project?: string;
        repo?: string;
        capability?: string;
        failed?: boolean;
        limit: string;
      }) => {
        const container = await open();
        const found = await container.runs.list({
          projectId: flags.project,
          repoId: flags.repo,
          capability: flags.capability,
          failedOnly: flags.failed,
          limit: Number(flags.limit),
        });

        if (found.length === 0) {
          console.log(style.dim('no runs yet'));
          return;
        }

        console.log(
          table(
            found.map((run) => [
              style.dim(run.id.slice(-8)),
              statusText(run),
              `${run.projectId}/${run.repoId}`,
              run.capability,
              run.summary ?? style.dim('—'),
              style.dim(duration(run)),
            ]),
            ['ID', 'STATUS', 'REPO', 'CAPABILITY', 'SUMMARY', 'TIME'],
          ),
        );
      },
    );

  runs
    .command('show <id>')
    .description('one run, with the tail of its output')
    .option('--full', 'print the whole log')
    .action(async (id: string, flags: { full?: boolean }) => {
      const container = await open();
      const run = await container.runs.get(await resolveRunId(container, id));

      console.log(`${statusText(run)}  ${style.bold(`${run.projectId}/${run.repoId}`)} ${run.capability}`);
      console.log(style.dim(`${run.id}`));
      console.log(`command   ${run.cmd}`);
      console.log(`cwd       ${run.cwd}`);
      console.log(`exit      ${run.exitCode ?? style.dim('—')}   ${duration(run)}`);
      if (run.summary) console.log(`summary   ${run.summary}`);

      const results = await container.runs.testResults(run.id);
      if (results.length > 0) {
        const failed = results.filter((result) => result.status === 'failed');
        console.log(`tests     ${results.length} recorded, ${failed.length} failed`);
        for (const failure of failed.slice(0, 10)) {
          console.log(`  ${style.red('✗')} ${failure.suite} ${failure.name}`);
          if (failure.message) console.log(`    ${style.dim(failure.message.split('\n')[0] ?? '')}`);
        }
      }

      const { text } = await readLogFrom(run.logPath, 0);
      const lines = text.split(/\r?\n/);
      const shown = flags.full ? lines : lines.slice(-40);
      console.log();
      if (!flags.full && lines.length > 40) {
        console.log(style.dim(`… ${lines.length - 40} earlier lines (--full for all)`));
      }
      console.log(shown.join('\n').trimEnd());
    });

  runs
    .command('tail <id>')
    .description('follow a running run')
    .action(async (id: string) => {
      const container = await open();
      const runId = await resolveRunId(container, id);
      let run = await container.runs.get(runId);
      let offset = 0;

      for (;;) {
        const chunk = await readLogFrom(run.logPath, offset);
        offset = chunk.offset;
        if (chunk.text) process.stdout.write(chunk.text);

        run = await container.runs.get(runId);
        if (run.status !== 'running' && run.status !== 'queued') break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      console.log(finishLine(run));
      if (run.status !== 'passed') process.exitCode = 1;
    });

  runs
    .command('cancel <id>')
    .description('stop a running run')
    .action(async (id: string) => {
      const container = await open();
      const run = await container.runs.cancel(await resolveRunId(container, id));
      console.log(`${style.yellow('cancelled')} ${run.id}`);
    });
}

/** Accept the short id printed by `runs list` as well as the full ULID. */
async function resolveRunId(container: PomniContainer, id: string): Promise<string> {
  if (id.length === 26) return id;
  const candidates = await container.runs.list({ limit: 200 });
  const match = candidates.find((run) => run.id.endsWith(id));
  return match?.id ?? id;
}

function statusText(run: Run): string {
  switch (run.status) {
    case 'passed':
      return style.green('passed');
    case 'failed':
      return style.red('failed');
    case 'timeout':
      return style.red('timeout');
    case 'cancelled':
      return style.yellow('cancelled');
    default:
      return style.cyan('running');
  }
}

function duration(run: Run): string {
  if (run.durationMs === null) return '';
  return run.durationMs < 1000
    ? `${run.durationMs}ms`
    : `${(run.durationMs / 1000).toFixed(1)}s`;
}

function finishLine(run: Run): string {
  const parts = [statusText(run), style.bold(run.repoId), run.capability];
  if (run.summary) parts.push(style.dim(run.summary));
  parts.push(style.dim(duration(run)));
  return parts.join('  ');
}
