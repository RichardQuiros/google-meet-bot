# Arquitectura del Sistema

Documento tecnico del MVP para bots autonomos en Google Meet.

Este archivo describe:

- arquitectura general
- protocolos entre servicios
- flujos de datos
- contratos de comandos y eventos
- decisiones de latencia
- despliegue en Docker
- limites actuales y puntos de extension

## 1. Objetivo del Sistema

El sistema permite que un agente de IA participe en una reunion de Google Meet por medio de un bot que:

- entra a la llamada
- observa texto, audio y video
- envia chat
- habla por voz sintetizada
- expone todo esto a un agente externo casi en tiempo real

La arquitectura esta separada para que la logica del agente no dependa del navegador ni del DOM de Meet.

## 2. Vision General

Hay dos servicios principales:

1. `meet-control-server`
2. `meet-bot`

Y un consumidor externo opcional:

3. agente de IA

Vista logica:

```text
Google Meet
   ^
   | UI + audio virtual
   v
meet-bot runtime
   ^                    ^
   | HTTP interno        | RTP media plane opcional
   v                    |
meet-control-server     |
   ^                    |
   | SSE + REST         |
   v                    |
agente de IA ------------+
```

Vista de responsabilidades:

- `meet-control-server`
  - API publica
  - timeline del meeting
  - cola de comandos
  - stream SSE
  - SDK para agentes

- `meet-bot`
  - supervisor de runtimes
  - Chrome + Playwright
  - automatizacion de Google Meet
  - captura de chat, captions, audio y video
  - reproduccion TTS hacia la reunion
  - relay RTP opcional para audio/video low-latency

- agente
  - consume eventos live
  - decide acciones
  - devuelve `chat`, `speak` o audio PCM directo por RTP

## 3. Componentes

### 3.1 meet-control-server

Servicio Node.js + Fastify + TypeScript.

Funciones principales:

- registrar bots runtime
- aceptar comandos de alto nivel
- guardar eventos normalizados
- exponer consultas historicas
- emitir eventos live por SSE

APIs importantes:

- `POST /bots/:botId/join`
- `POST /bots/:botId/chat`
- `POST /bots/:botId/speak`
- `GET /meetings/:meetingId/events/stream`
- `GET /meetings/:meetingId/messages`
- `GET /meetings/:meetingId/audio-transcripts`
- `GET /meetings/:meetingId/video-frames/latest`
- `GET /meetings/:meetingId/video-frames/:frameId/image`

### 3.2 meet-bot supervisor

Servicio Node.js + Fastify + TypeScript.

Funciones principales:

- crear bots runtime
- iniciar, detener y reiniciar runtimes
- exponer estado del runtime
- aislar cada bot en su propio proceso/logica

APIs importantes:

- `POST /runtime/bots`
- `GET /runtime/bots`
- `POST /runtime/bots/:botId/start`
- `POST /runtime/bots/:botId/stop`
- `POST /runtime/bots/:botId/restart`

### 3.3 runtime agent

Proceso de trabajo que vive dentro de `meet-bot`.

Funciones principales:

- registrar el bot en control
- hacer long polling de comandos
- ejecutar `bot.join`, `chat.send`, `speech.say`
- arrancar observers cuando el bot entra al meeting
- publicar eventos de estado, texto, audio y video

### 3.4 navegador automatizado

Base tecnica:

- Playwright
- Chrome real
- perfil persistente
- automatizacion DOM de Google Meet

Funciones:

- prejoin
- seleccion de microfono virtual
- envio de chat
- lectura de chat
- lectura de captions
- captura visual

### 3.5 pipeline de audio

Entradas:

- audio del meeting capturado desde el monitor del sink virtual
- audio RTP opcional recibido directamente desde el agente

Salidas:

- voz sintetizada reproducida al sink virtual y enviada al microfono virtual de Meet
- audio del meeting relayed por RTP para proveedores de voz/transcripcion externos

### 3.6 pipeline de video

Base tecnica:

- capturas periodicas desde Playwright
- serializacion a JPEG
- almacenamiento temporal en volumen compartido

## 4. Protocolos Entre Servicios

## 4.1 Host -> meet-bot supervisor

Protocolo:

- HTTP REST

Uso:

- crear y administrar runtimes

Ejemplo:

```http
POST /runtime/bots
Content-Type: application/json

{
  "botId": "bot-01",
  "displayName": "Agent-01",
  "autoStart": true
}
```

Notas:

- en Docker, el supervisor usa `CONTROL_BASE_URL` interno
- si el cliente manda `localhost`, el supervisor lo normaliza al URL interno del compose
- si el bot ya existe, el supervisor puede reusar o reconfigurar el runtime

## 4.2 Runtime -> control server

Protocolo:

- HTTP REST interno

Canales:

- registro de bot
- long polling de comandos
- publicacion de eventos

Endpoints:

- `POST /internal/bots/register`
- `GET /internal/bots/:botId/commands/next?waitMs=3000`
- `POST /internal/events`

