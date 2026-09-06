import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mcpConfig,
  toolGrants,
  type AgentAction,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type LlmToolSpec,
  type ToolGrant,
  type ToolLoopHooks,
} from '@pomni/core';

/**
 * A deliberately empty directory to run text-only sessions in.
 *
 * Claude Code loads `.claude/` settings, hooks and CLAUDE.md from its working directory. Run
 * a generation inside the Pomni repo and the session inherits Pomni's own SessionStart hook
 * and house rules, and answers as a Pomni session instead of doing the job it was given.
 * An empty directory has nothing to inherit.
 */
function sandbox(): string {
  const dir = join(tmpdir(), 'pomni-agent-sandbox');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Editing tools have to be named to be usable.
 *
 * `--allowedTools` pre-approves rather than restricts, and headless Claude Code denies
 * anything that would otherwise prompt. Bash is allowed by default; Write and Edit are not.
 * Leaving these out is what made every Pomni agent silently read-only — it would plan a
 * change, try to apply it, be refused, and report the refusal as its result.
 */
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * The shell, for an agent allowed to run things.
 *
 * Headless Claude Code lets trivial commands through and gates the rest, so an agent could
 * `echo` but not `npm test` — it would write a change, be refused the build, and report the
 * refusal. `run` on an agent means it may run commands; this is what says so.
 */
const SHELL_TOOLS = ['Bash'];

/** Tools a pure-text task has no use for, and which only invite the session to wander. */
const TEXT_ONLY_DISALLOWED = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
];

/**
 * Everything the session may do without being asked, in one list.
 *
 * Order is provider config, then editing, then the agent's granted tools — but nothing here
 * takes anything away: a name missing from this list is not forbidden, it merely has to ask,
 * and in headless mode asking means being refused.
 */
export function sessionPermissions(options: {
  allowedTools?: string[];
  files?: boolean;
  run?: boolean;
  tools?: ToolGrant[];
}): string[] {
  return [
    ...(options.allowedTools ?? []),
    ...(options.files ? FILE_TOOLS : []),
    ...(options.run ? SHELL_TOOLS : []),
    ...toolGrants(options.tools ?? []),
  ];
}

export interface ClaudeCodeOptions {
  /** Working directory for the session. An agent working in a repo wants the repo. */
  cwd?: string;
  /**
   * Every directory the session may touch. A project is several repos, and a change that
   * crosses them cannot be made — or honestly estimated — from inside only one.
   */
  dirs?: string[];
  /** Restrict what the session may do. Empty means Claude Code's own defaults. */
  allowedTools?: string[];
  maxTurns?: number;
  /** Replace Claude Code's system prompt instead of appending to it. */
  replaceSystemPrompt?: boolean;
  /** Tools this agent was granted: MCP servers to load, and binaries it may run. */
  tools?: ToolGrant[];
  /** Whether this agent is allowed to change files, which decides if editing is approved. */
  files?: boolean;
  /** Whether it may run commands — the difference between writing a change and building it. */
  run?: boolean;
  timeoutMs?: number;
}

interface ClaudeResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  stop_reason?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Runs an agent through the local `claude` CLI.
 *
 * Two things make this the most useful backend rather than merely another one. It uses the
 * machine's existing Claude Code authentication, so there is no API key to manage. And the
 * session arrives with file and shell tools already wired to a working directory, so an
 * agent asked to change a repo can actually change it — a plain chat endpoint can only
 * describe the change it would have made.
 *
 * The cost is that the tool loop belongs to Claude Code, not to us: `runWithTools` cannot
 * intercept individual calls. For orchestration, delegation is driven from the outside
 * instead — each delegated agent is its own session.
 */
export class ClaudeCodeLlm implements LlmPort {
  constructor(private readonly options: ClaudeCodeOptions = {}) {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    // Headless Claude Code takes one prompt, not a conversation, so a multi-turn exchange is
    // flattened. The marker matters: without it an orchestrator cannot tell its own earlier
    // replies apart from what was said to it.
    const prompt = request.messages
      .map((message) =>
        message.role === 'user'
          ? message.content
          : `<your-earlier-reply>\n${message.content}\n</your-earlier-reply>`,
      )
      .join('\n\n')
      .trim();

    // Streamed rather than a single blob: the same final result arrives on the last line,
    // and the lines before it are the only account we get of what the session actually did.
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);

    // The system prompt goes via a file and the user prompt via stdin. Neither can be passed
    // as an argument: on Windows the CLI must be launched through a shell to resolve
    // `claude.cmd`, and a shell mangles multi-line arguments — the prompt arrives empty and
    // the session answers as if it had been asked nothing.
    const scratch: string[] = [];
    if (request.system) {
      const file = join(sandbox(), `system-${randomUUID()}.txt`);
      await writeFile(file, request.system, 'utf8');
      scratch.push(file);
      args.push(
        this.options.replaceSystemPrompt ? '--system-prompt-file' : '--append-system-prompt-file',
        file,
      );
    }

    // Granted tools become two things: a config file naming the MCP servers, and permission
    // patterns. `--allowedTools` pre-approves rather than restricts, so appending to it
    // cannot take away the file and shell access an agent already had.
    const granted = this.options.tools ?? [];
    const permissions = sessionPermissions(this.options);

