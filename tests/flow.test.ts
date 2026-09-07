import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW,
  FlowSchema,
  InvalidTransitionError,
  RequirementsNotMetError,
  layout,
  type Flow,
} from '@pomni/core';
import { createApp } from '@pomni/server';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

/** A flow written the way a project author writes one: bare state names, partial requirements. */
function flow(input: unknown): Flow {
  return FlowSchema.parse(input);
}

/** Put the project on a flow of the test's own making. */
async function useFlow(input: unknown): Promise<void> {
  await harness.projects.update('acme', { taskFlow: flow(input) });
}

/** The body a real item gets once a human has actually written in it. */
function writtenBody(acceptance = '- [ ] one'): string {
  return `## Problem\n\nSupport load is high.\n\n## Acceptance criteria\n\n${acceptance}\n\n## Plan\n\n1. do the thing\n\n## Log\n`;
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the move to be refused, but it was allowed');
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
  const path = await makeNodeRepo(join(harness.dir, 'api'), {
    scripts: { test: 'vitest run' },
    devDependencies: {},
  });
  await (await harness.repos.add('acme', { source: { kind: 'local', path }, id: 'api' })).completion;
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a project without a flow', () => {
  it('runs on the built-in flow', async () => {
    expect(await harness.backlog.flow('acme')).toEqual(DEFAULT_FLOW);
  });

  it('offers every built-in move out of the initial state, unmet ones included', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    const detail = await harness.backlog.get('acme', item.id);

    expect(detail.offFlow).toBe(false);
    expect(detail.flowState?.name).toBe('backlog');
    expect(detail.allowedTransitions.map((offer) => offer.to)).toEqual([
      'specced',
      'ready',
      'blocked',
      'cancelled',
    ]);
    expect(detail.allowedTransitions.every((offer) => offer.via === 'arrow')).toBe(true);

    // A blocked target is offered with its reason attached, not hidden.
    const specced = detail.allowedTransitions.find((offer) => offer.to === 'specced');
    expect(specced?.ok).toBe(false);
    expect(specced?.unmet).toEqual([{ kind: 'sections', missing: ['Problem'] }]);

    expect(detail.allowedTransitions.find((offer) => offer.to === 'blocked')?.ok).toBe(true);
  });
});

describe('a project with its own flow', () => {
  it('refuses a move the built-in flow allows, as a graph refusal not a requirements one', async () => {
    await useFlow({
      states: ['backlog', 'specced', 'done'],
      transitions: [
        { from: 'backlog', to: 'specced' },
        { from: 'specced', to: 'done' },
      ],
    });

    const item = await harness.backlog.create('acme', { title: 'x', body: writtenBody() });
    // The built-in flow has backlog → ready. This one does not.
    const error = await caught(harness.backlog.transition('acme', item.id, 'ready'));

    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error).not.toBeInstanceOf(RequirementsNotMetError);
    expect(error.message).toContain("cannot move from 'backlog' to 'ready'");
    expect(error.message).toContain('allowed from here: specced');
  });

  it('refuses a state its flow has never heard of', async () => {
    await useFlow({ states: ['backlog', 'specced'], transitions: [{ from: 'backlog', to: 'specced' }] });
    const item = await harness.backlog.create('acme', { title: 'x' });

    const error = await caught(harness.backlog.transition('acme', item.id, 'in_review'));
    expect(error).toBeInstanceOf(InvalidTransitionError);
  });

  it('starts a new item in the flow’s own initial state', async () => {
    await useFlow({
      states: ['triage', 'doing'],
      transitions: [{ from: 'triage', to: 'doing' }],
    });
    const item = await harness.backlog.create('acme', { title: 'x' });
    expect(item.status).toBe('triage');
  });

  it('refuses a flow naming a gate the project does not declare', async () => {
    await expect(
      harness.projects.update('acme', {
        taskFlow: flow({
          states: ['backlog', 'shipped'],
          transitions: [{ from: 'backlog', to: 'shipped', requires: { gate: 'release' } }],
        }),
      }),
    ).rejects.toThrow(/no gate named 'release'/);
  });
});

