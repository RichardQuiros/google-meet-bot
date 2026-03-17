# 🤖 Google Meet Bot

A programmable bot that joins Google Meet sessions as a real participant. It can hear conversations (via Whisper STT), see shared screens (via Playwright screenshots), speak in meetings (via Piper TTS), and type in the Meet chat — all controlled through a REST API and SDK.

## Architecture

The system has two services:

**meet-bot** (Layer 1 — Browser Runtime)
- Chrome automation via Playwright with stealth plugins
- PulseAudio virtual audio routing (sink + virtual microphone)
- Speech-to-text via Faster Whisper
- Text-to-speech via Piper
- Chat, caption, and video frame observers
- RTP media relay for low-latency audio I/O
- Bot supervisor for multi-instance management

**meet-control-server** (Layer 2 — Event Bus + API)
- SSE event stream for real-time meeting events
- REST API for sending commands (join, speak, chat)
- Command queue with long-polling
- In-memory meeting timeline and data store
- MeetAgent SDK + AgentBridge for building custom agents
- Video frame serving via HTTP

```
┌─────────────────────────────────────────────────────────────┐
│  meet-control-server (Node.js/Fastify)         ← EVENT BUS │
│  SSE stream | REST API | Command queue | MeetAgent SDK      │
│                    ↕ HTTP internal                           │
├─────────────────────────────────────────────────────────────┤
│  meet-bot (Node.js/Playwright)                 ← BROWSER   │
│  Chrome + PulseAudio | Whisper STT | Piper TTS | Screenshots│
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

- **Docker** and **Docker Compose**
- A **Google account** for the bot (pre-authenticated Chrome profile)

## Quick Start

### 1. Run with Docker Compose

```bash
docker compose up --build
```

This starts both services:

| Service | URL | Description |
|---------|-----|-------------|
| meet-control-server | `http://localhost:3001` | Event bus + REST API |
| meet-bot (supervisor) | `http://localhost:3000` | Browser runtime |

### 2. Join a Google Meet

```bash
curl -X POST http://localhost:3001/bots/bot-01/join \
  -H "Content-Type: application/json" \
  -d '{
    "meetingId": "my-meeting",
    "meetingUrl": "https://meet.google.com/abc-defg-hij",
    "displayName": "Bot-01",
    "camera": false,
    "microphone": true
  }'
```

### 3. Make the bot speak

```bash
curl -X POST http://localhost:3001/bots/bot-01/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello everyone, I have joined the meeting."}'
```

### 4. Send a chat message

```bash
curl -X POST http://localhost:3001/bots/bot-01/chat \
  -H "Content-Type: application/json" \
  -d '{"text": "Here are the meeting notes so far..."}'
```

### 5. Listen to meeting events (SSE)

```bash
curl -N http://localhost:3001/meetings/my-meeting/events/stream
```

Events you'll receive:

| Event Type | Description |
|------------|-------------|
| `audio.transcript.detected` | Speech transcribed via Whisper |
| `caption.segment.detected` | Google Meet's own captions |
| `chat.message.detected` | Messages from the Meet chat |
| `video.frame.detected` | Screenshot of the meeting screen |

## Building a Custom Agent

The SDK provides `MeetAgent` and `startAgentBridge` for building your own AI agent on top of the bot. See the examples in `meet-control-server/examples/`.

### Generic Agent

```bash
cd meet-control-server
npm run example:agent
```

```typescript
import { MeetAgent, startAgentBridge } from './src/sdk/index.js';

const agent = new MeetAgent({
  baseUrl: 'http://localhost:3001',
  meetingId: 'my-meeting',
  botId: 'bot-01'
});

await agent.connect({ snapshotLimit: 0 });

await agent.joinAndWait({
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  displayName: 'AI Agent',
  camera: false,
  microphone: true
});

startAgentBridge(agent, {
  includeVideoFrames: true,
  onInput: async (input) => {
    if (input.kind === 'text' && /hello/i.test(input.text)) {
      return { type: 'speak', text: 'Hello! I heard you.', awaitCompletion: true };
    }
  },
  onError: (error) => console.error('[agent-bridge]', error)
});
```

### Low-Latency RTP Agent

Uses RTP for direct audio I/O instead of the REST command pipeline:

```bash
cd meet-control-server
npm run example:rtp-agent
```

## REST API Reference

