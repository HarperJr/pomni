import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotInitializedError, type PomniContainer } from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';
import { runCli } from './cli.js';

let harness: TestHarness;

/**
 * One project, two repos — the same shape `tests/runs.test.ts` seeds: `api` declares test+lint,
 * `web` declares test only, neither declares `typecheck`. Reused across every test in this
 * file so the gate/verify tests and the backlog-move-guard test (which needs a gate that has
 * never gone green) share one setup instead of three slightly different ones.
 */
async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme', id: 'acme' });

  const apiPath = await makeNodeRepo(join(harness.dir, 'api'), {
    scripts: { test: 'vitest run', lint: 'eslint .' },
    devDependencies: {},
  });
  const webPath = await makeNodeRepo(join(harness.dir, 'web'), {
    scripts: { test: 'vitest run' },
    devDependencies: {},
  });

  await (await harness.repos.add('acme', { source: { kind: 'local', path: apiPath }, id: 'api' }))
    .completion;
  await (await harness.repos.add('acme', { source: { kind: 'local', path: webPath }, id: 'web' }))
    .completion;
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('--json output', () => {
  it('prints exactly one JSON document for a list command, and nothing on stderr', async () => {
    await harness.runs.run('acme', 'test', { repoId: 'api' });

    const result = await runCli(harness, ['--json', 'runs', 'list']);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    // The whole of stdout parses as one document, and it is the same document `lines` found —
    // there is nothing on stdout before or after the JSON line.
    const whole = JSON.parse(result.stdout);
    expect(whole).toEqual(result.lines[0]);
    expect(Array.isArray(whole)).toBe(true);
    expect(whole.length).toBeGreaterThan(0);
    expect(whole[0]).toMatchObject({ projectId: 'acme', repoId: 'api', capability: 'test' });
    expect(() => JSON.parse(result.stderr)).toThrow();
  });

  it('prints the item created through the container for backlog show', async () => {
    const created = await harness.backlog.create('acme', { title: 'a shown item' });

    const result = await runCli(harness, ['--json', 'backlog', 'show', created.id]);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.last).toMatchObject({ id: created.id, title: 'a shown item', projectId: 'acme' });
  });

  it('prints every item for backlog list', async () => {
    const first = await harness.backlog.create('acme', { title: 'first' });
    const second = await harness.backlog.create('acme', { title: 'second' });

    const result = await runCli(harness, ['--json', 'backlog', 'list']);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    const ids = (result.last as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('moves an item on an allowed transition, printing the updated item and exiting 0', async () => {
    const created = await harness.backlog.create('acme', { title: 'movable' });
    expect(created.status).toBe('backlog');

    // backlog -> blocked carries no gate or section requirement in the built-in flow, so this
    // move needs nothing else set up first — the transition the guard test below exercises is
    // the one that does.
    const result = await runCli(harness, ['--json', 'backlog', 'move', created.id, 'blocked']);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.last).toMatchObject({ id: created.id, status: 'blocked' });

    const stored = await harness.backlog.get('acme', created.id);
    expect(stored.status).toBe('blocked');
  });

  it('exits 1 with a validation error envelope when the guard refuses a move', async () => {
    // `newItemBody` seeds each section with an italic prompt, which `sectionIsWritten` does not
    // count as written — real content is needed to clear the `specced` and `ready` guards
    // before the `in_progress -> in_review` guard (the one this test is actually about) fires.
    const created = await harness.backlog.create('acme', {
      title: 'ungated',
      body:
        '## Problem\n\nSomething is broken.\n\n## Acceptance criteria\n\n- [ ] it works\n\n## Plan\n\ndo the thing.\n',
    });
    await harness.backlog.transition('acme', created.id, 'specced');
    await harness.backlog.transition('acme', created.id, 'ready');
    await harness.backlog.transition('acme', created.id, 'in_progress');

    // Nobody has ever run the gate for this project, so `in_progress -> in_review` — which
    // requires gate 'default' — is exactly the transition RequirementsNotMetError guards.
    const result = await runCli(harness, ['--json', 'backlog', 'move', created.id, 'in_review']);

    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    const body = result.last as { error: { code: string; message: string; unmet: unknown[] } };
    expect(body.error.code).toBe('validation');
    expect(typeof body.error.message).toBe('string');
    expect(Array.isArray(body.error.unmet)).toBe(true);
    expect(body.error.unmet.length).toBeGreaterThan(0);
  });

  it('exits 1 and reports a failed gate as the last streamed line', async () => {
    harness.executor.script = [{ match: /run lint/, exitCode: 1 }];

    const result = await runCli(harness, ['--json', 'verify']);

    expect(result.code).toBe(1);
    expect(result.lines.length).toBeGreaterThan(0);
    // Every line on stdout parsed as JSON already, by way of `runCli` — a prose progress line
    // would have thrown while building `result.lines`. What is left to check is the last one.
    expect(result.last).toMatchObject({ passed: false, gate: 'default' });
  });

  it('exits 0 and reports a passed gate as the last streamed line', async () => {
    const result = await runCli(harness, ['--json', 'verify']);

    expect(result.code).toBe(0);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.last).toMatchObject({ passed: true, gate: 'default' });
  });

  it('exits 3 with a not_found envelope for an item that does not exist', async () => {
    const result = await runCli(harness, ['--json', 'backlog', 'show', 'does-not-exist']);

    expect(result.code).toBe(3);
    expect(result.lines).toHaveLength(1);
    const body = result.last as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.message).toBe('string');
  });

  it('exits 2 with a usage envelope for an unknown option', async () => {
    const result = await runCli(harness, ['--json', 'runs', 'list', '--bogus']);

    expect(result.code).toBe(2);
    expect(result.lines).toHaveLength(1);
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('usage');
  });

  it('exits 3 with a not_initialized envelope when the workspace has never been set up', async () => {
    const throwingOpen = async (): Promise<PomniContainer> => {
      throw new NotInitializedError('/nowhere/.pomni');
    };

    const result = await runCli(throwingOpen, ['--json', 'runs', 'list']);

    expect(result.code).toBe(3);
    expect(result.lines).toHaveLength(1);
    const body = result.last as { error: { code: string } };
    expect(body.error.code).toBe('not_initialized');
  });
});

