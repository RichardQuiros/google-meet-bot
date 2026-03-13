# Google Meet Live Agent Bot System

Linux-first MVP for running autonomous AI agents inside Google Meet sessions with near-live text, audio, and video ingestion.

The repository has two services:

- `meet-control-server`: control plane, session history, command API, SSE stream, lightweight SDK.
- `meet-bot`: runtime supervisor and runtime agents that launch Chrome with Playwright, join Meet, observe the call, and execute actions.

## What Works

- Join a Google Meet session
- Send chat messages
- Read chat messages
- Read captions
- Capture meeting audio and emit `audio.transcript.detected`
- Capture video frames and emit `video.frame.detected`
- Speak into the meeting through TTS + virtual microphone routing
- Stream everything to an external agent through SSE

## Recommended Deployment

The main entrypoint is Docker Compose:

```bash
docker compose up --build -d
```

This starts:

- `meet-control-server` on `http://localhost:3001`
- `meet-bot` supervisor on `http://localhost:3000`

The bot image already includes:

- Google Chrome
- `ffmpeg`
- PulseAudio + PipeWire
- `Xvfb`
- Piper
- a default Piper voice model
- faster-whisper runtime

No extra model mount is required for the default stack.

## Quick Start

1. Start the stack:

```bash
docker compose up --build -d
```

2. Check health:

```bash
docker compose ps
docker compose logs -f meet-bot
```

3. Create a runtime bot through the supervisor:

```http
POST http://localhost:3000/runtime/bots
Content-Type: application/json

{
  "botId": "bot-01",
  "displayName": "Agent-01",
  "autoStart": true
}
```

Important:

- In Docker, prefer omitting `controlBaseUrl` entirely. The supervisor falls back to its own `CONTROL_BASE_URL`, which is already set to `http://meet-control-server:3001` by the bundled `docker-compose.yml`.
- If you do send `controlBaseUrl` from host tools like Postman and accidentally use `http://localhost:3001`, the supervisor now normalizes that loopback URL to the internal Docker URL automatically.

4. Join a meeting:

```http
POST http://localhost:3001/bots/bot-01/join
Content-Type: application/json

{
  "meetingId": "demo-meeting",
  "meetingUrl": "https://meet.google.com/xxx-xxxx-xxx",
  "displayName": "Agent-01",
  "camera": false,
  "microphone": true
}
```

5. Subscribe to the live stream:

```http
GET http://localhost:3001/meetings/demo-meeting/events/stream?snapshotLimit=0
```

6. Interact:

- `POST /bots/:botId/chat`
- `POST /bots/:botId/speak`
- `GET /meetings/:meetingId/messages`
- `GET /meetings/:meetingId/audio-transcripts`
- `GET /meetings/:meetingId/video-frames/latest`

## Docker Behavior

The compose file is tuned for agent consumption with low latency defaults:

- command long-polling enabled
- chat polling at `500ms`
- caption polling at `400ms`
- audio segments at `2500ms`
- video frame polling at `700ms`
- video activity disabled by default to favor frame throughput
- JPEG quality lowered to reduce payload size

The `meet-bot` container also prepares virtual audio devices automatically:

- sink name: `meetbot_sink`
- microphone source name: `meetbot_mic`
- microphone label in Meet: `MeetBot Virtual Microphone`

So `speech.say` is routed to the virtual sink, and the runtime tries to select `MeetBot Virtual Microphone` inside Meet before speaking.

State is persisted in the Docker volume:

- `meet-bot-data` mounted to `/app/tmp`

That volume contains browser profiles, TTS output, audio segments, screenshots, and video frames.

## Main APIs

### Runtime Supervisor

Base URL: `http://localhost:3000`

- `GET /health`
- `POST /runtime/bots`
- `GET /runtime/bots`
- `GET /runtime/bots/:botId`
- `POST /runtime/bots/:botId/start`
- `POST /runtime/bots/:botId/stop`
- `POST /runtime/bots/:botId/restart`
- `DELETE /runtime/bots/:botId`

