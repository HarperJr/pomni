import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';

/**
 * What a turn actually carries, and what it stops carrying once a round is settled.
 *
 * Measured over the recorded steps: a step takes 26 turns at the median, is billed for about
 * 79,000 tokens on each of them, and 96% of that is cached context being re-read. So the two
 * things worth counting are what a turn carries and how many turns there are — and until this,
 * only the system prompt was counted, which is neither.
 */

let harness: TestHarness;

async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the question.',
    prompt: 'You lead.',
  });
  // Three of them, because an orchestrator is refused a third question to the same agent —
  // and a round that never happened cannot be condensed.
  for (const name of ['Analyst A', 'Analyst B', 'Analyst C']) {
    await harness.workflows.addAgent('discovery', {
      name,
      spec: 'Answers questions.',
      prompt: `You are ${name.toLowerCase()}.`,
    });
  }
  await harness.workflows.attach('acme', 'discovery');
}

const delegate = (agent: string, task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent, task }] }), '```'].join('\n');

/** A long answer, so condensing it is visible in the byte count rather than a rounding error. */
const essay = (subject: string) =>
  [`I looked at ${subject}.`, ...Array.from({ length: 60 }, (_, line) => `Finding ${line}: it is as described, in detail, at length.`)].join(
    '\n',
  );

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('what a step handed the provider', () => {
  it('is recorded, and counts the conversation and not only the system prompt', async () => {
    harness.llm.replies = ['Answered outright.'];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;

    const [step] = await harness.pipelineStore.steps(run.id);
    const call = harness.llm.calls[0];
    const sent =
      Buffer.byteLength(call?.system ?? '', 'utf8') +
      (call?.messages ?? []).reduce(
        (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
        0,
      );

    // Exactly what went over the wire — not the system prompt alone, which is what
    // `promptBytes` counts and what everything measured before this.
    expect(step?.sentBytes).toBe(sent);
    expect(step?.sentBytes).toBeGreaterThan(step?.promptBytes ?? 0);
  });

  it('adds up over an orchestrator’s rounds, because each one pays for the whole thing again', async () => {
    harness.llm.replies = [
      delegate('analyst-a', 'read the spec'),
      'Read it.',
      delegate('analyst-b', 'size the market'),
      'Sized it.',
      'Here is the answer.',
    ];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;

    const steps = await harness.pipelineStore.steps(run.id);
    const lead = steps.find((step) => step.role === 'orchestrator');
    const leadCalls = harness.llm.calls.filter((call) => call.system?.includes('You lead.'));

    expect(leadCalls).toHaveLength(3);
    const perCall = leadCalls.map(
      (call) =>
        Buffer.byteLength(call.system ?? '', 'utf8') +
        call.messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0),
    );
    expect(lead?.sentBytes).toBe(perCall.reduce((total, call) => total + call, 0));

    // The point of the number: the third round costs more than the first, on the same prompt.
    expect(perCall[2]).toBeGreaterThan(perCall[0] as number);
  });
});

describe('a round nobody is working from any more', () => {
  it('is kept as what it concluded, not word for word', async () => {
    harness.llm.replies = [
      delegate('analyst-a', 'read the spec'),
      essay('the spec'),
      delegate('analyst-b', 'size the market'),
      essay('the market'),
      delegate('analyst-c', 'check the licences'),
      essay('the licences'),
      'Here is the answer.',
    ];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;

    const leadCalls = harness.llm.calls.filter((call) => call.system?.includes('You lead.'));
    expect(leadCalls).toHaveLength(4);

    const last = leadCalls[3]?.messages.map((message) => message.content).join('\n') ?? '';

    // Three rounds came back and only the last two are still there whole. The oldest kept
    // its first line and lost its sixty findings.
    expect(last.match(/Finding 59/g)).toHaveLength(2);
    expect(last).toContain('this round is');

    // What survives of it is the part that stops the orchestrator asking again: who answered,
    // and one sentence of what they said.
    expect(last).toContain('I looked at the spec.');
    expect(last).toContain('Analyst A');
  });

  it('leaves a run that never delegated twice completely alone', async () => {
    harness.llm.replies = [
      delegate('analyst-a', 'read the spec'),
      essay('the spec'),
      'Here is the answer.',
    ];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
    });
    await completion;

    const leadCalls = harness.llm.calls.filter((call) => call.system?.includes('You lead.'));
    const last = leadCalls.at(-1)?.messages.map((message) => message.content).join('\n') ?? '';

    expect(last).toContain('Finding 59: it is as described');
    expect(last).not.toContain('this round is');
  });
});
