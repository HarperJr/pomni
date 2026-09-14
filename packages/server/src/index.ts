import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { ValidationError, type PomniContainer } from '@pomni/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler, sendNotFound } from './errors.js';
import { chatRoutes } from './routes/chats.js';
import { commentRoutes } from './routes/comments.js';
import { credentialRoutes } from './routes/credentials.js';
import { projectRoutes } from './routes/projects.js';
import { itemRoutes } from './routes/items.js';
import { repoRoutes } from './routes/repos.js';
import { runRoutes } from './routes/runs.js';
import { discoveryRoutes } from './routes/discovery.js';
import { pipelineRoutes } from './routes/pipelines.js';
import { toolRoutes } from './routes/tools.js';
import { workflowRoutes } from './routes/workflows.js';
import { systemRoutes } from './routes/system.js';

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Required when host is not loopback. */
  token?: string;
  /** Directory holding the built SPA. Defaults to packages/web/dist. */
  webRoot?: string;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export interface RunningServer {
  url: string;
  address: string;
  port: number;
  app: FastifyInstance;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export async function createApp(
  container: PomniContainer,
  options: ServeOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: options.logLevel ?? 'warn' } });

  registerErrorHandler(app);

  // Loopback-only by default, so no CSRF surface and no cookie auth. A token is required
  // the moment the server is reachable from another machine.
  if (options.token) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      const header = request.headers.authorization ?? '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (provided !== options.token) {
        reply.code(401).type('application/problem+json').send({
          type: 'about:blank',
          title: 'unauthorized',
          status: 401,
        });
      }
    });
  }

  // The SPA is served from the same origin in production. In dev it runs on the Vite port,
  // so allow that one explicitly rather than opening CORS generally.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Headers', 'content-type, authorization, if-match');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Expose-Headers', 'etag');
    }
    if (request.method === 'OPTIONS' && request.url.startsWith('/api/')) {
      reply.code(204).send();
    }
  });

  await systemRoutes(app, container);
  await projectRoutes(app, container);
  await repoRoutes(app, container);
  await credentialRoutes(app, container);
  await runRoutes(app, container);
  await itemRoutes(app, container);
  await workflowRoutes(app, container);
  await discoveryRoutes(app, container);
  await pipelineRoutes(app, container);
  await toolRoutes(app, container);
  await chatRoutes(app, container);
  await commentRoutes(app, container);

  const webRoot = options.webRoot ?? defaultWebRoot();
  const hasWeb = await exists(join(webRoot, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webRoot });
  }

  // One handler only — Fastify rejects a second registration for the same prefix.
  app.setNotFoundHandler((request, reply) => {
    if (!hasWeb || request.url.startsWith('/api/')) {
      sendNotFound(request, reply);
      return;
    }
    // SPA fallback: any non-API path renders the app shell and the router takes over.
    reply.sendFile('index.html');
  });

  return app;
}

export async function startServer(
  container: PomniContainer,
  options: ServeOptions = {},
): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7777;

  if (!isLoopback(host) && !options.token) {
    throw new ValidationError(
      `refusing to listen on ${host} without --token: a non-loopback server must be authenticated`,
    );
  }

  const app = await createApp(container, options);
  const unwatch = watchFlow(container);
  const unnotify = container.notifications.start();
  app.addHook('onClose', async () => {
    unwatch();
    unnotify();
  });

  await listenWithHandover(app, host, port);

  const address = app.addresses()[0];
  const actualPort = address?.port ?? port;
  const displayHost = isLoopback(host) ? 'localhost' : host;

  return {
    app,
    address: host,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    close: () => app.close(),
  };
}

/**
 * Start the workflow a column names, whenever an item enters it.
 *
 * Wired here, in the server, because this is the process that can own a run. A run outlives
 * the request that asked for it, and the alternative — a one-shot CLI process starting one and
 * exiting — produces exactly the orphan a run marked `running` with a dead pid is.
 *
 * It listens rather than being called from the transition route, so it fires for every move
 * this process makes: the board, the item page, the CLI talking to this server, and an agent
 * moving its own item mid-run.
 *
 * Nothing is awaited. The move has already happened and its response must not wait on an
 * agent run that takes ten minutes; the run announces itself on the same event stream the
 * board is already watching.
 */
function watchFlow(container: PomniContainer): () => void {
  return container.events.subscribe((event) => {
    if (event.type !== 'item.transitioned') return;

    void container.pipelines
      .onItemEntered(event.projectId, event.itemId, event.to)
      .then((started) => {
        if (started) {
          container.logger.info(
            `${event.to} names a workflow: started ${started.run.id} for ${event.itemId}`,
          );
          // The failure is already recorded on the run; this keeps an unhandled rejection from
          // taking the server down with it.
          started.completion.catch(() => undefined);
        }
      })
      .catch((error: unknown) => container.logger.error('flow trigger failed', error));
  });
}

const RESTART_AWAIT_PORT_ENV = 'POMNI_RESTART_AWAIT_PORT';
const PORT_RETRY_TIMEOUT_MS = 15_000;
const PORT_RETRY_INTERVAL_MS = 250;

/**
 * A successor spawned by a restart starts while its predecessor is still holding the port —
 * that is how the handover avoids a gap where nothing is listening. `POMNI_RESTART_AWAIT_PORT`
 * says this process is that successor, so `EADDRINUSE` is expected and worth retrying rather
 * than a reason to give up. The env var is cleared once read so any process this one spawns
 * does not inherit a retry meant for this handover alone.
 */
async function listenWithHandover(app: FastifyInstance, host: string, port: number): Promise<void> {
  const awaitPort = process.env[RESTART_AWAIT_PORT_ENV] === '1';
  delete process.env[RESTART_AWAIT_PORT_ENV];

  if (!awaitPort) {
    await app.listen({ host, port });
    return;
  }

  const deadline = Date.now() + PORT_RETRY_TIMEOUT_MS;
  for (;;) {
    try {
      await app.listen({ host, port });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, PORT_RETRY_INTERVAL_MS));
    }
  }
}

function defaultWebRoot(): string {
  // dist/index.js -> packages/server -> packages -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'web', 'dist');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export { registerErrorHandler };
export type { Problem } from './errors.js';