Notas:

- el long polling reduce latencia sin requerir WebSocket
- el runtime no hace polling fijo ciego; espera hasta que haya comando o timeout

## 4.3 Control server -> agente

Protocolos:

- SSE para eventos live
- REST para consultas y acciones

Canal de entrada live:

- `GET /meetings/:meetingId/events/stream?snapshotLimit=0`

Canal de acciones:

- `POST /bots/:botId/chat`
- `POST /bots/:botId/speak`

Canal de lectura puntual:

- `GET /meetings/:meetingId/messages`
- `GET /meetings/:meetingId/audio-transcripts`
- `GET /meetings/:meetingId/video-frames/latest`

## 4.4 Transporte de video al agente

El SSE no transporta el JPEG binario.

Modelo usado:

1. runtime genera `video.frame.detected`
2. control server guarda metadata del frame
3. el evento SSE incluye `frameId` y `frameUrl`
4. el agente descarga el JPEG por HTTP

Ventaja:

- el stream SSE sigue liviano

Costo:

- hay un paso adicional por HTTP para la imagen

## 4.5 Plano de medios RTP

Para bajar latencia se agrego un canal separado del control plane:

- audio del meeting -> RTP `sendonly`
- audio del agente -> RTP `recvonly`
- frames JPEG -> RTP `sendonly`

Caracteristicas:

- no reemplaza SSE/REST
- evita esperar a `speech.say` + TTS completo cuando el agente ya produce audio
- permite enchufar adapters realtime sobre ADK, Gemini Live o motores propios

## 5. Modelo de Comandos

Tipos principales:

- `bot.join`
- `chat.send`
- `speech.say`

Ciclo de vida:

- `queued`
- `started`
- `completed`
- `failed`

Eventos asociados:

- `command.started`
- `command.completed`
- `command.failed`

Ejemplo:

```text
POST /bots/:botId/speak
  -> command queued
  -> runtime hace long poll
  -> runtime ejecuta TTS
  -> runtime emite command.completed
  -> control server actualiza el command
```

## 6. Modelo de Eventos

Eventos observados del meeting:

- `bot.status.changed`
- `chat.message.detected`
- `caption.segment.detected`
- `audio.transcript.detected`
- `video.frame.detected`
- `video.activity.detected`
- `media.transport.ready`
- `media.transport.failed`
- `speech.output.completed`
- `speech.output.failed`

Eventos operativos:

- `command.started`
- `command.completed`
- `command.failed`
- `heartbeat`

## 6.1 Semantica

- `chat.message.detected`
  - mensaje detectado en el panel de chat de Meet

- `caption.segment.detected`
  - segmento de captions leido del DOM de Meet

- `audio.transcript.detected`
  - transcripcion STT obtenida desde captura de audio del sistema

- `video.frame.detected`
  - frame JPEG capturado para vision

- `speech.output.completed`
  - TTS reproducido correctamente

## 6.2 Observacion importante

No todas las modalidades vienen del mismo origen:

- chat y captions: DOM de Meet
- audio: dispositivo de audio del sistema
- video: captura de pantalla/render del navegador

## 7. Flujos Principales

## 7.1 Join

```text
Cliente/Agente
  -> POST /bots/:botId/join
Control Server
  -> encola bot.join
Runtime
  -> obtiene command por long poll
  -> abre Chrome
  -> navega a Meet
  -> llena nombre
  -> ajusta microfono preferido
  -> intenta entrar
  -> emite bot.status.changed
```

## 7.2 Chat entrante

```text
Participante escribe en Meet
  -> MeetChatObserver detecta el nodo
  -> RuntimeAgent emite chat.message.detected
  -> Control Server guarda mensaje
  -> SSE lo entrega al agente
```

## 7.3 Audio entrante

```text
Audio del meeting
  -> sink monitor
  -> ffmpeg captura WAV corto
  -> STT CLI
  -> RuntimeAgent emite audio.transcript.detected
  -> Control Server guarda transcript
  -> SSE lo entrega al agente
```

## 7.4 Video entrante

```text
Vista del meeting
  -> screenshot periodico
  -> JPEG en /app/tmp/video-frames
  -> video.frame.detected
  -> SSE entrega metadata
  -> agente baja frameUrl
```

Con RTP opcional:

```text
Vista del meeting
  -> screenshot periodico
  -> relay image2pipe
  -> RTP JPEG
  -> agente recibe frame low-latency
```

## 7.5 Voz saliente

```text
Agente
  -> POST /bots/:botId/speak
Control Server
  -> encola speech.say
Runtime
  -> TTS -> WAV
  -> reproduce al sink virtual
  -> Meet usa microfono virtual
  -> participantes oyen la voz del bot
```

## 7.6 Voz saliente ultrarrapida

```text
Proveedor realtime
  -> audio PCM incremental
  -> RtpAudioInputSender
  -> RTP al runtime
  -> sink virtual
  -> microfono virtual de Meet
  -> participantes oyen al bot sin esperar TTS
```

