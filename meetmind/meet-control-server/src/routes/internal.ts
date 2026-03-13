import type { FastifyInstance } from 'fastify';
import type { BotEvent, BotRegistration } from '../types.js';
import { InMemoryStore } from '../store.js';

export async function internalRoutes(app: FastifyInstance, store: InMemoryStore) {
  app.post('/internal/bots/register', async (request, reply) => {
    const body = request.body as BotRegistration;

    if (!body?.botId || !body?.displayName) {
      return reply.code(400).send({
        error: 'botId and displayName are required'
      });
    }

    const bot = store.registerBot(body);

    store.appendEvent({
      type: 'bot.registered',
      botId: bot.botId,
      meetingId: bot.meetingId,
      payload: {
        displayName: bot.displayName,
        runtimeUrl: bot.runtimeUrl,
        metadata: bot.metadata
      },
      timestamp: new Date().toISOString()
    });

    return reply.code(201).send(bot);
  });

  app.post('/internal/events', async (request, reply) => {
    const body = request.body as BotEvent;

    if (!body?.type || !body?.botId || !body?.timestamp) {
      return reply.code(400).send({
        error: 'Invalid event payload'
      });
    }

    store.appendEvent(body);
    return reply.send({ ok: true });
  });

  app.get('/internal/bots/:botId/commands/next', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const { waitMs } = request.query as { waitMs?: string | number };

    const bot = store.getBot(botId);
    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    const parsedWaitMs =
      typeof waitMs === 'number'
        ? waitMs
        : typeof waitMs === 'string'
          ? Number.parseInt(waitMs, 10)
          : 0;

    return reply.send({
      command: await store.waitForNextCommand(
        botId,
        Number.isFinite(parsedWaitMs) ? Math.max(0, Math.min(parsedWaitMs, 30000)) : 0
      )
    });
  });
}
