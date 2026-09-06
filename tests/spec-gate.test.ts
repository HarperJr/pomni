import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlowSchema,
  RequirementsNotMetError,
  describeUnmetList,
  hasRequirements,
  layout,
  newItemBody,
  type Flow,
  type UnmetRequirement,
} from '@pomni/core';
import { createApp } from '@pomni/server';
import { createHarness, type TestHarness } from './harness.js';

/**
 * The `spec` requirement: an item may not advance while its body is still the shipped
 * template. Every body here is either `newItemBody`'s own output, read back off a created
 * item, or prose a person could plausibly have typed — nothing pastes the template in.
 */

let harness: TestHarness;

function flow(input: unknown): Flow {
  return FlowSchema.parse(input);
}

async function useFlow(input: unknown): Promise<void> {
  await harness.projects.update('acme', { taskFlow: flow(input) });
}

/** A two-state flow whose one arrow asks only for a spec, so a refusal names only spec gaps. */
async function guarding(spec: { sections?: string[]; minCriteria?: number }): Promise<void> {
  await useFlow({
    states: ['backlog', 'ready'],
    transitions: [{ from: 'backlog', to: 'ready', requires: { spec } }],
  });
}

/** A body written by hand. An omitted section is genuinely absent, not blank. */
function body(parts: { problem?: string; acceptance?: string; plan?: string }): string {
  const chunks: string[] = [];
  if (parts.problem !== undefined) chunks.push(`## Problem\n\n${parts.problem}\n`);
  if (parts.acceptance !== undefined) chunks.push(`## Acceptance criteria\n\n${parts.acceptance}\n`);
  if (parts.plan !== undefined) chunks.push(`## Plan\n\n${parts.plan}\n`);
  chunks.push('## Log\n');
  return chunks.join('\n');
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the move to be refused, but it was allowed');
}

/** The refusal lines for a move, in the order the evaluator found them. */
async function refusal(itemId: string, to = 'ready'): Promise<string[]> {
  const error = await caught(harness.backlog.transition('acme', itemId, to));
  expect(error).toBeInstanceOf(RequirementsNotMetError);
  return describeUnmetList((error as RequirementsNotMetError).unmet);
}

/**
 * The unmet requirements as values rather than as sentences, for the few assertions that are
 * about the counting rather than about the English — `found` is not printed by any sentence.
 */
async function unmetOf(itemId: string, to = 'ready'): Promise<UnmetRequirement[]> {
  const error = await caught(harness.backlog.transition('acme', itemId, to));
  expect(error).toBeInstanceOf(RequirementsNotMetError);
  return (error as RequirementsNotMetError).unmet;
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a freshly created item, which is the case this exists for', () => {
  it('is shipped with the template body verbatim', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });
    expect(item.body).toBe(newItemBody('Magic link sign-in'));
  });

  it('is refused ready, and told which paragraph says nothing and which is missing', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });

    expect(await refusal(item.id)).toEqual([
      'Problem is still the template placeholder',
      'Acceptance criteria has one entry and it repeats the title',
      "no 'Plan' section is written in the item body",
    ]);
    expect((await harness.backlog.get('acme', item.id)).status).toBe('backlog');
  });

  it('goes to ready once a person has written in it', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });
    await harness.backlog.update('acme', item.id, {
      body: body({
        problem: 'Passwords are the top support ticket.',
        acceptance: '- [ ] a mailed link signs you in without a password',
        plan: '1. mail a signed token',
      }),
    });

    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });
});

