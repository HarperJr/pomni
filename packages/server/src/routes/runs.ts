import { z } from 'zod';
import type { PomniContainer } from '@pomni/core';
import { readLogFrom } from '@pomni/infra';
import type { FastifyInstance } from 'fastify';

const StartRunBody = z.object({
  project: z.string().min(1),
  capability: z.string().min(1),
  repoId: z.string().optional(),
  itemId: z.string().optional(),
  bail: z.boolean().optional(),
});

const ListQuery = z.object({
  project: z.string().optional(),
  repo: z.string().optional(),
  capability: z.string().optional(),
  item: z.string().optional(),
  failed: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.string().optional(),
});

export async function runRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get('/api/runs', async (request) => {
    const query = ListQuery.parse(request.query);
    return {
      runs: await container.runs.list({
        projectId: query.project,
        repoId: query.repo,
        capability: query.capability,
        itemId: query.item,
        failedOnly: query.failed === 'true',
        limit: query.limit ?? 30,
        before: query.before,
      }),
    };
  });

  /**
   * 202 and run detached. A build takes minutes; holding the request open would tie the
   * browser to it. The client follows `run.started` / `run.finished` on `/api/events` and
   * streams output from `/api/runs/:id/log`.
   */
  app.post('/api/runs', async (request, reply) => {
    const body = StartRunBody.parse(request.body);

    // Validate before accepting, so a bad capability is a 422 and not a silent no-op.
    const repos = await container.repos.listResolved(body.project);
    const targets = repos.filter(
      (repo) =>
        Boolean(repo.capabilities[body.capability]) &&
        (body.repoId ? repo.id === body.repoId : true),
    );

    if (targets.length === 0) {
      reply.code(422).type('application/problem+json');
      return {
        type: 'https://pomni.dev/errors/validation',
        title: `no repo in '${body.project}' declares a '${body.capability}' capability`,
        status: 422,
        code: 'validation',
      };
    }

    void container.runs
      .run(body.project, body.capability, {
        repoId: body.repoId,
        itemId: body.itemId,
        bail: body.bail,
      })
      .catch((error: unknown) => container.logger.error('run failed', error));

    reply.code(202);
    return {
      accepted: true,
      capability: body.capability,
      repos: targets.map((repo) => repo.id),
    };
  });

  /** Run a project's gate. Same detached shape as a single run. */
  app.post<{ Params: { id: string }; Body: { gate?: 'default' | 'land'; repoId?: string } }>(
    '/api/projects/:id/verify',
    async (request, reply) => {
      const gate = request.body?.gate === 'land' ? 'land' : 'default';
      await container.projects.getRef(request.params.id);

      void container.runs
        .gate(request.params.id, gate, { repoId: request.body?.repoId })
        .catch((error: unknown) => container.logger.error('gate failed', error));

      reply.code(202);
      return { accepted: true, gate };
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/doctor', async (request) => ({
    report: await container.doctor.check(request.params.id),
  }));

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    const run = await container.runs.get(request.params.id);
    return { run, testResults: await container.runs.testResults(run.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (request) => ({
    run: await container.runs.cancel(request.params.id),
  }));

  /**
   * Live output. Reads the log file rather than subscribing to the bus, so a run started by
   * the CLI in another process streams here exactly like one this process started.
   */
  app.get<{ Params: { id: string } }>('/api/runs/:id/log', async (request, reply) => {
    const run = await container.runs.get(request.params.id);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let offset = 0;
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    const send = (event: string, data: unknown) => {
      if (!closed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    for (;;) {
      if (closed) break;

      const chunk = await readLogFrom(run.logPath, offset);
      offset = chunk.offset;
      if (chunk.text) send('log', { text: chunk.text });

      const current = await container.runs.get(run.id);
      if (current.status !== 'running' && current.status !== 'queued') {
        // One last read: output can land between the final write and the status update.
        const tail = await readLogFrom(run.logPath, offset);
        if (tail.text) send('log', { text: tail.text });
        send('done', { run: current });
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (!closed) reply.raw.end();
    return reply;
  });
}
