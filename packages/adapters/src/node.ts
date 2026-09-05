import { join } from 'node:path';
import type { CapabilityMap, DetectionResult, FsProbe, StackDetector } from '@pomni/core';

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Frameworks worth naming in the UI, in the order we prefer to report them. */
const FRAMEWORKS: Array<[string, string]> = [
  ['next', 'next'],
  ['nuxt', 'nuxt'],
  ['@remix-run/react', 'remix'],
  ['@angular/core', 'angular'],
  ['@nestjs/core', 'nest'],
  ['astro', 'astro'],
  ['svelte', 'svelte'],
  ['vue', 'vue'],
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['hono', 'hono'],
  ['vite', 'vite'],
  ['react', 'react'],
];

const TEST_RUNNERS = ['vitest', 'jest', 'mocha', 'ava', 'node:test'];

export const nodeDetector: StackDetector = {
  name: 'node',

  async detect(dir: string, fs: FsProbe): Promise<DetectionResult | null> {
    const raw = await fs.readText(join(dir, 'package.json'));
    if (!raw) return null;

    let pkg: PackageJson;
    try {
      pkg = JSON.parse(raw) as PackageJson;
    } catch {
      // A package.json we cannot parse still means "this is a Node repo".
      pkg = {};
    }

    const names = await fs.listNames(dir);
    const pm = detectPackageManager(pkg, names);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts ?? {};

    const detected: string[] = [];
    for (const [dep, label] of FRAMEWORKS) {
      if (deps[dep]) {
        detected.push(withVersion(label, deps[dep]));
        break;
      }
    }
    detected.push(pm);
    if (deps.typescript) detected.push(withVersion('typescript', deps.typescript));
    for (const runner of TEST_RUNNERS) {
      if (deps[runner]) {
        detected.push(runner);
        break;
      }
    }
    if (deps['@playwright/test'] || deps.playwright) detected.push('playwright');
    if (deps.cypress) detected.push('cypress');
    if (pkg.workspaces) detected.push('workspaces');

    const capabilities: CapabilityMap = {
      install: cap(pm === 'npm' ? 'npm install' : `${pm} install`),
    };

    const script = (name: string) => `${pm} run ${name}`;

    if (scripts.build) capabilities.build = cap(script('build'), { timeoutMs: 600_000 });
    if (scripts.test) capabilities.test = cap(script('test'));
    if (scripts.lint) capabilities.lint = cap(script('lint'));

    const typecheckScript = ['typecheck', 'type-check', 'tsc'].find((name) => scripts[name]);
    if (typecheckScript) {
      capabilities.typecheck = cap(script(typecheckScript));
    } else if (deps.typescript) {
      capabilities.typecheck = cap(`${runner(pm)} tsc --noEmit`);
    }

    const e2eScript = ['e2e', 'test:e2e', 'test-e2e'].find((name) => scripts[name]);
    if (e2eScript) capabilities.e2e = cap(script(e2eScript));

    if (scripts.dev) {
      capabilities.dev = cap(script('dev'), {
        background: true,
        readyLog: deps.next ? 'Ready in' : 'ready in',
        port: deps.next ? 3000 : 5173,
      });
    } else if (scripts.start) {
      capabilities.dev = cap(script('start'), { background: true });
    }

    if (!capabilities.test && deps.vitest) capabilities.test = cap(`${runner(pm)} vitest run`);

    return { adapter: 'node', detected, capabilities };
  },
};

function detectPackageManager(pkg: PackageJson, names: string[]): PackageManager {
  const declared = pkg.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm' || declared === 'bun') {
    return declared;
  }
  if (names.includes('pnpm-lock.yaml')) return 'pnpm';
  if (names.includes('yarn.lock')) return 'yarn';
  if (names.includes('bun.lockb') || names.includes('bun.lock')) return 'bun';
  return 'npm';
}

/** How this package manager runs a bare binary from node_modules/.bin. */
function runner(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm exec';
    case 'yarn':
      return 'yarn';
    case 'bun':
      return 'bunx';
    default:
      return 'npx';
  }
}

function withVersion(label: string, range: string | undefined): string {
  if (!range) return label;
  const major = /(\d+)/.exec(range)?.[1];
  return major ? `${label}@${major}` : label;
}

function cap(cmd: string, extra: Record<string, unknown> = {}) {
  return { cmd, origin: 'detected' as const, ...extra };
}
