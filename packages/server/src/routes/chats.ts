import { z } from 'zod';
import type { PomniContainer } from '@pomni/core';
import type { FastifyInstance } from 'fastify';

const StartChatBody = z.object({
  text: z.string().min(1),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const SetModelBody = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});

const RenameChatBody = z.object({
  title: z.string().min(1),
});

const SendMessageBody = z.object({
  text: z.string().min(1),
});

const ListQuery = z.object({
  query: z.string().optional(),
  providerId: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const AddressablesQuery = z.object({
  projectId: z.string().optional(),
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

  /** What `#`, `@` and `/` can address, scoped to the addressed project when there is one. */
  app.get('/api/chats/addressables', async (request) => {
    const query = AddressablesQuery.parse(request.query);
    return container.chat.addressables(query.projectId ?? null);
  });

  // Returns as soon as the chat and its first message exist; the answer comes over the event
  // stream like every later one. Waiting for it here is what made the first message look
  // like a hang: the browser had no chat to show until the model had finished thinking.
  app.post('/api/chats', async (request, reply) => {
    const body = StartChatBody.parse(request.body);
    const { chat } = await container.chat.open(body);
    reply.code(201);
    return { chat };
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
    return { chat: await container.chat.setModel(request.params.id, body) };
  });

  app.patch<{ Params: { id: string } }>('/api/chats/:id/title', async (request) => {
    const body = RenameChatBody.parse(request.body);
    return { chat: await container.chat.rename(request.params.id, body.title) };
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
