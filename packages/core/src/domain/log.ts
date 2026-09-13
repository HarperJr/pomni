import { z } from 'zod';

/**
 * Pomni's own log: what the services said while they were working.
 *
 * Distinct from a run's log, which is a subprocess's output streamed to a file per run and
 * read back through `runs.ts`. This one is the server talking about itself — a sync that
 * refused, a credential that would not resolve, a worktree it could not release — and until
 * now it went to whichever terminal started `pomni serve`, which for a detached process is
 * nobody.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** Ordered, so a filter can say "warn and worse" rather than listing what it wants. */
export const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const LogEntrySchema = z.object({
  at: z.string(),
  level: LogLevelSchema,
  message: z.string(),
  /** Whatever the caller passed as meta, already scrubbed and flattened to a string. */
  detail: z.string().default(''),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/**
 * How much of the log is kept on disk.
 *
 * A log that grows without limit is a bug that files itself later, so the ceiling is named
 * here rather than left to whoever notices the disk is full. Two megabytes is roughly a day
 * of ordinary running and several hours of a bad one, which is the window that matters: the
 * question a log answers is almost always about something that just happened.
 */
export const SERVER_LOG_CEILING_BYTES = 2 * 1024 * 1024;

/** How many entries one read may return. The browser never holds the whole file. */
export const SERVER_LOG_PAGE = 500;

/**
 * Anything that looks like a secret, replaced before the line is written.
 *
 * `redact` in the git adapter removes one secret it already knows; this removes ones nobody
 * told us about, which is the case that matters for a log a browser can fetch. It is
 * deliberately eager: a false positive costs a reader some context, a false negative
 * publishes a token.
 *
 * Rule 3 does not stop at tracked files.
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // https://user:token@host — the shape a git remote takes once a credential is applied.
      .replace(/(\/\/[^\s/:@]+):[^\s/@]+@/g, '$1:***@')
      // Authorization: Bearer …, and the bare `token …` / `key=…` forms.
      .replace(/\b(bearer|token|api[-_]?key|secret|password)([\s=:]+)\S+/gi, '$1$2***')
      // Provider-shaped tokens, which are recognisable on their own.
      .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9-]{16,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '***')
  );
}

export interface LogFilter {
  /** This level and worse. Defaults to `info`, so `debug` is hidden unless it is asked for. */
  level?: LogLevel;
  /** Case-insensitive substring, matched against the message and its detail. */
  q?: string;
  limit?: number;
}

/**
 * The entries a filter selects, newest last.
 *
 * Newest last because the panel reads like a transcript and a person scrolls to the bottom
 * for what just happened — the same order a terminal would have shown them.
 */
export function filterLog(entries: LogEntry[], filter: LogFilter = {}): LogEntry[] {
  const floor = LEVEL_RANK[filter.level ?? 'info'];
  const needle = filter.q?.trim().toLowerCase();
  const limit = Math.min(filter.limit ?? SERVER_LOG_PAGE, SERVER_LOG_PAGE);

  const matched = entries.filter((entry) => {
    if (LEVEL_RANK[entry.level] < floor) return false;
    if (!needle) return true;
    return `${entry.message} ${entry.detail}`.toLowerCase().includes(needle);
  });

  return matched.slice(-limit);
}

/** One entry as it is stored: NDJSON, so a partial last line loses one entry and not the file. */
export function formatLogLine(entry: LogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Parse a stored log, skipping anything that will not read.
 *
 * A truncated final line is normal — the file is trimmed from the front and appended to from
 * a process that can be killed — so a line that does not parse is dropped rather than being
 * allowed to fail the whole read.
 */
export function parseLog(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = LogEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // A half-written line. The next append will be whole.
    }
  }
  return entries;
}

/**
 * Trim a log to the ceiling, dropping whole entries from the front.
 *
 * Cutting mid-line would leave a fragment that `parseLog` then discards, which loses a whole
 * entry to save a few bytes and makes the file's first line unpredictable. Whole lines only.
 */
export function trimLog(raw: string, ceiling: number = SERVER_LOG_CEILING_BYTES): string {
  if (Buffer.byteLength(raw, 'utf8') <= ceiling) return raw;

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  let kept: string[] = [];
  let size = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (size + cost > ceiling) break;
    kept = [line, ...kept];
    size += cost;
  }

  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}
