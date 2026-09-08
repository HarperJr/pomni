import type { ResolvedRepo } from '../domain/repo.js';
import { WELL_KNOWN_CAPABILITIES } from '../domain/capability.js';
import { isRunBranch, runIdFromBranch, type WorktreeState } from '../domain/worktree.js';
import type { Executor, GitPort } from '../ports/index.js';
import type { ProjectService } from './project-service.js';
import type { RepoService } from './repo-service.js';
import type { WorktreeService } from './worktree-service.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface RepoReport {
  repoId: string;
  name: string;
  status: CheckStatus;
  checks: Check[];
}

/**
 * One per-run checkout that still exists. Orphans cost disk, not correctness, so they warn
 * rather than fail — but they must be *visible*, because a pipeline process dying is not a
 * hypothetical and nothing else ever mentions the directory it left behind.
 */
export interface WorktreeCheck {
  id: string;
  repoId: string;
  runId: string;
  path: string;
  branch: string;
  state: WorktreeState;
  status: CheckStatus;
  detail: string;
}

/**
 * A branch a run left behind: commits that are on no other ref, with no worktree on them.
 *
 * `fix/POMN-54/main` is the one that prompted this. A run failed on a session limit, committed
 * what it had — `deliver()` runs on the failure path too — and was tidied up cleanly, which
 * deleted its worktree row. The resume then cut a fresh tree and took a different slot, and
 * the first pass's commit has sat there since, on no remote, referenced by nothing. Nobody was
 * ever told.
 */
export interface AbandonedBranch {
  repoId: string;
  branch: string;
  /** The run it belongs to, when the name still says. */
  runId: string | null;
  detail: string;
}

export interface DoctorReport {
  projectId: string;
  status: CheckStatus;
  repos: RepoReport[];
  worktrees: WorktreeCheck[];
  abandoned: AbandonedBranch[];
}

/**
 * Answers "will this actually run?" without running it.
 *
 * Executing every build to find out would take minutes; resolving each command's executable
 * on PATH catches the overwhelmingly common failure — a repo declaring `pnpm run build` on a
 * machine with no pnpm — in milliseconds.
 */
export class DoctorService {
  constructor(
    private readonly projects: ProjectService,
    private readonly repos: RepoService,
    private readonly executor: Executor,
    private readonly git: GitPort,
    private readonly worktrees: WorktreeService,
  ) {}

  async check(projectId: string, repoId?: string): Promise<DoctorReport> {
    await this.projects.getRef(projectId);
    const all = await this.repos.listResolved(projectId);
    const targets = repoId ? all.filter((repo) => repo.id === repoId) : all;

    const repos = await Promise.all(targets.map((repo) => this.checkRepo(repo)));
    const worktrees = await this.checkWorktrees(projectId, repoId);
    const abandoned = await this.checkAbandoned(targets, worktrees);

    return {
      projectId,
      status: worst([
        ...repos.map((repo) => repo.status),
        ...worktrees.map((worktree) => worktree.status),
        // Work nobody can see is a warning, never a failure: the repo is fine, the commits are
        // safe, and the only thing wrong is that no one has been told they exist.
        ...abandoned.map(() => 'warn' as const),
      ]),
      repos,
      worktrees,
      abandoned,
    };
  }

  private async checkWorktrees(projectId: string, repoId?: string): Promise<WorktreeCheck[]> {
    const inspected = await this.worktrees.inspect({ projectId, ...(repoId ? { repoId } : {}) });

    return inspected.map(({ worktree, state, detail }) => ({
      id: worktree.id,
      repoId: worktree.repoId,
      runId: worktree.runId,
      path: worktree.path,
      branch: worktree.branch,
      state,
      status: state === 'live' || state === 'kept' ? ('ok' as const) : ('warn' as const),
      detail,
    }));
  }

  /**
   * Run branches carrying commits that are on no other ref and have no worktree on them.
   *
   * Only branches Pomni itself cut — `isRunBranch` is the filter, and it is strict about all
   * three segments precisely so that a branch a person wrote is never reported as litter.
   */
  private async checkAbandoned(
    repos: ResolvedRepo[],
    worktrees: WorktreeCheck[],
  ): Promise<AbandonedBranch[]> {
    const held = new Set(worktrees.map((worktree) => worktree.branch));
    const found: AbandonedBranch[] = [];

    for (const repo of repos) {
      if (!repo.workingDirExists) continue;

      const base = repo.vcs?.defaultBranch ?? repo.vcs?.currentBranch;
      if (!base) continue;

      const branches = await this.git.branches(repo.workingDir, base).catch(() => []);
      for (const branch of branches) {
        if (branch.merged || held.has(branch.name) || !isRunBranch(branch.name)) continue;
        found.push({
          repoId: repo.id,
          branch: branch.name,
          runId: runIdFromBranch(branch.name),
          detail:
            `'${branch.name}' has commits that ${base} does not, and no worktree is on it — ` +
            'a run left it behind. Look at it, then merge it or delete it.',
        });
      }
    }

    return found;
  }

  private async checkRepo(repo: ResolvedRepo): Promise<RepoReport> {
    const checks: Check[] = [];

    checks.push(
      repo.workingDirExists
        ? { name: 'working directory', status: 'ok', detail: repo.workingDir }
        : { name: 'working directory', status: 'fail', detail: `missing: ${repo.workingDir}` },
    );

    if (repo.status === 'error' && repo.lastError) {
      checks.push({ name: 'last operation', status: 'fail', detail: repo.lastError });
    }

    if (repo.workingDirExists) {
      const isRepo = await this.git.isRepo(repo.workingDir);
      checks.push(
        isRepo
          ? { name: 'git', status: 'ok', detail: repo.vcs?.currentBranch ?? 'detached' }
          : {
              name: 'git',
              status: repo.source.kind === 'git' ? 'fail' : 'warn',
              detail: 'not a git repository',
            },
      );

      const names = Object.keys(repo.capabilities).sort();
      if (names.length === 0) {
        checks.push({
          name: 'capabilities',
          status: 'warn',
          detail: "none detected — run 'pomni repo sync' or declare them by hand",
        });
      }

      for (const name of names) {
        const capability = repo.capabilities[name];
        if (!capability) continue;

        const executable = firstToken(capability.cmd);
        const resolved = await this.executor.which(executable, repo.workingDir);
        checks.push(
          resolved
            ? { name, status: 'ok', detail: capability.cmd }
            : {
                name,
                status: 'fail',
                detail: `'${executable}' not found on PATH — ${capability.cmd}`,
              },
        );
      }

      const missing = WELL_KNOWN_CAPABILITIES.filter(
        (name) => name !== 'start' && name !== 'e2e' && !repo.capabilities[name],
      );
      if (missing.length > 0) {
        checks.push({
          name: 'coverage',
          status: 'warn',
          detail: `no ${missing.join(', ')} capability`,
        });
      }
    }

    return {
      repoId: repo.id,
      name: repo.name,
      status: worst(checks.map((check) => check.status)),
      checks,
    };
  }
}

/**
 * The executable a shell command line invokes. Skips leading `VAR=value` assignments so
 * `NODE_ENV=test vitest run` resolves `vitest`, not the assignment.
 */
export function firstToken(cmd: string): string {
  for (const part of cmd.trim().split(/\s+/)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) return part;
  }
  return cmd.trim().split(/\s+/)[0] ?? cmd;
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}
