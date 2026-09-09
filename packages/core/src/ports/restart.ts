/**
 * Replacing the running Pomni with the code that was merged.
 *
 * Types only, like every other port: `child_process`, `process.execPath`, argv and the
 * Windows-versus-POSIX difference between spawning a successor and exec'ing over yourself
 * all live in @pomni/infra. Three things and no more — build, replace, and say whether
 * replacing is possible at all.
 */

/**
 * The two builds, in the order they must run: the workspace first, the web bundle second.
 *
 * Named here rather than in the adapter so the use case, the adapter and the tests that
 * assert a failing build left the old process alive are all talking about the same commands.
 */
export const RESTART_BUILD_COMMANDS: readonly string[] = ['npm run build', 'npm run build:web'];

/**
 * How this process can be replaced, if at all.
 *
 * - `supervised` — something outside restarts it when it exits, so replacing it means
 *   exiting cleanly and letting that something do its job.
 * - `self` — nothing supervises it, but it was launched in a way this process can reproduce,
 *   so it can start its successor and hand the port over before exiting.
 * - `unsupported` — a `serve` typed into a terminal, whose successor would have no terminal
 *   to live in. Saying so is the point: appearing to restart and not restarting is the one
 *   behaviour this whole change exists to remove.
 */
export type SupervisionMode = 'supervised' | 'self' | 'unsupported';

export interface Supervision {
  mode: SupervisionMode;
  /** One sentence a person reads. The mode alone does not tell them what to do instead. */
  detail: string;
}

/** One of the two builds, and what it printed. */
export interface BuildStepResult {
  /** The command as it was run — one of `RESTART_BUILD_COMMANDS`. */
  cmd: string;
  /** Null when the process never started or was killed by a signal. */
  exitCode: number | null;
  /** stdout and stderr interleaved in arrival order, the way `ExecRequest.onOutput` gives them. */
  output: string;
}

export interface BuildOutcome {
  ok: boolean;
  /**
   * In the order they ran. A failed build stops at the step that failed, so the last entry
   * is always the one whose output a person needs to read.
   */
  steps: BuildStepResult[];
}

export interface RestartPort {
  /**
   * Whether an in-process request can replace this server at all. Consulted before anything
   * else is done, because refusing after a two-minute build would waste the two minutes.
   */
  supervision(): Promise<Supervision>;
  /**
   * `npm run build` then `npm run build:web`, in that order, stopping at the first failure.
   * Never throws for a non-zero exit — a failing build is a fact to report with its output,
   * not an error, and the caller's next move is to leave the old process running.
   */
  build(): Promise<BuildOutcome>;
  /**
   * Replace this process with one running the code that was just built.
   *
   * Never returns on success: by the time it would, this process is gone. Throws only when
   * the successor could not be started — in which case this process is still serving, and
   * the caller must say so rather than let the browser poll a health endpoint that never
   * went away.
   *
   * `graceMs` is how long to wait before exiting, so an HTTP response that announced the
   * restart can reach the browser first.
   */
  replace(options?: { graceMs?: number }): Promise<never>;
}