describe('each kind of requirement, failing and then passing', () => {
  it('holds a move until every acceptance box is ticked', async () => {
    await useFlow({
      states: ['backlog', 'done'],
      transitions: [{ from: 'backlog', to: 'done', requires: { acceptance: true } }],
    });

    const seven = [
      '- [x] a',
      '- [x] b',
      '- [x] c',
      '- [x] d',
      '- [ ] e',
      '- [ ] f',
      '- [ ] g',
    ].join('\n');
    const item = await harness.backlog.create('acme', { title: 'x', body: writtenBody(seven) });

    const error = await caught(harness.backlog.transition('acme', item.id, 'done'));
    expect(error).toBeInstanceOf(RequirementsNotMetError);
    expect(error.message).toContain('3 of 7 acceptance criteria unticked');

    await harness.backlog.update('acme', item.id, {
      body: writtenBody(seven.replace(/- \[ \]/g, '- [x]')),
    });
    expect((await harness.backlog.transition('acme', item.id, 'done')).status).toBe('done');
  });

  it('holds a move until the gate it names has actually run green', async () => {
    await useFlow({
      states: ['backlog', 'shipped'],
      transitions: [
        { from: 'backlog', to: 'shipped', requires: { gate: 'default' } },
      ],
    });
    const item = await harness.backlog.create('acme', { title: 'x', repos: ['api'] });

    // Nothing has run at all: pending, and named as such.
    const never = await caught(harness.backlog.transition('acme', item.id, 'shipped'));
    expect(never.message).toContain('gate `default` has not run for api (test)');

    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  1 failed (1)' }];
    await harness.runs.run('acme', 'test');

    const red = await caught(harness.backlog.transition('acme', item.id, 'shipped'));
    expect(red).toBeInstanceOf(RequirementsNotMetError);
    expect(red.message).toContain('gate `default` has not passed for api (test)');

    harness.executor.script = [];
    await harness.runs.run('acme', 'test');
    expect((await harness.backlog.transition('acme', item.id, 'shipped')).status).toBe('shipped');
  });

  it('holds a move until a human has ticked the definition-of-done boxes', async () => {
    await useFlow({
      states: ['backlog', 'ready'],
      transitions: [
        {
          from: 'backlog',
          to: 'ready',
          requires: { checklist: ['Design reviewed', 'Docs updated'] },
        },
      ],
    });
    const item = await harness.backlog.create('acme', { title: 'x' });

    const error = await caught(harness.backlog.transition('acme', item.id, 'ready'));
    expect(error.message).toContain(
      '2 of 2 checklist items unticked: Design reviewed, Docs updated',
    );

    await harness.backlog.tickChecklist('acme', item.id, 'design-reviewed', true);
    const half = await caught(harness.backlog.transition('acme', item.id, 'ready'));
    expect(half.message).toContain('1 of 2 checklist items unticked: Docs updated');

    const complete = await harness.backlog.tickChecklist('acme', item.id, 'docs-updated', true);
    expect(complete.allowedTransitions.find((offer) => offer.to === 'ready')?.ok).toBe(true);
    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });

  it('refuses to tick a box no move out of here declares', async () => {
    await useFlow({
      states: ['backlog', 'ready'],
      transitions: [
        { from: 'backlog', to: 'ready', requires: { checklist: ['Design reviewed'] } },
      ],
    });
    const item = await harness.backlog.create('acme', { title: 'x' });

    await expect(
      harness.backlog.tickChecklist('acme', item.id, 'nonsense', true),
    ).rejects.toThrow(/not a checklist box/);
  });

  it('holds a move until the fields it names are filled in', async () => {
    await useFlow({
      states: ['backlog', 'ready'],
      transitions: [
        { from: 'backlog', to: 'ready', requires: { fields: ['estimate', 'branch'] } },
      ],
    });
    const item = await harness.backlog.create('acme', { title: 'x' });

    const error = await caught(harness.backlog.transition('acme', item.id, 'ready'));
    expect(error.message).toContain('estimate and branch are empty');

    await harness.backlog.update('acme', item.id, { estimate: 'M' });
    const half = await caught(harness.backlog.transition('acme', item.id, 'ready'));
    expect(half.message).toContain('branch is empty');

    await harness.backlog.update('acme', item.id, { branch: 'feat/x' });
    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });

  it('does not count a section that still holds only its italic prompt as written', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });

    // The freshly created body: Problem is the italic template line, and nothing else.
    const error = await caught(harness.backlog.transition('acme', item.id, 'specced'));
    expect(error).toBeInstanceOf(RequirementsNotMetError);
    expect(error.message).toContain("no 'Problem' section is written in the item body");

    await harness.backlog.update('acme', item.id, { body: writtenBody() });
    expect((await harness.backlog.transition('acme', item.id, 'specced')).status).toBe('specced');
  });

  it('holds a move until the items it depends on are done', async () => {
    await useFlow({
      states: ['backlog', 'ready', 'done'],
      transitions: [
        { from: 'backlog', to: 'done' },
        { from: 'backlog', to: 'ready', requires: { dependencies: true } },
      ],
    });

    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });
    await harness.backlog.update('acme', second.id, { dependsOn: [first.id] });

    const error = await caught(harness.backlog.transition('acme', second.id, 'ready'));
    expect(error).toBeInstanceOf(RequirementsNotMetError);
    expect(error.message).toContain(`depends on ${first.id}, which is not done`);

    await harness.backlog.transition('acme', first.id, 'done');
    expect((await harness.backlog.transition('acme', second.id, 'ready')).status).toBe('ready');
  });
});

