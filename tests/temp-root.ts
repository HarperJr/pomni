import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One temporary directory for the whole run, swept once at the end.
 *
 * Every harness used to delete its own workspace in `afterEach`. Six hundred recursive
 * deletions, interleaved with the tests still running, on a filesystem four workers are
 * already hammering — and on Windows, with a virus scanner holding handles behind them, one of
 * those deletions occasionally took longer than the thirty-second hook timeout and failed a
 * test that had already passed. The tests that died this way were never the same two.
 *
 * A test does not need its directory *gone* to be finished with it; it needs its handles
 * closed, which the harness still does. So the deleting moves here: one sweep, after the last
 * test, of one tree.
 *
 * The path is passed to workers through the environment because a global setup and a test file
 * are different processes and share nothing else.
 */
export const TEMP_ROOT_ENV = 'POMNI_TEST_TEMP_ROOT';

/** Where a test should put its scratch directory. The shared root, or the system's own. */
export function tempRoot(): string {
  return process.env[TEMP_ROOT_ENV] ?? tmpdir();
}

export async function setup(): Promise<void> {
  process.env[TEMP_ROOT_ENV] = await mkdtemp(join(tmpdir(), 'pomni-suite-'));
}

export async function teardown(): Promise<void> {
  const root = process.env[TEMP_ROOT_ENV];
  if (!root) return;

  // Best effort. A leftover directory under the system temp is untidy; a suite that reports
  // failure because it could not delete one is worse, and says nothing about the code.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
}
