import { z } from 'zod';

/**
 * A named, runnable operation on a repo: build, test, lint, dev, or anything custom.
 * This is the abstraction that lets Pomni support new stacks without touching core —
 * a stack adapter proposes capabilities, and the repo's own config overrides them.
 */
export const CapabilitySchema = z.object({
  /** Shell command, run through the platform shell in the repo's working directory. */
  cmd: z.string().min(1),
  /** Directory relative to the repo root. Defaults to the root. */
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Long-running (dev servers). The runner does not wait for exit. */
  background: z.boolean().optional(),
  /** For background capabilities: log line that means "ready". */
  readyLog: z.string().optional(),
  port: z.number().int().positive().optional(),
  /**
   * Structured report to ingest after the run. `junit` reads `reportPath` and populates
   * per-test rows; detection never sets this, because a default `npm test` writes no report.
   * Set it by hand once the repo's test command emits one.
   */
  parser: z.enum(['junit', 'coverage', 'none']).optional(),
  /** Path to the report, relative to the repo root. Required when `parser` is set. */
  reportPath: z.string().optional(),
  /** Where this definition came from. Manual entries survive re-detection. */
  origin: z.enum(['detected', 'manual']).default('detected'),
});

export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityMapSchema = z.record(CapabilitySchema);
export type CapabilityMap = z.infer<typeof CapabilityMapSchema>;

/** Capability names Pomni understands specially. Others are allowed and simply run. */
export const WELL_KNOWN_CAPABILITIES = [
  'install',
  'build',
  'test',
  'lint',
  'typecheck',
  'e2e',
  'dev',
  'start',
] as const;

export type WellKnownCapability = (typeof WELL_KNOWN_CAPABILITIES)[number];

/**
 * Re-detection must not silently discard a command a human wrote. Manual entries win;
 * detected entries are replaced.
 */
export function mergeCapabilities(existing: CapabilityMap, detected: CapabilityMap): CapabilityMap {
  const merged: CapabilityMap = {};
  for (const [name, cap] of Object.entries(detected)) merged[name] = cap;
  for (const [name, cap] of Object.entries(existing)) {
    if (cap.origin === 'manual') merged[name] = cap;
  }
  return merged;
}
