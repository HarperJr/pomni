import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowSchema, type Drain } from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';
import { runCli } from './cli.js';

/**
 * POMN-74: the CLI half of the drain loop — `pomni backlog waves --run --all`, and the
 * `task list` / `task show` surfacing of the drain record `PipelineService.drain()` already
 * produces (see `tests/drain.test.ts`, which is green on this branch).
 *
 * Nothing under test exists yet: `backlog-commands.ts`'s `waves --run` only ever launches
 * wave 1, has no `--all`, `--keep-going`, `--max-items` or `--max-cost` option, and
 * `workflow-commands.ts`'s `task list` / `task show` know only about runs, never drains.
 *
 * No `cli-drain-surface.md` handover was attached to this task (the resumed run's own note
 * says a `cli-drain-surface.md` handover was supposed to fix these names and did not arrive
 * either time). The flags, JSON shapes and exit codes below are inferred from: the attached
 * `drain-schema.md` / `drain-events.md` / `drain-service-api.md` handovers (settled, and
 * already implemented in `packages/core`), the acceptance criteria's own wording (which
 * names `--keep-going`, `--max-items N`, `--max-cost <usd>`, `--all` literally), and the
 * existing conventions in `backlog-commands.ts` (`waves --run`, `out().report`) and
 * `workflow-commands.ts` (`task list`, `task show <id>`, `resolveRun`). Treat the exact
 * shapes here as a proposal for the CLI author to confirm or correct, not as settled fact —
 * flagged explicitly because the task asked for exactly that when a handover is missing.
 */

let harness: TestHarness;

const verdict = (outcome: string, unmet: string[] = []) =>
  ['```json', JSON.stringify({ outcome, unmet }), '```'].join('\n');
const pass = () => `Done.\n\n${verdict('done')}`;
const askHuman = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'human', task }] }), '```'].join('\n');

/**
 * Same shape `tests/drain.test.ts` seeds: a flow with a single `in_progress -> done` automatic
 * arrow, so a drain-launched run that passes actually unlocks a dependant in the next wave —
 * the built-in flow's `in_progress -> in_review` only arrow never reaches `done` on its own.
 */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme', id: 'acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the work.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('discovery', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
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

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('backlog waves --run, without --all', () => {
  it('still launches only wave 1 and creates no drain', async () => {
    await readyItem('A', { touches: ['src/a.ts'] });
    await readyItem('B', { touches: ['src/b.ts'] });
    harness.llm.replies = [pass(), pass()];

    const result = await runCli(harness, ['--json', 'backlog', 'waves', '-p', 'acme', '--run']);

    expect(result.code).toBe(0);
    expect(await harness.pipelines.listDrains({})).toHaveLength(0);
  });
});

describe('backlog waves --run --all', () => {
  it('launches every wave, re-planning between them, and exits 0 on an all-green drain', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    const b = await readyItem('B', { touches: ['src/b.ts'] });
    const c = await readyItem('C', { touches: ['src/c.ts'], dependsOn: [a.id] });
    harness.llm.replies = [pass(), pass(), pass()];

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
    ]);

    expect(result.code).toBe(0);
    const drain = result.last as Drain & { runs?: unknown[] };
    expect(drain.status).toBe('completed');
    expect(drain.waves).toHaveLength(2);
    expect(drain.waves[0]?.itemIds).toEqual([a.id, b.id]);
    expect(drain.waves[1]?.itemIds).toEqual([c.id]);
    expect(Array.isArray(drain.runs)).toBe(true);
    expect(drain.runs).toHaveLength(3);

    const stored = await harness.pipelines.getDrain(drain.id);
    expect(stored).not.toBeNull();
  });
});

describe('a red gate stops the drain', () => {
  async function seedRedGate(): Promise<{ a: { id: string }; b: { id: string } }> {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    const b = await readyItem('B', { touches: ['src/b.ts'] });
    await readyItem('C', { touches: ['src/c.ts'], dependsOn: [b.id] });
    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  1 failed (1)' }];
    harness.llm.replies = [pass()];
    return { a, b };
  }

  it('exits 1 with stopReason.kind red_gate and launches nothing after it', async () => {
    const { a } = await seedRedGate();

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
    ]);

    expect(result.code).toBe(1);
    const drain = result.last as Drain;
    expect(drain.status).toBe('stopped');
    expect(drain.stopReason?.kind).toBe('red_gate');
    if (drain.stopReason?.kind === 'red_gate') {
      expect(drain.stopReason.itemId).toBe(a.id);
    }
    expect(drain.waves).toHaveLength(1);
  });

  it('ends the human output with the stopped summary line', async () => {
    await seedRedGate();

    const result = await runCli(harness, ['backlog', 'waves', '-p', 'acme', '--run', '--all']);

    expect(result.code).toBe(1);
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    expect(last).toContain('stopped:');
    expect(last).toContain('red gate');
  });
});

describe('--keep-going', () => {
  it('skips only the dependants of the red item, and carries on with the rest', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    const b = await readyItem('B', { touches: ['src/b.ts'] });
    const c = await readyItem('C', { touches: ['src/c.ts'], dependsOn: [a.id] });
    const d = await readyItem('D', { touches: ['src/d.ts'], dependsOn: [b.id] });

    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  1 failed (1)' }];
    let sawAFinish = false;
    harness.events.subscribe((event) => {
      if (event.type === 'pipeline.finished' && !sawAFinish) {
        sawAFinish = true;
        harness.executor.script = [];
      }
    });
    harness.llm.replies = [pass(), pass(), pass()];

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
      '--keep-going',
    ]);

    expect(result.code).toBe(1);
    const drain = result.last as Drain & { runs?: Array<{ itemId: string; status: string }> };
    expect(drain.status).toBe('completed');
    expect(drain.skippedItemIds).toEqual([c.id]);

    const dRun = drain.runs?.find((run) => run.itemId === d.id);
    expect(dRun).toBeTruthy();
    expect(dRun?.status).toBe('passed');
  });
});

