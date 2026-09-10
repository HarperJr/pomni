import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PipelineStepSchema } from '@pomni/core';
import { watcher } from '@pomni/infra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * Stopping a session part-way through, for money.
 *
 * The check between steps is not enough on its own, and the run that proved it is the one
 * this file is about: $16.37 against a stated $10, because one step spent $7.77 after being
 * admitted at $8.12. Nothing was wrong with the decision to admit it — the ceiling had not
 * been reached — and nothing existed to stop it once it was running.
 */

let harness: TestHarness;

/** An orchestrator and one analyst, both prompted. A workflow is not ready without both. */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
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

/** A tracked repo whose worktree is always cut, so a run has something to commit. */
async function attachRepo(name: string): Promise<string> {
  const dir = await makeNodeRepo(join(harness.dir, name));
  harness.git.trackRepo(dir);
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    role: 'lib',
  });
  await completion;
  await harness.repos.update('acme', repo.id, { worktrees: 'always' });
  return repo.id;
}

/**
 * A finished run, so the store knows what a token costs on this model.
 *
 * The mid-session check is only as good as its rate, and the rate is measured from what has
 * already been paid. With no history there is nothing to measure and the check declines to
 * guess — which is exactly what the last test here asserts.
 */
async function priorSpend(costUsd: number): Promise<void> {
  harness.llm.costUsd = costUsd;
  const first = await harness.pipelines.start({ projectId: 'acme', task: 'the run before' });
  await first.completion;
}

const usage = (tokens: number) => ({
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a session that crosses the ceiling part-way through', () => {
  it('is cut off mid-turn, marked cancelled and partial, and keeps what it said', async () => {
    await attachRepo('web');
    // 0.06 over 30 tokens: $0.002 a token. Each 30-token turn below therefore costs $0.06,
    // so a $0.10 ceiling is intact after one turn and crossed on the second.
    await priorSpend(0.06);
    await harness.projects.update('acme', { policy: { maxCostUsd: 0.1 } });
    harness.llm.turnUsage = [usage(30), usage(30), usage(30)];
    harness.llm.partialText = 'I have read the domain and started on the service.';

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });

    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    await writeFile(join(path, 'delivered.ts'), 'export const whole = true;\n');

    const finished = await completion;
    const steps = await harness.pipelineStore.steps(run.id);
    const stopped = steps.at(-1);

    // Cancelled, not done. A step reported as done is one somebody reads as having finished.
    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.outcome).toBe('partial');
    expect(stopped?.output).toContain('I have read the domain and started on the service.');
    expect(stopped?.output).toContain('stopped part-way through its 2nd turn');
    expect(stopped?.error).toContain('policy.maxCostUsd');

    // It never reached the third turn it was willing to take.
    expect(stopped?.turns).toBe(2);

    // Charged at the measured rate, because the provider's own figure never arrived. Two
    // turns of 30 tokens at $0.002 is $0.12 — over the ceiling by one turn, which is the
    // whole of what this can promise.
    expect(stopped?.costUsd).toBeCloseTo(0.12, 5);
    expect(finished.costUsd).toBeCloseTo(0.12, 5);

    // The run says it stopped, and says why.
    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBe('blocked');
    expect(finished.error).toContain('policy.maxCostUsd');

    // What it had already done is committed, and the worktree is gone all the same.
    expect(harness.git.commits).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });

  it('leaves a run under the ceiling alone', async () => {
    await priorSpend(0.06);
    await harness.projects.update('acme', { policy: { maxCostUsd: 10 } });
    harness.llm.turnUsage = [usage(30), usage(30), usage(30)];
    harness.llm.reply = 'Yes, and here is why.';

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    const finished = await completion;
    const steps = await harness.pipelineStore.steps(run.id);

    expect(finished.status).toBe('passed');
    expect(steps.at(-1)?.status).toBe('done');
    expect(steps.at(-1)?.output).toContain('Yes, and here is why.');
  });

  it('never stops for money when nothing has been paid on the model yet', async () => {
    // No prior run, so no rate. A ceiling this small would stop anything measurable, and it
    // stops nothing: an estimate with no evidence behind it is worse than none, so the money
    // question simply is not asked. The turn question still is — it needs no rate — which is
    // why the ceiling here is set out of the way.
    await harness.projects.update('acme', {
      policy: { maxCostUsd: 0.000001, maxSessionTurns: 100 },
    });
    harness.llm.turnUsage = [usage(30), usage(30)];
    harness.llm.reply = 'Yes, and here is why.';

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    const finished = await completion;
    const steps = await harness.pipelineStore.steps(run.id);

    expect(steps.at(-1)?.status).toBe('done');
    expect(finished.error).toBeNull();
  });
});

describe('what a token has cost on a model', () => {
  it('is measured from the steps that recorded both, and is absent until one has', async () => {
    const store = harness.pipelineStore;
    expect(await store.rate('claude-sonnet-5')).toBeNull();

    const step = (id: string, model: string, cost: number | null, tokens: number) =>
      PipelineStepSchema.parse({
        id,
        runId: 'run-1',
        parentStepId: null,
        agentId: 'lead',
        agentName: 'Lead',
        role: 'orchestrator',
        providerId: 'claude-code',
        model,
        task: 'work',
        status: 'done',
        output: 'done',
        error: null,
        depth: 0,
        startedAt: '2026-09-10T00:00:00.000Z',
        endedAt: '2026-09-10T00:01:00.000Z',
        durationMs: 60_000,
        inputTokens: tokens,
        outputTokens: 0,
        costUsd: cost,
      });

    await store.insertStep(step('s1', 'claude-sonnet-5', 0.6, 300));
    await store.insertStep(step('s2', 'claude-sonnet-5', 0.4, 100));
    // Neither of these may move the answer: one is a different model, and the other is a
    // provider that reported no price at all.
    await store.insertStep(step('s3', 'claude-opus-5', 9, 10));
    await store.insertStep(step('s4', 'claude-sonnet-5', null, 1000));

    // $1.00 over 400 tokens.
    expect(await store.rate('claude-sonnet-5')).toBeCloseTo(0.0025, 8);
  });
});

