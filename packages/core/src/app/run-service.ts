import { ValidationError } from '../domain/errors.js';
import { NotFoundError } from '../domain/errors.js';
import { layout } from '../domain/layout.js';
import type { Repo, ResolvedRepo } from '../domain/repo.js';
import {
  RunSchema,
  isTerminal,
  statusFromExit,
  type GateReport,
  type GateResult,
  type Run,
  type RunFilter,
  type TestResult,
} from '../domain/run.js';
import { ulid } from '../domain/ulid.js';
import type {
  Clock,
  DocStore,
  EventBus,
  Executor,
  Logger,
  RunStore,
} from '../ports/index.js';
import type { ProjectService } from './project-service.js';
import type { RepoService } from './repo-service.js';

export interface RunOptions {
  /** Restrict to one repo. Otherwise every repo declaring the capability runs. */
  repoId?: string;
  itemId?: string;
  /** Stop after the first failure instead of running every repo. */
  bail?: boolean;
  /**
   * Where this run's copy of each repo actually is, by repo id; defaults to the repo's own
   * working directory. A pipeline run passes its worktrees here so that a passing gate means
   * *this* run's code passes, rather than whatever was in the shared directory at the time.
   */
  dirOverrides?: Record<string, string>;
  onOutput?: (runId: string, chunk: string) => void;
  onRunStart?: (run: Run) => void;
  onRunFinish?: (run: Run) => void;
}

/** Log sinks are injected so the service stays free of `fs`. */
export interface LogSink {
  open(runId: string, absPath: string): Promise<void>;
  write(runId: string, chunk: string): void;
  close(runId: string): Promise<void>;
}

/** Turns raw output into the one-line summary and, when configured, test rows. */
export interface OutputAnalyzer {
  summarize(capability: string, cmd: string, output: string, exitCode: number | null): string | null;
  testResults(
    capability: string,
    cwd: string,
    reportPath: string | undefined,
  ): Promise<TestResult[]>;
}

/**
 * Executes a repo's own declared commands and records what happened.
 *
 * Nothing here knows what a "test" is: it runs the capability the repo declared, records the
 * exit code, and lets a summarizer turn the output into a readable line. That is what makes
 * a gate meaningful across a Node repo and a Python one at the same time.
 */
export class RunService {
  /** pid by run id, for cancelling a run started in this process. */
  private readonly live = new Map<string, number>();

