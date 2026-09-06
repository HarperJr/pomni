import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { layout } from '../domain/layout.js';
import { RepoSchema, type Repo, type ResolvedRepo } from '../domain/repo.js';
import { ulid } from '../domain/ulid.js';
import {
  assertPomniOwned,
  isPomniOwned,
  isRunBranch,
  isolatesRuns,
  runBranch,
  worktreeEligibility,
  worktreeState,
  type Worktree,
  type WorktreeFilter,
  type WorktreeProbe,
  type WorktreeState,
} from '../domain/worktree.js';
import type {
  Clock,
  DocStore,
  EventBus,
  Executor,
  FsProbe,
  GitPort,
  Logger,
  PipelineStore,
  WorktreeRef,
  WorktreeStore,
} from '../ports/index.js';

/** One repo's directory for this run: the worktree when it got one, its own directory otherwise. */
export interface TakenWorktrees {
  /** Keyed by repo id. Every repo passed in appears here — a fallback maps to its own dir. */
  dirs: Record<string, string>;
  /** Repos that are sharing their directory with everyone else, and why. */
  fallbacks: Array<{ repoId: string; name: string; reason: string }>;
}

export interface WorktreeInspection {
  worktree: Worktree;
  state: WorktreeState;
  detail: string;
}

export interface PruneReport {
  removed: Array<{ id: string; path: string }>;
  kept: Array<{ id: string; path: string; reason: string }>;
  failed: Array<{ id: string; path: string; error: string }>;
}

/**
 * Gives each pipeline run its own checkout of each repo.
 *
 * Two rules shape everything here. A worktree is never allowed to fail a run: a repo that
 * cannot give one falls back to its own directory and says so, because a degraded run is
 * worth more than no run. And a worktree is never removed while it holds uncommitted work:
 * `GitPort.removeWorktree` does not force, so git refusing on a dirty tree is the mechanism
 * that keeps the work rather than an obstacle to route around.
 */
