import { RuntimeAgent } from './control/RuntimeAgent.js';

async function main() {
  const botId = process.env.BOT_ID || 'bot-01';
  const displayName = process.env.BOT_DISPLAY_NAME || 'Agent-01';
  const controlBaseUrl = process.env.CONTROL_BASE_URL || 'http://localhost:3001';

  const agent = new RuntimeAgent({
    botId,
    displayName,
    controlBaseUrl,
    pollIntervalMs: Number.parseInt(process.env.COMMAND_LONG_POLL_MS ?? '3000', 10)
  });

  process.on('SIGINT', async () => {
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await agent.stop();
    process.exit(0);
  });

  await agent.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
