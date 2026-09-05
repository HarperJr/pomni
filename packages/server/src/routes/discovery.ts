import { z } from 'zod';
import type { PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const ImportBody = z.object({
  workflowId: z.string(),
  assetId: z.string(),
  repoId: z.string().optional(),
});

export async function discoveryRoutes(
  app: FastifyInstance,
  container: PomniContainer,
): Promise<void> {
  /**
   * What already exists inside this project's repos: agent definitions, skills, commands and
   * house rules. Read-only, and cheap enough to call whenever the page opens.
   */
  app.get<{ Params: { id: string }; Querystring: { repo?: string } }>(
    '/api/projects/:id/discover',
    async (request) => ({
      report: await container.discovery.scan(request.params.id, { repoId: request.query.repo }),
    }),
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/discover/import', async (request) => {
    const body = ImportBody.parse(request.body);
    return {
      imported: await container.discovery.importAgent(
        request.params.id,
        body.workflowId,
        body.assetId,
        { repoId: body.repoId },
      ),
    };
  });
}