### Bot Commands

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/bots/:botId/join` | Join a Google Meet session |
| `POST` | `/bots/:botId/speak` | Speak via TTS in the meeting |
| `POST` | `/bots/:botId/chat` | Send a chat message |
| `GET` | `/bots` | List all registered bots |
| `GET` | `/bots/:botId` | Get bot details |
| `GET` | `/bots/:botId/events` | List bot events |
| `GET` | `/bots/:botId/commands` | List bot commands |

### Meeting Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/meetings` | List all meetings |
| `GET` | `/meetings/:meetingId` | Get meeting details |
| `GET` | `/meetings/:meetingId/events/stream` | SSE event stream (real-time) |
| `GET` | `/meetings/:meetingId/events` | List meeting events |
| `GET` | `/meetings/:meetingId/timeline` | Full meeting timeline |
| `GET` | `/meetings/:meetingId/messages` | Chat messages |
| `GET` | `/meetings/:meetingId/captions` | Caption segments |
| `GET` | `/meetings/:meetingId/audio-transcripts` | Whisper transcriptions |
| `GET` | `/meetings/:meetingId/video-events` | Video frame events |
| `GET` | `/meetings/:meetingId/video-frames/latest` | Latest screenshot metadata |
| `GET` | `/meetings/:meetingId/video-frames/:frameId/image` | Download JPEG frame |
| `GET` | `/meetings/:meetingId/commands` | List meeting commands |

### Internal (used by meet-bot)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/internal/bots/register` | Register a bot instance |
| `POST` | `/internal/events` | Publish a meeting event |
| `GET` | `/internal/bots/:botId/commands/next` | Poll for next command |
| `GET` | `/health` | Health check |

## Environment Variables

### meet-bot

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROL_BASE_URL` | `http://localhost:3001` | Control server URL |
| `PORT` | `3000` | Supervisor HTTP port |
| `ENABLE_AUDIO_INPUT` | `true` | Enable meeting audio capture |
| `AUDIO_SEGMENT_DURATION_MS` | `1200` | Audio chunk duration for STT |
| `AUDIO_SEGMENT_COOLDOWN_MS` | `50` | Cooldown between audio chunks |
| `MEET_AUDIO_INPUT_FORMAT` | `pulse` | Audio input format |
| `MEET_AUDIO_INPUT_DEVICE` | `meetbot_sink.monitor` | PulseAudio device to capture |
| `ENABLE_VIDEO_INPUT` | `true` | Enable screenshot capture |
| `CAPTURE_VIDEO_FRAMES` | `true` | Save video frames to disk |
| `VIDEO_POLL_INTERVAL_MS` | `500` | Screenshot capture interval |
| `VIDEO_JPEG_QUALITY` | `35` | JPEG compression quality (0-100) |
| `STT_COMMAND` | — | Speech-to-text command template (use `{input}` placeholder) |
| `FASTER_WHISPER_MODEL` | `base` | Whisper model size |
| `FASTER_WHISPER_DEVICE` | `cpu` | Whisper compute device |
| `TTS_BACKEND` | `piper` | TTS engine (`piper` or `windows-native`) |
| `PIPER_PATH` | `/opt/piper/piper` | Path to Piper binary |
| `PIPER_MODEL` | — | Path to Piper voice model |
| `SPEECH_DELIVERY_MODE` | `meeting-microphone` | How speech reaches the meeting |
| `AUDIO_OUTPUT_BACKEND` | `paplay` | Audio output backend |
| `AUDIO_OUTPUT_DEVICE` | `meetbot_sink` | PulseAudio output device |
| `MEET_AUDIO_SINK_NAME` | `meetbot_sink` | Virtual audio sink name |
| `MEET_AUDIO_SOURCE_NAME` | `meetbot_mic` | Virtual microphone name |
| `MEET_PREFERRED_MICROPHONE_LABEL` | `MeetBot_Virtual_Microphone` | Chrome mic selection label |
| `CHAT_POLL_INTERVAL_MS` | `250` | Chat DOM polling interval |
| `CAPTION_POLL_INTERVAL_MS` | `250` | Caption DOM polling interval |
| `COMMAND_LONG_POLL_MS` | `1000` | Command long-poll timeout |

### meet-control-server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `NODE_ENV` | `production` | Environment |

## Project Structure

