import { spawn } from 'node:child_process';
import type { BuildOutcome, BuildStepResult, Executor, Logger, RestartPort, Supervision } from '@pomni/core';
import { RESTART_BUILD_COMMANDS } from '@pomni/core';
import { ProcessExecutor } from './executor.js';

export interface NodeRestartAdapterOptions {
  repoDir: string;
  logger: Logger;
  /** Defaults to `ProcessExecutor`, the same house helper capabilities run through. */
  executor?: Executor;
}

/**
 * Replaces the running Pomni server with the code that was just built.
 *
 * `build()` reuses `ProcessExecutor` — the same helper capabilities run through — so `npm run
 * build` resolves `npm.cmd` on Windows the same way a declared capability's command line does,
 * via `shell: true`, without this adapter reaching for `child_process` itself.
 *
 * `replace()` cannot `exec` over itself on Windows, so it spawns a successor and exits once it
 * has taken the port, rather than replacing the current process image.
 */
export class NodeRestartAdapter implements RestartPort {
  private readonly repoDir: string;
  private readonly logger: Logger;
  private readonly executor: Executor;

  constructor(options: NodeRestartAdapterOptions) {
    this.repoDir = options.repoDir;
    this.logger = options.logger;
    this.executor = options.executor ?? new ProcessExecutor();
  }

  /**
   * Evidence, not a guess:
   *
   * - `POMNI_SUPERVISED=1` is a marker a launcher (systemd, pm2, a container restart policy)
   *   sets on the environment it starts Pomni in, to declare "I restart this when it exits."
   *   Nothing in this repo sets it today — there is no supervisor wired up yet — so this
   *   branch exists for whoever adds one, and is never guessed at from process shape alone.
   * - A TTY on stdin or stdout means a person typed `pomni serve` into a terminal by hand.
   *   That process has no supervisor and, on Windows particularly, sharing a console with a
   *   detached child risks both going down together on the next Ctrl+C — so it is reported
   *   `unsupported` rather than attempted.
   * - Anything else (no supervisor marker, no TTY — e.g. started from a script, a background
   *   job, or redirected output) can reproduce its own launch: `process.execPath` and
   *   `process.argv` are enough to spawn an equivalent successor, so it is `self`.
   */
  async supervision(): Promise<Supervision> {
    if (process.env.POMNI_SUPERVISED === '1') {
      return {
        mode: 'supervised',
        detail:
          'A supervisor restarts this process when it exits (declared via POMNI_SUPERVISED=1). ' +
          'Restarting will exit this process and let the supervisor relaunch it with the new build.',
      };
    }

    if (process.stdin.isTTY || process.stdout.isTTY) {
      return {
        mode: 'unsupported',
        detail:
          'This server was started by hand in a terminal, so it has no supervisor and restarting ' +
          'here is not safe to attempt. Stop it and run the serve command again to pick up the new build.',
      };
    }

    return {
      mode: 'self',
      detail:
        'No supervisor is declared and this process is not attached to a terminal, so restarting ' +
        'will spawn a successor with the same command line and exit once it has taken the port.',
    };
  }

  /**
   * Runs `RESTART_BUILD_COMMANDS` in order through `ProcessExecutor`, which already knows how
   * to run a command line on Windows (`shell: true`, so `npm` resolves to `npm.cmd`). Stops at
   * the first non-zero — or missing, i.e. `null` — exit code; never throws.
   */
  async build(): Promise<BuildOutcome> {
    const steps: BuildStepResult[] = [];

    for (const cmd of RESTART_BUILD_COMMANDS) {
      let output = '';
      const result = await this.executor.run({
        cmd,
        cwd: this.repoDir,
        onOutput: (chunk) => {
          output += chunk;
        },
      });

      steps.push({ cmd, exitCode: result.exitCode, output });

      if (result.exitCode !== 0) {
        return { ok: false, steps };
      }
    }

    return { ok: true, steps };
  }

  /**
   * Spawns a successor from `process.execPath` with the same argv, detached and unref'd, then
   * exits after `graceMs` so the caller's HTTP response has time to reach the browser first.
   *
   * Windows specifics: no shell (an unshelled argv array is exactly what avoids the multi-line
   * / quoting mangling a shell would do — the same reason `claude-code-llm.ts` sends its prompt
   * on stdin instead of an argument). `stdio: 'ignore'` together with `windowsHide: true` stops
   * a detached child from opening a visible console window on Windows, which it otherwise would.
   * `POMNI_RESTART_AWAIT_PORT=1` tells the successor to retry binding on `EADDRINUSE` for up to
   * 15s — that is the port handover, so this adapter does not close the listening socket itself.
   */
  async replace(options?: { graceMs?: number }): Promise<never> {
    const graceMs = options?.graceMs ?? 500;

    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: this.repoDir,
      env: { ...process.env, POMNI_RESTART_AWAIT_PORT: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(error));
    });

    child.unref();
    this.logger.info('restart: successor spawned, handing off port', { pid: child.pid });

    await new Promise((resolve) => setTimeout(resolve, graceMs));
    process.exit(0);
  }
}
