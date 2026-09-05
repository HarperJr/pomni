import { z } from 'zod';
import { STRUGGLE_LEVELS, type Struggle } from './agent.js';
import { ValidationError } from './errors.js';

/**
 * Where the model actually runs.
 *
 * An agent declares a model *scale* — fast, balanced, deep, max — never a model id. The
 * provider decides what each scale means. That indirection is what lets the same workflow
 * run on Claude Code, on an API key, or against a model on localhost, and it is why the
 * scales were named by intent in the first place.
 */

export const ProviderKindSchema = z.enum([
  /** The local `claude` CLI. Uses the machine's existing Claude Code auth, and brings its
   *  own file and shell tools, so an agent can actually work in a repo. */
  'claude-code',
  /** The Anthropic Messages API, via an API key. Text in, text out. */
  'anthropic',
  /** Anything speaking the OpenAI chat-completions shape: OpenAI itself, Ollama, LM Studio,
   *  vLLM, OpenRouter, LiteLLM. Distinguished only by base url and model names. */
  'openai',
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * Which model each struggle level runs on. Missing levels fall back to the nearest one that
 * is set, so a provider configured with a single model still runs every agent.
 *
 * The `fast`/`balanced`/`deep` keys are what the levels used to be called; they are read for
 * backwards compatibility and never written.
 */
export const ModelMapSchema = z.object({
  low: z.string().optional(),
  medium: z.string().optional(),
  high: z.string().optional(),
  max: z.string().optional(),
  fast: z.string().optional(),
  balanced: z.string().optional(),
  deep: z.string().optional(),
});
export type ModelMap = z.infer<typeof ModelMapSchema>;

const LEGACY_KEY: Record<Struggle, keyof ModelMap> = {
  low: 'fast',
  medium: 'balanced',
  high: 'deep',
  max: 'max',
};

export const ProviderSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  kind: ProviderKindSchema,
  /** OpenAI-compatible endpoints only. Include the version path, e.g. `/v1`. */
  baseUrl: z.string().optional(),
  /** Name of the env var holding the key. Never the key itself. */
  apiKeyEnv: z.string().optional(),
  models: ModelMapSchema.default({}),
  /**
   * claude-code only: tools the agent may use. Empty means Claude Code's defaults, which
   * include reading and editing files and running commands.
   */
  allowedTools: z.array(z.string()).default([]),
  /** claude-code only: cap the agentic loop. */
  maxTurns: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
});

export type Provider = z.infer<typeof ProviderSchema>;

export const ProvidersFileSchema = z.object({
  version: z.literal(1).default(1),
  /** Provider used when an agent or workflow does not name one. */
  default: z.string().nullable().default(null),
  providers: z.array(ProviderSchema).default([]),
});
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

/** Reported to the UI: config plus whether it can actually be used right now. */
export interface ProviderStatus extends Provider {
  available: boolean;
  detail: string;
}

/**
 * The model id for a scale on a given provider.
 *
 * Falls back to the nearest configured scale rather than failing: a local setup with one
 * model should still run every agent, just without the gradation.
 */
export function resolveModel(provider: Provider, struggle: Struggle): string {
  const at = (level: Struggle): string | undefined =>
    provider.models[level] ?? provider.models[LEGACY_KEY[level]];

  const exact = at(struggle);
  if (exact) return exact;

  // Nearest configured level, searching outwards, so one model covers everything.
  const index = STRUGGLE_LEVELS.indexOf(struggle);
  for (let distance = 1; distance < STRUGGLE_LEVELS.length; distance += 1) {
    for (const candidate of [
      STRUGGLE_LEVELS[index - distance],
      STRUGGLE_LEVELS[index + distance],
    ]) {
      const model = candidate ? at(candidate) : undefined;
      if (model) return model;
    }
  }

  throw new ValidationError(
    `provider '${provider.id}' has no model set for any level — map at least one on the Providers page`,
  );
}

/** The defaults a fresh workspace gets: whatever this machine can already do. */
export function builtinProviders(now: string): Provider[] {
  return [
    ProviderSchema.parse({
      id: 'claude-code',
      label: 'Claude Code (local CLI)',
      kind: 'claude-code',
      models: {
        low: 'claude-haiku-4-5',
        medium: 'claude-sonnet-5',
        high: 'claude-opus-5',
        max: 'claude-fable-5-1',
      },
      createdAt: now,
    }),
    ProviderSchema.parse({
      id: 'anthropic',
      label: 'Anthropic API',
      kind: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: {
        low: 'claude-haiku-4-5',
        medium: 'claude-sonnet-5',
        high: 'claude-opus-5',
        max: 'claude-fable-5-1',
      },
      createdAt: now,
    }),
  ];
}

/** Ready-made shapes for the common third-party and local endpoints. */
export const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: ModelMap;
  note: string;
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: { low: 'gpt-4o-mini', medium: 'gpt-4o', high: 'gpt-4o', max: 'gpt-4o' },
    note: 'Set OPENAI_API_KEY, then adjust the model per scale.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: {
      low: 'llama3.2',
      medium: 'qwen2.5-coder:14b',
      high: 'qwen2.5-coder:32b',
    },
    note: 'No key needed. Models must already be pulled — run `ollama list` to see them.',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    models: { medium: 'local-model' },
    note: 'Start the LM Studio server first; the model name is whatever it reports.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: {
      low: 'anthropic/claude-haiku-4.5',
      medium: 'anthropic/claude-sonnet-5',
      high: 'anthropic/claude-opus-5',
    },
    note: 'One key, many vendors. Model ids are namespaced by vendor.',
  },
];

/**
 * Whether this provider can run an agent that needs to read or change files.
 *
 * Only Claude Code brings its own tools. A plain chat endpoint can reason and write text,
 * but it cannot open a file — so a workflow whose agents touch a repo needs to say so
 * rather than silently producing prose where a diff was expected.
 */
export function hasBuiltInTools(provider: Provider): boolean {
  return provider.kind === 'claude-code';
}
