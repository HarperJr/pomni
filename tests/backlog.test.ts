import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLog,
  canTransition,
  countAcceptance,
  layout,
  parseSections,
  pickNext,
  type BacklogItem,
} from '@pomni/core';
import { deserializeMarkdown, serializeMarkdown } from '@pomni/infra';
import { createApp } from '@pomni/server';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

async function spec(projectId: string, itemId: string): Promise<void> {
  const item = await harness.backlog.get(projectId, itemId);
  await harness.backlog.update(projectId, itemId, {
    body: item.body
      .replace('_Why does this matter? What is broken or missing?_', 'Support load is high.')
      .replace('_Filled in by `pomni feature plan`, or by hand._', '1. do the thing'),
  });
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

describe('markdown round-trip', () => {
  it('preserves the body byte-for-byte', () => {
    const body = '## Problem\n\nSome  *odd*   spacing.\n\n- [ ] one\n- [x] two\n\n\ntrailing\n';
    const text = serializeMarkdown({ id: 'A-1', title: 'x', body });
    const parsed = deserializeMarkdown(text) as { id: string; body: string };

    expect(parsed.id).toBe('A-1');
    expect(parsed.body).toBe(body);
  });

  it('reads a file that has no frontmatter as pure body', () => {
    expect(deserializeMarkdown('# just prose')).toEqual({ body: '# just prose' });
  });

  it('writes frontmatter a human can read in a diff', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link' });
    const raw = await harness.fs.readText(
      join(harness.root, layout.backlogItem('acme', item.id)),
    );

    expect(raw?.startsWith('---\n')).toBe(true);
    expect(raw).toContain('title: Magic link');
    expect(raw).toContain('## Acceptance criteria');
    // The body is not YAML-encoded — no block scalar, no quoting.
    expect(raw).not.toContain('body: |');
  });
});

describe('sections and log', () => {
  it('splits a body into its headings', () => {
    const sections = parseSections('## Problem\n\nA\n\n## Plan\n\nB\n');
    expect(sections.Problem).toBe('A');
    expect(sections.Plan).toBe('B');
  });

  it('counts acceptance checkboxes', () => {
    const body = '## Acceptance criteria\n\n- [ ] one\n- [x] two\n- [X] three\n\n## Plan\n- [ ] not counted\n';
    expect(countAcceptance(body)).toEqual({ total: 3, checked: 2 });
  });

  it('appends to the Log section without disturbing later sections', () => {
    const body = '## Log\n- 2026-01-01 created\n\n## Notes\nkeep me\n';
    const next = appendLog(body, 'moved', '2026-01-02');

    expect(next).toContain('- 2026-01-01 created\n- 2026-01-02 moved');
    expect(next.trimEnd().endsWith('keep me')).toBe(true);
  });

  it('creates a Log section when the body has none', () => {
    expect(appendLog('## Problem\nx', 'created', '2026-01-01')).toContain('## Log\n- 2026-01-01 created');
  });
});

describe('creating items', () => {
  it('allocates sequential ids using the project prefix', async () => {
    const first = await harness.backlog.create('acme', { title: 'One' });
    const second = await harness.backlog.create('acme', { title: 'Two' });

    expect(first.id).toBe('ACME-1');
    expect(second.id).toBe('ACME-2');
    expect(second.order).toBeGreaterThan(first.order);
  });

  it('rejects an unknown repo instead of recording a dangling reference', async () => {
    await expect(
      harness.backlog.create('acme', { title: 'x', repos: ['nope'] }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('starts in backlog with a spec template', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link' });
    expect(item.status).toBe('backlog');
    expect(countAcceptance(item.body).total).toBe(1);
  });
});

describe('transitions', () => {
  it('refuses a move the state machine does not allow', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await expect(
      harness.backlog.transition('acme', item.id, 'done'),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(canTransition('backlog', 'done')).toBe(false);
  });

  it('will not mark an item specced without a problem and acceptance criteria', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await expect(harness.backlog.transition('acme', item.id, 'specced')).rejects.toThrow(/Problem/);
  });

  it('will not mark an item ready without a plan', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await harness.backlog.update('acme', item.id, {
      body: '## Problem\n\nreal problem\n\n## Acceptance criteria\n\n- [ ] a\n',
    });
    await harness.backlog.transition('acme', item.id, 'specced');
    await expect(harness.backlog.transition('acme', item.id, 'ready')).rejects.toThrow(/Plan/);
  });

  it('walks the happy path and records every move in the log', async () => {
    const item = await harness.backlog.create('acme', { title: 'x', repos: ['api'] });
    await spec('acme', item.id);

    await harness.backlog.transition('acme', item.id, 'specced');
    await harness.backlog.transition('acme', item.id, 'ready');
    const moved = await harness.backlog.transition('acme', item.id, 'in_progress');

    expect(moved.status).toBe('in_progress');
    expect(moved.body).toContain('backlog → specced');
    expect(moved.body).toContain('ready → in_progress');
  });

  it('records a forced move as forced', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    const moved = await harness.backlog.transition('acme', item.id, 'specced', { force: true });
    expect(moved.body).toContain('(forced)');
  });
});

