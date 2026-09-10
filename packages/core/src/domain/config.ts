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
});

/**
 * Editors looked for on PATH when none is configured, in the order they are preferred.
 *
 * Order is not quality — it is how likely the person running Pomni meant that one. Someone
 * with both `code` and `idea` installed almost certainly wants a file opened in the first.
 */
export const KNOWN_EDITORS = ['code', 'cursor', 'subl', 'idea'] as const;

export type PomniConfig = z.infer<typeof PomniConfigSchema>;

export const DEFAULT_CONFIG: PomniConfig = PomniConfigSchema.parse({});
