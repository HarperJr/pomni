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

/**
 * The shape every run branch used to have, and which many still do on disk.
 *
 * Kept because `isRunBranch` guards deletion: `removeWorktree` hands the branch to
 * `git branch -d`, and `prune` asks `isOurs` whether a stale entry is Pomni's to clear. A
 * predicate that stopped recognising the branches already cut would take away Pomni's right
 * to clean up after itself, so this prefix is understood forever even though nothing new
 * carries it.
 */
export const WORKTREE_BRANCH_PREFIX = 'pomni/run/';

/**
 * What each item type is called in a branch name.
 *
 * `bug → fix` is the one place the two vocabularies differ: a backlog talks about bugs, a
 * branch list talks about fixes, and every forge's automation is written against the second.
 * Everything else is its own name, so the map is a rename rather than a translation layer.
 */
export const BRANCH_PREFIX_BY_TYPE: Record<string, string> = {
  feature: 'feature',
  bug: 'fix',
  chore: 'chore',
  spike: 'spike',
  refactor: 'refactor',
  docs: 'docs',
  release: 'release',
};

/** Every prefix a Pomni branch may start with — what `isRunBranch` matches against. */
export const BRANCH_PREFIXES = [...new Set(Object.values(BRANCH_PREFIX_BY_TYPE))];

/**
 * The slot a first run on an item takes.
 *
 * The third segment exists so two runs on one item cannot land on one ref. That collision is
 * the reason the old naming reached for a ULID; answering it with a segment costs one word and
 * leaves the rest of the name readable.
 */
export const DEFAULT_BRANCH_SLOT = 'main';

/** An unknown type still has to produce a valid branch, and `chore` is the honest default. */
export function branchPrefixFor(type: string): string {
  return BRANCH_PREFIX_BY_TYPE[type] ?? 'chore';
}

/**
 * The branch a run's work lives on: `feature/POMN-1/main`.
 *
 * Three segments, each earning its place — the type sorts the branch list and is what forge
 * automation matches on, the item id is the link back to the spec, and the slot keeps two runs
 * on one item apart.
 */
export function itemBranch(
  type: string,
  itemId: string,
  slot: string = DEFAULT_BRANCH_SLOT,
): string {
  return `${branchPrefixFor(type)}/${itemId}/${sanitiseSlot(slot)}`;
}

/**
 * The branch for a run started without a backlog item.
 *
 * Still three segments, so nothing downstream has to special-case it. Run ids are ULIDs —
 * 26 characters of Crockford base32 — so the result is always a valid ref with no sanitising.
 */
export function runBranch(runId: string): string {
  return `chore/run-${runId}/${DEFAULT_BRANCH_SLOT}`;
}

/** The slot to fall back to when the readable one is taken. Unique, and still short. */
export function slotForRun(runId: string): string {
  return runId.slice(-8).toLowerCase();
}

/**
 * A git ref cannot hold every character a slot might be built from. Narrow rather than escape:
 * a slot is a label Pomni chooses, not user prose, so anything outside the safe set is a bug
 * upstream and collapsing it is better than producing a ref git will reject.
 */
function sanitiseSlot(slot: string): string {
  const safe = slot.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return safe.length > 0 ? safe : DEFAULT_BRANCH_SLOT;
}

const ITEM_BRANCH = new RegExp(
  `^(?:${BRANCH_PREFIXES.join('|')})/[A-Za-z][A-Za-z0-9_]*-\\d+/[A-Za-z0-9._-]+$`,
);
const RUN_ONLY_BRANCH = /^chore\/run-[0-9A-HJKMNP-TV-Z]{26}\/[A-Za-z0-9._-]+$/;

/**
 * Whether a branch is one Pomni cut.
 *
 * Deliberately strict about the whole shape rather than just the prefix. This predicate is
 * consulted before a branch is deleted and before a repository is pruned, so matching every
 * `feature/*` would hand Pomni authority over branches a person wrote by hand. All three
 * segments together are the signature; two of them are not.
 */
export function isRunBranch(branch: string): boolean {
  if (branch.startsWith(WORKTREE_BRANCH_PREFIX)) return true;
  return RUN_ONLY_BRANCH.test(branch) || ITEM_BRANCH.test(branch);
}

/** The run a branch belongs to, or null — including for a branch named after an item. */
export function runIdFromBranch(branch: string): string | null {
  if (branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
    const runId = branch.slice(WORKTREE_BRANCH_PREFIX.length);
    return runId.length > 0 ? runId : null;
  }
  const runOnly = /^chore\/run-([0-9A-HJKMNP-TV-Z]{26})\//.exec(branch);
  return runOnly?.[1] ?? null;
}

/** The item a branch delivers, or null when it is not an item branch. */
export function itemIdFromBranch(branch: string): string | null {
  if (!ITEM_BRANCH.test(branch)) return null;
  return branch.split('/')[1] ?? null;
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

/**
 * Join a repo-relative path onto a directory, and refuse if the result leaves it.
 *
 * Null rather than a throw, because "outside" is an answer a caller may have several of — a
 * project with three repos asks this three times and expects two nulls.
 *
 * The comparison is the same normalising one `isPomniOwned` uses, so `..` inside the relative
 * path is resolved before it is checked rather than after it is used. The path handed back is
 * the joined one in its original case: the check folds case because Windows does, and opening
 * a file needs the name the filesystem actually has.
 */
export function resolveInside(base: string, relative: string): string | null {
  if (!base || !relative) return null;

  // An absolute path is not a relative one, and joining it produces something that looks
  // contained and is not the file that was named: `C:/Windows/x` under a repo becomes
  // `<repo>/C:/Windows/x`, which passes every check below by accident. A drive letter, a
  // leading separator or a UNC prefix all mean the caller is not describing a repo-relative
  // path, and the honest answer to that is no rather than a reinterpretation of it.
  if (/^([a-z]:|[\\/])/i.test(relative)) return null;

  const joined = `${base.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`;
  const root = normalisePath(base);
  if (root === '') return null;

  return normalisePath(joined).startsWith(`${root}/`) ? joined : null;
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
