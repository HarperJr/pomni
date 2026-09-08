import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * What a turn carries, and what happens when it carries too much.
 *
 * A prompt is paid for on every turn of every agent, so scaffolding that outgrows the agent's
 * own instructions is not a one-off cost — it is a multiplier on the whole run.
 */
let harness: TestHarness;

async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
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
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('what a turn actually carries', () => {
  it('records the prompt it sent, and the parts add up to it', async () => {
    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship it',
    });
    await completion;

    const [step] = (await harness.pipelines.get(run.id)).steps;
    expect(step?.promptBytes).toBeGreaterThan(0);

    // The prompt that was measured is the prompt that was sent — not an estimate of it.
    const sent = harness.llm.calls[0]?.system ?? '';
    expect(step?.promptBytes).toBe(Buffer.byteLength(sent, 'utf8'));

    // Every part is accounted for. The sum is under the total rather than equal to it: the
    // joins between parts are bytes too, and claiming otherwise would be a tidier lie.
    const parts = step?.promptParts;
    const summed =
      (parts?.agent ?? 0) +
      (parts?.protocol ?? 0) +
      (parts?.roster ?? 0) +
      (parts?.tools ?? 0) +
      (parts?.repos ?? 0);
    expect(summed).toBeGreaterThan(0);
    expect(summed).toBeLessThanOrEqual(step?.promptBytes ?? 0);
  });

  it('charges the roster to the roster, so a big team is visible as one', async () => {
    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship it',
    });
    await completion;

    // The lead is an orchestrator, so it carries the list of who it may delegate to. That
    // list grows with the team rather than with the job, and is paid on every round.
    const [step] = (await harness.pipelines.get(run.id)).steps;
    expect(step?.promptParts.roster).toBeGreaterThan(0);
  });
});

describe('a prompt over the budget', () => {
  it('drops what may be dropped, and says what went', async () => {
    // The repo list is trimmable; the agent has to be able to touch files to be given one.
    // An agent with neither has only parts that may never be cut — the next test covers that.
    const dir = await makeNodeRepo(join(harness.dir, 'web'));
    harness.git.trackRepo(dir);
    const { completion: added } = await harness.repos.add('acme', {
      source: { kind: 'local', path: dir },
      role: 'lib',
    });
    await added;
    await harness.workflows.updateAgent('discovery', 'lead', { tools: { files: true } });
    await harness.projects.update('acme', { policy: { promptBudget: 400 } });

    harness.llm.replies = ['Done.'];
    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    await completion;

    const sent = harness.llm.calls[0]?.system ?? '';
    expect(sent).toContain('left out');
    expect(sent).toContain('the repo list');
    expect(sent).toContain('policy.promptBudget');
  });

  it('never cuts the agent’s own prompt or the verdict protocol', async () => {
    await harness.projects.update('acme', { policy: { promptBudget: 100 } });
    // Nothing here is trimmable, so the prompt stays over budget — and the person is told,
    // rather than the prompt growing to complain about its own size.

    harness.llm.replies = ['Done.'];
    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    await completion;

    // Cutting these changes what the agent was asked to do, which is worse than a big prompt.
    const sent = harness.llm.calls[0]?.system ?? '';
    expect(sent).toContain('You lead.');
    expect(sent).toContain('outcome');
  });

  it('leaves a prompt under the budget exactly as it was', async () => {
    await harness.projects.update('acme', { policy: { promptBudget: 100_000 } });

    harness.llm.replies = ['Done.'];
    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    await completion;

    expect(harness.llm.calls[0]?.system ?? '').not.toContain('left out');
  });
});
