import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopPort } from '@pomni/core';

const run = promisify(execFile);

/**
 * Launching a program on the machine Pomni is running on.
 *
 * This is the only code here that starts something the user can see, and the only code whose
 * mistakes cannot be corrected by rewriting a file. Two rules hold it together:
 *
 * **No shell, ever.** Arguments go across as an array; nothing is concatenated into a command
 * line for something else to parse. A path containing `&` is a path, not two commands.
 *
 * **The path is checked before it gets here.** The caller resolves it and proves it is inside
 * a repo working directory that this project knows about. This class does not re-derive it and
 * cannot: it only receives one.
 */
export class Desktop implements DesktopPort {
  async canRun(command: string): Promise<boolean> {
    // A program name, not a command line — a space here means someone put arguments in the
    // setting, and looking that up on PATH would find nothing and say something confusing.
    if (!/^[\w.+-]+$/.test(command)) return false;

    try {
      const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [command], {
        windowsHide: true,
      });
      return stdout.trim().length > 0;
    } catch {
      // Both `where` and `which` exit non-zero when there is nothing to find, which is the
      // answer rather than a failure.
      return false;
    }
  }

  async open(command: string, path: string): Promise<void> {
    if (!(await this.canRun(command))) {
      throw new Error(`'${command}' is not on PATH, so there is nothing to open the file with`);
    }

    // On Windows the editors people actually have are `.cmd` shims, which Node refuses to
    // spawn directly. `where` resolves the shim's real path, and cmd.exe runs it — with the
    // two arguments passed as arguments, so nothing in the path is parsed as syntax.
    if (process.platform === 'win32') {
      const { stdout } = await run('where', [command], { windowsHide: true });
      const resolved = stdout.split(/\r?\n/).find((line) => line.trim())?.trim();
      if (!resolved) throw new Error(`'${command}' is not on PATH`);

      detach(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', resolved, path]);
      return;
    }

    detach(command, [path]);
  }

  async reveal(path: string): Promise<void> {
    if (process.platform === 'win32') {
      // `/select,` and the path are one argument to explorer. It also exits 1 on success,
      // which is why nothing here waits for or reads its exit code.
      detach('explorer.exe', [`/select,${path}`]);
      return;
    }

    if (process.platform === 'darwin') {
      detach('open', ['-R', path]);
      return;
    }

    // No Linux file manager agrees on how to select a file, and every one of them opens a
    // directory. The directory is the part that is actually useful anyway.
    detach('xdg-open', [dirOf(path)]);
  }
}

/**
 * Start a program and stop caring about it.
 *
 * An editor outlives the request that opened it, and a request that waited for one would hang
 * until the person closed their editor. Errors are swallowed on purpose: `canRun` has already
 * answered the question worth answering, and a window that failed to appear is something the
 * user can see for themselves.
 */
function detach(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : path;
}
