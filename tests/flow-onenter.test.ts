import { join } from 'node:path';
import { FlowSchema, type Flow } from '@pomni/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * A column that starts work.
 *
 * Every run before this was launched by a person typing a command, even where the rule was
 * obvious: an item reaching `ready` should be picked up, an item reaching `in_review` should
 * be reviewed. `onEnter` is where a project says so once.
 *
 * Most of these tests are about when it does *not* fire. An agent run costs real money, so
 * every path that starts one without being asked has to be one somebody wrote down.
 */

let harness: TestHarness;

function flow(input: unknown): Flow {
  return FlowSchema.parse(input);
}

async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Dev' });
  await harness.workflows.addAgent('dev', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the work.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('dev', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.attach('acme', 'dev');

  const path = await makeNodeRepo(join(harness.dir, 'api'));
  await (await harness.repos.add('acme', { source: { kind: 'local', path }, id: 'api' })).completion;
}

/** A flow whose `doing` column starts the Dev workflow on arrival. */
async function useTriggeringFlow(): Promise<void> {
  await harness.projects.update('acme', {
    taskFlow: flow({
      states: ['triage', { name: 'doing', onEnter: 'dev' }, 'done'],
      transitions: [
        { from: 'triage', to: 'doing' },
        { from: 'doing', to: 'done' },
      ],
    }),
  });
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a state that names a workflow', () => {
  it('starts it when an item arrives, against the item’s own title and body', async () => {
    await useTriggeringFlow();
    const item = await harness.backlog.create('acme', { title: 'Add a column', body: '## Problem\n\nIt is missing.\n' });

    const started = await harness.pipelines.onItemEntered('acme', item.id, 'doing');
    expect(started).not.toBeNull();
    await started?.completion;

    expect(started?.run.workflowId).toBe('dev');
    expect(started?.run.itemId).toBe(item.id);
    expect(started?.run.task).toContain('Add a column');
    expect(started?.run.task).toContain('It is missing.');

    // Who asked. A run that starts itself is the one somebody will want explained, and a log
    // line is not an answer three days later.
    expect(started?.run.startedBy).toBe('flow:doing');
  });

  it('is visible in the run list and can be stopped, like any other run', async () => {
    await useTriggeringFlow();
    const item = await harness.backlog.create('acme', { title: 'a' });

    const started = await harness.pipelines.onItemEntered('acme', item.id, 'doing');
    const runId = started?.run.id as string;

    const listed = await harness.pipelines.list({ projectId: 'acme' });
    expect(listed.map((run) => run.id)).toContain(runId);

    await started?.completion;
    const cancelled = await harness.pipelines.cancel(runId);
    expect(cancelled.id).toBe(runId);
  });
});

describe('when it does not fire', () => {
  it('does nothing for a state that names no workflow', async () => {
    await useTriggeringFlow();
    const item = await harness.backlog.create('acme', { title: 'a' });

    expect(await harness.pipelines.onItemEntered('acme', item.id, 'triage')).toBeNull();
    expect(await harness.pipelines.list({ projectId: 'acme' })).toHaveLength(0);
  });

  it('does nothing under the built-in flow, which names none anywhere', async () => {
    const item = await harness.backlog.create('acme', { title: 'a' });

    for (const state of ['ready', 'in_progress', 'in_review', 'done']) {
      expect(await harness.pipelines.onItemEntered('acme', item.id, state)).toBeNull();
    }
    expect(await harness.pipelines.list({ projectId: 'acme' })).toHaveLength(0);
  });

  it('starts exactly one run for an item dragged in and out of the column', async () => {
    await useTriggeringFlow();
    const item = await harness.backlog.create('acme', { title: 'a' });

    // The gate holds the first run open, so the second arrival happens while it is going —
    // which is the case the guard exists for.
    let release = () => {};
    harness.llm.gate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const first = await harness.pipelines.onItemEntered('acme', item.id, 'doing');
    expect(first).not.toBeNull();

    const second = await harness.pipelines.onItemEntered('acme', item.id, 'doing');
    expect(second).toBeNull();

    release();
    harness.llm.gate = undefined;
    await first?.completion;

    expect(await harness.pipelines.list({ projectId: 'acme' })).toHaveLength(1);
  });

  it('leaves the move standing when the workflow cannot run', async () => {
    await harness.projects.update('acme', {
      taskFlow: flow({
        states: ['triage', { name: 'doing', onEnter: 'nothing-like-it' }],
        transitions: [{ from: 'triage', to: 'doing' }],
      }),
    });
    const item = await harness.backlog.create('acme', { title: 'a' });

    // Reported, not thrown. The move already happened and was correct; failing it afterwards
    // would leave the board disagreeing with the flow over something neither did wrong.
    await expect(harness.pipelines.onItemEntered('acme', item.id, 'doing')).resolves.toBeNull();
    expect(await harness.pipelines.list({ projectId: 'acme' })).toHaveLength(0);

    // And the item goes where it was sent. A configuration mistake in a column is not a
    // reason to undo work that moved correctly.
    await harness.backlog.transition('acme', item.id, 'doing');
    expect((await harness.backlog.get('acme', item.id)).status).toBe('doing');
  });

  it('does nothing for an item that is not there', async () => {
    await useTriggeringFlow();
    expect(await harness.pipelines.onItemEntered('acme', 'ACME-999', 'doing')).toBeNull();
    expect(await harness.pipelines.onItemEntered('nowhere', 'ACME-1', 'doing')).toBeNull();
  });
});

describe('a run finishing moves the card only where the flow allows', () => {
  it('cannot bypass a requirement a person’s drag would have to satisfy', async () => {
    await harness.projects.update('acme', {
      taskFlow: flow({
        states: ['triage', 'doing', 'reviewing'],
        transitions: [
          { from: 'triage', to: 'doing' },
          // The run finishes and asks for the next state; this requirement stands in the way
          // exactly as it would for a drag.
          { from: 'doing', to: 'reviewing', requires: { sections: ['Plan'] } },
        ],
      }),
    });

    const item = await harness.backlog.create('acme', { title: 'a', body: '## Problem\n\nIt hurts.\n' });
    await harness.backlog.transition('acme', item.id, 'doing');

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      itemId: item.id,
      task: 'do it',
    });
    const finished = await completion;

    // The run did its work; the item stayed where it was, and the run says why rather than
    // the board quietly showing something that never happened.
    expect(finished.id).toBe(run.id);
    const after = await harness.backlog.get('acme', item.id);
    expect(after.status).toBe('doing');
  });
});
