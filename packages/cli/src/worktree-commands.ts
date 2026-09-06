import type { PomniContainer, Worktree, WorktreeState } from '@pomni/core';
import type { Command } from 'commander';
import { style, table } from './format.js';

export function registerWorktreeCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const worktree = program.command('worktree').description('inspect and clean up per-run git worktrees');

  worktree
    .command('list')
    .alias('ls')
    .description('live worktrees, one per pipeline run')
    .option('-p, --project <id>', 'project')
    .option('-r, --repo <id>', 'restrict to one repo')
    .action(async (flags: { project?: string; repo?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const found = await container.worktrees.inspect({ projectId, repoId: flags.repo });

      if (found.length === 0) {
        console.log(style.dim('no live worktrees'));
        return;
      }

      console.log(
        table(
          found.map(({ worktree, state }: { worktree: Worktree; state: WorktreeState; detail: string }) => [
            style.bold(worktree.id),
            worktree.repoId,
            worktree.runId,
            worktree.branch,
            stateLabel(state),
            style.dim(worktree.path),
          ]),
          ['ID', 'REPO', 'RUN', 'BRANCH', 'STATE', 'PATH'],
        ),
      );
    });

  worktree
    .command('prune')
    .description('remove orphaned worktrees; kept worktrees (uncommitted work) are left alone')
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const result = await container.worktrees.prune({ projectId });

      for (const removed of result.removed) {
        console.log(`${style.green('removed')} ${removed.id}  ${style.dim(removed.path)}`);
      }
      for (const kept of result.kept) {
        console.log(`${style.yellow('kept')} ${kept.id}  ${style.dim(kept.path)}`);
        console.log(`   ${style.dim(kept.reason)}`);
      }
      for (const failed of result.failed) {
        console.log(`${style.red('failed')} ${failed.id}  ${style.dim(failed.path)}`);
        console.log(`   ${style.red(failed.error)}`);
      }

      if (result.removed.length === 0 && result.kept.length === 0 && result.failed.length === 0) {
        console.log(style.dim('nothing to prune'));
      }
      if (result.failed.length > 0) process.exitCode = 1;
    });

  worktree
    .command('remove <id>')
    .description('remove one worktree by id')
    .option('--force', 'remove even if it is still live or has uncommitted work')
    .action(async (id: string, options: { force?: boolean }) => {
      const container = await open();
      await container.worktrees.removeOne(id, { force: Boolean(options.force) });
      console.log(`${style.green('removed')} ${id}`);
    });
}

function stateLabel(state: 'live' | 'kept' | 'orphaned' | 'missing'): string {
  switch (state) {
    case 'live':
      return style.green('live');
    case 'kept':
      return style.yellow('kept');
    case 'orphaned':
      return style.red('orphaned');
    case 'missing':
      return style.dim('missing');
  }
}
