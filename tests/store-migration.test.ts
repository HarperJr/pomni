import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqlitePipelineStore } from '@pomni/infra';
import { tempRoot } from './temp-root.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
    close(): void;
  };
};

let dir: string;
/**
 * Every store this file opens, closed in teardown.
 *
 * Windows keeps the file handle until the connection is closed, so a store left open makes
 * the directory undeletable and `afterEach` fails with EBUSY — intermittently, because it
 * depends on what else is running. That is the flake this suite had.
 */
let opened: Array<{ close(): void }>;

beforeEach(async () => {
  opened = [];
  dir = await mkdtemp(join(tempRoot(), 'pomni-migrate-'));
});

afterEach(async () => {
  for (const store of opened) {
    try {
      store.close();
    } catch {
      // Already closed, or never opened cleanly. Teardown must not fail over it.
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const columns = (path: string, table: string): string[] => {
  const db = new DatabaseSync(path);
  const names = (db.prepare(`select name from pragma_table_info('${table}')`).all() as Array<{
    name: string;
  }>).map((row) => row.name);
  db.close();
  return names;
};

describe('a database whose schema diverged from this one', () => {
  it('is repaired on open, however complete its version number claims to be', async () => {
    const path = join(dir, 'diverged.db');

    // Built properly, then made to look like a database that ran a *different* list of the
    // same length: the column dropped, the version left where it was. That is not contrived —
    // it is what an unmerged branch's migrations did to the real database, and the version
    // number could not tell the two apart, because a counter describes depth and never
    // divergence.
    opened.push(new SqlitePipelineStore(path));
    const db = new DatabaseSync(path);
    const version = (db.prepare('select version from pipeline_schema limit 1').get() as {
      version: number;
    }).version;
    db.exec('ALTER TABLE pipeline_runs DROP COLUMN branch');
    db.close();

    expect(columns(path, 'pipeline_runs')).not.toContain('branch');

    // Opening it again is the repair. Nothing has to be told that anything is wrong.
    opened.push(new SqlitePipelineStore(path));

    expect(columns(path, 'pipeline_runs')).toContain('branch');
    const after = new DatabaseSync(path);
    expect(
      (after.prepare('select version from pipeline_schema limit 1').get() as { version: number })
        .version,
    ).toBe(version);
    after.close();
  });

  it('keeps the rows it already had', async () => {
    const path = join(dir, 'rows.db');
    const store = new SqlitePipelineStore(path);
    opened.push(store);
    await store.insertRun({
      id: 'r1',
      projectId: 'acme',
      workflowId: 'w',
      workflowName: 'W',
      providerId: 'p',
      itemId: null,
      rerunOf: null,
      startedBy: null,
      drainId: null,
      branch: null,
      task: 't',
      context: [],
      status: 'passed',
      pid: null,
      result: null,
      error: null,
      gateStatus: 'skipped',
      gateSummary: null,
      itemStatus: null,
      outcome: 'done',
      unmet: [],
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      bases: [],
      noSync: false,
    });

    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE pipeline_runs DROP COLUMN branch');
    db.close();

    opened.push(new SqlitePipelineStore(path));
    const after = new DatabaseSync(path);
    expect((after.prepare('select count(*) c from pipeline_runs').get() as { c: number }).c).toBe(1);
    after.close();
  });

  it('round-trips a drain and the run it launched, and reads an older run as drainId: null', async () => {
    const path = join(dir, 'drains.db');
    const store = new SqlitePipelineStore(path);
    opened.push(store);

    await store.insertRun({
      id: 'r-old',
      projectId: 'acme',
      workflowId: 'w',
      workflowName: 'W',
      providerId: 'p',
      itemId: null,
      rerunOf: null,
      startedBy: null,
      drainId: null,
      branch: null,
      task: 't',
      context: [],
      status: 'passed',
      pid: null,
      result: null,
      error: null,
      gateStatus: 'skipped',
      gateSummary: null,
      itemStatus: null,
      outcome: 'done',
      unmet: [],
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      bases: [],
      noSync: false,
    });

    await store.insertRun({
      id: 'r-drained',
      projectId: 'acme',
      workflowId: 'w',
      workflowName: 'W',
      providerId: 'p',
      itemId: 'acme-1',
      rerunOf: null,
      startedBy: 'drain',
      drainId: 'd1',
      branch: null,
      task: 't',
      context: [],
      status: 'passed',
      pid: null,
      result: null,
      error: null,
      gateStatus: 'passed',
      gateSummary: null,
      itemStatus: null,
      outcome: 'done',
      unmet: [],
      startedAt: '2026-09-09T00:00:00.000Z',
      endedAt: '2026-09-09T00:05:00.000Z',
      durationMs: 300_000,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1.5,
      bases: [],
      noSync: false,
    });

    await store.insertDrain({
      id: 'd1',
      projectId: 'acme',
      status: 'stopped',
      pid: null,
      keepGoing: false,
      maxItems: null,
      maxCostUsd: null,
      waves: [
        {
          index: 1,
          itemIds: ['acme-1'],
          runIds: ['r-drained'],
          results: [
            {
              runId: 'r-drained',
              itemId: 'acme-1',
              status: 'passed',
              gateStatus: 'passed',
              costUsd: 1.5,
              endedAt: '2026-09-09T00:05:00.000Z',
            },
          ],
          startedAt: '2026-09-09T00:00:00.000Z',
          endedAt: '2026-09-09T00:05:00.000Z',
        },
      ],
      skippedItemIds: [],
      stopReason: {
        kind: 'red_gate',
        runId: 'r-drained',
        itemId: 'acme-1',
        runStatus: 'passed',
        gateStatus: 'passed',
      },
      itemsLaunched: 1,
      costUsd: 1.5,
      startedAt: '2026-09-09T00:00:00.000Z',
      endedAt: '2026-09-09T00:05:00.000Z',
    });

    const reopened = new SqlitePipelineStore(path);
    opened.push(reopened);

    const drain = await reopened.getDrain('d1');
    expect(drain?.stopReason).toEqual({
      kind: 'red_gate',
      runId: 'r-drained',
      itemId: 'acme-1',
      runStatus: 'passed',
      gateStatus: 'passed',
    });
    expect(drain?.waves[0]?.results).toEqual([
      {
        runId: 'r-drained',
        itemId: 'acme-1',
        status: 'passed',
        gateStatus: 'passed',
        costUsd: 1.5,
        endedAt: '2026-09-09T00:05:00.000Z',
      },
    ]);

    const drained = await reopened.getRun('r-drained');
    expect(drained?.drainId).toBe('d1');
    const old = await reopened.getRun('r-old');
    expect(old?.drainId).toBe(null);
  });
});
