import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CONTEXT_FILE_BYTES,
  TOUCHED_FILES_CONTEXT_NAME,
  clampHandover,
  withinBudget,
  type PomniEvent,
} from '@pomni/core';
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

/** Three ordinary agents, so a handover can reach one and skip another. */
async function seedThreeAuthors(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Chain' });
  await harness.workflows.addAgent('chain', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the question.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('chain', {
    name: 'Author A',
    spec: 'Writes the first part.',
    prompt: 'You are author a.',
  });
  await harness.workflows.addAgent('chain', {
    name: 'Author B',
    spec: 'Writes the second part.',
    prompt: 'You are author b.',
  });
  await harness.workflows.addAgent('chain', {
    name: 'Author C',
    spec: 'Writes the third part.',
    prompt: 'You are author c.',
  });
  await harness.workflows.attach('acme', 'chain');
}

const delegate = (agent: string, task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent, task }] }), '```'].join('\n');

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('the files an item says it changes', () => {
  beforeEach(seed);

  it('reach the run as a named context file, and reach the delegate prompt', async () => {
    const item = await harness.backlog.create('acme', { title: 'Add a column' });
    await harness.backlog.update('acme', item.id, {
      touches: ['packages/web/src/api.ts', 'packages/web/src/console.tsx'],
    });

    harness.llm.replies = [delegate('analyst', 'read the spec'), 'Read it.', 'Built.'];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Add a column',
      itemId: item.id,
    });
    await completion;

    const file = run.context.find((entry) => entry.name === TOUCHED_FILES_CONTEXT_NAME);
    expect(file?.content).toContain('packages/web/src/api.ts');
    expect(file?.content).toContain('packages/web/src/console.tsx');

    const toAnalyst = harness.llm.calls.find((call) => call.system?.includes('You analyse.'));
    expect(toAnalyst?.messages[0]?.content).toContain('packages/web/src/api.ts');
    expect(toAnalyst?.messages[0]?.content).toContain('packages/web/src/console.tsx');
  });

  it('adds nothing to the run or the prompt when the item declares none', async () => {
    const item = await harness.backlog.create('acme', { title: 'Undeclared change' });
    // touches left as the schema default: an empty array.

    harness.llm.replies = ['Built.'];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Undeclared change',
      itemId: item.id,
    });
    await completion;

    expect(run.context.find((entry) => entry.name === TOUCHED_FILES_CONTEXT_NAME)).toBeUndefined();

    const call = harness.llm.calls[0];
    const prompt = String(call?.messages[0]?.content ?? '');
    // No section at all — not even one that would read as "this change touches no files".
    expect(prompt).not.toMatch(/touch/i);
    expect(prompt).not.toMatch(/no files/i);
  });

  it('leaves exactly one touched-files.md on a resumed run, holding the current paths', async () => {
    const item = await harness.backlog.create('acme', { title: 'Add a column' });
    await harness.backlog.update('acme', item.id, { touches: ['a.ts'] });

    harness.llm.replies = [delegate('analyst', 'size it'), 'Sized.', 'Done.'];
    const first = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Add a column', itemId: item.id })
    ).completion;

    // Pretend the process died instead of finishing cleanly, as the resume tests in
    // pipeline.test.ts do — status and outcome rewritten by hand, answers left alone.
    await harness.pipelineStore.updateRun(first.id, {
      ...first,
      status: 'cancelled',
      outcome: 'unknown',
      error: 'killed',
    });

    // The item grew a second path while the run was down.
    await harness.backlog.update('acme', item.id, { touches: ['a.ts', 'b.ts'] });

    harness.llm.replies = ['Done at last.'];
    const { run, completion } = await harness.pipelines.resume(first.id);
    await completion;

    const files = run.context.filter((entry) => entry.name === TOUCHED_FILES_CONTEXT_NAME);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain('a.ts');
    expect(files[0]?.content).toContain('b.ts');
  });
});

