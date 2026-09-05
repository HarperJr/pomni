import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConflictError, type Lock } from '@pomni/core';

const STALE_MS = 30_000;
const RETRY_MS = 50;
const TIMEOUT_MS = 10_000;

/**
 * Advisory lock as an exclusively-created file.
 *
 * Only the handful of operations that write more than one file need this — allocating an
 * item id bumps a counter in `project.yaml` as well as writing the item. Everything else
 * relies on `rev`, which is cheaper and does not strand a lock if a process dies.
 *
 * A lock older than 30s is assumed stale and broken: a crashed CLI must not wedge the
 * workspace forever, and the operations it guards are all sub-second.
 */
export class FileLock implements Lock {
  constructor(private readonly dir: string) {}

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const path = join(this.dir, `${name}.lock`);
    await this.acquire(path);
    try {
      return await fn();
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  private async acquire(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + TIMEOUT_MS;

    for (;;) {
      try {
        // `wx` fails if the file exists, which is what makes this a lock.
        await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }), {
          flag: 'wx',
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        if (await this.isStale(path)) {
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }

        if (Date.now() > deadline) {
          throw new ConflictError(
            `timed out waiting for the '${path}' lock — another Pomni process may be stuck`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private async isStale(path: string): Promise<boolean> {
    try {
      const raw = await readFile(path, 'utf8');
      const { at } = JSON.parse(raw) as { at?: number };
      return typeof at !== 'number' || Date.now() - at > STALE_MS;
    } catch {
      // Unreadable or already gone: treat as stale rather than blocking forever.
      return true;
    }
  }
}

/** No-op lock for tests and single-process contexts. */
export class NoopLock implements Lock {
  async withLock<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
