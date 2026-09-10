import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Alias workspace packages to source so tests exercise the code, not a stale dist build.
const pkg = (name: string) => resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@pomni/core': pkg('core'),
      '@pomni/infra': pkg('infra'),
      '@pomni/adapters': pkg('adapters'),
      '@pomni/server': pkg('server'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * A bounded pool, because these tests are not CPU-bound.
     *
     * Vitest defaults to one worker per core, and this machine has 24. Almost every suite here
     * drives real work — `mkdtemp`, four SQLite databases per harness, directory copies, and in
     * places a real `git` — so 24 workers is 24 processes contending for one disk, not 24
     * processes computing. It stayed under the limit until three branches merged, each having
     * added slow integration suites that were green on their own; together they pushed the set
     * over, and 44 tests died on the 30-second timeout without a single failed assertion.
     *
     * Serially the same suite is green in 873s. The timeouts are deliberately left where they
     * are: raising them would let oversubscription grow back silently, which is how this was
     * missed the first time. The pool size is the thing that was wrong.
     */
    maxWorkers: 4,
    minWorkers: 1,
    /**
     * One scratch directory for the whole run, deleted once at the end.
     *
     * See `tests/temp-root.ts`: deleting a workspace per test put six hundred recursive
     * removals in the middle of the run, and on Windows one of them occasionally outlasted the
     * thirty-second hook timeout and failed a test that had already passed.
     */
    globalSetup: ['tests/temp-root.ts'],
  },
});