    if (granted.some((grant) => grant.tool.kind === 'mcp')) {
      const file = join(sandbox(), `mcp-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(mcpConfig(granted), null, 2), 'utf8');
      scratch.push(file);
      // Only the servers Pomni granted: the machine's own MCP config is not this agent's.
      args.push('--mcp-config', file, '--strict-mcp-config');
    }

    if (permissions.length > 0) {
      args.push('--allowedTools', ...permissions);
    }
    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));

    // The working directory is allowed implicitly; every other repo has to be named, or the
    // session refuses to so much as list it.
    const extra = (this.options.dirs ?? []).filter((dir) => dir && dir !== this.options.cwd);
    if (extra.length > 0) args.push('--add-dir', ...extra);

    // No working directory means there is nothing to read or change, so keep the session
    // purely generative rather than letting it explore the sandbox.
    if (!this.options.cwd) args.push('--disallowedTools', ...TEXT_ONLY_DISALLOWED);

    try {
      const raw = await this.run(args, request.signal, undefined, prompt);
      const { result: parsed, actions } = readStream(raw);

      if (parsed.is_error) {
        throw new Error(parsed.result?.trim() || 'the Claude Code session reported an error');
      }

      return {
        actions,
        text: (parsed.result ?? '').trim(),
        stopReason: parsed.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        },
        turns: parsed.num_turns ?? 1,
        // The CLI hands us the cost on every result frame; it used to land nowhere.
        costUsd: parsed.total_cost_usd,
      };
    } finally {
      for (const file of scratch) await rm(file, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Claude Code owns its own tool loop, so there is nothing to intercept here. The tools are
   * declared in the prompt and the session is asked to report what it decided; the caller
   * drives delegation itself.
   */
  async runWithTools(
    request: LlmRequest & { tools: LlmToolSpec[] },
    hooks: ToolLoopHooks,
  ): Promise<LlmResult> {
    const described = request.tools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    const result = await this.complete({
      ...request,
      system: [
        request.system ?? '',
        '',
        'Available delegates (you cannot call these directly; describe what you want and it will be run):',
        described,
      ]
        .join('\n')
        .trim(),
    });

    hooks.onText?.(result.text);
    return result;
  }

  async isConfigured(): Promise<boolean> {
    try {
      const raw = await this.run(['--version'], undefined, 30_000);
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }

  async describeAuth(): Promise<string> {
    try {
      const version = (await this.run(['--version'], undefined, 30_000)).trim();
      return `the local Claude Code CLI (${version}), using its own login`;
    } catch {
      return "the `claude` CLI is not on PATH — install Claude Code, or use a different provider";
    }
  }

  private run(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
    stdin?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn('claude', args, {
        // Never the process's own cwd: that would be the Pomni repo, whose hooks and
        // CLAUDE.md would be loaded into a session that has nothing to do with them.
        cwd: this.options.cwd ?? sandbox(),
        windowsHide: true,
        // `shell` is needed on Windows to resolve `claude.cmd` from PATH.
        shell: process.platform === 'win32',
        env: { ...process.env, CLAUDE_CODE_NON_INTERACTIVE: '1' },
      });

      // Anything not passed as a flag goes in here; nothing gets shell-quoted.
      if (stdin !== undefined) {
        child.stdin.write(stdin);
      }
      child.stdin.end();

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? '');
      };

      const timer = setTimeout(
        () => {
          child.kill();
          finish(new Error(`the Claude Code session timed out after ${timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        },
        timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );

      const onAbort = () => {
        child.kill();
        finish(new Error('the run was cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        finish(
          new Error(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'the `claude` CLI is not on PATH'
              : error.message,
          ),
        );
      });

      child.on('close', (code) => {
        if (code === 0) finish(null, stdout);
        else {
          // stderr is often empty when the CLI gives up, and the last thing it managed to
          // say on stdout is then the only clue there is. Losing it costs another run.
          const said = firstUseful(stderr) || lastFrameError(stdout);
          finish(new Error(said ? `claude: ${said}` : `claude exited with code ${code}`));
        }
      });
    });
  }
}

/**
 * Read a streamed session: the final result, and everything it did to get there.
 *
 * Each line is its own JSON object. Anything unparseable is skipped rather than thrown on —
 * a malformed frame should cost us one action in a log, not the whole answer.
 */
export function readStream(raw: string): { result: ClaudeResult; actions: AgentAction[] } {
  const actions: AgentAction[] = [];
  let result: ClaudeResult | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let frame: StreamFrame;
    try {
      frame = JSON.parse(trimmed) as StreamFrame;
    } catch {
      continue;
    }

    if (frame.type === 'result') result = frame as ClaudeResult;

    for (const block of frame.message?.content ?? []) {
      if (block.type === 'tool_use' && block.name) {
        actions.push({ tool: block.name, detail: describeCall(block.name, block.input ?? {}) });
      }
    }
  }

  // No result line at all: the CLI printed something else, which is still an answer.
  return { result: result ?? parse(raw), actions };
}

/** The part of a tool call worth reading back later. */
function describeCall(tool: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  const detail = pick(
    'command',
    'skill',
    'file_path',
    'pattern',
    'url',
    'prompt',
    'description',
    'query',
  );
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

interface StreamFrame {
  type?: string;
  message?: {
    content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

function parse(raw: string): ClaudeResult {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as ClaudeResult;
  } catch {
    // Not JSON: the CLI printed plain text, which is still a usable answer.
    return { type: 'result', result: trimmed };
  }
}

/** Whatever the last readable frame said, for when the CLI exits without explaining. */
function lastFrameError(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));

  for (const line of lines.reverse()) {
    try {
      const frame = JSON.parse(line) as { result?: string; error?: string; subtype?: string };
      const said = frame.error ?? frame.result ?? frame.subtype;
      if (typeof said === 'string' && said.trim()) return said.trim().slice(0, 300);
    } catch {
      continue;
    }
  }
  return '';
}

function firstUseful(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop() ?? ''
  );
}
