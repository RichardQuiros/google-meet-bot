import type { FastifyInstance } from 'fastify';
import { BotManager } from '../bot/BotManager.js';

const manager = new BotManager();

export async function botRoutes(app: FastifyInstance) {
  app.post('/bots', async (request, reply) => {
    const body = request.body as {
      displayName: string;
      meetingUrl: string;
    };

    if (!body?.displayName || !body?.meetingUrl) {
      return reply.code(400).send({
        error: 'displayName and meetingUrl are required'
      });
    }

    const bot = manager.create(body);
    return reply.code(201).send(bot);
  });

  app.get('/bots', async () => {
    return manager.list();
  });

  app.get('/bots/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const bot = manager.get(id);

    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    return bot.record;
  });

  app.post('/bots/:id/join', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      camera?: boolean;
      microphone?: boolean;
    };

    const bot = await manager.join(id, body);

    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    return bot;
  });

  app.delete('/bots/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await manager.remove(id);

    if (!ok) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    return { ok: true };
  });
}