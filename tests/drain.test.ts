import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlowSchema,
  drainRunIds,
  drainSucceeded,
  type Drain,
  type PipelineRun,
} from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * POMN-74: `pipelines.drain()` launches wave 1, waits for it, re-plans from the
 * then-current backlog, and keeps going until nothing is ready or a stop condition fires.
 *
 * Nothing under test exists yet — `packages/core/src/app/pipeline-service.ts` has no
 * `drain()`, `getDrain()` or `listDrains()`, `domain/pipeline.ts` has no `Drain` record, and
 * `@pomni/core` exports neither `drainRunIds` nor `drainSucceeded`. Every test here is
 * expected to fail today, and the point of the file is that it fails for that reason and no
 * other once the service exists.
 *
 * The call shape assumed below — `harness.pipelines.drain({ projectId, keepGoing, maxItems,
 * maxCostUsd })` returning `{ drain, completion }`, mirroring `start()` — is inferred from
 * the drain-schema handover and from `PipelineService.start()`'s own shape; the
 * drain-service-api handover that was supposed to fix these names was not attached to this
 * task, so the service author should treat the exact method/option names here as a proposal
 * to confirm or correct, not as settled.
 */

let harness: TestHarness;

const verdict = (outcome: string, unmet: string[] = []) =>
  ['```json', JSON.stringify({ outcome, unmet }), '```'].join('\n');

/** A clean pass: the orchestrator does the work itself and says so. */
const pass = () => `Done.\n\n${verdict('done')}`;

const askHuman = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'human', task }] }), '```'].join('\n');

/**
 * One orchestrator, one repo eligible for its own worktree, and a task flow that goes
 * straight from `in_progress` to `done` on a green gate.
 *
 * The built-in flow will not do for this: its only automatic arrow is
 * `in_progress -> in_review` (see `flow-auto.test.ts`, "leaves the built-in flow with exactly
 * one automatic arrow") — reaching `done` is always a person's decision, made by hand, one
 * `backlog.transition` at a time. `BacklogService.reevaluate` also fires at most one automatic
 * arrow per call (see its own comment: "calls `nextAutoMove` exactly once and performs at
 * most one move"), so even a flow that chained `in_progress -> in_review -> done` as two
 * automatic arrows would not reach `done` in the one `reevaluate` a finishing run triggers.
 *
 * Consequence for the service author: **a passing drain-launched run does not, by itself,
 * move its item to `done` under the flow a fresh project ships with.** Since `planWaves`
 * only treats a dependency as satisfied once the item it points at is `status: 'done'`
 * (`schedule.ts`, "A dependency is satisfied when it is done"), a real drain running on the
 * built-in flow could never re-plan its way past a wave-1 item unlocking a wave-2 dependant —
 * the exact scenario POMN-74's acceptance criteria opens with. The tests below give the
 * project a flow with a single `in_progress -> done` automatic arrow so that scenario is
 * actually exercised; a project running the shipped default flow would need either a person
 * in the loop or a different mechanism, and that gap is worth settling before this ships.
 */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the work.',
    prompt: 'You lead.',
  });
  await harness.workflows.attach('acme', 'discovery');

  const dir = await makeNodeRepo(join(harness.dir, 'web'));
  harness.git.trackRepo(dir);
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    id: 'web',
  });
  await completion;
  await harness.repos.update('acme', repo.id, { worktrees: 'always' });

  await harness.projects.update('acme', {
    taskFlow: FlowSchema.parse({
      initial: 'ready',
      states: ['ready', 'in_progress', 'done', 'blocked'],
      transitions: [
        { from: 'ready', to: 'in_progress' },
        { from: 'in_progress', to: 'done', mode: 'auto', requires: { gate: 'default' } },
        { from: 'in_progress', to: 'blocked' },
      ],
    }),
  });
}

/** A `ready` item — the flow above starts every item there — with a non-overlapping path. */
async function readyItem(
  title: string,
  options: { touches?: string[]; dependsOn?: string[] } = {},
): Promise<{ id: string }> {
  const item = await harness.backlog.create('acme', {
    title,
    repos: ['web'],
    dependsOn: options.dependsOn ?? [],
  });
  if (options.touches) {
    await harness.backlog.update('acme', item.id, { touches: options.touches });
  }
  return item;
}

