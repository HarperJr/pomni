import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  PomniError,
  RequirementsNotMetError,
  describeSource,
  type AddRepoSourceInput,
  type RepoRole,
  type WorktreePolicy,
} from '@pomni/core';
import { FileEventSource } from '@pomni/infra';
import { startServer } from '@pomni/server';
import { Command } from 'commander';
import { createContainer, openContainer, rootForInit } from './container.js';
import { describeCapabilities, repoRow, statusLabel, style, table } from './format.js';
import { registerBacklogCommands } from './backlog-commands.js';
import { registerRunCommands } from './run-commands.js';
import { registerToolCommands } from './tool-commands.js';
import { registerWorktreeCommands } from './worktree-commands.js';
import {
  registerDiscoveryCommands,
  registerProviderCommands,
  registerTaskCommands,
  registerWorkflowCommands,
} from './workflow-commands.js';

interface GlobalOptions {
  root?: string;
  verbose?: boolean;
}

const WORKTREE_POLICIES: WorktreePolicy[] = ['auto', 'always', 'never'];

export async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name('pomni')
    .description('AI-driven, project-oriented fullstack runtime')
    .version('0.1.0')
    .option('--root <path>', 'workspace directory (defaults to the nearest .pomni)')
    .option('--verbose', 'verbose logging')
    .showHelpAfterError();

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const open = () =>
    openContainer({ root: globals().root, logLevel: globals().verbose ? 'debug' : 'warn' });

  /**
   * `-p` is optional when there is only one project — the overwhelmingly common case early
   * on, and typing the id every time gets old fast.
   */
  const defaultProject = async (): Promise<string> => {
    const container = await open();
    const configured = (await container.workspace.config()).defaultProject;
    if (configured) return configured;

    const projects = await container.projects.list();
    if (projects.length === 1) return projects[0]!.id;
    if (projects.length === 0) {
      throw new PomniError('validation', "no projects yet — run 'pomni project create <name>'");
    }
    throw new PomniError(
      'validation',
      `several projects exist — pass -p <id> or run 'pomni project use <id>'. Available: ${projects
        .map((project) => project.id)
        .join(', ')}`,
    );
  };

  // -- init -----------------------------------------------------------------

  program
    .command('init')
    .description('create a Pomni workspace in the current directory')
    .action(async () => {
      const root = rootForInit({ root: globals().root });
      const container = createContainer(root, globals().verbose ? 'debug' : 'warn');
      const existed = await container.workspace.isInitialized();
      await container.workspace.init();

      console.log(
        existed
          ? `${style.dim('workspace already initialized at')} ${root}`
          : `${style.green('initialized')} ${root}`,
      );
      if (!(await container.git.isAvailable())) {
        console.log(style.yellow('warning: git was not found on PATH — cloning repos will fail'));
      }
    });

  // -- project --------------------------------------------------------------

  const project = program.command('project').description('manage projects');

  project
    .command('create <name>')
    .description('create a project')
    .option('--id <id>', 'explicit project id (default: derived from the name)')
    .option('-d, --description <text>', 'short description')
    .action(async (name: string, options: { id?: string; description?: string }) => {
      const container = await open();
      const created = await container.projects.create({
        name,
        id: options.id,
        description: options.description,
      });
      console.log(`${style.green('created')} project ${style.bold(created.id)}  ${created.name}`);
      console.log(style.dim(`add a repo:  pomni repo add <path-or-url> -p ${created.id}`));
    });

  project
    .command('edit <id>')
    .description('change a project: its name, description, or the key its items are numbered under')
    .option('-n, --name <name>', 'display name')
    .option('-d, --description <text>', 'short description')
    .option('--item-prefix <key>', 'key for future item ids and branch names, e.g. POMN')
    .option('--auto-commit', 'a run commits what it wrote on its own branch')
    .option('--no-auto-commit', 'a run leaves its work as uncommitted files')
    .option('--auto-push', "a run pushes its branch, so there is something to open an MR against")
    .option('--no-auto-push', 'a run keeps its branch local')
    .option('--auto-mr', "a pushed branch also gets a merge request opened through the forge")
    .option('--no-auto-mr', 'a pushed branch is left for someone to open a merge request for')
    .option('--max-cost <usd>', 'stop a run once its accumulated cost passes this many dollars')
    .option('--no-max-cost', 'remove the cost ceiling — a run may spend without limit')
    .option('--max-turns <n>', 'stop a run once its agent steps reach this many, across the whole run')
    .option('--no-max-turns', 'remove the turn ceiling — a run may take as many steps as it needs')
    .action(
      async (
        id: string,
        options: {
          name?: string;
          description?: string;
          itemPrefix?: string;
          autoCommit?: boolean;
          autoPush?: boolean;
          autoMr?: boolean;
          maxCost?: string | false;
          maxTurns?: string | false;
        },
      ) => {
        const container = await open();
        const before = await container.projects.getRef(id);

        let maxCostUsd: number | undefined;
        if (options.maxCost !== undefined && options.maxCost !== false) {
          maxCostUsd = Number(options.maxCost);
          if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
            console.error(style.red(`--max-cost must be a positive number, got ${options.maxCost}`));
            process.exitCode = 1;
            return;
          }
        }

        let maxTurns: number | undefined;
        if (options.maxTurns !== undefined && options.maxTurns !== false) {
          maxTurns = Number(options.maxTurns);
          if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
            console.error(style.red(`--max-turns must be a positive integer, got ${options.maxTurns}`));
            process.exitCode = 1;
            return;
          }
        }

        const policy = {
          ...(options.autoCommit !== undefined ? { autoCommit: options.autoCommit } : {}),
          ...(options.autoPush !== undefined ? { autoPush: options.autoPush } : {}),
          ...(options.autoMr !== undefined ? { autoMergeRequest: options.autoMr } : {}),
          ...(options.maxCost !== undefined ? { maxCostUsd } : {}),
          ...(options.maxTurns !== undefined ? { maxTurns } : {}),
        };
        const updated = await container.projects.update(id, {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.itemPrefix !== undefined ? { itemPrefix: options.itemPrefix } : {}),
          ...(Object.keys(policy).length > 0 ? { policy } : {}),
        });
        console.log(`${style.green('updated')} project ${style.bold(updated.id)}  ${updated.name}`);
        if (Object.keys(policy).length > 0) {
          console.log(
            style.dim(
              `  a run now ${updated.policy.autoCommit ? 'commits' : 'does not commit'} its work, ` +
                `${updated.policy.autoPush ? 'pushes' : 'does not push'} the branch and ` +
                `${updated.policy.autoMergeRequest ? 'opens' : 'does not open'} a merge request`,
            ),
          );
        }
        if (options.maxCost !== undefined || options.maxTurns !== undefined) {
          console.log(
            style.dim(
              `  a run now stops past ${
                updated.policy.maxCostUsd !== undefined ? `$${updated.policy.maxCostUsd}` : 'no cost limit'
              } or ${
                updated.policy.maxTurns !== undefined ? `${updated.policy.maxTurns} turns` : 'no turn limit'
              }`,
            ),
          );
        }
        if (updated.itemPrefix !== before.data.itemPrefix) {
          console.log(
            style.dim(
              `  items are now numbered ${updated.itemPrefix}-${updated.counters.nextItem} onwards; ` +
                `${before.data.itemPrefix} ids already written keep their names`,
            ),
          );
        }
      },
    );

  project
    .command('list')
    .alias('ls')
    .description('list projects')
    .action(async () => {
      const container = await open();
      const projects = await container.projects.list();
      if (projects.length === 0) {
        console.log(style.dim("no projects yet — create one with 'pomni project create <name>'"));
        return;
      }
      console.log(
        table(
          projects.map((item) => [
            style.bold(item.id),
            item.name,
            `${item.repoCount} repo${item.repoCount === 1 ? '' : 's'}`,
            item.repos.map((repo) => repo.id).join(', ') || style.dim('—'),
          ]),
          ['ID', 'NAME', 'REPOS', ''],
        ),
      );
    });

  project
    .command('show <id>')
    .description('show a project and its repos')
    .action(async (id: string) => {
      const container = await open();
      const detail = await container.projects.get(id);
      const repos = await container.repos.listResolved(id);

      console.log(`${style.bold(detail.name)}  ${style.dim(`(${detail.id})`)}`);
      if (detail.description) console.log(detail.description);
      console.log(style.dim(`item prefix ${detail.itemPrefix} · gate ${detail.gates.default.join(' → ')}`));
      console.log();

      if (repos.length === 0) {
        console.log(style.dim("no repos yet — add one with 'pomni repo add <path-or-url> -p " + id + "'"));
        return;
      }
      const worktrees = await container.worktrees.list({ projectId: id });
      const byRepo = new Map<string, typeof worktrees>();
      for (const wt of worktrees) byRepo.set(wt.repoId, [...(byRepo.get(wt.repoId) ?? []), wt]);
      console.log(
        table(
          repos.map((repo) => repoRow(repo, byRepo.get(repo.id) ?? [])),
          ['REPO', 'ROLE', 'STATUS', 'STACK', 'KIND', 'SOURCE', 'WORKTREES'],
        ),
      );
    });

  project
    .command('use <id>')
    .description('set the default project for commands that omit -p')
    .action(async (id: string) => {
      const container = await open();
      await container.projects.getRef(id);
      await container.workspace.setConfig({ defaultProject: id });
      console.log(`${style.green('default project')} ${style.bold(id)}`);
    });

  project
    .command('remove <id>')
    .alias('rm')
    .description('remove a project')
    .option('--purge', 'also delete cloned working copies (linked local repos are never deleted)')
    .action(async (id: string, options: { purge?: boolean }) => {
      const container = await open();
      await container.projects.remove(id, { purge: options.purge });
      console.log(`${style.green('removed')} project ${id}`);
    });

  // -- repo -----------------------------------------------------------------

  const repo = program.command('repo').description('manage repos inside a project');

  repo
    .command('add <target>')
    .description('add a repo: a local path, or a git url to clone into the workspace')
    .requiredOption('-p, --project <id>', 'project to add the repo to')
    .option('--path', 'force treating the target as a local path')
    .option('--url', 'force treating the target as a git url')
    .option('--ref <ref>', 'branch or tag to check out (git only)')
    .option('--provider <name>', 'github | gitlab | bitbucket | generic (default: detected)')
    .option('-c, --credential <id>', 'credential to authenticate with (git only)')
    .option('--id <id>', 'explicit repo id (default: derived from the target)')
    .option('-n, --name <name>', 'display name')
    .option('-r, --role <role>', 'web | api | mobile | desktop | lib | infra | docs | other')
    .action(
      async (
        target: string,
        options: {
          project: string;
          path?: boolean;
          url?: boolean;
          ref?: string;
          provider?: string;
          credential?: string;
          id?: string;
          name?: string;
          role?: string;
        },
      ) => {
        const container = await open();
        const source = buildSource(target, options);

        const { repo: created, completion } = await container.repos.add(options.project, {
          source,
          id: options.id,
          name: options.name,
          role: options.role as RepoRole | undefined,
        });

        if (source.kind === 'git') {
          console.log(`${style.cyan('cloning')} ${source.url} → ${style.dim(container.workspace.workingDir(created))}`);
          container.events.subscribe((event) => {
            if (event.type === 'repo.progress' && event.repoId === created.id) {
              process.stderr.write(`\r${style.dim(event.line.slice(0, 100).padEnd(100))}`);
            }
          });
        }

        const settled = await completion;
        if (source.kind === 'git') process.stderr.write('\r'.padEnd(102) + '\r');

        if (settled.status === 'error') {
          console.error(`${style.red('failed')} ${settled.lastError ?? 'unknown error'}`);
          process.exitCode = 1;
          return;
        }

        const resolved = await container.workspace.resolve(settled);
        console.log(
          `${style.green('added')} ${style.bold(settled.id)} to ${options.project}  ${statusLabel(settled.status)}`,
        );
        console.log(style.dim(`  ${describeSource(settled.source)}`));
        console.log(style.dim(`  ${resolved.workingDir}`));
        if (settled.stack) {
          console.log(`  ${style.blue(settled.stack.adapter)}  ${settled.stack.detected.join(', ')}`);
        }
        const names = Object.keys(settled.capabilities);
        if (names.length > 0) console.log(style.dim(`  capabilities: ${names.sort().join(', ')}`));
      },
    );

  repo
    .command('list')
    .alias('ls')
    .description('list repos')
    .option('-p, --project <id>', 'project to list (default: all projects)')
    .action(async (options: { project?: string }) => {
      const container = await open();
      const projectIds = options.project
        ? [options.project]
        : (await container.projects.list()).map((item) => item.id);

      let printed = false;
      for (const projectId of projectIds) {
        const repos = await container.repos.listResolved(projectId);
        if (repos.length === 0) continue;
        if (projectIds.length > 1) console.log(style.bold(projectId));

        const worktrees = await container.worktrees.list({ projectId });
        const byRepo = new Map<string, typeof worktrees>();
        for (const wt of worktrees) byRepo.set(wt.repoId, [...(byRepo.get(wt.repoId) ?? []), wt]);

        console.log(
          table(
            repos.map((repo) => repoRow(repo, byRepo.get(repo.id) ?? [])),
            ['REPO', 'ROLE', 'STATUS', 'STACK', 'KIND', 'SOURCE', 'WORKTREES'],
          ),
        );
        if (projectIds.length > 1) console.log();
        printed = true;
      }
      if (!printed) console.log(style.dim('no repos yet'));
    });

  repo
    .command('show <ref>')
    .description('show one repo, as project/repo')
    .action(async (ref: string) => {
      const container = await open();
      const [projectId, repoId] = splitRef(ref);
      const found = await container.repos.get(projectId, repoId);

      console.log(`${style.bold(found.name)}  ${style.dim(`(${projectId}/${found.id})`)}`);
      console.log(`status    ${statusLabel(found.status)}${found.lastError ? `  ${style.red(found.lastError)}` : ''}`);
      console.log(`role      ${found.role}`);
      console.log(`source    ${describeSource(found.source)}  ${style.dim(`(${found.source.kind})`)}`);
      console.log(`path      ${found.workingDir}${found.workingDirExists ? '' : style.red('  (missing)')}`);
      if (found.stack) console.log(`stack     ${found.stack.adapter}: ${found.stack.detected.join(', ')}`);
      if (found.vcs) {
        console.log(
          `git       ${found.vcs.currentBranch ?? 'detached'}${found.vcs.dirty ? style.yellow(' (dirty)') : ''}${
            found.vcs.remote ? style.dim(`  ${found.vcs.remote}`) : ''
          }`,
        );
      }
      console.log();
      console.log(describeCapabilities(found.capabilities));
    });

  repo
    .command('sync <ref>')
    .description('fetch and re-detect the stack for a repo')
    .action(async (ref: string) => {
      const container = await open();
      const [projectId, repoId] = splitRef(ref);
      const synced = await container.repos.sync(projectId, repoId);
      console.log(`${style.green('synced')} ${projectId}/${repoId}  ${statusLabel(synced.status)}`);
      if (synced.stack) console.log(style.dim(`  ${synced.stack.detected.join(', ')}`));
      // What the base branch did is the reason to run this at all: a run cuts its worktree
      // from that branch, so "fetched" and "moved" are different news.
      if (synced.advanced) {
        const refused =
          synced.advanced.status === 'diverged' || synced.advanced.status === 'dirty';
        const label = refused ? style.yellow('  not advanced') : style.dim('  ');
        console.log(`${label}${refused ? ' — ' : ''}${synced.advanced.detail}`);
      }
    });

  repo
    .command('edit <ref>')
    .description('change a repo: its name, role, or — for a clone — its url, branch or credential')
    .option('-n, --name <name>', 'display name')
    .option('-r, --role <role>', 'web | api | mobile | desktop | lib | infra | docs | other')
    .option('--url <url>', 'new git url (needs --reclone if a working copy exists)')
    .option('--ref <ref>', 'branch or tag; pass "" to follow the default branch')
    .option('-c, --credential <id>', 'credential to authenticate with; pass "" to detach')
    .option('--provider <name>', 'github | gitlab | bitbucket | generic')
    .option('--reclone', 'delete the existing working copy and clone the new url')
    .option(
      '--worktrees <policy>',
      'auto | always | never — auto gives a clone its own worktree per run and leaves a linked repo shared; always takes a worktree even for a linked repo; never shares this repo\'s directory across every run',
    )
    .action(
      async (
        target: string,
        options: {
          name?: string;
          role?: string;
          url?: string;
          ref?: string;
          credential?: string;
          provider?: string;
          reclone?: boolean;
          worktrees?: string;
        },
      ) => {
        const container = await open();
        const [projectId, repoId] = splitRef(target);

        if (options.worktrees !== undefined && !WORKTREE_POLICIES.includes(options.worktrees as WorktreePolicy)) {
          throw new PomniError(
            'validation',
            `--worktrees must be one of ${WORKTREE_POLICIES.join(', ')}, got '${options.worktrees}'`,
          );
        }

        const updated = await container.repos.update(projectId, repoId, {
          name: options.name,
          role: options.role as RepoRole | undefined,
          url: options.url,
          ref: options.ref === undefined ? undefined : options.ref === '' ? null : options.ref,
          credential:
            options.credential === undefined
              ? undefined
              : options.credential === ''
                ? null
                : options.credential,
          provider: options.provider as 'github' | 'gitlab' | 'bitbucket' | 'generic' | undefined,
          reclone: options.reclone,
          worktrees: options.worktrees as WorktreePolicy | undefined,
        });

        console.log(`${style.green('updated')} ${projectId}/${updated.id}  ${statusLabel(updated.status)}`);
        console.log(style.dim(`  ${describeSource(updated.source)}`));
        if (updated.source.kind === 'git' && updated.source.credential) {
          console.log(style.dim(`  credential: ${updated.source.credential}`));
        }
        if (updated.lastError) console.log(style.red(`  ${updated.lastError}`));
        else if (updated.status !== 'ready' && updated.status !== 'linked') {
          console.log(style.dim(`  next: pomni repo sync ${projectId}/${updated.id}`));
        }
      },
    );

  repo
    .command('doctor')
    .description('check that each repo and each declared capability can actually run')
    .option('-p, --project <id>', 'project')
    .option('-r, --repo <id>', 'restrict to one repo')
    .action(async (flags: { project?: string; repo?: string }) => {
      const container = await open();
      const projectId = flags.project ?? (await defaultProject());
      const report = await container.doctor.check(projectId, flags.repo);

      for (const repoReport of report.repos) {
        console.log(`${mark(repoReport.status)} ${style.bold(repoReport.repoId)} ${style.dim(repoReport.name)}`);
        for (const check of repoReport.checks) {
          console.log(`   ${mark(check.status)} ${check.name.padEnd(14)} ${style.dim(check.detail)}`);
        }
        console.log();
      }

      if (report.worktrees.length > 0) {
        console.log(style.bold('worktrees'));
        for (const wt of report.worktrees) {
          console.log(
            `   ${mark(wt.status)} ${wt.repoId.padEnd(14)} run ${wt.runId}  ${wt.state}  ${style.dim(wt.path)}`,
          );
          console.log(`      ${style.dim(wt.detail)}`);
        }
        console.log();
      }

      if (report.abandoned.length > 0) {
        console.log(style.bold('branches a run left behind'));
        for (const branch of report.abandoned) {
          console.log(
            `   ${mark('warn')} ${branch.repoId.padEnd(14)} ${branch.branch}` +
              `${branch.runId ? `  ${style.dim(`run ${branch.runId}`)}` : ''}`,
          );
          console.log(`      ${style.dim(branch.detail)}`);
        }
        console.log();
      }

      console.log(
        report.status === 'fail'
          ? style.red('problems found')
          : report.status === 'warn'
            ? style.yellow('usable, with warnings')
            : style.green('all good'),
      );
      if (report.status === 'fail') process.exitCode = 1;
    });

  repo
    .command('remove <ref>')
    .alias('rm')
    .description('remove a repo from its project')
    .option('--purge', 'also delete the cloned working copy')
    .action(async (ref: string, options: { purge?: boolean }) => {
      const container = await open();
      const [projectId, repoId] = splitRef(ref);
      await container.repos.remove(projectId, repoId, { purge: options.purge });
      console.log(`${style.green('removed')} ${projectId}/${repoId}`);
    });

  // -- credentials ----------------------------------------------------------

  const cred = program.command('cred').description('manage git credentials');

  cred
    .command('add <name>')
    .description('register a credential (the token is never written to a tracked file)')
    .option('--id <id>', 'explicit credential id')
    .option('--provider <provider>', 'github | gitlab | bitbucket | generic', 'github')
    .option('--host <host>', 'host this credential is valid for')
    .option('--username <username>', 'username sent with the token')
    .option('--env <VAR>', 'read the token from this environment variable')
    .option('--gh', 'delegate to the GitHub CLI (gh auth token)')
    .option('--token <token>', 'store the token in .pomni/credentials.secret.json (gitignored)')
    .action(
      async (
        name: string,
        options: {
          id?: string;
          provider?: string;
          host?: string;
          username?: string;
          env?: string;
          gh?: boolean;
          token?: string;
        },
      ) => {
        const container = await open();
        const chosen = [options.env && 'env', options.gh && 'gh', options.token && 'token'].filter(
          Boolean,
        );
        if (chosen.length !== 1) {
          console.error(style.red('choose exactly one of --env <VAR>, --gh, or --token <token>'));
          process.exitCode = 1;
          return;
        }

        const secretRef = options.env
          ? ({ kind: 'env', var: options.env } as const)
          : options.gh
            ? ({ kind: 'gh-cli' } as const)
            : ({ kind: 'file' } as const);

        const created = await container.credentials.create({
          name,
          id: options.id,
          provider: options.provider as 'github' | 'gitlab' | 'bitbucket' | 'generic' | undefined,
          host: options.host,
          username: options.username,
          secretRef,
          secret: options.token,
        });

        console.log(`${style.green('added')} credential ${style.bold(created.id)} for ${created.host}`);
        if (!created.hasSecret) {
          console.log(style.yellow('  the secret does not resolve yet — check the source and run: pomni cred test ' + created.id));
        }
      },
    );

  cred
    .command('list')
    .alias('ls')
    .description('list credentials')
    .action(async () => {
      const container = await open();
      const credentials = await container.credentials.list();
      if (credentials.length === 0) {
        console.log(style.dim("no credentials — add one with 'pomni cred add <name> --gh'"));
        return;
      }
      console.log(
        table(
          credentials.map((item) => [
            style.bold(item.id),
            item.host,
            item.secretRef.kind === 'env' ? `env:${item.secretRef.var}` : item.secretRef.kind,
            item.hasSecret ? style.green('resolves') : style.red('no secret'),
          ]),
          ['ID', 'HOST', 'SOURCE', 'SECRET'],
        ),
      );
    });

  cred
    .command('edit <id>')
    .description('change a credential, or rotate its token')
    .option('--name <name>', 'display name')
    .option('--provider <provider>', 'github | gitlab | bitbucket | generic')
    .option('--host <host>', 'host this credential is valid for (include a port if the url has one)')
    .option('--username <username>', 'username sent with the token')
    .option('--env <VAR>', 'read the token from this environment variable')
    .option('--gh', 'delegate to the GitHub CLI')
    .option('--token <token>', 'replace the stored token')
    .action(
      async (
        id: string,
        options: {
          name?: string;
          provider?: string;
          host?: string;
          username?: string;
          env?: string;
          gh?: boolean;
          token?: string;
        },
      ) => {
        const container = await open();
        const chosen = [options.env && 'env', options.gh && 'gh', options.token && 'token'].filter(
          Boolean,
        );
        if (chosen.length > 1) {
          console.error(style.red('choose at most one of --env <VAR>, --gh, or --token <token>'));
          process.exitCode = 1;
          return;
        }

        const secretRef = options.env
          ? ({ kind: 'env', var: options.env } as const)
          : options.gh
            ? ({ kind: 'gh-cli' } as const)
            : options.token
              ? ({ kind: 'file' } as const)
              : undefined;

        const updated = await container.credentials.update(id, {
          name: options.name,
          provider: options.provider as
            | 'github'
            | 'gitlab'
            | 'bitbucket'
            | 'generic'
            | undefined,
          host: options.host,
          username: options.username,
          secretRef,
          secret: options.token,
        });

        console.log(`${style.green('updated')} credential ${style.bold(updated.id)}`);
        console.log(style.dim(`  ${updated.host}  user ${updated.username}  ${updated.secretRef.kind}`));
        if (!updated.hasSecret) {
          console.log(style.yellow('  the secret does not resolve — check the source'));
        }
      },
    );

  cred
    .command('test <id>')
    .description('check that the credential resolves, and optionally that a remote accepts it')
    .option('--url <url>', 'git url to authenticate against')
    .action(async (id: string, options: { url?: string }) => {
      const container = await open();
      const result = await container.credentials.test(id, options.url);
      console.log(result.ok ? style.green(result.message) : style.red(result.message));
      if (!result.ok) process.exitCode = 1;
    });

  cred
    .command('remove <id>')
    .alias('rm')
    .description('remove a credential')
    .action(async (id: string) => {
      const container = await open();
      await container.credentials.remove(id);
      console.log(`${style.green('removed')} credential ${id}`);
    });

  // -- serve ----------------------------------------------------------------

  program
    .command('mcp')
    .description('run the MCP server over stdio (for Claude Code and other MCP clients)')
    .action(async () => {
      const container = await open();
      const { startStdioServer } = await import('@pomni/mcp');
      // stdout is the transport from here on: nothing else may write to it.
      await startStdioServer(container);
    });

  program
    .command('serve')
    .description('start the management server and web UI')
    .option('--port <port>', 'port to listen on', '7777')
    .option('--host <host>', 'address to bind', '127.0.0.1')
    .option('--token <token>', 'bearer token (required when host is not loopback)')
    .option('--open', 'open a browser once the server is up')
    .action(async (options: { port: string; host: string; token?: string; open?: boolean }) => {
      const container = await open();

      // Reads the commit this process is running, once, before it serves anything — the
      // baseline `/api/health` compares HEAD against to say the server is behind the repo.
      await container.system.boot();

      // Replay events written by other Pomni processes onto this bus, so a run started from
      // a terminal shows up live in the browser. This is what makes the server a peer.
      const source = new FileEventSource(container.events, join(container.root, 'events.ndjson'));
      await source.start();

      const server = await startServer(container, {
        host: options.host,
        port: Number(options.port),
        token: options.token,
        logLevel: globals().verbose ? 'info' : 'warn',
      });

      console.log(`${style.green('pomni')} ${server.url}`);
      console.log(style.dim(`workspace ${container.root}`));
      console.log(style.dim('press ctrl+c to stop'));

      if (options.open) openBrowser(server.url);

      const shutdown = () => {
        source.stop();
        container.runStore.close();
        void server.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  registerRunCommands(program, open, defaultProject);
  registerBacklogCommands(program, open, defaultProject);
  registerWorkflowCommands(program, open, defaultProject);
  registerDiscoveryCommands(program, open, defaultProject);
  registerProviderCommands(program, open);
  registerTaskCommands(program, open, defaultProject);
  registerToolCommands(program, open, defaultProject);
  registerWorktreeCommands(program, open, defaultProject);

  await program.parseAsync(argv);
}

// ---------------------------------------------------------------------------

function mark(status: 'ok' | 'warn' | 'fail'): string {
  if (status === 'ok') return style.green('✓');
  if (status === 'warn') return style.yellow('!');
  return style.red('✗');
}

const GIT_URL = /^(https?:\/\/|git@|ssh:\/\/)/i;

/** A single positional argument is friendlier than --path/--url; the flags stay as overrides. */
function buildSource(
  target: string,
  options: {
    path?: boolean;
    url?: boolean;
    ref?: string;
    provider?: string;
    credential?: string;
  },
): AddRepoSourceInput {
  const looksLikeUrl = GIT_URL.test(target.trim());
  const isGit = options.url || (!options.path && looksLikeUrl);

  if (isGit) {
    return {
      kind: 'git',
      url: target.trim(),
      ref: options.ref,
      credential: options.credential,
      provider: options.provider as 'github' | 'gitlab' | 'bitbucket' | 'generic' | undefined,
    };
  }
  return { kind: 'local', path: target };
}

function splitRef(ref: string): [string, string] {
  const [projectId, repoId] = ref.split('/');
  if (!projectId || !repoId) {
    throw new PomniError('validation', `expected project/repo, got '${ref}'`);
  }
  return [projectId, repoId];
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function reportError(error: unknown): void {
  if (error instanceof RequirementsNotMetError) {
    console.error(style.red(error.message));
    const advice = error.unmet.some((unmet) => unmet.kind === 'gate')
      ? "run 'pomni verify' first, or pass --force to record that you moved it anyway"
      : 'pass --force to record that you moved it anyway';
    console.error(style.dim(advice));
    process.exitCode = 1;
    return;
  }
  if (error instanceof PomniError) {
    console.error(style.red(error.message));
    if (error.code === 'not_initialized') {
      console.error(style.dim(`run 'pomni init' in ${relative(process.cwd(), '.') || '.'}`));
    }
    process.exitCode = 1;
    return;
  }
  console.error(style.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

export { createContainer, openContainer } from './container.js';
