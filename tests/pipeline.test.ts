import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SIBLING_BYTES,
  PipelineRunSchema,
  parseHandover,
  withSiblings,
} from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

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

const delegate = (task: string) =>
  ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task }] }), '```'].join('\n');

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('orchestration', () => {
  it('answers a repeated delegation from what it already got back', async () => {
    // The lead asks for the same thing twice. The second ask must not open a second session:
    // it costs money and returns what the first one said.
    harness.llm.replies = [
      delegate('size the market'),
      'The market is large.',
      delegate('size the market'),
      'Everything considered, build it.',
    ];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' });
    const run = await completion;
    const detail = await harness.pipelines.get(run.id);

    expect(run.status).toBe('passed');
    expect(run.result).toBe('Everything considered, build it.');

    const analystSteps = detail.steps.filter((step) => step.agentId === 'analyst');
    expect(analystSteps).toHaveLength(1);
    expect(harness.llm.replies).toHaveLength(0);
  });

  it('lets an orchestrator see its own earlier turns', async () => {
    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    await (await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })).completion;

    // The lead's second turn. Without its own reply in the history it cannot tell what it
    // has already asked for, and asks again.
    const last = harness.llm.calls[harness.llm.calls.length - 1];
    expect(last?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(last?.messages[1]?.content).toContain('size the market');
    expect(last?.messages[2]?.content).toContain('analyst (1x)');
  });
});

describe('context files', () => {
  it('gives every agent the attached files, not only the orchestrator', async () => {
    harness.llm.replies = [delegate('size the market'), 'The market is large.', 'Build it.'];

    await (
      await harness.pipelines.start({
        projectId: 'acme',
        task: 'Should we?',
        context: [{ name: 'brief.md', content: 'The buyer is a hospital procurement lead.' }],
      })
    ).completion;

    // The analyst is told the task as if it can see nothing else. If context stopped at the
    // orchestrator, the agent doing the work would be the one without it.
    for (const call of harness.llm.calls) {
      expect(call.messages[0]?.content).toContain('hospital procurement lead');
    }
  });

  it('keeps the stored task free of the attachment', async () => {
    harness.llm.replies = ['Build it.'];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we?',
      context: [{ name: 'notes/brief.md', content: 'Some background.' }],
    });
    await completion;

    expect(run.task).toBe('Should we?');
    // Named by basename: an agent refers to the file, not to where it sat on someone's disk.
    expect(run.context).toEqual([{ name: 'brief.md', content: 'Some background.' }]);

    const reloaded = await harness.pipelines.get(run.id);
    expect(reloaded.context[0]?.name).toBe('brief.md');
  });

  it('refuses a file too large to send to every agent', async () => {
    await expect(
      harness.pipelines.start({
        projectId: 'acme',
        task: 'Should we?',
        context: [{ name: 'dump.log', content: 'x'.repeat(300_000) }],
      }),
    ).rejects.toThrow(/limit for one file/);
  });

  it('refuses a file that is not text', async () => {
    await expect(
      harness.pipelines.start({
        projectId: 'acme',
        task: 'Should we?',
        context: [{ name: 'logo.png', content: 'PNG\u0000\u0000' }],
      }),
    ).rejects.toThrow(/not a text file/);
  });
});

