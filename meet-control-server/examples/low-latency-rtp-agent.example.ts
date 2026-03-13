import {
  MeetAgent,
  RtpAudioInputSender,
  startAgentBridge,
  type AgentBridgeAction,
  type AgentBridgeInput,
  type RealtimeTransportReadyEvent
} from '../src/sdk/index.js';

async function decideActions(input: AgentBridgeInput): Promise<AgentBridgeAction | void> {
  if (input.kind === 'text' && /hola|hello/i.test(input.text)) {
    return {
      type: 'chat',
      text: `Recibi "${input.text}" de ${input.speaker}.`
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

  agent.on('mediaTransportFailed', (event) => {
    console.error('[rtp-transport]', event);
  });

  const transport = await agent.waitForMediaTransport(
    Number.parseInt(process.env.MEDIA_TRANSPORT_WAIT_MS ?? '45000', 10)
  );

  logTransport(transport);

  const audioInput = transport.payload.transport.audioInput
    ? new RtpAudioInputSender(transport.payload.transport.audioInput, {
        targetHost: process.env.RTP_AUDIO_TARGET_HOST
      })
    : undefined;

  const stop = startAgentBridge(agent, {
    includeVideoFrames: false,
    onInput: decideActions,
    onError: (error) => {
      console.error('[agent-bridge]', error);
    }
  });

  console.log('Low-latency RTP agent ready', {
    baseUrl,
    meetingId,
    botId,
    audioInputTarget: audioInput?.getTarget()
  });

  console.log(
    'Feed PCM16 mono chunks from your provider by calling audioInput.writePcm(chunk).'
  );

  const shutdown = async () => {
    stop();
    await audioInput?.close().catch(() => {});
    agent.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

function logTransport(event: RealtimeTransportReadyEvent): void {
  console.log('Realtime transport ready', {
    audioInput: event.payload.transport.audioInput,
    meetingAudioOutput: event.payload.transport.meetingAudioOutput,
    videoOutput: event.payload.transport.videoOutput
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
