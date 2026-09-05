import { z } from 'zod';
import { ProjectPatchSchema, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const CreateProjectBody = z.object({
  name: z.string().min(1),
  id: z.string().optional(),
  description: z.string().optional(),
});

export async function projectRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get('/api/projects', async () => ({ projects: await container.projects.list() }));

  app.post('/api/projects', async (request, reply) => {
    const body = CreateProjectBody.parse(request.body);
    const project = await container.projects.create(body);
    reply.code(201);
    return { project };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const ref = await container.projects.getRef(request.params.id);
    const repos = await container.repos.listResolved(request.params.id);
    reply.header('ETag', ref.rev);
    return { project: { ...ref.data, repos }, rev: ref.rev };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const patch = ProjectPatchSchema.parse(request.body);
    const ifMatch = normalizeEtag(request.headers['if-match']);
    const project = await container.projects.update(request.params.id, patch, ifMatch);
    return { project };
  });

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/api/projects/:id',
    async (request, reply) => {
      await container.projects.remove(request.params.id, {
        purge: request.query.purge === 'true',
      });
      reply.code(204);
    },
  );
}

/** Strip the quotes and any weak-validator prefix an HTTP client may add. */
export function normalizeEtag(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw === '*') return undefined;
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}