### Control Server

Base URL: `http://localhost:3001`

- `GET /health`
- `GET /bots`
- `GET /bots/:botId`
- `POST /bots/:botId/join`
- `POST /bots/:botId/chat`
- `POST /bots/:botId/speak`
- `GET /bots/:botId/commands`
- `GET /bots/:botId/events`
- `GET /commands/:commandId`
- `GET /meetings`
- `GET /meetings/:meetingId`
- `GET /meetings/:meetingId/messages`
- `GET /meetings/:meetingId/captions`
- `GET /meetings/:meetingId/audio-transcripts`
- `GET /meetings/:meetingId/video-events`
- `GET /meetings/:meetingId/video-frames/latest`
- `GET /meetings/:meetingId/video-frames/:frameId/image`
- `GET /meetings/:meetingId/commands`
- `GET /meetings/:meetingId/events`
- `GET /meetings/:meetingId/timeline`
- `GET /meetings/:meetingId/events/stream`

### Internal Runtime API

Used by runtime processes:

- `POST /internal/bots/register`
- `POST /internal/events`
- `GET /internal/bots/:botId/commands/next`

The command endpoint supports long polling through `waitMs`.

## Agent-Focused Usage

The control server ships a lightweight SDK at:

- `meet-control-server/src/sdk/MeetAgent.ts`
- `meet-control-server/src/sdk/AgentBridge.ts`

The lowest-latency pattern is:

```ts
import { MeetAgent, startAgentBridge } from './src/sdk/index.js';

const agent = new MeetAgent({
  baseUrl: 'http://localhost:3001',
  meetingId: 'demo-meeting',
  botId: 'bot-01'
});

await agent.connect({ snapshotLimit: 0 });

const stop = startAgentBridge(agent, {
  includeVideoFrames: true,
  onInput: async (input) => {
    if (input.kind === 'text' && /hello/i.test(input.text)) {
      return {
        type: 'chat',
        text: 'Hello from the agent bridge'
      };
    }

    if (input.kind === 'image') {
      console.log('latest frame', input.frameId, input.image.byteLength);
    }
  },
  onError: (error) => {
    console.error(error);
  }
});
```

Key SDK helpers:

- `connect({ snapshotLimit: 0 })`
- `joinAndWait(...)`
- `chatAndWait(...)`
- `sayAndWait(...)`
- `waitForCommand(commandId)`
- `startLiveInputs(...)`
- `startLiveVideoFrames(...)`
- `startLiveSession(...)`
- `startAgentBridge(...)`

Reference material for AI integrations:

- `README_IA.md`
- `meet-control-server/examples/generic-live-agent.example.ts`
- `npm --prefix meet-control-server run example:agent`

## Postman

The collection is:

- `meet-bot/postman.json`

It includes:

- supervisor endpoints
- control API endpoints
- internal runtime endpoints
- live SSE request with `snapshotLimit=0`
- latest video frame endpoints

Important Postman variables:

- `runtimeSupervisorUrl=http://localhost:3000`
- `controlServerUrl=http://localhost:3001`
- `runtimeControlBaseUrl=http://meet-control-server:3001`

Use `runtimeControlBaseUrl` when creating runtime bots from the supervisor while everything is running in Docker.

## Local Development

Control server:

```bash
cd meet-control-server
npm install
npm run dev
```

Runtime supervisor:

```bash
cd meet-bot
npm install
npm run dev:supervisor
```

Standalone runtime:

```bash
cd meet-bot
npm run dev
```

## Notes and Constraints

- The bot is optimized for Linux containers and Linux hosts.
- Google Meet access still depends on the account and meeting policy.
- Some meetings allow guest join immediately; others may require a previously trusted profile or admission.
- The Docker volume persists the Playwright profile, which is important for keeping browser trust and Meet device preferences across restarts.
- Video transport is JPEG-over-HTTP today. It is tuned for near-live agent consumption, but it is not WebRTC streaming.