export class WorktreeService {
  constructor(
    private readonly docs: DocStore,
    private readonly store: WorktreeStore,
    private readonly pipelines: PipelineStore,
    private readonly git: GitPort,
    private readonly fs: FsProbe,
    private readonly executor: Executor,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  /** The one directory Pomni creates worktrees in, and therefore the only one it may delete in. */
  get root(): string {
    return this.docs.absolute(layout.worktreesDir);
  }

  /**
   * Cut a worktree per repo for a run.
   *
   * Never throws for a repo that cannot be isolated — the caller gets a directory for every
   * repo it passed in, plus the sentences explaining which of them are shared.
   */
  async take(
    projectId: string,
    runId: string,
    repos: ResolvedRepo[],
    options: { pid?: number } = {},
  ): Promise<TakenWorktrees> {
    const dirs: Record<string, string> = {};
    const fallbacks: TakenWorktrees['fallbacks'] = [];
    if (repos.length === 0) return { dirs, fallbacks };

    // Asked once for the whole call: it is a property of the git on this machine, not of a repo.
    const gitSupportsWorktrees = await this.git.supportsWorktrees().catch(() => false);
    const branch = runBranch(runId);

    for (const repo of repos) {
      const probe = await this.probe(repo, gitSupportsWorktrees);
      const eligibility = worktreeEligibility(repo, probe);

      if (!eligibility.eligible) {
        dirs[repo.id] = repo.workingDir;
        fallbacks.push({ repoId: repo.id, name: repo.name, reason: eligibility.reason });
        continue;
      }

      const path = this.docs.absolute(layout.worktree(projectId, repo.id, runId));

      try {
        // `git worktree add` makes the leaf; the repo slot above it is ours to create.
        await this.docs.ensureDir(layout.worktreeRepo(projectId, repo.id));
        const { head } = await this.git.addWorktree(repo.workingDir, {
          path,
          branch,
          baseRef: eligibility.baseRef,
        });

        const worktree: Worktree = {
          id: ulid(this.clock.now().getTime()),
          projectId,
          repoId: repo.id,
          runId,
          path,
          branch,
          baseBranch: eligibility.baseBranch,
          baseCommit: head,
          ownerPid: options.pid ?? null,
          status: 'active',
          keptReason: null,
          createdAt: this.clock.iso(),
          endedAt: null,
        };

        await this.store.insert(worktree);
        this.events.emit({
          type: 'worktree.taken',
          projectId,
          repoId: repo.id,
          runId,
          path,
        });
        dirs[repo.id] = path;
      } catch (error) {
        // The branch already exists, the disk is full, the filesystem cannot do links, the
        // repo is itself somebody's worktree. All of it is a shared directory, not a dead run.
        const reason = `'${repo.name}': could not create a worktree (${firstLine(error)}) — the run is working in the repo directory`;
        this.logger.warn(reason);
        dirs[repo.id] = repo.workingDir;
        fallbacks.push({ repoId: repo.id, name: repo.name, reason });
      }
    }

    return { dirs, fallbacks };
  }

  /**
   * Give back every worktree a run holds.
   *
   * A per-repo failure is reported, never thrown: a run that has otherwise finished should not
   * end as failed because one directory would not come away.
   */
  async release(
    runId: string,
  ): Promise<Array<{ repoId: string; path: string; kept: boolean; reason: string | null }>> {
    const rows = await this.store.list({ runId, status: 'active' });
    const released: Array<{ repoId: string; path: string; kept: boolean; reason: string | null }> =
      [];

    for (const worktree of rows) {
      released.push(await this.releaseOne(worktree));
    }
    return released;
  }

  async list(filter: WorktreeFilter): Promise<Worktree[]> {
    return this.store.list(filter);
  }

  /**
   * Which of these repos can hand each concurrent run its own checkout.
   *
   * The read-only half of {@link take}, for callers that have to know before they launch
   * anything whether two runs on one repo would be sharing a directory. Never throws: a repo
   * whose probe fails answers `false`, which is the reading that costs a lost opportunity to
   * parallelise rather than two runs writing over each other.
   */
  async isolation(repos: Repo[]): Promise<Record<string, boolean>> {
    const answers: Record<string, boolean> = {};
    if (repos.length === 0) return answers;

    // Asked once for the whole call, as in `take`: a property of the git on this machine.
    const gitSupportsWorktrees = await this.git.supportsWorktrees().catch(() => false);

    for (const repo of repos) {
      try {
        const probe = await this.probe(await this.resolve(repo), gitSupportsWorktrees);
        answers[repo.id] = isolatesRuns(repo, probe);
      } catch {
        answers[repo.id] = false;
      }
    }
    return answers;
  }

  /** Every worktree with what it actually is right now — what `pomni doctor` reports. */
  async inspect(filter: WorktreeFilter = {}): Promise<WorktreeInspection[]> {
    const rows = await this.store.list(filter);
    const inspections: WorktreeInspection[] = [];

    for (const worktree of rows) {
      const state = await this.stateOf(worktree);
      inspections.push({ worktree, state, detail: describe(worktree, state) });
    }
    return inspections;
  }

  /**
   * Reap what is left over. Orphans go; `kept` worktrees never do — reaping one deletes the
   * uncommitted work this whole feature exists to protect, so they are reported instead.
   */
  async prune(filter: WorktreeFilter = {}): Promise<PruneReport> {
    const report: PruneReport = { removed: [], kept: [], failed: [] };

    for (const { worktree, state, detail } of await this.inspect(filter)) {
      if (state === 'live') continue;

      if (state === 'kept') {
        report.kept.push({
          id: worktree.id,
          path: worktree.path,
          reason: worktree.keptReason ?? detail,
        });
        continue;
      }

      try {
        const repoDir = await this.repoDir(worktree);

        if (state === 'missing') {
          // The directory is already gone. Removing it behind git's back is what leaves the
          // admin entry that makes the user's next `git worktree add` at this name fail, so
          // the fix is git's own prune — never an fs delete.
          const leftover = repoDir ? await this.clearStaleEntry(worktree, repoDir) : null;
          await this.store.delete(worktree.id);
          if (leftover) {
            report.failed.push({ id: worktree.id, path: worktree.path, error: leftover });
          } else {
            report.removed.push({ id: worktree.id, path: worktree.path });
          }
          this.announceRelease(worktree, false, null);
          continue;
        }

        if (!repoDir) {
          report.failed.push({
            id: worktree.id,
            path: worktree.path,
            error: `the repo '${worktree.repoId}' this worktree came from is gone, so there is no repository to remove it from — remove '${worktree.path}' yourself`,
          });
          continue;
        }

        assertPomniOwned(worktree.path, this.root);
        await this.git.removeWorktree(repoDir, worktree.path, { deleteBranch: worktree.branch });
        await this.store.delete(worktree.id);
        report.removed.push({ id: worktree.id, path: worktree.path });
        this.announceRelease(worktree, false, null);
      } catch (error) {
        report.failed.push({ id: worktree.id, path: worktree.path, error: firstLine(error) });
      }
    }

    return report;
  }

  /**
   * Remove one worktree by id.
   *
   * `force` overrides Pomni's own refusal to touch a live or kept worktree — it does not make
   * git force anything. `removeWorktree` still declines a dirty tree, which is the last line
   * of defence for uncommitted work.
   */
  async removeOne(id: string, options: { force: boolean }): Promise<void> {
    const worktree = await this.store.get(id);
    if (!worktree) throw new NotFoundError('worktree', id);

    const state = await this.stateOf(worktree);

    if (!options.force) {
      if (state === 'kept') {
        throw new ConflictError(
          `'${worktree.path}' was kept because run ${worktree.runId} left uncommitted changes in it` +
            `${worktree.keptReason ? ` (${worktree.keptReason})` : ''} — commit or copy them out first, then remove it with --force`,
        );
      }
      if (state === 'live') {
        throw new ConflictError(
          `'${worktree.path}' is in use by run ${worktree.runId} — stop that run first, or remove it with --force`,
        );
      }
    }

    assertPomniOwned(worktree.path, this.root);
    const repoDir = await this.repoDir(worktree);

    if (state === 'missing') {
      const leftover = repoDir ? await this.clearStaleEntry(worktree, repoDir) : null;
      // The row is this command's subject and it is gone either way; git's own entry is a
      // separate object, and one Pomni may not have been able to touch.
      if (leftover) this.logger.warn(leftover);
      await this.store.delete(id);
      this.announceRelease(worktree, false, null);
      return;
    }

    if (!repoDir) {
      throw new ValidationError(
        `the repo '${worktree.repoId}' this worktree came from is gone, so there is no repository to remove it from — remove '${worktree.path}' yourself`,
      );
    }

    await this.git.removeWorktree(repoDir, worktree.path, { deleteBranch: worktree.branch });
    await this.store.delete(id);
    this.announceRelease(worktree, false, null);
  }

  // -------------------------------------------------------------------------

  private async releaseOne(
    worktree: Worktree,
  ): Promise<{ repoId: string; path: string; kept: boolean; reason: string | null }> {
    try {
      assertPomniOwned(worktree.path, this.root);
    } catch (error) {
      return this.keep(worktree, firstLine(error));
    }

    const repoDir = await this.repoDir(worktree);
    if (!repoDir) {
      // Guessing which repository owns a directory is how a run ends up removing somebody
      // else's. Leave the row `active`, so doctor and prune can decide with more evidence.
      const reason = `the repo '${worktree.repoId}' is gone, so '${worktree.path}' could not be removed — 'pomni worktree prune' will report it`;
      this.logger.warn(reason);
      this.announceRelease(worktree, true, reason);
      return { repoId: worktree.repoId, path: worktree.path, kept: true, reason };
    }

    try {
      await this.git.removeWorktree(repoDir, worktree.path, { deleteBranch: worktree.branch });
      // A record exists if and only if a directory exists — deleted in the same step.
      await this.store.delete(worktree.id);
      this.announceRelease(worktree, false, null);
      return { repoId: worktree.repoId, path: worktree.path, kept: false, reason: null };
    } catch (error) {
      return this.keep(worktree, firstLine(error));
    }
  }

  /** The designed path: git would not remove it, so the work stays and the row says why. */
  private async keep(
    worktree: Worktree,
    gitSaid: string,
  ): Promise<{ repoId: string; path: string; kept: boolean; reason: string | null }> {
    const changes = await this.git.changes(worktree.path).catch(() => []);
    const named = changes
      .slice(0, 3)
      .map((change) => change.path)
      .join(', ');

    const reason =
      changes.length > 0
        ? `${changes.length} uncommitted change${changes.length === 1 ? '' : 's'} on branch ${worktree.branch}${
            named ? ` (${named}${changes.length > 3 ? ', …' : ''})` : ''
          }`
        : `git would not remove it: ${gitSaid}`;

    try {
      await this.store.update(worktree.id, {
        ...worktree,
        status: 'kept',
        keptReason: reason,
        endedAt: this.clock.iso(),
      });
    } catch (error) {
      this.logger.warn(`could not mark ${worktree.path} as kept: ${firstLine(error)}`);
    }

    this.logger.info(`kept ${worktree.path}: ${reason}`);
    this.announceRelease(worktree, true, reason);
    return { repoId: worktree.repoId, path: worktree.path, kept: true, reason };
  }

  /**
   * Clear git's admin entry for a worktree whose directory has gone — Pomni's, and only ever
   * Pomni's. Returns a sentence for the person when the entry had to be left, null otherwise.
   *
   * `git worktree prune` is a property of the *repository*, not of a path: run in a repo the
   * user linked it deregisters every worktree of theirs whose directory is not present right
   * now, which includes the one on the external drive they have not plugged in today. The
   * directory survives, so rule 4's letter holds — but their branch lock does not, and that is
   * the same kind of loss. `assertPomniOwned` cannot catch this, because what needs scoping is
   * the repository the command runs in and not the path being removed.
   *
   * `GitPort` has no way to drop one entry, so the blanket prune is used only when every entry
   * git would drop is one of ours. Otherwise nothing is run and the user is told which entry to
   * clear by hand, once they have looked at it.
   */
  private async clearStaleEntry(worktree: Worktree, repoDir: string): Promise<string | null> {
    if (!isPomniOwned(worktree.path, this.root)) {
      return `'${worktree.path}' is not inside '${this.root}', so Pomni did not touch git's record of it — remove it yourself if it is stale`;
    }

    let entries: WorktreeRef[];
    try {
      entries = await this.git.listWorktrees(repoDir);
    } catch (error) {
      return `git could not list the worktrees of '${repoDir}' (${firstLine(error)}), so the stale entry for '${worktree.path}' was left — clear it with 'git -C ${repoDir} worktree prune' once you have checked no worktree of your own is missing`;
    }

    const prunable = entries.filter((entry) => entry.prunable);
    if (prunable.length === 0) return null;

    const theirs = prunable.filter((entry) => !this.isOurs(entry));
    if (theirs.length > 0) {
      return `git's entry for '${worktree.path}' was left in place: '${repoDir}' also has a stale entry for '${theirs
        .map((entry) => entry.path)
        .join("', '")}', which Pomni did not create, and 'git worktree prune' would clear that too. Check whether that directory is only unmounted, then run 'git -C ${repoDir} worktree prune' yourself`;
    }

    try {
      await this.git.pruneWorktrees(repoDir);
      return null;
    } catch (error) {
      return `git could not prune '${repoDir}' (${firstLine(error)}), so the stale entry for '${worktree.path}' is still there`;
    }
  }

  /** Whether an entry git reports is one of ours — by where it is, or by what it is on. */
  private isOurs(entry: WorktreeRef): boolean {
    return (
      isPomniOwned(entry.path, this.root) || (entry.branch !== null && isRunBranch(entry.branch))
    );
  }

  private announceRelease(worktree: Worktree, kept: boolean, reason: string | null): void {
    this.events.emit({
      type: 'worktree.released',
      projectId: worktree.projectId,
      repoId: worktree.repoId,
      runId: worktree.runId,
      path: worktree.path,
      kept,
      reason,
    });
  }

  /** A stored repo with the directory it resolves to, via the same arms as `repoDir`. */
  private async resolve(repo: Repo): Promise<ResolvedRepo> {
    const workingDir = await this.repoDir({ projectId: repo.projectId, repoId: repo.id });
    if (!workingDir) return { ...repo, workingDir: '', workingDirExists: false };
    return {
      ...repo,
      workingDir,
      workingDirExists: await this.fs.isDirectory(workingDir).catch(() => false),
    };
  }

  private async probe(repo: ResolvedRepo, gitSupportsWorktrees: boolean): Promise<WorktreeProbe> {
    if (!repo.workingDirExists) {
      return {
        workingDirExists: false,
        isGitRepo: false,
        gitSupportsWorktrees,
        currentBranch: null,
        head: null,
      };
    }

    const isGitRepo = await this.git.isRepo(repo.workingDir).catch(() => false);
    const info = isGitRepo ? await this.git.info(repo.workingDir).catch(() => null) : null;

    return {
      workingDirExists: true,
      isGitRepo,
      gitSupportsWorktrees,
      currentBranch: info?.currentBranch ?? null,
      head: info?.head ?? null,
    };
  }

  private async stateOf(worktree: Worktree): Promise<WorktreeState> {
    const dirExists = await this.fs.isDirectory(worktree.path).catch(() => false);
    const ownerAlive =
      worktree.ownerPid === null
        ? false
        : await this.executor.isAlive(worktree.ownerPid).catch(() => false);
    // A run whose row has been deleted is not an error here — it is the orphan case itself.
    const run = await this.pipelines.getRun(worktree.runId).catch(() => null);

    return worktreeState(worktree, run, { dirExists, ownerAlive }, this.clock.now());
  }

  /**
   * The repository a worktree was cut from.
   *
   * This repeats `WorkspaceService.workingDir` rather than calling it: the constructor is
   * fixed by the composition root and does not hand this service a `RepoService`. The two
   * arms are the only place either file branches on `source.kind`.
   */
  private async repoDir(worktree: Pick<Worktree, 'projectId' | 'repoId'>): Promise<string | null> {
    const ref = await this.docs
      .read(layout.repo(worktree.projectId, worktree.repoId), RepoSchema)
      .catch(() => null);
    if (!ref) return null;

    const { source } = ref.data;
    return source.kind === 'local'
      ? this.fs.resolve(source.path)
      : this.docs.absolute(layout.workspaceRepo(worktree.projectId, worktree.repoId));
  }
}

/** One sentence a person reads in `pomni doctor`. */
function describe(worktree: Worktree, state: WorktreeState): string {
  switch (state) {
    case 'live':
      return `${worktree.path} is in use by run ${worktree.runId} on branch ${worktree.branch}.`;
    case 'kept':
      return `${worktree.path} was kept after run ${worktree.runId} because ${
        worktree.keptReason ?? 'it had uncommitted changes'
      }.`;
    case 'orphaned':
      return `${worktree.path} was left behind by run ${worktree.runId}, whose process is gone — remove it with 'pomni worktree prune'.`;
    case 'missing':
      return `${worktree.path} is gone but its record survives (run ${worktree.runId}) — 'pomni worktree prune' clears it and git's stale entry.`;
  }
}

/** git's own first line is what a person needs; the rest of a git failure is noise. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.trim() || message;
}
