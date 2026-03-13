import {
  MeetAgent,
  startAgentBridge,
  type AgentBridgeAction,
  type AgentBridgeInput
} from '../src/sdk/index.js';

async function decideActions(input: AgentBridgeInput): Promise<AgentBridgeAction | void> {
  if (input.kind === 'text' && /hello|hola/i.test(input.text)) {
    return {
      type: 'chat',
      text: `I received "${input.text}" from ${input.speaker}.`,
      awaitCompletion: true
    };
  }

  if (input.kind === 'text' && /explain|summary/i.test(input.text)) {
    return {
      type: 'speak',
      text: 'I am processing the request and will respond shortly.',
      awaitCompletion: true
    };
  }

  return;
}

async function main(): Promise<void> {
  const baseUrl = process.env.CONTROL_SERVER_URL ?? 'http://localhost:3001';
  const meetingId = process.env.MEETING_ID ?? 'demo-meeting';
  const botId = process.env.BOT_ID ?? 'bot-01';
  const meetingUrl = process.env.MEETING_URL;

  const agent = new MeetAgent({
    baseUrl,
    meetingId,
    botId
  });

  await agent.connect({ snapshotLimit: 0 });

  if (meetingUrl) {
    await agent.joinAndWait({
      meetingUrl,
      displayName: process.env.BOT_DISPLAY_NAME ?? 'Agent-01',
      camera: false,
      microphone: true
    });
  }

  const stop = startAgentBridge(agent, {
    includeVideoFrames: true,
    onInput: decideActions,
    onError: (error) => {
      console.error('[agent-bridge]', error);
    }
  });

  console.log('Agent bridge running', {
    baseUrl,
    meetingId,
    botId
  });

  const shutdown = () => {
    stop();
    agent.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
