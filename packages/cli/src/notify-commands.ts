import type { NotificationTestResult, PomniContainer } from '@pomni/core';
import type { Command } from 'commander';
import { style } from './format.js';
import type { Output } from './output.js';

/**
 * `pomni notify` — checking the two channels a workspace can point a run's attention at
 * (`.pomni/config.yaml`'s `notify` section) without waiting for a real question or a red gate.
 */
export function registerNotifyCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
  out: () => Output,
): void {
  const notify = program.command('notify').description('desktop and webhook notifications');

  notify
    .command('test')
    .description('send a sample notification to every configured channel')
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const results = await container.notifications.sendTest(projectId);

      out().report({ results }, () => {
        if (results.length === 0) {
          console.log(
            style.dim(
              'no notification channels configured — set notify.desktop or notify.webhook.url in .pomni/config.yaml',
            ),
          );
          return;
        }

        for (const result of results) {
          console.log(
            result.ok
              ? `${style.bold(result.channel)}: ${style.green('ok')}`
              : `${style.bold(result.channel)}: ${style.red(`failed — ${result.error}`)}`,
          );
        }
      });

      if (results.length === 0 || results.some((result: NotificationTestResult) => !result.ok)) out().fail(1);
    });
}
