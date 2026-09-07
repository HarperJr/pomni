import { z } from 'zod';
import {
  AgentRoleSchema,
  StruggleSchema,
  PROVIDER_PRESETS,
  ProviderKindSchema,
  resolveModel,
  type PomniContainer,
} from '@pomni/core';
import type { FastifyInstance } from 'fastify';
import { normalizeEtag } from './projects.js';

const CreateWorkflowBody = z.object({
  name: z.string().min(1),
  id: z.string().optional(),
  description: z.string().optional(),
  suits: z.array(z.string()).optional(),
});

const CreateProviderBody = z.object({
  label: z.string().min(1),
  kind: ProviderKindSchema,
  id: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  models: z
    .object({
      fast: z.string().optional(),
      balanced: z.string().optional(),
      deep: z.string().optional(),
      max: z.string().optional(),
    })
    .optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
});

const UpdateWorkflowBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  suits: z.array(z.string()).optional(),
  entry: z.string().nullable().optional(),
  handoffTo: z.string().nullable().optional(),
});

const AgentBody = z.object({
  name: z.string().min(1),
  id: z.string().optional(),
  role: AgentRoleSchema.optional(),
  spec: z.string().optional(),
  prompt: z.string().optional(),
  struggle: StruggleSchema.optional(),
  provider: z.string().nullable().optional(),
  outputs: z.string().optional(),
  delegatesTo: z.array(z.string()).optional(),
  tools: z
    .object({
      files: z.boolean().optional(),
      run: z.boolean().optional(),
      web: z.boolean().optional(),
      mcp: z.array(z.string()).optional(),
      cli: z.array(z.string()).optional(),
    })
    .optional(),
});

const UpdateAgentBody = AgentBody.partial();

export async function workflowRoutes(
  app: FastifyInstance,
  container: PomniContainer,
): Promise<void> {
  app.get('/api/workflows', async () => ({
    workflows: await container.workflows.list(),
    scales: container.workflows.scales(),
  }));

  app.post('/api/workflows', async (request, reply) => {
    const body = CreateWorkflowBody.parse(request.body);
    reply.code(201);
    return { workflow: await container.workflows.create(body) };
  });

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    const ref = await container.workflows.getRef(request.params.id);
    reply.header('ETag', ref.rev);
    return { workflow: await container.workflows.get(request.params.id), rev: ref.rev };
  });

  app.patch<{ Params: { id: string } }>('/api/workflows/:id', async (request) => {
    const body = UpdateWorkflowBody.parse(request.body);
    const workflow = await container.workflows.update(
      request.params.id,
      body,
      normalizeEtag(request.headers['if-match']),
    );
    return { workflow };
  });

  app.delete<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    await container.workflows.remove(request.params.id);
    reply.code(204);
  });

  // -- agents ---------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/api/workflows/:id/agents', async (request, reply) => {
    const body = AgentBody.parse(request.body);
    reply.code(201);
    return { agent: await container.workflows.addAgent(request.params.id, body) };
  });

  app.patch<{ Params: { id: string; agentId: string } }>(
    '/api/workflows/:id/agents/:agentId',
    async (request) => {
      const body = UpdateAgentBody.parse(request.body);
      return {
        agent: await container.workflows.updateAgent(
          request.params.id,
          request.params.agentId,
          body,
          normalizeEtag(request.headers['if-match']),
        ),
      };
    },
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/workflows/:id/agents/:agentId',
    async (request, reply) => {
      await container.workflows.removeAgent(request.params.id, request.params.agentId);
      reply.code(204);
    },
  );

  /**
   * The "generate the prompt" button. Synchronous: it is one model call and the author is
   * sitting there waiting for the text to appear in the editor.
   */
  app.post<{ Params: { id: string; agentId: string } }>(
    '/api/workflows/:id/agents/:agentId/prompt',
    async (request) => ({
      agent: await container.workflows.generatePrompt(request.params.id, request.params.agentId),
    }),
  );

  // -- export / import ------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/workflows/:id/export', async (request, reply) => {
    const body = await container.workflows.export(request.params.id);
    reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${request.params.id}.pomni.json"`);
    return body;
  });

  app.post<{ Body: { content?: string; id?: string } }>(
    '/api/workflows/import',
    async (request, reply) => {
      const body = z.object({ content: z.string(), id: z.string().optional() }).parse(request.body);
      reply.code(201);
      return { workflow: await container.workflows.import(body.content, { id: body.id }) };
    },
  );

  // -- attaching ------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/projects/:id/workflows', async (request) => ({
    workflows: await container.workflows.forProject(request.params.id),
  }));

  app.post<{ Params: { id: string }; Body: { workflowId: string } }>(
    '/api/projects/:id/workflows',
    async (request) => {
      const body = z.object({ workflowId: z.string() }).parse(request.body);
      return { workflows: await container.workflows.attach(request.params.id, body.workflowId) };
    },
  );

  app.delete<{ Params: { id: string; workflowId: string } }>(
    '/api/projects/:id/workflows/:workflowId',
    async (request) => ({
      workflows: await container.workflows.detach(request.params.id, request.params.workflowId),
    }),
  );

  /** Which providers exist and which of them actually work right now. */
  app.get('/api/llm/status', async () => {
    const status = await container.providers.status();
    const usable = status.providers.find((provider) => provider.available);
    const chosen = status.providers.find((provider) => provider.id === status.default) ?? usable;

    // The concrete model a fresh chat would actually run on, so the composer can show it
    // before any chat exists — without reimplementing `resolveModel`'s fallback in the client.
    let defaultModel: { providerId: string; model: string } | null = null;
    if (chosen) {
      try {
        defaultModel = { providerId: chosen.id, model: resolveModel(chosen, 'medium') };
      } catch {
        defaultModel = null;
      }
    }

    return {
      configured: Boolean(usable),
      auth: usable ? usable.detail : 'no usable provider — add one on the Providers page',
      default: status.default,
      defaultModel,
      providers: status.providers,
    };
  });

  app.get('/api/providers', async () => container.providers.status());

  app.post('/api/providers', async (request, reply) => {
    const body = CreateProviderBody.parse(request.body);
    reply.code(201);
    return { provider: await container.providers.create(body) };
  });

  app.patch<{ Params: { id: string } }>('/api/providers/:id', async (request) => ({
    provider: await container.providers.update(
      request.params.id,
      CreateProviderBody.partial().extend({ enabled: z.boolean().optional() }).parse(request.body),
    ),
  }));

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => {
    await container.providers.remove(request.params.id);
    reply.code(204);
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/default', async (request) => {
    await container.providers.setDefault(request.params.id);
    return { default: request.params.id };
  });

  /** Presets for the common endpoints, so a local setup is two clicks rather than research. */
  app.get('/api/providers/presets', async () => ({ presets: PROVIDER_PRESETS }));

  /** What an OpenAI-compatible endpoint actually serves, so model names are not guesswork. */
  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request) => {
    const provider = await container.providers.get(request.params.id);
    if (provider.kind !== 'openai' || !provider.baseUrl) return { models: [] };

    const { OpenAiCompatibleLlm } = await import('@pomni/infra');
    const client = new OpenAiCompatibleLlm({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined,
      label: provider.label,
    });
    return { models: await client.listModels() };
  });
}
