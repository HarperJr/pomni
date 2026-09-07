import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpConfig, toolBriefing, toolGrants } from '@pomni/core';
import { quoteForShell, readStream, sessionPermissions, spawnArgs } from '@pomni/infra';
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
      { tool: 'Bash', detail: 'npm run typecheck', outcome: 'ok' },
      { tool: 'Skill', detail: 'code-review', outcome: 'ok' },
      { tool: 'Edit', detail: 'a/b.ts', outcome: 'ok' },
    ]);
  });

  it('records a command the permission layer turned away', () => {
    const raw = [
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm run typecheck' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              is_error: true,
              content: 'Claude requested permissions to use Bash, but you have not granted it yet.',
            },
          ],
        },
      }),
      line({ type: 'result', result: 'I could not build it.' }),
    ].join('\n');

    const [action] = readStream(raw).actions;

    expect(action?.outcome).toBe('refused');
    expect(action?.note).toContain('permissions');
  });

  it('tells a failing command apart from a refused one', () => {
    const raw = [
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'c', is_error: true, content: '3 tests failed' },
          ],
        },
      }),
    ].join('\n');

    // A failing build is the answer the agent went looking for; only the permission layer
    // saying no means it never got to ask.
    expect(readStream(raw).actions[0]?.outcome).toBe('failed');
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
  it('turns the repos own checks into exact permissions, for every shell it has', () => {
    // Windows hands the session a PowerShell tool as well; an agent refused on Bash simply
    // tries the other one, and used to be refused there for a reason nobody had told it.
    expect(verifyGrants(['npm run typecheck', 'npm test'])).toEqual([
      'Bash(npm run typecheck)',
      'PowerShell(npm run typecheck)',
      'Bash(npm test)',
      'PowerShell(npm test)',
    ]);
  });

  it('says nothing when a repo declares nothing', () => {
    expect(verifyGrants([])).toEqual([]);
    expect(sessionPermissions({ verify: [] })).toEqual([]);
  });

  it('grants the checks and no shell', () => {
    const permissions = sessionPermissions({ verify: ['npm test'] });

    expect(permissions).toEqual(['Bash(npm test)', 'PowerShell(npm test)']);
    expect(permissions).not.toContain('Bash');
    expect(permissions).not.toContain('PowerShell');
  });

  it('does not repeat them for an agent that already has a shell', () => {
    const permissions = sessionPermissions({ run: true, verify: ['npm test'] });

    expect(permissions).toEqual(['Bash', 'PowerShell']);
  });
});

describe('handing arguments to the CLI', () => {
  // The bug this covers cost every verify-only agent its checks: `shell: true` is needed on
  // Windows to resolve `claude.cmd`, Node does not quote when a shell is used, and
  // `Bash(npm run typecheck)` arrived as three arguments. The permission was never granted,
  // and the only sign of it was an agent reporting that it had been refused.
  const awkward = [
    'Bash(npm run typecheck)',
    'PowerShell(npm run test)',
    'Write',
    'mcp__pomni__*',
    'C:/a path/with spaces/repo',
    'node -e "console.log(1)"',
  ];

  it('gives back exactly the arguments it was given, through a real spawn', () => {
    const probe = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const result = spawnSync('node', spawnArgs(['-e', probe, ...awkward]), {
      shell: process.platform === 'win32',
      encoding: 'utf8',
    });

    expect(JSON.parse(result.stdout.trim())).toEqual(awkward);
  });

  it('leaves a plain value alone, so the command line stays readable', () => {
    expect(quoteForShell('--allowedTools')).toBe('--allowedTools');
    expect(quoteForShell('Write')).toBe('Write');
    // A glob is wrapped rather than trusted: cmd does not expand it, but nothing here should
    // depend on which shell is on the other side.
    expect(quoteForShell('mcp__pomni__*')).toBe('"mcp__pomni__*"');
  });

  it('quotes anything a shell would split or read as syntax', () => {
    expect(quoteForShell('Bash(npm run test)')).toBe('"Bash(npm run test)"');
    expect(quoteForShell('')).toBe('""');
  });

  it('passes argv straight through where no shell is involved', () => {
    expect(spawnArgs(awkward, 'linux')).toEqual(awkward);
  });
});