describe('a run asking a question stops the drain', () => {
  it('reports stopReason.kind question, naming the run, and exits 1', async () => {
    await readyItem('Only', { touches: ['src/only.ts'] });
    harness.llm.replies = [askHuman('Which layout?')];

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
    ]);

    expect(result.code).toBe(1);
    const drain = result.last as Drain;
    expect(drain.stopReason?.kind).toBe('question');

    const [question] = await harness.pipelines.openQuestions();
    expect(question).toBeTruthy();
    if (drain.stopReason?.kind === 'question') {
      expect(drain.stopReason.runId).toBe(question?.runId);
    }

    if (question) await harness.pipelines.answer(question.id, 'Either one.');
  });
});

describe('cost and item ceilings', () => {
  it('--max-cost stops the drain with stopReason.kind max_cost and exits 1', async () => {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    await readyItem('B', { touches: ['src/b.ts'], dependsOn: [a.id] });
    harness.llm.costUsd = 3;
    harness.llm.replies = [pass()];

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
      '--max-cost',
      '2',
    ]);

    expect(result.code).toBe(1);
    const drain = result.last as Drain;
    expect(drain.stopReason?.kind).toBe('max_cost');
    if (drain.stopReason?.kind === 'max_cost') {
      expect(drain.stopReason.limitUsd).toBe(2);
    }
  });

  it('--max-items 1 stops after one launch with stopReason.kind max_items', async () => {
    await readyItem('X', { touches: ['src/x.ts'] });
    await readyItem('Y', { touches: ['src/y.ts'] });
    harness.llm.replies = [pass()];

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
      '--max-items',
      '1',
    ]);

    expect(result.code).toBe(1);
    const drain = result.last as Drain;
    expect(drain.itemsLaunched).toBe(1);
    expect(drain.stopReason?.kind).toBe('max_items');
  });
});

describe('validation', () => {
  it('rejects --keep-going without --all, launching nothing', async () => {
    await readyItem('A', { touches: ['src/a.ts'] });

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--keep-going',
    ]);

    expect(result.code).toBe(2);
    // Distinguishes the intended failure (a `ValidationError` because `--keep-going` makes no
    // sense without `--all`) from the accidental one commander gives today, before `--all` and
    // `--keep-going` are even registered options: both currently exit 2, but with `code:
    // 'usage'`, not `'validation'` — this assertion is what makes the test red for the right
    // reason ahead of the CLI existing, rather than passing by coincidence.
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('validation');
    expect(await harness.pipelines.listDrains({})).toHaveLength(0);
  });

  it('rejects --max-items without --all, launching nothing', async () => {
    await readyItem('A', { touches: ['src/a.ts'] });

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--max-items',
      '1',
    ]);

    expect(result.code).toBe(2);
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('validation');
    expect(await harness.pipelines.listDrains({})).toHaveLength(0);
  });

  it('rejects a non-positive --max-items', async () => {
    await readyItem('A', { touches: ['src/a.ts'] });

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
      '--max-items',
      '0',
    ]);

    expect(result.code).toBe(2);
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('validation');
  });

  it('rejects a negative --max-cost', async () => {
    await readyItem('A', { touches: ['src/a.ts'] });

    const result = await runCli(harness, [
      '--json',
      'backlog',
      'waves',
      '-p',
      'acme',
      '--run',
      '--all',
      '--max-cost',
      '-1',
    ]);

    expect(result.code).toBe(2);
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('validation');
  });
});

describe('task list and task show know about drains', () => {
  async function runADrain(): Promise<Drain> {
    const a = await readyItem('A', { touches: ['src/a.ts'] });
    await readyItem('B', { touches: ['src/b.ts'], dependsOn: [a.id] });
    harness.llm.replies = [pass(), pass()];
    const { completion } = await harness.pipelines.drain({ projectId: 'acme' });
    return completion;
  }

  it('lists the drain beside runs, in both human and --json output', async () => {
    const drain = await runADrain();

    const jsonResult = await runCli(harness, ['--json', 'task', 'list', '-p', 'acme']);
    expect(jsonResult.code).toBe(0);
    const body = jsonResult.last as { drains: Array<{ id: string }> };
    expect(Array.isArray(body.drains)).toBe(true);
    expect(body.drains.map((entry) => entry.id)).toContain(drain.id);

    const humanResult = await runCli(harness, ['task', 'list', '-p', 'acme']);
    expect(humanResult.code).toBe(0);
    expect(humanResult.stdout).toContain(drain.id.slice(-8));
  });

  it('breaks a drain down by waves, runs and stop reason', async () => {
    const drain = await runADrain();

    const result = await runCli(harness, ['--json', 'task', 'show', drain.id]);

    expect(result.code).toBe(0);
    const body = result.last as Drain & { runs?: unknown[] };
    expect(body.id).toBe(drain.id);
    expect(body.waves).toHaveLength(drain.waves.length);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.stopReason).toEqual(drain.stopReason);
  });

  it('exits 3 with a not_found envelope for a drain id that matches nothing', async () => {
    const result = await runCli(harness, ['--json', 'task', 'show', '01NOSUCHDRAIN000000000000']);

    expect(result.code).toBe(3);
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