describe('a section that says nothing', () => {
  beforeEach(async () => {
    await guarding({ sections: ['Problem'], minCriteria: 0 });
  });

  it('names a heading that is not in the body at all', async () => {
    const item = await harness.backlog.create('acme', {
      title: 'Magic link',
      body: body({ acceptance: '- [ ] a mailed link signs you in' }),
    });

    expect(await refusal(item.id)).toEqual(['Problem is missing from the item body']);
  });

  const nothings: Array<[string, string, string]> = [
    ['whitespace', '   \t  ', 'Problem is empty'],
    [
      'the shipped italic prompt',
      '_Why does this matter? What is broken or missing?_',
      'Problem is still the template placeholder',
    ],
    ['TBD', 'TBD', 'Problem is still the template placeholder'],
    ['ToDo', 'ToDo', 'Problem is still the template placeholder'],
    ['question marks', '???', 'Problem is still the template placeholder'],
    ['N/A', 'N/A', 'Problem is still the template placeholder'],
    ['Decide Later', 'Decide Later', 'Problem is still the template placeholder'],
    // Emphasis is stripped before the filler list is consulted, which is the seam that lets
    // the italic rule be narrow: a bold paragraph is prose, but a bold non-answer is still a
    // non-answer. Remove the stripping and this case silently opens.
    ['TBD in bold', '**TBD**', 'Problem is still the template placeholder'],
    ['an ellipsis', '...', 'Problem is still the template placeholder'],
    ['an em dash', '—', 'Problem is still the template placeholder'],
    ['three asterisks', '***', 'Problem is still the template placeholder'],
    ['a lone emoji', '🚀', 'Problem is still the template placeholder'],
  ];

  for (const [name, text, expected] of nothings) {
    it(`refuses a Problem that is only ${name}`, async () => {
      const item = await harness.backlog.create('acme', {
        title: 'Magic link',
        body: body({ problem: text, acceptance: '- [ ] a mailed link signs you in' }),
      });

      expect(await refusal(item.id)).toEqual([expected]);
    });
  }

  it('lets a paragraph written entirely in bold through, because emphasis is not emptiness', async () => {
    // A whole paragraph in bold is how people write a one-line problem statement emphatically.
    // Only the *italic* shape is the shipped prompt, so only italic is read as a placeholder —
    // refusing this would refuse a short, real spec, which is the one failure this gate cannot
    // have.
    const item = await harness.backlog.create('acme', {
      title: 'Cancel an orphaned run',
      body: body({
        problem: '**Runs orphaned by a dead process can never be cancelled.**',
        acceptance: '- [ ] a run whose process is gone can still be cancelled',
      }),
    });

    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });

  it('lets a real paragraph that happens to contain an italic phrase through', async () => {
    const item = await harness.backlog.create('acme', {
      title: 'Magic link',
      body: body({
        problem: 'Support calls are _mostly_ password resets.',
        acceptance: '- [ ] a mailed link signs you in',
      }),
    });

    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });
});

