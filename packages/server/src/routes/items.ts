import { z } from 'zod';
import {
  ACTIVE_STATUSES,
  EstimateSchema,
  ItemStatusSchema,
  ItemTypeSchema,
  PrioritySchema,
  type ItemStatus,
  type PomniContainer,
} from '@pomni/core';
import type { FastifyInstance } from 'fastify';
import { normalizeEtag } from './projects.js';

const CreateItemBody = z.object({
  title: z.string().min(1),
  type: ItemTypeSchema.optional(),
  priority: PrioritySchema.optional(),
  estimate: EstimateSchema.optional(),
  repos: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  body: z.string().optional(),
});

const UpdateItemBody = z.object({
  title: z.string().min(1).optional(),
  type: ItemTypeSchema.optional(),
  priority: PrioritySchema.optional(),
  estimate: EstimateSchema.nullable().optional(),
  repos: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  branch: z.string().nullable().optional(),
  body: z.string().optional(),
  order: z.number().optional(),
});

const TransitionBody = z.object({
  to: ItemStatusSchema,
  comment: z.string().optional(),
  /** Older alias for `comment`; kept because every existing caller already passes it. */
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

const PreviewTransitionsBody = z.object({
  body: z.string(),
});

const ChecklistBody = z.object({
  key: z.string().min(1),
  ticked: z.boolean(),
});

const ListQuery = z.object({
  status: z.string().optional(),
  type: ItemTypeSchema.optional(),
  priority: PrioritySchema.optional(),
  label: z.string().optional(),
  repo: z.string().optional(),
  q: z.string().optional(),
});

export async function itemRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/projects/:id/items', async (request) => {
    const query = ListQuery.parse(request.query);
    return {
      items: await container.backlog.list({
        projectId: request.params.id,
        status: parseStatus(query.status),
        type: query.type,
        priority: query.priority,
        label: query.label,
        repo: query.repo,
        query: query.q,
      }),
    };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/items', async (request, reply) => {
    const body = CreateItemBody.parse(request.body);
    const item = await container.backlog.create(request.params.id, body);
    reply.code(201);
    return { item };
  });

  app.get<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId',
    async (request, reply) => {
      const ref = await container.backlog.getRef(request.params.id, request.params.itemId);
      reply.header('ETag', ref.rev);
      return {
        item: await container.backlog.get(request.params.id, request.params.itemId),
        rev: ref.rev,
      };
    },
  );

  app.patch<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId',
    async (request) => {
      const patch = UpdateItemBody.parse(request.body);
      const item = await container.backlog.update(
        request.params.id,
        request.params.itemId,
        patch,
        normalizeEtag(request.headers['if-match']),
      );
      return { item };
    },
  );

  /**
   * Transitions are a separate route rather than a PATCH of `status`, because they run the
   * state machine and its guards — a client should not be able to skate past them by
   * writing the field directly.
   */
  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId/transition',
    async (request) => {
      const body = TransitionBody.parse(request.body);
      const item = await container.backlog.transition(
        request.params.id,
        request.params.itemId,
        body.to,
        { comment: body.comment, reason: body.reason, force: body.force },
      );
      return { item };
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId/transitions/preview',
    async (request) => {
      const body = PreviewTransitionsBody.parse(request.body);
      return {
        allowedTransitions: await container.backlog.previewTransitions(
          request.params.id,
          request.params.itemId,
          body.body,
        ),
      };
    },
  );

  app.post<{ Params: { id: string; itemId: string }; Body: { reason?: string } }>(
    '/api/projects/:id/items/:itemId/block',
    async (request) => ({
      item: await container.backlog.block(
        request.params.id,
        request.params.itemId,
        request.body?.reason ?? '',
      ),
    }),
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId/unblock',
    async (request) => ({
      item: await container.backlog.unblock(request.params.id, request.params.itemId),
    }),
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId/checklist',
    async (request) => {
      const body = ChecklistBody.parse(request.body);
      const item = await container.backlog.tickChecklist(
        request.params.id,
        request.params.itemId,
        body.key,
        body.ticked,
      );
      return { item };
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/items/:itemId',
    async (request, reply) => {
      await container.backlog.remove(request.params.id, request.params.itemId);
      reply.code(204);
    },
  );

  app.post<{ Params: { id: string }; Body: { status: ItemStatus; orderedIds: string[] } }>(
    '/api/projects/:id/items/reorder',
    async (request, reply) => {
      const body = z
        .object({ status: ItemStatusSchema, orderedIds: z.array(z.string()) })
        .parse(request.body);
      await container.backlog.reorder(request.params.id, body.status, body.orderedIds);
      reply.code(204);
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/items-next', async (request) => ({
    item: await container.backlog.next(request.params.id),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id/items-flow', async (request) => ({
    flow: await container.backlog.flow(request.params.id),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id/items-waves', async (request) => ({
    plan: await container.backlog.waves(request.params.id),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id/items-eligible', async (request) => {
    const query = ListQuery.parse(request.query);
    return {
      eligible: await container.backlog.eligibleItems({
        projectId: request.params.id,
        status: parseStatus(query.status),
        type: query.type,
        priority: query.priority,
        label: query.label,
        repo: query.repo,
        query: query.q,
      }),
    };
  });
}

function parseStatus(value: string | undefined): ItemStatus[] | ItemStatus | undefined {
  if (!value) return undefined;
  if (value === 'active') {
    // The built-in vocabulary's active statuses. A project's own flow can name others, but
    // this alias is a convenience for the common case, not a per-project computation — doing
    // that would mean fetching the project's flow on every list call.
    return [...ACTIVE_STATUSES];
  }
  const parsed = ItemStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
