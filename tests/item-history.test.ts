import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment, TransitionRecord } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

/**
 * The shape this suite expects `BacklogItemDetail.activity` to take — chosen here because no
 * design handed one down (item.ts stays untouched; the merge is display-only). A future reader
 * should treat this as this suite's assumption, not an established contract.
 */
interface ItemActivityEntry {
  at: string;
  kind: 'transition' | 'comment';
  transition?: TransitionRecord;
  comment?: Comment;
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * `backlog.get()` merges an item's transition history with its comments into one time-ordered
 * list, per the item's acceptance criteria: "'moved to blocked' and 'blocked because Figma was
 * unreachable' belong next to each other." Nothing else in this repo has ever asserted on that
 * merge, so this is the first test of `BacklogItemDetail`'s comment-aware shape — a later reader
 * should not assume `.activity` is an established field name elsewhere; it is this suite's name
 * for "the merged list", chosen because none was handed down with the design.
 */
describe('an item\'s history interleaved with its comments', () => {
  it('orders a comment and a transition next to each other by when they happened', async () => {
    const item = await harness.backlog.create('acme', { title: 'Ship the redesign' });

    harness.clock.advance(1000);
    await harness.comments.add({
      subject: 'item',
      subjectId: item.id,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'Figma was unreachable, blocking this',
    });

    harness.clock.advance(1000);
    await harness.backlog.transition('acme', item.id, 'blocked', { reason: 'Figma unreachable' });

    const detail = await harness.backlog.get('acme', item.id);
    const activity = detail.activity as ItemActivityEntry[];
    expect(Array.isArray(activity)).toBe(true);

    const timestamps = activity.map((entry) => entry.at);
    expect([...timestamps]).toEqual([...timestamps].sort());

    const commentEntry = activity.find((entry) => entry.kind === 'comment');
    const transitionEntry = activity.find((entry) => entry.kind === 'transition');
    expect(commentEntry?.comment?.text).toBe('Figma was unreachable, blocking this');
    expect(transitionEntry?.transition?.to).toBe('blocked');

    // The comment came first in wall-clock time and must sort before the transition.
    expect(activity.indexOf(commentEntry!)).toBeLessThan(activity.indexOf(transitionEntry!));
  });

  it('shows a deleted comment as a deletion, with the text withheld', async () => {
    const item = await harness.backlog.create('acme', { title: 'Ship the redesign' });

    const comment = await harness.comments.add({
      subject: 'item',
      subjectId: item.id,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'a private note nobody should see after deletion',
    });
    await harness.comments.delete(comment.id, { kind: 'person', name: 'Nikita' });

    const detail = await harness.backlog.get('acme', item.id);
    const activity = detail.activity as ItemActivityEntry[];
    const entry = activity.find(
      (candidate) => candidate.kind === 'comment' && candidate.comment?.id === comment.id,
    );

    expect(entry).toBeDefined();
    expect(entry?.comment?.deletedAt).not.toBeNull();
    // Withheld: the original text must not be readable off the merged history, however the
    // deletion itself is represented.
    expect(entry?.comment?.text).not.toBe('a private note nobody should see after deletion');
  });
});