describe('a handover reaches what runs after it, not what ran before', () => {
  beforeEach(seedThreeAuthors);

  it('lets a later agent see a field name a middle agent settled, and keeps it from an earlier one', async () => {
    harness.llm.replies = [
      delegate('author-a', 'read the ticket'), // Lead round 1
      'Read it.', // Author A
      delegate('author-b', 'name the fields'), // Lead round 2
      // Author B settles the shape and hands it over.
      [
        'Named them.',
        '',
        '```handover field-names.md',
        'turns, cacheReadTokens, freshInputTokens',
        '```',
      ].join('\n'),
      delegate('author-c', 'write the row'), // Lead round 3
      'Wrote it.', // Author C
      'Done.', // Lead's final answer
    ];

    const { run, completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    await completion;

    const toA = harness.llm.calls.find((call) => call.system?.includes('You are author a.'));
    const toC = harness.llm.calls.find((call) => call.system?.includes('You are author c.'));

    // A ran before B settled anything — its merge was computed before B published.
    expect(String(toA?.messages[0]?.content ?? '')).not.toContain('cacheReadTokens');
    // C was delegated to after B finished, so its merge picked the handover up.
    expect(String(toC?.messages[0]?.content ?? '')).toContain('turns, cacheReadTokens, freshInputTokens');
    expect(String(toC?.messages[0]?.content ?? '')).toContain('field-names.md');

    // And it lands on the run itself, the same shelf a person's attachment would.
    const detail = await harness.pipelines.get(run.id);
    const handedOverFile = detail.context.find((file) => file.name === 'field-names.md');
    expect(handedOverFile).toBeDefined();
    expect(handedOverFile?.content).toContain('cacheReadTokens');
  });

  it('ignores a malformed handover block without throwing or leaving anything behind', async () => {
    harness.llm.replies = [
      delegate('author-a', 'settle the shape'),
      [
        'Here is what I found.',
        '',
        '```handover',
        'no name on this one',
        '```',
        '',
        '```handover empty.md',
        '```',
        '',
        '```handover unterminated.md',
        'never closed',
      ].join('\n'),
      'Done.',
    ];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    const run = await completion;

    expect(run.status).toBe('passed');
    // Nothing was published: none of the three blocks was well-formed.
    expect(run.context).toEqual([]);
  });
});

describe('a repeated delegation is answered from the ledger', () => {
  beforeEach(seed);

  it('is observable in the run events, not silent', async () => {
    const events: PomniEvent[] = [];
    const unsubscribe = harness.events.subscribe((event) => events.push(event));

    harness.llm.replies = [
      delegate('analyst', 'size the market'),
      'The market is large.',
      delegate('analyst', 'size the market'),
      'Build it.',
    ];

    await (await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })).completion;
    unsubscribe();

    const memoLine = events.find(
      (event) =>
        event.type === 'pipeline.step.output' &&
        typeof (event as { chunk?: string }).chunk === 'string' &&
        (event as { chunk: string }).chunk.startsWith("answered from this run's ledger"),
    );
    expect(memoLine).toBeDefined();
    expect((memoLine as { chunk: string }).chunk).toContain('size the market');
  });

  it('treats a task differing only by case and whitespace as the same one', async () => {
    harness.llm.replies = [
      delegate('analyst', 'size the market'),
      'The market is large.',
      delegate('analyst', '  SIZE   the Market  '),
      'Build it.',
    ];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })
    ).completion;
    const detail = await harness.pipelines.get(run.id);

    const analystSteps = detail.steps.filter((step) => step.agentId === 'analyst');
    expect(analystSteps).toHaveLength(1);
  });

  it('opens a second session when the task differs by more than case or whitespace', async () => {
    harness.llm.replies = [
      delegate('analyst', 'size the market'),
      'The market is large.',
      delegate('analyst', 'size the whole market'),
      'It is bigger than we thought.',
      'Build it.',
    ];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })
    ).completion;
    const detail = await harness.pipelines.get(run.id);

    const analystSteps = detail.steps.filter((step) => step.agentId === 'analyst');
    expect(analystSteps).toHaveLength(2);
  });
});

describe('what a handover may cost the agents after it', () => {
  it('cuts one that is too big, and says so inside the file', () => {
    const huge = 'x'.repeat(MAX_CONTEXT_FILE_BYTES + 50_000);
    const { files, notes } = clampHandover([{ name: 'dump.md', content: huge }]);

    // Cut, not refused. `normaliseContext` throws, which is right for a person attaching a
    // file and wrong mid-run: nobody is reading, and killing a run over an oversized note
    // throws away work that is otherwise finished.
    expect(files).toHaveLength(1);
    expect(Buffer.byteLength(files[0]?.content ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_CONTEXT_FILE_BYTES,
    );
    // An agent reading a note that stops mid-sentence must be able to tell it was cut.
    expect(files[0]?.content).toContain('cut here');
    expect(notes.join(' ')).toContain('dump.md');
  });

  it('drops one that is empty or is not text, and keeps the rest', () => {
    const { files, notes } = clampHandover([
      { name: 'empty.md', content: '   ' },
      { name: 'binary.md', content: `a\u0000b` },
      { name: 'good.md', content: 'turns, cacheReadTokens' },
    ]);

    expect(files.map((file) => file.name)).toEqual(['good.md']);
    expect(notes).toHaveLength(2);
  });

  it('holds the run under the total every later agent carries, oldest first', () => {
    const half = 'y'.repeat(MAX_CONTEXT_FILE_BYTES);
    const dropped: string[] = [];

    const kept = withinBudget(
      [
        { name: 'first.md', content: half },
        { name: 'second.md', content: half },
        { name: 'third.md', content: half },
      ],
      (name) => dropped.push(name),
    );

    // The most recent decision is the one the next agent is most likely to need.
    expect(dropped).toEqual(['first.md']);
    expect(kept.map((file) => file.name)).toEqual(['second.md', 'third.md']);
  });

  it('marks a handover as one, so a later attempt can tell it from an attachment', async () => {
    await seed();
    harness.llm.replies = [
      delegate('author-a', 'settle the shape'),
      ['Named them.', '', '```handover field-names.md', 'turns, cacheReadTokens', '```'].join('\n'),
      'Done.',
    ];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship it',
      context: [{ name: 'spec.md', content: 'what a person attached' }],
    });
    await completion;

    const detail = await harness.pipelines.get(run.id);
    expect(detail.context.find((file) => file.name === 'field-names.md')?.origin).toBe('handover');
    // Absent means attached: nothing else could ever have put a file here.
    expect(detail.context.find((file) => file.name === 'spec.md')?.origin).toBeUndefined();
  });

  it('does not carry a handover into a rerun, only what a person attached', async () => {
    await seed();
    harness.llm.replies = [
      delegate('author-a', 'settle the shape'),
      ['Named them.', '', '```handover field-names.md', 'turns, cacheReadTokens', '```'].join('\n'),
      'Done.',
    ];

    const first = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship it',
      context: [{ name: 'spec.md', content: 'what a person attached' }],
    });
    await first.completion;

    harness.llm.replies = ['Done.'];
    const again = await harness.pipelines.rerun(first.run.id);
    await again.completion;

    const carried = (await harness.pipelines.get(again.run.id)).context.map((file) => file.name);
    // A decision taken inside a run that did not finish is not source material for the next
    // attempt: carrying it hands the new agents a conclusion and calls it evidence.
    expect(carried).toContain('spec.md');
    expect(carried).not.toContain('field-names.md');
  });
});
