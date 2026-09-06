import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecRequest, ExecResult, Executor } from '@pomni/core';

const execFileAsync = promisify(execFile);

/**
 * Runs a repo's own command line through the platform shell.
 *
 * Two details that matter on Windows: killing the shell does not kill its grandchildren, so
 * termination goes through `taskkill /T`; and a timeout must still produce a result rather
 * than a rejection, because a timed-out run is a recorded outcome, not an error.
 */
export class ProcessExecutor implements Executor {
  async run(request: ExecRequest): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      const child = spawn(request.cmd, {
        cwd: request.cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...request.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1' },
      });

      const pid = child.pid ?? null;
      if (pid) request.onStart?.(pid);

      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const stop = () => {
        if (pid) void this.kill(pid);
        else child.kill();
      };

      const timer = request.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            request.onOutput?.(`\n[pomni] timed out after ${request.timeoutMs}ms\n`);
            stop();
          }, request.timeoutMs)
        : null;

      const onAbort = () => {
        cancelled = true;
        stop();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      const forward = (chunk: Buffer) => request.onOutput?.(chunk.toString());
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode, timedOut, cancelled, pid });
      };

      child.on('error', (error) => {
        request.onOutput?.(`\n[pomni] ${error.message}\n`);
        finish(null);
      });

      child.on('close', (code) => finish(code));
    });
  }

  /** Kill the whole tree — a package-manager script is a child of a child. */
  async kill(pid: number): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        // Negative pid targets the process group.
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGTERM');
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** `process.kill(pid, 0)` semantics: EPERM means the process exists but isn't ours. */
  async isAlive(pid: number): Promise<boolean> {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async which(command: string, cwd: string): Promise<string | null> {
    // Shell builtins and control words have no executable to find.
    if (SHELL_BUILTINS.has(command)) return command;

    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(finder, [command], {
        cwd,
        timeout: 10_000,
        windowsHide: true,
      });
      const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
      return first?.trim() ?? null;
    } catch {
      return null;
    }
  }
}

const SHELL_BUILTINS = new Set([
  'cd',
  'echo',
  'exit',
  'export',
  'set',
  'true',
  'false',
  'test',
  'source',
  'call',
  'rem',
]);