describe('an acceptance list that does not say anything the title does not', () => {
  const realProblem = 'Passwords are the top support ticket.';

  async function item(title: string, acceptance: string): Promise<string> {
    const created = await harness.backlog.create('acme', {
      title,
      body: body({ problem: realProblem, acceptance }),
    });
    return created.id;
  }

  beforeEach(async () => {
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 1 });
  });

  it('refuses a single criterion that restates the title', async () => {
    const id = await item('Refuse a placeholder', '- [ ] Refuse a placeholder');
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has one entry and it repeats the title',
    ]);
  });

  it('sees through a restated title in another case, with a full stop and a tick', async () => {
    const id = await item('Refuse a placeholder', '- [x]   refuse a  placeholder.  ');
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has one entry and it repeats the title',
    ]);
  });

  it('refuses a single criterion that is itself a placeholder', async () => {
    // A preamble line keeps the section as a whole from reading as a placeholder, so the one
    // entry beneath it is judged as a criterion rather than the paragraph being judged whole.
    const id = await item('Refuse a placeholder', 'The item must:\n\n- [ ] TBD');

    expect(await refusal(id)).toEqual([
      'Acceptance criteria has one entry and it is still a placeholder',
    ]);
  });

  it('calls a list of one placeholder a placeholder section, not a short list', async () => {
    // Both readings are true and only one of them is worth printing: with the heading among
    // the guarded sections, the whole paragraph is the absence and the count is suppressed.
    const id = await item('Refuse a placeholder', '- [ ] TBD');
    expect(await refusal(id)).toEqual(['Acceptance criteria is still the template placeholder']);
  });

  it('says so when every entry repeats the title', async () => {
    const id = await item(
      'Refuse a placeholder',
      '- [ ] Refuse a placeholder\n- [ ] refuse a placeholder!',
    );
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has 2 entries and every one repeats the title',
    ]);
  });

  it('says so when every entry is a placeholder', async () => {
    const id = await item('Refuse a placeholder', '- [ ] TBD\n- [ ] decide later');
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has 2 entries and every one is still a placeholder',
    ]);
  });

  it('covers both at once when the list is a mixture of the two', async () => {
    const id = await item('Refuse a placeholder', '- [ ] Refuse a placeholder\n- [ ] TBD');
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has 2 entries and none of them says anything the title does not',
    ]);
  });

  it('reports the missing acceptance section once, not twice', async () => {
    const id = await item('Refuse a placeholder', 'TBD');
    expect(await refusal(id)).toEqual(['Acceptance criteria is still the template placeholder']);
  });

  it('names an absent acceptance heading as absent, and does not also count its entries', async () => {
    const created = await harness.backlog.create('acme', {
      title: 'Refuse a placeholder',
      body: body({ problem: realProblem }),
    });

    // Not "lists no criteria" as well: one absent heading is one problem, not two.
    expect(await refusal(created.id)).toEqual(['Acceptance criteria is missing from the item body']);
  });

  it('says nothing about criteria when the requirement never named the acceptance heading', async () => {
    // A project that wrote `spec: { sections: [Problem] }` asked about one paragraph. Refusing
    // it by the state of a heading its config never mentioned is the gate answering a question
    // nobody asked — so an acceptance list of nothing but the title said again goes through.
    await guarding({ sections: ['Problem'] });
    const written = await item('Refuse a placeholder', '- [ ] Refuse a placeholder');

    expect((await harness.backlog.transition('acme', written, 'ready')).status).toBe('ready');
  });

  it('reports only the sections a Problem-only requirement asked about', async () => {
    await guarding({ sections: ['Problem'] });
    const created = await harness.backlog.create('acme', {
      title: 'Refuse a placeholder',
      body: body({ problem: 'TBD', acceptance: '- [ ] Refuse a placeholder' }),
    });

    expect(await refusal(created.id)).toEqual(['Problem is still the template placeholder']);
  });

  it('accepts prose acceptance criteria with no checkbox in sight', async () => {
    const id = await item('Refuse a placeholder', 'A placeholder item cannot reach ready.');
    expect((await harness.backlog.transition('acme', id, 'ready')).status).toBe('ready');
  });

  it('refuses prose acceptance criteria that only say the title again', async () => {
    const id = await item('Refuse a placeholder', 'Refuse a placeholder');
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has one entry and it repeats the title',
    ]);
  });

  it('counts a project that asks for more than one, and says how far short it fell', async () => {
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 2 });
    const id = await item(
      'Refuse a placeholder',
      '- [ ] Refuse a placeholder\n- [ ] the refusal names the section',
    );

    expect(await refusal(id)).toEqual([
      'Acceptance criteria has one criterion that says something the title does not, and needs 2',
    ]);
  });

  it('pluralises the shortfall when more than one criterion survived', async () => {
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 3 });
    const id = await item(
      'Refuse a placeholder',
      '- [ ] the refusal names the section\n- [ ] the refusal names the reason',
    );

    expect(await refusal(id)).toEqual([
      'Acceptance criteria has 2 criteria that say something the title does not, and needs 3',
    ]);
  });

  const dressedUp: Array<[string, string]> = [
    ['bold', '**Refuse a placeholder**'],
    ['a code span', '`Refuse a placeholder`'],
    ['a strikethrough', '~~Refuse a placeholder~~'],
    ['double quotes', '"Refuse a placeholder"'],
    ['guillemets', '«Refuse a placeholder»'],
  ];

  for (const [name, wrapping] of dressedUp) {
    it(`sees through a restated title wrapped in ${name}`, async () => {
      const id = await item('Refuse a placeholder', `- [ ] ${wrapping}`);
      expect(await refusal(id)).toEqual([
        'Acceptance criteria has one entry and it repeats the title',
      ]);
    });
  }

  it('calls a wholly italic criterion a placeholder rather than an echo, since it is both', async () => {
    // `_…_` is the shape the template writes its prompts in, so the placeholder test claims it
    // before the echo test is reached. Either sentence would be a true refusal; this is the one
    // that is printed, and it is the more general of the two.
    const id = await item('Refuse a placeholder', '- [ ] _Refuse a placeholder_');
    expect(await refusal(id)).toEqual([
      'Acceptance criteria has one entry and it is still a placeholder',
    ]);
  });
});

