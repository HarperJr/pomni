import { z } from 'zod';
import { ValidationError } from './errors.js';
import type { PipelineRun } from './pipeline.js';
import type { Repo } from './repo.js';

/**
 * A worktree is one run's private checkout of one repo.
 *
 * It is a record of its own, deliberately not a third arm of `RepoSource`. A source arm would
 * mean one `Repo` record per live worktree, so three concurrent runs would make a one-repo
 * project report four repos and the gate would fan out over all four. It would also be
 * unresolvable: `WorkspaceService.workingDir(repo)` is pure and synchronous and has no `runId`
 * in scope, so it could not say which of the four directories it meant.
 */

/**
 * `active` — a run holds it and it will be removed at run end.
 * `kept`   — the run ended with uncommitted changes in it, so it survives for a person to look at.
 *
 * There is deliberately no `released`: a cleanly removed worktree has its row deleted in the
 * same step, so a record exists if and only if a directory exists.
 */
export const WorktreeStatusSchema = z.enum(['active', 'kept']);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const WorktreeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repoId: z.string(),
  runId: z.string(),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().nullable().default(null),
  baseCommit: z.string().nullable().default(null),
  ownerPid: z.number().int().positive().nullable().default(null),
  status: WorktreeStatusSchema.default('active'),
  keptReason: z.string().nullable().default(null),
  createdAt: z.string(),
  endedAt: z.string().nullable().default(null),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export interface WorktreeFilter {
  projectId?: string;
  repoId?: string;
  runId?: string;
  status?: WorktreeStatus;
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

export const WORKTREE_BRANCH_PREFIX = 'pomni/run/';

/**
 * The branch a run's worktree is cut onto.
 *
 * Run ids are ULIDs — 26 characters of Crockford base32, uppercase letters and digits only —
 * so the result is always a valid git ref and there is no sanitising step. Adding one would be
 * a way for two distinct runs to collide on a single branch.
 */
export function runBranch(runId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${runId}`;
}

export function isRunBranch(branch: string): boolean {
  return branch.startsWith(WORKTREE_BRANCH_PREFIX);
}

/** The run a branch belongs to, or null when it is somebody else's branch. */
export function runIdFromBranch(branch: string): string | null {
  if (!isRunBranch(branch)) return null;
  const runId = branch.slice(WORKTREE_BRANCH_PREFIX.length);
  return runId.length > 0 ? runId : null;
}

// ---------------------------------------------------------------------------
// Ownership — CLAUDE.md rule 4, as an assertion
// ---------------------------------------------------------------------------

/**
 * Normalise a path for prefix comparison: separators to `/`, `.`/`..` segments resolved,
 * trailing slash stripped, case folded. Pure string math — the domain imports no `node:path`,
 * and case folding is what makes this hold on Windows.
 */
function normalisePath(input: string): string {
  const slashed = input.replace(/\\/g, '/');
  const rooted = slashed.startsWith('/');
  const out: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = (rooted ? '/' : '') + out.join('/');
  return joined.replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a directory is one Pomni made and may therefore remove.
 *
 * "A linked repo is the user's own working tree. Pomni never deletes it." Every delete path
 * asks this first, so the rule is enforced by the code rather than remembered by the author.
 */
export function isPomniOwned(path: string, worktreesRoot: string): boolean {
  const target = normalisePath(path);
  const root = normalisePath(worktreesRoot);
  if (root === '' || target === '') return false;
  return target.startsWith(`${root}/`);
}

/** `isPomniOwned`, as a guard. Throws ValidationError with the path it refused. */
export function assertPomniOwned(path: string, worktreesRoot: string): void {
  if (!isPomniOwned(path, worktreesRoot)) {
    throw new ValidationError(
      `refusing to remove '${path}' — it is not inside '${worktreesRoot}'. ` +
        'Pomni removes only directories it created.',
    );
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** What the caller had to touch the filesystem and git to find out. */
export interface WorktreeProbe {
  workingDirExists: boolean;
  isGitRepo: boolean;
  gitSupportsWorktrees: boolean;
  currentBranch: string | null;
  head: string | null;
}

export type WorktreeEligibility =
  | { eligible: true; baseRef: string; baseBranch: string | null }
  | { eligible: false; reason: string };

/**
 * Whether this repo can give a run its own checkout, and what to cut it from.
 *
 * Pure: every fact it needs arrives in the probe. The reason strings are the ones a person
 * reads in `pomni repo list` and `pomni doctor`, so they say what the fallback costs — two
 * runs sharing one directory is a conflict, not a quiet degradation.
 *
 * Under `auto` a linked repo is left alone: the directory is the user's own working tree and
 * linking it was not consent to write a worktree entry into their `.git/`. `worktrees: 'always'`
 * is that consent, per repo; `worktrees: 'never'` is the opt-out, and it is available to a
 * cloned repo too.
 */
export function worktreeEligibility(repo: Repo, probe: WorktreeProbe): WorktreeEligibility {
  if (repo.worktrees === 'never') {
    return {
      eligible: false,
      reason: `'${repo.name}' is set to worktrees: never — runs share its directory, and two runs on it are a conflict`,
    };
  }
  if (repo.worktrees === 'auto' && repo.source.kind === 'local') {
    return {
      eligible: false,
      reason: `'${repo.name}' is a repo you linked, so runs share your own working tree — run 'pomni repo edit ${repo.id} --worktrees always' to give each run its own worktree`,
    };
  }
  if (repo.status === 'cloning') {
    return {
      eligible: false,
      reason: `'${repo.name}' is still cloning — runs share its directory until the clone finishes`,
    };
  }
  if (!probe.workingDirExists) {
    return {
      eligible: false,
      reason: `'${repo.name}' has no working directory on this machine — there is nothing to make a worktree from`,
    };
  }
  if (!probe.isGitRepo) {
    return {
      eligible: false,
      reason: `'${repo.name}' is not a git repository — runs share its directory, and two runs on it are a conflict`,
    };
  }
  if (!probe.gitSupportsWorktrees) {
    return {
      eligible: false,
      reason: 'this git is too old for worktrees (2.5 or newer is needed) — runs share every repo directory',
    };
  }
  if (!probe.head) {
    return {
      eligible: false,
      reason: `'${repo.name}' has no commits yet — a worktree needs a commit to start from`,
    };
  }
  return { eligible: true, baseRef: probe.currentBranch ?? probe.head, baseBranch: probe.currentBranch };
}

/** Shorthand for the only question most callers have. */
export function isolatesRuns(repo: Repo, probe: WorktreeProbe): boolean {
  return worktreeEligibility(repo, probe).eligible;
}

// ---------------------------------------------------------------------------
// Orphans
// ---------------------------------------------------------------------------

export type WorktreeState = 'live' | 'kept' | 'orphaned' | 'missing';

/**
 * How long a worktree row is given to catch up with the bookkeeping around it before it counts
 * as orphaned. It covers two gaps, both of which look exactly like abandonment from here:
 *
 *  - between `git worktree add` returning and the owning pid being written down, and
 *  - between the row being written and the run row it points at existing at all —
 *    `PipelineService.start()` takes a worktree per repo and only then inserts the run.
 *
 * The second gap is as long as `git worktree add` takes for every remaining repo in the
 * project, which on a large repo or a slow disk is not seconds. Five minutes, not one: the cost
 * of being late is that a genuinely dead worktree survives until the next prune, which is
 * recoverable; the cost of being early is `git worktree remove` on a directory a run is about
 * to write into, which is not.
 */
export const ORPHAN_GRACE_MS = 300_000;

/** Whether a row is still young enough that missing bookkeeping around it means nothing yet. */
function withinGrace(worktree: Worktree, now: Date): boolean {
  return now.getTime() - Date.parse(worktree.createdAt) <= ORPHAN_GRACE_MS;
}

/**
 * What a worktree actually is right now, as `pomni doctor` reports it.
 *
 * The run's own `status` cannot be trusted alone: a process that dies without calling
 * `cancel()` leaves the row at `running` forever, so a live pid is the second opinion. A
 * `kept` worktree is never an orphan — reaping it would delete the uncommitted work this
 * whole feature exists to protect.
 *
 * A missing run row is not evidence on its own. `PipelineService.start()` writes a worktree row
 * per repo and inserts the run only afterwards, so a run row that has not appeared YET and a run
 * row that will never appear again are indistinguishable at this point — both are simply `null`.
 * The grace window is what separates them: inside it the row is younger than the bookkeeping
 * around it, so its absence is not trusted; outside it, nothing is coming.
 *
 * Every fork here is deliberately biased the same way — under-report an orphan rather than
 * over-report one. A stale directory left behind is reaped by the next prune; a live one removed
 * takes a run's work with it.
 */
export function worktreeState(
  worktree: Worktree,
  run: PipelineRun | null,
  probe: { dirExists: boolean; ownerAlive: boolean },
  now: Date,
): WorktreeState {
  if (!probe.dirExists) return 'missing';
  if (worktree.status === 'kept') return 'kept';
  if (!run) return withinGrace(worktree, now) ? 'live' : 'orphaned';
  if (run.status !== 'running') return 'orphaned';
  if (worktree.ownerPid === null) {
    return withinGrace(worktree, now) ? 'live' : 'orphaned';
  }
  return probe.ownerAlive ? 'live' : 'orphaned';
}

export function isOrphan(state: WorktreeState): boolean {
  return state === 'orphaned';
}
