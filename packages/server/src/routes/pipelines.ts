import { z } from 'zod';
import type { PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const StartBody = z.object({
  task: z.string().min(1),
  workflowId: z.string().optional(),
  itemId: z.string().optional(),
  repoId: z.string().optional(),
  providerId: z.string().optional(),
});

export async function pipelineRoutes(
  app: FastifyInstance,
  container: PomniContainer,
): Promise<void> {
  /**
   * Start a run and return immediately. A pipeline takes minutes and fans out across many
   * model calls; the console follows it on /api/events rather than holding a request open.
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/pipelines', async (request, reply) => {
    const body = StartBody.parse(request.body);
    const { run, completion } = await container.pipelines.start({
      projectId: request.params.id,
      ...body,
    });

    completion.catch((error: unknown) => container.logger.error('pipeline failed', error));
    reply.code(202);
    return { run };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; workflow?: string } }>(
    '/api/projects/:id/pipelines',
    async (request) => ({
      runs: await container.pipelines.list({
        projectId: request.params.id,
        workflowId: request.query.workflow,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      }),
    }),
  );

  app.get<{ Params: { runId: string } }>('/api/pipelines/:runId', async (request) => ({
    run: await container.pipelines.get(request.params.runId),
  }));

  app.delete<{ Params: { runId: string } }>('/api/pipelines/:runId', async (request) => ({
    run: await container.pipelines.cancel(request.params.runId),
  }));
}
