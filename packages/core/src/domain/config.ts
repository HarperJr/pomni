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
});

export type PomniConfig = z.infer<typeof PomniConfigSchema>;

export const DEFAULT_CONFIG: PomniConfig = PomniConfigSchema.parse({});
