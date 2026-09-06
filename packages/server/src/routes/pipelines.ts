import { z } from 'zod';
import { PipelineStatusSchema, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const ListQuery = z.object({
  status: z.enum(['running', 'passed', 'failed', 'cancelled']).optional(),
  project: z.string().optional(),
  workflow: z.string().optional(),
  item: z.string().optional(),
  // Clamped by the service rather than rejected here — asking for more rows than exist
  // is not a malformed request, it is a request for everything.
  limit: z.coerce.number().int().positive().optional(),
});

const StartBody = z.object({
  task: z.string().min(1),
  workflowId: z.string().optional(),
  itemId: z.string().optional(),
  repoId: z.string().optional(),
  providerId: z.string().optional(),
  /**
   * Attached files, sent inline. The browser has already read them; asking it to upload them
   * separately would buy a second endpoint and a half-started run to attach them to.
   */
  context: z.array(z.object({ name: z.string().min(1), content: z.string() })).optional(),
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

  /**
   * Cross-project view: the per-project GET above can't answer "what is running anywhere",
   * which is exactly what the Projects and Tracker screens need to show live indicators.
   */
  app.get<{
    Querystring: { status?: string; project?: string; workflow?: string; item?: string; limit?: string };
  }>('/api/pipelines', async (request) => {
    const query = ListQuery.parse(request.query);
    return {
      runs: await container.pipelines.list({
        status: query.status,
        projectId: query.project,
        workflowId: query.workflow,
        itemId: query.item,
        limit: query.limit,
      }),
    };
  });

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; workflow?: string; status?: string };
  }>('/api/projects/:id/pipelines', async (request) => {
    const query = ListQuery.parse(request.query);
    return {
      runs: await container.pipelines.list({
        projectId: request.params.id,
        workflowId: query.workflow,
        status: query.status,
        limit: query.limit,
      }),
    };
  });

  app.get<{ Params: { runId: string } }>('/api/pipelines/:runId', async (request) => ({
    run: await container.pipelines.get(request.params.runId),
  }));

  app.delete<{ Params: { runId: string } }>('/api/pipelines/:runId', async (request) => ({
    run: await container.pipelines.cancel(request.params.runId),
  }));

  /** Run a finished run again, carrying forward why it ended. */
  app.post<{ Params: { runId: string } }>('/api/pipelines/:runId/rerun', async (request, reply) => {
    const { run, completion } = await container.pipelines.rerun(request.params.runId);

    completion.catch((error: unknown) => container.logger.error('rerun failed', error));
    reply.code(202);
    return { run };
  });

  /** What a person is being asked, and their reply. A waiting run is polling for it. */
  app.get<{ Querystring: { project?: string } }>('/api/questions', async (request) => ({
    questions: await container.pipelines.openQuestions(request.query.project),
  }));

  app.post<{ Params: { questionId: string } }>(
    '/api/questions/:questionId',
    async (request) => ({
      question: await (() => {
        const body = z
          .object({
            answer: z.string().default(''),
            files: z.array(z.object({ name: z.string().min(1), content: z.string() })).optional(),
          })
          .parse(request.body);
        return container.pipelines.answer(request.params.questionId, body.answer, body.files);
      })(),
    }),
  );
}