  constructor(
    private readonly docs: DocStore,
    private readonly store: RunStore,
    private readonly projects: ProjectService,
    private readonly repos: RepoService,
    private readonly executor: Executor,
    private readonly logs: LogSink,
    private readonly analyzer: OutputAnalyzer,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  /**
   * Run one capability across a project. Returns one Run per repo that declared it.
   * Sequential: interleaved output from four repos at once is unreadable, and the common
   * case is a handful of repos.
   */
  async run(projectId: string, capability: string, options: RunOptions = {}): Promise<Run[]> {
    await this.projects.getRef(projectId);
    const targets = await this.targets(projectId, capability, options.repoId);

    if (targets.length === 0) {
      throw new ValidationError(
        options.repoId
          ? `repo '${options.repoId}' does not declare a '${capability}' capability`
          : `no repo in '${projectId}' declares a '${capability}' capability`,
      );
    }

    const runs: Run[] = [];
    for (const repo of targets) {
      const run = await this.runOne(repo, capability, options);
      runs.push(run);
      if (options.bail && run.status !== 'passed') break;
    }
    return runs;
  }

  /** Execute one capability on one repo, start to finish. */
  async runOne(repo: ResolvedRepo, capability: string, options: RunOptions = {}): Promise<Run> {
    const definition = repo.capabilities[capability];
    if (!definition) {
      throw new ValidationError(`repo '${repo.id}' does not declare '${capability}'`);
    }
    // An override is this run's own checkout, made moments ago by git; whether the repo's
    // original directory exists is a different question and not the one that matters here.
    // The service has no FsProbe to stat the override with, so the executor's own failure is
    // what reports a directory that has since gone.
    const base = options.dirOverrides?.[repo.id] ?? repo.workingDir;
    if (!options.dirOverrides?.[repo.id] && !repo.workingDirExists) {
      throw new ValidationError(
        `working directory for '${repo.projectId}/${repo.id}' is missing: ${repo.workingDir}`,
      );
    }
    if (definition.background) {
      throw new ValidationError(
        `'${capability}' is a background capability (a dev server) — those are not run this way yet`,
      );
    }

    const id = ulid(this.clock.now().getTime());
    const cwd = definition.cwd ? joinPath(base, definition.cwd) : base;
    const logPath = this.docs.absolute(`${layout.runDir(id)}/output.log`);
    const startedAt = this.clock.iso();

    let run: Run = RunSchema.parse({
      id,
      projectId: repo.projectId,
      repoId: repo.id,
      itemId: options.itemId ?? null,
      capability,
      cmd: definition.cmd,
      cwd,
      status: 'running',
      startedAt,
      logPath,
    });

    await this.docs.ensureDir(layout.runDir(id));
    await this.store.insert(run);
    await this.logs.open(id, logPath);

    this.events.emit({
      type: 'run.started',
      projectId: repo.projectId,
      repoId: repo.id,
      runId: id,
      capability,
    });
    options.onRunStart?.(run);

    // Kept in memory only for the summary; the log file is the durable copy.
    let captured = '';
    const startedMs = Date.now();

    const timeoutMs = definition.timeoutMs ?? 10 * 60 * 1000;

    try {
      const result = await this.executor.run({
        cmd: definition.cmd,
        cwd,
        env: definition.env,
        timeoutMs,
        onStart: (pid) => {
          this.live.set(id, pid);
          void this.store.update(id, { pid });
        },
        onOutput: (chunk) => {
          if (captured.length < 512 * 1024) captured += chunk;
          this.logs.write(id, chunk);
          options.onOutput?.(id, chunk);
          this.events.emit({
            type: 'run.output',
            projectId: repo.projectId,
            runId: id,
            chunk,
          });
        },
      });

      const status = statusFromExit(result.exitCode, result.timedOut, result.cancelled);
      const parsed = this.analyzer.summarize(capability, definition.cmd, captured, result.exitCode);
      // A killed run's counts are not a verdict. On 2026-09-13 a suite that finished its
      // tests at 545s was killed at 600s during teardown, and "4 failed, 851 passed" was
      // recorded as if the tests had been the problem — the four had themselves died on a
      // 30s test timeout on a machine that was twenty times slower than usual. The kill is
      // the headline; whatever the parser saw goes after it, marked as what it is.
      const summary = result.timedOut
        ? `timed out after ${formatSeconds(timeoutMs)}${parsed ? ` — ${parsed} before the kill` : ''}`
        : result.cancelled
          ? `cancelled${parsed ? ` — ${parsed} before the stop` : ''}`
          : parsed;

      run = {
        ...run,
        status,
        exitCode: result.exitCode,
        pid: null,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedMs,
        summary,
      };

      if (definition.parser === 'junit') {
        const results = await this.analyzer.testResults(capability, cwd, definition.reportPath);
        if (results.length > 0) await this.store.putTestResults(id, results);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logs.write(id, `\n[pomni] ${message}\n`);
      run = {
        ...run,
        status: 'failed',
        exitCode: null,
        pid: null,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedMs,
        summary: message,
      };
      this.logger.debug(`run ${id} failed to execute`, message);
    } finally {
      this.live.delete(id);
      await this.logs.close(id);
    }

    await this.store.update(run.id, run);
    this.events.emit({
      type: 'run.finished',
      projectId: run.projectId,
      repoId: run.repoId,
      runId: run.id,
      capability: run.capability,
      status: run.status,
      summary: run.summary,
    });
    options.onRunFinish?.(run);

    return run;
  }

  /**
   * Evaluate a named gate: every capability in order, across every repo that declares it.
   * Stops at the first failing capability — a red typecheck makes the test result moot.
   */
  async gate(projectId: string, gateName: 'default' | 'land', options: RunOptions = {}): Promise<GateReport> {
    const project = (await this.projects.getRef(projectId)).data;
    const capabilities = project.gates[gateName];

    const results: GateResult[] = [];
    let passed = true;

    for (const capability of capabilities) {
      const targets = await this.targets(projectId, capability, options.repoId);
      if (targets.length === 0) {
        results.push({ capability, status: 'skipped', runs: [] });
        continue;
      }

      const runs = await this.run(projectId, capability, { ...options, bail: true });
      const ok = runs.every((run) => run.status === 'passed');
      results.push({ capability, status: ok ? 'passed' : 'failed', runs });

      if (!ok) {
        passed = false;
        break;
      }
    }

    return { projectId, gate: gateName, passed, results };
  }

  async list(filter: RunFilter): Promise<Run[]> {
    return this.store.list(filter);
  }

  async get(id: string): Promise<Run> {
    const run = await this.store.get(id);
    if (!run) throw new NotFoundError('run', id);
    return run;
  }

  async testResults(id: string): Promise<TestResult[]> {
    return this.store.testResults(id);
  }

  /**
   * Cancel by pid, so a run started by the CLI can be stopped from the browser and vice
   * versa. The pid is recorded on the run precisely so this works across processes.
   */
  async cancel(id: string): Promise<Run> {
    const run = await this.get(id);
    if (isTerminal(run.status)) return run;

    const pid = this.live.get(id) ?? run.pid;
    if (pid) await this.executor.kill(pid);

    const cancelled: Run = {
      ...run,
      status: 'cancelled',
      pid: null,
      endedAt: this.clock.iso(),
      durationMs: Date.now() - new Date(run.startedAt).getTime(),
      summary: run.summary ?? 'cancelled',
    };
    await this.store.update(id, cancelled);
    this.events.emit({
      type: 'run.finished',
      projectId: run.projectId,
      repoId: run.repoId,
      runId: run.id,
      capability: run.capability,
      status: 'cancelled',
      summary: cancelled.summary,
    });
    return cancelled;
  }

  /**
   * Whether a pid written down by some Pomni process is still a live process.
   *
   * It lives here because this is the service that owns process identity — it records the pid
   * on a run and kills by it in `cancel`. Callers that hold a `RunService` therefore do not
   * need an `Executor` of their own to tell a run in progress from a row left behind by a
   * session that died.
   */
  async isProcessAlive(pid: number): Promise<boolean> {
    return this.executor.isAlive(pid).catch(() => false);
  }

  /** Repos in this project that declare the capability, optionally narrowed to one. */
  private async targets(
    projectId: string,
    capability: string,
    repoId?: string,
  ): Promise<ResolvedRepo[]> {
    const repos = await this.repos.listResolved(projectId);
    return repos.filter(
      (repo) =>
        Boolean(repo.capabilities[capability]) &&
        !repo.capabilities[capability]?.background &&
        (repoId ? repo.id === repoId : true),
    );
  }
}

export function capabilitiesOf(repos: Array<Pick<Repo, 'capabilities'>>): string[] {
  const names = new Set<string>();
  for (const repo of repos) {
    for (const name of Object.keys(repo.capabilities)) names.add(name);
  }
  return [...names].sort();
}

/** Join without importing `node:path` into the domain-facing layer. */
function joinPath(base: string, relative: string): string {
  const separator = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${relative.replace(/^[\\/]+/, '')}`;
}

/** `600000` -> `600s`; a ceiling is read as seconds, the way it was configured. */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}
