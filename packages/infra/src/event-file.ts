import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { DURABLE_EVENT_TYPES, type EmittedEvent, type EventBus, type PomniEvent } from '@pomni/core';
import { readLogFrom } from './log-sink.js';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Writes lifecycle events to `.pomni/events.ndjson`, the stream any Pomni process can tail.
 *
 * This is what lets the management server be a peer rather than a daemon: a run started by
 * the CLI reaches the browser because both processes meet at this file, not because one
 * connects to the other.
 *
 * Output chunks are excluded on purpose — the per-run log file already holds them, and
 * duplicating a megabyte of build output here would make the stream useless.
 */
export class FileEventSink {
  private readonly unsubscribe: () => void;

  constructor(
    bus: EventBus,
    private readonly path: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.unsubscribe = bus.subscribe((event) => this.write(event));
  }

  private write(event: PomniEvent & EmittedEvent): void {
    // Replayed from another process — writing it back would loop.
    if (event.origin === 'remote') return;
    if (!DURABLE_EVENT_TYPES.has(event.type)) return;

    try {
      this.rotateIfNeeded();
      appendFileSync(this.path, `${JSON.stringify({ ...event, pid: process.pid })}\n`, 'utf8');
    } catch {
      // The event stream is a convenience; losing a line must never fail an operation.
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) {
        renameSync(this.path, `${this.path}.1`);
      }
    } catch {
      // Another process rotated first.
    }
  }

  close(): void {
    this.unsubscribe();
  }
}

/**
 * Tails `.pomni/events.ndjson` and replays other processes' events onto the local bus,
 * tagged `remote` so the sink ignores them.
 */
export class FileEventSource {
  private watcher: FSWatcher | null = null;
  private offset = 0;
  private reading = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly path: string,
  ) {}

  /** Start from the end: history is in SQLite, this stream is for what happens next. */
  async start(): Promise<void> {
    try {
      this.offset = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      this.offset = 0;
    }

    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Watch the directory: the file may not exist yet, and rotation replaces it.
      this.watcher = watch(dirname(this.path), (_event, filename) => {
        if (!filename || !String(filename).startsWith('events.ndjson')) return;
        void this.drain();
      });
    } catch {
      // Watching is unavailable on some filesystems; the poll below still works.
    }

    // fs.watch misses writes on network drives and some Windows cases.
    this.timer = setInterval(() => void this.drain(), 1000);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const { text, offset } = await readLogFrom(this.path, this.offset);
      this.offset = offset;
      if (!text) return;

      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed) as PomniEvent & EmittedEvent & { pid?: number };
          // Our own writes already reached subscribers directly.
          if (parsed.pid === process.pid) continue;
          this.bus.emitRemote(parsed);
        } catch {
          // A torn final line; the next drain re-reads from the new offset.
        }
      }
    } catch {
      // Transient read errors are not worth surfacing.
    } finally {
      this.reading = false;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
