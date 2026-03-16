export type BotStatus =
  | 'created'
  | 'starting'
  | 'launching'
  | 'joining'
  | 'waiting_for_admission'
  | 'joined'
  | 'disconnected'
  | 'recovering'
  | 'failed'
  | 'closed';

export type CommandStatus = 'queued' | 'started' | 'completed' | 'failed';

export interface RtpAudioTransportDescriptor {
  transport: 'rtp';
  host: string;
  port: number;
  codec: 'L16';
  sampleRate: number;
  channels: number;
  direction: 'sendonly' | 'recvonly';
  sdp: string;
}

export interface RtpVideoTransportDescriptor {
  transport: 'rtp';
  host: string;
  port: number;
  codec: 'JPEG';
  fps: number;
  direction: 'sendonly' | 'recvonly';
  sdp: string;
}

export interface RealtimeMediaTransportDescriptor {
  audioInput?: RtpAudioTransportDescriptor;
  meetingAudioOutput?: RtpAudioTransportDescriptor;
  videoOutput?: RtpVideoTransportDescriptor;
}

type CommandEnvelope<TType extends string, TPayload> = {
  id: string;
  type: TType;
  botId: string;
  meetingId: string;
  payload: TPayload;
  createdAt: string;
  status: CommandStatus;
  startedAt?: string;
  completedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
};

export type ChatSendCommand = CommandEnvelope<
  'chat.send',
  {
    text: string;
  }
>;

export type BotJoinCommand = CommandEnvelope<
  'bot.join',
  {
    meetingUrl: string;
    displayName: string;
    camera?: boolean;
    microphone?: boolean;
  }
>;

export type BotLeaveCommand = CommandEnvelope<
  'bot.leave',
  Record<string, never>
>;

export type SpeechSayCommand = CommandEnvelope<
  'speech.say',
  {
    text: string;
    voice?: string;
    rate?: number;
    pitch?: number;
    volume?: number;
  }
>;

export type BotCommand = ChatSendCommand | BotJoinCommand | BotLeaveCommand | SpeechSayCommand;

export type EnqueueBotCommand =
  | Omit<
      ChatSendCommand,
      'id' | 'createdAt' | 'status' | 'startedAt' | 'completedAt' | 'result' | 'error'
    >
  | Omit<
      BotJoinCommand,
      'id' | 'createdAt' | 'status' | 'startedAt' | 'completedAt' | 'result' | 'error'
    >
  | Omit<
      BotLeaveCommand,
      'id' | 'createdAt' | 'status' | 'startedAt' | 'completedAt' | 'result' | 'error'
    >
  | Omit<
      SpeechSayCommand,
      'id' | 'createdAt' | 'status' | 'startedAt' | 'completedAt' | 'result' | 'error'
    >;

type SessionEventBase<TType extends string, TPayload> = {
  type: TType;
  botId: string;
  meetingId?: string;
  commandId?: string;
  payload: TPayload;
  timestamp: string;
};

type MeetingEventBase<TType extends string, TPayload> = Omit<
  SessionEventBase<TType, TPayload>,
  'meetingId'
> & {
  meetingId: string;
};

export type BotRegisteredEvent = SessionEventBase<
  'bot.registered',
  {
    displayName?: string;
    runtimeUrl?: string;
    metadata?: Record<string, unknown>;
  }
>;

export type BotStatusChangedEvent = SessionEventBase<
  'bot.status.changed',
  {
    status: BotStatus;
    error?: string;
  }
>;

export type ChatMessageDetectedEvent = MeetingEventBase<
  'chat.message.detected',
  {
    messageId: string;
    author: string;
    text: string;
    sentAt: string;
  }
>;

export type CaptionSegmentDetectedEvent = MeetingEventBase<
  'caption.segment.detected',
  {
    segmentId: string;
    speaker: string;
    text: string;
    startAt: string;
  }
>;

export type AudioTranscriptDetectedEvent = MeetingEventBase<
  'audio.transcript.detected',
  {
    transcriptId: string;
    speaker: string;
    text: string;
    confidence?: number;
    startedAt: string;
    endedAt?: string;
    language?: string;
    source: 'meeting-audio';
  }
>;

