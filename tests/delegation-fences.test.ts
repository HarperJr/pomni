import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksLikeDelegation, parseDelegations } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

/**
 * The fence pairing behind POMN-67.
 *
 * Runs `KF1HCPKF` and `NSP5X8MW` both ended after two steps, reporting passed, because the
 * orchestrator's delegation was never read. The reply carried a ```handover block before the
 * ```json one, and the regex that looked for an opening fence could not tell it from a
 * closing fence — so the handover's closer paired with the JSON block's opener and the
 * delegation ended up inside a block that never existed.
 */
describe('delegation blocks in a reply that carries other fenced blocks', () => {
  const delegation = '{"delegate": [{"agent": "test-author", "task": "Write the tests"}]}';

  it('reads the delegation when a labelled block comes first — the POMN-67 shape', () => {
    const reply = [
      'Tests first.',
      '',
      '```handover resolve-run.md',
      'resolveRun — exported from workflow-commands.ts',
      'Zero matches → throw',
      '```',
      '',
      '```json',
      delegation,
      '```',
    ].join('\n');

    const parsed = parseDelegations(reply);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.agent).toBe('test-author');
  });

  /**
   * A handover that happens to hold an object must not be read as one. It is somebody else's
   * payload, and parsing it would let a file's contents steer the run.
   */
  it('does not read a labelled block as JSON even when it holds an object', () => {
    const reply = [
      '```handover shape.md',
      '{"delegate": [{"agent": "impostor", "task": "not a real delegation"}]}',
      '```',
      '',
      'That is the shape I settled on.',
    ].join('\n');

    expect(parseDelegations(reply)).toBeNull();
    expect(looksLikeDelegation(reply)).toBe(false);
  });

  it('still reads a plain fence, an unlabelled one, and a bare object', () => {
    expect(parseDelegations(['```json', delegation, '```'].join('\n'))).toHaveLength(1);
    expect(parseDelegations(['```', delegation, '```'].join('\n'))).toHaveLength(1);
    expect(parseDelegations(delegation)).toHaveLength(1);
  });

  it('reads a block the model never closed', () => {
    expect(parseDelegations(['Here it is:', '```json', delegation].join('\n'))).toHaveLength(1);
  });

  /**
   * The distinction the run status now turns on: asked-and-unreadable is a fault, finished is
   * not. `looksLikeDelegation` is what tells them apart.
   */
  it('tells an unreadable delegation apart from a reply that never asked', () => {
    const malformed = ['```json', '{"delegate": "test-author"}', '```'].join('\n');
    expect(parseDelegations(malformed)).toBeNull();
    expect(looksLikeDelegation(malformed)).toBe(true);

    const finished = 'The work is done. Nothing left to delegate.';
    expect(parseDelegations(finished)).toBeNull();
    expect(looksLikeDelegation(finished)).toBe(false);
  });
});

/**
 * The run status, when a delegation is asked for and cannot be read.
 *
 * A run that finished because the orchestrator said so is still a pass — the distinction this
 * guards is planned-and-dropped against nothing-left-to-do.
 */
describe('a run whose delegation could not be read', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
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
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('does not report passed, and says why', async () => {
    // Shaped like a delegation and not one: the agent is a string where a list belongs.
    harness.llm.replies = [['```json', '{"delegate": "analyst"}', '```'].join('\n')];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;

    expect(run.status).toBe('failed');
    expect(run.error).toContain('could not be read as a delegation');
    expect(run.unmet.join(' ')).toContain('nothing was run for it');
  });

  it('leaves a run that simply finished alone', async () => {
    harness.llm.replies = ['The work is done. Nothing left to delegate.'];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;

    expect(run.status).toBe('passed');
    expect(run.error).toBeNull();
  });

  it('runs the delegation when a handover block precedes it, instead of dropping it', async () => {
    harness.llm.replies = [
      [
        '```handover shape.md',
        'the shape I settled on',
        '```',
        '',
        '```json',
        JSON.stringify({ delegate: [{ agent: 'analyst', task: 'size the market' }] }),
        '```',
      ].join('\n'),
      'The market is large.',
      'Build it.',
    ];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    expect(run.status).toBe('passed');
    expect(detail.steps.filter((step) => step.agentId === 'analyst')).toHaveLength(1);
  });
});