describe('exit codes on the commands that answer "no" without throwing', () => {
  it('tool check exits 1 when a check failed, with the results as the document', async () => {
    await harness.tools.create({
      name: 'Figma CLI',
      id: 'figma-cli',
      kind: 'cli',
      bin: 'figma-cli',
      check: 'figma-cli status',
    });
    harness.executor.script = [{ match: /figma-cli status/, exitCode: 1, output: 'daemon is not running' }];

    const result = await runCli(harness, ['--json', 'tool', 'check']);

    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.last).toMatchObject({ results: [{ id: 'figma-cli', status: 'failed' }] });
  });

  it('tool check exits 0 and still prints one document when every check passed', async () => {
    await harness.tools.create({
      name: 'Figma CLI',
      id: 'figma-cli',
      kind: 'cli',
      bin: 'figma-cli',
      check: 'figma-cli status',
    });

    const result = await runCli(harness, ['--json', 'tool', 'check']);

    expect(result.code).toBe(0);
    expect(result.last).toMatchObject({ results: [{ id: 'figma-cli', status: 'ok' }] });
  });

  it('worktree prune exits 0 with an empty report when there is nothing to prune', async () => {
    const result = await runCli(harness, ['--json', 'worktree', 'prune']);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.last).toEqual({ removed: [], kept: [], failed: [] });
  });

  it('task show exits 3 for a run id that matches nothing', async () => {
    const result = await runCli(harness, ['--json', 'task', 'show', 'NOSUCHRUN']);

    expect(result.code).toBe(3);
    expect(result.lines).toHaveLength(1);
    expect(result.last).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('one document per non-stream command', () => {
  it('editor prints one document even when it also set the editor', async () => {
    const result = await runCli(harness, ['--json', 'editor', 'vim']);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.last).toMatchObject({ changed: true, configured: true, found: 'vim' });
  });

  it('repo add keeps its progress off stdout', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'mobile'));
    const result = await runCli(harness, ['--json', 'repo', 'add', path, '-p', 'acme', '-r', 'mobile']);

    expect(result.code).toBe(0);
    // Every stdout line parsed as JSON already; a "cloning …" line would have thrown.
    expect(result.lines).toHaveLength(1);
    expect(result.last).toMatchObject({ id: 'mobile', status: 'linked' });
  });
});

describe('human output', () => {
  it('still exits 3 for a missing item, with stdout empty and the message on stderr', async () => {
    const result = await runCli(harness, ['backlog', 'show', 'does-not-exist']);

    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
