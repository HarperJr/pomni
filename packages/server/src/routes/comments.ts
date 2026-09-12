import { z } from 'zod';
import { CommentSubjectSchema, type PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const WriteCommentBody = z.object({
  text: z.string().min(1),
  /**
   * Who is writing. A person, always — an agent writes through the run it is speaking from,
   * and a browser that could claim to be one would make an agent's note mistakable for a
   * person's, which is the one thing the author model exists to prevent.
   */
  author: z.string().optional(),
  addressedTo: z.string().nullable().optional(),
  resolvesCommentId: z.string().nullable().optional(),
});

const DeleteCommentBody = z.object({ author: z.string().optional() });

const ListQuery = z.object({
  includeDeleted: z.enum(['true', 'false']).optional(),
});

function person(name: string | undefined): { kind: 'person'; name: string } {
  const trimmed = name?.trim();
  return { kind: 'person', name: trimmed ? trimmed : 'someone' };
}

/**
 * Notes on items and runs.
 *
 * One pair of routes for both subjects rather than a set under `items` and another under
 * `runs`: the subject is a field on the comment, and splitting it here would make two
 * near-identical handlers that could drift apart.
 */
export async function commentRoutes(
  app: FastifyInstance,
  container: PomniContainer,
): Promise<void> {
  app.get<{ Params: { subject: string; subjectId: string } }>(
    '/api/comments/:subject/:subjectId',
    async (request) => {
      const subject = CommentSubjectSchema.parse(request.params.subject);
      const query = ListQuery.parse(request.query);
      return {
        comments: await container.comments.list({
          subject,
          subjectId: request.params.subjectId,
          includeDeleted: query.includeDeleted === 'true',
        }),
      };
    },
  );

  app.post<{ Params: { subject: string; subjectId: string } }>(
    '/api/projects/:projectId/comments/:subject/:subjectId',
    async (request, reply) => {
      const params = request.params as { projectId: string; subject: string; subjectId: string };
      const subject = CommentSubjectSchema.parse(params.subject);
      const body = WriteCommentBody.parse(request.body);
      const comment = await container.comments.add({
        subject,
        subjectId: params.subjectId,
        projectId: params.projectId,
        author: person(body.author),
        text: body.text,
        addressedTo: body.addressedTo ?? null,
        resolvesCommentId: body.resolvesCommentId ?? null,
      });
      reply.code(201);
      return { comment };
    },
  );

  /** Withdrawing, not removing: the row stays and every reader stops showing its text. */
  app.delete<{ Params: { commentId: string } }>(
    '/api/comments/:commentId',
    async (request) => {
      const body = DeleteCommentBody.parse(request.body ?? {});
      return { comment: await container.comments.delete(request.params.commentId, person(body.author)) };
    },
  );
}
