import { PomniError, StaleRevisionError } from '@pomni/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** RFC 7807-shaped problem body, so every client can handle failures uniformly. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  /** For 409 conflicts: the content the caller must merge against. */
  current?: unknown;
  errors?: unknown;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    if (error instanceof PomniError) {
      const problem: Problem = {
        type: `https://pomni.dev/errors/${error.code}`,
        title: error.message,
        status: error.status,
        code: error.code,
      };

      if (error instanceof StaleRevisionError) {
        problem.current = error.current;
        problem.detail =
          'Someone else changed this while you were editing. Merge against `current` and retry with the new revision.';
      } else if (error.details !== undefined) {
        problem.errors = error.details;
      }

      reply.code(error.status).type('application/problem+json').send(problem);
      return;
    }

    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);

    reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: status >= 500 ? 'Internal server error' : error.message,
        status,
        detail: status >= 500 ? undefined : error.message,
      } satisfies Problem);
  });
}

/**
 * Fastify allows exactly one not-found handler per prefix, so the SPA fallback and the API
 * 404 share this one; `createApp` decides which branch applies.
 */
export function sendNotFound(request: FastifyRequest, reply: FastifyReply): void {
  reply
    .code(404)
    .type('application/problem+json')
    .send({
      type: 'about:blank',
      title: `no route for ${request.method} ${request.url}`,
      status: 404,
    } satisfies Problem);
}
