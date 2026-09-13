import type { LogEntry, LogFilter } from '../domain/log.js';
import type {
  Clock,
  EventBus,
  GitPort,
  Logger,
  RestartPort,
  ServerLogStore,
} from '../ports/index.js';
import type { BuildOutcome, Supervision } from '../ports/restart.js';
import type { PipelineService } from './pipeline-service.js';
import type { RunService } from './run-service.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * How long `replace` waits before exiting, so the response that announced the restart
 * reaches the browser before the socket does.
 */
const RESTART_GRACE_MS = 500;

/** Enough rows to find every genuinely live run; nothing here pages. */
const IN_FLIGHT_LIMIT = 200;

/** What the running server is, as opposed to what bundle it is serving. */
export interface ServerIdentity {
  /**
   * The commit this process was launched at, read once at boot. Null when Pomni is not
   * running from a git checkout — an install from a tarball has no HEAD to be behind.
   */
  startedAtCommit: string | null;
  /** The checkout's HEAD right now. Moves when someone merges; `startedAtCommit` does not. */
  headCommit: string | null;
  /**
   * True only when both commits are known and differ. An unknown commit is not evidence of
   * staleness, and a footer that cried "restart me" at every tarball install would teach
   * people to ignore it — which is the failure this change is trying to undo.
   */
  behindRepo: boolean;
  /** When this process started serving. */
  startedAt: string;
  supervision: Supervision;
}

/**
 * What `/api/health` answers.
 *
 * The two staleness questions are separate fields on purpose. "Your tab is behind the
 * server" is `build` against the asset hash the browser loaded; "the server is behind the
 * repo" is `server.behindRepo`. Neither needs the caller to compare strings it had to
 * assemble itself.
 */
export interface SystemHealth {
  ok: true;
  /** The hashed asset name of the bundle on disk, as health has always reported it. */
  build: string | null;
  root: string;
  git: boolean;
  initialized: boolean;
  server: ServerIdentity;
}

/**
 * A run a restart would kill, named the way a person recognises it rather than by id alone.
 */
export interface InFlightRun {
  kind: 'pipeline' | 'capability';
  id: string;
  projectId: string;
  /** The backlog item it is working on, when it was started from one. */
  itemId: string | null;
  /** What it is doing: a pipeline's task, or a capability and the repo it is running in. */
  what: string;
  startedAt: string;
}

export interface RestartInput {
  /**
   * Cancel the in-flight runs instead of refusing. Only ever set by a person who was shown
   * the list and chose — which is why the refusal carries the runs rather than a count.
   */
  cancelInFlight?: boolean;
}

/**
 * Every way a restart ends, discriminated so a surface can render each one without reading
 * a message. `restarting` is the only arm where this process is going away.
 */
export type RestartResult =
  | { outcome: 'unsupported'; supervision: Supervision }
  | { outcome: 'runs-in-flight'; runs: InFlightRun[] }
  | { outcome: 'build-failed'; build: BuildOutcome }
  | { outcome: 'restarting'; build: BuildOutcome; cancelled: InFlightRun[] };

/**
 * What the server can say and do about itself: which code it is running, and replacing that
 * code with the code that was merged.
 *
 * The whole point is that a reload which repaints the tab is not an update. Everything here
 * exists to make the difference visible — and, when it can, to close it.
 */
export class SystemService {
  private startedAtCommit: string | null = null;
  private startedAt: string;
  private booted = false;

  constructor(
    /**
     * The Pomni checkout this server is running from. Passed in rather than derived: core
     * has no `import.meta.url` and no way to walk up from `.pomni`, and the composition root
     * is the only place that knows where the code it just loaded came from.
     */
    private readonly selfRepoDir: string,
    private readonly restart: RestartPort,
    private readonly pipelines: PipelineService,
    private readonly runs: RunService,
    private readonly workspace: WorkspaceService,
    private readonly git: GitPort,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
    /** Pomni's own log, so the interface can read what the services said. */
    private readonly serverLog: ServerLogStore,
  ) {
    this.startedAt = clock.iso();
  }