describe('force', () => {
  it('waives the requirements and records in the log what it went past', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });

    const forced = await harness.backlog.transition('acme', item.id, 'specced', { force: true });
    expect(forced.status).toBe('specced');
    expect(forced.body).toContain('(forced)');
    expect(forced.body).toContain("unmet: no 'Problem' section is written in the item body");
  });

  it('will not invent an arrow the flow does not have', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });

    const error = await caught(
      harness.backlog.transition('acme', item.id, 'done', { force: true }),
    );
    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect((await harness.backlog.get('acme', item.id)).status).toBe('backlog');
  });
});

describe('an item standing off the flow', () => {
  /** Put a status onto disk that the project's flow does not declare. */
  async function stranded(): Promise<string> {
    const item = await harness.backlog.create('acme', { title: 'x' });
    const path = join(harness.root, layout.backlogItem('acme', item.id));
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.replace(/^status: .*$/m, 'status: archived'), 'utf8');
    return item.id;
  }

  it('still parses, lists and shows, offering only the flow’s recovery states', async () => {
    const id = await stranded();

    const listed = await harness.backlog.list({ projectId: 'acme' });
    expect(listed.map((item) => item.status)).toEqual(['archived']);

    const detail = await harness.backlog.get('acme', id);
    expect(detail.offFlow).toBe(true);
    expect(detail.flowState).toBeNull();
    expect(detail.allowedTransitions).toEqual([
      { to: 'backlog', label: 'Backlog', ok: true, unmet: [], via: 'recovery' },
    ]);
  });

  it('may step back onto the flow at a recovery state, and nowhere else', async () => {
    const id = await stranded();

    const error = await caught(harness.backlog.transition('acme', id, 'in_review'));
    expect(error).toBeInstanceOf(InvalidTransitionError);

    expect((await harness.backlog.transition('acme', id, 'backlog')).status).toBe('backlog');
  });
});

describe('two deliberate changes to what the built-in flow enforces', () => {
  it('refuses review when the gate has never run at all, not only when it is red', async () => {
    const item = await harness.backlog.create('acme', {
      title: 'x',
      repos: ['api'],
      body: writtenBody(),
    });
    await harness.backlog.transition('acme', item.id, 'specced');
    await harness.backlog.transition('acme', item.id, 'ready');
    await harness.backlog.transition('acme', item.id, 'in_progress');

    // No run has ever been recorded for this project.
    const error = await caught(harness.backlog.transition('acme', item.id, 'in_review'));
    expect(error).toBeInstanceOf(RequirementsNotMetError);
    expect(error.message).toContain('cannot go to review — the gate is not green');
    expect(error.message).toContain('gate `default` has not run for api (test)');
  });

  it('accepts a spec whose acceptance criteria are prose with no checkbox', async () => {
    const item = await harness.backlog.create('acme', {
      title: 'x',
      body: '## Problem\n\nreal problem\n\n## Acceptance criteria\n\nthe thing works end to end\n',
    });

    expect((await harness.backlog.transition('acme', item.id, 'specced')).status).toBe('specced');
  });
});

