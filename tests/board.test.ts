import { join } from 'node:path';
import { FlowSchema, type Flow } from '@pomni/core';
import { createApp } from '@pomni/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * What the board asks, and what answers it.
 *
 * The board is a view of the flow rather than a second definition of it, so every question it
 * puts to a card — which columns will take it, what is outstanding, why a drop was refused —
 * is answered here in one call, from the same evidence a manual `pomni backlog move` uses.
 */

let harness: TestHarness;

function flow(input: unknown): Flow {
  return FlowSchema.parse(input);
}

async function useFlow(input: unknown): Promise<void> {
  await harness.projects.update('acme', { taskFlow: flow(input) });
}

const writtenBody = (acceptance = '- [ ] one') =>
  `## Problem\n\nIt hurts.\n\n## Acceptance criteria\n\n${acceptance}\n\n## Plan\n\n1. do it\n\n## Log\n`;

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

describe('every move every card could make', () => {
  it('answers for the whole board in one call, with each move’s verdict on it', async () => {
    await useFlow({
      states: ['backlog', 'specced', 'done'],
      transitions: [
        { from: 'backlog', to: 'specced', requires: { sections: ['Problem'] } },
        { from: 'specced', to: 'done' },
      ],
    });

    const written = await harness.backlog.create('acme', { title: 'a', body: writtenBody() });
    const blank = await harness.backlog.create('acme', { title: 'b' });

    const board = await harness.backlog.boardMoves({ projectId: 'acme' });
    const forWritten = board.find((entry) => entry.itemId === written.id);
    const forBlank = board.find((entry) => entry.itemId === blank.id);

    // Both cards can be *offered* the move — the arrow exists — and only one of them can make
    // it. A column that quietly disappears for one card and not another is a board nobody can
    // learn the rules from.
    expect(forWritten?.transitions.map((offer) => offer.to)).toEqual(['specced']);
    expect(forWritten?.transitions[0]?.ok).toBe(true);

    expect(forBlank?.transitions.map((offer) => offer.to)).toEqual(['specced']);
    expect(forBlank?.transitions[0]?.ok).toBe(false);
    expect(forBlank?.transitions[0]?.unmet[0]).toMatchObject({ kind: 'sections' });
    expect(JSON.stringify(forBlank?.transitions[0]?.unmet)).toContain('Problem');
  });

  it('matches what a move actually does, refusal for refusal', async () => {
    await useFlow({
      states: ['backlog', 'specced'],
      transitions: [{ from: 'backlog', to: 'specced', requires: { sections: ['Problem'] } }],
    });
    const item = await harness.backlog.create('acme', { title: 'b' });

    const [entry] = await harness.backlog.boardMoves({ projectId: 'acme' });
    expect(entry?.transitions[0]?.ok).toBe(false);

    // The board said no; the flow says no for the same reason. Two answers that can disagree
    // are worse than one that is sometimes wrong.
    await expect(harness.backlog.transition('acme', item.id, 'specced')).rejects.toThrow(
      /Problem/,
    );

    await harness.backlog.update('acme', item.id, { body: writtenBody() });
    const [after] = await harness.backlog.boardMoves({ projectId: 'acme' });
    expect(after?.transitions[0]?.ok).toBe(true);
    await expect(harness.backlog.transition('acme', item.id, 'specced')).resolves.toBeDefined();
  });

  it('gives an item standing off the flow its recovery moves, rather than nothing', async () => {
    const item = await harness.backlog.create('acme', { title: 'a' });
    await useFlow({
      states: ['triage', 'doing'],
      transitions: [{ from: 'triage', to: 'doing' }],
    });

    // The item's stored status is `backlog`, which this flow has never heard of. A card nobody
    // can move is exactly the one somebody opened the board to rescue.
    const [entry] = await harness.backlog.boardMoves({ projectId: 'acme' });
    expect(entry?.itemId).toBe(item.id);
    expect(entry?.transitions.length).toBeGreaterThan(0);
    expect(entry?.transitions.every((offer) => offer.via === 'recovery')).toBe(true);
  });

  it('covers every item the same filter would list, in the same order', async () => {
    const first = await harness.backlog.create('acme', { title: 'a', priority: 'P3' });
    const second = await harness.backlog.create('acme', { title: 'b', priority: 'P0' });

    const listed = await harness.backlog.list({ projectId: 'acme' });
    const board = await harness.backlog.boardMoves({ projectId: 'acme' });

    expect(board.map((entry) => entry.itemId)).toEqual(listed.map((item) => item.id));
    // Board order is priority order, which is the one ordering — the columns do not re-sort.
    expect(board[0]?.itemId).toBe(second.id);
    expect(board[1]?.itemId).toBe(first.id);
  });

  it('narrows with the same filter the list takes', async () => {
    await harness.backlog.create('acme', { title: 'a', type: 'bug' });
    await harness.backlog.create('acme', { title: 'b', type: 'feature' });

    const bugs = await harness.backlog.boardMoves({ projectId: 'acme', type: 'bug' });
    expect(bugs).toHaveLength(1);
  });
});

describe('the board over http', () => {
  it('serves the same answer the service gives', async () => {
    await harness.backlog.create('acme', { title: 'a', body: writtenBody() });

    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/projects/acme/items-board' });
      expect(response.statusCode).toBe(200);

      const { board } = response.json() as { board: Array<{ itemId: string }> };
      const direct = await harness.backlog.boardMoves({ projectId: 'acme' });
      expect(board.map((entry) => entry.itemId)).toEqual(direct.map((entry) => entry.itemId));
    } finally {
      await app.close();
    }
  });
});