describe('a run whose process died', () => {
  it('can be closed out by another process', async () => {
    // What the store looks like after a session is killed mid-run: still `running`, with
    // nothing left anywhere to receive a signal.
    // Through the schema, not spelled out. Written by hand this literal fell behind
    // `inputTokens`/`outputTokens` once and `branch` a second time, each caught only because
    // the test project type-checks now. Defaults are the schema's job.
    const orphan = PipelineRunSchema.parse({
      id: 'orphaned-run',
      projectId: 'acme',
      workflowId: 'discovery',
      workflowName: 'Discovery',
      providerId: 'claude-code',
      task: 'something from a session that is gone',
      status: 'running',
      itemId: null,
      result: null,
      error: null,
      costUsd: null,
      endedAt: null,
      durationMs: null,
      // The pid of the session that died. It is still written down; nothing is behind it.
      pid: 999_999,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await harness.pipelineStore.insertRun(orphan);

    const closed = await harness.pipelines.cancel(orphan.id);

    expect(closed.status).toBe('cancelled');
    expect(closed.error).toContain('is gone');
    expect((await harness.pipelines.get(orphan.id)).status).toBe('cancelled');
  });
});

describe('asking a person', () => {
  const askHuman = (task: string) =>
    ['```json', JSON.stringify({ delegate: [{ agent: 'human', task }] }), '```'].join('\n');

  /** Wait for the run to actually be blocked on its question. */
  async function waitForQuestion(): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const [question] = await harness.pipelines.openQuestions();
      if (question) return question.id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the run never asked anything');
  }

  it('stops until the answer arrives, then carries on with it', async () => {
    harness.llm.replies = [askHuman('Ship behind a flag, or hold?'), 'Held it, as you said.'];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we ship?',
    });

    const questionId = await waitForQuestion();
    // Still blocked: the orchestrator has had exactly one turn and is waiting.
    expect(harness.llm.calls).toHaveLength(1);

    await harness.pipelines.answer(questionId, 'Hold it until Monday.');
    const run = await completion;

    expect(run.status).toBe('passed');
    expect(run.result).toBe('Held it, as you said.');

    // The answer comes back where an agent's result would, in the same conversation.
    const last = harness.llm.calls[harness.llm.calls.length - 1];
    expect(last?.messages[2]?.content).toContain('Hold it until Monday.');
    expect(last?.messages[2]?.content).toContain('The person who started this run');
  });

  it('hands a file over with the answer, to the asker and to everyone after it', async () => {
    harness.llm.replies = [
      askHuman('Which layout?'),
      // The lead delegates onward once it has the answer.
      ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task: 'build it' }] }), '```'].join('\n'),
      'Built.',
      'Done.',
    ];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Design it',
    });

    const questionId = await waitForQuestion();
    await harness.pipelines.answer(questionId, 'This one.', [
      { name: 'layout.md', content: 'Two columns, sidebar on the left.' },
    ]);
    await completion;

    // The asker sees it in the round it was waiting on.
    const toLead = harness.llm.calls[1];
    expect(toLead?.messages[2]?.content).toContain('Two columns, sidebar on the left.');

    // The analyst, delegated to afterwards, gets it as context — it was never in that
    // conversation, so without this the file would have died with the question.
    const toAnalyst = harness.llm.calls.find((call) =>
      call.system?.includes('You analyse.'),
    );
    expect(toAnalyst?.messages[0]?.content).toContain('Two columns, sidebar on the left.');
    expect(toAnalyst?.messages[0]?.content).toContain('layout.md');
  });

  it('takes a file as the whole answer', async () => {
    harness.llm.replies = [askHuman('Which layout?'), 'Done.'];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Design it',
    });

    const questionId = await waitForQuestion();
    await harness.pipelines.answer(questionId, '', [
      { name: 'layout.md', content: 'Two columns.' },
    ]);
    await completion;

    const [question] = (await harness.pipelines.get(run.id)).questions;
    expect(question?.answer).toContain('layout.md');
    expect(question?.attachments[0]?.name).toBe('layout.md');
  });

  it('refuses an answer that is neither words nor a file', async () => {
    harness.llm.replies = [askHuman('Which layout?'), 'Done.'];

    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Design it' });
    const questionId = await waitForQuestion();

    await expect(harness.pipelines.answer(questionId, '   ')).rejects.toThrow(
      /words, a file, or both/,
    );

    await harness.pipelines.answer(questionId, 'This one.');
    await completion;
  });

  it('records the question against the run', async () => {
    harness.llm.replies = [askHuman('Which one?'), 'Done.'];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we ship?',
    });

    const questionId = await waitForQuestion();
    await harness.pipelines.answer(questionId, 'The second one.');
    await completion;

    const [question] = (await harness.pipelines.get(run.id)).questions;
    expect(question?.question).toBe('Which one?');
    expect(question?.answer).toBe('The second one.');
    expect(question?.status).toBe('answered');
    expect(question?.agentName).toBe('Lead');
  });

  it('refuses a second answer to the same question', async () => {
    harness.llm.replies = [askHuman('Which one?'), 'Done.'];

    const { completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Should we ship?',
    });

    const questionId = await waitForQuestion();
    await harness.pipelines.answer(questionId, 'The second one.');
    await completion;

    await expect(harness.pipelines.answer(questionId, 'Actually the first.')).rejects.toThrow(
      /already answered/,
    );
  });
});

