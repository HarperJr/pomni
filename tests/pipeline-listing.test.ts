import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineRunSchema, type PipelineRun } from '@pomni/core';
import { createApp } from '@pomni/server';
import { createHarness, type TestHarness } from './harness.js';

/**
 * The Agent runs block pages its history through `GET /api/projects/:id/pipelines?limit=`:
 * it starts at 30 and asks for 30 more each time you press Show all, up to 200. These are
 * the guarantees the browser leans on — that the limit is honoured, that it cannot be talked
 * past 200, and that the two filters the block uses are the ones the route reads.
 */

/**
 * A run that exists only to be counted. Ids sort lexicographically; the store orders by id.
 *
 * Through the schema, and cast by nothing. The `as PipelineRun` this used to end with let the
 * literal fall silently behind the record — the store then tried to bind an `undefined` and
 * every test in the file died on "cannot be bound to SQLite parameter 23", which says nothing
 * about what was actually missing.
 */
function seedRun(index: number, overrides: Partial<PipelineRun> = {}): PipelineRun {
  return PipelineRunSchema.parse({
    id: `run-${String(index).padStart(4, '0')}`,
    projectId: 'acme',
    workflowId: 'discovery',
    workflowName: 'Discovery',
    providerId: 'claude-code',
    task: `task ${index}`,
    outcome: 'done',
    status: 'passed',
    itemId: null,
    result: null,
    error: null,
    costUsd: null,
    startedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    endedAt: new Date(1_700_000_000_000 + index * 1000 + 500).toISOString(),
    durationMs: 500,
    ...overrides,
  });
}

describe('listing a project’s pipeline runs', () => {
  let harness: TestHarness;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    harness = await createHarness();
    // One app per test, not one per request. Building it per call meant thirty fastify
    // instances were created and none was ever closed, so each one outlived the harness that
    // owned its stores — which is where `database is not open` came from, and a good part of
    // where the time went.
    app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
  });

  afterEach(async () => {
    // Closed before the harness, never after: the harness closes the databases this app is
    // still holding, and an app shut down afterwards is an app shut down against a dead store.
    await app.close();
    await harness.cleanup();
  });

  const listed = async (query: string): Promise<PipelineRun[]> => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/acme/pipelines${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().runs as PipelineRun[];
  };

  async function seed(count: number, overrides: (i: number) => Partial<PipelineRun> = () => ({})) {
    for (let i = 0; i < count; i += 1) {
      await harness.pipelineStore.insertRun(seedRun(i, overrides(i)));
    }
  }

  it('returns the newest 30 runs when the browser does not ask for a page size', async () => {
    await seed(45);

    const runs = await listed('');

    expect(runs).toHaveLength(30);
    // Newest first: the block shows the most recent history, not the oldest.
    expect(runs[0]?.id).toBe('run-0044');
    expect(runs.at(-1)?.id).toBe('run-0015');
  });

  it('honours the limit the Show all control raises', async () => {
    await seed(80);

    // What the block asks for after one press of Show all, and after two.
    expect(await listed('?limit=60')).toHaveLength(60);
    expect(await listed('?limit=90')).toHaveLength(80);
  });

  it('caps a request at 200 rows however large a limit is asked for', async () => {
    await seed(240);

    const runs = await listed('?limit=500');

    // The store clamps; nothing the browser sends can make one response render 240 rows.
    expect(runs).toHaveLength(200);
    expect(runs[0]?.id).toBe('run-0239');
  });

  it('caps at 200 exactly at the boundary the browser stops raising the limit', async () => {
    await seed(240);

    expect(await listed('?limit=200')).toHaveLength(200);
    // 210 is what a naive "add 30 to 180" would send; it must not widen the page.
    expect(await listed('?limit=210')).toHaveLength(200);
  });

  it('returns fewer rows than the limit when the project has less history', async () => {
    await seed(12);

    // The block reads "fewer than asked for" as "there is no more", so short must stay short.
    expect(await listed('?limit=30')).toHaveLength(12);
  });

  it('reads the workflow filter from the `workflow` query parameter', async () => {
    await seed(6, (i) =>
      i % 2 === 0
        ? { workflowId: 'discovery', workflowName: 'Discovery' }
        : { workflowId: 'delivery', workflowName: 'Delivery' },
    );

    const delivery = await listed('?workflow=delivery');

    expect(delivery).toHaveLength(3);
    expect(delivery.every((run) => run.workflowId === 'delivery')).toBe(true);
    // `workflowId` is the service's field name, not the wire name; sending it filters nothing.
    expect(await listed('?workflowId=delivery')).toHaveLength(6);
  });

  it('lists running and finished runs together, so the block can partition them itself', async () => {
    await seed(4, (i) =>
      i >= 2 ? { status: 'running', endedAt: null, durationMs: null, outcome: 'unknown' } : {},
    );

    const runs = await listed('');

    // The endpoint does not sort the live ones to the top; the browser does that.
    expect(runs.map((run) => run.status)).toEqual(['running', 'running', 'passed', 'passed']);
  });

  it('leaves a run out of the live set once it finishes', async () => {
    await harness.pipelineStore.insertRun(
      seedRun(0, { status: 'running', endedAt: null, durationMs: null, outcome: 'unknown' }),
    );
    expect((await listed('')).map((run) => run.status)).toEqual(['running']);

    const live = (await harness.pipelineStore.getRun('run-0000'))!;
    await harness.pipelineStore.updateRun('run-0000', {
      ...live,
      status: 'passed',
      outcome: 'done',
      endedAt: new Date().toISOString(),
      durationMs: 500,
    });

    // The same row, refetched, now belongs under "Recent" rather than "Running".
    expect((await listed('')).map((run) => run.status)).toEqual(['passed']);
  });

  it('does not leak another project’s runs into the block', async () => {
    await seed(3);
    await harness.pipelineStore.insertRun(seedRun(99, { projectId: 'other' }));

    expect((await listed('?limit=200')).map((run) => run.projectId)).toEqual(['acme', 'acme', 'acme']);
  });
});
