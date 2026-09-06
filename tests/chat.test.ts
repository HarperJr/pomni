import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layout, parseActionCalls, type Chat, type ChatMessage } from '@pomni/core';
import { SqliteChatStore } from '@pomni/infra';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

const PROVIDER = 'claude-code';
const MODEL = 'claude-sonnet-5';

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

async function newChat(): Promise<Chat> {
  return harness.chat.create({ providerId: PROVIDER, model: MODEL });
}

function onlyAction(message: ChatMessage) {
  const action = message.actions[0];
  if (!action) throw new Error(`expected one action, got ${message.actions.length}`);
  return action;
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
  const path = await makeNodeRepo(join(harness.dir, 'api'), {
    scripts: { test: 'vitest run' },
    devDependencies: {},
  });
  await (await harness.repos.add('acme', { source: { kind: 'local', path }, id: 'api' })).completion;
});

afterEach(async () => {
  await harness.cleanup();
});

describe('reading what the assistant asked for', () => {
  it('separates the prose the person reads from the block that runs', () => {
    const { prose, calls } = parseActionCalls(
      propose('Let me look.', { name: 'backlog.list', args: { project: 'acme' } }),
    );

    expect(prose).toBe('Let me look.');
    expect(calls).toEqual([{ name: 'backlog.list', args: { project: 'acme' } }]);
  });

  it('reads a reply that is nothing but the block', () => {
    const { prose, calls } = parseActionCalls(
      JSON.stringify({ actions: [{ name: 'project.list', args: {} }] }),
    );

    expect(prose).toBe('');
    expect(calls.map((call) => call.name)).toEqual(['project.list']);
  });

  it('leaves an ordinary answer alone', () => {
    expect(parseActionCalls('Three items are open.')).toEqual({
      prose: 'Three items are open.',
      calls: [],
    });
  });
});

