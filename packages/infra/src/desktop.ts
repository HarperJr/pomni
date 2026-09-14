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

  /**
   * Unlike `open` and `reveal`, this waits for the process that shows the toast to exit — not
   * for the toast to be dismissed, which nothing here can observe, but for the one-shot command
   * that posted it to finish and say whether posting worked. A silent failure here would look
   * exactly like "the person saw it and ignored it", which is the one outcome a caller must be
   * able to tell apart from every other.
   */
  async notify(title: string, body: string): Promise<void> {
    if (process.platform === 'win32') return this.notifyWindows(title, body);
    if (process.platform === 'darwin') return this.notifyMac(title, body);
    return this.notifyLinux(title, body);
  }

  private async notifyWindows(title: string, body: string): Promise<void> {
    if (!(await this.canRun('powershell'))) {
      throw new Error("'powershell' is not on PATH, so there is nothing to show a toast with");
    }

    // Built as XML and loaded rather than assembled through the toast API's object model
    // directly, because ToastGeneric's binding is what Explorer actually renders — the older
    // ToastText templates still work but are visually inconsistent across Windows builds.
    const xmlEscape = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xml =
      `<toast><visual><binding template="ToastGeneric">` +
      `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>` +
      `</binding></visual></toast>`;

    // A PowerShell single-quoted string literal: doubling the only character that ends one.
    const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$xml.LoadXml(${psLiteral(xml)})`,
      '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pomni').Show($toast)",
    ].join('; ');

    // `-EncodedCommand` carries the whole script as base64, so nothing in the title or body
    // is ever parsed as PowerShell syntax even after the single-quote doubling above — it is
    // belt and suspenders against the one character that escaping alone gets wrong.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await runAwaited('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  }

  private async notifyMac(title: string, body: string): Promise<void> {
    if (!(await this.canRun('osascript'))) {
      throw new Error("'osascript' is not on PATH, so there is nothing to show a notification with");
    }

    // JSON's string escaping and AppleScript's agree on the characters that matter here:
    // backslash and the double quote that ends the literal.
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    await runAwaited('osascript', ['-e', script]);
  }

  private async notifyLinux(title: string, body: string): Promise<void> {
    if (!(await this.canRun('notify-send'))) {
      throw new Error("'notify-send' is not on PATH, so there is nothing to show a notification with");
    }

    await runAwaited('notify-send', [title, body]);
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

/**
 * Start a program and wait for it to finish, the opposite tradeoff from `detach`.
 *
 * Used only for the one-shot commands that post a toast: there is nothing to keep running
 * after they exit, and the caller needs to know whether posting it actually worked.
 */
function runAwaited(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`'${command}' exited with code ${code}`));
    });
  });
}

function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : path;
}