describe('an acceptance list written in a script that is not Latin', () => {
  const problem = 'Пользователи не получают уведомления о новых событиях.';

  beforeEach(async () => {
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 1 });
  });

  it('goes to ready, because a gate only Latin script can satisfy is a broken gate', async () => {
    const created = await harness.backlog.create('acme', {
      title: 'Пользовательские события',
      body: body({ problem, acceptance: '- [ ] уведомление приходит в течение минуты' }),
    });

    expect((await harness.backlog.transition('acme', created.id, 'ready')).status).toBe('ready');
  });

  it('still catches a Russian criterion that only says the Russian title again', async () => {
    const created = await harness.backlog.create('acme', {
      title: 'Пользовательские события',
      body: body({ problem, acceptance: '- [ ] Пользовательские события' }),
    });

    expect(await refusal(created.id)).toEqual([
      'Acceptance criteria has one entry and it repeats the title',
    ]);
  });

  it('catches the echo through trailing punctuation from another script', async () => {
    const created = await harness.backlog.create('acme', {
      title: 'Пользовательские события',
      body: body({ problem, acceptance: '- [ ] Пользовательские события。' }),
    });

    expect(await refusal(created.id)).toEqual([
      'Acceptance criteria has one entry and it repeats the title',
    ]);
  });
});

describe('a note indented under a criterion', () => {
  const problem = 'Passwords are the top support ticket.';

  it('is folded into the entry above it rather than counted as a second criterion', async () => {
    // The count is the assertion, and no sentence prints it — so this reads the gap itself.
    // Counting sub-bullets as peers would make "add a sub-bullet" the way to answer a refusal.
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 2 });
    const created = await harness.backlog.create('acme', {
      title: 'Magic link sign-in',
      body: body({
        problem,
        acceptance: '- [ ] a mailed link signs you in\n  - within a minute\n  - and only once',
      }),
    });

    expect(await unmetOf(created.id)).toEqual([
      {
        kind: 'spec',
        gap: {
          section: 'Acceptance criteria',
          reason: 'criteria',
          found: 1,
          usable: 1,
          needed: 2,
          echoesTitle: 0,
          placeholders: 0,
        },
      },
    ]);
  });

  it('lets an echoed criterion through once a note is folded onto it — a known hole, not a rule', async () => {
    // Folding makes the entry read "{title} as discussed", which is not the title, so the echo
    // test no longer fires. The plain continuation-line branch has always had this shape.
    // Closing it needs a judgement about whether words are vague, which this gate deliberately
    // refuses to make — length is not thought, and neither is its absence. Pinned so that a
    // future change closing it is a visible decision rather than a surprise.
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 1 });
    const created = await harness.backlog.create('acme', {
      title: 'Magic link sign-in',
      body: body({ problem, acceptance: '- [ ] Magic link sign-in\n  - as discussed' }),
    });

    expect((await harness.backlog.transition('acme', created.id, 'ready')).status).toBe('ready');
  });
});

