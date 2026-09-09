import { describe, expect, it } from 'vitest';
import {
  authorLabel,
  CommentSchema,
  commentsContext,
  isAgentAuthor,
  isDeleted,
  isOutstanding,
  MAX_COMMENT_BYTES,
  UNATTRIBUTED_PERSON,
  type Comment,
  type CommentAuthor,
} from '@pomni/core';
import { MAX_CONTEXT_FILE_BYTES } from '@pomni/core';

/**
 * Only the fields a test cares about need overriding — the rest are the shape a plain
 * person comment on an item takes, per the frozen design in comment-shape.md.
 */
function makeComment(overrides: Partial<Comment> = {}): Comment {
  return CommentSchema.parse({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    subject: 'item',
    subjectId: 'ACME-1',
    projectId: 'acme',
    author: { kind: 'person', name: 'Nikita' } satisfies CommentAuthor,
    text: 'the wireframes moved, use the new export',
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
  });
}

describe('authorLabel', () => {
  it('labels a person by name, marked as a person', () => {
    expect(authorLabel({ kind: 'person', name: 'Nikita' })).toBe('Nikita (person)');
  });

  it('labels an agent by name, id and the run it was speaking from — never mistakable for a person', () => {
    expect(
      authorLabel({
        kind: 'agent',
        agentId: 'reviewer',
        agentName: 'Review Agent',
        runId: 'run-1',
        stepId: 'step-1',
      }),
    ).toBe('Review Agent (agent `reviewer`, run run-1)');
  });

  it('falls back to the unattributed name for a person comment with none', () => {
    const author = CommentSchema.parse({
      ...makeComment(),
      author: { kind: 'person' },
    }).author;
    expect(authorLabel(author)).toBe(`${UNATTRIBUTED_PERSON} (person)`);
  });
});

describe('isAgentAuthor', () => {
  it('is true only for the agent arm of the union', () => {
    expect(isAgentAuthor({ kind: 'person', name: 'Nikita' })).toBe(false);
    expect(
      isAgentAuthor({
        kind: 'agent',
        agentId: 'reviewer',
        agentName: 'Review Agent',
        runId: 'run-1',
        stepId: 'step-1',
      }),
    ).toBe(true);
  });
});

describe('isDeleted / isOutstanding', () => {
  it('a plain comment is neither deleted nor outstanding', () => {
    const comment = makeComment();
    expect(isDeleted(comment)).toBe(false);
    expect(isOutstanding(comment)).toBe(false);
  });

  it('a tombstoned comment is deleted regardless of anything else on it', () => {
    const comment = makeComment({ deletedAt: '2026-09-06T00:00:00.000Z', addressedTo: 'Sam' });
    expect(isDeleted(comment)).toBe(true);
    expect(isOutstanding(comment)).toBe(false);
  });

  it('is outstanding only while addressed, unresolved and not deleted', () => {
    expect(isOutstanding(makeComment({ addressedTo: 'Sam' }))).toBe(true);
    expect(
      isOutstanding(
        makeComment({ addressedTo: 'Sam', resolvedAt: '2026-09-06T00:00:00.000Z' }),
      ),
    ).toBe(false);
    expect(
      isOutstanding(
        makeComment({ addressedTo: 'Sam', deletedAt: '2026-09-06T00:00:00.000Z' }),
      ),
    ).toBe(false);
    expect(isOutstanding(makeComment({ addressedTo: null }))).toBe(false);
  });
});

