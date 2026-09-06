import { z } from 'zod';
import { needsBuiltInTools, type Agent, type Struggle } from '../domain/agent.js';
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

    if (preferred) {
      // A named provider is still refused when it is switched off. Returning it anyway meant
      // a disabled provider ran anything that asked for it by id and only the fallback path
      // respected the flag — which is not what "disabled" says on the Providers page.
      const named = await this.get(preferred);
      if (!named.enabled) {
        throw new ValidationError(
          `provider '${named.id}' is disabled — enable it on the Providers page, or choose another`,
        );
      }
      return named;
    }
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
    //
    // Asked of the domain rather than restated here, because `files` and `run` are abilities a
    // chat endpoint cannot perform either — checking only the named grants let a file-editing
    // agent onto an API backend, which is exactly the session that discovers it cannot work.
    const needsTools = needsBuiltInTools({
      tools: {
        files: options.files ?? false,
        run: options.run ?? false,
        verify: (options.verify?.length ?? 0) > 0,
        mcp: options.tools?.map((grant) => grant.tool.id) ?? [],
        cli: [],
      },
    });
    if (needsTools && !hasBuiltInTools(provider)) {
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

  /**
   * Refuse an agent that cannot run where it is pointed — before the first model call.
   *
   * Three things go wrong here and a reader has to tell them apart: the provider was never
   * configured, it exists but is switched off, or it exists and cannot give this agent the
   * tools its grants promise. Each says the agent's name, because in a mixed-provider run the
   * run's own provider is not the one at fault.
   *
   * Called for every agent in a workflow as a run starts, not as each step begins: delegation
   * is lazy, so a leaf agent pointed at a dead provider would otherwise be discovered by that
   * leaf, mid-run, and report the discovery as its work.
   */
  async assertAgentCanRun(
    agent: Pick<Agent, 'name' | 'tools'>,
    providerId: string,
  ): Promise<Provider> {
    let provider: Provider;
    try {
      provider = await this.get(providerId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      throw new ValidationError(
        `agent '${agent.name}' runs on provider '${providerId}', which is not configured — ` +
          "add it with `pomni provider add`, or clear the agent's provider to use the run's",
        { agent: agent.name, providerId },
      );
    }

    if (!provider.enabled) {
      throw new ValidationError(
        `agent '${agent.name}' runs on provider '${provider.id}', which is disabled — enable it ` +
          "on the Providers page, or clear the agent's provider to use the run's",
        { agent: agent.name, providerId },
      );
    }

    if (needsBuiltInTools(agent) && !hasBuiltInTools(provider)) {
      throw new ValidationError(
        `agent '${agent.name}' is granted tools, and provider '${provider.id}' cannot give an ` +
          'agent tools — only a claude-code provider can. Move it to a claude-code provider, ' +
          'or take its tool grants away.',
        { agent: agent.name, providerId },
      );
    }

    return provider;
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
