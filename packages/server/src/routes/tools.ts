import { z } from 'zod';
import { McpTransportSchema, ToolKindSchema, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const ToolBody = z.object({
  name: z.string().min(1),
  kind: ToolKindSchema,
  id: z.string().optional(),
  description: z.string().optional(),
  usage: z.string().optional(),
  bin: z.string().optional(),
  transport: McpTransportSchema.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  envFrom: z.array(z.string()).optional(),
  credential: z.string().nullable().optional(),
  credentialEnv: z.string().nullable().optional(),
  check: z.string().nullable().optional(),
});

const UpdateToolBody = ToolBody.partial().extend({ enabled: z.boolean().optional() });

/**
 * Tools an agent can be given: MCP servers and CLI programs.
 *
 * Nothing here ever returns a secret. A tool names the credential it needs; the token is
 * resolved only when a session is about to be started with it.
 */
export async function toolRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get('/api/tools', async () => ({ tools: await container.tools.list() }));

  app.get<{ Params: { id: string } }>('/api/tools/:id', async (request) => ({
    tool: await container.tools.get(request.params.id),
  }));

  app.post('/api/tools', async (request, reply) => {
    const tool = await container.tools.create(ToolBody.parse(request.body));
    reply.code(201);
    return { tool };
  });

  app.patch<{ Params: { id: string } }>('/api/tools/:id', async (request) => ({
    tool: await container.tools.update(request.params.id, UpdateToolBody.parse(request.body)),
  }));

  app.delete<{ Params: { id: string } }>('/api/tools/:id', async (request, reply) => {
    await container.tools.remove(request.params.id);
    reply.code(204);
  });

  app.post<{ Body: unknown }>('/api/tools/check', async (request) => ({
    results: await container.tools.check(
      z.object({ ids: z.array(z.string()).optional() }).parse(request.body ?? {}).ids,
    ),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id/tools', async (request) => ({
    tools: await container.tools.forProject(request.params.id),
  }));

  app.put<{ Params: { id: string; toolId: string } }>(
    '/api/projects/:id/tools/:toolId',
    async (request) => ({
      tools: await container.tools.attach(request.params.id, request.params.toolId),
    }),
  );

  app.delete<{ Params: { id: string; toolId: string } }>(
    '/api/projects/:id/tools/:toolId',
    async (request) => ({
      tools: await container.tools.detach(request.params.id, request.params.toolId),
    }),
  );
}
