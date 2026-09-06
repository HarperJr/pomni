import { z } from 'zod';
import type { Struggle } from '../domain/agent.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { assertSlug, deriveId } from '../domain/ids.js';
import { layout } from '../domain/layout.js';
import {
  ProviderSchema,
  ProvidersFileSchema,
  builtinProviders,
  hasBuiltInTools,
  resolveModel,
  type Provider,
  type ProviderKind,
  type ProviderStatus,
} from '../domain/provider.js';
import type { ToolGrant } from '../domain/tool.js';
import type { Clock, DocStore, EventBus, LlmPort } from '../ports/index.js';

export interface CreateProviderInput {
  label: string;
  kind: ProviderKind;
  id?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  models?: Partial<Record<Struggle, string>>;
  allowedTools?: string[];
  maxTurns?: number;
}

/**
 * Builds an `LlmPort` for a provider. Injected so the service stays free of adapters and a
 * test can hand back a fake.
 */
export interface LlmFactory {
  create(
    provider: Provider,
    options?: {
      cwd?: string;
      dirs?: string[];
      tools?: ToolGrant[];
      files?: boolean;
      run?: boolean;
      verify?: string[];
    },
  ): LlmPort;
}

/**
 * Which model runs an agent, and where.
 *
 * The first time this is asked anything it seeds two providers — the local Claude Code CLI
 * and the Anthropic API — because both are things the machine may already be able to do.
 * Claude Code is the default: it needs no key and it can touch files.
 */
export class ProviderService {
  constructor(
    private readonly docs: DocStore,
    private readonly factory: LlmFactory,
    private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  async list(): Promise<Provider[]> {
    return (await this.load()).providers;
  }

  /** Config plus a live check of whether each one can actually be used. */
  async status(): Promise<{ default: string | null; providers: ProviderStatus[] }> {
    const file = await this.load();

    const providers = await Promise.all(
      file.providers.map(async (provider) => {
        if (!provider.enabled) {
          return { ...provider, available: false, detail: 'disabled' };
        }
        try {
          const port = this.factory.create(provider);
          const available = await port.isConfigured();
          return { ...provider, available, detail: await port.describeAuth() };
        } catch (error) {
          return {
            ...provider,
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    return { default: file.default, providers };
  }

  async get(id: string): Promise<Provider> {
    const found = (await this.load()).providers.find((provider) => provider.id === id);
    if (!found) throw new NotFoundError('provider', id);
    return found;
  }

  /**
   * The provider to use when nothing names one: the configured default, else the first
   * enabled provider that actually works right now.
   */
  async resolve(preferred?: string): Promise<Provider> {
    const file = await this.load();

    if (preferred) return this.get(preferred);
    if (file.default) {
      const configured = file.providers.find((provider) => provider.id === file.default);
      if (configured?.enabled) return configured;
    }

    for (const provider of file.providers.filter((candidate) => candidate.enabled)) {
      try {
        if (await this.factory.create(provider).isConfigured()) return provider;
      } catch {
        // Try the next one; an unreachable local endpoint should not block the list.
      }
    }

    throw new ValidationError(
      'no usable model provider — install Claude Code, set an API key, or point Pomni at a local endpoint with `pomni provider add`',
    );
  }

  /** An LlmPort ready to run, plus the model id for this scale. */
  async portFor(
    struggle: Struggle,
    options: {
      provider?: string;
      cwd?: string;
      dirs?: string[];
      tools?: ToolGrant[];
      files?: boolean;
      run?: boolean;
      verify?: string[];
    } = {},
  ): Promise<{ provider: Provider; port: LlmPort; model: string; tools: boolean }> {
    const provider = await this.resolve(options.provider);

    // A tool only reaches a session through the Claude Code CLI: the API backends here have
    // no tool loop to give it to. Saying so is better than a session whose prompt promises
    // a tool it was never handed.
    if (options.tools?.length && provider.kind !== 'claude-code') {
      throw new ValidationError(
        `provider '${provider.id}' cannot give an agent tools — only a claude-code provider can`,
      );
    }

    return {
      provider,
      port: this.factory.create(provider, {
        cwd: options.cwd,
        dirs: options.dirs,
        tools: options.tools,
        files: options.files,
        run: options.run,
        verify: options.verify,
      }),
      model: resolveModel(provider, struggle),
      tools: hasBuiltInTools(provider),
    };
  }

  async create(input: CreateProviderInput): Promise<Provider> {
    const label = input.label.trim();
    if (!label) throw new ValidationError('a provider needs a label');

    const id = input.id?.trim() || deriveId(label, 'provider');
    assertSlug(id, 'provider id');

    const file = await this.load();
    if (file.providers.some((provider) => provider.id === id)) {
      throw new ConflictError(`provider '${id}' already exists`);
    }

    if (input.kind === 'openai' && !input.baseUrl?.trim()) {
      throw new ValidationError('an OpenAI-compatible provider needs a base url, e.g. http://localhost:11434/v1');
    }

    const provider = ProviderSchema.parse({
      id,
      label,
      kind: input.kind,
      baseUrl: input.baseUrl?.trim(),
      apiKeyEnv: input.apiKeyEnv?.trim(),
      models: input.models ?? {},
      allowedTools: input.allowedTools ?? [],
      maxTurns: input.maxTurns,
      enabled: true,
      createdAt: this.clock.iso(),
    });

    await this.save({ ...file, providers: [...file.providers, provider] });
    return provider;
  }

  async update(id: string, patch: Partial<CreateProviderInput> & { enabled?: boolean }): Promise<Provider> {
    const file = await this.load();
    const index = file.providers.findIndex((provider) => provider.id === id);
    if (index === -1) throw new NotFoundError('provider', id);

    const current = file.providers[index] as Provider;
    const next = ProviderSchema.parse({
      ...current,
      ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}),
      ...(patch.apiKeyEnv !== undefined ? { apiKeyEnv: patch.apiKeyEnv.trim() } : {}),
      ...(patch.models !== undefined ? { models: { ...current.models, ...patch.models } } : {}),
      ...(patch.allowedTools !== undefined ? { allowedTools: patch.allowedTools } : {}),
      ...(patch.maxTurns !== undefined ? { maxTurns: patch.maxTurns } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });

    const providers = [...file.providers];
    providers[index] = next;
    await this.save({ ...file, providers });
    return next;
  }

  async remove(id: string): Promise<void> {
    const file = await this.load();
    if (!file.providers.some((provider) => provider.id === id)) {
      throw new NotFoundError('provider', id);
    }
    await this.save({
      ...file,
      default: file.default === id ? null : file.default,
      providers: file.providers.filter((provider) => provider.id !== id),
    });
  }

  async setDefault(id: string): Promise<void> {
    await this.get(id);
    await this.save({ ...(await this.load()), default: id });
  }

  // -------------------------------------------------------------------------

  private async load(): Promise<z.infer<typeof ProvidersFileSchema>> {
    const ref = await this.docs.read(layout.providers, ProvidersFileSchema);
    if (ref) return ref.data;

    // Seed on first use rather than at init, so an existing workspace picks these up too.
    const seeded = ProvidersFileSchema.parse({
      version: 1,
      default: 'claude-code',
      providers: builtinProviders(this.clock.iso()),
    });
    await this.docs.write(layout.providers, seeded);
    return seeded;
  }

  private async save(file: z.infer<typeof ProvidersFileSchema>): Promise<void> {
    await this.docs.write(layout.providers, file);
    this.events.emit({ type: 'provider.changed' });
  }
}
