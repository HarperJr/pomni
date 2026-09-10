import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

/** An orchestrator and one analyst, both prompted, attached to a project. Matches pipeline.test.ts. */
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
async function attachRepo(name: string): Promise<{ id: string; dir: string }> {
  const dir = await makeNodeRepo(join(harness.dir, name));
  harness.git.trackRepo(dir);
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    role: 'lib',
  });
  await completion;
  await harness.repos.update('acme', repo.id, { worktrees: 'always' });
  return { id: repo.id, dir };
}

const delegate = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task }] }), '```'].join('\n');

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a run that spends past its project ceiling', () => {
  it('stops before the next step, ends failed/blocked, and keeps what it already committed', async () => {
    await attachRepo('web');
    await harness.projects.update('acme', { policy: { maxCostUsd: 0.02 } });
    harness.llm.costUsd = 0.05;
    harness.llm.replies = [delegate('size the market')];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });

    // The worktree exists as soon as start() resolves. Writing into it now is standing in for
    // whatever the entry step would itself have produced before the budget stopped the next one.
    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    await writeFile(join(path, 'delivered.ts'), 'export const whole = true;\n');

    const finished = await completion;

    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBe('blocked');
    const expectedError =
      "this run has spent $0.05 of the $0.02 its project allows (policy.maxCostUsd), so it " +
      "stopped before the next step. What it had already done is committed. Raise the ceiling " +
      "with 'pomni project edit --max-cost <usd>' and resume the run, or leave it here.";
    expect(finished.error).toBe(expectedError);
    expect(finished.unmet).toContain(expectedError);

    // The figure is the real accumulated cost, not the ceiling.
    expect(finished.costUsd).toBeCloseTo(0.05, 5);

    // What it had already done is committed, not thrown away with the worktree.
    expect(harness.git.commits).toHaveLength(1);
    expect(harness.git.commits[0]?.message).toContain(run.id);
    expect(existsSync(path)).toBe(false);
  });
});

describe('a run that reaches its project turn ceiling', () => {
  it('refuses the next step, ends failed/blocked, and keeps what it already committed', async () => {
    await attachRepo('web');
    await harness.projects.update('acme', { policy: { maxTurns: 1 } });
    harness.llm.replies = [delegate('size the market')];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });

    const [held] = await harness.worktrees.list({ runId: run.id });
    const path = held?.path as string;
    await writeFile(join(path, 'delivered.ts'), 'export const whole = true;\n');

    const finished = await completion;

    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBe('blocked');
    const expectedError =
      'this run reached step 2 of the 1 its project allows (policy.maxTurns), so it stopped ' +
      "before running it. What it had already done is committed. Raise the ceiling with " +
      "'pomni project edit --max-turns <n>' and resume the run, or leave it here.";
    expect(finished.error).toBe(expectedError);
    expect(finished.unmet).toContain(expectedError);

    // The refused step never ran: only the entry agent's step is on the record.
    const detail = await harness.pipelines.get(run.id);
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps.some((step) => step.agentId === 'analyst')).toBe(false);

    expect(harness.git.commits).toHaveLength(1);
    expect(harness.git.commits[0]?.message).toContain(run.id);
  });
});

describe('a run under both limits', () => {
  it('finishes normally, with no budget error', async () => {
    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })
    ).completion;

    expect(run.status).toBe('passed');
    expect(run.error).toBeNull();
    expect(run.unmet).toEqual([]);
    expect(run.result).toBe('Build it.');
  });
});

describe('raising the ceiling mid-run', () => {
  it('takes effect on the very next check, without a restart', async () => {
    await harness.projects.update('acme', { policy: { maxCostUsd: 0.02 } });
    harness.llm.costUsd = 0.05;

    // Raise the ceiling from inside the first completion, standing in for a person editing the
    // project while the run is between steps — the check re-reads policy every time it fires.
    let calls = 0;
    const original = harness.llm.complete.bind(harness.llm);
    harness.llm.complete = async (request) => {
      calls += 1;
      if (calls === 1) {
        await harness.projects.update('acme', { policy: { maxCostUsd: 10 } });
      }
      return original(request);
    };

    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })
    ).completion;

    // Three steps, each costing $0.05, sail past the original $0.02 ceiling because it was
    // raised to $10 before the check that would otherwise have stopped the second one.
    expect(run.status).toBe('passed');
    expect(run.error).toBeNull();
    expect(run.costUsd).toBeCloseTo(0.15, 5);
  });
});

