import { EventEmitter } from 'node:events';
import { EventSource } from 'eventsource';
import type { BotEvent, BotCommand, MeetingTimeline, VideoEventRecord } from '../types.js';

type EventSourceMessage = Event & {
  data: string;
};

export type VideoFrameEvent = Extract<BotEvent, { type: 'video.frame.detected' }>;
export type ChatDetectedEvent = Extract<BotEvent, { type: 'chat.message.detected' }>;
export type CaptionDetectedEvent = Extract<BotEvent, { type: 'caption.segment.detected' }>;
export type AudioTranscriptEvent = Extract<BotEvent, { type: 'audio.transcript.detected' }>;
export type CommandCompletedEvent = Extract<BotEvent, { type: 'command.completed' }>;
export type CommandFailedEvent = Extract<BotEvent, { type: 'command.failed' }>;

export interface LiveVideoFrame {
  event: VideoFrameEvent;
  image: ArrayBuffer;
  imageUrl: string;
}

export type LiveInputEvent =
  | {
      kind: 'chat';
      event: ChatDetectedEvent;
      text: string;
      speaker: string;
      occurredAt: string;
    }
  | {
      kind: 'caption';
      event: CaptionDetectedEvent;
      text: string;
      speaker: string;
      occurredAt: string;
    }
  | {
      kind: 'audioTranscript';
      event: AudioTranscriptEvent;
      text: string;
      speaker: string;
      occurredAt: string;
    };

export interface MeetAgentOptions {
  baseUrl?: string;
  meetingId: string;
  botId: string;
}

export interface ConnectOptions {
  snapshotLimit?: number;
}

export class MeetAgent extends EventEmitter {
  private readonly baseUrl: string;
  private readonly meetingId: string;
  private readonly botId: string;
  private source?: EventSource;

  constructor(options: MeetAgentOptions) {
    super();
    this.baseUrl = options.baseUrl ?? 'http://localhost:3001';
    this.meetingId = options.meetingId;
    this.botId = options.botId;
  }

