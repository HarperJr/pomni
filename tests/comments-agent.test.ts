import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

/**
 * An orchestrator and a reviewer, attached to a project with one backlog item — enough to
 * delegate a review and have the reviewer speak about the item rather than only answer.
 *
 * The reviewer's id is pinned to `reviewer` and its name to `Review Agent` because the design
 * this suite is testing against gives that exact pairing as its worked example of an agent
 * heading — see comment-shape.md's `authorLabel`.
 */
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
  await harness.workflows.addAgent('discovery', {
    id: 'reviewer',
    name: 'Review Agent',
    spec: 'Reviews the change.',
    prompt: 'You review.',
  });
  await harness.workflows.attach('acme', 'discovery');
  const item = await harness.backlog.create('acme', { title: 'Auth changes' });
  return item.id;
}

const delegateToReviewer = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'reviewer', task }] }), '```'].join('\n');

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('an agent leaving a comment mid-run', () => {
  it('lands on the item, attributed to the agent and the step it spoke from, without blocking the run', async () => {
    const itemId = await seed();

    const reviewerReply = [
      'I looked at the auth changes.',
      '',
      '```comment',
      'Found a potential bug in the auth flow — the token refresh path never rotates.',
      '```',
      '',
      'Otherwise it looks fine.',
    ].join('\n');

    harness.llm.replies = [
      delegateToReviewer('review the auth changes'),
      reviewerReply,
      'Reviewed and merged.',
    ];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship the auth changes',
      itemId,
    });

    // Unlike asking a person, nothing here should ever open a question — the run runs straight
    // through to the end.
    const run = await completion;
    expect(run.status).toBe('passed');
    expect(run.result).toBe('Reviewed and merged.');
    expect((await harness.pipelines.get(run.id)).questions).toHaveLength(0);
    expect(await harness.pipelines.openQuestions()).toHaveLength(0);

    const detail = await harness.pipelines.get(run.id);
    const reviewerStep = detail.steps.find((step) => step.agentId === 'reviewer');
    expect(reviewerStep).toBeDefined();

    const onItem = await harness.comments.list({ subject: 'item', subjectId: itemId });
    expect(onItem).toHaveLength(1);
    const [comment] = onItem;
    expect(comment?.subject).toBe('item');
    expect(comment?.subjectId).toBe(itemId);
    expect(comment?.author).toEqual({
      kind: 'agent',
      agentId: 'reviewer',
      agentName: 'Review Agent',
      runId: run.id,
      stepId: reviewerStep!.id,
    });
    expect(comment?.text).toContain('the token refresh path never rotates');
  });

  it('addresses a comment to a person with an @-fence, and it shows up as outstanding', async () => {
    const itemId = await seed();

    const reviewerReply = [
      'Something needs a human call here.',
      '',
      '```comment @Sam',
      'This is the second time the API half slipped — should we split it?',
      '```',
    ].join('\n');

    harness.llm.replies = [
      delegateToReviewer('review the auth changes'),
      reviewerReply,
      'Reviewed.',
    ];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship the auth changes',
      itemId,
    });
    const run = await completion;

    expect(run.status).toBe('passed');
    expect((await harness.pipelines.get(run.id)).questions).toHaveLength(0);

    const outstanding = await harness.comments.outstanding(itemId);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.addressedTo).toBe('Sam');
    expect(outstanding[0]?.text).toContain('should we split it');
  });
});
