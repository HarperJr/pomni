import { z } from 'zod';
import type { PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const CreateChatBody = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  title: z.string().optional(),
});

const SetModelBody = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});

const SendMessageBody = z.object({
  text: z.string().min(1),
});

const ListQuery = z.object({
  query: z.string().optional(),
  providerId: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export async function chatRoutes(app: FastifyInstance, container: PomniContainer): Promise<void> {
  app.get('/api/chats', async (request) => {
    const query = ListQuery.parse(request.query);
    return {
      chats: await container.chat.list({
        query: query.query,
        providerId: query.providerId,
        limit: query.limit,
      }),
    };
  });

  app.post('/api/chats', async (request, reply) => {
    const body = CreateChatBody.parse(request.body);
    reply.code(201);
    return { chat: await container.chat.create(body) };
  });

  app.get<{ Params: { id: string } }>('/api/chats/:id', async (request) => ({
    chat: await container.chat.get(request.params.id),
  }));

  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (request, reply) => {
    await container.chat.remove(request.params.id);
    reply.code(204);
  });

  app.patch<{ Params: { id: string } }>('/api/chats/:id/model', async (request) => {
    const body = SetModelBody.parse(request.body);
    return { chat: await container.chat.setModel(request.params.id, body.providerId, body.model) };
  });

  app.post<{ Params: { id: string } }>('/api/chats/:id/messages', async (request, reply) => {
    const body = SendMessageBody.parse(request.body);
    reply.code(201);
    return { message: await container.chat.sendMessage(request.params.id, body.text) };
  });

  app.post<{ Params: { id: string; messageId: string; actionId: string } }>(
    '/api/chats/:id/messages/:messageId/actions/:actionId/confirm',
    async (request) => ({
      message: await container.chat.confirmAction(
        request.params.id,
        request.params.messageId,
        request.params.actionId,
      ),
    }),
  );

  app.post<{ Params: { id: string; messageId: string; actionId: string } }>(
    '/api/chats/:id/messages/:messageId/actions/:actionId/reject',
    async (request) => ({
      message: await container.chat.rejectAction(
        request.params.id,
        request.params.messageId,
        request.params.actionId,
      ),
    }),
  );
}
