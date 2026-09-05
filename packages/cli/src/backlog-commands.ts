import { spawn } from 'node:child_process';
import {
  BOARD_COLUMNS,
  ItemStatusSchema,
  layout,
  type BacklogItem,
  type Estimate,
  type ItemStatus,
  type ItemType,
  type PomniContainer,
  type Priority,
} from '@pomni/core';
import type { Command } from 'commander';
import { style, table } from './format.js';

export function registerBacklogCommands(
  program: Command,
  open: () => Promise<PomniContainer>,
  defaultProject: () => Promise<string>,
): void {
  const backlog = program.command('backlog').alias('b').description('manage the backlog');

  backlog
    .command('add <title...>')
    .description('capture a new item')
    .option('-p, --project <id>', 'project')
    .option('-t, --type <type>', 'feature | bug | chore | spike | refactor | docs')
    .option('--priority <priority>', 'P0 | P1 | P2 | P3')
    .option('-e, --estimate <size>', 'XS | S | M | L | XL')
    .option('-r, --repos <ids>', 'comma-separated repos this item touches')
    .option('-l, --labels <labels>', 'comma-separated labels')
    .option('--depends-on <ids>', 'comma-separated item ids that must be done first')
    .action(async (titleParts: string[], flags: AddFlags) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());

      const item = await container.backlog.create(projectId, {
        title: titleParts.join(' '),
        type: flags.type as ItemType | undefined,
        priority: flags.priority as Priority | undefined,
        estimate: flags.estimate as Estimate | undefined,
        repos: list(flags.repos),
        labels: list(flags.labels),
        dependsOn: list(flags.dependsOn),
      });

      console.log(`${style.green('created')} ${style.bold(item.id)}  ${item.title}`);
      console.log(style.dim(`  ${container.root}/${layout.backlogItem(projectId, item.id)}`));
      console.log(style.dim(`  next: pomni backlog show ${item.id}`));
    });

  backlog
    .command('list')
    .alias('ls')
    .description('list items')
    .option('-p, --project <id>', 'project (default: all)')
    .option('-s, --status <status>', 'filter by status; "active" excludes done and cancelled')
    .option('-t, --type <type>', 'filter by type')
    .option('--priority <priority>', 'filter by priority')
    .option('-l, --label <label>', 'filter by label')
    .option('-r, --repo <id>', 'filter by repo')
    .option('-q, --query <text>', 'substring match on the title')
    .action(async (flags: ListFlags) => {
      const container = await open();
      const items = await container.backlog.list({
        projectId: flags.project,
        status: parseStatusFilter(flags.status),
        type: flags.type as ItemType | undefined,
        priority: flags.priority as Priority | undefined,
        label: flags.label,
        repo: flags.repo,
        query: flags.query,
      });

      if (items.length === 0) {
        console.log(style.dim("nothing here — capture something with 'pomni backlog add <title>'"));
        return;
      }

      console.log(
        table(
          items.map((item) => [
            style.bold(item.id),
            statusText(item.status),
            item.priority,
            item.type,
            item.title,
            item.repos.join(', ') || style.dim('—'),
          ]),
          ['ID', 'STATUS', 'PRI', 'TYPE', 'TITLE', 'REPOS'],
        ),
      );
    });

  backlog
    .command('board')
    .description('items grouped by column')
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const items = await container.backlog.list({ projectId });

      for (const column of BOARD_COLUMNS) {
        const inColumn = items.filter((item) => item.status === column);
        const blocked = column === 'backlog' ? items.filter((item) => item.status === 'blocked') : [];
        if (inColumn.length === 0 && blocked.length === 0) continue;

        console.log(`${statusText(column)} ${style.dim(`(${inColumn.length})`)}`);
        for (const item of inColumn) {
          console.log(`  ${style.bold(item.id.padEnd(10))} ${item.priority}  ${item.title}`);
        }
        for (const item of blocked) {
          console.log(
            `  ${style.bold(item.id.padEnd(10))} ${style.red('blocked')}  ${item.title} ${style.dim(
              `— ${item.blockedReason ?? ''}`,
            )}`,
          );
        }
        console.log();
      }
    });

  backlog
    .command('show <id>')
    .description('one item, with its spec')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const item = await container.backlog.get(projectId, itemId);

      console.log(`${style.bold(item.id)}  ${item.title}`);
      console.log(
        `${statusText(item.status)}  ${item.priority}  ${item.type}${
          item.estimate ? `  ${item.estimate}` : ''
        }`,
      );
      if (item.repos.length > 0) console.log(`repos      ${item.repos.join(', ')}`);
      if (item.labels.length > 0) console.log(`labels     ${item.labels.join(', ')}`);
      if (item.dependsOn.length > 0) {
        console.log(
          `depends on ${item.dependsOn.join(', ')}${
            item.blockedBy.length > 0 ? style.red(`  (waiting on ${item.blockedBy.join(', ')})`) : ''
          }`,
        );
      }
      if (item.blocking.length > 0) console.log(`blocks     ${item.blocking.join(', ')}`);
      if (item.blockedReason) console.log(style.red(`blocked    ${item.blockedReason}`));
      if (item.acceptance.total > 0) {
        console.log(`acceptance ${item.acceptance.checked}/${item.acceptance.total} checked`);
      }

      console.log();
      console.log(item.body.trimEnd());
    });

  backlog
    .command('edit <id>')
    .description('change fields on an item')
    .option('-p, --project <id>', 'project')
    .option('--title <text>', 'new title')
    .option('-t, --type <type>', 'type')
    .option('--priority <priority>', 'priority')
    .option('-e, --estimate <size>', 'estimate')
    .option('-r, --repos <ids>', 'comma-separated repos (replaces the list)')
    .option('-l, --labels <labels>', 'comma-separated labels (replaces the list)')
    .option('--branch <name>', 'branch this work lives on')
    .action(async (id: string, flags: EditFlags) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);

      const updated = await container.backlog.update(projectId, itemId, {
        title: flags.title,
        type: flags.type as ItemType | undefined,
        priority: flags.priority as Priority | undefined,
        estimate: flags.estimate as Estimate | undefined,
        repos: flags.repos === undefined ? undefined : list(flags.repos),
        labels: flags.labels === undefined ? undefined : list(flags.labels),
        branch: flags.branch,
      });
      console.log(`${style.green('updated')} ${updated.id}`);
    });

  backlog
    .command('move <id> <status>')
    .description(`move an item: ${ItemStatusSchema.options.join(' | ')}`)
    .option('-p, --project <id>', 'project')
    .option('--reason <text>', 'why (recorded in the item log)')
    .option('-f, --force', 'skip the guards; recorded as forced')
    .action(async (id: string, status: string, flags: MoveFlags) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);

      const parsed = ItemStatusSchema.safeParse(status);
      if (!parsed.success) {
        console.error(style.red(`unknown status '${status}' — one of: ${ItemStatusSchema.options.join(', ')}`));
        process.exitCode = 1;
        return;
      }

      const moved = await container.backlog.transition(projectId, itemId, parsed.data, {
        reason: flags.reason,
        force: flags.force,
      });
      console.log(`${style.green('moved')} ${moved.id} → ${statusText(moved.status)}`);
    });

  backlog
    .command('block <id> <reason...>')
    .description('mark an item blocked')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, reason: string[], flags: { project?: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const blocked = await container.backlog.block(projectId, itemId, reason.join(' '));
      console.log(`${style.yellow('blocked')} ${blocked.id} — ${blocked.blockedReason}`);
    });

  backlog
    .command('unblock <id>')
    .description('restore an item to whatever it was doing before')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const item = await container.backlog.unblock(projectId, itemId);
      console.log(`${style.green('unblocked')} ${item.id} → ${statusText(item.status)}`);
    });

  backlog
    .command('link <id>')
    .description('record that an item depends on others')
    .requiredOption('--depends-on <ids>', 'comma-separated item ids')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string; dependsOn: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const current = await container.backlog.get(projectId, itemId);

      const merged = [...new Set([...current.dependsOn, ...(list(flags.dependsOn) ?? [])])];
      await container.backlog.update(projectId, itemId, { dependsOn: merged });
      console.log(`${style.green('linked')} ${itemId} depends on ${merged.join(', ')}`);
    });

  backlog
    .command('reopen <id>')
    .description('move a done item back into progress')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const item = await container.backlog.transition(projectId, itemId, 'in_progress', {
        reason: 'reopened',
        force: true,
      });
      console.log(`${style.green('reopened')} ${item.id}`);
    });

  backlog
    .command('remove <id>')
    .alias('rm')
    .description('delete an item')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      await container.backlog.remove(projectId, itemId);
      console.log(`${style.green('removed')} ${itemId}`);
    });

  backlog
    .command('next')
    .description('the highest-priority ready item')
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const item = await container.backlog.next(projectId);

      if (!item) {
        console.log(style.dim("nothing is ready — move an item to 'ready' first"));
        return;
      }
      console.log(`${style.bold(item.id)}  ${item.priority}  ${item.title}`);
    });

  backlog
    .command('open <id>')
    .description('open the item file in $EDITOR')
    .option('-p, --project <id>', 'project')
    .action(async (id: string, flags: { project?: string }) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const path = container.root
        ? `${container.root}/${layout.backlogItem(projectId, itemId)}`
        : layout.backlogItem(projectId, itemId);

      const editor = process.env.EDITOR ?? process.env.VISUAL;
      if (!editor) {
        console.log(path);
        console.log(style.dim('set $EDITOR to open it directly'));
        return;
      }
      spawn(editor, [path], { stdio: 'inherit', shell: true });
    });
}