describe('a run is green only if the work happened', () => {
  const verdict = (outcome: string, unmet: string[] = []) =>
    ['```json', JSON.stringify({ outcome, unmet }), '```'].join('\n');

  it('fails a run whose orchestrator reports it was blocked', async () => {
    harness.llm.replies = [
      `I could not do this.${'\n\n'}${verdict('blocked', ['no Figma access'])}`,
    ];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Design it' })
    ).completion;

    expect(run.status).toBe('failed');
    expect(run.outcome).toBe('blocked');
    expect(run.unmet).toEqual(['no Figma access']);
    // The verdict block is machinery, not prose: it does not belong in what a person reads.
    expect(run.result).toBe('I could not do this.');
  });

  it('does not call a run done when nobody said it was', async () => {
    harness.llm.replies = ['Finished, I think.'];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Design it' })
    ).completion;

    // Absence of a claim is not a claim of success.
    expect(run.outcome).toBe('unknown');
  });

  it('shows the orchestrator that its agent was blocked', async () => {
    harness.llm.replies = [
      ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task: 'read the wireframes' }] }), '```'].join('\n'),
      `I have zero visibility into the wireframes.${'\n\n'}${verdict('blocked', ['could not open the Figma file'])}`,
      `Reported honestly.${'\n\n'}${verdict('partial', ['no wireframes were read'])}`,
    ];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Design it' })
    ).completion;

    const last = harness.llm.calls[harness.llm.calls.length - 1];
    expect(last?.messages[2]?.content).toContain('BLOCKED');
    expect(last?.messages[2]?.content).toContain('could not open the Figma file');

    // The step itself is recorded as blocked, so the tree cannot show it green.
    const detail = await harness.pipelines.get(run.id);
    const analyst = detail.steps.find((step) => step.agentId === 'analyst');
    expect(analyst?.status).toBe('done');
    expect(analyst?.outcome).toBe('blocked');
    expect(run.outcome).toBe('partial');
  });
});

