import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StaleRevisionError } from '@pomni/core';
import { FileDocStore } from '@pomni/infra';
import { createApp } from '@pomni/server';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

const Doc = z.object({ name: z.string(), count: z.number().default(0) });

describe('doc store', () => {
  let dir: string;
  let store: FileDocStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pomni-store-'));
    store = new FileDocStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for a missing document rather than throwing', async () => {
    expect(await store.read('nope.yaml', Doc)).toBeNull();
  });

  it('round-trips through yaml and applies schema defaults', async () => {
    await store.write('a/b.yaml', { name: 'x' });
    const ref = await store.read('a/b.yaml', Doc);
    expect(ref?.data).toEqual({ name: 'x', count: 0 });
    expect(ref?.rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes the rev when the content changes', async () => {
    await store.write('a.yaml', { name: 'one', count: 1 });
    const first = await store.read('a.yaml', Doc);
    await store.write('a.yaml', { name: 'two', count: 1 });
    const second = await store.read('a.yaml', Doc);
    expect(first?.rev).not.toBe(second?.rev);
  });

  it('rejects a write based on a stale revision and hands back the current content', async () => {
    await store.write('a.yaml', { name: 'original', count: 1 });
    const stale = (await store.read('a.yaml', Doc))!.rev;

    // Someone else writes first — a Claude session editing the same file.
    await store.write('a.yaml', { name: 'theirs', count: 2 });

    await expect(
      store.write('a.yaml', { name: 'mine', count: 3 }, { ifMatch: stale }),
    ).rejects.toBeInstanceOf(StaleRevisionError);

    // The other writer's content survived.
    expect((await store.read('a.yaml', Doc))?.data.name).toBe('theirs');
  });

  it('accepts a write that carries the current revision', async () => {
    await store.write('a.yaml', { name: 'one', count: 1 });
    const rev = (await store.read('a.yaml', Doc))!.rev;
    await expect(store.write('a.yaml', { name: 'two', count: 1 }, { ifMatch: rev })).resolves.toBeTruthy();
  });

  it('enforces mustNotExist', async () => {
    await store.write('a.yaml', { name: 'one', count: 1 });
    await expect(
      store.write('a.yaml', { name: 'two', count: 1 }, { mustNotExist: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses paths that escape the workspace', () => {
    expect(() => store.absolute('../outside.yaml')).toThrow(/escapes/);
  });

  it('serialises .json documents as json', async () => {
    await store.write('secrets.json', { version: 1, secrets: { a: 'b' } });
    const raw = await store.read(
      'secrets.json',
      z.object({ version: z.number(), secrets: z.record(z.string()) }),
    );
    expect(raw?.data.secrets.a).toBe('b');
  });
});

describe('http api', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('creates a project and adds a local repo', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Web Shop' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.id).toBe('web-shop');

    const path = await makeNodeRepo(join(harness.dir, 'web'));
    const added = await app.inject({
      method: 'POST',
      url: '/api/projects/web-shop/repos',
      payload: { source: { kind: 'local', path }, role: 'web' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().repo.status).toBe('linked');
    expect(added.json().repo.stack.detected).toContain('next@15');

    await app.close();
  });

  it('returns 202 while a clone is in flight', async () => {
    await harness.projects.create({ name: 'Acme' });
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/acme/repos',
      payload: { source: { kind: 'git', url: 'https://github.com/o/r.git' } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().repo.status).toBe('cloning');
    await app.close();
  });

  it('reports domain errors as problem+json with the right status', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const missing = await app.inject({ method: 'GET', url: '/api/projects/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.json().code).toBe('not_found');

    await harness.projects.create({ name: 'Acme' });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/projects/acme/repos',
      payload: { source: { kind: 'local', path: join(harness.dir, 'missing') } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().code).toBe('validation');

    await app.close();
  });

  it('never returns a credential secret', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    await app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: { name: 'GitHub', provider: 'github', secretRef: { kind: 'file' }, secret: 'ghp_x' },
    });

    const listed = await app.inject({ method: 'GET', url: '/api/credentials' });
    expect(listed.body).not.toContain('ghp_x');
    expect(listed.json().credentials[0].hasSecret).toBe(true);

    await app.close();
  });

  it('rejects unauthenticated api calls when a token is configured', async () => {
    const app = await createApp(harness, { token: 'sekret', webRoot: join(harness.dir, 'no-web') });

    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/projects',
          headers: { authorization: 'Bearer sekret' },
        })
      ).statusCode,
    ).toBe(200);

    await app.close();
  });
});
