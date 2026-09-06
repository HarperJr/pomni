import type {
  LlmPort,
  LlmRequest,
  LlmResult,
  LlmToolSpec,
  LlmUsage,
  ToolLoopHooks,
} from '@pomni/core';

export interface OpenAiCompatibleOptions {
  /** Includes the version path, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Resolved key, or undefined for endpoints that need none (Ollama, LM Studio). */
  apiKey?: string;
  label?: string;
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: ChatMessage;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 40;

/**
 * Any endpoint speaking the OpenAI chat-completions shape.
 *
 * That covers OpenAI, Ollama, LM Studio, vLLM, OpenRouter and LiteLLM — they differ only in
 * base url, whether a key is needed, and what the models are called. One adapter rather than
 * four, because the differences are configuration, not behaviour.
 *
 * Written against the wire format with `fetch` rather than a vendor SDK: the point is to
 * reach endpoints that are merely OpenAI-*compatible*, and a vendor SDK tends to assume it
 * is talking to that vendor.
 */
export class OpenAiCompatibleLlm implements LlmPort {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    const response = await this.chat({
      model: request.model,
      messages: this.toMessages(request),
      max_tokens: request.maxTokens ?? 16_000,
      signal: request.signal,
    });

    const message = response.choices?.[0]?.message;
    return {
      text: (message?.content ?? '').trim(),
      stopReason: response.choices?.[0]?.finish_reason ?? 'stop',
      usage: usageOf(response),
      turns: 1,
    };
  }

  async runWithTools(
    request: LlmRequest & { tools: LlmToolSpec[]; maxTurns?: number },
    hooks: ToolLoopHooks,
  ): Promise<LlmResult> {
    const messages = this.toMessages(request);
    const tools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const total: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;

    let turns = 0;
    let lastText = '';
    let finish = 'stop';

    while (turns < maxTurns) {
      turns += 1;

      const response = await this.chat({
        model: request.model,
        messages,
        tools,
        max_tokens: request.maxTokens ?? 16_000,
        signal: request.signal,
      });

      add(total, usageOf(response));

      const choice = response.choices?.[0];
      const message = choice?.message;
      finish = choice?.finish_reason ?? 'stop';

      if (message?.content) {
        lastText = message.content.trim();
        hooks.onText?.(lastText);
      }

      const calls = message?.tool_calls ?? [];
      if (calls.length === 0) break;

      messages.push({
        role: 'assistant',
        content: message?.content ?? null,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (hooks.shouldStop?.()) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'The run was stopped before this could be delegated.',
          });
          continue;
        }

        let output: string;
        try {
          output = await hooks.onTool({
            id: call.id,
            name: call.function.name,
            // Arguments arrive as a JSON string here, unlike Anthropic's parsed object.
            input: safeParse(call.function.arguments),
          });
        } catch (error) {
          output = error instanceof Error ? error.message : String(error);
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }

      if (hooks.shouldStop?.()) {
        finish = 'stopped';
        break;
      }
    }

    if (turns >= maxTurns && finish === 'tool_calls') finish = 'max_turns';
    return { text: lastText, stopReason: finish, usage: total, turns };
  }

  async isConfigured(): Promise<boolean> {
    try {
      const response = await fetch(`${this.trimmedBase()}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      // 401 still proves the endpoint is there; it is the key that is wrong.
      return response.ok || response.status === 401;
    } catch {
      return false;
    }
  }

  async describeAuth(): Promise<string> {
    const label = this.options.label ?? this.options.baseUrl;
    if (await this.isConfigured()) {
      return this.options.apiKey ? `${label}, with a key` : `${label}, no key needed`;
    }
    return `${label} did not respond — check it is running and the base url is right`;
  }

  /** Models the endpoint reports. Useful for a local server whose names you do not know. */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.trimmedBase()}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return [];

      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => Boolean(id))
        .sort();
    } catch {
      return [];
    }
  }

  private toMessages(request: LlmRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const message of request.messages) {
      messages.push({ role: message.role, content: message.content });
    }
    return messages;
  }

  private async chat(body: {
    model: string;
    messages: ChatMessage[];
    tools?: unknown[];
    max_tokens: number;
    signal?: AbortSignal;
  }): Promise<ChatResponse> {
    const { signal, ...payload } = body;

    const response = await fetch(`${this.trimmedBase()}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(explain(response.status, text, this.options.label ?? this.options.baseUrl));
    }

    const parsed = JSON.parse(text) as ChatResponse;
    if (parsed.error) throw new Error(parsed.error.message ?? 'the endpoint returned an error');
    return parsed;
  }

  private headers(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }

  private trimmedBase(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }
}

function usageOf(response: ChatResponse): LlmUsage {
  return {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
  };
}

function add(total: LlmUsage, next: LlmUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cacheReadTokens += next.cacheReadTokens;
  total.cacheCreationTokens += next.cacheCreationTokens;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function explain(status: number, body: string, label: string): string {
  const detail = extractMessage(body);
  if (status === 401 || status === 403) {
    return `${label} rejected the credentials${detail ? `: ${detail}` : ''}`;
  }
  if (status === 404) {
    return `${label} has no such model or endpoint${detail ? `: ${detail}` : ''}`;
  }
  if (status === 429) return `${label} rate limited the request`;
  return `${label} returned ${status}${detail ? `: ${detail}` : ''}`;
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? '';
  } catch {
    return body.slice(0, 200);
  }
}
