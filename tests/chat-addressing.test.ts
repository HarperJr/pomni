import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * Addressing a chat: `#project`, `@agent`, `/skill`, and what happens when one of them names
 * something that is not there.
 *
 * The parser has its own unit tests next to it (`packages/core/src/domain/address.test.ts`);
 * everything here is about the half the parser deliberately refuses to do — deciding what a
 * candidate actually names, and what the chat does about it.
 */

let harness: TestHarness;

const SKILL_BODY = 'Answer in exactly one sentence, and name the file you read.';

/** What the assistant sends back when it wants Pomni to do something. */
function propose(prose: string, ...calls: Array<{ name: string; args?: unknown }>): string {
  return [
    prose,
    '',
    '```json',
    JSON.stringify({ actions: calls.map((call) => ({ args: {}, ...call })) }),
    '```',
  ].join('\n');
}

/** An item with a Problem and Acceptance criteria, so the flow will let it move on. */
async function specced(title: string): Promise<string> {
  const item = await harness.backlog.create('acme', { title });
  await harness.backlog.update('acme', item.id, {
    body: item.body
      .replace('_Why does this matter? What is broken or missing?_', 'Support load is high.')
      .replace('_Filled in by `pomni feature plan`, or by hand._', '1. do the thing'),
  });
  return item.id;
}

/** The system prompt of the nth-from-last completion — how a test sees what a turn was framed with. */
function systemAt(fromEnd = 1): string {
  return harness.llm.calls[harness.llm.calls.length - fromEnd]?.system ?? '';
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });

  const path = await makeNodeRepo(join(harness.dir, 'api'), {
    scripts: { test: 'vitest run' },
    devDependencies: {},
  });
  // A skill checked into the repo, in the shape discovery actually looks for.
  await mkdir(join(path, '.claude', 'skills', 'summarize'), { recursive: true });
  await writeFile(
    join(path, '.claude', 'skills', 'summarize', 'SKILL.md'),
    ['---', 'name: summarize', 'description: Say it in one sentence.', '---', '', SKILL_BODY].join(
      '\n',
    ),
  );
  await (await harness.repos.add('acme', { source: { kind: 'local', path }, id: 'api' })).completion;

  // One workflow attached to acme, and one that exists and is not.
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Scout',
    spec: 'Reads the codebase.',
    prompt: 'You read code and report what is there.',
  });
  await harness.workflows.attach('acme', 'discovery');

  await harness.workflows.create({ name: 'Fringe' });
  await harness.workflows.addAgent('fringe', {
    name: 'Stranger',
    spec: 'Belongs to another project.',
    prompt: 'You are elsewhere.',
  });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('a chat begins with the first thing someone types', () => {
  it('creates itself on the default provider and its medium model, with nobody asked', async () => {
    // Two replies, and the order is not a guess: the turn is awaited before `nameChat` is
    // started, so the answer takes the first and the title generation takes the second.
    harness.llm.replies = ['There is one project: acme.', 'Projects in this workspace'];

    const detail = await harness.chat.createFromFirstMessage({
      text: 'How many projects are there?',
    });

    expect(detail.providerId).toBe('claude-code');
    expect(detail.model).toBe('claude-sonnet-5');

    const answer = detail.messages.find((message) => message.role === 'assistant');
    expect(answer?.model).toBe('claude-sonnet-5');
    expect(answer?.providerId).toBe('claude-code');
    expect(answer?.text).toContain('one project');

    // The reply did not wait for the name, so the name arrives after it. Polled rather than
    // slept on: the title is written by a promise nobody returned, and the observable fact is
    // `titleGeneratedAt` becoming non-null.
    await vi.waitFor(async () => {
      const named = await harness.chat.get(detail.id);
      expect(named.titleGeneratedAt).not.toBeNull();
      expect(named.title).toBe('Projects in this workspace');
    });
  });

  it('falls back to the first line when the title completion fails, and settles it', async () => {
    harness.llm.replies = ['One.'];
    // Only the naming call fails; the answer itself is unaffected, which is the whole point of
    // doing it off the request path.
    harness.llm.failCompleteWhen = /Give this conversation a title/;

    const detail = await harness.chat.createFromFirstMessage({ text: 'What repos does acme have?' });
    expect(detail.messages.at(-1)?.text).toContain('One.');

    // Provisional until the generation lands, and the fallback is the message itself.
    await vi.waitFor(async () => {
      expect((await harness.chat.get(detail.id)).titleGeneratedAt).not.toBeNull();
    });
    expect((await harness.chat.get(detail.id)).title).toBe('What repos does acme have?');
  });

  it('refuses a first message with no words in it rather than creating an empty chat', async () => {
    await expect(harness.chat.createFromFirstMessage({ text: '  \n ' })).rejects.toMatchObject({
      code: 'validation',
    });
    expect(await harness.chat.list()).toHaveLength(0);
  });
});

