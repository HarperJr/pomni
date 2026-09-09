import { describe, expect, it } from 'vitest';
import {
  PipelineRunSchema,
  PipelineStepSchema,
  findings,
  signalsFor,
  since,
  type PipelineRun,
  type PipelineStep,
} from '@pomni/core';

const run = (overrides: Partial<PipelineRun> = {}): PipelineRun =>
  PipelineRunSchema.parse({
    id: 'run-1',
    projectId: 'acme',
    workflowId: 'w',
    workflowName: 'W',
    providerId: 'p',
    itemId: null,
    task: 't',
    status: 'passed',
    outcome: 'done',
    result: null,
    error: null,
    endedAt: null,
    durationMs: null,
    costUsd: null,
    startedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  });

const step = (overrides: Partial<PipelineStep> = {}): PipelineStep =>
  PipelineStepSchema.parse({
    id: 'step-1',
    runId: 'run-1',
    parentStepId: null,
    agentId: 'author',
    agentName: 'Author',
    role: 'agent',
    model: 'm',
    task: 't',
    status: 'done',
    output: 'Done.',
    error: null,
    depth: 1,
    startedAt: '2026-09-09T00:00:00.000Z',
    endedAt: null,
    durationMs: null,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: null,
    ...overrides,
  });

describe('what a run says went wrong', () => {
  it('names the agent for what an agent did, and nobody for what the run did', () => {
    const signals = signalsFor(
      run({ error: "this run has spent $5.26 of the $5.00 its project allows (policy.maxCostUsd)" }),
      [step({ outcome: 'partial' })],
    );

    expect(signals.find((s) => s.kind === 'partial')?.agentName).toBe('Author');
    // Nobody chose to run out of money. Blaming the last agent to speak is how a prompt gets
    // edited for something that was never its fault.
    expect(signals.find((s) => s.kind === 'budget-stop')?.agentId).toBeNull();
  });

  it('reads a refusal only in the narrow phrases that mean one', () => {
    const refused = signalsFor(run(), [step({ output: 'I have no shell, so I did not measure it.' })]);
    expect(refused.some((s) => s.kind === 'refusal')).toBe(true);

    // An agent describing a limitation in code it reviewed is not refusing. A signal that
    // fires on that teaches the reader to ignore it, which is worse than not having it.
    const described = signalsFor(run(), [
      step({ output: 'The handler cannot run without a database connection, which is the bug.' }),
    ]);
    expect(described.some((s) => s.kind === 'refusal')).toBe(false);
  });

  it('names the step that took most of the run', () => {
    const signals = signalsFor(run(), [
      step({ id: 's1', agentId: 'a', agentName: 'A', inputTokens: 9000, outputTokens: 0 }),
      step({ id: 's2', agentId: 'b', agentName: 'B', inputTokens: 100, outputTokens: 0 }),
    ]);

    const expensive = signals.filter((s) => s.kind === 'expensive');
    expect(expensive).toHaveLength(1);
    expect(expensive[0]?.agentName).toBe('A');
  });

  it('flags a turn whose frame outgrew its own prompt', () => {
    const signals = signalsFor(run(), [
      step({ promptParts: { agent: 100, protocol: 900, roster: 0, tools: 0, repos: 0, context: 0 } }),
    ]);
    expect(signals.some((s) => s.kind === 'prompt-heavy')).toBe(true);

    // Not measured is not "no frame": a step recorded before prompts were measured reads zero
    // everywhere, and calling that prompt-heavy would invent a finding out of an absence.
    const unmeasured = signalsFor(run(), [step()]);
    expect(unmeasured.some((s) => s.kind === 'prompt-heavy')).toBe(false);
  });
});

describe('a signal that kept happening', () => {
  it('needs distinct runs, not repetition inside one', () => {
    const thrice = ['r1', 'r2', 'r3'].flatMap((runId) =>
      signalsFor(run({ id: runId }), [step({ runId, outcome: 'partial' })]),
    );
    expect(findings(thrice).some((f) => f.kind === 'partial')).toBe(true);

    // The same agent saying it three times in one run is one problem, not three.
    const once = signalsFor(run(), [
      step({ id: 's1', outcome: 'partial' }),
      step({ id: 's2', outcome: 'partial' }),
      step({ id: 's3', outcome: 'partial' }),
    ]);
    expect(findings(once)).toEqual([]);
  });

  it('keeps the wording, because the wording is the evidence', () => {
    const signals = ['r1', 'r2', 'r3'].flatMap((runId) =>
      signalsFor(run({ id: runId }), [step({ runId, unmet: ['did not re-run npm test'] })]),
    );

    const [finding] = findings(signals);
    expect(finding?.runIds).toHaveLength(3);
    expect(finding?.details[0]).toBe('did not re-run npm test');
  });
});

describe('whether a finding kept happening after the agent changed', () => {
  const runs = [
    { id: 'old-1', startedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'old-2', startedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'new-1', startedAt: '2026-09-08T00:00:00.000Z' },
  ];
  const signal = (runId: string) => ({
    kind: 'partial' as const,
    runId,
    agentId: 'a',
    agentName: 'A',
    detail: 'reported the work as partial',
  });

  it('splits on when the agent was last changed', () => {
    const split = since(
      [signal('old-1'), signal('old-2'), signal('new-1')],
      runs,
      '2026-09-05T00:00:00.000Z',
    );
    expect(split).toEqual({ before: 2, after: 1, runsAfter: 1 });
  });

  it('counts distinct runs, the same unit a finding is counted in', () => {
    // Two signals from one run are one run. Counting signals here and runs in the finding
    // puts two different things on one line and reads as a contradiction.
    const split = since([signal('new-1'), signal('new-1')], runs, '2026-09-05T00:00:00.000Z');
    expect(split.after).toBe(1);
  });

  it('says nothing has been tried when no run has happened since', () => {
    const split = since([signal('old-1')], runs, '2026-09-09T00:00:00.000Z');
    // An amendment nobody has exercised is not an amendment that worked.
    expect(split).toEqual({ before: 1, after: 0, runsAfter: 0 });
  });
});