```
google-meet-bot/
├── meet-bot/                             # Layer 1: Browser runtime + media
│   ├── src/
│   │   ├── bot/
│   │   │   ├── MeetBot.ts               # Core Google Meet automation (1500+ lines)
│   │   │   ├── BotManager.ts            # Bot lifecycle management
│   │   │   ├── MeetChatObserver.ts      # Chat message observer (DOM polling)
│   │   │   ├── MeetCaptionsObserver.ts  # Caption observer (DOM polling)
│   │   │   ├── MeetVideoObserver.ts     # Screenshot capture
│   │   │   └── SpeechOutputService.ts   # Speech delivery
│   │   ├── audio/
│   │   │   ├── AudioTranscriptObserver.ts  # Audio capture + Whisper STT
│   │   │   ├── TtsService.ts              # Piper TTS + Windows native
│   │   │   ├── CliSpeechToTextProvider.ts  # CLI-based STT wrapper
│   │   │   ├── LinuxAudioOutputProvider.ts # paplay output
│   │   │   └── WindowsAudioOutputProvider.ts # Windows audio output
│   │   ├── control/
│   │   │   ├── ControlClient.ts         # HTTP client to control server
│   │   │   └── RuntimeAgent.ts          # Command executor (join, speak, chat)
│   │   ├── media/
│   │   │   └── RtpMediaRelay.ts         # Low-latency RTP audio relay
│   │   ├── supervisor/
│   │   │   └── RuntimeSupervisor.ts     # Multi-bot instance management
│   │   ├── routes/
│   │   │   ├── supervisor.ts            # Supervisor HTTP routes
│   │   │   └── bots.ts                  # Bot management routes
│   │   ├── runtime.ts                   # Standalone bot entry point
│   │   └── server.ts                    # Supervisor entry point
│   ├── scripts/
│   │   └── faster_whisper_transcribe.py # Whisper STT script
│   ├── docker/
│   │   └── runtime-entrypoint.sh        # PulseAudio + Xvfb init
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
│
├── meet-control-server/                  # Layer 2: Event bus + REST API
│   ├── src/
│   │   ├── server.ts                    # Fastify entry point
│   │   ├── store.ts                     # In-memory event/command store
│   │   ├── types.ts                     # TypeScript type definitions
│   │   ├── routes/
│   │   │   ├── public.ts               # Public REST + SSE endpoints
│   │   │   └── internal.ts             # Bot registration + event ingestion
│   │   └── sdk/
│   │       ├── MeetAgent.ts            # Client SDK for building agents
│   │       ├── AgentBridge.ts          # High-level agent loop
│   │       ├── RtpAudioInputSender.ts  # RTP audio sender
│   │       └── index.ts               # SDK exports
│   ├── examples/
│   │   ├── generic-live-agent.example.ts     # Basic agent example
│   │   └── low-latency-rtp-agent.example.ts  # RTP agent example
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
│
├── docker-compose.yml                    # Both services orchestrated
└── README.md
```

## Local Development

### meet-control-server

```bash
cd meet-control-server
npm install
npm run dev          # Watch mode with auto-reload
```

### meet-bot (Supervisor mode)

```bash
cd meet-bot
npm install
npm run dev:supervisor   # Watch mode
```

### meet-bot (Standalone runtime)

```bash
cd meet-bot
npm install
npm run dev              # Single bot instance
```

### Windows Local Speech Test

```powershell
cd meet-bot
$env:DEBUG_SPEECH_OUTPUT='true'
$env:TTS_BACKEND='windows-native'
$env:SPEECH_DELIVERY_MODE='local-playback'
$env:POWERSHELL_PATH='powershell.exe'
npm run dev
```

To route speech through a virtual microphone on Windows:

```powershell
$env:SPEECH_DELIVERY_MODE='meeting-microphone'
$env:MEET_PREFERRED_MICROPHONE_LABEL='Stereo Mix (Realtek(R) Audio)'
```

## Docker Details

When running via Docker, the container automatically sets up:

- **Xvfb** virtual display at `:99` (Chrome runs headlessly)
- **PulseAudio** daemon with a virtual sink and virtual microphone
- **Piper TTS** with a pre-downloaded English voice model (`en_US-lessac-medium`)
- **Faster Whisper** for speech-to-text transcription
- **Google Chrome Stable** for Playwright automation

The `shm_size: 2gb` setting in docker-compose is required for Chrome stability.

## Google Account Setup

The bot needs a pre-authenticated Chrome profile to join meetings:

1. Mount a persistent profile directory to the container
2. On first run, manually log in to Google in the Chrome instance
3. The profile is saved and reused for subsequent runs

For meetings with **"Anyone with the link can join"** enabled, no Google authentication is needed — the bot joins as a guest.

## License

MIT

**Authors:** Richard Quiros (pqrichardpq@gmail.com) , Omar Nunez (omarnunez26@gmail.com)
