import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowSchema, type Drain } from '@pomni/core';
import { createApp } from '@pomni/server';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * POMN-74: the server half of the drain loop — `GET /api/projects/:id/drains` and
 * `GET /api/drains/:id`, so the run tracker can show a run as belonging to the drain that
 * launched it (per the item's plan: "expose the drain in the run list … the record is what
 * this item is for").
 *
 * Neither route exists yet — `packages/server/src/routes/pipelines.ts` has routes for runs
 * only. No `cli-drain-surface.md` handover was attached to fix these exact paths and response
 * shapes (see the note in `tests/cli-drain.test.ts`); the shapes below follow the existing
 * convention in that same file (`{ runs: [...] }`, `{ run }`) applied to drains, and are a
 * proposal to confirm or correct, not settled fact.
 */

let harness: TestHarness;

const verdict = (outcome: string, unmet: string[] = []) =>
  ['```json', JSON.stringify({ outcome, unmet }), '```'].join('\n');
const pass = () => `Done.\n\n${verdict('done')}`;

/** Same flow shape `tests/drain.test.ts` and `tests/cli-drain.test.ts` seed. */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme', id: 'acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the work.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('discovery', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.attach('acme', 'discovery');

  const dir = await makeNodeRepo(join(harness.dir, 'web'));
  harness.git.trackRepo(dir);
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    id: 'web',
  });
  await completion;
  await harness.repos.update('acme', repo.id, { worktrees: 'always' });

  await harness.projects.update('acme', {
    taskFlow: FlowSchema.parse({
      initial: 'ready',
      states: ['ready', 'in_progress', 'done', 'blocked'],
      transitions: [
        { from: 'ready', to: 'in_progress' },
        { from: 'in_progress', to: 'done', mode: 'auto', requires: { gate: 'default' } },
        { from: 'in_progress', to: 'blocked' },
      ],
    }),
  });
}

async function readyItem(title: string, touches: string[]): Promise<{ id: string }> {
  const item = await harness.backlog.create('acme', { title, repos: ['web'] });
  await harness.backlog.update('acme', item.id, { touches });
  return item;
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('GET /api/projects/:id/drains', () => {
  it('returns the project\'s drains, newest first', async () => {
    const a = await readyItem('A', ['src/a.ts']);
    harness.llm.replies = [pass()];
    const first = await (await harness.pipelines.drain({ projectId: 'acme' })).completion;

    await readyItem('B', ['src/b.ts']);
    harness.llm.replies = [pass()];
    const second = await (await harness.pipelines.drain({ projectId: 'acme' })).completion;

    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const response = await app.inject({ method: 'GET', url: '/api/projects/acme/drains' });

    expect(response.statusCode).toBe(200);
    const drains = response.json().drains as Drain[];
    expect(drains.map((drain) => drain.id)).toEqual([second.id, first.id]);
    expect(drains[0]?.waves.flatMap((wave) => wave.itemIds)).not.toContain(a.id);

    await app.close();
  });
});

describe('GET /api/drains/:id', () => {
  it('returns one drain by id', async () => {
    await readyItem('A', ['src/a.ts']);
    harness.llm.replies = [pass()];
    const drain = await (await harness.pipelines.drain({ projectId: 'acme' })).completion;

    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const response = await app.inject({ method: 'GET', url: `/api/drains/${drain.id}` });

    expect(response.statusCode).toBe(200);
    expect((response.json().drain as Drain).id).toBe(drain.id);

    await app.close();
  });

  it('404s for a drain id that matches nothing', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const response = await app.inject({ method: 'GET', url: '/api/drains/01NOSUCHDRAIN000000000000' });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