describe('counting a streamed session by its requests', () => {
  it('counts one turn per request however many frames it prints', () => {
    const seen: number[] = [];
    const watch = watcher((used) => {
      seen.push(used.turns);
      return null;
    });

    const frame = (requestId: string, tokens: number) =>
      JSON.stringify({
        type: 'assistant',
        request_id: requestId,
        message: { usage: { input_tokens: tokens, output_tokens: 1 } },
      });

    // One request, three frames: thinking, prose, a tool call. One turn, one bill.
    watch.line(frame('req-1', 100));
    watch.line(frame('req-1', 100));
    watch.line(frame('req-1', 100));
    watch.line(frame('req-2', 50));

    expect(seen).toEqual([1, 2]);
    expect(watch.used.inputTokens).toBe(150);
    expect(watch.used.outputTokens).toBe(2);
    expect(watch.used.turns).toBe(2);
  });

  it('ignores anything that is not an assistant turn, and stops when told to', () => {
    const watch = watcher((used) => (used.turns >= 2 ? 'enough' : null));

    expect(watch.line('not json at all')).toBeNull();
    expect(watch.line('{ broken')).toBeNull();
    expect(watch.line(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
    expect(
      watch.line(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 9 } } })),
    ).toBeNull();

    const turn = (requestId: string) =>
      JSON.stringify({
        type: 'assistant',
        request_id: requestId,
        message: { usage: { input_tokens: 10, output_tokens: 5 } },
      });

    expect(watch.line(turn('req-1'))).toBeNull();
    expect(watch.line(turn('req-2'))).toBe('enough');
    // Once stopped it stays stopped, and stops counting.
    expect(watch.line(turn('req-3'))).toBe('enough');
    expect(watch.used.turns).toBe(2);
    expect(watch.stoppedBy).toBe('enough');
  });

  it('is never consulted when the caller has no check to make', () => {
    const watch = watcher(undefined);
    expect(
      watch.line(
        JSON.stringify({
          type: 'assistant',
          request_id: 'req-1',
          message: { usage: { input_tokens: 10 } },
        }),
      ),
    ).toBeNull();
    expect(watch.used.turns).toBe(0);
    expect(watch.stoppedBy).toBeNull();
  });
});

describe('a session that keeps taking turns', () => {
  it('is stopped on the turn that reaches the ceiling, and keeps what it wrote', async () => {
    await attachRepo('web');
    await harness.projects.update('acme', { policy: { maxSessionTurns: 3 } });
    harness.llm.turnUsage = [usage(10), usage(10), usage(10), usage(10), usage(10)];
    harness.llm.partialText = 'I got as far as the domain.';

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });

    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    await writeFile(join(path, 'delivered.ts'), 'export const whole = true;\n');

    const finished = await completion;
    const steps = await harness.pipelineStore.steps(run.id);
    const stopped = steps.at(-1);

    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.outcome).toBe('partial');
    expect(stopped?.turns).toBe(3);
    expect(stopped?.output).toContain('I got as far as the domain.');
    expect(stopped?.output).toContain('stopped on its 3rd turn');
    expect(stopped?.error).toContain('policy.maxSessionTurns');

    // No rate exists here — nothing has been paid on this model — and the turn count needs
    // none. It is counted, not estimated.
    expect(finished.error).toContain('policy.maxSessionTurns');
    expect(harness.git.commits).toHaveLength(1);
  });

  it('leaves a session under the ceiling alone', async () => {
    await harness.projects.update('acme', { policy: { maxSessionTurns: 50 } });
    harness.llm.turnUsage = [usage(10), usage(10), usage(10)];
    harness.llm.reply = 'Yes, and here is why.';

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    const finished = await completion;
    const steps = await harness.pipelineStore.steps(run.id);

    expect(finished.status).toBe('passed');
    expect(steps.at(-1)?.status).toBe('done');
  });

  it('never stops a provider that reports no turns at all', async () => {
    await harness.projects.update('acme', { policy: { maxSessionTurns: 1 } });
    // `turnUsage` empty: the fake answers without ever reporting a turn, the way a provider
    // that streams nothing does. An unmeasured session must not read as an infinite one.
    harness.llm.reply = 'Yes, and here is why.';

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    const finished = await completion;
    const steps = await harness.pipelineStore.steps(run.id);

    expect(finished.status).toBe('passed');
    expect(steps.at(-1)?.status).toBe('done');
  });

  it('is offered even with no cost ceiling, because turns need no rate to count', async () => {
    await harness.projects.update('acme', {
      policy: { maxCostUsd: undefined, maxSessionTurns: 2 },
    });
    harness.llm.turnUsage = [usage(10), usage(10), usage(10)];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;
    const steps = await harness.pipelineStore.steps(run.id);

    expect(steps.at(-1)?.status).toBe('cancelled');
    expect(steps.at(-1)?.turns).toBe(2);
  });
});
