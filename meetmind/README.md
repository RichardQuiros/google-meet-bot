# 🧠 MeetMind AI

**Your AI teammate that joins, listens, sees, and contributes — configured for any role.**

> Built for the [Gemini Live Agent Challenge 2026](https://geminiliveagentchallenge.devpost.com/) | Category: The Live Agent

MeetMind is an AI agent that joins Google Meet sessions as a **real participant**. It hears conversations via Whisper STT, sees shared screens via Playwright screenshots, thinks via Gemini Live API, and speaks back through Piper TTS — all powered by Google ADK with bidirectional streaming.

Unlike passive transcription tools (Otter.ai, Fireflies), MeetMind is an **active participant** with multimodal awareness and configurable behavior.

## Features

- **Multimodal perception**: Audio transcripts + screen share vision simultaneously
- **Gemini Live API**: Bidirectional streaming via Google ADK with `LiveRequestQueue` and `run_live()`
- **6 configurable roles**: Devil's Advocate, Technical Reviewer, Meeting Scribe, Code Reviewer, Brainstorm Partner, Compliance Officer
- **4 participation modes**: Active, Reactive, Observer, Hybrid
- **Voice output**: Agent speaks in meetings via Piper TTS
- **Screen understanding**: Reads slides, code, diagrams, and documents shared on screen
- **Post-meeting deliverables**: Structured summaries, action items, role-specific insights
- **Real-time dashboard**: Deploy, monitor, and interact with the agent during meetings
- **Custom tools**: `take_note` and `flag_action_item` for structured meeting intelligence

## Architecture

The system has three layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: meetmind-agent (Python/FastAPI)              ← AI BRAIN   │
│  Gemini Live API + ADK | Role Engine | Dashboard | Bridge Layer     │
│                    ↕ SSE events + REST commands                     │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: meet-control-server (Node.js/Fastify)       ← EVENT BUS   │
│  SSE stream | REST API | Command queue | MeetAgent SDK              │
│                    ↕ HTTP internal                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: meet-bot (Node.js/Playwright)               ← BROWSER     │
│  Chrome + PulseAudio | Whisper STT | Piper TTS | Screenshots        │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow During a Meeting

```
Meet participants speak
    │
    ▼
meet-bot captures audio via PulseAudio → ffmpeg → Whisper STT
meet-bot captures captions via DOM observer
meet-bot captures screenshots via Playwright → JPEG
    │
    ▼ (events published to meet-control-server)
    │
SSE stream delivers to meetmind-agent:
  - audio.transcript.detected → text from speech
  - caption.segment.detected → Google's own captions
  - chat.message.detected → chat messages
  - video.frame.detected → JPEG frame metadata + URL
    │
    ▼
meetmind-agent (Gemini Live API + ADK):
  1. Receives text events → sends as text context to Gemini via send_content()
  2. Downloads JPEG frames → sends to Gemini via send_realtime()
  3. Gemini processes multimodal input with role-specific prompt
  4. Gemini decides to respond (based on participation mode)
    │
    ▼ (agent decides to speak or stay silent)
    │
  POST /bots/:botId/speak → meet-control-server → meet-bot
    → TTS → PulseAudio → virtual mic → Google Meet
    │
  OR POST /bots/:botId/chat → meet-control-server → meet-bot
    → types in Meet chat panel
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| AI Model | Gemini 2.5 Flash / Gemini Live 2.5 Flash Native Audio |
| Agent Framework | Google ADK (Bidi-streaming, `LiveRequestQueue`, `Runner`) |
| Browser | Playwright + Chrome (persistent profile, stealth plugins) |
| Agent Server | FastAPI (Python) + WebSocket |
| Dashboard | Vanilla JS served by FastAPI (no build step) |
| Audio | PulseAudio + Piper TTS + Faster Whisper STT |
| Vision | Playwright screenshots → Gemini multimodal via `send_realtime()` |
| Event Bus | Fastify (Node.js) + SSE + REST |
| Database | Firestore (optional) |
| Cloud | Google Cloud Run + Artifact Registry |

## Roles & Participation Modes

### Predefined Roles

| Role | Mode | Description |
|------|------|-------------|
| 🔥 Devil's Advocate | Active | Challenges assumptions, probes for weaknesses |
| ⚙️ Technical Reviewer | Hybrid | Evaluates feasibility, flags technical concerns |
| 📝 Meeting Scribe | Observer | Silent note-taker — captures decisions and action items |
| 💻 Code Reviewer | Hybrid | Analyzes screenshared code for bugs and issues |
| 💡 Brainstorm Partner | Active | Contributes creative ideas, builds on suggestions |
| 🛡️ Compliance Officer | Hybrid | Monitors for legal and regulatory concerns |

### Participation Modes

| Mode | Behavior |
|------|----------|
| **Active** | Speaks proactively — shares insights, asks questions |
| **Reactive** | Only speaks when directly addressed ("MeetMind, what do you think?") |
| **Observer** | Completely silent — captures notes and action items |
| **Hybrid** | Mostly listens, interjects only at key moments (trigger-based) |

## Prerequisites

- **Docker** and **Docker Compose**
- **Google Cloud account** with one of:
  - Gemini API key (from [AI Studio](https://aistudio.google.com)) OR
  - Vertex AI enabled with Application Default Credentials
- **Google account** for the bot to use (pre-authenticated Chrome profile)

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/meetmind-ai.git
cd meetmind-ai
```

### 2. Set up authentication

**Option A: Google AI + API Key (simplest)**

```bash
# Enable the Generative Language API
gcloud services enable generativelanguage.googleapis.com --project=YOUR_PROJECT

# Set environment variables
export GOOGLE_API_KEY=AIzaSy...your_key...
export GOOGLE_GENAI_USE_VERTEXAI=false
export GEMINI_LIVE_MODEL=gemini-2.5-flash
```

**Option B: Vertex AI + Application Default Credentials**

```bash
# Enable Vertex AI
gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT

# Authenticate
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT

# Set environment variables
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=us-central1
export GOOGLE_GENAI_USE_VERTEXAI=true
export GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
export GOOGLE_ADC_PATH=$HOME/.config/gcloud/application_default_credentials.json
```

### 3. Run with Docker Compose

```bash
docker compose up --build
```

This starts all three services:

| Service | URL | Description |
|---------|-----|-------------|
| meetmind-agent | `http://localhost:8080` | AI brain + dashboard |
| meet-control-server | `http://localhost:3001` | Event bus + REST API |
| meet-bot | `http://localhost:3000` | Browser runtime |

### 4. Deploy the agent

Open `http://localhost:8080` in your browser:

1. Paste a Google Meet URL
2. Select a role (e.g. "Brainstorm Partner")
3. Toggle screen vision on/off
4. Click **🚀 Deploy MeetMind Agent**

Or via API:

```bash
curl -X POST http://localhost:8080/api/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_url": "https://meet.google.com/abc-defg-hij",
    "role_id": "brainstorm_partner",
    "vision_enabled": true
  }'
```

### 5. Interact during the meeting

The dashboard shows live transcripts and agent activity. You can also send messages to the agent:

```bash
curl -X POST http://localhost:8080/api/session/message \
  -H "Content-Type: application/json" \
  -d '{"text": "Summarize the discussion so far"}'
```

### 6. End the session

```bash
curl -X POST http://localhost:8080/api/session/end
```

Returns a structured summary with notes, action items, and session statistics.

## REST API Reference

### meetmind-agent (Layer 3)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard UI |
| `GET` | `/health` | Health check |
| `POST` | `/api/deploy` | Deploy agent into a meeting |
| `GET` | `/api/session` | Get current session status |
| `POST` | `/api/session/end` | End session, get summary |
| `POST` | `/api/session/message` | Send message to agent |
| `GET` | `/api/roles` | List available roles |
| `WS` | `/ws/dashboard` | WebSocket for live events |

### meet-control-server (Layer 2)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/bots/:botId/join` | Join a Google Meet session |
| `POST` | `/bots/:botId/speak` | Speak via TTS |
| `POST` | `/bots/:botId/chat` | Send a chat message |
| `GET` | `/bots` | List registered bots |
| `GET` | `/bots/:botId/events` | List bot events |
| `GET` | `/meetings` | List all meetings |
| `GET` | `/meetings/:meetingId/events/stream` | SSE event stream (real-time) |
| `GET` | `/meetings/:meetingId/timeline` | Full meeting timeline |
| `GET` | `/meetings/:meetingId/messages` | Chat messages |
| `GET` | `/meetings/:meetingId/captions` | Caption segments |
| `GET` | `/meetings/:meetingId/audio-transcripts` | Whisper transcriptions |
| `GET` | `/meetings/:meetingId/video-frames/latest` | Latest screenshot |
| `GET` | `/meetings/:meetingId/video-frames/:frameId/image` | Download JPEG frame |

### Internal (used by meet-bot)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/internal/bots/register` | Register a bot instance |
| `POST` | `/internal/events` | Publish a meeting event |
| `GET` | `/internal/bots/:botId/commands/next` | Poll for next command |

## Environment Variables

### meetmind-agent

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | — | Gemini API key (for Google AI mode) |
| `GOOGLE_GENAI_USE_VERTEXAI` | `false` | Use Vertex AI instead of Google AI |
| `GOOGLE_CLOUD_PROJECT` | — | GCP project ID (Vertex AI mode) |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | GCP region (Vertex AI mode) |
| `GEMINI_LIVE_MODEL` | `gemini-2.5-flash` | Gemini model for Live API |
| `CONTROL_BASE_URL` | `http://localhost:3001` | Control server URL |
| `BOT_ID` | `bot-01` | Bot identifier |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8080` | Server port |

### meet-bot

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROL_BASE_URL` | `http://localhost:3001` | Control server URL |
| `ENABLE_AUDIO_INPUT` | `true` | Enable meeting audio capture |
| `ENABLE_VIDEO_INPUT` | `true` | Enable screenshot capture |
| `VIDEO_POLL_INTERVAL_MS` | `500` | Screenshot interval |
| `VIDEO_JPEG_QUALITY` | `35` | JPEG compression (0-100) |
| `STT_COMMAND` | — | Whisper STT command template |
| `FASTER_WHISPER_MODEL` | `base` | Whisper model size |
| `TTS_BACKEND` | `piper` | TTS engine |
| `SPEECH_DELIVERY_MODE` | `meeting-microphone` | Speech delivery method |

### meet-control-server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |

## Project Structure

```
meetmind/
├── meetmind-agent/                       # Layer 3: Gemini AI brain (Python)
│   ├── app/meetmind_agent/
│   │   ├── roles.py                     # 6 predefined roles + custom role factory
│   │   ├── prompts.py                   # Dynamic system prompt builder (7 sections)
│   │   └── tools.py                     # take_note, flag_action_item tools
│   ├── bridge/
│   │   ├── sse_consumer.py              # SSE client → routes events to Gemini
│   │   ├── command_sender.py            # HTTP client → sends speak/chat commands
│   │   └── frame_fetcher.py             # Downloads JPEG frames from control server
│   ├── gemini/
│   │   └── live_session.py              # Gemini Live API session via ADK
│   ├── static/
│   │   └── index.html                   # Dashboard UI (vanilla JS, no build step)
│   ├── main.py                          # FastAPI server + deploy/session endpoints
│   ├── requirements.txt
│   └── Dockerfile
│
├── meet-bot/                             # Layer 1: Browser runtime (Node.js)
│   ├── src/
│   │   ├── bot/
│   │   │   ├── MeetBot.ts               # Core Meet automation (1500+ lines)
│   │   │   ├── MeetChatObserver.ts      # Chat message observer
│   │   │   ├── MeetCaptionsObserver.ts  # Caption observer
│   │   │   ├── MeetVideoObserver.ts     # Screenshot capture
│   │   │   └── BotManager.ts            # Bot lifecycle
│   │   ├── audio/
│   │   │   ├── AudioTranscriptObserver.ts  # Audio → Whisper STT
│   │   │   └── TtsService.ts               # Piper TTS
│   │   ├── control/
│   │   │   ├── ControlClient.ts         # HTTP to control server
│   │   │   └── RuntimeAgent.ts          # Command executor
│   │   ├── media/
│   │   │   └── RtpMediaRelay.ts         # Low-latency RTP audio
│   │   └── supervisor/
│   │       └── RuntimeSupervisor.ts     # Multi-bot management
│   ├── scripts/faster_whisper_transcribe.py
│   ├── docker/runtime-entrypoint.sh     # PulseAudio + Xvfb setup
│   └── Dockerfile
│
├── meet-control-server/                  # Layer 2: Event bus + API (Node.js)
│   ├── src/
│   │   ├── server.ts                    # Fastify entry point
│   │   ├── store.ts                     # In-memory event/command store
│   │   ├── routes/public.ts             # REST + SSE endpoints
│   │   ├── routes/internal.ts           # Bot registration + events
│   │   └── sdk/
│   │       ├── MeetAgent.ts             # Client SDK for agents
│   │       ├── AgentBridge.ts           # High-level agent loop
│   │       └── RtpAudioInputSender.ts   # RTP audio sender
│   ├── examples/
│   │   ├── generic-live-agent.example.ts
│   │   └── low-latency-rtp-agent.example.ts
│   └── Dockerfile
│
├── frontend/                             # React dashboard (alternative)
│   └── src/App.jsx
├── docker-compose.yml                    # All 3 services
├── deploy-gcp.sh                         # Cloud Run deployment (IaC)
├── THIRD_PARTY_LICENSE                   # MIT license for Layers 1-2
└── README.md
```

## Building a Custom Agent

The SDK in `meet-control-server/src/sdk/` lets you build your own agent:

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
    // input.kind: 'chat' | 'caption' | 'audioTranscript' | 'videoFrame'
    // input.text: transcribed text
    // input.speaker: who said it
    if (input.kind === 'text' && /hello/i.test(input.text)) {
      return { type: 'speak', text: 'Hello! I heard you.', awaitCompletion: true };
    }
  },
  onError: (error) => console.error(error)
});
```

## Deploy to Google Cloud Run

```bash
export GCP_PROJECT_ID=your-project-id
./deploy-gcp.sh
```

This script builds all 3 container images, pushes them to Artifact Registry, and deploys to Cloud Run.

## Docker Details

When running via Docker, the meet-bot container automatically sets up:

- **Xvfb** virtual display at `:99` (Chrome runs headlessly)
- **PulseAudio** daemon with a virtual sink and virtual microphone
- **Piper TTS** with a pre-downloaded English voice model (`en_US-lessac-medium`)
- **Faster Whisper** for speech-to-text transcription
- **Google Chrome Stable** for Playwright automation

The `shm_size: 2gb` in docker-compose is required for Chrome stability.

## Google Account Setup

For meetings that require authentication:

1. Mount a persistent profile directory to the meet-bot container
2. On first run, manually log in to Google in the Chrome instance
3. The profile is saved and reused for subsequent runs

For meetings with **"Anyone with the link can join"** enabled, no authentication is needed.

## Open Source Attribution

Layers 1-2 (`meet-bot` and `meet-control-server`) are based on [google-meet-bot](https://github.com/pqrichardpq) by **Richard Quiros**, licensed under MIT. Layer 3 covers MeetMind builds upon this infrastructure by adding the Gemini AI intelligence layer, role engine, bridge layer, and dashboard by **Omar Nunez**.

## Hackathon Compliance

- [x] Uses Gemini model (`gemini-2.5-flash` / `gemini-live-2.5-flash-native-audio`)
- [x] Uses Google ADK (`LiveRequestQueue`, `Runner`, `run_live()`, `StreamingMode.BIDI`)
- [x] Uses Google Cloud (Vertex AI + Cloud Run)
- [x] Multimodal (audio transcripts + JPEG vision → Gemini → voice + chat output)
- [x] Automated cloud deployment (`deploy-gcp.sh`)
- [x] New project, open source compliant

## License

MIT
**Authors:** Richard Quiros (pqrichardpq@gmail.com) , Omar Nunez (omarnunez26@gmail.com)

---

*This project was created for the purposes of entering the Gemini Live Agent Challenge hackathon. #GeminiLiveAgentChallenge*