/** Every launched run, in wave then item order — what `drainRunIds` is for. */
async function launchedRuns(drain: Drain): Promise<PipelineRun[]> {
  return Promise.all(drainRunIds(drain).map((id) => harness.pipelines.get(id)));
}

/** The invariants every drain must hold, whatever stopped it or didn't. */
async function assertInvariants(drain: Drain): Promise<void> {
  expect(drain.status === 'running').toBe(drain.endedAt === null);
  expect(drain.stopReason !== null).toBe(drain.status === 'stopped');

  const runIdsByWave = drain.waves.flatMap((wave) => wave.runIds);
  expect(drain.itemsLaunched).toBe(runIdsByWave.length);
  expect(new Set(runIdsByWave).size).toBe(runIdsByWave.length);

  const reloaded = await harness.pipelines.getDrain(drain.id);
  expect(reloaded).toEqual(drain);
  const listed = await harness.pipelines.listDrains({ projectId: drain.projectId });
  expect(listed.map((entry) => entry.id)).toContain(drain.id);
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('draining the whole queue', () => {
  it('re-plans between waves so a run finishing one item unblocks its dependant', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    const b = await readyItem('B', { touches: ['src/b.ts'] });
    const c = await readyItem('C', { touches: ['src/c.ts'], dependsOn: [a.id] });

    harness.llm.replies = [pass(), pass(), pass()];

    const { completion } = await harness.pipelines.drain({ projectId: 'acme' });
    const drain = await completion;

    expect(drain.status).toBe('completed');
    expect(drain.stopReason).toBeNull();
    expect(drain.itemsLaunched).toBe(3);

    expect(drain.waves).toHaveLength(2);
    expect(drain.waves[0]?.itemIds).toEqual([a.id, b.id]);
    expect(drain.waves[1]?.itemIds).toEqual([c.id]);

    const runs = await launchedRuns(drain);
    expect(drainSucceeded(drain, runs)).toBe(true);
    for (const run of runs) expect(run.drainId).toBe(drain.id);

    for (const wave of drain.waves) {
      wave.itemIds.forEach((itemId, index) => {
        const runId = wave.runIds[index];
        const run = runs.find((candidate) => candidate.id === runId);
        expect(run?.itemId).toBe(itemId);
      });
    }

    await assertInvariants(drain);
  });

  it('stops at the first run whose gate goes red, and launches nothing after it', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    const b = await readyItem('B', { touches: ['src/b.ts'] });
    await readyItem('C', { touches: ['src/c.ts'], dependsOn: [b.id] });

    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  1 failed (1)' }];
    harness.llm.replies = [pass()];

    const { completion } = await harness.pipelines.drain({ projectId: 'acme' });
    const drain = await completion;

    expect(drain.status).toBe('stopped');
    expect(drain.stopReason?.kind).toBe('red_gate');
    if (drain.stopReason?.kind === 'red_gate') {
      expect(drain.stopReason.itemId).toBe(a.id);
    }
    expect(drain.waves).toHaveLength(1);
    expect(drain.itemsLaunched).toBe(1);
    // B was next in the same wave and never got the chance.
    expect(drain.waves[0]?.itemIds).toEqual([a.id, b.id]);
    expect(drain.waves[0]?.runIds).toHaveLength(1);

    const runs = await launchedRuns(drain);
    expect(drainSucceeded(drain, runs)).toBe(false);

    await assertInvariants(drain);
  });

  it('--keep-going skips only the dependants of the red item and carries on', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    const b = await readyItem('B', { touches: ['src/b.ts'] });
    const c = await readyItem('C', { touches: ['src/c.ts'], dependsOn: [a.id] });
    const d = await readyItem('D', { touches: ['src/d.ts'], dependsOn: [b.id] });

    // A's gate is red; B's (and D's) must not be, or nothing here distinguishes "skipped
    // because it depends on the red item" from "skipped because everything after A failed
    // too". The executor has no per-worktree state, so the test flips the script back to
    // green itself, on the first `pipeline.finished` — which is A's, since A is first in
    // wave 1's item order and runs are launched one at a time.
    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  1 failed (1)' }];
    let sawAFinish = false;
    harness.events.subscribe((event) => {
      if (event.type === 'pipeline.finished' && !sawAFinish) {
        sawAFinish = true;
        harness.executor.script = [];
      }
    });

    harness.llm.replies = [pass(), pass(), pass()];

    const { completion } = await harness.pipelines.drain({ projectId: 'acme', keepGoing: true });
    const drain = await completion;

    expect(drain.status).toBe('completed');
    expect(drain.stopReason).toBeNull();
    expect(drain.skippedItemIds).toEqual([c.id]);
    expect(drainSucceeded(drain, await launchedRuns(drain))).toBe(false);

    // D depended on B, which passed — it must have been launched, in a wave after the first.
    const dRun = (await launchedRuns(drain)).find(
      (run) => run.itemId === d.id,
    );
    expect(dRun).toBeTruthy();
    expect(dRun?.status).toBe('passed');
    const dWaveIndex = drain.waves.findIndex((wave) => wave.itemIds.includes(d.id));
    expect(dWaveIndex).toBeGreaterThan(0);

    await assertInvariants(drain);
  });

  it('stops on a question, without cancelling the run that asked it', async () => {
    await readyItem('Only', { touches: ['src/only.ts'] });
    harness.llm.replies = [askHuman('Which layout?')];

    const { completion } = await harness.pipelines.drain({ projectId: 'acme' });
    const drain = await completion;

    expect(drain.status).toBe('stopped');
    expect(drain.endedAt).not.toBeNull();
    expect(drain.stopReason?.kind).toBe('question');

    const [question] = await harness.pipelines.openQuestions();
    expect(question).toBeTruthy();
    if (drain.stopReason?.kind === 'question') {
      expect(question?.id).toBe(drain.stopReason.questionId);
      expect(question?.runId).toBe(drain.stopReason.runId);
    }

    const runs = await launchedRuns(drain);
    expect(runs).toHaveLength(1);
    // Still running: a drain that stops must not reach for the run it is waiting on.
    expect(runs[0]?.status).toBe('running');

    await assertInvariants(drain);

    // Close it out so nothing outlives the test.
    if (question) await harness.pipelines.answer(question.id, 'Either one.');
  });

  it('stops once spend crosses the ceiling, after the run that crossed it', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    await readyItem('B', { touches: ['src/b.ts'], dependsOn: [a.id] });

    harness.llm.costUsd = 3;
    harness.llm.replies = [pass()];

    const { completion } = await harness.pipelines.drain({ projectId: 'acme', maxCostUsd: 2 });
    const drain = await completion;

    expect(drain.status).toBe('stopped');
    expect(drain.stopReason?.kind).toBe('max_cost');
    if (drain.stopReason?.kind === 'max_cost') {
      expect(drain.stopReason.limitUsd).toBe(2);
      expect(drain.stopReason.spentUsd).toBe(drain.costUsd);
    }
    expect(drain.waves).toHaveLength(1);
    expect(drain.itemsLaunched).toBe(1);

    const runs = await launchedRuns(drain);
    const total = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    expect(drain.costUsd).toBe(total);
    expect(drain.costUsd).toBeGreaterThan(0);

    await assertInvariants(drain);
  });

  it('maxItems cuts a wave in flight rather than launching the rest of it', async () => {
    await readyItem('X', { touches: ['src/x.ts'] });
    await readyItem('Y', { touches: ['src/y.ts'] });

    harness.llm.replies = [pass()];

    const { completion } = await harness.pipelines.drain({ projectId: 'acme', maxItems: 1 });
    const drain = await completion;

    expect(drain.status).toBe('stopped');
    expect(drain.stopReason?.kind).toBe('max_items');
    expect(drain.itemsLaunched).toBe(1);
    expect(drain.waves).toHaveLength(1);
    expect(drain.waves[0]?.itemIds).toHaveLength(2);
    expect(drain.waves[0]?.runIds).toHaveLength(1);

    await assertInvariants(drain);
  });
});
