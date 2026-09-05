import { z } from 'zod';
import { SecretRefSchema, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const CreateCredentialBody = z.object({
  name: z.string().min(1),
  id: z.string().optional(),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).optional(),
  host: z.string().optional(),
  username: z.string().optional(),
  secretRef: SecretRefSchema,
  secret: z.string().optional(),
});

const UpdateCredentialBody = z.object({
  name: z.string().min(1).optional(),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).optional(),
  host: z.string().optional(),
  username: z.string().optional(),
  secretRef: SecretRefSchema.optional(),
  secret: z.string().optional(),
});

/**
 * Credentials go in but never come back out: every response is metadata plus `hasSecret`.
 * There is deliberately no route that returns a token.
 */
export async function credentialRoutes(
  app: FastifyInstance,
  container: PomniContainer,
): Promise<void> {
  app.get('/api/credentials', async () => ({
    credentials: await container.credentials.list(),
  }));

  app.post('/api/credentials', async (request, reply) => {
    const body = CreateCredentialBody.parse(request.body);
    const credential = await container.credentials.create(body);
    reply.code(201);
    return { credential };
  });

  app.patch<{ Params: { id: string } }>('/api/credentials/:id', async (request) => {
    const body = UpdateCredentialBody.parse(request.body);
    return { credential: await container.credentials.update(request.params.id, body) };
  });

  app.post<{ Params: { id: string }; Body: { url?: string } }>(
    '/api/credentials/:id/test',
    async (request) => container.credentials.test(request.params.id, request.body?.url),
  );

  app.delete<{ Params: { id: string } }>('/api/credentials/:id', async (request, reply) => {
    await container.credentials.remove(request.params.id);
    reply.code(204);
  });
}
