import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpConfig, toolBriefing, toolGrants } from '@pomni/core';
import { readStream, sessionPermissions } from '@pomni/infra';
import { verifyGrants } from '@pomni/core';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme' });
});

afterEach(async () => {
  await harness.cleanup();
});

async function addFigmaCli(): Promise<void> {
  await harness.tools.create({
    name: 'Figma CLI',
    id: 'figma-cli',
    kind: 'cli',
    bin: 'figma-cli',
    description: 'Drives Figma Desktop.',
    check: 'figma-cli status',
  });
}

describe('the tool registry', () => {
  it('reports a half-configured tool as broken instead of refusing to list it', async () => {
    await harness.tools.create({ name: 'Nameless', id: 'broken', kind: 'cli' });

    const [tool] = await harness.tools.list();
    expect(tool?.usable).toBe(false);
    expect(tool?.problems[0]).toContain('no binary');
  });

  it('needs both gates before an agent can be given a tool', async () => {
    await addFigmaCli();

    // Registered, but this project was never given it.
    await expect(harness.tools.grantsFor('acme', ['figma-cli'])).rejects.toThrow(/not attached/);

    await harness.tools.attach('acme', 'figma-cli');
    const grants = await harness.tools.grantsFor('acme', ['figma-cli']);
    expect(grants).toHaveLength(1);
  });

  it('says so when the tool does not exist at all', async () => {
    await expect(harness.tools.grantsFor('acme', ['nope'])).rejects.toThrow(/no tool 'nope'/);
  });

  it('detaches a removed tool from every project', async () => {
    await addFigmaCli();
    await harness.tools.attach('acme', 'figma-cli');

    await harness.tools.remove('figma-cli');

    const project = await harness.projects.getRef('acme');
    expect(project.data.tools).toEqual([]);
  });

  it('runs the check command and reports what it said', async () => {
    await addFigmaCli();
    harness.executor.script = [
      { match: /figma-cli status/, exitCode: 1, output: 'daemon is not running\n' },
    ];

    const [result] = await harness.tools.check(['figma-cli']);
    expect(result?.status).toBe('failed');
    expect(result?.detail).toBe('daemon is not running');
  });
});

describe('what a granted tool becomes', () => {
  it('turns an mcp tool into a config entry and a permission', () => {
    const tool = {
      id: 'figma',
      name: 'Figma',
      kind: 'mcp' as const,
      transport: 'http' as const,
      url: 'https://mcp.figma.com/mcp',
      credentialEnv: 'Authorization',
      headers: {},
      args: [],
      env: {},
      envFrom: [],
      description: '',
      usage: '',
      bin: null,
      command: null,
      credential: 'figma-token',
      check: null,
      enabled: true,
      createdAt: '',
      updatedAt: '',
    };
    const grants = [{ tool, secret: 'Bearer s3cret' }];

    expect(toolGrants(grants)).toEqual(['mcp__figma__*']);
    // The secret rides in the header, and only in the generated config.
    expect(mcpConfig(grants).mcpServers.figma).toEqual({
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
      headers: { Authorization: 'Bearer s3cret' },
    });
  });

  it('turns a cli tool into a bash permission scoped to its binary', async () => {
    await addFigmaCli();
    await harness.tools.attach('acme', 'figma-cli');

    const grants = await harness.tools.grantsFor('acme', ['figma-cli']);
    expect(toolGrants(grants)).toEqual(['Bash(figma-cli:*)']);
    expect(mcpConfig(grants).mcpServers).toEqual({});
  });

  it('tells the agent the tool exists', async () => {
    await addFigmaCli();
    await harness.tools.attach('acme', 'figma-cli');

    const briefing = toolBriefing(await harness.tools.grantsFor('acme', ['figma-cli']));
    expect(briefing).toContain('Figma CLI');
    expect(briefing).toContain('Drives Figma Desktop.');
    expect(briefing).toContain('figma-cli');
  });

  it('has nothing to say when an agent was granted nothing', () => {
    expect(toolBriefing([])).toBeNull();
  });
});

