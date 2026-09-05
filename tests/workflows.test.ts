import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STRUGGLE,
  STRUGGLE_LEVELS,
  chooseWorkflow,
  entryAgent,
  rosterFor,
  validateWorkflow,
  type Workflow,
} from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

/** A workflow with an orchestrator and two agents, all prompted. */
async function seed(): Promise<string> {
  await harness.workflows.create({ name: 'Bug fix', suits: ['bug', 'regression'] });
  await harness.workflows.addAgent('bug-fix', {
    name: 'Planner',
    role: 'orchestrator',
    spec: 'Owns the bug and delegates.',
    prompt: 'You plan.',
  });
  await harness.workflows.addAgent('bug-fix', {
    name: 'Investigator',
    spec: 'Finds the cause.',
    prompt: 'You investigate.',
  });
  await harness.workflows.addAgent('bug-fix', {
    name: 'Fixer',
    spec: 'Writes the diff.',
    prompt: 'You fix.',
  });
  return 'bug-fix';
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('struggle levels', () => {
  it('runs from low to max', () => {
    expect(STRUGGLE_LEVELS).toEqual(['low', 'medium', 'high', 'max']);
    expect(STRUGGLE.medium.label).toBe('Medium');
  });

  it('reads a workflow written before the rename', async () => {
    // `modelScale: deep` was how "work hard on this" used to be expressed.
    const { AgentSchema } = await import('@pomni/core');
    const parsed = AgentSchema.parse({
      id: 'a',
      name: 'A',
      modelScale: 'deep',
      createdAt: 'x',
      updatedAt: 'x',
    });
    expect(parsed.struggle).toBe('high');
  });
});

describe('provider model mapping', () => {
  it('maps each level to the model the provider configured', async () => {
    const { resolveModel, ProviderSchema } = await import('@pomni/core');
    const provider = ProviderSchema.parse({
      id: 'p',
      label: 'P',
      kind: 'openai',
      baseUrl: 'http://x/v1',
      models: { low: 'small', medium: 'mid', high: 'big', max: 'biggest' },
      createdAt: 'x',
    });

    expect(resolveModel(provider, 'low')).toBe('small');
    expect(resolveModel(provider, 'max')).toBe('biggest');
  });

  it('falls back to the nearest configured level, so one model covers everything', async () => {
    const { resolveModel, ProviderSchema } = await import('@pomni/core');
    const provider = ProviderSchema.parse({
      id: 'p',
      label: 'P',
      kind: 'openai',
      baseUrl: 'http://x/v1',
      models: { medium: 'only-one' },
      createdAt: 'x',
    });

    for (const level of STRUGGLE_LEVELS) {
      expect(resolveModel(provider, level)).toBe('only-one');
    }
  });

  it('still reads a provider written with the old key names', async () => {
    const { resolveModel, ProviderSchema } = await import('@pomni/core');
    const provider = ProviderSchema.parse({
      id: 'p',
      label: 'P',
      kind: 'openai',
      baseUrl: 'http://x/v1',
      models: { fast: 'small', balanced: 'mid', deep: 'big' },
      createdAt: 'x',
    });

    expect(resolveModel(provider, 'low')).toBe('small');
    expect(resolveModel(provider, 'high')).toBe('big');
  });
});

describe('authoring', () => {
  it('makes an orchestrator struggle harder than a plain agent by default', async () => {
    await harness.workflows.create({ name: 'W' });
    const head = await harness.workflows.addAgent('w', { name: 'Head', role: 'orchestrator' });
    const worker = await harness.workflows.addAgent('w', { name: 'Worker' });

    expect(head.struggle).toBe('high');
    expect(worker.struggle).toBe('medium');
  });

  it('makes the first orchestrator the entry point without being asked', async () => {
    await harness.workflows.create({ name: 'W' });
    await harness.workflows.addAgent('w', { name: 'Head', role: 'orchestrator' });
    expect((await harness.workflows.get('w')).entry).toBe('head');
  });

  it('gives colliding agent names distinct ids', async () => {
    await harness.workflows.create({ name: 'W' });
    const first = await harness.workflows.addAgent('w', { name: 'Worker' });
    const second = await harness.workflows.addAgent('w', { name: 'Worker' });
    expect(first.id).toBe('worker');
    expect(second.id).toBe('worker-2');
  });

  it('drops a removed agent from every roster that named it', async () => {
    const id = await seed();
    await harness.workflows.updateAgent(id, 'planner', { delegatesTo: ['investigator', 'fixer'] });
    await harness.workflows.removeAgent(id, 'fixer');

    const after = await harness.workflows.get(id);
    expect(after.agents.find((agent) => agent.id === 'planner')?.delegatesTo).toEqual([
      'investigator',
    ]);
  });
});

describe('validation', () => {
  it('reports every problem at once, not just the first', async () => {
    await harness.workflows.create({ name: 'W' });
    await harness.workflows.addAgent('w', { name: 'A' });
    await harness.workflows.addAgent('w', { name: 'B' });

    const problems = validateWorkflow(await harness.workflows.get('w'));
    // No orchestrator, and neither agent has a prompt.
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.some((problem) => problem.message.includes('orchestrator role'))).toBe(true);
  });

  it('refuses an orchestrator with nobody to delegate to', async () => {
    await harness.workflows.create({ name: 'W' });
    await harness.workflows.addAgent('w', {
      name: 'Head',
      role: 'orchestrator',
      prompt: 'plan',
    });

    const problems = validateWorkflow(await harness.workflows.get('w'));
    expect(problems.some((problem) => problem.message.includes('no agents to delegate to'))).toBe(
      true,
    );
  });

  it('refuses a plain agent that tries to delegate', async () => {
    const id = await seed();
    await harness.workflows.updateAgent(id, 'fixer', { delegatesTo: ['investigator'] });

    const problems = validateWorkflow(await harness.workflows.get(id));
    expect(problems.some((problem) => problem.message.includes('cannot delegate'))).toBe(true);
  });

  it('accepts a complete workflow', async () => {
    const id = await seed();
    const workflow = await harness.workflows.get(id);
    expect(workflow.problems).toEqual([]);
    expect(workflow.runnable).toBe(true);
    expect(entryAgent(workflow).id).toBe('planner');
  });

  it('treats an empty roster as "everyone else"', async () => {
    const id = await seed();
    const workflow = await harness.workflows.get(id);
    const head = workflow.agents.find((agent) => agent.id === 'planner')!;
    expect(rosterFor(workflow, head).map((agent) => agent.id)).toEqual(['investigator', 'fixer']);
  });
});