describe('an address that names nothing', () => {
  it('sends anyway, keeps the words, and answers with what does exist', async () => {
    const chat = await harness.chat.create({
      providerId: 'claude-code',
      model: 'claude-sonnet-5',
    });
    harness.llm.replies = ['I do not know that one.'];

    const answer = await harness.chat.sendMessage(chat.id, '#nope what is open?');

    // Not a throw, and not a silent deletion: the candidate is still where it was typed.
    const messages = await harness.chatStore.listMessages(chat.id);
    expect(messages[0]?.text).toBe('#nope what is open?');
    expect(messages[0]?.addresses).toEqual([]);
    expect(messages[0]?.projectId).toBeNull();
    expect((await harness.chat.get(chat.id)).projectId).toBeNull();

    // And the reply says what there is instead of failing.
    expect(answer.text).toContain("no project 'nope'");
    expect(answer.text).toContain('acme');

    // The model was asked the question with the unresolved candidate intact — deleting it
    // would change what was asked.
    const asked = harness.llm.calls[0]?.messages.map((entry) => entry.content).join('\n') ?? '';
    expect(asked).toContain('#nope');
  });

  it('refuses an agent that is real but is not this project’s to run, and says what is', async () => {
    const chat = await harness.chat.create({
      providerId: 'claude-code',
      model: 'claude-sonnet-5',
    });

    await expect(
      harness.chat.sendMessage(chat.id, '#acme @stranger have a look'),
    ).rejects.toMatchObject({ code: 'validation' });

    await expect(
      harness.chat.sendMessage(chat.id, '#acme @stranger have a look'),
    ).rejects.toThrow(/Fringe.*not attached.*acme/s);
    await expect(harness.chat.sendMessage(chat.id, '#acme @stranger have a look')).rejects.toThrow(
      /@discovery\/scout/,
    );

    // A refusal costs nothing: no turn was taken and no message was stored.
    expect(harness.llm.calls).toHaveLength(0);
    expect(await harness.chatStore.listMessages(chat.id)).toHaveLength(0);
  });

  it('offers only the agents of the workflows the project actually has', async () => {
    const offered = await harness.chat.addressables('acme');

    expect(offered.projects.map((project) => project.id)).toEqual(['acme']);
    expect(offered.agents.map((agent) => `${agent.workflowId}/${agent.agentId}`)).toEqual([
      'discovery/scout',
    ]);
    expect(offered.skills.map((skill) => skill.name)).toContain('summarize');

    // With no project in force there is no authority to offer anything under.
    const unscoped = await harness.chat.addressables(null);
    expect(unscoped.agents).toEqual([]);
    expect(unscoped.skills).toEqual([]);
  });
});

