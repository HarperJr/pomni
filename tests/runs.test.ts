import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firstToken, ulid } from '@pomni/core';
import { DefaultOutputAnalyzer, SqliteRunStore, parseJunit } from '@pomni/infra';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

/** Two repos: `api` declares test+lint, `web` declares test only. */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });

  // No typescript, so neither repo declares `typecheck` — the gate should skip it.
  const apiPath = await makeNodeRepo(join(harness.dir, 'api'), {
    scripts: { test: 'vitest run', lint: 'eslint .' },
    devDependencies: {},
  });
  const webPath = await makeNodeRepo(join(harness.dir, 'web'), {
    scripts: { test: 'vitest run' },
    devDependencies: {},
  });

  await (await harness.repos.add('acme', { source: { kind: 'local', path: apiPath }, id: 'api' }))
    .completion;
  await (await harness.repos.add('acme', { source: { kind: 'local', path: webPath }, id: 'web' }))
    .completion;
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('running capabilities', () => {
  it('fans out across every repo that declares the capability', async () => {
    const runs = await harness.runs.run('acme', 'test');

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.repoId).sort()).toEqual(['api', 'web']);
    expect(runs.every((run) => run.status === 'passed')).toBe(true);
  });

  it('skips repos that do not declare it, rather than failing them', async () => {
    const runs = await harness.runs.run('acme', 'lint');
    expect(runs.map((run) => run.repoId)).toEqual(['api']);
  });

  it('restricts to one repo when asked', async () => {
    const runs = await harness.runs.run('acme', 'test', { repoId: 'web' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.repoId).toBe('web');
  });

  it('rejects a capability no repo declares', async () => {
    await expect(harness.runs.run('acme', 'deploy')).rejects.toMatchObject({ code: 'validation' });
  });

  it('records a non-zero exit as failed, with the command and cwd', async () => {
    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  2 failed (5)' }];
    const runs = await harness.runs.run('acme', 'test', { repoId: 'api' });

    const run = runs[0]!;
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.cmd).toBe('npm run test');
    expect(run.cwd).toBe(join(harness.dir, 'api'));
    expect(run.summary).toBe('2 failed, 3 passed');
  });

  it('reports a killed run as timed out, with what the parser saw marked as partial', async () => {
    // What happened on 2026-09-13: the suite printed its own summary, then the executor killed
    // it during teardown. The counts are real, but the kill is the news.
    harness.executor.script = [
      { match: /run test/, exitCode: null as unknown as number, timedOut: true, output: 'Tests  4 failed | 851 passed (856)' },
    ];
    const [run] = await harness.runs.run('acme', 'test', { repoId: 'api' });

    expect(run!.status).toBe('timeout');
    expect(run!.summary).toBe('timed out after 600s — 4 failed, 851 passed before the kill');
  });

  it('says only that it timed out when the kill left nothing to parse', async () => {
    harness.executor.script = [{ match: /run test/, exitCode: null as unknown as number, timedOut: true }];
    const [run] = await harness.runs.run('acme', 'test', { repoId: 'api' });

    expect(run!.status).toBe('timeout');
    expect(run!.summary).toBe('timed out after 600s');
  });

  it('stops after the first failing repo when bail is set', async () => {
    harness.executor.script = [{ match: /run test/, exitCode: 1 }];
    const runs = await harness.runs.run('acme', 'test', { bail: true });
    expect(runs).toHaveLength(1);
  });

  it('streams output to the log sink and emits lifecycle events', async () => {
    harness.executor.script = [{ match: /run test/, exitCode: 0, output: 'hello from the test run' }];

    const seen: string[] = [];
    harness.events.subscribe((event) => seen.push(event.type));

    const runs = await harness.runs.run('acme', 'test', { repoId: 'api' });
    expect(harness.logs.logs.get(runs[0]!.id)).toContain('hello from the test run');
    expect(seen).toContain('run.started');
    expect(seen).toContain('run.finished');
  });

  it('refuses to run a background capability as a normal run', async () => {
    const repo = await harness.repos.get('acme', 'api');
    await expect(
      harness.runs.runOne(
        { ...repo, capabilities: { dev: { cmd: 'npm run dev', origin: 'detected', background: true } } },
        'dev',
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('cancels by pid and records the outcome', async () => {
    harness.executor.script = [{ match: /run test/, exitCode: 0, delayMs: 300 }];

    const pending = harness.runs.run('acme', 'test', { repoId: 'api' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const [running] = await harness.runs.list({ projectId: 'acme', limit: 1 });
    const cancelled = await harness.runs.cancel(running!.id);

    expect(cancelled.status).toBe('cancelled');
    expect(harness.executor.killed).toContain(4242);
    await pending;
  });
});

describe('gates', () => {
  it('runs each capability in order and passes when all do', async () => {
    const report = await harness.runs.gate('acme', 'default');

    expect(report.passed).toBe(true);
    // typecheck is declared by neither repo.
    expect(report.results.find((result) => result.capability === 'typecheck')?.status).toBe('skipped');
    expect(report.results.find((result) => result.capability === 'lint')?.status).toBe('passed');
    expect(report.results.find((result) => result.capability === 'test')?.status).toBe('passed');
  });

  it('stops at the first failing capability', async () => {
    harness.executor.script = [{ match: /run lint/, exitCode: 1 }];
    const report = await harness.runs.gate('acme', 'default');

    expect(report.passed).toBe(false);
    expect(report.results.map((result) => result.capability)).toEqual(['typecheck', 'lint']);
    // `test` never ran — a red lint makes it moot.
    expect(await harness.runs.list({ capability: 'test' })).toHaveLength(0);
  });
});

describe('doctor', () => {
  it('flags a capability whose executable is not on PATH', async () => {
    harness.executor.missing.add('npm');
    const report = await harness.doctor.check('acme');

    expect(report.status).toBe('fail');
    const failing = report.repos[0]!.checks.filter((check) => check.status === 'fail');
    expect(failing.some((check) => check.detail.includes("'npm' not found"))).toBe(true);
  });

  it('passes an otherwise healthy repo, warning about missing capabilities', async () => {
    const report = await harness.doctor.check('acme', 'api');
    expect(report.repos).toHaveLength(1);
    expect(report.status).not.toBe('fail');
  });

  it('takes the executable from the command, ignoring env assignments', () => {
    expect(firstToken('npm run test')).toBe('npm');
    expect(firstToken('NODE_ENV=test vitest run')).toBe('vitest');
    expect(firstToken('  pnpm  exec tsc ')).toBe('pnpm');
  });
});

describe('run store', () => {
  it('round-trips a run and filters by project, repo and failure', async () => {
    await harness.runs.run('acme', 'test');
    harness.executor.script = [{ match: /run test/, exitCode: 1 }];
    await harness.runs.run('acme', 'test', { repoId: 'web' });

    expect(await harness.runs.list({ projectId: 'acme' })).toHaveLength(3);
    expect(await harness.runs.list({ repoId: 'web' })).toHaveLength(2);
    expect(await harness.runs.list({ failedOnly: true })).toHaveLength(1);
  });

  it('returns the most recent run per repo for a capability', async () => {
    await harness.runs.run('acme', 'test');
    await harness.runs.run('acme', 'test');

    const latest = await harness.runStore.latest('acme', 'test');
    expect(latest).toHaveLength(2);
    expect(new Set(latest.map((run) => run.repoId))).toEqual(new Set(['api', 'web']));
  });

  it('applies migrations to a fresh database and stores test rows', async () => {
    const store = new SqliteRunStore(':memory:');
    await store.insert({
      id: ulid(),
      projectId: 'p',
      repoId: 'r',
      itemId: null,
      capability: 'test',
      cmd: 'x',
      cwd: '/tmp',
      status: 'passed',
      exitCode: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: 5,
      logPath: '/tmp/log',
      summary: null,
    });

    const [stored] = await store.list({});
    await store.putTestResults(stored!.id, [
      { suite: 'auth', name: 'signs in', status: 'passed', durationMs: 3, message: null },
      { suite: 'auth', name: 'rejects', status: 'failed', durationMs: 1, message: 'boom' },
    ]);

    const results = await store.testResults(stored!.id);
    expect(results).toHaveLength(2);
    expect(results[1]?.message).toBe('boom');
    store.close();
  });
});

describe('gradle detection', () => {
  it('reads plugins from the build script and the version catalogue together', async () => {
    const { DetectorRegistry } = await import('@pomni/adapters');
    const { mkdir, writeFile } = await import('node:fs/promises');

    const dir = join(harness.dir, 'kmp');
    await mkdir(join(dir, 'gradle', 'wrapper'), { recursive: true });
    await writeFile(join(dir, 'gradlew'), '#!/bin/sh\n');
    await writeFile(
      join(dir, 'build.gradle.kts'),
      `plugins {
         alias(libs.plugins.kotlin.multiplatform) apply false
         alias(libs.plugins.androidApplication) apply false
         alias(libs.plugins.ktlint) apply false
         alias(libs.plugins.detekt) apply false
       }`,
    );
    await writeFile(
      join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip',
    );

    const detected = await new DetectorRegistry(harness.fs).detect(dir);

    expect(detected?.adapter).toBe('gradle');
    expect(detected?.detected).toContain('gradle@8.14');
    expect(detected?.detected).toContain('kotlin-multiplatform');
    expect(detected?.detected).toContain('android');

    // The project's own linters beat Android's generic `lint` task.
    expect(detected?.capabilities.lint?.cmd).toContain('ktlintCheck detekt');
    expect(detected?.capabilities.build?.cmd).toContain('assemble');
    // Kotlin is type-checked by compiling; a separate typecheck would compile twice.
    expect(detected?.capabilities.typecheck).toBeUndefined();
  });

  it('falls back to a system gradle when no wrapper is committed', async () => {
    const { DetectorRegistry } = await import('@pomni/adapters');
    const { mkdir, writeFile } = await import('node:fs/promises');

    const dir = join(harness.dir, 'plain-gradle');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'build.gradle'), "apply plugin: 'java'");

    const detected = await new DetectorRegistry(harness.fs).detect(dir);
    expect(detected?.capabilities.build?.cmd.startsWith('gradle ')).toBe(true);
  });
});

describe('ulid', () => {
  it('sorts lexicographically by time', () => {
    const early = ulid(1_000_000);
    const late = ulid(2_000_000);
    expect(early < late).toBe(true);
    expect(early).toHaveLength(26);
  });
});

describe('output analysis', () => {
  const analyzer = new DefaultOutputAnalyzer();
  const summarize = (output: string, exitCode = 0) =>
    analyzer.summarize('test', 'x', output, exitCode);

  it('reads vitest counts', () => {
    expect(summarize('  Tests  12 passed (12)')).toBe('12 passed');
    expect(summarize('  Tests  1 failed | 11 passed (12)', 1)).toBe('1 failed, 11 passed');
  });

  it('reads jest counts', () => {
    expect(summarize('Tests:       1 failed, 11 passed, 12 total', 1)).toBe('1 failed, 11 passed');
  });

  it('reads pytest counts', () => {
    expect(summarize('===== 1 failed, 5 passed, 2 skipped in 0.42s =====', 1)).toBe(
      '1 failed, 5 passed, 2 skipped',
    );
  });

  it('reads gradle output', () => {
    expect(analyzer.summarize('build', 'gradlew', 'BUILD SUCCESSFUL in 1m 23s', 0)).toBe(
      'build successful in 1m 23s',
    );
    // The failing task is more useful than the summary line that follows it.
    expect(
      analyzer.summarize(
        'build',
        'gradlew',
        '> Task :app:compileKotlin FAILED\nBUILD FAILED in 12s',
        1,
      ),
    ).toBe('task :app:compileKotlin failed');
  });

  it('reads tsc and eslint output', () => {
    expect(analyzer.summarize('typecheck', 'tsc', 'Found 3 errors in 2 files.', 1)).toBe(
      '3 type errors in 2 file(s)',
    );
    expect(analyzer.summarize('lint', 'eslint', '✖ 7 problems (3 errors, 4 warnings)', 1)).toBe(
      '3 error(s), 4 warning(s)',
    );
  });

  it('falls back to the last line when it recognises nothing', () => {
    expect(summarize('some noise\nEACCES: permission denied\n', 1)).toBe(
      'EACCES: permission denied',
    );
  });

  it('says nothing for an unremarkable success', () => {
    expect(summarize('done\n', 0)).toBeNull();
  });

  it('parses junit xml into test rows', () => {
    const xml = `<?xml version="1.0"?>
      <testsuites>
        <testsuite name="auth" tests="3">
          <testcase classname="auth" name="signs in" time="0.012"/>
          <testcase classname="auth" name="rejects bad password" time="0.004">
            <failure message="expected 401 got 500">stack trace here</failure>
          </testcase>
          <testcase classname="auth" name="rate limits"><skipped/></testcase>
        </testsuite>
      </testsuites>`;

    const results = parseJunit(xml);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ name: 'signs in', status: 'passed', durationMs: 12 });
    expect(results[1]).toMatchObject({ status: 'failed', message: 'expected 401 got 500' });
    expect(results[2]?.status).toBe('skipped');
  });
});
