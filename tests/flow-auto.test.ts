import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FLOW, EMPTY_EVIDENCE, FlowSchema, nextAutoMove } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

/**
 * Automatic transitions, and the comment a person leaves on a manual one.
 *
 * The flow engine is the layer where a wrong answer is silent: an arrow that fires when it
 * should not walks an item forward on its own, and an arrow that never fires looks exactly
 * like a person who has not got round to it.
 */
let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
});

afterEach(async () => {
  await harness.cleanup();
});

/** A flow with one arrow, so a test says which mode it is testing and nothing else. */
const flowWith = (mode: 'auto' | 'manual', requires: Record<string, unknown>) =>
  FlowSchema.parse({
    initial: 'open',
    states: ['open', 'shut'],
    transitions: [{ from: 'open', to: 'shut', mode, requires }],
  });

describe('an automatic arrow must be able to wait for something', () => {
  it('refuses one that requires nothing', () => {
    // An auto arrow with no requirements fires the moment the item arrives, and a row of them
    // walks an item from the first state to the last without anyone touching it.
    const built = () => flowWith('auto', {});
    expect(built).toThrow(/requires nothing/);
  });

  it('allows the same arrow when it is manual', () => {
    expect(() => flowWith('manual', {})).not.toThrow();
  });

  it('will not let an item leave blocked automatically', () => {
    // Leaving `blocked` restores `statusBefore`, and an auto arrow out of it races that.
    const built = () =>
      FlowSchema.parse({
        initial: 'open',
        states: ['open', 'blocked'],
        transitions: [
          { from: 'blocked', to: 'open', mode: 'auto', requires: { gate: 'default' } },
        ],
      });
    expect(built).toThrow(/unblocks it/);
  });
});

describe('which move fires on its own', () => {
  it('picks the automatic arrow and never a manual one', () => {
    const flow = FlowSchema.parse({
      initial: 'open',
      states: ['open', 'shut', 'parked'],
      transitions: [
        { from: 'open', to: 'parked', mode: 'manual', requires: {} },
        { from: 'open', to: 'shut', mode: 'auto', requires: { acceptance: true } },
      ],
    });

    // `parked` is a legal move from here and needs nothing to be true. It is still not
    // something the system may make on its own — only the arrow marked `auto` is.
    expect(
      nextAutoMove({ id: 'ACME-1', status: 'open' }, flow, {
        ...EMPTY_EVIDENCE,
        acceptance: { total: 1, checked: 1 },
      })?.to,
    ).toBe('shut');
  });

  it('fires nothing while the requirement is unmet', () => {
    const flow = flowWith('auto', { acceptance: true });
    expect(
      nextAutoMove({ id: 'ACME-1', status: 'open' }, flow, {
        ...EMPTY_EVIDENCE,
        acceptance: { total: 2, checked: 1 },
      }),
    ).toBeNull();
  });

  it('leaves the built-in flow with exactly one automatic arrow', () => {
    // `in_progress -> in_review` and nothing else. Anything reaching `done` is a person's
    // decision, and a second auto arrow added carelessly would chain with this one.
    const auto = DEFAULT_FLOW.transitions.filter((transition) => transition.mode === 'auto');
    expect(auto.map((transition) => `${transition.from}->${transition.to}`)).toEqual([
      'in_progress->in_review',
    ]);
  });
});

describe('why a move happened', () => {
  it('records the comment a person left, and puts it in the log', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });

    const moved = await harness.backlog.transition('acme', item.id, 'specced', {
      force: true,
      comment: 'spec agreed on the call',
    });

    expect(moved.body).toContain('spec agreed on the call');
  });

  it('still takes the older name for the same thing', async () => {
    // `reason` predates `comment` and every surface already passes it. One place to write why
    // a move happened, not two.
    const item = await harness.backlog.create('acme', { title: 'x' });

    const moved = await harness.backlog.transition('acme', item.id, 'specced', {
      force: true,
      reason: 'spec agreed on the call',
    });

    expect(moved.body).toContain('spec agreed on the call');
  });

  it('flattens a comment with newlines, because the log is one line', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });

    const moved = await harness.backlog.transition('acme', item.id, 'specced', {
      force: true,
      comment: 'agreed on the call\nand in the thread',
    });

    const logLine = moved.body
      .split('\n')
      .find((line) => line.includes('agreed on the call')) as string;
    expect(logLine).toContain('and in the thread');
  });
});

describe('re-evaluating an item', () => {
  it('does not move one whose automatic arrow is not satisfied', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    expect((await harness.backlog.reevaluate('acme', item.id)).status).toBe(item.status);
  });

  it('is safe to call on an item with nothing automatic ahead of it', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await harness.backlog.transition('acme', item.id, 'blocked', { reason: 'waiting' });

    // Nothing leaves `blocked` on its own, so this must be a no-op rather than an error.
    expect((await harness.backlog.reevaluate('acme', item.id)).status).toBe('blocked');
  });
});