describe('running it again', () => {
  const verdict = (outcome: string, unmet: string[] = []) =>
    ['```json', JSON.stringify({ outcome, unmet }), '```'].join('\n');

  it('carries why the last attempt ended into the next one', async () => {
    harness.llm.replies = [
      `figma-cli reported no file open.${'\n\n'}${verdict('blocked', ['could not read the wireframes'])}`,
    ];

    const first = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Design the flow' })
    ).completion;
    expect(first.status).toBe('failed');

    harness.llm.replies = [`Done this time.${'\n\n'}${verdict('done')}`];
    const { run, completion } = await harness.pipelines.rerun(first.id);
    await completion;

    expect(run.rerunOf).toBe(first.id);
    expect(run.task).toBe(first.task);

    // The agent starts knowing what stopped the last attempt, rather than walking into it.
    const attempt = run.context.find((file) => file.name === 'previous-attempt.md');
    expect(attempt?.content).toContain('could not read the wireframes');
    expect(attempt?.content).toContain('figma-cli reported no file open');
    const latest = harness.llm.calls[harness.llm.calls.length - 1];
    expect(latest?.messages[0]?.content).toContain('previous-attempt.md');
    expect(latest?.messages[0]?.content).toContain('could not read the wireframes');
  });

  it('does not stack a summary per attempt', async () => {
    harness.llm.replies = [`Blocked.${'\n\n'}${verdict('blocked', ['first reason'])}`];
    const first = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Design the flow' })
    ).completion;

    harness.llm.replies = [`Blocked again.${'\n\n'}${verdict('blocked', ['second reason'])}`];
    const second = await (await harness.pipelines.rerun(first.id)).completion;

    harness.llm.replies = [`Done.${'\n\n'}${verdict('done')}`];
    const { run, completion } = await harness.pipelines.rerun(second.id);
    await completion;

    const attempts = run.context.filter((file) => file.name === 'previous-attempt.md');
    expect(attempts).toHaveLength(1);
    // And it describes the most recent attempt, not the first one.
    expect(attempts[0]?.content).toContain('second reason');
  });

  it('refuses to rerun something still going', async () => {
    // Held open by a question, which is the one way to be sure it is still running.
    harness.llm.replies = [
      ['```json', JSON.stringify({ delegate: [{ agent: 'human', task: 'Which?' }] }), '```'].join(
        '\n',
      ),
      `Done.${'\n\n'}${verdict('done')}`,
    ];

    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Design the flow',
    });

    let questionId = '';
    for (let attempt = 0; attempt < 60 && !questionId; attempt += 1) {
      questionId = (await harness.pipelines.openQuestions())[0]?.id ?? '';
      if (!questionId) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await expect(harness.pipelines.rerun(run.id)).rejects.toThrow(/still going/);

    await harness.pipelines.answer(questionId, 'The first one.');
    await completion;
  });
});

describe('a project is more than its first repo', () => {
  it('opens every repo to the agent, not just the one it starts in', async () => {
    // Two repos, as a real project has: the API and the app that calls it.
    const api = await makeNodeRepo(join(harness.dir, 'nons-be'));
    const app = await makeNodeRepo(join(harness.dir, 'nons-kmp'));
    await (await harness.repos.add('acme', { source: { kind: 'local', path: api } })).completion;
    await (await harness.repos.add('acme', { source: { kind: 'local', path: app } })).completion;

    await harness.workflows.updateAgent('discovery', 'analyst', { tools: { files: true } });
    harness.llm.replies = [
      ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task: 'read both' }] }), '```'].join('\n'),
      'Read them.',
      'Done.',
    ];

    await (await harness.pipelines.start({ projectId: 'acme', task: 'Cross-repo change' }))
      .completion;

    // Both directories reach the session. Handing over only the first is what made agents
    // report the mobile app as unreadable — and they were right.
    const dirs = harness.llmFactory.lastOptions.dirs ?? [];
    expect(dirs).toHaveLength(2);
    expect(dirs.some((dir) => dir.endsWith('nons-be'))).toBe(true);
    expect(dirs.some((dir) => dir.endsWith('nons-kmp'))).toBe(true);

    // And the agent is told they exist: access it does not know about is no access.
    const toAnalyst = harness.llm.calls.find((call) => call.system?.includes('You analyse.'));
    expect(toAnalyst?.system).toContain('Repos you can read and change');
    expect(toAnalyst?.system).toContain('nons-kmp');
  });
});

