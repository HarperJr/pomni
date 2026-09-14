import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineRunSchema, QuestionSchema, type PipelineRun, type Question } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

/**
 * POMN-75: a run waiting on a person should be able to reach one.
 *
 * Nothing under test exists yet. `packages/core/src/ports/notify.ts` has no `WebhookPort` or
 * `WebhookRequest`, `packages/core/src/app/notification-service.ts` has no `NotificationService`,
 * and `tests/harness.ts` imports both by their real path rather than through the `@pomni/core`
 * barrel — so this whole file is expected to fail to even load, with a module-not-found error,
 * until those two files exist. That is the failure this file is meant to produce; once the
 * service is written, the tests below are what it has to satisfy.
 *
 * Shapes below follow the `pomn-75-shapes.md` handover: `NotificationEvent` carries `kind`,
 * `projectId`, `runId` (null only for `test`), `itemId`, `reason`, `url`, `ts`, `questionId` and
 * `mergeRequestUrl`; the webhook body is `{ version: 1, ...event }`; `PipelineStore.markNotified`
 * is the dedupe row, claimed once per event before any channel is tried.
 */

let harness: TestHarness;

async function configureNotify(
  patch: { desktop?: boolean; webhookUrl?: string | null; credential?: string | null } = {},
): Promise<void> {
  // `notify` is not on `PomniConfig` yet — POMN-75 adds it (`pomn-75-shapes.md`). Cast rather
  // than assert away the type error, so this keeps compiling once the field lands too.
  await harness.workspace.setConfig({
    notify: {
      desktop: patch.desktop ?? true,
      webhook: {
        url: patch.webhookUrl === undefined ? 'http://hook.test/x' : patch.webhookUrl,
        credential: patch.credential ?? null,
      },
    },
  } as Parameters<typeof harness.workspace.setConfig>[0]);
}

let runCounter = 0;

/** A minimal, schema-valid run — the pattern `pipeline-listing.test.ts`'s `seedRun` uses. */
function seedRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  runCounter += 1;
  return PipelineRunSchema.parse({
    id: `run-${String(runCounter).padStart(4, '0')}`,
    projectId: 'acme',
    workflowId: 'discovery',
    workflowName: 'Discovery',
    providerId: 'claude-code',
    task: 'do the thing',
    itemId: null,
    status: 'running',
    result: null,
    error: null,
    costUsd: null,
    startedAt: '2026-09-14T10:00:00.000Z',
    endedAt: null,
    durationMs: null,
    ...overrides,
  });
}

function seedQuestion(runId: string, overrides: Partial<Question> = {}): Question {
  return QuestionSchema.parse({
    id: `q-${runId}`,
    runId,
    stepId: 'step-1',
    agentId: 'lead',
    agentName: 'Lead',
    question: 'Which layout?\nA or B, take your pick.',
    answer: null,
    status: 'open',
    askedAt: '2026-09-14T10:00:00.000Z',
    answeredAt: null,
    ...overrides,
  });
}

