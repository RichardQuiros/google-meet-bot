import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { InMemoryStore } from '../store.js';
import type { BotEvent, MeetingTimeline, VideoEventRecord } from '../types.js';

const DEFAULT_LIMIT = 100;

function getLimit(query: { limit?: string | number } | undefined, fallback = DEFAULT_LIMIT): number {
  const raw = query?.limit;
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 1000);
}

function buildBaseUrl(request: {
  protocol: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const forwardedHost = request.headers['x-forwarded-host'];
  const protocol =
    (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol)?.split(',')[0]?.trim() ||
    request.protocol;
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() ||
    (Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host) ||
    'localhost';

  return `${protocol}://${host}`;
}

function buildVideoFrameUrl(baseUrl: string, meetingId: string, frameId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/meetings/${encodeURIComponent(meetingId)}/video-frames/${encodeURIComponent(frameId)}/image`;
}

function enrichVideoEventRecord(record: VideoEventRecord, baseUrl: string): VideoEventRecord {
  if (record.eventType !== 'video.frame.detected') {
    return record;
  }

  return {
    ...record,
    frameUrl: buildVideoFrameUrl(baseUrl, record.meetingId, record.eventId)
  };
}

function enrichBotEvent(event: BotEvent, baseUrl: string): BotEvent {
  if (event.type !== 'video.frame.detected' || !event.meetingId) {
    return event;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      frameUrl: buildVideoFrameUrl(baseUrl, event.meetingId, event.payload.frameId)
    }
  };
}

function enrichTimeline(timeline: MeetingTimeline, baseUrl: string): MeetingTimeline {
  return {
    ...timeline,
    events: timeline.events.map((event) => enrichBotEvent(event, baseUrl)),
    videoEvents: timeline.videoEvents.map((event) => enrichVideoEventRecord(event, baseUrl))
  };
}

export async function publicRoutes(app: FastifyInstance, store: InMemoryStore) {
  app.get('/health', async () => ({
    ok: true,
    service: 'meet-control-server',
    timestamp: new Date().toISOString()
  }));

  app.get('/bots', async () => store.listBots());

  app.get('/bots/:botId', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = store.getBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    return bot;
  });

  app.get('/bots/:botId/commands', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = store.getBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listCommandsByBot(botId, limit);
  });

  app.get('/commands/:commandId', async (request, reply) => {
    const { commandId } = request.params as { commandId: string };
    const command = store.getCommand(commandId);

    if (!command) {
      return reply.code(404).send({ error: 'Command not found' });
    }

    return command;
  });

  app.get('/bots/:botId/events', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const bot = store.getBot(botId);

    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listEventsByBot(botId, limit);
  });

  app.post('/bots/:botId/chat', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const body = request.body as {
      text: string;
      meetingId?: string;
    };

    const bot = store.getBot(botId);
    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    const meetingId = body?.meetingId ?? bot.meetingId;
    if (!meetingId) {
      return reply.code(400).send({
        error: 'meetingId is required if bot has no meetingId assigned'
      });
    }

    if (!body?.text?.trim()) {
      return reply.code(400).send({
        error: 'text is required'
      });
    }

    const command = store.enqueueCommand({
      type: 'chat.send',
      botId,
      meetingId,
      payload: {
        text: body.text.trim()
      }
    });

    return reply.code(201).send(command);
  });

  app.post('/bots/:botId/join', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const body = request.body as {
      meetingId: string;
      meetingUrl: string;
      displayName?: string;
      camera?: boolean;
      microphone?: boolean;
    };

    const bot = store.getBot(botId);
    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    if (!body?.meetingId || !body?.meetingUrl) {
      return reply.code(400).send({
        error: 'meetingId and meetingUrl are required'
      });
    }

    store.ensureMeeting(body.meetingId, body.meetingUrl);
    store.attachBotToMeeting(botId, body.meetingId);

    const command = store.enqueueCommand({
      type: 'bot.join',
      botId,
      meetingId: body.meetingId,
      payload: {
        meetingUrl: body.meetingUrl,
        displayName: body.displayName ?? bot.displayName,
        camera: body.camera ?? false,
        microphone: body.microphone ?? false
      }
    });

    return reply.code(201).send(command);
  });

  app.post('/bots/:botId/speak', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const body = request.body as {
      text: string;
      meetingId?: string;
      voice?: string;
      rate?: number;
      pitch?: number;
      volume?: number;
    };

    const bot = store.getBot(botId);
    if (!bot) {
      return reply.code(404).send({ error: 'Bot not found' });
    }

    const meetingId = body?.meetingId ?? bot.meetingId;
    if (!meetingId) {
      return reply.code(400).send({
        error: 'meetingId is required if bot has no meetingId assigned'
      });
    }

    if (!body?.text?.trim()) {
      return reply.code(400).send({
        error: 'text is required'
      });
    }

    const command = store.enqueueCommand({
      type: 'speech.say',
      botId,
      meetingId,
      payload: {
        text: body.text.trim(),
        voice: body.voice,
        rate: body.rate,
        pitch: body.pitch,
        volume: body.volume
      }
    });

    return reply.code(201).send(command);
  });

  app.get('/meetings', async () => store.listMeetings());

  app.get('/meetings/:meetingId', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    return meeting;
  });

  app.get('/meetings/:meetingId/messages', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listMessagesByMeeting(meetingId, limit);
  });

  app.get('/meetings/:meetingId/captions', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listCaptionsByMeeting(meetingId, limit);
  });

  app.get('/meetings/:meetingId/audio-transcripts', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listAudioTranscriptsByMeeting(meetingId, limit);
  });

  app.get('/meetings/:meetingId/video-events', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    const baseUrl = buildBaseUrl(request);
    return store
      .listVideoEventsByMeeting(meetingId, limit)
      .map((event) => enrichVideoEventRecord(event, baseUrl));
  });

  app.get('/meetings/:meetingId/video-frames/latest', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const latestFrame = store.getLatestVideoFrameByMeeting(meetingId);

    if (!latestFrame) {
      return reply.code(404).send({ error: 'Video frame not found' });
    }

    return enrichVideoEventRecord(latestFrame, buildBaseUrl(request));
  });

  app.get('/meetings/:meetingId/video-frames/:frameId/image', async (request, reply) => {
    const { meetingId, frameId } = request.params as { meetingId: string; frameId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const frame = store.getVideoFrameById(meetingId, frameId);

    if (!frame?.framePath) {
      return reply.code(404).send({ error: 'Video frame not found' });
    }

    try {
      const file = await fs.readFile(frame.framePath);
      reply.header('Cache-Control', 'no-store');
      reply.type('image/jpeg');
      return reply.send(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read video frame';
      return reply.code(404).send({ error: message });
    }
  });

  app.get('/meetings/:meetingId/commands', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listCommandsByMeeting(meetingId, limit);
  });

  app.get('/meetings/:meetingId/events', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    const baseUrl = buildBaseUrl(request);
    return store.listEventsByMeeting(meetingId, limit).map((event) => enrichBotEvent(event, baseUrl));
  });

  app.get('/meetings/:meetingId/timeline', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    const timeline = store.getMeetingTimeline(meetingId, limit);

    if (!timeline) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    return enrichTimeline(timeline, buildBaseUrl(request));
  });

  app.get('/meetings/:meetingId/events/stream', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const { snapshotLimit } = request.query as { snapshotLimit?: string | number };
    const meeting = store.getMeeting(meetingId);

    if (!meeting) {
      return reply.code(404).send({ error: 'Meeting not found' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const send = (eventName: string, data: unknown) => {
      reply.raw.write(`event: ${eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('connected', {
      meetingId,
      timestamp: new Date().toISOString()
    });

    const baseUrl = buildBaseUrl(request);
    const parsedSnapshotLimit =
      typeof snapshotLimit === 'number'
        ? snapshotLimit
        : typeof snapshotLimit === 'string'
          ? Number.parseInt(snapshotLimit, 10)
          : 50;

    if (Number.isFinite(parsedSnapshotLimit) && parsedSnapshotLimit > 0) {
      const timeline = store.getMeetingTimeline(meetingId, Math.min(parsedSnapshotLimit, 200));
      send('snapshot', timeline ? enrichTimeline(timeline, baseUrl) : null);
    }

    const unsubscribe = store.subscribeToMeetingEvents(meetingId, (event) => {
      send(event.type, enrichBotEvent(event, baseUrl));
    });

    const heartbeat = setInterval(() => {
      send('heartbeat', {
        meetingId,
        timestamp: new Date().toISOString()
      });
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.get('/events', async (request) => {
    const limit = getLimit(request.query as { limit?: string | number } | undefined);
    return store.listEvents(limit);
  });
}