describe('a write waits for a person', () => {
  it('proposes the move and does not make it until it is confirmed', async () => {
    const itemId = await specced('Magic link');
    const chat = await newChat();

    harness.llm.replies = [
      propose('I can move that for you.', {
        name: 'backlog.move',
        args: { project: 'acme', item: itemId, to: 'specced' },
      }),
    ];

    const answer = await harness.chat.sendMessage(chat.id, `Move ${itemId} to specced`);
    const proposed = onlyAction(answer);

    expect(proposed.name).toBe('backlog.move');
    expect(proposed.writes).toBe(true);
    expect(proposed.status).toBe('proposed');
    expect(proposed.result).toBeNull();
    expect(proposed.decidedAt).toBeNull();
    // The claim that matters: the backlog itself has not moved.
    expect((await harness.backlog.get('acme', itemId)).status).toBe('backlog');

    const settled = await harness.chat.confirmAction(chat.id, answer.id, proposed.id);
    const executed = onlyAction(settled);

    expect(executed.status).toBe('executed');
    expect(executed.decidedAt).not.toBeNull();
    expect(executed.result).toContain('specced');
    expect((await harness.backlog.get('acme', itemId)).status).toBe('specced');
  });

  it('leaves the data alone when the person says no', async () => {
    const itemId = await specced('Magic link');
    const chat = await newChat();

    harness.llm.replies = [
      propose('I can move that for you.', {
        name: 'backlog.move',
        args: { project: 'acme', item: itemId, to: 'specced' },
      }),
    ];

    const answer = await harness.chat.sendMessage(chat.id, `Move ${itemId} to specced`);
    const settled = await harness.chat.rejectAction(chat.id, answer.id, onlyAction(answer).id);
    const rejected = onlyAction(settled);

    expect(rejected.status).toBe('rejected');
    expect(rejected.result).toBeNull();
    expect((await harness.backlog.get('acme', itemId)).status).toBe('backlog');
  });

  it('refuses to run the same proposal twice', async () => {
    const itemId = await specced('Magic link');
    const chat = await newChat();

    harness.llm.replies = [
      propose('I can move that.', {
        name: 'backlog.move',
        args: { project: 'acme', item: itemId, to: 'specced' },
      }),
    ];

    const answer = await harness.chat.sendMessage(chat.id, `Move ${itemId}`);
    const actionId = onlyAction(answer).id;
    await harness.chat.confirmAction(chat.id, answer.id, actionId);

    // A second tab pressing the same button. Executed is terminal, so it cannot run again.
    await expect(harness.chat.confirmAction(chat.id, answer.id, actionId)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('shows a pending write in the chat until it is decided', async () => {
    const itemId = await specced('Magic link');
    const chat = await newChat();

    harness.llm.replies = [
      propose('Offering this.', {
        name: 'backlog.move',
        args: { project: 'acme', item: itemId, to: 'specced' },
      }),
    ];
    const answer = await harness.chat.sendMessage(chat.id, `Move ${itemId}`);

    expect((await harness.chat.get(chat.id)).pendingActions).toHaveLength(1);
    await harness.chat.rejectAction(chat.id, answer.id, onlyAction(answer).id);
    expect((await harness.chat.get(chat.id)).pendingActions).toHaveLength(0);
  });
});

describe('a read runs at once', () => {
  it('comes back with what the backlog service actually holds', async () => {
    const first = await specced('Magic link');
    const second = await specced('Password reset');
    const chat = await newChat();

    harness.llm.replies = [
      propose('Looking at the backlog.', {
        name: 'backlog.list',
        args: { project: 'acme', status: 'active' },
      }),
    ];

    const answer = await harness.chat.sendMessage(chat.id, 'What is open in acme?');
    const action = onlyAction(answer);

    expect(action.writes).toBe(false);
    // No confirmation happened, and none was asked for.
    expect(action.status).toBe('executed');
    expect(action.decidedAt).toBeNull();
    expect(action.error).toBeNull();

    const items = JSON.parse(action.result ?? 'null') as Array<{ id: string; title: string }>;
    expect(items.map((item) => item.id).sort()).toEqual([first, second].sort());
    expect(items.map((item) => item.title)).toContain('Magic link');
  });

  it('tells the model what the read returned on the next turn', async () => {
    await specced('Magic link');
    const chat = await newChat();

    harness.llm.replies = [
      propose('Looking.', { name: 'backlog.list', args: { project: 'acme' } }),
      'One item is open: Magic link.',
    ];

    await harness.chat.sendMessage(chat.id, 'What is open?');
    await harness.chat.sendMessage(chat.id, 'And its title?');

    const last = harness.llm.calls[harness.llm.calls.length - 1];
    const transcript = (last?.messages ?? []).map((message) => message.content).join('\n');
    expect(transcript).toContain('`backlog.list` returned');
    expect(transcript).toContain('Magic link');
  });

  it('says so instead of inventing an action it does not have', async () => {
    const chat = await newChat();
    harness.llm.replies = [propose('On it.', { name: 'backlog.delete', args: { item: 'ACME-1' } })];

    const answer = await harness.chat.sendMessage(chat.id, 'Delete ACME-1');

    expect(answer.actions).toHaveLength(0);
    expect(answer.text).toContain('could not run that');
    expect(answer.text).toContain('backlog.delete');
  });
});

describe('the transcript', () => {
  it('is still there when the chat is opened from a fresh store', async () => {
    const itemId = await specced('Magic link');
    const chat = await newChat();

    harness.llm.replies = [
      propose('I can move that.', {
        name: 'backlog.move',
        args: { project: 'acme', item: itemId, to: 'specced' },
      }),
    ];
    const answer = await harness.chat.sendMessage(chat.id, 'Move it to specced');
    await harness.chat.confirmAction(chat.id, answer.id, onlyAction(answer).id);

    const reopened = new SqliteChatStore(join(harness.root, layout.database));
    try {
      const stored = await reopened.getChat(chat.id);
      expect(stored).toMatchObject({
        id: chat.id,
        title: 'Move it to specced',
        providerId: PROVIDER,
        model: MODEL,
      });

      const messages = await reopened.listMessages(chat.id);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[0]?.text).toBe('Move it to specced');
      expect(messages[0]?.model).toBeNull();
      expect(messages[1]?.model).toBe(MODEL);
      expect(messages[1]?.providerId).toBe(PROVIDER);

      const action = messages[1]?.actions[0];
      expect(action?.name).toBe('backlog.move');
      expect(action?.writes).toBe(true);
      expect(action?.status).toBe('executed');
      expect(action?.args).toEqual({ project: 'acme', item: itemId, to: 'specced' });
      expect(action?.result).toContain('specced');
    } finally {
      reopened.close();
    }
  });

  it('names itself from the first message and does not rename on the second', async () => {
    const chat = await newChat();
    harness.llm.replies = ['Three.', 'Two.'];

    await harness.chat.sendMessage(chat.id, 'How many projects are there?');
    expect((await harness.chat.get(chat.id)).title).toBe('How many projects are there?');

    await harness.chat.sendMessage(chat.id, 'And how many repos?');
    expect((await harness.chat.get(chat.id)).title).toBe('How many projects are there?');
  });

  it('records a model change without rewriting who said what', async () => {
    const chat = await newChat();
    harness.llm.replies = ['Answered on sonnet.'];
    const first = await harness.chat.sendMessage(chat.id, 'Hello');

    await harness.chat.setModel(chat.id, 'anthropic', 'claude-opus-5');
    const detail = await harness.chat.get(chat.id);

    expect(detail.providerId).toBe('anthropic');
    expect(detail.model).toBe('claude-opus-5');

    const system = detail.messages.filter((message) => message.role === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toContain('claude-opus-5');

    // The earlier answer still says what actually wrote it.
    const earlier = detail.messages.find((message) => message.id === first.id);
    expect(earlier?.model).toBe(MODEL);
    expect(earlier?.providerId).toBe(PROVIDER);
  });

  it('reports usage as the sum of its messages, not a separate count', async () => {
    const chat = await newChat();
    harness.llm.replies = ['One.', 'Two.'];

    await harness.chat.sendMessage(chat.id, 'First');
    await harness.chat.sendMessage(chat.id, 'Second');
    const detail = await harness.chat.get(chat.id);

    const sum = (field: 'inputTokens' | 'outputTokens') =>
      detail.messages.reduce((total, message) => total + message[field], 0);

    expect(detail.inputTokens).toBe(sum('inputTokens'));
    expect(detail.outputTokens).toBe(sum('outputTokens'));
    expect(detail.inputTokens).toBeGreaterThan(0);
    // No provider here reports a price, and zero would read as "this was free".
    expect(detail.costUsd).toBeNull();
  });
});

describe('a chat is pinned to a model', () => {
  it('refuses a model the provider does not offer', async () => {
    await expect(
      harness.chat.create({ providerId: PROVIDER, model: 'gpt-9' }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('refuses an empty message rather than spending a turn on it', async () => {
    const chat = await newChat();
    await expect(harness.chat.sendMessage(chat.id, '   ')).rejects.toMatchObject({
      code: 'validation',
    });
    expect(harness.llm.calls).toHaveLength(0);
  });

  it('forgets a removed chat and its messages', async () => {
    const chat = await newChat();
    harness.llm.replies = ['Hello.'];
    await harness.chat.sendMessage(chat.id, 'Hello');

    await harness.chat.remove(chat.id);

    expect(await harness.chat.list()).toHaveLength(0);
    expect(await harness.chatStore.listMessages(chat.id)).toHaveLength(0);
  });
});