// ---------------------------------------------------------------------------

interface AddFlags {
  project?: string;
  type?: string;
  priority?: string;
  estimate?: string;
  repos?: string;
  labels?: string;
  dependsOn?: string;
}

interface ListFlags {
  project?: string;
  status?: string;
  type?: string;
  priority?: string;
  label?: string;
  repo?: string;
  query?: string;
}

interface EditFlags extends AddFlags {
  title?: string;
  branch?: string;
}

interface MoveFlags {
  project?: string;
  reason?: string;
  force?: boolean;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseStatusFilter(value: string | undefined): ItemStatus[] | ItemStatus | undefined {
  if (!value) return undefined;
  if (value === 'active') {
    return ['backlog', 'specced', 'ready', 'in_progress', 'in_review', 'blocked'];
  }
  const parsed = ItemStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Item ids carry their project prefix (`ACME-12`), so the project can usually be inferred
 * rather than typed. An explicit `-p` still wins.
 */
async function resolve(
  container: PomniContainer,
  itemId: string,
  explicit: string | undefined,
  fallback: () => Promise<string>,
): Promise<[string, string]> {
  const id = itemId.toUpperCase();
  if (explicit) return [explicit, id];

  const prefix = id.split('-')[0];
  if (prefix) {
    for (const projectId of await container.projects.listIds()) {
      const project = await container.projects.getRef(projectId);
      if (project.data.itemPrefix === prefix) return [projectId, id];
    }
  }
  return [await fallback(), id];
}

function statusText(status: ItemStatus): string {
  switch (status) {
    case 'done':
      return style.green('done');
    case 'in_review':
      return style.cyan('in_review');
    case 'in_progress':
      return style.cyan('in_progress');
    case 'ready':
      return style.blue('ready');
    case 'blocked':
      return style.red('blocked');
    case 'cancelled':
      return style.dim('cancelled');
    case 'specced':
      return style.blue('specced');
    default:
      return style.dim('backlog');
  }
}

export function itemLine(item: BacklogItem): string {
  return `${item.id}  ${item.priority}  ${item.title}`;
}
