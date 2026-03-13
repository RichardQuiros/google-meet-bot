# meet-bot

Runtime supervisor and runtime agents for Google Meet.

## Recommended Way To Run

Use the root Docker Compose file:

```bash
docker compose up --build -d
```

The `meet-bot` service exposes the supervisor at `http://localhost:3000`.

## Local Development

Supervisor:

```bash
npm install
npm run dev:supervisor
```

Standalone runtime:

```bash
npm install
npm run dev
```

## Important Defaults In Docker

- Chrome runs inside `Xvfb`
- PulseAudio + PipeWire start automatically
- a virtual sink and virtual microphone are created automatically
- default preferred Meet microphone label is `MeetBot Virtual Microphone`
- Piper and a default English voice model are already present

## Local Windows Speech Smoke Test

```powershell
$env:DEBUG_SPEECH_OUTPUT='true'
$env:TTS_BACKEND='windows-native'
$env:SPEECH_DELIVERY_MODE='local-playback'
$env:POWERSHELL_PATH='powershell.exe'
npm run dev
```

If you want the meeting itself to hear the bot on Windows, use a loopback or virtual microphone and set:

```powershell
$env:SPEECH_DELIVERY_MODE='meeting-microphone'
$env:MEET_PREFERRED_MICROPHONE_LABEL='Mezcla estereo (Realtek(R) Audio)'
```
