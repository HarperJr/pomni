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

  describe('runs across every project', () => {
    /** A project with a runnable one-agent workflow attached, so `pipelines.start` succeeds. */
    async function seedProject(name: string): Promise<string> {
      const project = await harness.projects.create({ name });
      await harness.workflows.attach(project.id, 'solo');
      return project.id;
    }

    beforeEach(async () => {
      await harness.workflows.create({ name: 'Solo' });
      await harness.workflows.addAgent('solo', {
        name: 'Lead',
        role: 'orchestrator',
        spec: 'Owns the question.',
        prompt: 'You lead.',
      });
      // An orchestrator with nobody to delegate to is not runnable.
      await harness.workflows.addAgent('solo', {
        name: 'Analyst',
        spec: 'Answers questions.',
        prompt: 'You analyse.',
      });
    });

    it('lists runs belonging to more than one project', async () => {
      await seedProject('Acme');
      await seedProject('Globex');
      harness.llm.replies = ['Done with acme.', 'Done with globex.'];

      await (await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' })).completion;
      await (await harness.pipelines.start({ projectId: 'globex', task: 'Ship it too' })).completion;

      const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
      const listed = await app.inject({ method: 'GET', url: '/api/pipelines' });

      expect(listed.statusCode).toBe(200);
      const projectIds = listed.json().runs.map((run: { projectId: string }) => run.projectId);
      // The point of the endpoint: without a `project` param it answers for all of them.
      expect(new Set(projectIds)).toEqual(new Set(['acme', 'globex']));

      await app.close();
    });

    it('returns only the run still in flight when asked for running ones', async () => {
      await seedProject('Acme');
      await seedProject('Globex');

      // A finished run to be excluded.
      harness.llm.replies = ['Done with acme.'];
      const finished = await (
        await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' })
      ).completion;
      expect(finished.status).toBe('passed');

      // A second run held mid-answer, so there is a genuinely running row to find.
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      harness.llm.gate = () => held;
      const inFlight = await harness.pipelines.start({ projectId: 'globex', task: 'Keep going' });

      const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
      try {
        const listed = await app.inject({ method: 'GET', url: '/api/pipelines?status=running' });

        expect(listed.statusCode).toBe(200);
        const runs = listed.json().runs as Array<{ id: string; status: string; projectId: string }>;
        expect(runs.map((run) => run.id)).toEqual([inFlight.run.id]);
        expect(runs[0]?.projectId).toBe('globex');
        expect(runs.some((run) => run.id === finished.id)).toBe(false);
      } finally {
        // A failed assertion must fail the test, not wedge the suite: the held run has to be let
        // go and settled before cleanup removes the directory its sqlite handle is still on.
        // `allSettled` so a rejection here cannot replace the assertion error that got us here.
        release();
        await Promise.allSettled([inFlight.completion]);
        await app.close();
      }
      // Settled above, so this only re-reads the outcome — it surfaces a run that ended badly.
      await inFlight.completion;
    });

    it('rejects a status it does not recognise instead of answering with nothing', async () => {
      const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

      const response = await app.inject({ method: 'GET', url: '/api/pipelines?status=pending' });

      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json().code).toBe('validation');

      await app.close();
    });
  });
});
