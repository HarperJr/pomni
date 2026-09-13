import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SERVER_LOG_CEILING_BYTES,
  filterLog,
  formatLogLine,
  parseLog,
  trimLog,
  type LogEntry,
  type LogFilter,
  type ServerLogStore,
} from '@pomni/core';

/**
 * Pomni's own log, as a trimmed NDJSON file.
 *
 * A file rather than a ring buffer in memory, because the log matters most about the run that
 * just died and a restart is exactly when it dies. The cost is that a write touches the disk;
 * that is paid asynchronously and a failed write is swallowed — a logger that can throw turns
 * every caller into a place the process can die, which is a bad trade for a diagnostic.
 *
 * Appends are serialised through one promise chain. Two services logging at once would
 * otherwise interleave inside a line, and a half-written entry is one `parseLog` throws away.
 */
export class FileServerLog implements ServerLogStore {
  private queue: Promise<void> = Promise.resolve();
  private written = 0;
  private ready = false;

  constructor(
    private readonly path: string,
    private readonly ceiling: number = SERVER_LOG_CEILING_BYTES,
  ) {}

  append(entry: LogEntry): void {
    this.queue = this.queue.then(async () => {
      try {
        if (!this.ready) {
          await mkdir(dirname(this.path), { recursive: true });
          this.ready = true;
        }

        const line = formatLogLine(entry);
        await appendFile(this.path, line, 'utf8');
        this.written += Buffer.byteLength(line, 'utf8');

        // Checked against what this process has added rather than by stat-ing on every line:
        // the ceiling is a bound on growth, not a promise about the exact byte count, and a
        // stat per log line is a syscall nobody asked for.
        if (this.written >= this.ceiling / 4) {
          const raw = await readFile(this.path, 'utf8');
          const trimmed = trimLog(raw, this.ceiling);
          if (trimmed.length !== raw.length) await writeFile(this.path, trimmed, 'utf8');
          this.written = 0;
        }
      } catch {
        // A log that cannot be written must not take the caller down with it.
      }
    });
  }

  async read(filter: LogFilter): Promise<LogEntry[]> {
    // Everything queued is on disk before the read, so a person who just did something sees
    // what it said rather than what it had said a moment earlier.
    await this.queue;
    try {
      return filterLog(parseLog(await readFile(this.path, 'utf8')), filter);
    } catch {
      // No file yet is not an error: it means nothing has been logged.
      return [];
    }
  }
}

/** Everything appended so far, for a test that wants the log without a disk. */
export class MemoryServerLog implements ServerLogStore {
  private readonly entries: LogEntry[] = [];

  append(entry: LogEntry): void {
    this.entries.push(entry);
  }

  async read(filter: LogFilter): Promise<LogEntry[]> {
    return filterLog(this.entries, filter);
  }
}
