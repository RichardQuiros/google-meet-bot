import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { InMemoryStore } from './store.js';
import { internalRoutes } from './routes/internal.js';
import { publicRoutes } from './routes/public.js';

export async function buildServer() {
  const app = Fastify({
    logger: true
  });

  const store = new InMemoryStore();

  await app.register(async (instance) => {
    await internalRoutes(instance, store);
    await publicRoutes(instance, store);
  });

  return app;
}

export async function start() {
  const app = await buildServer();

  await app.listen({
    port: Number.parseInt(process.env.PORT ?? '3001', 10),
    host: '0.0.0.0'
  });

  return app;
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