describe('what a run reports about its own spend before it bites', () => {
  it('carries spend-so-far and steps-so-far on the step output event', async () => {
    harness.llm.costUsd = 0.1;
    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    const seen: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === 'pipeline.step.output') seen.push(event.chunk);
    });

    await (await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })).completion;
    unsubscribe();

    const budgetLines = seen.filter((chunk) => chunk.includes('Budget:'));
    expect(budgetLines.length).toBeGreaterThan(0);
    expect(
      budgetLines.some((line) =>
        /Budget: \$\d+\.\d{2} of \$5\.00, step \d+ of 200, 50 turns a session\./.test(line),
      ),
    ).toBe(true);
  });
});

describe('a ceiling is raised, never removed', () => {
  it('patching a policy field to undefined falls back to the schema default, not to absent', async () => {
    await harness.projects.update('acme', { policy: { maxCostUsd: 0.02, maxTurns: 5 } });
    const withLimits = await harness.projects.getRef('acme');
    expect(withLimits.data.policy.maxCostUsd).toBe(0.02);
    expect(withLimits.data.policy.maxTurns).toBe(5);

    // What `pomni project edit --no-max-cost --no-max-turns` sends: an explicit `undefined`.
    // There is no "no limit" state for this domain — the shallow spread in
    // ProjectService#update leaves the key present but undefined, and ProjectPolicySchema's
    // `.default(...)` (not `.optional()`) fills it back in on parse.
    await harness.projects.update('acme', { policy: { maxCostUsd: undefined, maxTurns: undefined } });

    const cleared = await harness.projects.getRef('acme');
    expect(cleared.data.policy.maxCostUsd).toBe(5);
    expect(cleared.data.policy.maxTurns).toBe(200);
  });

  it('raising the ceiling to a larger number sticks after a round trip', async () => {
    await harness.projects.update('acme', { policy: { maxCostUsd: 0.02 } });
    await harness.projects.update('acme', { policy: { maxCostUsd: 10 } });

    const raised = await harness.projects.getRef('acme');
    expect(raised.data.policy.maxCostUsd).toBe(10);
  });
});

describe('the turn ceiling boundary: one more step than allowed, not one fewer', () => {
  it('runs exactly maxTurns steps before refusing the next one', async () => {
    await harness.projects.update('acme', { policy: { maxTurns: 2, maxCostUsd: 10 } });
    // Entry orchestrator's first round delegates (step 1), the analyst answers (step 2), and
    // the orchestrator reads that back and asks for a *second* round of delegation — that
    // delegate would be step 3, the one the ceiling refuses. A synthesis round that answers
    // outright, without delegating again, never asks for a third step at all, so it would not
    // pin this boundary.
    harness.llm.replies = [delegate('size the market'), 'size: large.', delegate('go deeper')];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });

    const finished = await completion;

    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBe('blocked');
    const expectedError =
      'this run reached step 3 of the 2 its project allows (policy.maxTurns), so it stopped ' +
      "before running it. What it had already done is committed. Raise the ceiling with " +
      "'pomni project edit --max-turns <n>' and resume the run, or leave it here.";
    expect(finished.error).toBe(expectedError);

    // Both permitted steps actually ran: the entry orchestrator and its one delegate.
    const detail = await harness.pipelines.get(run.id);
    expect(detail.steps).toHaveLength(2);
    expect(detail.steps.some((step) => step.agentId === 'analyst')).toBe(true);
  });

  it('lets the entry orchestrator run its one step when maxTurns is 1', async () => {
    await harness.projects.update('acme', { policy: { maxTurns: 1 } });
    harness.llm.replies = [delegate('size the market')];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });

    const finished = await completion;

    expect(finished.status).toBe('failed');
    const detail = await harness.pipelines.get(run.id);
    expect(detail.steps.length).toBeGreaterThan(0);
    expect(detail.steps[0]?.agentId).not.toBe('analyst');
  });
});
