import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { botRoutes } from './routes/bots.js';
import { supervisorRoutes } from './routes/supervisor.js';

export async function buildServer() {
  const app = Fastify({ logger: true });

  app.addContentTypeParser(
    ['application/x-www-form-urlencoded', 'application/octet-stream'],
    { parseAs: 'string' },
    (request, body, done) => {
      const rawBody = typeof body === 'string' ? body.trim() : body.toString('utf8').trim();

      if (!rawBody) {
        done(null, {});
        return;
      }

      if (request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        done(null, Object.fromEntries(new URLSearchParams(rawBody).entries()));
        return;
      }

      done(null, { rawBody });
    }
  );

  app.get('/health', async () => ({
    ok: true,
    service: 'meet-bot-supervisor',
    timestamp: new Date().toISOString()
  }));

  await app.register(botRoutes);
  await app.register(supervisorRoutes);

  return app;
}

export async function start() {
  const app = await buildServer();

  await app.listen({
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    host: '0.0.0.0'
  });
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
