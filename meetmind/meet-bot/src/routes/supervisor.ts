import type { FastifyInstance } from 'fastify';
import { RuntimeSupervisor } from '../supervisor/RuntimeSupervisor.js';

const supervisor = new RuntimeSupervisor();

function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function resolveControlBaseUrl(requestedControlBaseUrl?: string): string | undefined {
  const requested = requestedControlBaseUrl?.trim();
  const configured = process.env.CONTROL_BASE_URL?.trim();

  if (!requested) {
    return configured;
  }

  if (configured && isLoopbackUrl(requested)) {
    return configured;
  }

  return requested;
}

export async function supervisorRoutes(app: FastifyInstance) {
  app.get('/runtime/bots', async () => supervisor.listBots());

  app.get('/runtime/bots/:botId', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = supervisor.getBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Runtime bot not found' });
    }

    return bot;
  });

  app.post('/runtime/bots', async (request, reply) => {
    const body = request.body as {
      botId?: string;
      displayName: string;
      controlBaseUrl?: string;
      runtimeUrl?: string;
      autoStart?: boolean;
    };
    const controlBaseUrl = resolveControlBaseUrl(body?.controlBaseUrl);

    if (!body?.displayName || !controlBaseUrl) {
      return reply.code(400).send({
        error: 'displayName is required and controlBaseUrl must be provided either in the request body or in CONTROL_BASE_URL'
      });
    }

    const existing = body.botId ? supervisor.getBot(body.botId) : undefined;
    const normalizedRuntimeUrl = body.runtimeUrl?.trim() || undefined;
    const shouldAutoStart = body.autoStart ?? true;
    const configChanged =
      !!existing &&
      (existing.displayName !== body.displayName ||
        existing.controlBaseUrl !== controlBaseUrl ||
        existing.runtimeUrl !== normalizedRuntimeUrl);

    if (existing && !configChanged) {
      if (shouldAutoStart && !['running', 'starting'].includes(existing.state)) {
        const restarted = supervisor.startBot(existing.botId);
        return reply.code(200).send(restarted ?? existing);
      }

      return reply.code(200).send(existing);
    }

    if (existing && configChanged) {
      await supervisor.removeBot(existing.botId);
    }

    const record = supervisor.createBot({
      ...body,
      controlBaseUrl,
      runtimeUrl: normalizedRuntimeUrl,
      autoStart: shouldAutoStart
    });

    return reply.code(configChanged ? 200 : 201).send(record);
  });

  app.post('/runtime/bots/:botId/start', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = supervisor.startBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Runtime bot not found' });
    }

    return bot;
  });

  app.post('/runtime/bots/:botId/stop', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = await supervisor.stopBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Runtime bot not found' });
    }

    return bot;
  });

  app.post('/runtime/bots/:botId/restart', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = await supervisor.restartBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Runtime bot not found' });
    }

    return bot;
  });

  app.delete('/runtime/bots/:botId', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const removed = await supervisor.removeBot(botId);

    if (!removed) {
      return reply.code(404).send({ error: 'Runtime bot not found' });
    }

    return { ok: true };
  });
}