describe('a spec requirement that names no sections', () => {
  it('guards nothing, even though the arrow still reports that it requires something', async () => {
    await guarding({});
    const parsed = await harness.backlog.flow('acme');
    const requires = parsed.transitions[0]?.requires;

    expect(requires?.spec).toEqual({ sections: [], minCriteria: 1 });
    expect(hasRequirements(requires as never)).toBe(true);

    // `minCriteria` defaults to 1, but the acceptance heading is not among the sections this
    // requirement asked about, so nothing is counted and the shipped template goes through.
    const created = await harness.backlog.create('acme', { title: 'Magic link sign-in' });
    expect((await harness.backlog.transition('acme', created.id, 'ready')).status).toBe('ready');
  });
});

describe('length is not thought', () => {
  beforeEach(async () => {
    await guarding({ sections: ['Problem', 'Acceptance criteria'], minCriteria: 1 });
  });

  it('accepts a short spec that actually says something', async () => {
    const item = await harness.backlog.create('acme', {
      title: 'Rotate the signing key',
      body: body({
        problem: 'The key has not changed since launch.\nOne leak and every session is forged.',
        acceptance: '- [ ] a leaked key stops working within an hour',
      }),
    });

    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });

  it('still refuses a long body that says nothing', async () => {
    const padded = `_${'Why does this matter, and what exactly is broken or missing here, '.repeat(
      6,
    )}_`;
    const item = await harness.backlog.create('acme', {
      title: 'Rotate the signing key',
      body: body({
        problem: padded,
        acceptance: [
          '- [ ] Rotate the signing key',
          '- [ ] rotate the signing key.',
          '- [ ] Rotate the signing key!',
          '- [ ] ROTATE THE SIGNING KEY',
        ].join('\n'),
      }),
    });

    expect(await refusal(item.id)).toEqual([
      'Problem is still the template placeholder',
      'Acceptance criteria has 4 entries and every one repeats the title',
    ]);
  });
});

describe('force', () => {
  it('still overrides the spec gate, and records what it went past as forced', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });

    const forced = await harness.backlog.transition('acme', item.id, 'ready', { force: true });

    expect(forced.status).toBe('ready');
    expect(forced.body).toContain('(forced)');
    expect(forced.body).toContain('unmet: ');
    expect(forced.body).toContain('Problem is still the template placeholder');
    expect(forced.body).toContain('Acceptance criteria has one entry and it repeats the title');
  });
});

describe('an agent run', () => {
  /** An orchestrator and one analyst to delegate to — the smallest runnable workflow. */
  async function seedWorkflow(): Promise<void> {
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

  it('is refused a guarded move for the same reason a person is, and the run says so', async () => {
    await seedWorkflow();
    // The pipeline moves the item it was started for as work begins. Guarding that arrow is
    // how a `spec` requirement lands in front of an agent.
    await useFlow({
      states: ['backlog', 'in_progress', 'in_review', 'blocked'],
      transitions: [
        {
          from: 'backlog',
          to: 'in_progress',
          requires: {
            spec: { sections: ['Problem', 'Acceptance criteria'], minCriteria: 1 },
          },
        },
        { from: 'backlog', to: 'blocked' },
        { from: 'in_progress', to: 'in_review' },
        { from: 'in_progress', to: 'blocked' },
      ],
    });
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Do the thing',
      itemId: item.id,
    });

    // Recorded on the run at the moment the move was refused, before the run finishes and
    // overwrites `itemStatus` with where the item ended up.
    const started = await harness.pipelines.get(run.id);
    expect(started.itemStatus).toContain('could not move to in_progress');
    expect(started.itemStatus).toContain('Problem is still the template placeholder');
    expect(started.itemStatus).toContain(
      'Acceptance criteria has one entry and it repeats the title',
    );

    // The item did not move anyway.
    expect((await harness.backlog.get('acme', item.id)).status).toBe('backlog');

    await completion;
  });
});

