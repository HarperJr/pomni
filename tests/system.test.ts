import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRestartAdapter } from '@pomni/infra';
import { createHarness, FakeExecutor, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

/** One repo declaring a slow `test` capability, so a capability run can be held in flight. */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  const apiPath = await makeNodeRepo(join(harness.dir, 'api'), {
    scripts: { test: 'vitest run' },
    devDependencies: {},
  });
  await (await harness.repos.add('acme', { source: { kind: 'local', path: apiPath }, id: 'api' }))
    .completion;

  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the question.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('discovery', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.attach('acme', 'discovery');
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('restarting while work is in flight', () => {
  it('refuses a capability run in flight, naming it, without building or replacing', async () => {
    harness.executor.script = [{ match: /run test/, exitCode: 0, delayMs: 300 }];
    const pending = harness.runs.run('acme', 'test', { repoId: 'api' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const result = await harness.system.restartServer();

    expect(result.outcome).toBe('runs-in-flight');
    if (result.outcome !== 'runs-in-flight') throw new Error('unreachable');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ kind: 'capability', projectId: 'acme', what: 'test in api' });
    expect(harness.restart.buildCalls).toBe(0);
    expect(harness.restart.replaceCalls).toHaveLength(0);

    // Cancelling and proceeding is a second, deliberate call — not a retry of the same one.
    const proceeded = await harness.system.restartServer({ cancelInFlight: true });
    expect(proceeded.outcome).toBe('restarting');
    expect(harness.restart.buildCalls).toBe(1);
    expect(harness.restart.replaceCalls).toHaveLength(1);

    // Read the row immediately: the executor is a fake and does not actually stop running,
    // so the background `run()` call later overwrites this row with its own outcome once its
    // delay elapses. `cancel()`'s own return value, and the row read right after it, are what
    // prove the cancellation happened — not the eventual state of a process nothing killed.
    const runId = result.runs[0]!.id;
    expect((await harness.runs.get(runId)).status).toBe('cancelled');

    await Promise.allSettled([pending]);
  });

  it('refuses a pipeline run in flight, naming the task, without building or replacing', async () => {
    // Held mid-answer via the LLM gate, so there is a genuinely running pipeline row.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.llm.gate = () => held;
    const inFlight = await harness.pipelines.start({ projectId: 'acme', task: 'Ship the thing' });

    try {
      const result = await harness.system.restartServer();

      expect(result.outcome).toBe('runs-in-flight');
      if (result.outcome !== 'runs-in-flight') throw new Error('unreachable');
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({
        kind: 'pipeline',
        id: inFlight.run.id,
        projectId: 'acme',
        what: 'Ship the thing',
      });
      expect(harness.restart.buildCalls).toBe(0);
      expect(harness.restart.replaceCalls).toHaveLength(0);

      const proceeded = await harness.system.restartServer({ cancelInFlight: true });
      expect(proceeded.outcome).toBe('restarting');
      if (proceeded.outcome !== 'restarting') throw new Error('unreachable');
      expect(proceeded.cancelled).toHaveLength(1);
      expect(proceeded.cancelled[0]?.id).toBe(inFlight.run.id);

      // The orchestrator is mid-turn behind the gate, so cancellation is a flag it notices on
      // its next turn, not an instant status flip. Release it and let that turn happen.
      release();
      const settled = await inFlight.completion;
      expect(settled.status).toBe('cancelled');
    } finally {
      release();
      await Promise.allSettled([inFlight.completion]);
    }
  });
});

describe('restarting when the build fails', () => {
  it('leaves the old process alive and returns the failing step’s output', async () => {
    harness.restart.buildResult = {
      ok: false,
      steps: [
        { cmd: 'npm run build', exitCode: 0, output: 'built the workspace\n' },
        { cmd: 'npm run build:web', exitCode: 1, output: 'ERROR: Cannot find module ./missing\n' },
      ],
    };

    const result = await harness.system.restartServer();

    expect(result.outcome).toBe('build-failed');
    if (result.outcome !== 'build-failed') throw new Error('unreachable');
    expect(result.build.ok).toBe(false);
    expect(result.build.steps).toHaveLength(2);
    expect(result.build.steps[1]).toEqual({
      cmd: 'npm run build:web',
      exitCode: 1,
      output: 'ERROR: Cannot find module ./missing\n',
    });
    // The process was never told to replace itself.
    expect(harness.restart.replaceCalls).toHaveLength(0);
  });
});

describe('reporting whether the server is behind the repo', () => {
  it('reports the started-at commit and HEAD differing once the repo moves past boot', async () => {
    harness.git.trackRepo(harness.dir, { head: 'commit-at-boot' });
    await harness.system.boot();

    const atBoot = await harness.system.health({ build: 'app.abc123.js' });
    expect(atBoot.server.startedAtCommit).toBe('commit-at-boot');
    expect(atBoot.server.headCommit).toBe('commit-at-boot');
    expect(atBoot.server.behindRepo).toBe(false);

    // A merge landed after this process started serving.
    harness.git.trackRepo(harness.dir, { head: 'commit-after-merge' });

    const afterMerge = await harness.system.health({ build: 'app.abc123.js' });
    expect(afterMerge.server.startedAtCommit).toBe('commit-at-boot');
    expect(afterMerge.server.headCommit).toBe('commit-after-merge');
    expect(afterMerge.server.behindRepo).toBe(true);

    // The pre-existing fields still read the way health has always reported them.
    expect(afterMerge.ok).toBe(true);
    expect(afterMerge.build).toBe('app.abc123.js');
    expect(afterMerge.root).toBe(harness.root);
    expect(afterMerge.git).toBe(true);
    expect(afterMerge.initialized).toBe(true);
  });

  it('does not call it behind when the checkout is not a git repo at all', async () => {
    // `dir` was never handed to `trackRepo`, so this models an install with no HEAD to compare —
    // a tarball install, not a merge nobody has picked up yet.
    await harness.system.boot();

    const health = await harness.system.health({ build: null });

    expect(health.server.startedAtCommit).toBeNull();
    expect(health.server.headCommit).toBeNull();
    expect(health.server.behindRepo).toBe(false);
  });
});

describe('the empty repoDir the CLI falls back to for a global install', () => {
  it('is a defect: NodeRestartAdapter does not report supervision as unsupported for it', async () => {
    // packages/cli/src/container.ts passes `repoDir: ''` when it cannot find the Pomni
    // checkout it is running from. `supervision()` only ever looks at POMNI_SUPERVISED and
    // whether a TTY is attached — never at repoDir — so an empty repoDir is indistinguishable
    // from a perfectly good one. In a non-interactive test runner (no TTY, no supervisor env)
    // that reports 'self': a restart button that will "rebuild" and spawn a successor in an
    // empty working directory, not the directory Pomni is actually checked out in.
    const adapter = new NodeRestartAdapter({
      repoDir: '',
      logger: harness.logger,
      executor: new FakeExecutor(),
    });

    const supervision = await adapter.supervision();

    expect(supervision.mode).toBe('self');
    expect(supervision.mode).not.toBe('unsupported');
  });
});