async function itemId(): Promise<string> {
  await harness.projects.create({ name: 'Acme', id: 'acme' });
  const item = await harness.backlog.create('acme', { title: 'Only', repos: [] });
  return item.id;
}

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a run asks a question', () => {
  it('notifies both channels exactly once, and not again for the identical event', async () => {
    await configureNotify();
    const item = await itemId();
    const run = seedRun({ itemId: item, status: 'running' });
    await harness.pipelineStore.insertRun(run);
    const question = seedQuestion(run.id);
    await harness.pipelineStore.insertQuestion(question);

    const event = {
      type: 'pipeline.question.asked' as const,
      runId: run.id,
      questionId: question.id,
      agentName: 'Lead',
      question: question.question,
    };

    harness.events.emit(event);
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(1);
    expect(harness.desktop.notified).toHaveLength(1);

    const [posted] = harness.webhook.posted;
    expect(posted?.event.kind).toBe('question');
    expect(posted?.event.runId).toBe(run.id);
    expect(posted?.event.itemId).toBe(item);
    expect(posted?.event.questionId).toBe(question.id);
    expect(posted?.event.reason).toBe('Which layout?');
    expect(posted?.event.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:7777/p/acme/`));

    harness.events.emit(event);
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(1);
    expect(harness.desktop.notified).toHaveLength(1);
  });
});

describe('a run finishes with a red gate', () => {
  it('notifies once, carrying the gate summary as the reason', async () => {
    await configureNotify();
    const item = await itemId();
    const run = seedRun({
      itemId: item,
      status: 'passed',
      gateStatus: 'failed',
      gateSummary: 'test failed: 3 of 412',
      endedAt: '2026-09-14T10:05:00.000Z',
    });
    await harness.pipelineStore.insertRun(run);

    harness.events.emit({
      type: 'pipeline.finished',
      runId: run.id,
      projectId: 'acme',
      status: run.status,
      summary: 'done',
    });
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(1);
    expect(harness.webhook.posted[0]?.event.kind).toBe('gate_failed');
    expect(harness.webhook.posted[0]?.event.reason).toBe('test failed: 3 of 412');
    expect(harness.desktop.notified).toHaveLength(1);
  });

  it('sends nothing when the gate passed', async () => {
    await configureNotify();
    const item = await itemId();
    const run = seedRun({
      itemId: item,
      status: 'passed',
      gateStatus: 'passed',
      endedAt: '2026-09-14T10:05:00.000Z',
    });
    await harness.pipelineStore.insertRun(run);

    harness.events.emit({
      type: 'pipeline.finished',
      runId: run.id,
      projectId: 'acme',
      status: run.status,
      summary: 'done',
    });
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(0);
    expect(harness.desktop.notified).toHaveLength(0);
  });
});

describe('an item reaches in_review with a merge request', () => {
  async function moveToInReview(item: string): Promise<void> {
    await harness.backlog.transition('acme', item, 'ready', { force: true });
    await harness.backlog.transition('acme', item, 'in_progress', { force: true });
    await harness.backlog.transition('acme', item, 'in_review', { force: true });
  }

  it('notifies once, with the merge request url', async () => {
    await configureNotify();
    const item = await itemId();
    const run = seedRun({
      itemId: item,
      status: 'passed',
      gateStatus: 'passed',
      endedAt: '2026-09-14T10:05:00.000Z',
    });
    await harness.pipelineStore.insertRun(run);
    await harness.pipelineStore.putArtifacts([
      {
        id: 'mr-artifact',
        runId: run.id,
        stepId: null,
        name: 'feature/only',
        kind: 'report',
        path: 'https://forge.test/mr/1',
        change: 'merge request',
        bytes: 0,
        createdAt: '2026-09-14T10:05:00.000Z',
      },
    ]);

    await moveToInReview(item);
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(1);
    expect(harness.webhook.posted[0]?.event.kind).toBe('in_review');
    expect(harness.webhook.posted[0]?.event.mergeRequestUrl).toBe('https://forge.test/mr/1');
    expect(harness.desktop.notified).toHaveLength(1);
  });

  it('sends nothing when the run left no merge-request artifact', async () => {
    await configureNotify();
    const item = await itemId();
    const run = seedRun({
      itemId: item,
      status: 'passed',
      gateStatus: 'passed',
      endedAt: '2026-09-14T10:05:00.000Z',
    });
    await harness.pipelineStore.insertRun(run);

    await moveToInReview(item);
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(0);
    expect(harness.desktop.notified).toHaveLength(0);
  });
});

describe('a channel that fails', () => {
  it('never touches the run or the item, and still claims the dedupe row', async () => {
    await configureNotify();
    const item = await itemId();
    const run = seedRun({
      itemId: item,
      status: 'passed',
      gateStatus: 'failed',
      gateSummary: 'test failed: 3 of 412',
      endedAt: '2026-09-14T10:05:00.000Z',
    });
    await harness.pipelineStore.insertRun(run);

    harness.webhook.failNext = 'ECONNREFUSED';
    harness.desktop.notifyFails = 'no display';

    const event = {
      type: 'pipeline.finished' as const,
      runId: run.id,
      projectId: 'acme',
      status: run.status,
      summary: 'done',
    };

    // Neither channel's failure may surface as a rejection: a person's missing toast or a
    // dead webhook must never be what fails the run that triggered it.
    harness.events.emit(event);
    await harness.notifications.idle();

    const reloadedRun = await harness.pipelineStore.getRun(run.id);
    expect(reloadedRun?.status).toBe('passed');
    const reloadedItem = await harness.backlog.get('acme', item);
    expect(reloadedItem.status).toBe('backlog');

    const warnings = await harness.serverLog.read({ level: 'warn' });
    expect(warnings.length).toBeGreaterThan(0);

    // The row was still claimed: a second identical event sends nothing, on either channel,
    // even though neither one is failing any more.
    harness.webhook.failNext = null;
    harness.desktop.notifyFails = null;
    harness.events.emit(event);
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(0);
    expect(harness.desktop.notified).toHaveLength(0);
  });
});

describe('nothing configured', () => {
  it('sends nothing for any of the three events', async () => {
    const item = await itemId();
    const run = seedRun({
      itemId: item,
      status: 'passed',
      gateStatus: 'failed',
      gateSummary: 'red',
      endedAt: '2026-09-14T10:05:00.000Z',
    });
    await harness.pipelineStore.insertRun(run);
    const question = seedQuestion(run.id);
    await harness.pipelineStore.insertQuestion(question);

    harness.events.emit({
      type: 'pipeline.question.asked',
      runId: run.id,
      questionId: question.id,
      agentName: 'Lead',
      question: question.question,
    });
    harness.events.emit({
      type: 'pipeline.finished',
      runId: run.id,
      projectId: 'acme',
      status: run.status,
      summary: 'done',
    });
    harness.events.emit({ type: 'item.transitioned', projectId: 'acme', itemId: item, from: 'in_progress', to: 'in_review' });
    await harness.notifications.idle();

    expect(harness.webhook.posted).toHaveLength(0);
    expect(harness.desktop.notified).toHaveLength(0);
  });
});

describe('PipelineStore.markNotified', () => {
  it('claims the row once, and reports the second claim as already taken', async () => {
    const item = await itemId();
    const run = seedRun({ itemId: item });
    await harness.pipelineStore.insertRun(run);

    const first = await harness.pipelineStore.markNotified(run.id, 'gate_failed', '2026-09-14T10:05:00.000Z');
    const second = await harness.pipelineStore.markNotified(run.id, 'gate_failed', '2026-09-14T10:06:00.000Z');

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('notifications.sendTest', () => {
  it('sends one sample per configured channel, never deduped', async () => {
    await configureNotify();

    const first = await harness.notifications.sendTest();
    expect(first).toHaveLength(2);
    expect(first.every((result) => result.ok)).toBe(true);

    expect(harness.webhook.posted).toHaveLength(1);
    expect(harness.webhook.posted[0]?.event.kind).toBe('test');
    expect(harness.webhook.posted[0]?.event.runId).toBeNull();
    expect(harness.desktop.notified).toHaveLength(1);

    const second = await harness.notifications.sendTest();
    expect(second).toHaveLength(2);
    expect(harness.webhook.posted).toHaveLength(2);
    expect(harness.desktop.notified).toHaveLength(2);
  });

  it('sends to only the channels configured', async () => {
    await configureNotify({ webhookUrl: null });

    const result = await harness.notifications.sendTest();
    expect(result).toHaveLength(1);
    expect(harness.desktop.notified).toHaveLength(1);
    expect(harness.webhook.posted).toHaveLength(0);
  });

  it('sends nothing when nothing is configured', async () => {
    const result = await harness.notifications.sendTest();
    expect(result).toEqual([]);
  });
});

describe('a webhook credential', () => {
  it('is attached as the secret on every posted request', async () => {
    const created = await harness.credentials.create({
      name: 'Webhook secret',
      provider: 'generic',
      host: 'hook.test',
      secretRef: { kind: 'file' },
      secret: 'whsec_abc123',
    });
    await configureNotify({ credential: created.id });

    const [result] = await harness.notifications.sendTest();
    expect(result?.ok).toBe(true);
    expect(harness.webhook.posted[0]?.secret).toBe('whsec_abc123');
  });

  it('is null when no credential is configured', async () => {
    await configureNotify();

    await harness.notifications.sendTest();
    expect(harness.webhook.posted[0]?.secret).toBeNull();
  });
});
