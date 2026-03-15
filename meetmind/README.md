# 🧠 MeetMind AI

**Your AI teammate that joins, listens, sees, and contributes — configured for any role.**

> Built for the [Gemini Live Agent Challenge 2026](https://geminiliveagentchallenge.devpost.com/) | Category: The Live Agent

## What is MeetMind?

MeetMind is an AI agent that joins Google Meet sessions as a **real participant**. It hears conversations, sees shared screens in real-time, and contributes based on a configurable role/persona — powered by **Gemini Live API** and **Google ADK**.

Unlike passive transcription tools (Otter.ai, Fireflies), MeetMind is an **active participant** with multimodal awareness.

## Features

- **Multimodal perception**: Audio transcripts + screen share vision simultaneously
- **6 configurable roles**: Devil's Advocate, Technical Reviewer, Meeting Scribe, Code Reviewer, Brainstorm Partner, Compliance Officer
- **4 participation modes**: Active, Reactive, Observer, Hybrid
- **Voice output**: Agent speaks in meetings via TTS
- **Screen understanding**: Reads slides, code, diagrams, and documents shared on screen
- **Post-meeting deliverables**: Structured summaries, action items, role-specific insights
- **Real-time dashboard**: Deploy, monitor, and interact with the agent during meetings

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Layer 3: meetmind-agent (Python/FastAPI)     ← GEMINI BRAIN │
│  Gemini Live API + ADK | Role Engine | React Dashboard       │
│              ↕ SSE events + REST commands                     │
├───────────────────────────────────────────────────────────────┤
│  Layer 2: meet-control-server (Node.js)       ← EVENT BUS    │
│  SSE stream | REST API | Command queue | Timeline            │
│              ↕ HTTP internal                                  │
├───────────────────────────────────────────────────────────────┤
│  Layer 1: meet-bot (Node.js/Playwright)       ← BROWSER      │
│  Chrome automation | PulseAudio | STT | TTS | Screenshots    │
└───────────────────────────────────────────────────────────────┘
```

### Data Flow
```
Meet participants speak → meet-bot captures audio → Whisper STT → transcript
Meet screen shared → meet-bot screenshots → JPEG frames
    ↓ (SSE events via meet-control-server)
meetmind-agent receives text + images → Gemini Live API processes with role prompt
    ↓ (Gemini decides to respond)
POST /speak → meet-control-server → meet-bot → TTS → PulseAudio → Meet
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| AI Model | Gemini Live 2.5 Flash Native Audio (Live API) |
| Agent Framework | Google ADK (Bidi-streaming) |
| Browser | Playwright + Chrome (persistent profile) |
| Agent Server | FastAPI (Python) + WebSocket |
| Frontend | React + Vite |
| Audio | PulseAudio + Piper TTS + Whisper STT |
| Vision | Playwright screenshots → Gemini multimodal |
| Database | Firestore |
| Cloud | Google Cloud Run |

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Google Cloud account with Gemini API key
- Google account for the bot to use

### 1. Clone and configure
```bash
git clone https://github.com/YOUR_USERNAME/meetmind.git
cd meetmind

# Configure your Gemini API key
cp meetmind-agent/.env.example meetmind-agent/.env
# Edit .env and set GOOGLE_API_KEY
```

### 2. Run with Docker Compose
```bash
# Set your API key
export GOOGLE_API_KEY=your_key_here

# Launch all 3 services
docker-compose up --build
```

Services:
- **meet-bot**: http://localhost:3000
- **meet-control-server**: http://localhost:3001
- **meetmind-agent (dashboard)**: http://localhost:8080

### 3. Deploy the agent
Open http://localhost:8080, select a role, paste a Meet link, and click Deploy.

Or via API:
```bash
curl -X POST http://localhost:8080/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"meeting_url": "https://meet.google.com/abc-defg-hij", "role_id": "technical_reviewer"}'
```

### Deploy to Google Cloud Run
```bash
export GCP_PROJECT_ID=your-project-id
export GOOGLE_API_KEY=your-key
./deploy-gcp.sh
```

## Project Structure
```
meetmind/
├── meet-bot/                  # Layer 1: Browser + media runtime (MIT, Richard Quiros)
├── meet-control-server/       # Layer 2: Event bus + control API (MIT, Richard Quiros)
├── meetmind-agent/            # Layer 3: Gemini AI brain (our code)
│   ├── app/meetmind_agent/    # Role engine, prompts, tools
│   ├── bridge/                # SSE consumer, command sender, frame fetcher
│   ├── gemini/                # Gemini Live API session management
│   ├── main.py                # FastAPI server
│   └── Dockerfile
├── frontend/                  # React dashboard
├── docker-compose.yml         # All 3 services
└── deploy-gcp.sh              # Cloud Run deployment (IaC)
```

## Open Source Attribution

Layers 1-2 (`meet-bot` and `meet-control-server`) are based on [google-meet-bot](https://github.com/...) by **Richard Quiros**, licensed under MIT. MeetMind builds upon this infrastructure by adding the Gemini AI intelligence layer, role engine, and dashboard.

## Hackathon Compliance

- [x] Uses Gemini model (gemini-live-2.5-flash-native-audio)
- [x] Uses Google ADK (Agent Development Kit)
- [x] Uses Google Cloud (Firestore + Cloud Run)
- [x] Multimodal (audio + vision)
- [x] Automated cloud deployment (deploy-gcp.sh)
- [x] New project, open source compliant

## License

MIT

---

*This project was created for the purposes of entering the Gemini Live Agent Challenge hackathon. #GeminiLiveAgentChallenge*