## 8. Pipeline de Audio

## 8.1 Speech output

Pipeline:

```text
speech.say
  -> TtsService
  -> WAV
  -> AudioOutputProvider
  -> sink virtual
  -> source virtual / microfono virtual
  -> Google Meet
```

En Docker:

- sink: `meetbot_sink`
- source: `meetbot_mic`
- etiqueta visible: `MeetBot_Virtual_Microphone`

Modo low-latency adicional:

```text
agent PCM
  -> RTP input port
  -> ffmpeg decode
  -> PulseAudio default sink
  -> source virtual / microfono virtual
  -> Google Meet
```

## 8.2 Speech to text

Pipeline:

```text
meetbot_sink.monitor
  -> ffmpeg
  -> segmento WAV corto
  -> faster-whisper
  -> audio.transcript.detected
```

## 9. Pipeline de Video

Formato actual:

- JPEG

Estrategia:

- polling rapido
- `latest wins`
- sin backlog grande
- relay RTP opcional sobre `image2pipe` para el frame mas reciente

Por que:

- la prioridad es latencia para el agente
- para vision live suele ser mejor el frame mas reciente que una cola de frames viejos

## 10. Persistencia y Volumenes

El volumen principal es:

- `meet-bot-data`

Montajes:

- `meet-bot` -> `/app/tmp`
- `meet-control-server` -> `/app/tmp` solo lectura para servir frames

Contenido tipico:

- perfiles de Chrome
- audio temporal
- salida TTS
- screenshots
- artifacts HTML/PNG/JSON
- video frames JPEG

## 10.1 Estado en memoria

El control server del MVP usa store en memoria para:

- meetings
- commands
- eventos
- mensajes
- captions
- transcripciones

Esto es suficiente para MVP, pero no es persistencia durable de negocio.

## 11. Latencia y Modo Casi Live

Decisiones actuales:

- long polling para comandos
- SSE para eventos
- `snapshotLimit=0` para agentes live
- polling agresivo para chat/captions
- segmentos cortos para audio
- video con `latest wins`
- calidad JPEG reducida

Defaults Docker orientados a baja latencia:

- chat: `250ms`
- captions: `250ms`
- audio: `1200ms`
- video: `250ms`
- RTP audio input directo: `5004/udp`

## 11.1 Lo que sigue pendiente

Hoy el sistema aun no usa WebRTC server-side nativo.

El modo disponible ahora es:

- SSE/REST para control e historial
- RTP para media low-latency
- near-live en texto/control
- latencia mucho menor en audio directo que con `speech.say`

## 12. Resiliencia y Recuperacion

Mecanismos actuales:

- perfil persistente
- normalizacion de `controlBaseUrl` en Docker
- limpieza de locks viejos de Chrome
- reintento al detectar profile lock
- cierre reforzado del modal de Settings
- recovery de pagina/contexto en runtime
- healthchecks en Docker

Fallos comunes mitigados:

- `command` se queda en `queued`
- Chrome no abre por lock del perfil
- Settings se queda abierto y bloquea el join
- seleccion incorrecta del microfono virtual

## 13. Contrato para Agentes

La capa recomendada para agentes es:

- `MeetAgent`
- `AgentBridge`

Patron recomendado:

```text
SSE snapshotLimit=0
  -> texto
  -> audio transcript
  -> metadata de frame
  -> GET frameUrl si hace falta vision
  -> decidir accion
  -> POST chat o speak
```

Eso permite conectar:

- ADK
- Gemini Live
- OpenAI realtime/vision adapters
- Nvidia PersonaPlex y runtimes propios con PCM
- runtimes propios

## 14. Limites Actuales

- el control server aun no usa base de datos real
- video sigue naciendo de screenshot periodico, aunque ahora puede relayed por RTP
- captions dependen del DOM de Meet
- el audio se enruta por dispositivos del sistema, no por una API nativa de Meet
- la seleccion de dispositivos depende del DOM real de Settings
- WebRTC aun requiere un gateway/adapter externo si el proveedor lo exige

## 15. Extension Futura Recomendada

Pasos naturales para evolucionar:

1. mover timeline a una base de datos real
2. agregar un bridge concreto para un proveedor de IA
3. optimizar video para transporte en memoria
4. introducir un canal mas directo para audio/video live
5. agregar supervisor multi-worker con scheduling

## 16. Resumen Ejecutivo

El sistema esta dividido correctamente en:

- control plane
- runtime de meeting
- agente externo

Los protocolos actuales son:

- REST para administracion y acciones
- long polling para commands runtime
- SSE para observacion live
- HTTP para recuperar frames JPEG
- RTP para audio/video low-latency opcional

Eso hace que el sistema sea modular, portable y lo bastante rapido para un agente multimodal near-live sin acoplar la IA al navegador ni a Google Meet directamente.