describe('http api', () => {
  it('answers a refused transition with 422 and the unmet requirements', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const item = await harness.backlog.create('acme', { title: 'x' });

    const refused = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/items/${item.id}/transition`,
      payload: { to: 'specced' },
    });

    expect(refused.statusCode).toBe(422);
    const body = refused.json();
    expect(body.code).toBe('validation');
    expect(body.unmet).toEqual([{ kind: 'sections', missing: ['Problem'] }]);
    expect(body.title).toContain("no 'Problem' section is written in the item body");

    await app.close();
  });

  it('serves the project flow so a board can draw its own columns', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const read = await app.inject({ method: 'GET', url: '/api/projects/acme/items-flow' });
    expect(read.statusCode).toBe(200);
    expect(read.json().flow).toEqual(DEFAULT_FLOW);

    await useFlow({ states: ['triage', 'doing'], transitions: [{ from: 'triage', to: 'doing' }] });
    const custom = await app.inject({ method: 'GET', url: '/api/projects/acme/items-flow' });
    expect(custom.json().flow.states.map((state: { name: string }) => state.name)).toEqual([
      'triage',
      'doing',
    ]);

    await app.close();
  });

  it('ticks a checklist box and hands back the redrawn move buttons', async () => {
    await useFlow({
      states: ['backlog', 'ready'],
      transitions: [
        { from: 'backlog', to: 'ready', requires: { checklist: ['Design reviewed'] } },
      ],
    });
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const item = await harness.backlog.create('acme', { title: 'x' });

    const ticked = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/items/${item.id}/checklist`,
      payload: { key: 'design-reviewed', ticked: true },
    });

    expect(ticked.statusCode).toBe(200);
    expect(ticked.json().item.checklist['design-reviewed']).toBeTruthy();
    expect(
      ticked.json().item.allowedTransitions.find((offer: { to: string }) => offer.to === 'ready'),
    ).toMatchObject({ ok: true, unmet: [] });

    await app.close();
  });
});

describe('blocking an item that is already blocked', () => {
  it('records the new reason and says so in the log, instead of keeping the old one', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await harness.backlog.block('acme', item.id, 'you have hit your session limit');

    const again = await harness.backlog.transition('acme', item.id, 'blocked', {
      reason: 'the agents reported the work as partial',
    });

    // A stale reason is worse than no reason, because it is read as current. POMN-54 showed
    // a session limit from hours earlier while the truth had become something else entirely.
    expect(again.blockedReason).toBe('the agents reported the work as partial');
    expect(again.body).toContain('still blocked — the agents reported the work as partial');
    // And the first reason is still in the log — this adds a line, it does not rewrite one.
    expect(again.body).toContain('you have hit your session limit');
  });

  it('leaves statusBefore alone, so unblock still knows where the item was working', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await harness.backlog.transition('acme', item.id, 'specced', { force: true });
    await harness.backlog.block('acme', item.id, 'first');
    await harness.backlog.transition('acme', item.id, 'blocked', { reason: 'second' });

    // Overwriting statusBefore with 'blocked' would make unblock put the item back into
    // blocked, which is the one place it must never land.
    expect((await harness.backlog.unblock('acme', item.id)).status).toBe('specced');
  });

  it('is still a no-op when nothing about the block has changed', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    const blocked = await harness.backlog.block('acme', item.id, 'the same reason');

    const again = await harness.backlog.transition('acme', item.id, 'blocked', {
      reason: 'the same reason',
    });
    expect(again.body).toBe(blocked.body);
    expect(again.updatedAt).toBe(blocked.updatedAt);
  });
});