describe('the gate guard', () => {
  it('blocks review while a repo the item touches is red', async () => {
    const item = await harness.backlog.create('acme', { title: 'x', repos: ['api'] });
    await spec('acme', item.id);
    await harness.backlog.transition('acme', item.id, 'specced');
    await harness.backlog.transition('acme', item.id, 'ready');
    await harness.backlog.transition('acme', item.id, 'in_progress');

    harness.executor.script = [{ match: /run test/, exitCode: 1, output: 'Tests  1 failed (1)' }];
    await harness.runs.run('acme', 'test');

    await expect(harness.backlog.transition('acme', item.id, 'in_review')).rejects.toThrow(
      /gate is not green/,
    );
  });

  it('allows review once the gate passes', async () => {
    const item = await harness.backlog.create('acme', { title: 'x', repos: ['api'] });
    await spec('acme', item.id);
    await harness.backlog.transition('acme', item.id, 'specced');
    await harness.backlog.transition('acme', item.id, 'ready');
    await harness.backlog.transition('acme', item.id, 'in_progress');

    await harness.runs.run('acme', 'test');
    const reviewed = await harness.backlog.transition('acme', item.id, 'in_review');
    expect(reviewed.status).toBe('in_review');
  });

  it('can be overridden with force, and says so in the log', async () => {
    const item = await harness.backlog.create('acme', { title: 'x', repos: ['api'] });
    await spec('acme', item.id);
    await harness.backlog.transition('acme', item.id, 'specced');
    await harness.backlog.transition('acme', item.id, 'ready');
    await harness.backlog.transition('acme', item.id, 'in_progress');

    harness.executor.script = [{ match: /run test/, exitCode: 1 }];
    await harness.runs.run('acme', 'test');

    const forced = await harness.backlog.transition('acme', item.id, 'in_review', { force: true });
    expect(forced.status).toBe('in_review');
    expect(forced.body).toContain('(forced)');
  });
});

describe('dependencies', () => {
  it('will not start an item whose dependency is unfinished', async () => {
    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });
    await harness.backlog.update('acme', second.id, { dependsOn: [first.id] });
    await spec('acme', second.id);

    await harness.backlog.transition('acme', second.id, 'specced');
    await harness.backlog.transition('acme', second.id, 'ready');
    await expect(harness.backlog.transition('acme', second.id, 'in_progress')).rejects.toThrow(
      new RegExp(first.id),
    );
  });

  it('reports both directions of the dependency edge from one stored field', async () => {
    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });
    await harness.backlog.update('acme', second.id, { dependsOn: [first.id] });

    expect((await harness.backlog.get('acme', second.id)).blockedBy).toEqual([first.id]);
    expect((await harness.backlog.get('acme', first.id)).blocking).toEqual([second.id]);
  });

  it('refuses a dependency cycle', async () => {
    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });
    await harness.backlog.update('acme', second.id, { dependsOn: [first.id] });

    await expect(
      harness.backlog.update('acme', first.id, { dependsOn: [second.id] }),
    ).rejects.toThrow(/cycle/);
  });

  it('refuses to delete an item something still depends on', async () => {
    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });
    await harness.backlog.update('acme', second.id, { dependsOn: [first.id] });

    await expect(harness.backlog.remove('acme', first.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('blocking', () => {
  it('remembers where the item was and restores it on unblock', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await spec('acme', item.id);
    await harness.backlog.transition('acme', item.id, 'specced');

    const blocked = await harness.backlog.block('acme', item.id, 'waiting on design');
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedReason).toBe('waiting on design');

    const restored = await harness.backlog.unblock('acme', item.id);
    expect(restored.status).toBe('specced');
    expect(restored.blockedReason).toBeNull();
  });

  it('requires a reason', async () => {
    const item = await harness.backlog.create('acme', { title: 'x' });
    await expect(harness.backlog.block('acme', item.id, '  ')).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('ordering', () => {
  it('picks the highest-priority ready item', () => {
    const base = { status: 'ready', order: 10 } as Partial<BacklogItem>;
    const items = [
      { ...base, id: 'A-1', priority: 'P2', order: 10 },
      { ...base, id: 'A-2', priority: 'P0', order: 20 },
      { ...base, id: 'A-3', priority: 'P1', order: 5 },
      { ...base, id: 'A-4', priority: 'P0', status: 'backlog', order: 1 },
    ] as BacklogItem[];

    expect(pickNext(items)?.id).toBe('A-2');
  });

  it('renumbers a column sparsely on reorder', async () => {
    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });

    await harness.backlog.reorder('acme', 'backlog', [second.id, first.id]);
    const items = await harness.backlog.list({ projectId: 'acme' });

    expect(items.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(items.map((item) => item.order)).toEqual([10, 20]);
  });
});

describe('http api', () => {
  it('creates, lists and transitions items', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects/acme/items',
      payload: { title: 'Magic link', priority: 'P1' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().item.id;

    const listed = await app.inject({ method: 'GET', url: '/api/projects/acme/items' });
    expect(listed.json().items).toHaveLength(1);

    // The guard applies over HTTP exactly as it does in the CLI.
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/items/${id}/transition`,
      payload: { to: 'specced' },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().code).toBe('validation');

    await spec('acme', id);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/items/${id}/transition`,
      payload: { to: 'specced' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().item.status).toBe('specced');

    await app.close();
  });

  it('returns an ETag and honours If-Match', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const item = await harness.backlog.create('acme', { title: 'x' });

    const read = await app.inject({ method: 'GET', url: `/api/projects/acme/items/${item.id}` });
    const rev = read.headers.etag as string;
    expect(rev).toBeTruthy();

    // Someone else edits first.
    await harness.backlog.update('acme', item.id, { title: 'changed elsewhere' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/projects/acme/items/${item.id}`,
      headers: { 'if-match': rev },
      payload: { title: 'mine' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('stale_revision');
    expect(stale.json().current).toBeTruthy();

    await app.close();
  });
});
