# README IA

Guia de integracion para conectar un agente de IA al sistema de bots de Google Meet.

Este documento esta pensado para equipos que van a usar un agente externo, por ejemplo una integracion propia, ADK, Gemini Live o cualquier runtime multimodal que pueda:

- recibir texto e imagenes casi en tiempo real
- decidir acciones
- devolver respuestas por chat o por voz
- emitir audio PCM de forma continua para respuesta ultrarrapida

## Modelo de Integracion

El sistema expone dos capas:

1. Transporte del meeting:

- `meet-bot` entra a Google Meet
- captura chat, captions, audio y video
- ejecuta acciones como `chat.send` y `speech.say`

2. Capa de control para la IA:

- `meet-control-server` normaliza eventos
- expone SSE para entradas live
- expone REST para comandos y consultas
- incluye SDK y un bridge generico para agentes

3. Plano de medios low-latency:

- `meet-bot` puede abrir RTP para audio del meeting
- `meet-bot` puede recibir audio RTP del agente y reproducirlo directo en Meet
- `meet-bot` puede reenviar frames JPEG por RTP a baja frecuencia

## Formas de Consumirlo

### Opcion 1: SSE + REST directo

Util si ya tienes un runtime propio.

- suscribete a `GET /meetings/:meetingId/events/stream?snapshotLimit=0`
- recibe eventos `chat.message.detected`, `caption.segment.detected`, `audio.transcript.detected`, `video.frame.detected`
- envia acciones con:
  - `POST /bots/:botId/chat`
  - `POST /bots/:botId/speak`

### Opcion 2: SDK `MeetAgent`

Util si quieres trabajar con una abstraccion ligera sin manejar SSE a mano.

Archivos:

- `meet-control-server/src/sdk/MeetAgent.ts`
- `meet-control-server/src/sdk/index.ts`

Helpers utiles:

- `connect({ snapshotLimit: 0 })`
- `joinAndWait(...)`
- `chatAndWait(...)`
- `sayAndWait(...)`
- `startLiveInputs(...)`
- `startLiveVideoFrames(...)`
- `startLiveSession(...)`

### Opcion 3: `startAgentBridge`

Es la opcion recomendada para agentes live.

Archivos:

- `meet-control-server/src/sdk/AgentBridge.ts`
- `meet-control-server/examples/generic-live-agent.example.ts`

Esta capa convierte los eventos del meeting a un contrato simple de IA y ejecuta automaticamente las acciones que el agente devuelva.

### Opcion 4: RTP directo para audio/video

Es la opcion recomendada cuando buscas la menor latencia posible.

Flujo:

- SSE sigue siendo el canal de control y texto
- `media.transport.ready` anuncia el descriptor RTP disponible
- el agente envia PCM16 mono al bot con `RtpAudioInputSender`
- el bot reenvia audio del meeting y frames por RTP si configuras sus destinos

## Contrato de Entradas Para IA

El bridge entrega dos tipos de input:

### Texto

```ts
type AgentBridgeTextInput = {
  kind: 'text';
  modality: 'chat' | 'caption' | 'audioTranscript';
  text: string;
  speaker: string;
  occurredAt: string;
  raw: LiveInputEvent;
};
```

### Imagen

```ts
type AgentBridgeImageInput = {
  kind: 'image';
  modality: 'videoFrame';
  frameId: string;
  occurredAt: string;
  image: ArrayBuffer;
  imageUrl: string;
  mimeType: 'image/jpeg';
  raw: LiveVideoFrame;
};
```

## Contrato de Salidas Del Agente

El agente puede devolver acciones de alto nivel:

```ts
type AgentBridgeAction =
  | {
      type: 'chat';
      text: string;
      awaitCompletion?: boolean;
      timeoutMs?: number;
    }
  | {
      type: 'speak';
      text: string;
      voice?: string;
      rate?: number;
      pitch?: number;
      volume?: number;
      awaitCompletion?: boolean;
      timeoutMs?: number;
    };
```

Recomendacion:

- usa `chat` para acuses rapidos y datos estructurados
- usa `speak` para participacion conversacional dentro de la reunion
- si necesitas responder extremadamente rapido, puedes poner `awaitCompletion: false`
- si el proveedor ya genera audio PCM, evita `speak` y usa el canal RTP directo

## Evento de Transporte Realtime

Cuando el runtime entra al meeting y tiene RTP configurado emite:

```ts
type MediaTransportReadyEvent = {
  type: 'media.transport.ready';
  payload: {
    transport: {
      audioInput?: {
        transport: 'rtp';
        host: string;
        port: number;
        codec: 'L16';
        sampleRate: number;
        channels: number;
        direction: 'recvonly';
        sdp: string;
      };
      meetingAudioOutput?: {
        transport: 'rtp';
        host: string;
        port: number;
        codec: 'L16';
        sampleRate: number;
        channels: number;
        direction: 'sendonly';
        sdp: string;
      };
      videoOutput?: {
        transport: 'rtp';
        host: string;
        port: number;
        codec: 'JPEG';
        fps: number;
        direction: 'sendonly';
        sdp: string;
      };
    };
  };
};
```

## Flujo Recomendado Para Un Agente Live

1. Arranca el stack con Docker.
2. Crea el runtime bot y haz `join`.
3. Conecta el agente con `snapshotLimit: 0`.
4. Procesa texto de `chat`, `caption` y `audioTranscript`.
5. Procesa solo el frame mas reciente de video.
6. Devuelve acciones cortas y claras.
7. Mantiene memoria corta del contexto reciente.

Para ultra baja latencia:

