import { z } from 'zod';

/**
 * One execution of one capability against one repo.
 *
 * A run is the evidence a gate consults, so it records everything needed to explain a
 * verdict later: the exact command, where it ran, how long it took, and where the output
 * went. Runs are never edited — only appended to and finished.
 */

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'timeout',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'passed',
  'failed',
  'timeout',
  'cancelled',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const RunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repoId: z.string(),
  /** Backlog item this run was performed for, once items exist. */
  itemId: z.string().nullable().default(null),
  capability: z.string(),
  cmd: z.string(),
  cwd: z.string(),
  status: RunStatusSchema,
  exitCode: z.number().nullable().default(null),
  /** OS pid while running, so another process can cancel it. */
  pid: z.number().nullable().default(null),
  startedAt: z.string(),
  endedAt: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  /** Absolute path to the combined output log. */
  logPath: z.string(),
  /** One line a human can read without opening the log: "12 passed, 1 failed". */
  summary: z.string().nullable().default(null),
});

export type Run = z.infer<typeof RunSchema>;

export const TestResultSchema = z.object({
  suite: z.string(),
  name: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().nullable().default(null),
  message: z.string().nullable().default(null),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export interface RunFilter {
  projectId?: string;
  repoId?: string;
  itemId?: string;
  capability?: string;
  status?: RunStatus;
  /** Only runs that did not pass. */
  failedOnly?: boolean;
  limit?: number;
  before?: string;
}

/**
 * A gate evaluates one capability across every repo that declares it. A repo that does not
 * declare the capability is skipped, not failed — an `api` repo with no `e2e` script should
 * not block a gate that the `web` repo satisfies.
 */
export interface GateResult {
  capability: string;
  status: 'passed' | 'failed' | 'skipped';
  runs: Run[];
}

export interface GateReport {
  projectId: string;
  gate: string;
  passed: boolean;
  results: GateResult[];
}

export function runLabel(run: Run): string {
  return `${run.projectId}/${run.repoId} ${run.capability}`;
}

/** Exit code alone decides pass/fail; timeouts and cancels are recorded distinctly. */
export function statusFromExit(exitCode: number | null, timedOut: boolean, cancelled: boolean): RunStatus {
  if (cancelled) return 'cancelled';
  if (timedOut) return 'timeout';
  return exitCode === 0 ? 'passed' : 'failed';
}
