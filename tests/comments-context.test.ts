import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMENTS_CONTEXT_NAME } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

/** A project, a one-agent workflow that just answers, and one backlog item to comment on. */
async function seed(): Promise<string> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    id: 'lead',
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the question.',
    prompt: 'You lead.',
  });
  // An orchestrator with nobody to delegate to is not a runnable workflow, and every test
  // here starts a run. Without this the whole file fails on the seed rather than on anything
  // it means to assert.
  await harness.workflows.addAgent('discovery', {
    id: 'analyst',
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.attach('acme', 'discovery');
  const item = await harness.backlog.create('acme', { title: 'Wireframes' });
  return item.id;
}

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

function commentsFile(context: Array<{ name: string; content: string }>) {
  return context.find((file) => file.name === COMMENTS_CONTEXT_NAME);
}

describe('a comment reaching a run started from its item', () => {
  it('is undefined — not an empty file — when the item has no live comments', async () => {
    const itemId = await seed();
    harness.llm.replies = ['Nothing to add.'];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Look at it',
      itemId,
    });
    const run = await completion;

    expect(commentsFile(run.context)).toBeUndefined();
    expect(COMMENTS_CONTEXT_NAME).toBe('comments.md');
  });

  it('renders a person comment under the exact heading the design freezes', async () => {
    const itemId = await seed();
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'the wireframes moved, use the new export',
    });

    harness.llm.replies = ['Using the new export.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const run = await completion;

    const file = commentsFile(run.context);
    expect(file).toBeDefined();
    // The exact heading line, not merely present somewhere — an implementation that renders
    // an agent's comment the same way a person's is rendered must fail this line.
    expect(file!.content).toContain('### 2026-01-01T00:00:00.000Z — Nikita (person)');
    expect(file!.content).toContain('the wireframes moved, use the new export');

    // Given to every agent, not composed only for the orchestrator's eyes.
    expect(harness.llm.calls[0]?.messages[0]?.content).toContain(
      'the wireframes moved, use the new export',
    );
  });

  it('renders an agent comment under a heading that cannot be mistaken for a person\'s', async () => {
    const itemId = await seed();
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: {
        kind: 'agent',
        agentId: 'reviewer',
        agentName: 'Review Agent',
        runId: 'earlier-run',
        stepId: 'earlier-step',
      },
      text: 'found a bug in the auth flow',
    });

    harness.llm.replies = ['Noted.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const run = await completion;

    const file = commentsFile(run.context);
    expect(file!.content).toContain(
      '### 2026-01-01T00:00:00.000Z — Review Agent (agent `reviewer`, run earlier-run)',
    );
  });

  it('names an attachment by filename only, never its content', async () => {
    const itemId = await seed();
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'here is the layout',
      attachments: [{ name: 'layout.md', content: 'Two columns, sidebar on the left.' }],
    });

    harness.llm.replies = ['Done.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const run = await completion;

    const file = commentsFile(run.context);
    expect(file!.content).toContain('Attached: `layout.md`');
    expect(file!.content).not.toContain('Two columns, sidebar on the left.');
  });

  it('never surfaces a comment that was deleted before the run started', async () => {
    const itemId = await seed();
    const comment = await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'this was retracted',
    });
    await harness.comments.delete(comment.id, { kind: 'person', name: 'Nikita' });

    harness.llm.replies = ['Done.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const run = await completion;

    // The only comment on the item is gone, so there is nothing live to show at all.
    expect(commentsFile(run.context)).toBeUndefined();
  });
});

describe('a rerun and what it shows about comments written since the last attempt', () => {
  it('replaces comments.md by name rather than stacking a second copy', async () => {
    const itemId = await seed();
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'first note',
    });

    harness.llm.replies = ['Blocked on something.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const first = await completion;

    harness.llm.replies = ['Trying again.'];
    const { completion: rerunCompletion } = await harness.pipelines.rerun(first.id);
    const second = await rerunCompletion;

    const files = second.context.filter((file) => file.name === COMMENTS_CONTEXT_NAME);
    expect(files).toHaveLength(1);
  });

  it('splits comments into what the last attempt already saw and what arrived since', async () => {
    const itemId = await seed();
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'seen by the first attempt',
    });

    harness.llm.replies = ['First try.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const first = await completion;

    // Time passes between attempts; a comment written now is written after the first attempt
    // started, and must land in the "since" section of the second attempt's context.
    harness.clock.advance(60_000);
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Sam' },
      text: 'written after the first attempt',
    });

    harness.llm.replies = ['Second try.'];
    const { completion: rerunCompletion } = await harness.pipelines.rerun(first.id);
    const second = await rerunCompletion;

    const file = commentsFile(second.context)!;
    expect(file.content).toContain('## Already in front of the last attempt');
    expect(file.content).toContain(`## Written since the last attempt (run ${first.id})`);

    const alreadyHeading = file.content.indexOf('## Already in front of the last attempt');
    const sinceHeading = file.content.indexOf(`## Written since the last attempt (run ${first.id})`);
    const oldNote = file.content.indexOf('seen by the first attempt');
    const newNote = file.content.indexOf('written after the first attempt');

    expect(oldNote).toBeGreaterThan(alreadyHeading);
    expect(oldNote).toBeLessThan(sinceHeading);
    expect(newNote).toBeGreaterThan(sinceHeading);
  });

  it('shows neither "##" heading when nothing was written since the last attempt', async () => {
    const itemId = await seed();
    await harness.comments.add({
      subject: 'item',
      subjectId: itemId,
      projectId: 'acme',
      author: { kind: 'person', name: 'Nikita' },
      text: 'only note there ever was',
    });

    harness.llm.replies = ['First try.'];
    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Build it',
      itemId,
    });
    const first = await completion;

    harness.llm.replies = ['Second try.'];
    const { completion: rerunCompletion } = await harness.pipelines.rerun(first.id);
    const second = await rerunCompletion;

    const file = commentsFile(second.context)!;
    expect(file.content).not.toMatch(/^##\s/m);
  });
});