  /**
   * Read the commit this process is running, once, before it serves anything.
   *
   * Read at boot and never again: HEAD moves when someone merges, and that movement is
   * precisely the fact health has to report. Reading it lazily would mean the first person
   * to ask after a merge is told the server is current, which is the lie.
   */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    this.startedAt = this.clock.iso();
    this.startedAtCommit = await this.head();
  }

  /**
   * `build` is passed in because the served bundle is read off disk by the HTTP layer that
   * knows where `web/dist` sits relative to itself. Everything else about the answer is
   * this service's to know.
   */
  async health(input: { build: string | null }): Promise<SystemHealth> {
    const [headCommit, git, initialized, supervision] = await Promise.all([
      this.head(),
      this.git.isAvailable(),
      this.workspace.isInitialized(),
      this.restart.supervision(),
    ]);

    return {
      ok: true,
      build: input.build,
      root: this.workspace.root,
      git,
      initialized,
      server: {
        startedAtCommit: this.startedAtCommit,
        headCommit,
        behindRepo:
          this.startedAtCommit !== null &&
          headCommit !== null &&
          this.startedAtCommit !== headCommit,
        startedAt: this.startedAt,
        supervision,
      },
    };
  }

  /**
   * Rebuild, then replace this process — or say why not.
   *
   * The order is the contract. Supervision first, because refusing after a two-minute build
   * would have wasted the two minutes. Runs second, because a restart kills them mid-step
   * and leaves a worktree owned by a pid that no longer exists. Build third, and a failing
   * one ends here with its output — a Pomni that will not come back is worse than one that
   * is out of date. Only then is the process replaced.
   */
  /**
   * What Pomni has been saying about itself.
   *
   * On `SystemService` because it answers the same question `/api/health` does — what is this
   * server doing — and a person who reaches for one usually wants the other next.
   */
  async log(filter: LogFilter = {}): Promise<LogEntry[]> {
    return this.serverLog.read(filter);
  }

  async restartServer(input: RestartInput = {}): Promise<RestartResult> {
    const supervision = await this.restart.supervision();
    if (supervision.mode === 'unsupported') {
      return { outcome: 'unsupported', supervision };
    }

    const inFlight = await this.inFlightRuns();
    if (inFlight.length > 0 && !input.cancelInFlight) {
      return { outcome: 'runs-in-flight', runs: inFlight };
    }

    for (const run of inFlight) {
      if (run.kind === 'pipeline') await this.pipelines.cancel(run.id);
      else await this.runs.cancel(run.id);
    }

    const build = await this.restart.build();
    if (!build.ok) return { outcome: 'build-failed', build };

    this.events.emit({ type: 'system.restarting' });

    // Not awaited: on success `replace` never returns, and the caller still has a response
    // to send. The grace period is what gives that response time to leave.
    void this.restart.replace({ graceMs: RESTART_GRACE_MS }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`the replacement process could not be started: ${detail}`);
      // The browser was told to expect this process to disappear. It will not, so say so
      // rather than leave it polling a health endpoint that never went away.
      this.events.emit({ type: 'system.restart.failed', detail });
    });

    return { outcome: 'restarting', build, cancelled: inFlight };
  }

  /**
   * The runs a restart would interrupt.
   *
   * A row saying `running` is not proof: a process that died without cancelling leaves one
   * behind forever, and refusing to restart because of a run that ended yesterday is the
   * same unhelpfulness in the other direction. The pid on the row is the evidence that
   * crosses processes, which is how `PipelineService.cancel` already decides. A row with no
   * pid at all is counted as in flight — unproven is not the same as finished, and the
   * cautious answer here only ever costs a person one extra click.
   */
  async inFlightRuns(): Promise<InFlightRun[]> {
    const [pipelines, runs] = await Promise.all([
      this.pipelines.list({ status: 'running', limit: IN_FLIGHT_LIMIT }),
      this.runs.list({ status: 'running', limit: IN_FLIGHT_LIMIT }),
    ]);

    const live: InFlightRun[] = [];

    for (const run of pipelines) {
      if (!(await this.isLive(run.pid))) continue;
      live.push({
        kind: 'pipeline',
        id: run.id,
        projectId: run.projectId,
        itemId: run.itemId,
        what: run.task,
        startedAt: run.startedAt,
      });
    }

    for (const run of runs) {
      if (!(await this.isLive(run.pid))) continue;
      live.push({
        kind: 'capability',
        id: run.id,
        projectId: run.projectId,
        itemId: run.itemId,
        what: `${run.capability} in ${run.repoId}`,
        startedAt: run.startedAt,
      });
    }

    return live;
  }

  private async isLive(pid: number | null): Promise<boolean> {
    if (pid === null) return true;
    return this.runs.isProcessAlive(pid);
  }

  /** HEAD of the checkout this server runs from, or null when it is not one. */
  private async head(): Promise<string | null> {
    const info = await this.git.info(this.selfRepoDir).catch(() => null);
    return info?.head ?? null;
  }
}