describe('how long an address lasts', () => {
  it('holds #project for later messages, until another one changes it', async () => {
    await harness.projects.create({ name: 'Beta' });
    const chat = await harness.chat.create({
      providerId: 'claude-code',
      model: 'claude-sonnet-5',
    });
    harness.llm.replies = ['Nothing yet.', 'Still nothing.', 'Beta is empty.'];

    const first = await harness.chat.sendMessage(chat.id, '#acme what is open?');
    expect(first.projectId).toBe('acme');
    expect((await harness.chat.get(chat.id)).projectId).toBe('acme');

    // No address at all, and the conversation is still about acme.
    const second = await harness.chat.sendMessage(chat.id, 'and the repos?');
    expect(second.projectId).toBe('acme');
    expect(systemAt()).toContain("the project 'acme'");

    const third = await harness.chat.sendMessage(chat.id, '#beta and over here?');
    expect(third.projectId).toBe('beta');
    expect((await harness.chat.get(chat.id)).projectId).toBe('beta');
  });

  it('applies a /skill to the message it is in and no further', async () => {
    const chat = await harness.chat.create({
      providerId: 'claude-code',
      model: 'claude-sonnet-5',
    });
    harness.llm.replies = ['One sentence.', 'A longer answer.'];

    await harness.chat.sendMessage(chat.id, '#acme /summarize what is this repo?');
    expect(systemAt()).toContain(SKILL_BODY);
    expect(systemAt()).toContain('# Skill: summarize');

    await harness.chat.sendMessage(chat.id, 'and what does it test?');
    expect(systemAt()).not.toContain(SKILL_BODY);
    // The project it was said alongside is still in force, though.
    expect(systemAt()).toContain("the project 'acme'");
  });

  it('puts one message to an @agent and the next back to Pomni', async () => {
    const chat = await harness.chat.create({
      providerId: 'claude-code',
      model: 'claude-sonnet-5',
    });
    harness.llm.replies = ['The repo is a Node package.', 'Pomni here.'];

    const addressed = await harness.chat.sendMessage(chat.id, '#acme @scout what is in the repo?');

    // The agent's own prompt ran, and the transcript says whose answer this is.
    expect(systemAt()).toContain('You read code and report what is there.');
    expect(addressed.text).toContain('**Scout**');
    expect(addressed.text).toContain('discovery/scout');
    expect(addressed.text).toContain('The repo is a Node package.');

    const stored = await harness.chatStore.listMessages(chat.id);
    expect(stored[0]?.addresses).toEqual([
      { kind: 'project', name: 'acme', workflowId: null },
      { kind: 'agent', name: 'scout', workflowId: null },
    ]);
    // The agent was given the question without the chips in it.
    const task = harness.llm.calls[0]?.messages[0]?.content ?? '';
    expect(task).toBe('what is in the repo?');

    const next = await harness.chat.sendMessage(chat.id, 'and who wrote it?');
    expect(next.text).not.toContain('**Scout**');
    expect(systemAt()).toContain('You are Pomni');
  });
});

describe('addressing is not a way round the confirmation', () => {
  it('still proposes a write, and does not make it, when the turn went to an agent', async () => {
    const itemId = await specced('Magic link');
    const chat = await harness.chat.create({
      providerId: 'claude-code',
      model: 'claude-sonnet-5',
    });

    harness.llm.replies = [
      propose('That one is ready to move.', {
        name: 'backlog.move',
        args: { project: 'acme', item: itemId, to: 'specced' },
      }),
    ];

    const answer = await harness.chat.sendMessage(chat.id, `#acme @scout move ${itemId} on`);
    const action = answer.actions[0];

    expect(action?.name).toBe('backlog.move');
    expect(action?.writes).toBe(true);
    expect(action?.status).toBe('proposed');
    // The claim that matters: nothing moved because of how the message was addressed.
    expect((await harness.backlog.get('acme', itemId)).status).toBe('backlog');

    const settled = await harness.chat.confirmAction(chat.id, answer.id, action?.id ?? '');
    expect(settled.actions[0]?.status).toBe('executed');
    expect((await harness.backlog.get('acme', itemId)).status).toBe('specced');
  });
});