export type VideoFrameDetectedEvent = MeetingEventBase<
  'video.frame.detected',
  {
    frameId: string;
    capturedAt: string;
    width?: number;
    height?: number;
    framePath?: string;
    thumbnailPath?: string;
    frameUrl?: string;
  }
>;

export type VideoActivityDetectedEvent = MeetingEventBase<
  'video.activity.detected',
  {
    activityId: string;
    detectedAt: string;
    activeSpeaker?: string;
    presentationActive?: boolean;
    participantTileCount?: number;
    summary: string;
    metadata?: Record<string, unknown>;
  }
>;

export type MediaTransportReadyEvent = MeetingEventBase<
  'media.transport.ready',
  {
    transport: RealtimeMediaTransportDescriptor;
  }
>;

export type MediaTransportFailedEvent = MeetingEventBase<
  'media.transport.failed',
  {
    stage: 'audio-input' | 'meeting-audio-output' | 'video-output' | 'unknown';
    error: string;
  }
>;

export type SpeechOutputCompletedEvent = MeetingEventBase<
  'speech.output.completed',
  {
    text: string;
    voice?: string;
    durationMs?: number;
    wavPath?: string;
    backend?: string;
  }
>;

export type SpeechOutputFailedEvent = MeetingEventBase<
  'speech.output.failed',
  {
    text: string;
    error: string;
  }
>;

export type CommandStartedEvent = MeetingEventBase<
  'command.started',
  {
    commandType: BotCommand['type'];
    status: 'started';
  }
>;

export type CommandCompletedEvent = MeetingEventBase<
  'command.completed',
  {
    commandType: BotCommand['type'];
    status: 'completed';
    result?: Record<string, unknown>;
  }
>;

export type CommandFailedEvent = MeetingEventBase<
  'command.failed',
  {
    commandType: BotCommand['type'];
    status: 'failed';
    error: string;
  }
>;

export type BotEvent =
  | AudioTranscriptDetectedEvent
  | BotRegisteredEvent
  | BotStatusChangedEvent
  | CaptionSegmentDetectedEvent
  | ChatMessageDetectedEvent
  | CommandCompletedEvent
  | CommandFailedEvent
  | CommandStartedEvent
  | MediaTransportFailedEvent
  | MediaTransportReadyEvent
  | SpeechOutputCompletedEvent
  | SpeechOutputFailedEvent
  | VideoActivityDetectedEvent
  | VideoFrameDetectedEvent;

export interface BotRegistration {
  botId: string;
  displayName: string;
  runtimeUrl?: string;
  meetingId?: string;
  metadata?: Record<string, unknown>;
}

export interface BotRecord {
  botId: string;
  displayName: string;
  runtimeUrl?: string;
  meetingId?: string;
  status: BotStatus;
  metadata?: Record<string, unknown>;
  lastSeenAt: string;
  createdAt: string;
  error?: string;
}

export interface MeetingSession {
  meetingId: string;
  meetingUrl?: string;
  botIds: string[];
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
}

export interface ChatMessageRecord {
  meetingId: string;
  messageId: string;
  author: string;
  text: string;
  sentAt: string;
  detectedAt: string;
  botId: string;
}

export interface CaptionSegmentRecord {
  meetingId: string;
  segmentId: string;
  speaker: string;
  text: string;
  startAt: string;
  detectedAt: string;
  botId: string;
}

export interface AudioTranscriptRecord {
  meetingId: string;
  transcriptId: string;
  speaker: string;
  text: string;
  confidence?: number;
  startedAt: string;
  endedAt?: string;
  language?: string;
  detectedAt: string;
  botId: string;
}

export interface VideoEventRecord {
  meetingId: string;
  eventId: string;
  eventType: 'video.frame.detected' | 'video.activity.detected';
  botId: string;
  detectedAt: string;
  activeSpeaker?: string;
  presentationActive?: boolean;
  participantTileCount?: number;
  summary?: string;
  framePath?: string;
  thumbnailPath?: string;
  frameUrl?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingTimeline {
  meeting: MeetingSession;
  commands: BotCommand[];
  events: BotEvent[];
  messages: ChatMessageRecord[];
  captions: CaptionSegmentRecord[];
  audioTranscripts: AudioTranscriptRecord[];
  videoEvents: VideoEventRecord[];
}