describe('prompt generation', () => {
  it('writes the prompt from the spec and records when', async () => {
    const id = await seed();
    harness.llm.reply = 'You investigate a failing test and report the cause.';

    const updated = await harness.workflows.generatePrompt(id, 'investigator');

    expect(updated.prompt).toBe('You investigate a failing test and report the cause.');
    expect(updated.promptGeneratedAt).not.toBeNull();
    // Prompt-writing is judgement work, so it asks for the provider's strongest tier.
    expect(harness.llm.calls[0]?.model).toBe('claude-opus-5');
  });

  it('tells an orchestrator who it can delegate to', async () => {
    const id = await seed();
    await harness.workflows.generatePrompt(id, 'planner');

    const brief = harness.llm.calls[0]?.messages[0]?.content ?? '';
    expect(brief).toContain('Investigator');
    expect(brief).toContain('Fixer');
    expect(brief).toContain('delegate');
  });

  it('does not offer a plain agent a roster it cannot use', async () => {
    const id = await seed();
    await harness.workflows.generatePrompt(id, 'fixer');

    const brief = harness.llm.calls[0]?.messages[0]?.content ?? '';
    expect(brief).toContain('does not call them');
  });

  it('strips a code fence the model wrapped the prompt in', async () => {
    const id = await seed();
    harness.llm.reply = '```\nYou investigate.\n```';

    const updated = await harness.workflows.generatePrompt(id, 'investigator');
    expect(updated.prompt).toBe('You investigate.');
  });

  it('refuses to generate from an empty spec', async () => {
    await harness.workflows.create({ name: 'W' });
    await harness.workflows.addAgent('w', { name: 'Blank' });

    await expect(harness.workflows.generatePrompt('w', 'blank')).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('export and import', () => {
  it('round-trips a workflow through its portable form', async () => {
    const id = await seed();
    const exported = await harness.workflows.export(id);

    await harness.workflows.remove(id);
    const imported = await harness.workflows.import(exported);

    expect(imported.id).toBe(id);
    expect(imported.agents.map((agent) => agent.id)).toEqual([
      'planner',
      'investigator',
      'fixer',
    ]);
    expect(imported.entry).toBe('planner');
  });

  it('renames rather than refusing when the id is taken', async () => {
    const id = await seed();
    const exported = await harness.workflows.export(id);

    const imported = await harness.workflows.import(exported);
    expect(imported.id).toBe('bug-fix-2');
    expect((await harness.workflows.list()).length).toBe(2);
  });

  it('rejects something that is not a workflow export', async () => {
    await expect(harness.workflows.import('{"hello":"world"}')).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(harness.workflows.import('not json at all')).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('attaching to projects', () => {
  it('attaches, lists and detaches', async () => {
    const id = await seed();

    await harness.workflows.attach('acme', id);
    expect((await harness.workflows.forProject('acme')).map((w) => w.id)).toEqual([id]);

    await harness.workflows.detach('acme', id);
    expect(await harness.workflows.forProject('acme')).toEqual([]);
  });

  it('is idempotent, so attaching twice does not duplicate', async () => {
    const id = await seed();
    await harness.workflows.attach('acme', id);
    const second = await harness.workflows.attach('acme', id);
    expect(second).toEqual([id]);
  });

  it('refuses to delete a workflow a project still uses', async () => {
    const id = await seed();
    await harness.workflows.attach('acme', id);

    await expect(harness.workflows.remove(id)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('choosing a workflow for a task', () => {
  const make = (id: string, suits: string[]): Workflow =>
    ({ id, name: id, suits, agents: [], entry: null }) as unknown as Workflow;

  it('prefers an explicit choice', () => {
    const workflows = [make('a', []), make('b', [])];
    expect(chooseWorkflow(workflows, 'anything', 'b')?.id).toBe('b');
  });

  it('matches the task text against each workflow\'s hints', () => {
    const workflows = [make('bugs', ['bug', 'regression']), make('features', ['feature'])];
    expect(chooseWorkflow(workflows, 'Fix the login bug')?.id).toBe('bugs');
    expect(chooseWorkflow(workflows, 'Add a feature for export')?.id).toBe('features');
  });

  it('falls back to the only workflow, and to nothing when ambiguous', () => {
    expect(chooseWorkflow([make('only', [])], 'whatever')?.id).toBe('only');
    expect(chooseWorkflow([make('a', []), make('b', [])], 'whatever')).toBeNull();
  });
});