describe('resuming an interrupted run', () => {
  const verdict = (outcome: string) =>
    ['```json', JSON.stringify({ outcome, unmet: [] }), '```'].join('\n');

  it('reuses what finished and does not ask those agents again', async () => {
    // A run that delegates once, gets an answer, and is then cut off mid-flight.
    harness.llm.replies = [
      ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task: 'size it' }] }), '```'].join('\n'),
      'The market is large.',
      `Done.\n\n${verdict('done')}`,
    ];

    const first = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })
    ).completion;
    expect(first.status).toBe('passed');

    // Pretend it was interrupted instead: the row says cancelled, the answers remain.
    await harness.pipelineStore.updateRun(first.id, {
      ...first,
      status: 'cancelled',
      outcome: 'unknown',
      error: 'killed',
    });

    const before = harness.llm.calls.length;
    harness.llm.replies = [
      ['```json', JSON.stringify({ delegate: [{ agent: 'analyst', task: 'size it' }] }), '```'].join('\n'),
      `Done at last.\n\n${verdict('done')}`,
    ];

    const { run, completion } = await harness.pipelines.resume(first.id);
    const finished = await completion;

    // Same run, carried on.
    expect(run.id).toBe(first.id);
    expect(finished.status).toBe('passed');

    // The analyst was not opened a second time: its answer came from the ledger.
    const analystCalls = harness.llm.calls
      .slice(before)
      .filter((call) => call.system?.includes('You analyse.'));
    expect(analystCalls).toHaveLength(0);

    // And the orchestrator did receive that answer.
    const last = harness.llm.calls[harness.llm.calls.length - 1];
    expect(last?.messages.map((m) => m.content).join(' ')).toContain('The market is large.');
  });

  it('refuses to resume a run that finished', async () => {
    harness.llm.replies = [`All done.\n\n${verdict('done')}`];
    const done = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Should we?' })
    ).completion;

    await expect(harness.pipelines.resume(done.id)).rejects.toThrow(/finished/);
  });
});

describe('what an agent is handed before it starts', () => {
  const report = (agentId: string, answer: string) => ({
    agentId,
    agentName: agentId,
    task: `do the ${agentId} part`,
    answer,
  });

  it('adds nothing when nobody has reported yet', () => {
    expect(withSiblings('Write the store.', [])).toBe('Write the store.');
  });

  it('tells a delegate what the ones before it decided', () => {
    const composed = withSiblings('Write the web.', [
      report('service-author', 'I named the fields turns and cacheReadTokens.'),
    ]);

    expect(composed).toContain('Write the web.');
    expect(composed).toContain('already decided');
    expect(composed).toContain('turns and cacheReadTokens');
    // The task it was asked, so the reader can tell which part of the change this was.
    expect(composed).toContain('do the service-author part');
  });

  it('carries the newest first and stops at its budget', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      report(`agent-${index}`, `line for ${index}${'x'.repeat(4000)}`),
    );

    const composed = withSiblings('Task.', many);

    expect(Buffer.byteLength(composed, 'utf8')).toBeLessThan(MAX_SIBLING_BYTES + 1500);
    // Newest first: the most recent decision is the one most likely to bind this agent.
    expect(composed).toContain('agent-11');
    expect(composed).not.toContain('agent-0 ');
  });
});

describe('an agent handing something to the rest of the run', () => {
  it('reads a published file out of an answer', () => {
    const answer = [
      'I settled the shape.',
      '',
      '```handover field-names.md',
      'turns, cacheReadTokens, freshInputTokens',
      '```',
      '',
      'That is all.',
    ].join('\n');

    expect(parseHandover(answer)).toEqual([
      { name: 'field-names.md', content: 'turns, cacheReadTokens, freshInputTokens' },
    ]);
  });

  it('ignores an unnamed, an empty or an unterminated block', () => {
    expect(parseHandover('```handover\nno name\n```')).toEqual([]);
    expect(parseHandover('```handover a.md\n\n```')).toEqual([]);
    expect(parseHandover('```handover a.md\nnever closed')).toEqual([]);
  });

  it('reads several, and leaves ordinary fences alone', () => {
    const answer = [
      '```ts',
      'const notAHandover = true;',
      '```',
      '```handover one.md',
      'first',
      '```',
      '```handover two.md',
      'second',
      '```',
    ].join('\n');

    expect(parseHandover(answer).map((file) => file.name)).toEqual(['one.md', 'two.md']);
  });
});

