import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineRunSchema } from '@pomni/core';
import { resolveRun } from '../packages/cli/src/workflow-commands.js';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

/** A finished run in a project, with the id the caller wants to look up by. */
async function seedRun(projectId: string, id: string): Promise<void> {
  await harness.pipelineStore.insertRun(
    PipelineRunSchema.parse({
      id,
      projectId,
      workflowId: 'pomni',
      workflowName: 'Pomni',
      providerId: 'claude-code',
      task: 'something',
      outcome: 'done',
      status: 'passed',
      itemId: null,
      result: null,
      error: null,
      costUsd: null,
      startedAt: '2026-09-13T10:00:00.000Z',
      endedAt: '2026-09-13T10:05:00.000Z',
      durationMs: 300000,
    }),
  );
}

/**
 * The error a refusal threw.
 *
 * `.catch(caught => caught)` types as the union of the value and the error, which then has no
 * `.message` — this narrows once, here, instead of at every assertion.
 */
async function failure(promise: Promise<unknown>): Promise<Error> {
  let thrown: unknown;
  try {
    await promise;
  } catch (caught) {
    thrown = caught;
  }
  if (!(thrown instanceof Error)) throw new Error('expected a refusal, and nothing was thrown');
  return thrown;
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme', id: 'acme' });
  await harness.projects.create({ name: 'Beta', id: 'beta' });
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * POMN-66: a run id does not carry its project the way an item id carries its prefix, but the
 * run is a row and the row says. Refusing before looking made `-p` the toll for using a run
 * id rather than the way to disambiguate.
 */
describe('resolveRun', () => {
  it('finds a run by the tail the listings print, with no project given', async () => {
    await seedRun('acme', '01M2BY28DQPWSSSQD4KF1HCPKF');

    const run = await resolveRun(harness, 'KF1HCPKF', undefined);
    expect(run.projectId).toBe('acme');
  });

  it('finds it in a project that was never named', async () => {
    await seedRun('beta', '01M2BY28DQPWSSSQD4BETA0001');

    const run = await resolveRun(harness, 'BETA0001', undefined);
    expect(run.projectId).toBe('beta');
  });

  it('takes the full id as readily as the tail', async () => {
    await seedRun('acme', '01M2BY28DQPWSSSQD4KF1HCPKF');

    const run = await resolveRun(harness, '01M2BY28DQPWSSSQD4KF1HCPKF', undefined);
    expect(run.id).toBe('01M2BY28DQPWSSSQD4KF1HCPKF');
  });

  /** Picking one silently is the outcome that loses work, so both are named and neither wins. */
  it('refuses an id that matches in two projects, naming both', async () => {
    await seedRun('acme', '01M2AAAAAAAAAAAAAASHARED1');
    await seedRun('beta', '01M2BBBBBBBBBBBBBBSHARED1');

    await expect(resolveRun(harness, 'SHARED1', undefined)).rejects.toThrow(/pass -p/);
    const error = await failure(resolveRun(harness, 'SHARED1', undefined));
    expect(error.message).toContain('acme');
    expect(error.message).toContain('beta');
    expect(error.message).toContain('01M2AAAAAAAAAAAAAASHARED1');
    expect(error.message).toContain('01M2BBBBBBBBBBBBBBSHARED1');
  });

  it('still narrows when a project is given', async () => {
    await seedRun('acme', '01M2AAAAAAAAAAAAAASHARED1');
    await seedRun('beta', '01M2BBBBBBBBBBBBBBSHARED1');

    const run = await resolveRun(harness, 'SHARED1', 'beta');
    expect(run.projectId).toBe('beta');
  });

  it('says which project it looked in when one was named', async () => {
    await seedRun('beta', '01M2BY28DQPWSSSQD4BETA0001');

    const error = await failure(resolveRun(harness, 'BETA0001', 'acme'));
    expect(error.message).toContain("in project 'acme'");
  });

  /** "No run here" is a lie when "here" was never the whole answer. */
  it('names what it searched when nothing matched anywhere', async () => {
    const error = await failure(resolveRun(harness, 'NOPE', undefined));
    expect(error.message).toContain('any project');
    expect(error.message).toContain('acme');
    expect(error.message).toContain('beta');
  });
});
