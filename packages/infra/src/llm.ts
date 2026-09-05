import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmPort,
  LlmRequest,
  LlmResult,
  LlmToolSpec,
  LlmUsage,
  ToolLoopHooks,
} from '@pomni/core';

const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_MAX_TURNS = 40;

/**
 * Anthropic Messages API.
 *
 * The tool loop is written by hand rather than using the SDK's beta tool runner: every tool
 * call here is an agent delegation that has to be reported as it happens, and owning the
 * loop keeps that reporting exact without depending on a beta surface.
 */
export class AnthropicLlm implements LlmPort {
  private client: Anthropic | null = null;

  /**
   * Constructed lazily. The SDK resolves credentials from `ANTHROPIC_API_KEY`,
   * `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile — an unset env var does not mean
   * there are none, so never demand a key up front.
   */
  private get anthropic(): Anthropic {
    this.client ??= new Anthropic();
    return this.client;
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const response = await this.anthropic.messages.create(
      {
        ...this.baseParams(request),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    return {
      text: textOf(response.content),
      stopReason: response.stop_reason ?? 'end_turn',
      usage: usageOf(response.usage),
      turns: 1,
    };
  }

  async runWithTools(
    request: LlmRequest & { tools: LlmToolSpec[]; maxTurns?: number },
    hooks: ToolLoopHooks,
  ): Promise<LlmResult> {
    const messages: Anthropic.MessageParam[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const tools: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const total: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;

    let turns = 0;
    let lastText = '';
    let stopReason = 'end_turn';

    while (turns < maxTurns) {
      turns += 1;

      const response = await this.anthropic.messages.create(
        { ...this.baseParams(request), messages, tools },
        request.signal ? { signal: request.signal } : undefined,
      );

      add(total, usageOf(response.usage));
      stopReason = response.stop_reason ?? 'end_turn';

      const said = textOf(response.content);
      if (said) {
        lastText = said;
        hooks.onText?.(said);
      }

      // A refusal is a real outcome on current models, not an exception. Stop and say so
      // rather than looping into it again.
      if (stopReason === 'refusal') break;
      if (stopReason !== 'tool_use') break;

      // Append the whole content — thinking blocks included, unchanged. Stripping them
      // breaks continuation on the same model.
      messages.push({ role: 'assistant', content: response.content });

      const calls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      // Every tool_result for a turn goes back in ONE user message. Splitting them across
      // messages quietly teaches the model to stop making parallel calls.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        if (hooks.shouldStop?.()) {
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: 'The run was stopped before this could be delegated.',
            is_error: true,
          });
          continue;
        }

        try {
          const output = await hooks.onTool({
            id: call.id,
            name: call.name,
            input: (call.input ?? {}) as Record<string, unknown>,
          });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
        } catch (error) {
          // Hand the failure back rather than throwing: the orchestrator can often route
          // around one agent failing, and it should get the chance.
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: error instanceof Error ? error.message : String(error),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: results });

      if (hooks.shouldStop?.()) {
        stopReason = 'stopped';
        break;
      }
    }

    if (turns >= maxTurns && stopReason === 'tool_use') stopReason = 'max_turns';

    return { text: lastText, stopReason, usage: total, turns };
  }

  async isConfigured(): Promise<boolean> {
    try {
      // Cheapest possible proof that credentials resolve and the model id is real.
      await this.anthropic.models.retrieve('claude-haiku-4-5');
      return true;
    } catch {
      return false;
    }
  }

  async describeAuth(): Promise<string> {
    if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
    if (process.env.ANTHROPIC_AUTH_TOKEN) return 'ANTHROPIC_AUTH_TOKEN';
    return (await this.isConfigured())
      ? 'an ant auth profile'
      : "no credentials — set ANTHROPIC_API_KEY, or run 'ant auth login'";
  }

  private baseParams(request: LlmRequest): {
    model: string;
    max_tokens: number;
    system?: string;
    thinking?: { type: 'adaptive' };
    output_config?: { effort: NonNullable<LlmRequest['effort']> };
  } {
    return {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.system ? { system: request.system } : {}),
      // Adaptive thinking is the current shape; `budget_tokens` is rejected on these models.
      // Haiku does not take it at all, hence the flag from the caller.
      ...(request.adaptiveThinking ? { thinking: { type: 'adaptive' as const } } : {}),
      ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    };
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function usageOf(usage: Anthropic.Usage): LlmUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function add(total: LlmUsage, next: LlmUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cacheReadTokens += next.cacheReadTokens;
}

/** Turn an SDK error into something a user can act on. */
export function explainLlmError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "the Anthropic credentials were rejected — check ANTHROPIC_API_KEY, or run 'ant auth login'";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'rate limited by the Anthropic API — wait a moment and run it again';
  }
  if (error instanceof Anthropic.NotFoundError) {
    return 'the model id was not found — the workflow may reference a model your account cannot use';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `the request was rejected: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'could not reach the Anthropic API — check your network';
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