describe('commentsContext', () => {
  it('is undefined when there is nothing live to show', () => {
    expect(commentsContext([])).toBeUndefined();
    expect(
      commentsContext([makeComment({ deletedAt: '2026-09-06T00:00:00.000Z' })]),
    ).toBeUndefined();
  });

  it('drops rows written on a run, keeping only what was written on the item', () => {
    const onItem = makeComment({ id: 'a', subject: 'item' });
    const onRun = makeComment({ id: 'b', subject: 'run', subjectId: 'run-1' });
    const file = commentsContext([onRun, onItem]);
    expect(file?.content).toContain(onItem.text);
    expect(file?.content).not.toContain(onRun.text);
  });

  it('never surfaces a deleted comment, even when handed one directly', () => {
    const live = makeComment({ id: 'a', text: 'still here' });
    const gone = makeComment({
      id: 'b',
      text: 'should never appear',
      deletedAt: '2026-09-06T00:00:00.000Z',
    });
    const file = commentsContext([live, gone]);
    expect(file?.content).toContain('still here');
    expect(file?.content).not.toContain('should never appear');
  });

  it('orders comments oldest first by id, exactly the heading the design freezes', () => {
    const first = makeComment({
      id: 'a',
      createdAt: '2026-09-05T00:00:00.000Z',
      author: { kind: 'person', name: 'Nikita' },
      text: 'first',
    });
    const second = makeComment({
      id: 'b',
      createdAt: '2026-09-05T00:05:00.000Z',
      author: {
        kind: 'agent',
        agentId: 'reviewer',
        agentName: 'Review Agent',
        runId: 'run-1',
        stepId: 'step-1',
      },
      text: 'second',
    });

    // Handed in the wrong order on purpose: the function must sort by id, not trust the caller.
    const file = commentsContext([second, first]);
    const firstAt = file!.content.indexOf('### 2026-09-05T00:00:00.000Z — Nikita (person)');
    const secondAt = file!.content.indexOf(
      '### 2026-09-05T00:05:00.000Z — Review Agent (agent `reviewer`, run run-1)',
    );
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it('names an attachment without carrying its content', () => {
    const comment = makeComment({
      attachments: [{ name: 'layout.md', content: 'Two columns, sidebar on the left.' }],
    });
    const file = commentsContext([comment]);
    expect(file?.content).toContain('Attached: `layout.md`');
    expect(file?.content).not.toContain('Two columns, sidebar on the left.');
  });

  it('splits into what was already in front of the last attempt and what is new since it', () => {
    const before = makeComment({
      id: 'a',
      createdAt: '2026-09-01T00:00:00.000Z',
      text: 'seen already',
    });
    const after = makeComment({
      id: 'b',
      createdAt: '2026-09-06T00:00:00.000Z',
      text: 'written since',
    });

    const file = commentsContext([before, after], {
      since: { at: '2026-09-05T00:00:00.000Z', runId: 'run-1' },
    });

    expect(file?.content).toContain('## Already in front of the last attempt');
    expect(file?.content).toContain('## Written since the last attempt (run run-1)');
    const beforeHeading = file!.content.indexOf('## Already in front of the last attempt');
    const afterHeading = file!.content.indexOf('## Written since the last attempt (run run-1)');
    const seenAt = file!.content.indexOf('seen already');
    const newAt = file!.content.indexOf('written since');
    expect(seenAt).toBeGreaterThan(beforeHeading);
    expect(seenAt).toBeLessThan(afterHeading);
    expect(newAt).toBeGreaterThan(afterHeading);
  });

  it('omits the "already in front" heading when every comment is new, and vice versa', () => {
    const onlyNew = commentsContext([makeComment({ id: 'a', createdAt: '2026-09-06T00:00:00.000Z' })], {
      since: { at: '2026-09-05T00:00:00.000Z', runId: 'run-1' },
    });
    expect(onlyNew?.content).not.toContain('## Already in front of the last attempt');
    expect(onlyNew?.content).toContain('## Written since the last attempt (run run-1)');

    const onlyOld = commentsContext([makeComment({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z' })], {
      since: { at: '2026-09-05T00:00:00.000Z', runId: 'run-1' },
    });
    expect(onlyOld?.content).not.toContain('## Written since the last attempt');
  });

  it('has no "##" section headings at all when nothing is new', () => {
    const file = commentsContext([makeComment({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z' })], {
      since: { at: '2026-09-05T00:00:00.000Z', runId: 'run-1' },
    });
    expect(file?.content).not.toMatch(/^##\s/m);
  });

  it('caps the file at MAX_CONTEXT_FILE_BYTES by dropping the oldest notes first', () => {
    const huge = 'x'.repeat(MAX_CONTEXT_FILE_BYTES);
    const old = makeComment({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z', text: 'old and dropped' });
    const recent = makeComment({ id: 'b', createdAt: '2026-09-06T00:00:00.000Z', text: huge });

    const file = commentsContext([old, recent]);
    expect(file).toBeDefined();
    expect(Buffer.byteLength(file!.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_FILE_BYTES);
    expect(file!.content).not.toContain('old and dropped');
    expect(file!.content).toMatch(/_1 older notes? omitted — this file is capped at 256 KB\._/);
  });
});

describe('the comment text limit', () => {
  it('is 20,000 bytes, so a store-level test can assert the boundary against a named constant', () => {
    expect(MAX_COMMENT_BYTES).toBe(20_000);
  });
});
