import { spawn } from 'node:child_process';
import {
  BOARD_COLUMNS,
  assertWavesDisjoint,
  describeConflict,
  describeUnmetList,
  hasRequirements,
  layout,
  stateLabel,
  type BacklogItem,
  type Estimate,
  type ItemStatus,
  type ItemType,
  type EmittedEvent,
  type PathScope,
  type PomniContainer,
  type PomniEvent,
  type Priority,
  type Requirements,
  type TransitionOffer,
  type WavePlan,
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
        `${statusText(item.status, item.flowState?.label)}  ${item.priority}  ${item.type}${
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
      if (item.offFlow) {
        console.log(style.yellow(`off-flow   '${item.status}' is not a state in this project's flow`));
      }

      if (item.allowedTransitions.length > 0) {
        console.log();
        console.log(style.bold('moves'));
        for (const offer of item.allowedTransitions) {
          console.log(offerLine(offer));
        }
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
    .option('--touches <paths>', 'comma-separated paths this item edits (replaces the list)')
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
        touches: flags.touches === undefined ? undefined : list(flags.touches),
      });
      console.log(`${style.green('updated')} ${updated.id}`);
    });

  backlog
    .command('move <id> <status>')
    .description("move an item to a new status — see 'pomni backlog flow' for what this project allows")
    .option('-p, --project <id>', 'project')
    .option('--reason <text>', 'why (recorded in the item log)')
    .option('-f, --force', 'skip the guards; recorded as forced')
    .action(async (id: string, status: string, flags: MoveFlags) => {
      const container = await open();
      const [projectId, itemId] = await resolve(container, id, flags.project, defaultProject);
      const flow = await container.backlog.flow(projectId);

      const known = flow.states.map((state) => state.name);
      if (!known.includes(status)) {
        console.error(style.red(`unknown status '${status}' — this project's flow has: ${known.join(', ')}`));
        process.exitCode = 1;
        return;
      }

      const moved = await container.backlog.transition(projectId, itemId, status, {
        reason: flags.reason,
        force: flags.force,
      });
      console.log(`${style.green('moved')} ${moved.id} → ${statusText(moved.status, stateLabel(flow, moved.status))}`);
    });

  backlog
    .command('flow')
    .description("show this project's task flow: states, arrows, and what each arrow requires")
    .option('-p, --project <id>', 'project')
    .action(async (flags: { project?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const flow = await container.backlog.flow(projectId);

      console.log(style.bold('states'));
      console.log(
        table(
          flow.states.map((state) => [
            state.name === flow.initial ? style.green('initial') : '',
            style.bold(state.name),
            state.label,
            state.board ? 'board' : '',
            state.active ? 'active' : '',
          ]),
          ['', 'STATE', 'LABEL', 'COLUMN', 'ACTIVE'],
        ),
      );

      console.log();
      console.log(style.bold('arrows'));
      if (flow.transitions.length === 0) {
        console.log(style.dim('none declared'));
      } else {
        console.log(
          table(
            flow.transitions.map((transition) => [
              `${transition.from} → ${transition.to}`,
              describeRequirements(transition.requires),
            ]),
            ['ARROW', 'REQUIRES'],
          ),
        );
      }
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
      const flow = await container.backlog.flow(projectId);
      console.log(`${style.green('unblocked')} ${item.id} → ${statusText(item.status, stateLabel(flow, item.status))}`);
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
    .command('waves')
    .description('group ready items into waves that can run concurrently')
    .option('-p, --project <id>', 'project')
    .option('--explain', 'show the conflict graph and each item\'s path scope')
    .option('--run', 'launch wave 1')
    .action(async (flags: { project?: string; explain?: boolean; run?: boolean }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const plan: WavePlan = await container.backlog.waves(projectId);
      const items = await container.backlog.list({ projectId });
      const byId = new Map(items.map((item) => [item.id, item]));

      if (plan.waves.length === 0 && plan.blocked.length === 0) {
        console.log(style.dim("nothing is ready — move an item to 'ready' first"));
        return;
      }

      for (const wave of plan.waves) {
        console.log(`${style.bold(`wave ${wave.index}`)} ${style.dim(`(${wave.itemIds.length})`)}`);
        for (const itemId of wave.itemIds) {
          const item = byId.get(itemId);
          console.log(`  ${item ? itemLine(item) : itemId}`);
        }
        console.log();
      }

      if (plan.blocked.length > 0) {
        console.log(style.bold('blocked'));
        for (const blocked of plan.blocked) {
          const item = byId.get(blocked.itemId);
          console.log(
            `  ${style.bold(blocked.itemId)}  ${item ? item.title : ''} ${style.red(
              `— waiting on ${blocked.waitingOn.join(', ')}`,
            )}`,
          );
        }
        console.log();
      }

      if (flags.explain) {
        console.log(style.bold('conflicts'));
        if (plan.conflicts.length === 0) {
          console.log(style.dim('none — every ready item is independent'));
        } else {
          for (const edge of plan.conflicts) {
            console.log(`${style.bold(edge.a)} <-> ${style.bold(edge.b)}`);
            for (const reason of edge.reasons) {
              console.log(`  ${describeConflict(reason)}`);
            }
          }
        }

        console.log();
        console.log(style.bold('scopes'));
        for (const [itemId, scope] of Object.entries(plan.scopes)) {
          console.log(`${style.bold(itemId)}  ${describeScope(scope)}`);
        }
        console.log();
      }

      if (flags.run) {
        const first = plan.waves[0];
        if (!first || first.itemIds.length === 0) {
          console.log(style.dim('nothing to run — wave 1 is empty'));
          return;
        }

        // `planWaves` already asserts this before returning, so this call is redundant today.
        // Kept as a genuine guard for the day a plan arrives from somewhere other than
        // `planWaves` — not a guard against anything a user did.
        assertWavesDisjoint(plan);

        console.log(`${style.cyan('running')} wave 1: ${first.itemIds.join(', ')}`);
        console.log();

        const results = await Promise.allSettled(
          first.itemIds.map(async (itemId) => {
            const item = byId.get(itemId);
            const description = item ? `${item.title}\n\n${item.body}` : itemId;

            const printEvent = (event: PomniEvent & EmittedEvent) => {
              if (event.type === 'pipeline.step.started') {
                const indent = '  '.repeat(event.depth);
                console.log(
                  `${indent}${style.cyan('▸')} ${style.dim(itemId)} ${style.bold(event.agentName)} ${style.dim(
                    `${event.providerId} · ${event.model}`,
                  )}`,
                );
              }
              if (event.type === 'pipeline.step.finished') {
                console.log(
                  `  ${style.dim(itemId)} ${event.status === 'done' ? style.green('✓') : style.red('✗')} ${style.dim(
                    event.summary,
                  )}`,
                );
              }
            };

            // Subscribed before `start()` is even called: `start()` resolves once the run row
            // exists and its pipeline is already executing, so the orchestrator's first
            // `pipeline.step.started` can fire before we would otherwise have a handler for it.
            // Events that arrive before we know this item's run id are buffered and replayed
            // once `start()` tells us which run id is ours.
            let runId: string | null = null;
            const buffered: (PomniEvent & EmittedEvent)[] = [];
            const unsubscribe = container.events.subscribe((event) => {
              if (!('runId' in event)) return;
              if (runId === null) {
                buffered.push(event);
                return;
              }
              if (event.runId === runId) printEvent(event);
            });

            try {
              const { run, completion } = await container.pipelines.start({
                projectId,
                task: description,
                itemId,
              });
              runId = run.id;
              for (const event of buffered) {
                if ('runId' in event && event.runId === runId) printEvent(event);
              }
              buffered.length = 0;

              const finished = await completion;
              if (finished.status === 'passed') {
                console.log(`${style.green('✓')} ${itemId} finished in ${Math.round((finished.durationMs ?? 0) / 1000)}s`);
              } else {
                console.log(`${style.red('✗')} ${itemId} ${finished.status}: ${finished.error ?? ''}`);
                throw new Error(`${itemId} ${finished.status}`);
              }
            } finally {
              unsubscribe();
            }
          }),
        );

        const failed = results.filter((result) => result.status === 'rejected').length;
        const passed = results.length - failed;
        console.log();
        console.log(
          `${style.bold('wave 1 done')}  ${style.green(`${passed} passed`)}${
            failed > 0 ? `  ${style.red(`${failed} failed`)}` : ''
          }`,
        );
        if (failed > 0) process.exitCode = 1;
      }
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
  touches?: string;
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
  return value;
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

/** Colours for the built-in vocabulary. A project state outside it prints plainly, uncoloured. */
const STATUS_COLOR: Record<string, (text: string) => string> = {
  backlog: style.dim,
  specced: style.blue,
  ready: style.blue,
  in_progress: style.cyan,
  in_review: style.cyan,
  done: style.green,
  blocked: style.red,
  cancelled: style.dim,
};

function statusText(status: ItemStatus, label?: string): string {
  const text = label ?? status;
  const color = STATUS_COLOR[status];
  return color ? color(text) : text;
}

/** English for a declared requirement set, in the voice used everywhere a refusal is shown. */
function describeRequirements(requires: Requirements): string {
  if (!hasRequirements(requires)) return '';
  const parts: string[] = [];
  if (requires.acceptance) parts.push('acceptance');
  if (requires.gate) parts.push(`gate \`${requires.gate}\``);
  if (requires.checklist.length > 0) {
    parts.push(`checklist: ${requires.checklist.map((entry) => entry.label).join(', ')}`);
  }
  if (requires.fields.length > 0) parts.push(`fields: ${requires.fields.join(', ')}`);
  if (requires.sections.length > 0) parts.push(`sections: ${requires.sections.join(', ')}`);
  if (requires.spec) {
    parts.push(`spec: ${requires.spec.sections.join(', ')} (min ${requires.spec.minCriteria} criteria)`);
  }
  if (requires.dependencies) parts.push('dependencies');
  return parts.join(', ');
}

/** One line of `pomni backlog show`'s moves list — available, or unavailable with why. */
function offerLine(offer: TransitionOffer): string {
  if (offer.ok) return `  ${style.green('→')} ${offer.label}`;

  const reasons = describeUnmetList(offer.unmet);
  if (reasons.length === 0) return `  ${style.dim('✗')} ${offer.label} ${style.dim('(no such move from here)')}`;
  return [
    `  ${style.dim('✗')} ${offer.label}`,
    ...reasons.map((reason) => `      ${style.dim(reason)}`),
  ].join('\n');
}

/** `pomni backlog waves --explain`'s per-item line: what paths it reads as touching, and why. */
function describeScope(scope: PathScope): string {
  if (scope.kind === 'whole-repo') {
    return style.dim('names no paths — read as touching its whole repo');
  }
  return `${scope.paths.join(', ')} ${style.dim(`(from ${scope.source})`)}`;
}

export function itemLine(item: BacklogItem): string {
  return `${item.id}  ${item.priority}  ${item.title}`;
}
