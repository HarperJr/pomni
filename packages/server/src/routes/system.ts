import { z } from 'zod';
import { ValidationError, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const BrowseQuery = z.object({ path: z.string().optional() });

const RestartBody = z.object({ cancelInFlight: z.boolean().optional() });

/**
 * Which web bundle this server would serve right now.
 *
 * Read from `index.html` rather than remembered at startup: the bundle is rebuilt while the
 * server keeps running, and a value fixed at boot would tell you the opposite of the truth.
 */
async function servedBuild(): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../../web/dist/index.html'),
    join(here, '../../../../web/dist/index.html'),
  ];

  for (const candidate of candidates) {
    try {
      const html = await readFile(candidate, 'utf8');
      return /assets\/(index-[\w-]+\.js)/.exec(html)?.[1] ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

export async function systemRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get('/api/health', async () => container.system.health({ build: await servedBuild() }));

  /**
   * Rebuild and replace this process, or say why it did not. Every outcome — including the
   * refusals — is a 200 carrying the discriminated union: the browser renders each arm, it
   * does not catch an error to find out which one happened.
   */
  app.post('/api/restart', async (request) => {
    const body = RestartBody.parse(request.body ?? {});
    return container.system.restartServer(body);
  });

  /**
   * Directory picker for "add a local repo". Read-only, loopback-only by virtue of the
   * server's bind address, and it never lists file contents — only names.
   */
  app.get<{ Querystring: { path?: string } }>('/api/fs/browse', async (request) => {
    const query = BrowseQuery.parse(request.query);

    if (!query.path) {
      return {
        path: null,
        parent: null,
        home: container.fs.home(),
        roots: await container.fs.roots(),
        entries: [],
      };
    }

    const path = container.fs.resolve(query.path);
    if (!(await container.fs.isDirectory(path))) {
      throw new ValidationError(`'${path}' is not a directory`);
    }

    return {
      path,
      parent: parentOf(path),
      home: container.fs.home(),
      roots: await container.fs.roots(),
      entries: await container.fs.listDir(path),
    };
  });

  /** Preview what Pomni would detect, before committing to adding the repo. */
  app.get<{ Querystring: { path?: string } }>('/api/fs/detect', async (request) => {
    const query = BrowseQuery.parse(request.query);
    if (!query.path) throw new ValidationError('path is required');

    const path = container.fs.resolve(query.path);
    if (!(await container.fs.isDirectory(path))) {
      throw new ValidationError(`'${path}' is not a directory`);
    }

    const [detection, vcs] = await Promise.all([
      container.detection.detect(path),
      container.git.info(path),
    ]);
    return { path, detection, vcs };
  });

  /**
   * Live updates. The bus is in-process today; when runs land it also tails
   * `.pomni/events.ndjson`, and this endpoint does not change.
   */
  app.get('/api/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`: connected\n\n`);

    const unsubscribe = container.events.subscribe((event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Keep the handler open; Fastify must not send its own response.
    return reply;
  });
}

function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index <= 0) return null;
  const parent = trimmed.slice(0, index);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}
