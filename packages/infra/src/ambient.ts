import { scrubSecrets } from '@pomni/core';
import type {
  Clock,
  EmittedEvent,
  EventBus,
  Logger,
  PomniEvent,
  ServerLogStore,
} from '@pomni/core';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  iso(): string {
    return new Date().toISOString();
  }
}

/** Fixed clock for tests, so timestamps in assertions are stable. */
export class FixedClock implements Clock {
  constructor(private value: Date = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return this.value;
  }

  iso(): string {
    return this.value.toISOString();
  }

  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class ConsoleLogger implements Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    const suffix = meta === undefined ? '' : ` ${formatMeta(meta)}`;
    stream.write(`${level.padEnd(5)} ${message}${suffix}\n`);
  }
}

/**
 * A logger that also keeps what it said where the interface can read it.
 *
 * Wraps rather than replaces `ConsoleLogger`: a terminal that started the server should keep
 * printing, and the file is an addition for the case where there is no terminal. Both get the
 * same line, scrubbed once, here — scrubbing at the sink would leave the terminal copy with
 * the secret in it.
 */
export class RecordingLogger implements Logger {
  constructor(
    private readonly console: Logger,
    private readonly store: ServerLogStore,
    private readonly clock: { iso(): string },
    private readonly level: LogLevel = 'debug',
  ) {}

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    const scrubbed = scrubSecrets(message);
    const detail = meta === undefined ? '' : scrubSecrets(formatMeta(meta));

    this.console[level](scrubbed, meta === undefined ? undefined : detail);

    if (LEVELS[level] < LEVELS[this.level]) return;
    this.store.append({ at: this.clock.iso(), level, message: scrubbed, detail });
  }
}

export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/**
 * In-process bus. The cross-process NDJSON sink described in ARCHITECTURE.md §6 plugs in
 * here as a subscriber once runs exist; nothing about this interface changes then.
 */
export class InMemoryEventBus implements EventBus {
  private handlers = new Set<(event: PomniEvent & EmittedEvent) => void>();

  emit(event: PomniEvent & { ts?: string }): void {
    this.dispatch({ ...event, ts: event.ts ?? new Date().toISOString(), origin: 'local' });
  }

  emitRemote(event: PomniEvent & { ts: string }): void {
    this.dispatch({ ...event, origin: 'remote' });
  }

  subscribe(handler: (event: PomniEvent & EmittedEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private dispatch(event: PomniEvent & EmittedEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A bad subscriber must not break the operation that emitted.
      }
    }
  }
}

function formatMeta(meta: unknown): string {
  if (meta instanceof Error) return meta.message;
  if (typeof meta === 'string') return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
