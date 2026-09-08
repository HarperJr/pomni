import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineStepSchema, type PipelineStep } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A step with every required field set, so a test only has to vary what it cares about. */
function makeStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  // Through the schema, so a field added to `PipelineStep` defaults here instead of failing
  // this helper — which is how the same literal has fallen behind twice already.
  return PipelineStepSchema.parse({
    id: 'step-1',
    runId: 'run-1',
    parentStepId: null,
    agentId: 'agent-1',
    agentName: 'Agent One',
    role: 'orchestrator',
    providerId: 'anthropic',
    model: 'claude',
    task: 'do the thing',
    status: 'running',
    output: null,
    error: null,
    actions: [],
    outcome: 'unknown',
    unmet: [],
    depth: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    durationMs: null,
    turns: 0,
    cacheReadTokens: 0,
    freshInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    ...overrides,
  });
}

describe('pipeline step: turns and cache split', () => {
  it('survives a store round-trip from creation through the finished update', async () => {
    const store = harness.pipelineStore;
    const created = makeStep({ id: 'step-rt', runId: 'run-rt' });
    await store.insertStep(created);

    const finished: PipelineStep = {
      ...created,
      status: 'done',
      endedAt: '2026-01-01T00:05:00.000Z',
      durationMs: 300_000,
      turns: 12,
      cacheReadTokens: 800,
      freshInputTokens: 200,
      inputTokens: 1000,
      outputTokens: 300,
      costUsd: 0.42,
    };
    await store.updateStep('step-rt', finished);

    const [readBack] = await store.steps('run-rt');
    expect(readBack).toBeDefined();
    expect(readBack?.turns).toBe(12);
    expect(readBack?.cacheReadTokens).toBe(800);
    expect(readBack?.freshInputTokens).toBe(200);
    expect(readBack?.inputTokens).toBe(1000);
    expect(readBack?.outputTokens).toBe(300);
    expect(readBack?.costUsd).toBe(0.42);
    // The invariant the service is meant to keep for anything written from now on: the two
    // halves of the total sum back to it.
    expect((readBack?.cacheReadTokens ?? 0) + (readBack?.freshInputTokens ?? 0)).toBe(
      readBack?.inputTokens,
    );
  });

  it('reads an old row back as unmeasured, not as a crash or a fabricated split', async () => {
    // A row shaped the way one was before this migration: no turns, no cache columns supplied
    // at all, relying on the schema's own DEFAULT 0 rather than anything the store writes.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };

    const dbPath = join(harness.root, 'pomni.db');
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO pipeline_steps (id, run_id, agent_id, agent_name, role, model, task, status, depth, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('step-old', 'run-old', 'agent-1', 'Agent One', 'orchestrator', 'claude', 'legacy task', 'done', 0, '2025-01-01T00:00:00.000Z');
    } finally {
      raw.close();
    }

    const [readBack] = await harness.pipelineStore.steps('run-old');
    expect(readBack).toBeDefined();
    expect(readBack?.turns).toBe(0);
    expect(readBack?.cacheReadTokens).toBe(0);
    expect(readBack?.freshInputTokens).toBe(0);
    // Untouched by the migration: still readable, still their own values.
    expect(readBack?.inputTokens).toBe(0);
    expect(readBack?.outputTokens).toBe(0);
    expect(readBack?.costUsd).toBeNull();
  });
});

describe('pipeline step: turns across an orchestrator round', () => {
  async function seed(): Promise<void> {
    await harness.projects.create({ name: 'Acme' });
    await harness.workflows.create({ name: 'Discovery' });
    await harness.workflows.addAgent('discovery', {
      name: 'Lead',
      role: 'orchestrator',
      spec: 'Owns the question.',
      prompt: 'You lead.',
    });
    await harness.workflows.addAgent('discovery', {
      name: 'Analyst',
      spec: 'Answers questions.',
      prompt: 'You analyse.',
    });
    await harness.workflows.attach('acme', 'discovery');
  }

  const delegate = (task: string) =>
    ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task }] }), '```'].join('\n');

  beforeEach(seed);

  it('sums an orchestrator step across its rounds instead of overwriting with the last one', async () => {
    // Call order, shared across both agents by the one FakeLlm: the lead's delegating round,
    // the analyst's single-round answer, then the lead's final round.
    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Everything considered, build it.'];
    harness.llm.turnsQueue = [4, 1, 6];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    expect(run.status).toBe('passed');

    const leadStep = detail.steps.find((step) => step.agentId === 'lead');
    const analystStep = detail.steps.find((step) => step.agentId === 'analyst');

    // Summed across the lead's two rounds (4 + 6), not the last round's value (6) alone.
    expect(leadStep?.turns).toBe(10);
    expect(analystStep?.turns).toBe(1);
  });

  it('records 0 turns, not 1, when the provider reports none for either round', async () => {
    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];
    harness.llm.turnsQueue = [0, 0, 0];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    const leadStep = detail.steps.find((step) => step.agentId === 'lead');
    expect(leadStep?.turns).toBe(0);
  });

  it('keeps cacheReadTokens + freshInputTokens equal to inputTokens for a step written today', async () => {
    harness.llm.replies = ['Build it.'];
    harness.llm.usageQueue = [
      { inputTokens: 50, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 150 },
    ];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    const leadStep = detail.steps.find((step) => step.agentId === 'lead');
    expect(leadStep?.inputTokens).toBe(1100);
    expect(leadStep?.cacheReadTokens).toBe(900);
    expect(leadStep?.freshInputTokens).toBe(200);
    expect((leadStep?.cacheReadTokens ?? 0) + (leadStep?.freshInputTokens ?? 0)).toBe(
      leadStep?.inputTokens,
    );
  });
});
