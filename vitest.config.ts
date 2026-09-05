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
  },
});
