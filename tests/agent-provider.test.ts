import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSchema } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

/** An orchestrator and one analyst, both prompted, attached to a project. */
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

/** A second, tool-less backend to send individual agents to. */
async function addLocalProvider(): Promise<void> {
  await harness.providers.create({
    id: 'local',
    label: 'Local endpoint',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: { medium: 'qwen2.5-coder:14b' },
  });
}

const delegate = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task }] }), '```'].join('\n');

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('an agent that has never named a provider', () => {
  const base = {
    id: 'analyst',
    name: 'Analyst',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('is read as using the run’s, not as a broken record', () => {
    // A workflow written before the field existed has no `provider` key at all. It must keep
    // parsing, and it must mean exactly what it meant then: wherever the run is going.
    expect(AgentSchema.parse(base).provider).toBeNull();
  });

  it('treats a blank provider as no choice at all', () => {
    // `--provider ""` and an empty select both arrive as a string. If whitespace survived, the
    // run would look for a provider called "  " and refuse to start.
    expect(AgentSchema.parse({ ...base, provider: '  ' }).provider).toBeNull();
    expect(AgentSchema.parse({ ...base, provider: '' }).provider).toBeNull();
  });
});

describe('where an agent runs', () => {
  it('runs on the provider the agent names, not the one the run picked', async () => {
    await addLocalProvider();
    await harness.workflows.updateAgent('discovery', 'analyst', { provider: 'local' });

    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    expect(run.status).toBe('passed');
    // The run went to the default; only the analyst was moved.
    expect(run.providerId).toBe('claude-code');

    const byAgent = new Map(detail.steps.map((step) => [step.agentId, step.providerId]));
    expect(byAgent.get('analyst')).toBe('local');
    expect(byAgent.get('lead')).toBe('claude-code');

    // And the session really was opened against that backend, not merely labelled with it.
    expect(harness.llmFactory.providersUsed()).toContain('local');
  });

  it('falls back to the run’s provider when the agent clears its own', async () => {
    await addLocalProvider();
    await harness.workflows.updateAgent('discovery', 'analyst', { provider: 'local' });
    // `--provider ""` puts it back to following the run.
    const cleared = await harness.workflows.updateAgent('discovery', 'analyst', { provider: '' });
    expect(cleared.provider).toBeNull();

    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
      providerId: 'local',
    });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    expect(run.status).toBe('passed');
    expect(run.providerId).toBe('local');
    // Neither agent names one, so every step is the run's choice.
    expect(detail.steps.map((step) => step.providerId)).toEqual(['local', 'local']);
    expect(new Set(harness.llmFactory.providersUsed())).toEqual(new Set(['local']));
  });

  it('records which provider ran each step, and still adds the costs up', async () => {
    await addLocalProvider();
    await harness.workflows.updateAgent('discovery', 'analyst', { provider: 'local' });
    harness.llm.costUsd = 0.01;

    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    // Two steps, two different backends: this is what makes the run readable afterwards.
    expect(detail.steps.map((step) => `${step.agentId}@${step.providerId}`).sort()).toEqual([
      'analyst@local',
      'lead@claude-code',
    ]);

    // Mixing providers must not lose the accounting. The lead took two turns, the analyst one.
    const stepTotal = detail.steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
    expect(stepTotal).toBeCloseTo(0.03, 10);
    expect(run.costUsd).toBeCloseTo(stepTotal, 10);
  });
});

describe('refusing a run before it costs anything', () => {
  it('refuses a file-editing agent on a backend that has no tools, naming the agent', async () => {
    await addLocalProvider();
    await harness.workflows.updateAgent('discovery', 'analyst', {
      provider: 'local',
      tools: { files: true },
    });

    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    // The analyst is only reached by delegation. Checked as the run starts, the refusal names
    // it; checked lazily, the orchestrator would pay for a round and report the discovery as
    // its finding.
    await expect(
      harness.pipelines.start({ projectId: 'acme', task: 'Should we?' }),
    ).rejects.toThrow(/agent 'Analyst'.*cannot give an agent tools/s);

    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.llmFactory.created).toHaveLength(0);
    expect(await harness.pipelines.list({})).toHaveLength(0);
  });

  it('refuses an agent pointed at a provider that is switched off', async () => {
    await addLocalProvider();
    await harness.workflows.updateAgent('discovery', 'analyst', { provider: 'local' });
    await harness.providers.update('local', { enabled: false });

    await expect(
      harness.pipelines.start({ projectId: 'acme', task: 'Should we?' }),
    ).rejects.toThrow(/agent 'Analyst' runs on provider 'local', which is disabled/);

    expect(harness.llm.calls).toHaveLength(0);
    expect(await harness.pipelines.list({})).toHaveLength(0);
  });

  it('refuses an agent pointed at a provider nobody configured', async () => {
    await harness.workflows.updateAgent('discovery', 'analyst', { provider: 'ghost' });

    await expect(
      harness.pipelines.start({ projectId: 'acme', task: 'Should we?' }),
    ).rejects.toThrow(/agent 'Analyst' runs on provider 'ghost', which is not configured/);

    expect(harness.llm.calls).toHaveLength(0);
    expect(await harness.pipelines.list({})).toHaveLength(0);
  });
});
