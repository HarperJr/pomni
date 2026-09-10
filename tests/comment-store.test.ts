import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid, type Comment, type CommentAuthor } from '@pomni/core';
import { SqliteCommentStore } from '@pomni/infra';

let dir: string;
/** Every store opened in a test, closed in teardown — Windows holds the file handle otherwise. */
let opened: Array<{ close(): void }>;

beforeEach(async () => {
  opened = [];
  dir = await mkdtemp(join(tmpdir(), 'pomni-comment-store-'));
});

afterEach(async () => {
  for (const store of opened) {
    try {
      store.close();
    } catch {
      // Already closed, or never opened cleanly.
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function open(): SqliteCommentStore {
  const store = new SqliteCommentStore(join(dir, 'pomni.db'));
  opened.push(store);
  return store;
}

const person = (name: string): CommentAuthor => ({ kind: 'person', name });

function makeComment(overrides: Partial<Comment> & { id: string }): Comment {
  return {
    subject: 'item',
    subjectId: 'ACME-1',
    projectId: 'acme',
    author: person('Nikita'),
    text: 'a note',
    attachments: [],
    addressedTo: null,
    resolvesCommentId: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByCommentId: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('insert and list', () => {
  it('orders by id, not by createdAt — the field a millisecond-shared batch cannot use', async () => {
    const store = open();

    // Same millisecond on every row, as a FixedClock produces for a burst of comments in one
    // turn. Only the ULID's random suffix can tell them apart, so a store that orders by
    // createdAt would return them in whatever order SQLite happens to store ties in.
    const sameMs = 1_800_000_000_000;
    const ids = [ulid(sameMs), ulid(sameMs), ulid(sameMs)];
    expect(new Set(ids).size).toBe(3);
    // Confirm the fixture is actually testing what it claims: the timestamps really do tie.
    const createdAt = new Date(sameMs).toISOString();

    for (const id of ids) {
      await store.insert(makeComment({ id, createdAt, text: `note ${id}` }));
    }

    const listed = await store.list({ subject: 'item', subjectId: 'ACME-1' });
    expect(listed.map((c: Comment) => c.id)).toEqual([...ids].sort());
  });

  it('round-trips every field, including a null-author-name person and an agent author', async () => {
    const store = open();
    await store.insert(
      makeComment({
        id: 'a',
        author: { kind: 'agent', agentId: 'reviewer', agentName: 'Review Agent', runId: 'run-1', stepId: 'step-1' },
        addressedTo: 'Sam',
      }),
    );

    const got = await store.get('a');
    expect(got?.author).toEqual({
      kind: 'agent',
      agentId: 'reviewer',
      agentName: 'Review Agent',
      runId: 'run-1',
      stepId: 'step-1',
    });
    expect(got?.addressedTo).toBe('Sam');
  });

  it('scopes list to the given subject and subjectId', async () => {
    const store = open();
    await store.insert(makeComment({ id: 'a', subject: 'item', subjectId: 'ACME-1' }));
    await store.insert(makeComment({ id: 'b', subject: 'item', subjectId: 'ACME-2' }));
    await store.insert(makeComment({ id: 'c', subject: 'run', subjectId: 'ACME-1' }));

    const onItem1 = await store.list({ subject: 'item', subjectId: 'ACME-1' });
    expect(onItem1.map((c: Comment) => c.id)).toEqual(['a']);
  });
});

describe('deletion is a tombstone, not a removal', () => {
  it('keeps the text on the row, hides it from list, and shows it back with includeDeleted', async () => {
    const store = open();
    await store.insert(makeComment({ id: 'a', text: 'what was said' }));

    await store.markDeleted('a', { at: '2026-09-06T00:00:00.000Z', by: person('Nikita') });

    const visible = await store.list({ subject: 'item', subjectId: 'ACME-1' });
    expect(visible).toHaveLength(0);

    const withDeleted = await store.list({
      subject: 'item',
      subjectId: 'ACME-1',
      includeDeleted: true,
    });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.text).toBe('what was said');
    expect(withDeleted[0]?.deletedAt).toBe('2026-09-06T00:00:00.000Z');
  });

  it('never returns a deleted comment for run context, includeDeleted or not', async () => {
    const store = open();
    await store.insert(makeComment({ id: 'a', text: 'gone' }));
    await store.markDeleted('a', { at: '2026-09-06T00:00:00.000Z', by: person('Nikita') });

    const context = await store.forRunContext('ACME-1');
    expect(context.map((c: Comment) => c.id)).not.toContain('a');
  });
});

describe('markResolved', () => {
  it('refuses a comment that was never addressed to anyone', async () => {
    const store = open();
    await store.insert(makeComment({ id: 'a', addressedTo: null }));

    await expect(
      store.markResolved('a', { at: '2026-09-06T00:00:00.000Z', by: person('Sam'), byCommentId: null }),
    ).rejects.toThrow();
  });

  it('is a no-op the second time it is called on the same comment', async () => {
    const store = open();
    await store.insert(makeComment({ id: 'a', addressedTo: 'Sam' }));

    await store.markResolved('a', { at: '2026-09-06T00:00:00.000Z', by: person('Sam'), byCommentId: null });
    const firstResolvedAt = (await store.get('a'))?.resolvedAt;

    await store.markResolved('a', { at: '2026-09-07T00:00:00.000Z', by: person('Sam'), byCommentId: null });
    const secondResolvedAt = (await store.get('a'))?.resolvedAt;

    expect(secondResolvedAt).toBe(firstResolvedAt);
  });
});

describe('reopening the database', () => {
  it('runs its migrations again harmlessly and keeps the rows it already had', async () => {
    const path = join(dir, 'reopen.db');
    const first = new SqliteCommentStore(path);
    opened.push(first);
    await first.insert(makeComment({ id: 'a', text: 'kept across reopen' }));

    const second = new SqliteCommentStore(path);
    opened.push(second);

    const got = await second.get('a');
    expect(got?.text).toBe('kept across reopen');
  });
});
