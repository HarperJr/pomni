import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmPort, LlmRequest, LlmResult, LlmToolSpec, ToolLoopHooks } from '@pomni/core';

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

export interface ClaudeCodeOptions {
  /** Working directory for the session. An agent working in a repo wants the repo. */
  cwd?: string;
  /** Restrict what the session may do. Empty means Claude Code's own defaults. */
  allowedTools?: string[];
  maxTurns?: number;
  /** Replace Claude Code's system prompt instead of appending to it. */
  replaceSystemPrompt?: boolean;
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
    const prompt = request.messages
      .map((message) => (message.role === 'user' ? message.content : `\n${message.content}\n`))
      .join('\n')
      .trim();

    const args = ['-p', '--output-format', 'json'];
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

    if (this.options.allowedTools?.length) {
      args.push('--allowedTools', ...this.options.allowedTools);
    }
    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));

    // No working directory means there is nothing to read or change, so keep the session
    // purely generative rather than letting it explore the sandbox.
    if (!this.options.cwd) args.push('--disallowedTools', ...TEXT_ONLY_DISALLOWED);

    try {
      const raw = await this.run(args, request.signal, undefined, prompt);
      const parsed = parse(raw);

      if (parsed.is_error) {
        throw new Error(parsed.result?.trim() || 'the Claude Code session reported an error');
      }

      return {
        text: (parsed.result ?? '').trim(),
        stopReason: parsed.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
        },
        turns: parsed.num_turns ?? 1,
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
        else finish(new Error(firstUseful(stderr) || `claude exited with code ${code}`));
      });
    });
  }
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

function firstUseful(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop() ?? ''
  );
}