describe('what kind of change a run is for', () => {
  it('tells the orchestrator, so it can size the team to it', async () => {
    const item = await harness.backlog.create('acme', { title: 'Fix the checkout', type: 'bug' });

    harness.llm.replies = ['Done.'];
    await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Fix the checkout', itemId: item.id })
    ).completion;

    // The item's `type` existed from the beginning and reached nobody: the task was its title
    // and body. A lead cannot size a team to a kind of change it is never told.
    const brief = String(harness.llm.calls[0]?.messages[0]?.content ?? '');
    expect(brief).toContain('**bug**');
    expect(brief).toContain(item.id);
  });

  it('says nothing about a kind when the run has no item', async () => {
    harness.llm.replies = ['Done.'];
    await (await harness.pipelines.start({ projectId: 'acme', task: 'Look at something' })).completion;

    expect(String(harness.llm.calls[0]?.messages[0]?.content ?? '')).not.toContain('Size the team');
  });
});

describe('POMN-70: a run syncs the code it is about to work in', () => {
  /** A cloned repo, isolated by default (git kind, not a linked directory). */
  async function addCloned(name: string): Promise<{ id: string; workingDir: string }> {
    const { repo, completion } = await harness.repos.add('acme', {
      source: { kind: 'git', url: `https://forge.test/acme/${name}.git` },
    });
    await completion;
    const workingDir = (await harness.repos.get('acme', repo.id)).workingDir;
    return { id: repo.id, workingDir };
  }

  /** A repo linked from the user's own disk — must never have its branch advanced. */
  async function addLinked(name: string): Promise<{ id: string; workingDir: string }> {
    const dir = await makeNodeRepo(join(harness.dir, name));
    harness.git.trackRepo(dir);
    const { repo, completion } = await harness.repos.add('acme', {
      source: { kind: 'local', path: dir },
    });
    await completion;
    // 'always' so the linked repo is still isolated into its own worktree — the sync
    // question ("was the branch advanced") is independent of the isolation question.
    await harness.repos.update('acme', repo.id, { worktrees: 'always' });
    return { id: repo.id, workingDir: dir };
  }

  it('syncs a repo before cutting its worktree, and records what the sync found', async () => {
    const { id: repoId, workingDir } = await addCloned('web');
    // The head `addWorktree` will report once the branch has been fast-forwarded.
    harness.git.trackRepo(workingDir, { branch: 'main', head: 'bbb' });
    harness.git.fastForwardResult = {
      status: 'advanced',
      branch: 'main',
      upstream: 'origin/main',
      from: 'aaa',
      to: 'bbb',
      detail: "'main' advanced to origin/main",
    };

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });

    expect(run.bases).toHaveLength(1);
    expect(run.bases[0]).toMatchObject({
      repoId,
      sync: 'advanced',
      from: 'aaa',
      to: 'bbb',
      commit: 'bbb',
    });

    // Read the tree that exists now, not whatever it happened to be at when someone last
    // synced by hand: the fetch and fast-forward on the repo's own directory must be recorded
    // before the worktree is cut from it.
    const relevant = harness.git.ordered.filter((call) => call.dir === workingDir);
    const fetchIndex = relevant.findIndex((call) => call.method === 'fetch');
    const worktreeIndex = relevant.findIndex((call) => call.method === 'addWorktree');
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(worktreeIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(worktreeIndex);

    await completion;
  });

  it('carries on when the sync could not fast-forward, with the reason on the run', async () => {
    const { workingDir } = await addCloned('web');
    harness.git.fastForwardResult = {
      status: 'unavailable',
      branch: 'main',
      upstream: null,
      from: null,
      to: null,
      detail: 'origin could not be reached',
    };

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    const finished = await completion;

    // A remote being down is not the run's failure — a run that refuses to start over a
    // stale clone is worse than one that says so and carries on.
    expect(finished.status).toBe('passed');
    expect(run.bases[0]?.sync).toBe('unavailable');
    expect(run.bases[0]?.detail).toBeTruthy();
  });

  it('carries on when the fetch itself throws', async () => {
    const { workingDir } = await addCloned('web');
    harness.git.failFetchFor(workingDir);

    harness.llm.replies = ['Done.'];
    // start() itself must not reject — an unreachable remote is a normal state, not an
    // exception a caller has to catch.
    const { completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    const finished = await completion;

    expect(finished.status).toBe('passed');
  });

  it.each(['diverged', 'dirty'] as const)('records a %s base as what it is, and still runs', async (status) => {
    const { workingDir } = await addCloned('web');
    harness.git.fastForwardResult = {
      status,
      branch: 'main',
      upstream: 'origin/main',
      from: 'aaa',
      to: 'aaa',
      detail: `the branch is ${status}`,
    };

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    const finished = await completion;

    expect(finished.status).toBe('passed');
    expect(run.bases[0]?.sync).toBe(status);
  });

  it('never advances a repo linked from the user\'s own disk', async () => {
    const { id: repoId, workingDir } = await addLinked('web');

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });

    // The repo is still isolated into its own worktree (addWorktree runs) — what must never
    // happen for a linked repo is the branch being advanced.
    const advanced = harness.git.ordered.filter(
      (call) => call.dir === workingDir && (call.method === 'fetch' || call.method === 'fastForward'),
    );
    expect(advanced).toHaveLength(0);

    const base = run.bases.find((entry) => entry.repoId === repoId);
    expect(base?.sync).toBe('skipped');
    // Still isolated into its own worktree, so there is still a commit to point at.
    expect(base?.commit).toBeTruthy();

    await completion;
  });

  it('--no-sync skips every repo and says so on the run', async () => {
    const { workingDir } = await addCloned('web');

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({
      projectId: 'acme',
      task: 'Ship it',
      sync: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(run.noSync).toBe(true);
    expect(harness.git.fetched).toHaveLength(0);
    expect(
      harness.git.ordered.some(
        (call) => call.dir === workingDir && (call.method === 'fetch' || call.method === 'fastForward'),
      ),
    ).toBe(false);
    expect(run.bases.every((entry) => entry.sync === 'skipped')).toBe(true);

    await completion;
  });

  it('fetches a repo once per run, no matter how many agents touch it', async () => {
    const { workingDir } = await addCloned('web');
    await harness.workflows.updateAgent('discovery', 'analyst', { tools: { files: true } });

    harness.llm.replies = [
      delegate('look at the first thing'),
      'First thing looked at.',
      delegate('look at the second thing'),
      'Second thing looked at.',
      'Done.',
    ];

    await (await harness.pipelines.start({ projectId: 'acme', task: 'Multi-step change' })).completion;

    const fetches = harness.git.ordered.filter(
      (call) => call.method === 'fetch' && call.dir === workingDir,
    );
    expect(fetches).toHaveLength(1);
  });

  it('keeps bases and noSync when the run is read back from storage', async () => {
    const { id: repoId, workingDir } = await addCloned('web');
    harness.git.trackRepo(workingDir, { branch: 'main', head: 'bbb' });
    harness.git.fastForwardResult = {
      status: 'advanced',
      branch: 'main',
      upstream: 'origin/main',
      from: 'aaa',
      to: 'bbb',
      detail: "'main' advanced to origin/main",
    };

    harness.llm.replies = ['Done.'];
    const { run, completion } = await harness.pipelines.start({ projectId: 'acme', task: 'Ship it' });
    await completion;

    const reloaded = await harness.pipelines.get(run.id);

    expect(reloaded.bases).toEqual(run.bases);
    expect(reloaded.bases[0]).toMatchObject({ repoId, sync: 'advanced', from: 'aaa', to: 'bbb' });
    expect(reloaded.noSync).toBe(run.noSync);
    expect(reloaded.noSync).toBe(false);
  });

  it('reads bases and noSync as empty and false on a run recorded before they existed', () => {
    const parsed = PipelineRunSchema.parse({
      id: 'pre-pomn-70',
      projectId: 'acme',
      workflowId: 'discovery',
      workflowName: 'Discovery',
      providerId: 'claude-code',
      itemId: null,
      task: 'something recorded before this run tracked its base',
      status: 'passed',
      result: 'Done.',
      error: null,
      costUsd: null,
      endedAt: new Date().toISOString(),
      durationMs: 1000,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(parsed.bases).toEqual([]);
    expect(parsed.noSync).toBe(false);
  });
});
