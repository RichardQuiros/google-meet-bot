import { randomUUID } from 'node:crypto';
import type {
  AudioTranscriptRecord,
  BotCommand,
  BotEvent,
  BotRecord,
  BotRegistration,
  BotStatus,
  CaptionSegmentRecord,
  ChatMessageRecord,
  EnqueueBotCommand,
  MeetingSession,
  MeetingTimeline,
  VideoEventRecord
} from './types.js';

type EventListener = (event: BotEvent) => void;
type CommandWaiter = (command: BotCommand | null) => void;

export class InMemoryStore {
  private bots = new Map<string, BotRecord>();
  private meetings = new Map<string, MeetingSession>();
  private commands = new Map<string, BotCommand>();
  private commandQueues = new Map<string, string[]>();
  private events: BotEvent[] = [];
  private chatMessages: ChatMessageRecord[] = [];
  private captionSegments: CaptionSegmentRecord[] = [];
  private audioTranscripts: AudioTranscriptRecord[] = [];
  private videoEvents: VideoEventRecord[] = [];

  private meetingListeners = new Map<string, Set<EventListener>>();
  private commandWaiters = new Map<string, Set<CommandWaiter>>();

  registerBot(input: BotRegistration): BotRecord {
    const now = new Date().toISOString();
    const existing = this.bots.get(input.botId);

    const record: BotRecord = {
      botId: input.botId,
      displayName: input.displayName,
      runtimeUrl: input.runtimeUrl,
      meetingId: input.meetingId,
      metadata: input.metadata,
      status: existing?.status ?? 'created',
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      error: existing?.error
    };

    this.bots.set(input.botId, record);
    this.ensureBotQueue(input.botId);

    if (input.meetingId) {
      this.ensureMeeting(input.meetingId);
      this.attachBotToMeeting(input.botId, input.meetingId);
    }

    return record;
  }

  getBot(botId: string): BotRecord | undefined {
    return this.bots.get(botId);
  }

  listBots(): BotRecord[] {
    return [...this.bots.values()];
  }

  updateBotStatus(botId: string, status: BotStatus, error?: string): BotRecord | undefined {
    const bot = this.bots.get(botId);
    if (!bot) {
      return undefined;
    }

    bot.status = status;
    bot.error = error;
    bot.lastSeenAt = new Date().toISOString();

    this.bots.set(botId, bot);
    return bot;
  }

  touchBot(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }

    bot.lastSeenAt = new Date().toISOString();
    this.bots.set(botId, bot);
  }

  ensureMeeting(meetingId: string, meetingUrl?: string): MeetingSession {
    const now = new Date().toISOString();
    const existing = this.meetings.get(meetingId);

    if (existing) {
      if (meetingUrl) {
        existing.meetingUrl = meetingUrl;
      }

      existing.updatedAt = now;
      this.meetings.set(meetingId, existing);
      return existing;
    }

    const meeting: MeetingSession = {
      meetingId,
      meetingUrl,
      botIds: [],
      createdAt: now,
      updatedAt: now
    };

    this.meetings.set(meetingId, meeting);
    return meeting;
  }

  attachBotToMeeting(botId: string, meetingId: string): void {
    const meeting = this.ensureMeeting(meetingId);

    if (!meeting.botIds.includes(botId)) {
      meeting.botIds.push(botId);
    }

    meeting.updatedAt = new Date().toISOString();
    this.meetings.set(meetingId, meeting);

    const bot = this.bots.get(botId);
    if (bot) {
      bot.meetingId = meetingId;
      bot.lastSeenAt = new Date().toISOString();
      this.bots.set(botId, bot);
    }
  }

  getMeeting(meetingId: string): MeetingSession | undefined {
    return this.meetings.get(meetingId);
  }

  listMeetings(): MeetingSession[] {
    return [...this.meetings.values()];
  }

  enqueueCommand(command: EnqueueBotCommand): BotCommand {
    const fullCommand: BotCommand = {
      ...command,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'queued'
    } as BotCommand;

    this.commands.set(fullCommand.id, fullCommand);

    const waiters = this.commandWaiters.get(command.botId);
    const nextWaiter = waiters ? [...waiters][0] : undefined;

    if (nextWaiter) {
      waiters?.delete(nextWaiter);

      if (waiters && waiters.size === 0) {
        this.commandWaiters.delete(command.botId);
      }

      nextWaiter(fullCommand);
    } else {
      const queue = this.commandQueues.get(command.botId) ?? [];
      queue.push(fullCommand.id);
      this.commandQueues.set(command.botId, queue);
    }

    this.touchBot(command.botId);
    return fullCommand;
  }

  dequeueNextCommand(botId: string): BotCommand | null {
    const queue = this.commandQueues.get(botId);

    if (!queue || queue.length === 0) {
      this.touchBot(botId);
      return null;
    }

    const nextCommandId = queue.shift();
    this.commandQueues.set(botId, queue);
    this.touchBot(botId);

    return nextCommandId ? this.commands.get(nextCommandId) ?? null : null;
  }

  async waitForNextCommand(botId: string, waitMs = 0): Promise<BotCommand | null> {
    const immediateCommand = this.dequeueNextCommand(botId);

    if (immediateCommand || waitMs <= 0) {
      return immediateCommand;
    }

    return new Promise<BotCommand | null>((resolve) => {
      const waiters = this.commandWaiters.get(botId) ?? new Set<CommandWaiter>();

      const settle: CommandWaiter = (command) => {
        clearTimeout(timeout);
        waiters.delete(settle);

        if (waiters.size === 0) {
          this.commandWaiters.delete(botId);
        } else {
          this.commandWaiters.set(botId, waiters);
        }

        this.touchBot(botId);
        resolve(command);
      };

      const timeout = setTimeout(() => {
        settle(null);
      }, waitMs);

      waiters.add(settle);
      this.commandWaiters.set(botId, waiters);
      this.touchBot(botId);
    });
  }

  getCommand(commandId: string): BotCommand | undefined {
    return this.commands.get(commandId);
  }

  peekCommands(botId: string): BotCommand[] {
    return (this.commandQueues.get(botId) ?? [])
      .map((commandId) => this.commands.get(commandId))
      .filter((command): command is BotCommand => Boolean(command));
  }

  listCommandsByBot(botId: string, limit = 100): BotCommand[] {
    return [...this.commands.values()]
      .filter((command) => command.botId === botId)
      .slice(-limit);
  }

  listCommandsByMeeting(meetingId: string, limit = 100): BotCommand[] {
    return [...this.commands.values()]
      .filter((command) => command.meetingId === meetingId)
      .slice(-limit);
  }

  appendEvent(event: BotEvent): void {
    this.events.push(event);

    if (this.events.length > 5000) {
      this.events.splice(0, this.events.length - 5000);
    }

    this.touchBot(event.botId);

    if (event.type === 'bot.status.changed') {
      this.updateBotStatus(event.botId, event.payload.status, event.payload.error);
    }

    if (event.meetingId) {
      const meeting = this.ensureMeeting(event.meetingId);
      this.attachBotToMeeting(event.botId, event.meetingId);
      meeting.lastEventAt = event.timestamp;
      meeting.updatedAt = new Date().toISOString();
      this.meetings.set(event.meetingId, meeting);
    }

    switch (event.type) {
      case 'chat.message.detected':
        this.storeChatMessage(event);
        break;
      case 'caption.segment.detected':
        this.storeCaptionSegment(event);
        break;
      case 'audio.transcript.detected':
        this.storeAudioTranscript(event);
        break;
      case 'video.frame.detected':
        this.storeVideoFrame(event);
        break;
      case 'video.activity.detected':
        this.storeVideoActivity(event);
        break;
      case 'command.started':
        if (event.commandId) {
          this.markCommandStarted(event.commandId, event.timestamp);
        }
        break;
      case 'command.completed':
        if (event.commandId) {
          this.markCommandCompleted(event.commandId, event.timestamp, event.payload.result);
        }
        break;
      case 'command.failed':
        if (event.commandId) {
          this.markCommandFailed(event.commandId, event.timestamp, event.payload.error);
        }
        break;
      default:
        break;
    }

    if (event.meetingId) {
      this.publishMeetingEvent(event.meetingId, event);
    }
  }

  listEvents(limit = 100): BotEvent[] {
    return this.events.slice(-limit);
  }

  listEventsByBot(botId: string, limit = 100): BotEvent[] {
    return this.events.filter((event) => event.botId === botId).slice(-limit);
  }

  listEventsByMeeting(meetingId: string, limit = 100): BotEvent[] {
    return this.events.filter((event) => event.meetingId === meetingId).slice(-limit);
  }

  listMessagesByMeeting(meetingId: string, limit = 100): ChatMessageRecord[] {
    return this.chatMessages.filter((item) => item.meetingId === meetingId).slice(-limit);
  }

  listCaptionsByMeeting(meetingId: string, limit = 100): CaptionSegmentRecord[] {
    return this.captionSegments
      .filter((item) => item.meetingId === meetingId)
      .slice(-limit);
  }

  listAudioTranscriptsByMeeting(meetingId: string, limit = 100): AudioTranscriptRecord[] {
    return this.audioTranscripts
      .filter((item) => item.meetingId === meetingId)
      .slice(-limit);
  }

  listVideoEventsByMeeting(meetingId: string, limit = 100): VideoEventRecord[] {
    return this.videoEvents.filter((item) => item.meetingId === meetingId).slice(-limit);
  }

  getVideoFrameById(meetingId: string, frameId: string): VideoEventRecord | undefined {
    return this.videoEvents.find(
      (item) =>
        item.meetingId === meetingId &&
        item.eventType === 'video.frame.detected' &&
        item.eventId === frameId
    );
  }

  getLatestVideoFrameByMeeting(meetingId: string): VideoEventRecord | undefined {
    for (let index = this.videoEvents.length - 1; index >= 0; index -= 1) {
      const item = this.videoEvents[index];

      if (item.meetingId === meetingId && item.eventType === 'video.frame.detected') {
        return item;
      }
    }

    return undefined;
  }

  getMeetingTimeline(meetingId: string, limit = 100): MeetingTimeline | undefined {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) {
      return undefined;
    }

    return {
      meeting,
      commands: this.listCommandsByMeeting(meetingId, limit),
      events: this.listEventsByMeeting(meetingId, limit),
      messages: this.listMessagesByMeeting(meetingId, limit),
      captions: this.listCaptionsByMeeting(meetingId, limit),
      audioTranscripts: this.listAudioTranscriptsByMeeting(meetingId, limit),
      videoEvents: this.listVideoEventsByMeeting(meetingId, limit)
    };
  }

  subscribeToMeetingEvents(meetingId: string, listener: EventListener): () => void {
    const listeners = this.meetingListeners.get(meetingId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.meetingListeners.set(meetingId, listeners);

    return () => {
      const current = this.meetingListeners.get(meetingId);
      if (!current) {
        return;
      }

      current.delete(listener);

      if (current.size === 0) {
        this.meetingListeners.delete(meetingId);
      }
    };
  }

  private publishMeetingEvent(meetingId: string, event: BotEvent): void {
    const listeners = this.meetingListeners.get(meetingId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener failures so a broken SSE client does not block others.
      }
    }
  }

  private ensureBotQueue(botId: string): void {
    if (!this.commandQueues.has(botId)) {
      this.commandQueues.set(botId, []);
    }
  }

  private markCommandStarted(commandId: string, startedAt: string): void {
    const command = this.commands.get(commandId);
    if (!command) {
      return;
    }

    command.status = 'started';
    command.startedAt = startedAt;
    this.commands.set(commandId, command);
  }

  private markCommandCompleted(
    commandId: string,
    completedAt: string,
    result?: Record<string, unknown>
  ): void {
    const command = this.commands.get(commandId);
    if (!command) {
      return;
    }

    command.status = 'completed';
    command.completedAt = completedAt;
    command.result = result;
    command.error = undefined;
    this.commands.set(commandId, command);
  }

  private markCommandFailed(commandId: string, completedAt: string, error: string): void {
    const command = this.commands.get(commandId);
    if (!command) {
      return;
    }

    command.status = 'failed';
    command.completedAt = completedAt;
    command.error = error;
    this.commands.set(commandId, command);
  }

  private storeChatMessage(
    event: Extract<BotEvent, { type: 'chat.message.detected' }>
  ): void {
    const alreadyExists = this.chatMessages.some(
      (item) =>
        item.meetingId === event.meetingId &&
        item.messageId === event.payload.messageId
    );

    if (alreadyExists) {
      return;
    }

    this.chatMessages.push({
      meetingId: event.meetingId,
      messageId: event.payload.messageId,
      author: event.payload.author,
      text: event.payload.text,
      sentAt: event.payload.sentAt,
      detectedAt: event.timestamp,
      botId: event.botId
    });

    if (this.chatMessages.length > 5000) {
      this.chatMessages.splice(0, this.chatMessages.length - 5000);
    }
  }

  private storeCaptionSegment(
    event: Extract<BotEvent, { type: 'caption.segment.detected' }>
  ): void {
    const alreadyExists = this.captionSegments.some(
      (item) =>
        item.meetingId === event.meetingId &&
        item.segmentId === event.payload.segmentId
    );

    if (alreadyExists) {
      return;
    }

    this.captionSegments.push({
      meetingId: event.meetingId,
      segmentId: event.payload.segmentId,
      speaker: event.payload.speaker,
      text: event.payload.text,
      startAt: event.payload.startAt,
      detectedAt: event.timestamp,
      botId: event.botId
    });

    if (this.captionSegments.length > 7000) {
      this.captionSegments.splice(0, this.captionSegments.length - 7000);
    }
  }

  private storeAudioTranscript(
    event: Extract<BotEvent, { type: 'audio.transcript.detected' }>
  ): void {
    const alreadyExists = this.audioTranscripts.some(
      (item) =>
        item.meetingId === event.meetingId &&
        item.transcriptId === event.payload.transcriptId
    );

    if (alreadyExists) {
      return;
    }

    this.audioTranscripts.push({
      meetingId: event.meetingId,
      transcriptId: event.payload.transcriptId,
      speaker: event.payload.speaker,
      text: event.payload.text,
      confidence: event.payload.confidence,
      startedAt: event.payload.startedAt,
      endedAt: event.payload.endedAt,
      language: event.payload.language,
      detectedAt: event.timestamp,
      botId: event.botId
    });

    if (this.audioTranscripts.length > 7000) {
      this.audioTranscripts.splice(0, this.audioTranscripts.length - 7000);
    }
  }

  private storeVideoFrame(
    event: Extract<BotEvent, { type: 'video.frame.detected' }>
  ): void {
    const alreadyExists = this.videoEvents.some(
      (item) =>
        item.meetingId === event.meetingId &&
        item.eventType === 'video.frame.detected' &&
        item.eventId === event.payload.frameId
    );

    if (alreadyExists) {
      return;
    }

    this.videoEvents.push({
      meetingId: event.meetingId,
      eventId: event.payload.frameId,
      eventType: 'video.frame.detected',
      botId: event.botId,
      detectedAt: event.timestamp,
      framePath: event.payload.framePath,
      thumbnailPath: event.payload.thumbnailPath,
      width: event.payload.width,
      height: event.payload.height,
      capturedAt: event.payload.capturedAt
    });

    if (this.videoEvents.length > 5000) {
      this.videoEvents.splice(0, this.videoEvents.length - 5000);
    }
  }

  private storeVideoActivity(
    event: Extract<BotEvent, { type: 'video.activity.detected' }>
  ): void {
    const alreadyExists = this.videoEvents.some(
      (item) =>
        item.meetingId === event.meetingId &&
        item.eventType === 'video.activity.detected' &&
        item.eventId === event.payload.activityId
    );

    if (alreadyExists) {
      return;
    }

    this.videoEvents.push({
      meetingId: event.meetingId,
      eventId: event.payload.activityId,
      eventType: 'video.activity.detected',
      botId: event.botId,
      detectedAt: event.timestamp,
      activeSpeaker: event.payload.activeSpeaker,
      presentationActive: event.payload.presentationActive,
      participantTileCount: event.payload.participantTileCount,
      summary: event.payload.summary,
      metadata: event.payload.metadata,
      capturedAt: event.payload.detectedAt
    });

    if (this.videoEvents.length > 5000) {
      this.videoEvents.splice(0, this.videoEvents.length - 5000);
    }
  }
}