1. Espera `media.transport.ready`.
2. Manda audio PCM directo por RTP.
3. Usa `chat` solo para acuses o datos.
4. Usa `speak` como fallback cuando no tengas audio del proveedor.

## Ejemplo Minimo

```ts
import {
  MeetAgent,
  startAgentBridge,
  type AgentBridgeAction,
  type AgentBridgeInput
} from './meet-control-server/src/sdk/index.js';

async function decide(input: AgentBridgeInput): Promise<AgentBridgeAction | void> {
  if (input.kind === 'text' && /hello|hola/i.test(input.text)) {
    return {
      type: 'chat',
      text: `Recibido: ${input.text}`
    };
  }

  if (input.kind === 'text' && /resume|summary/i.test(input.text)) {
    return {
      type: 'speak',
      text: 'Estoy preparando el resumen.'
    };
  }
}

const agent = new MeetAgent({
  baseUrl: 'http://localhost:3001',
  meetingId: 'demo-meeting',
  botId: 'bot-01'
});

await agent.connect({ snapshotLimit: 0 });

const stop = startAgentBridge(agent, {
  includeVideoFrames: true,
  onInput: decide,
  onError: console.error
});
```

Tambien tienes un ejemplo runnable en:

- `meet-control-server/examples/generic-live-agent.example.ts`

Comando:

```bash
npm --prefix meet-control-server run example:agent
```

Ejemplo low-latency:

```bash
npm --prefix meet-control-server run example:rtp-agent
```

## Audio Directo del Proveedor

SDK helper:

```ts
import { MeetAgent, RtpAudioInputSender } from './meet-control-server/src/sdk/index.js';

const agent = new MeetAgent({
  baseUrl: 'http://localhost:3001',
  meetingId: 'demo-meeting',
  botId: 'bot-01'
});

await agent.connect({ snapshotLimit: 0 });
const transport = await agent.waitForMediaTransport();

if (transport.payload.transport.audioInput) {
  const sender = new RtpAudioInputSender(transport.payload.transport.audioInput, {
    targetHost: '127.0.0.1'
  });

  // Conecta aqui los chunks PCM16 mono de tu proveedor.
  // sender.writePcm(chunk);
}
```

## Como Pensarlo Para ADK / Gemini Live

La recomendacion es no acoplar el sistema de Meet a un proveedor concreto.

Usa este proyecto como una capa de I/O del meeting:

- entradas del meeting -> texto/imagenes para el modelo
- salidas del modelo -> `chat` o `speak`

Arquitectura sugerida:

1. `MeetAgent` o `startAgentBridge` consume el meeting.
2. Tu adapter convierte `AgentBridgeInput` al formato del proveedor.
3. Tu runtime de IA decide la respuesta.
4. Tu adapter traduce la respuesta a `AgentBridgeAction`.
5. El bridge ejecuta la accion en Meet.

Para un runtime tipo Gemini Live o ADK:

- texto de chat/captions/audio puede entrar como turns o mensajes incrementales
- imagenes JPEG de `video.frame.detected` pueden entrar como frames discretos
- conviene procesar solo el frame mas reciente y descartar backlog
- si tu adapter ya recibe audio PCM incremental del proveedor, conectalo a `RtpAudioInputSender`
- si el proveedor expone WebRTC o WebSocket de audio, usa ese SDK oficial y traduce los frames/chunks a PCM para el sender RTP
- `speech.say` queda como fallback estable cuando no quieres mantener un stream de audio continuo

Para un runtime tipo `nvidia/personaplex-7b-v1`:

- separa el loop de razonamiento del loop de audio
- mantiene una cola corta de salida PCM
- recorta silencios largos antes de enviarlos al sender RTP
- usa `chat` para mensajes estructurados y el RTP para voz natural

## Recomendaciones de Baja Latencia

- usar `snapshotLimit=0` en SSE
- trabajar siempre con `latest wins` para video
- no reconstruir todo el timeline en cada evento
- limitar memoria conversacional a una ventana corta
- responder por chat si quieres acknowledgement inmediato
- responder por voz cuando el mensaje merezca presencia en la reunion
- si el agente genera mucho texto, dividirlo antes de `speak`
- preferir audio PCM -> RTP cuando el proveedor ya genera voz
- bajar el costo del STT manteniendo los segmentos cortos si lo usas como fallback

## Endpoints Clave Para IA

- `GET /meetings/:meetingId/events/stream?snapshotLimit=0`
- `GET /meetings/:meetingId/video-frames/latest`
- `GET /meetings/:meetingId/video-frames/:frameId/image`
- `POST /bots/:botId/chat`
- `POST /bots/:botId/speak`
- `GET /commands/:commandId`

## Postman

La coleccion actualizada esta en:

- `meet-bot/postman.json`

Variables importantes para pruebas desde Docker:

- `runtimeSupervisorUrl=http://localhost:3000`
- `controlServerUrl=http://localhost:3001`
- `runtimeControlBaseUrl=http://meet-control-server:3001`
- `REALTIME_AGENT_AUDIO_RTP_PORT=5004`
- `REALTIME_MEETING_AUDIO_RTP_URL=rtp://host.docker.internal:5006`
- `REALTIME_VIDEO_RTP_URL=rtp://host.docker.internal:5008`

## Siguiente Paso Recomendado

Cuando ya vayas a conectar el agente real:

1. define un adapter propio sobre `startAgentBridge`
2. decide cuando responder por `chat` y cuando por `speak`
3. agrega politicas de memoria corta y control de turnos
4. si el proveedor lo permite, separa procesamiento de texto, vision y audio para no bloquear el loop principal
