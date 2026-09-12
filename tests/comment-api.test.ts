import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@pomni/server';
import { createHarness, type TestHarness } from './harness.js';

/**
 * The routes behind the notes boxes on an item and a run.
 *
 * The service and its store are covered elsewhere; what is new here is that a browser can
 * reach them at all — before this, comments existed and had no surface but an agent's.
 */
describe('comment routes', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
    await harness.projects.create({ name: 'Acme' });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('writes a note on an item and reads it back', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link' });
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const written = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/comments/item/${item.id}`,
      payload: { text: 'use the new wireframes', author: 'Nikita' },
    });
    expect(written.statusCode).toBe(201);
    expect(written.json().comment.author).toEqual({ kind: 'person', name: 'Nikita' });

    const listed = await app.inject({ method: 'GET', url: `/api/comments/item/${item.id}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().comments).toHaveLength(1);
    expect(listed.json().comments[0].text).toBe('use the new wireframes');

    await app.close();
  });

  /**
   * A browser has no way to claim it is an agent. `authorLabel` promises a reader that an
   * agent's note is never mistakable for a person's, and a route that took the author kind
   * from the request body would let anything with the url break that promise. `author` is a
   * name, so an author shaped like an agent is refused rather than quietly flattened — a
   * caller that meant something Pomni will not do should hear so.
   */
  it('refuses a body claiming to be an agent, rather than flattening it', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link' });
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const written = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/comments/item/${item.id}`,
      payload: { text: 'from the browser', author: { kind: 'agent', agentName: 'scout' } },
    });
    expect(written.statusCode).toBe(422);

    await app.close();
  });

  it('addresses a note to a person, and the item reports it outstanding', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link' });
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    await app.inject({
      method: 'POST',
      url: `/api/projects/acme/comments/item/${item.id}`,
      payload: { text: 'which copy do we use?', author: 'Nikita', addressedTo: 'Sasha' },
    });

    expect(await harness.comments.outstanding(item.id)).toHaveLength(1);

    await app.close();
  });

  /** Withdrawing keeps the row and stops every reader showing its text. */
  it('withdraws a note without removing it from the thread', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link' });
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const written = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/comments/item/${item.id}`,
      payload: { text: 'ignore this one', author: 'Nikita' },
    });
    const id = written.json().comment.id;

    const withdrawn = await app.inject({
      method: 'DELETE',
      url: `/api/comments/${id}`,
      payload: { author: 'Nikita' },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().comment.deletedAt).not.toBeNull();

    // Hidden by default, and still there for a caller that asks — which the notes box does,
    // so a withdrawn note reads as withdrawn rather than as one that was never written.
    const hidden = await app.inject({ method: 'GET', url: `/api/comments/item/${item.id}` });
    expect(hidden.json().comments).toHaveLength(0);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/comments/item/${item.id}?includeDeleted=true`,
    });
    expect(listed.json().comments).toHaveLength(1);
    expect(listed.json().comments[0].deletedAt).not.toBeNull();

    await app.close();
  });

  it('refuses a subject it does not know', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const response = await app.inject({ method: 'GET', url: '/api/comments/invoice/ACME-1' });
    expect(response.statusCode).toBe(422);
    await app.close();
  });
});
