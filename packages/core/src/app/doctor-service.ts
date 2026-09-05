import type { ResolvedRepo } from '../domain/repo.js';
import { WELL_KNOWN_CAPABILITIES } from '../domain/capability.js';
import type { Executor, GitPort } from '../ports/index.js';
import type { ProjectService } from './project-service.js';
import type { RepoService } from './repo-service.js';

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

export interface DoctorReport {
  projectId: string;
  status: CheckStatus;
  repos: RepoReport[];
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
  ) {}

  async check(projectId: string, repoId?: string): Promise<DoctorReport> {
    await this.projects.getRef(projectId);
    const all = await this.repos.listResolved(projectId);
    const targets = repoId ? all.filter((repo) => repo.id === repoId) : all;

    const repos = await Promise.all(targets.map((repo) => this.checkRepo(repo)));
    return { projectId, status: worst(repos.map((repo) => repo.status)), repos };
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
