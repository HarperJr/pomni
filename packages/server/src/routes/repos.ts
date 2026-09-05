import { z } from 'zod';
import { RepoRoleSchema, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';
import { normalizeEtag } from './projects.js';

const AddRepoBody = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), path: z.string().min(1) }),
    z.object({
      kind: z.literal('git'),
      url: z.string().min(1),
      ref: z.string().optional(),
      credential: z.string().optional(),
      provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).optional(),
    }),
  ]),
  id: z.string().optional(),
  name: z.string().optional(),
  role: RepoRoleSchema.optional(),
});

const UpdateRepoBody = z.object({
  name: z.string().min(1).optional(),
  role: RepoRoleSchema.optional(),
  url: z.string().min(1).optional(),
  ref: z.string().nullable().optional(),
  credential: z.string().nullable().optional(),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).optional(),
  reclone: z.boolean().optional(),
});

export async function repoRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/projects/:id/repos', async (request) => ({
    repos: await container.repos.listResolved(request.params.id),
  }));

  /**
   * Returns 202 with the repo in `cloning`: the clone runs on after the response and the
   * client polls (or listens on /api/events). A local link is finished by the time the
   * completion settles, so it comes back already resolved.
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/repos', async (request, reply) => {
    const body = AddRepoBody.parse(request.body);
    const { repo, completion } = await container.repos.add(request.params.id, body);

    if (repo.source.kind === 'local') {
      const settled = await completion;
      reply.code(201);
      return { repo: await container.workspace.resolve(settled) };
    }

    completion.catch((error: unknown) => container.logger.error('clone failed', error));
    reply.code(202);
    return { repo: await container.workspace.resolve(repo) };
  });

  app.get<{ Params: { id: string; repoId: string } }>(
    '/api/projects/:id/repos/:repoId',
    async (request) => ({
      repo: await container.repos.get(request.params.id, request.params.repoId),
    }),
  );

  app.patch<{ Params: { id: string; repoId: string } }>(
    '/api/projects/:id/repos/:repoId',
    async (request) => {
      const patch = UpdateRepoBody.parse(request.body);
      const repo = await container.repos.update(
        request.params.id,
        request.params.repoId,
        patch,
        normalizeEtag(request.headers['if-match']),
      );
      return { repo: await container.workspace.resolve(repo) };
    },
  );

  app.post<{ Params: { id: string; repoId: string } }>(
    '/api/projects/:id/repos/:repoId/sync',
    async (request) => ({
      repo: await container.repos.sync(request.params.id, request.params.repoId),
    }),
  );

  app.delete<{ Params: { id: string; repoId: string }; Querystring: { purge?: string } }>(
    '/api/projects/:id/repos/:repoId',
    async (request, reply) => {
      await container.repos.remove(request.params.id, request.params.repoId, {
        purge: request.query.purge === 'true',
      });
      reply.code(204);
    },
  );
}