describe('a flow stored before this requirement existed', () => {
  it('still loads, and its arrows guard exactly what they always did', async () => {
    await useFlow({
      states: ['backlog', 'ready'],
      transitions: [{ from: 'backlog', to: 'ready', requires: { sections: ['Problem'] } }],
    });

    // What such a project's file looked like: no `spec` key anywhere in it.
    const path = join(harness.root, layout.project('acme'));
    const stored = await readFile(path, 'utf8');
    expect(stored).toContain('spec: null');
    await writeFile(path, stored.replace(/^\s*spec: null\r?\n/gm, ''), 'utf8');
    expect(await readFile(path, 'utf8')).not.toContain('spec:');

    const loaded = await harness.backlog.flow('acme');
    expect(loaded.transitions[0]?.requires.spec).toBeNull();

    // The italic template Problem is all the old `sections` check ever refused, and all it
    // refuses now — the acceptance echo it never noticed is still not its business.
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });
    expect(await refusal(item.id)).toEqual(["no 'Problem' section is written in the item body"]);

    await harness.backlog.update('acme', item.id, {
      body: body({ problem: 'Passwords are the top support ticket.', acceptance: '- [ ] Magic link sign-in' }),
    });
    expect((await harness.backlog.transition('acme', item.id, 'ready')).status).toBe('ready');
  });
});

describe('previewing a body nobody has saved', () => {
  const written = () =>
    body({
      problem: 'Passwords are the top support ticket.',
      acceptance: '- [ ] a mailed link signs you in without a password',
      plan: '1. mail a signed token',
    });

  function ready(offers: Array<{ to: string }>): { ok: boolean; unmet: unknown[] } {
    return offers.find((offer) => offer.to === 'ready') as never;
  }

  it('answers for the typed text and writes nothing', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });
    const before = await harness.backlog.get('acme', item.id);

    const asShipped = await harness.backlog.previewTransitions('acme', item.id, item.body);
    expect(ready(asShipped).ok).toBe(false);

    const edited = await harness.backlog.previewTransitions('acme', item.id, written());
    expect(ready(edited)).toEqual({ to: 'ready', label: 'Ready', ok: true, unmet: [], via: 'arrow' });

    const after = await harness.backlog.get('acme', item.id);
    expect(after.body).toBe(before.body);
    expect(after.status).toBe('backlog');
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('reads an empty draft as every section missing rather than as nothing to say', async () => {
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });

    const offers = await harness.backlog.previewTransitions('acme', item.id, '');
    const lines = describeUnmetList(ready(offers).unmet as never);

    expect(ready(offers).ok).toBe(false);
    expect(lines).toContain('Problem is missing from the item body');
    expect(lines).toContain('Acceptance criteria is missing from the item body');
    expect((await harness.backlog.get('acme', item.id)).body).toBe(item.body);
  });
});

describe('http api', () => {
  it('previews the transitions for a draft body without saving it', async () => {
    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const item = await harness.backlog.create('acme', { title: 'Magic link sign-in' });

    const shipped = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/items/${item.id}/transitions/preview`,
      payload: { body: item.body },
    });

    expect(shipped.statusCode).toBe(200);
    const refused = shipped
      .json()
      .allowedTransitions.find((offer: { to: string }) => offer.to === 'ready');
    expect(refused.ok).toBe(false);
    expect(refused.unmet).toContainEqual({
      kind: 'spec',
      gap: { section: 'Problem', reason: 'placeholder' },
    });

    const edited = await app.inject({
      method: 'POST',
      url: `/api/projects/acme/items/${item.id}/transitions/preview`,
      payload: {
        body: body({
          problem: 'Passwords are the top support ticket.',
          acceptance: '- [ ] a mailed link signs you in without a password',
          plan: '1. mail a signed token',
        }),
      },
    });

    expect(
      edited.json().allowedTransitions.find((offer: { to: string }) => offer.to === 'ready'),
    ).toMatchObject({ ok: true, unmet: [] });

    // The preview is a question, not an edit.
    const stored = await app.inject({ method: 'GET', url: `/api/projects/acme/items/${item.id}` });
    expect(stored.json().item.body).toBe(item.body);
    expect(stored.json().item.status).toBe('backlog');

    await app.close();
  });
});