  override on(
    eventName:
      | 'connected'
      | 'snapshot'
      | 'event'
      | 'chat'
      | 'caption'
      | 'audioTranscript'
      | 'videoFrame'
      | 'videoActivity'
      | 'botStatus'
      | 'commandStarted'
      | 'commandCompleted'
      | 'commandFailed'
      | 'speechCompleted'
      | 'speechFailed'
      | 'error',
    listener: (...args: unknown[]) => void
  ): this {
    return super.on(eventName, listener);
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    if (this.source) {
      return;
    }

    const snapshotLimit =
      typeof options.snapshotLimit === 'number' ? options.snapshotLimit : 0;
    const source = new EventSource(
      `${this.baseUrl.replace(/\/$/, '')}/meetings/${this.meetingId}/events/stream?snapshotLimit=${Math.max(0, snapshotLimit)}`
    );
    this.source = source;

    this.bindStreamEvent(source, 'snapshot', (timeline) => {
      this.emit('snapshot', timeline);
    });

    this.bindStreamEvent(source, 'chat.message.detected', (event) => {
      this.emit('chat', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'caption.segment.detected', (event) => {
      this.emit('caption', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'audio.transcript.detected', (event) => {
      this.emit('audioTranscript', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'video.frame.detected', (event) => {
      this.emit('videoFrame', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'video.activity.detected', (event) => {
      this.emit('videoActivity', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'bot.status.changed', (event) => {
      this.emit('botStatus', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'command.started', (event) => {
      this.emit('commandStarted', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'command.completed', (event) => {
      this.emit('commandCompleted', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'command.failed', (event) => {
      this.emit('commandFailed', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'speech.output.completed', (event) => {
      this.emit('speechCompleted', event);
      this.emit('event', event);
    });

    this.bindStreamEvent(source, 'speech.output.failed', (event) => {
      this.emit('speechFailed', event);
      this.emit('event', event);
    });

    await new Promise<void>((resolve, reject) => {
      const handleConnected = (event: Event) => {
        const payload = JSON.parse((event as EventSourceMessage).data);
        this.emit('connected', payload);
        resolve();
      };

      const handleError = (error: Event) => {
        this.emit('error', error);
        reject(new Error('Failed to connect to meeting event stream'));
      };

      source.addEventListener('connected', handleConnected, { once: true });
      source.addEventListener('error', handleError, { once: true });
      source.onerror = (error) => {
        this.emit('error', error);
      };
    });
  }

  disconnect(): void {
    this.source?.close();
    this.source = undefined;
  }

  async join(input: {
    meetingUrl: string;
    displayName?: string;
    camera?: boolean;
    microphone?: boolean;
  }): Promise<BotCommand> {
    return this.request<BotCommand>(`/bots/${this.botId}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        meetingId: this.meetingId,
        ...input
      })
    });
  }

  async joinAndWait(
    input: {
      meetingUrl: string;
      displayName?: string;
      camera?: boolean;
      microphone?: boolean;
    },
    timeoutMs = 120000
  ): Promise<CommandCompletedEvent> {
    const command = await this.join(input);
    return this.waitForCommand(command.id, timeoutMs);
  }

  async chat(text: string): Promise<BotCommand> {
    return this.request<BotCommand>(`/bots/${this.botId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        meetingId: this.meetingId,
        text
      })
    });
  }

  async chatAndWait(text: string, timeoutMs = 30000): Promise<CommandCompletedEvent> {
    const command = await this.chat(text);
    return this.waitForCommand(command.id, timeoutMs);
  }

  async say(
    text: string,
    options: {
      voice?: string;
      rate?: number;
      pitch?: number;
      volume?: number;
    } = {}
  ): Promise<BotCommand> {
    return this.request<BotCommand>(`/bots/${this.botId}/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        meetingId: this.meetingId,
        text,
        ...options
      })
    });
  }

  async sayAndWait(
    text: string,
    options: {
      voice?: string;
      rate?: number;
      pitch?: number;
      volume?: number;
    } = {},
    timeoutMs = 120000
  ): Promise<CommandCompletedEvent> {
    const command = await this.say(text, options);
    return this.waitForCommand(command.id, timeoutMs);
  }

  async getTimeline(limit = 100): Promise<MeetingTimeline> {
    return this.request<MeetingTimeline>(
      `/meetings/${this.meetingId}/timeline?limit=${limit}`
    );
  }

  async getCommand(commandId: string): Promise<BotCommand> {
    return this.request<BotCommand>(`/commands/${commandId}`);
  }

  async getVideoEvents(limit = 100): Promise<VideoEventRecord[]> {
    return this.request<VideoEventRecord[]>(
      `/meetings/${this.meetingId}/video-events?limit=${limit}`
    );
  }

  async getLatestVideoFrame(): Promise<VideoEventRecord> {
    return this.request<VideoEventRecord>(
      `/meetings/${this.meetingId}/video-frames/latest`
    );
  }

  getVideoFrameImageUrl(frameId: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/meetings/${this.meetingId}/video-frames/${encodeURIComponent(frameId)}/image`;
  }

  async getVideoFrameImage(frameId: string): Promise<ArrayBuffer> {
    const response = await fetch(this.getVideoFrameImageUrl(frameId));

    if (!response.ok) {
      throw new Error(
        `MeetAgent video frame request failed: ${response.status} ${response.statusText}`
      );
    }

    return response.arrayBuffer();
  }

  async waitForCommand(
    commandId: string,
    timeoutMs = 30000
  ): Promise<CommandCompletedEvent> {
    const current = await this.getCommand(commandId).catch(() => undefined);

    if (current?.status === 'completed') {
      return {
        type: 'command.completed',
        botId: current.botId,
        meetingId: current.meetingId,
        commandId: current.id,
        timestamp: current.completedAt ?? current.startedAt ?? current.createdAt,
        payload: {
          commandType: current.type,
          status: 'completed',
          result: current.result
        }
      };
    }

    if (current?.status === 'failed') {
      throw new Error(current.error ?? `Command ${commandId} failed`);
    }

    const result = await this.waitForOneOfEvents<CommandCompletedEvent | CommandFailedEvent>(
      ['commandCompleted', 'commandFailed'],
      (event) => (event as { commandId?: string }).commandId === commandId,
      timeoutMs
    );

    if (result.type === 'command.failed') {
      throw new Error(result.payload.error);
    }

    return result;
  }

  startLiveInputs(options: {
    onInput: (input: LiveInputEvent) => void | Promise<void>;
    onError?: (error: Error) => void;
  }): () => void {
    let stopped = false;
    let inputPump = Promise.resolve();

    const enqueue = (input: LiveInputEvent) => {
      inputPump = inputPump
        .then(async () => {
          if (!stopped) {
            await options.onInput(input);
          }
        })
        .catch((error) => {
          options.onError?.(
            error instanceof Error ? error : new Error('Unknown live input error')
          );
        });
    };

    const chatHandler = (event: unknown) => {
      const payload = event as ChatDetectedEvent;
      enqueue({
        kind: 'chat',
        event: payload,
        text: payload.payload.text,
        speaker: payload.payload.author,
        occurredAt: payload.payload.sentAt
      });
    };

    const captionHandler = (event: unknown) => {
      const payload = event as CaptionDetectedEvent;
      enqueue({
        kind: 'caption',
        event: payload,
        text: payload.payload.text,
        speaker: payload.payload.speaker,
        occurredAt: payload.payload.startAt
      });
    };

    const audioHandler = (event: unknown) => {
      const payload = event as AudioTranscriptEvent;
      enqueue({
        kind: 'audioTranscript',
        event: payload,
        text: payload.payload.text,
        speaker: payload.payload.speaker,
        occurredAt: payload.payload.startedAt
      });
    };

    this.on('chat', chatHandler);
    this.on('caption', captionHandler);
    this.on('audioTranscript', audioHandler);

    return () => {
      stopped = true;
      this.off('chat', chatHandler);
      this.off('caption', captionHandler);
      this.off('audioTranscript', audioHandler);
    };
  }

  startLiveVideoFrames(options: {
    onFrame: (frame: LiveVideoFrame) => void | Promise<void>;
    onError?: (error: Error) => void;
  }): () => void {
    let stopped = false;
    let isProcessing = false;
    let pendingEvent: VideoFrameEvent | undefined;

    const pump = async () => {
      if (stopped || isProcessing) {
        return;
      }

      isProcessing = true;

      try {
        while (!stopped && pendingEvent) {
          const nextEvent = pendingEvent;
          pendingEvent = undefined;

          const imageUrl =
            nextEvent.payload.frameUrl ??
            this.getVideoFrameImageUrl(nextEvent.payload.frameId);

          const response = await fetch(imageUrl, {
            cache: 'no-store'
          });

          if (!response.ok) {
            throw new Error(
              `MeetAgent live video frame request failed: ${response.status} ${response.statusText}`
            );
          }

          const image = await response.arrayBuffer();

          await options.onFrame({
            event: nextEvent,
            image,
            imageUrl
          });
        }
      } catch (error) {
        options.onError?.(
          error instanceof Error ? error : new Error('Unknown live video frame error')
        );
      } finally {
        isProcessing = false;

        if (!stopped && pendingEvent) {
          void pump();
        }
      }
    };

    const handleFrame = (event: unknown) => {
      pendingEvent = event as VideoFrameEvent;
      void pump();
    };

    this.on('videoFrame', handleFrame);

    return () => {
      stopped = true;
      pendingEvent = undefined;
      this.off('videoFrame', handleFrame);
    };
  }

  startLiveSession(options: {
    onInput?: (input: LiveInputEvent) => void | Promise<void>;
    onVideoFrame?: (frame: LiveVideoFrame) => void | Promise<void>;
    onError?: (error: Error) => void;
  }): () => void {
    const stopInputs = options.onInput
      ? this.startLiveInputs({
          onInput: options.onInput,
          onError: options.onError
        })
      : () => {};

    const stopVideo = options.onVideoFrame
      ? this.startLiveVideoFrames({
          onFrame: options.onVideoFrame,
          onError: options.onError
        })
      : () => {};

    return () => {
      stopInputs();
      stopVideo();
    };
  }

  private bindStreamEvent<T = BotEvent | MeetingTimeline>(
    source: EventSource,
    eventName: string,
    handler: (payload: T) => void
  ): void {
    source.addEventListener(eventName, (event) => {
      handler(JSON.parse((event as EventSourceMessage).data) as T);
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, init);

    if (!response.ok) {
      throw new Error(
        `MeetAgent request failed: ${response.status} ${response.statusText}`
      );
    }

    return (await response.json()) as T;
  }

  private async waitForOneOfEvents<T>(
    eventNames: Array<
      | 'connected'
      | 'snapshot'
      | 'event'
      | 'chat'
      | 'caption'
      | 'audioTranscript'
      | 'videoFrame'
      | 'videoActivity'
      | 'botStatus'
      | 'commandStarted'
      | 'commandCompleted'
      | 'commandFailed'
      | 'speechCompleted'
      | 'speechFailed'
      | 'error'
    >,
    predicate: (payload: T) => boolean,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for events: ${eventNames.join(', ')}`));
      }, timeoutMs);

      const handlers = new Map<string, (...args: unknown[]) => void>();

      const cleanup = () => {
        clearTimeout(timeout);

        for (const [eventName, handler] of handlers.entries()) {
          this.off(eventName, handler);
        }
      };

      for (const eventName of eventNames) {
        const handler = (payload: unknown) => {
          const typedPayload = payload as T;

          if (!predicate(typedPayload)) {
            return;
          }

          cleanup();
          resolve(typedPayload);
        };

        handlers.set(eventName, handler);
        this.on(eventName, handler);
      }
    });
  }
}
