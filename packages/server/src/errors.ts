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
  /** From `RequirementsNotMetError.details.unmet` — which requirements a refused move failed. */
  unmet?: unknown;
}

/**
 * A `ZodError`, detected structurally rather than with `instanceof`. `@pomni/server` has no
 * declared dependency on zod — every route that parses with it (`pipelines.ts` among others)
 * reaches it transitively through `@pomni/core`. An `instanceof ZodError` check here would need
 * its own `import { ZodError } from 'zod'`, and npm's hoisting gives no guarantee that resolves
 * to the same module instance a route's `z.parse` threw from; a mismatch would make the check
 * silently always fail. Matching on `name` and `issues` needs no zod import at all, so there is
 * no instance to mismatch.
 */
function isZodError(error: unknown): error is { issues: Array<{ path: Array<string | number>; message: string }> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawError: unknown, request, reply) => {
    if (isZodError(rawError)) {
      const first = rawError.issues[0];
      const field = first?.path?.length ? first.path.join('.') : '(body)';
      const problem: Problem = {
        type: 'https://pomni.dev/errors/validation',
        title: 'validation failed',
        status: 422,
        code: 'validation',
        detail: first ? `${field}: ${first.message}` : 'validation failed',
        errors: rawError.issues,
      };
      reply.code(422).type('application/problem+json').send(problem);
      return;
    }

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
        const details = error.details as { unmet?: unknown };
        if (Array.isArray(details?.unmet)) problem.unmet = details.unmet;
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