describe('a run with tools', () => {
  beforeEach(async () => {
    await harness.workflows.create({ name: 'Design' });
    // An orchestrator, because a workflow needs one to be runnable — and a lead that drives
    // Figma itself is the shape this feature exists for.
    await harness.workflows.addAgent('design', {
      name: 'Designer',
      role: 'orchestrator',
      spec: 'Designs.',
      prompt: 'You design.',
      tools: { run: true, cli: ['figma-cli'] },
    });
    // An orchestrator must have someone to delegate to, even when this run never does.
    await harness.workflows.addAgent('design', {
      name: 'Reviewer',
      spec: 'Reviews.',
      prompt: 'You review.',
    });
    await harness.workflows.attach('acme', 'design');
  });

  it('hands the grant to the session and puts it in the prompt', async () => {
    await addFigmaCli();
    await harness.tools.attach('acme', 'figma-cli');
    harness.llm.replies = ['Designed it.'];

    await (await harness.pipelines.start({ projectId: 'acme', task: 'Make a screen' }))
      .completion;

    expect(harness.llmFactory.lastOptions.tools?.[0]?.tool.id).toBe('figma-cli');
    expect(harness.llm.calls[0]?.system).toContain('## Tools you have');
    expect(harness.llm.calls[0]?.system).toContain('figma-cli');
  });

  it('fails the run before spending anything when the tool is not attached', async () => {
    await addFigmaCli();
    harness.llm.replies = ['Designed it.'];

    const run = await (
      await harness.pipelines.start({ projectId: 'acme', task: 'Make a screen' })
    ).completion;

    expect(run.status).toBe('failed');
    expect(run.error).toContain('not attached');
    expect(harness.llm.calls).toHaveLength(0);
  });
});

describe('what a session is permitted', () => {
  // Headless Claude Code denies anything that would prompt, and Write prompts. An agent
  // allowed to change files but not given the name ends up read-only: it plans the change,
  // is refused, and reports the refusal as its answer.
  it('approves editing only for an agent allowed to change files', () => {
    expect(sessionPermissions({ files: true })).toEqual([
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
    ]);
    expect(sessionPermissions({ files: false })).toEqual([]);
  });

  it('keeps the provider list, and adds rather than replaces', () => {
    const permissions = sessionPermissions({
      allowedTools: ['Bash(git *)'],
      files: true,
      tools: [{ tool: { kind: 'cli', bin: 'figma-cli' } as never, secret: null }],
    });

    expect(permissions[0]).toBe('Bash(git *)');
    expect(permissions).toContain('Write');
    expect(permissions).toContain('Bash(figma-cli:*)');
  });
});

describe('reading a streamed session', () => {
  const line = (frame: unknown) => JSON.stringify(frame);

  it('keeps the answer and everything the session did to reach it', () => {
    const raw = [
      line({ type: 'system', subtype: 'init' }),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'npm run typecheck' } },
            { type: 'tool_use', name: 'Skill', input: { skill: 'code-review' } },
          ],
        },
      }),
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a/b.ts' } }] },
      }),
      line({ type: 'result', subtype: 'success', result: 'Finished.', num_turns: 3 }),
    ].join('\n');

    const { result, actions } = readStream(raw);

    expect(result.result).toBe('Finished.');
    expect(actions).toEqual([
      { tool: 'Bash', detail: 'npm run typecheck' },
      { tool: 'Skill', detail: 'code-review' },
      { tool: 'Edit', detail: 'a/b.ts' },
    ]);
  });

  it('loses one frame, not the answer, when a line is malformed', () => {
    const raw = ['{ not json', line({ type: 'result', result: 'Still fine.' })].join('\n');
    expect(readStream(raw).result.result).toBe('Still fine.');
  });

  it('falls back when the session printed no result line', () => {
    expect(readStream('just some text').result.result).toBe('just some text');
  });
});

describe('verifying without a shell', () => {
  it('turns the repos own checks into exact permissions', () => {
    expect(verifyGrants(['npm run typecheck', 'npm test'])).toEqual([
      'Bash(npm run typecheck)',
      'Bash(npm test)',
    ]);
  });

  it('says nothing when a repo declares nothing', () => {
    expect(verifyGrants([])).toEqual([]);
    expect(sessionPermissions({ verify: [] })).toEqual([]);
  });

  it('grants the checks and no shell', () => {
    const permissions = sessionPermissions({ verify: ['npm test'] });

    expect(permissions).toEqual(['Bash(npm test)']);
    expect(permissions).not.toContain('Bash');
  });

  it('does not repeat them for an agent that already has a shell', () => {
    const permissions = sessionPermissions({ run: true, verify: ['npm test'] });

    expect(permissions).toEqual(['Bash']);
  });
});
