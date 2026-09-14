import { z } from 'zod';

export const PomniConfigSchema = z.object({
  version: z.literal(1).default(1),
  defaultProject: z.string().nullable().default(null),
  server: z
    .object({
      port: z.number().int().positive().default(7777),
      host: z.string().default('127.0.0.1'),
    })
    .default({}),
  /**
   * What opens a file when someone asks Pomni to open one.
   *
   * Null means "look for one on PATH", which is what almost everybody wants and nobody wants
   * to configure. It is a setting rather than a guess because the guess is wrong for anyone
   * whose editor is not on the list, and because a command that runs on someone's machine
   * should be something they can see written down.
   *
   * It is a program name, not a command line: the file is passed as a separate argument and
   * never goes through a shell, so `code --wait` here would be looked up as a program called
   * `code --wait` and not found.
   */
  editor: z
    .object({
      command: z.string().nullable().default(null),
    })
    .default({}),
  /**
   * Telling a person a run needs them, without them having to go look.
   *
   * Both channels are optional and off by default: a desktop toast only makes sense on the
   * machine running `serve`, and a webhook only makes sense once someone has somewhere to
   * point it. `baseUrl` overrides the link built into every notification when the server is
   * reached from somewhere other than `server.host`/`server.port` — behind a reverse proxy,
   * a tunnel, or a different hostname entirely.
   */
  notify: z
    .object({
      baseUrl: z.string().nullable().default(null).transform(trimToNull),
      desktop: z.boolean().default(false),
      webhook: z
        .object({
          url: z.string().nullable().default(null).transform(trimToNull),
          /** A credential id, resolved at send time. The secret itself never lives here. */
          credential: z.string().nullable().default(null).transform(trimToNull),
        })
        .default({}),
    })
    .default({}),
});

/** Empty and whitespace-only strings are the same as never having set the field. */
function trimToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Editors looked for on PATH when none is configured, in the order they are preferred.
 *
 * Order is not quality — it is how likely the person running Pomni meant that one. Someone
 * with both `code` and `idea` installed almost certainly wants a file opened in the first.
 */
export const KNOWN_EDITORS = ['code', 'cursor', 'subl', 'idea'] as const;

export type PomniConfig = z.infer<typeof PomniConfigSchema>;

export const DEFAULT_CONFIG: PomniConfig = PomniConfigSchema.parse({});

/**
 * Where a link in a notification points, when nobody said otherwise.
 *
 * `server.host`/`server.port` is what `serve` actually bound, which is right for the common
 * case of opening a notification on the same machine. `notify.baseUrl` overrides it for
 * everyone else: a reverse proxy, a tunnel, a hostname the server itself does not know it is
 * reachable at.
 */
export function notifyBaseUrl(config: PomniConfig): string {
  return config.notify.baseUrl ?? `http://${config.server.host}:${config.server.port}`;
}
