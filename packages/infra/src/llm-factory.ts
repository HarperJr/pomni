import {
  hasBuiltInTools,
  type LlmFactory,
  type LlmPort,
  type Provider,
} from '@pomni/core';
import { AnthropicLlm } from './llm.js';
import { ClaudeCodeLlm } from './claude-code-llm.js';
import { OpenAiCompatibleLlm } from './openai-llm.js';

/**
 * Turns a provider record into something that can run a model.
 *
 * The composition point for the three backends: the local Claude Code CLI, the Anthropic
 * API, and anything speaking the OpenAI chat shape. Adding a fourth means adding a case
 * here and a kind to the schema — nothing above this line changes.
 */
export class DefaultLlmFactory implements LlmFactory {
  create(provider: Provider, options: { cwd?: string } = {}): LlmPort {
    switch (provider.kind) {
      case 'claude-code':
        return new ClaudeCodeLlm({
          cwd: options.cwd,
          allowedTools: provider.allowedTools,
          maxTurns: provider.maxTurns,
          // With no repo to work in there is nothing for the built-in tools to do, so the
          // agent's own prompt replaces Claude Code's rather than being appended to it.
          replaceSystemPrompt: !options.cwd,
        });

      case 'anthropic':
        return new AnthropicLlm();

      case 'openai':
        return new OpenAiCompatibleLlm({
          baseUrl: provider.baseUrl ?? '',
          apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined,
          label: provider.label,
        });
    }
  }

  /** Whether agents on this provider can read and change files. */
  toolsAvailable(provider: Provider): boolean {
    return hasBuiltInTools(provider);
  }
}
