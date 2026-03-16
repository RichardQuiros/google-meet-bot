import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { ControlClient } from './ControlClient.js';
import { MeetBot } from '../bot/MeetBot.js';
import {
  MeetChatObserver,
  type ChatObserverDebugInfo
} from '../bot/MeetChatObserver.js';
import { MeetCaptionsObserver } from '../bot/MeetCaptionsObserver.js';
import {
  MeetVideoObserver,
  type DetectedVideoActivity,
  type DetectedVideoFrame
} from '../bot/MeetVideoObserver.js';
import { SpeechOutputService } from '../bot/SpeechOutputService.js';
import { TtsService } from '../audio/TtsService.js';
import { LinuxAudioOutputProvider } from '../audio/LinuxAudioOutputProvider.js';
import { WindowsAudioOutputProvider } from '../audio/WindowsAudioOutputProvider.js';
import { CliSpeechToTextProvider } from '../audio/CliSpeechToTextProvider.js';
import {
  AudioTranscriptObserver,
  type AudioObserverDebugInfo,
  type DetectedAudioTranscript
} from '../audio/AudioTranscriptObserver.js';
import { RtpMediaRelay } from '../media/RtpMediaRelay.js';
import type {
  BotCommand,
  BotEvent,
  BotJoinCommand,
  BotRegistration,
  BotStatus
} from '../types/control.js';

type RuntimeAgentOptions = {
  botId: string;
  displayName: string;
  controlBaseUrl: string;
  runtimeUrl?: string;
  pollIntervalMs?: number;
  recoveryBackoffMs?: number;
  enableAudioInput?: boolean;
  enableVideoInput?: boolean;
  captureVideoFrames?: boolean;
  audioInputDevice?: string;
};

export class RuntimeAgent {
  private readonly botId: string;
  private readonly displayName: string;
  private readonly controlClient: ControlClient;
  private readonly bot: MeetBot;
  private readonly pollIntervalMs: number;
  private readonly recoveryBackoffMs: number;
  private readonly enableAudioInput: boolean;
  private readonly enableVideoInput: boolean;
  private readonly captureVideoFrames: boolean;
  private readonly audioInputDevice?: string;
  private readonly runtimeUrl?: string;

  private speechOutput?: SpeechOutputService;
  private isRunning = false;
  private isRecovering = false;
  private nextRecoveryAttemptAt = 0;
  private activeMeetingId?: string;
  private lastJoinCommand?: BotJoinCommand;
  private observerPage?: Page;
  private chatObserver?: MeetChatObserver;
  private captionsObserver?: MeetCaptionsObserver;
  private audioObserver?: AudioTranscriptObserver;
  private videoObserver?: MeetVideoObserver;
  private realtimeMediaRelay?: RtpMediaRelay;
  private realtimeMediaAnnounced = false;
  private pendingVideoFrame?: { meetingId: string } & DetectedVideoFrame;
  private videoFrameFlushPromise?: Promise<void>;

  constructor(options: RuntimeAgentOptions) {
    this.botId = options.botId;
    this.displayName = options.displayName;
    this.runtimeUrl = options.runtimeUrl;
    this.controlClient = new ControlClient(options.controlBaseUrl, options.botId);
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.recoveryBackoffMs = options.recoveryBackoffMs ?? 10000;
    this.enableAudioInput =
      options.enableAudioInput ?? process.env.ENABLE_AUDIO_INPUT === 'true';
    this.enableVideoInput =
      options.enableVideoInput ?? process.env.ENABLE_VIDEO_INPUT === 'true';
    this.captureVideoFrames =
      options.captureVideoFrames ?? process.env.CAPTURE_VIDEO_FRAMES !== 'false';
    this.audioInputDevice =
      options.audioInputDevice ?? process.env.MEET_AUDIO_INPUT_DEVICE;

    this.bot = new MeetBot({
      id: options.botId,
      displayName: options.displayName,
      meetingUrl: '',
      status: 'created'
    });
  }

  async start(): Promise<void> {
    const registration: BotRegistration = {
      botId: this.botId,
      displayName: this.displayName,
      runtimeUrl: this.runtimeUrl,
      metadata: this.buildRuntimeMetadata()
    };

    this.log('registering bot with control server');
    await this.controlClient.registerBot(registration);
    await this.sendStatus('starting');

    this.isRunning = true;
    this.log('starting command polling loop');

    while (this.isRunning) {
      try {
        await this.ensureRuntimeHealth();
        await this.ensureMediaObservers();

        const command = await this.controlClient.getNextCommand(this.pollIntervalMs);
        if (command) {
          this.log(`received command ${command.type}`, { commandId: command.id });
          await this.processCommand(command);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown runtime loop error';

        this.log('runtime loop error', { message });
        await this.sendStatus('disconnected', message).catch(() => {});
        await this.sleep(Math.min(this.pollIntervalMs, 1000));
      }
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.stopMediaObservers();
    await this.bot.close().catch(() => {});
    await this.sendStatus('closed').catch(() => {});
  }

  private async processCommand(command: BotCommand): Promise<void> {
    await this.emitCommandStarted(command);

    try {
      let result: Record<string, unknown>;

      switch (command.type) {
        case 'bot.join':
          result = await this.handleJoinCommand(command);
          break;
        case 'bot.leave':
          result = await this.handleLeaveCommand(command);
          break;
        case 'chat.send':
          result = await this.handleChatSendCommand(command);
          break;
        case 'speech.say':
          result = await this.handleSpeechSayCommand(command);
          break;
        default:
          throw new Error(`Unsupported command type: ${(command as BotCommand).type}`);
      }

      await this.emitCommandCompleted(command, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown command error';

      if (command.type === 'bot.join') {
        await this.sendStatus('failed', message).catch(() => {});
      }

      await this.emitCommandFailed(command, message);
    }
  }

  private async handleJoinCommand(
    command: Extract<BotCommand, { type: 'bot.join' }>
  ): Promise<Record<string, unknown>> {
    this.lastJoinCommand = command;
    this.activeMeetingId = command.meetingId;
    this.bot.record.meetingUrl = command.payload.meetingUrl;
    this.bot.record.displayName = command.payload.displayName;

    await this.stopMediaObservers();
    await this.sendStatus('joining');

    await this.bot.join({
      camera: command.payload.camera ?? false,
      microphone: command.payload.microphone ?? false
    });

    await this.sendStatus(this.bot.record.status as BotStatus, this.bot.record.error);

    if (this.bot.record.status === 'failed') {
      throw new Error(this.bot.record.error ?? 'Join failed');
    }

    if (this.bot.record.status === 'joined') {
      await this.ensureMediaObservers();
    }

    return {
      meetingId: command.meetingId,
      meetingUrl: command.payload.meetingUrl,
      status: this.bot.record.status,
      waitingForAdmission: this.bot.record.status === 'waiting_for_admission'
    };
  }

  private async handleChatSendCommand(
    command: Extract<BotCommand, { type: 'chat.send' }>
  ): Promise<Record<string, unknown>> {
    this.ensureJoinedForCommand('chat.send');
    await this.bot.sendChatMessage(command.payload.text);

    return {
      text: command.payload.text
    };
  }

  private async handleLeaveCommand(
    command: Extract<BotCommand, { type: 'bot.leave' }>
  ): Promise<Record<string, unknown>> {
    await this.stopMediaObservers();
    await this.bot.close().catch(() => {});

    this.activeMeetingId = undefined;
    this.lastJoinCommand = undefined;
    this.speechOutput = undefined;
    this.realtimeMediaRelay = undefined;

    await this.sendStatus('closed');

    return {
      meetingId: command.meetingId,
      status: 'closed'
    };
  }

  private async handleSpeechSayCommand(
    command: Extract<BotCommand, { type: 'speech.say' }>
  ): Promise<Record<string, unknown>> {
    try {
      this.ensureJoinedForCommand('speech.say');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bot is not joined';
      await this.emitSpeechOutputFailed({
        meetingId: command.meetingId,
        commandId: command.id,
        text: command.payload.text,
        error: message
      });
      throw error;
    }

    await this.ensureSpeechDeliveryReady();

    const speechOutput = this.getSpeechOutputService();

    try {
      this.log('speech output starting', this.isSpeechDebugEnabled()
        ? {
            meetingId: command.meetingId,
            text: command.payload.text,
            voice: command.payload.voice,
            deliveryMode: this.getSpeechDeliveryMode(),
            config: speechOutput.getDebugConfig()
          }
        : {
            meetingId: command.meetingId,
            text: command.payload.text,
            voice: command.payload.voice,
            deliveryMode: this.getSpeechDeliveryMode()
          });

      const result = await speechOutput.speak({
        text: command.payload.text,
        voice: command.payload.voice,
        rate: command.payload.rate,
        pitch: command.payload.pitch,
        volume: command.payload.volume
      });

      this.log('speech output completed', {
        meetingId: command.meetingId,
        durationMs: result.durationMs,
        wavPath: result.wavPath,
        backend: result.backend
      });

      await this.emitSpeechOutputCompleted({
        meetingId: command.meetingId,
        commandId: command.id,
        text: command.payload.text,
        voice: command.payload.voice,
        durationMs: result.durationMs,
        wavPath: result.wavPath,
        backend: result.backend
      });

      return {
        text: command.payload.text,
        durationMs: result.durationMs,
        wavPath: result.wavPath,
        backend: result.backend
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown speech output error';

      this.log('speech output failed', { message });

      await this.emitSpeechOutputFailed({
        meetingId: command.meetingId,
        commandId: command.id,
        text: command.payload.text,
        error: message
      });

      throw error;
    }
  }

  private async ensureMediaObservers(): Promise<void> {
    if (this.bot.record.status !== 'joined' || !this.activeMeetingId) {
      return;
    }

    const page = this.bot.getPage();
    if (!page || page.isClosed()) {
      return;
    }

    if (this.observerPage && this.observerPage !== page) {
      await this.stopMediaObservers();
    }

    this.observerPage = page;

    await this.ensureRealtimeMediaRelay();

    if (!this.chatObserver) {
      await this.startChatObserver(page);
    }

    if (!this.captionsObserver) {
      await this.startCaptionsObserver(page);
    }

    if (this.enableAudioInput && !this.audioObserver) {
      await this.startAudioObserver();
    }

    if (this.enableVideoInput && !this.videoObserver) {
      await this.startVideoObserver(page);
    }
  }

  private async startChatObserver(page: Page): Promise<void> {
    this.chatObserver = new MeetChatObserver(page, {
      pollIntervalMs: Number.parseInt(process.env.CHAT_POLL_INTERVAL_MS ?? '500', 10),
      maxSeenMessages: 500,
      ownDisplayNames: [this.displayName],
      skipInitialVisibleMessages:
        process.env.SKIP_INITIAL_CHAT_MESSAGES === 'true'
    });

    await this.chatObserver.start(async (messages) => {
      for (const message of messages) {
        this.log('chat detected', { author: message.author, text: message.text });

        await this.emitDetectedChatMessage({
          meetingId: this.activeMeetingId!,
          author: message.author,
          text: message.text,
          sentAt: message.sentAt,
          messageId: message.messageId
        });
      }
    }, (error) => {
      this.log('chat observer error', { message: error.message });
    }, this.isChatDebugEnabled()
      ? (debug) => {
          this.logChatObserverDebug(debug);
        }
      : undefined);

    const probe = this.isChatDebugEnabled()
      ? await this.chatObserver.probe().catch((error) => ({
          visibleCount: -1,
          sample: [],
          error: error instanceof Error ? error.message : 'Unknown chat probe error'
        }))
      : undefined;

    this.log('chat observer started', {
      meetingId: this.activeMeetingId,
      skipInitialVisibleMessages:
        process.env.SKIP_INITIAL_CHAT_MESSAGES === 'true',
      probe
    });
  }

  private async startCaptionsObserver(page: Page): Promise<void> {
    this.captionsObserver = new MeetCaptionsObserver(page, {
      pollIntervalMs: Number.parseInt(process.env.CAPTION_POLL_INTERVAL_MS ?? '400', 10),
      maxSeenSegments: 500,
      ownDisplayNames: [this.displayName],
      skipInitialVisibleSegments: true
    });

    await this.captionsObserver.start(async (segments) => {
      for (const segment of segments) {
        this.log('caption detected', { speaker: segment.speaker, text: segment.text });

        await this.emitDetectedCaptionSegment({
          meetingId: this.activeMeetingId!,
          speaker: segment.speaker,
          text: segment.text,
          startAt: segment.startAt,
          segmentId: segment.segmentId
        });
      }
    });
  }

  private async startAudioObserver(): Promise<void> {
    if (!this.audioInputDevice) {
      this.log('audio input enabled but MEET_AUDIO_INPUT_DEVICE is not configured');
      return;
    }

    const sttProvider = new CliSpeechToTextProvider();
    if (!sttProvider.isConfigured()) {
      this.log('audio input enabled but no STT command is configured');
      return;
    }

    this.audioObserver = new AudioTranscriptObserver(sttProvider, {
      inputDevice: this.audioInputDevice,
      segmentDurationMs: Number.parseInt(process.env.AUDIO_SEGMENT_DURATION_MS ?? '2500', 10),
      cooldownMs: Number.parseInt(process.env.AUDIO_SEGMENT_COOLDOWN_MS ?? '100', 10),
      keepSegments: process.env.KEEP_AUDIO_SEGMENTS === 'true'
    });

    this.log('audio observer starting', this.audioObserver.getDebugConfig());

    await this.audioObserver.start(
      async (transcripts) => {
        for (const transcript of transcripts) {
          this.log('audio transcript detected', {
            speaker: transcript.speaker,
            text: transcript.text
          });

          await this.emitDetectedAudioTranscript({
            meetingId: this.activeMeetingId!,
            ...transcript
          });
        }
      },
      (error) => {
        this.log('audio observer error', { message: error.message });
      },
      this.isAudioDebugEnabled()
        ? (debug) => {
            this.logAudioObserverDebug(debug);
          }
        : undefined
    );

    this.log('audio observer started', {
      meetingId: this.activeMeetingId,
      inputDevice: this.audioInputDevice
    });
  }

  private isChatDebugEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.DEBUG_CHAT_OBSERVER ?? '');
  }

  private isAudioDebugEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.DEBUG_AUDIO_INPUT ?? '');
  }

  private isVideoDebugEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.DEBUG_VIDEO_INPUT ?? '');
  }

  private isSpeechDebugEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.DEBUG_SPEECH_OUTPUT ?? '');
  }

  private shouldAutoEnableMicrophoneForSpeech(): boolean {
    return !/^(0|false|no)$/i.test(process.env.SPEECH_AUTO_ENABLE_MICROPHONE ?? 'true');
  }

  private getSpeechDeliveryMode(): 'meeting-microphone' | 'local-playback' {
    return /^(local|local-playback|speaker-only)$/i.test(
      process.env.SPEECH_DELIVERY_MODE ?? ''
    )
      ? 'local-playback'
      : 'meeting-microphone';
  }

  private async ensureSpeechDeliveryReady(): Promise<void> {
    const deliveryMode = this.getSpeechDeliveryMode();

    if (deliveryMode === 'local-playback') {
      return;
    }

    const preferredMicrophoneSelection =
      await this.bot.ensurePreferredMicrophoneSelected();

    if (preferredMicrophoneSelection.reason !== 'not-configured') {
      this.log('preferred microphone selection attempt', preferredMicrophoneSelection);

      if (!preferredMicrophoneSelection.selected) {
        throw new Error(
          `Unable to select the preferred Meet microphone${
            preferredMicrophoneSelection.preferredLabel
              ? ` "${preferredMicrophoneSelection.preferredLabel}"`
              : ''
          }.`
        );
      }
    }

    const microphoneState = await this.bot.getMicrophoneState();
    this.log('speech microphone state', microphoneState);

    if (microphoneState.state === 'disabled') {
      if (!this.shouldAutoEnableMicrophoneForSpeech()) {
        throw new Error(
          'Bot microphone is muted. Join with microphone=true or unmute it in Meet before calling speak.'
        );
      }

      const result = await this.bot.ensureMicrophoneEnabled();
      this.log('speech microphone enable attempt', result);

      if (result.state !== 'enabled') {
        throw new Error(
          'Bot microphone is muted and could not be enabled automatically. Unmute it in Meet or join with microphone=true before calling speak.'
        );
      }
    } else if (microphoneState.state === 'unknown') {
      throw new Error(
        'Unable to determine the bot microphone state in Meet. Confirm the microphone control is visible and enabled before calling speak.'
      );
    }

    if (process.platform === 'win32') {
      const loopbackHint =
        process.env.WINDOWS_MEETING_LOOPBACK_HINT ??
        process.env.MEET_AUDIO_INPUT_DEVICE ??
        process.env.WINDOWS_MEETING_MICROPHONE_HINT;

      if (!loopbackHint) {
        throw new Error(
          'Windows speech delivery to the meeting requires a loopback or virtual microphone route. Configure MEET_AUDIO_INPUT_DEVICE or WINDOWS_MEETING_LOOPBACK_HINT and choose that device as the Meet microphone. If you only want a local speaker test, set SPEECH_DELIVERY_MODE=local-playback.'
        );
      }

      this.log('speech delivery loopback hint', { loopbackHint });
    }
  }

  private logAudioObserverDebug(debug: AudioObserverDebugInfo): void {
    this.log('audio observer debug', debug);
  }

  private async startVideoObserver(page: Page): Promise<void> {
    this.videoObserver = new MeetVideoObserver(page, {
      pollIntervalMs: Number.parseInt(process.env.VIDEO_POLL_INTERVAL_MS ?? '700', 10),
      captureFrames: this.captureVideoFrames,
      detectActivity: /^(1|true|yes)$/i.test(process.env.ENABLE_VIDEO_ACTIVITY ?? ''),
      jpegQuality: Number.parseInt(process.env.VIDEO_JPEG_QUALITY ?? '45', 10)
    });

    await this.videoObserver.start({
      onFrame: async (frame) => {
        if (frame.framePath) {
          await this.realtimeMediaRelay?.pushVideoFrame(frame.framePath).catch((error) => {
            const message =
              error instanceof Error ? error.message : 'Unknown RTP video relay error';
            this.log('realtime video relay error', { message });
          });
        }

        this.queueLatestVideoFrameEmit({
          meetingId: this.activeMeetingId!,
          ...frame
        });
      },
      onActivity: async (activity) => {
        if (this.isVideoDebugEnabled()) {
          this.log('video activity detected', activity);
        }

        await this.emitDetectedVideoActivity({
          meetingId: this.activeMeetingId!,
          ...activity
        });
      },
      onError: (error) => {
        this.log('video observer error', { message: error.message });
      }
    });

    this.log('video observer started', {
      meetingId: this.activeMeetingId,
      captureFrames: this.captureVideoFrames,
      detectActivity: /^(1|true|yes)$/i.test(process.env.ENABLE_VIDEO_ACTIVITY ?? ''),
      pollIntervalMs: Number.parseInt(process.env.VIDEO_POLL_INTERVAL_MS ?? '700', 10)
    });
  }

  private async stopMediaObservers(): Promise<void> {
    this.chatObserver?.stop();
    this.captionsObserver?.stop();
    this.videoObserver?.stop();
    await this.audioObserver?.stop();
    await this.realtimeMediaRelay?.stop();

    this.chatObserver = undefined;
    this.captionsObserver = undefined;
    this.videoObserver = undefined;
    this.audioObserver = undefined;
    this.observerPage = undefined;
    this.pendingVideoFrame = undefined;
    this.realtimeMediaAnnounced = false;
    this.videoFrameFlushPromise = undefined;
  }

  private async ensureRuntimeHealth(): Promise<void> {
    if (!this.lastJoinCommand) {
      return;
    }

    const page = this.bot.getPage();
    if (page && !page.isClosed()) {
      return;
    }

    const recoverableStates = new Set<BotStatus>([
      'joined',
      'waiting_for_admission',
      'disconnected',
      'recovering'
    ]);

    if (!recoverableStates.has(this.bot.record.status as BotStatus)) {
      return;
    }

    if (this.isRecovering || Date.now() < this.nextRecoveryAttemptAt) {
      return;
    }

    this.isRecovering = true;
    this.nextRecoveryAttemptAt = Date.now() + this.recoveryBackoffMs;

    try {
      await this.stopMediaObservers();
      await this.sendStatus('recovering');

      await this.bot.join({
        camera: this.lastJoinCommand.payload.camera ?? false,
        microphone: this.lastJoinCommand.payload.microphone ?? false
      });

      await this.sendStatus(this.bot.record.status as BotStatus, this.bot.record.error);

      if (this.bot.record.status === 'failed') {
        throw new Error(this.bot.record.error ?? 'Recovery join failed');
      }

      if (this.bot.record.status === 'joined') {
        await this.ensureMediaObservers();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown recovery error';
      await this.sendStatus('disconnected', message).catch(() => {});
    } finally {
      this.isRecovering = false;
    }
  }

  private ensureJoinedForCommand(commandType: BotCommand['type']): void {
    if (this.bot.record.status !== 'joined') {
      throw new Error(
        `Cannot execute ${commandType} while bot status is ${this.bot.record.status}`
      );
    }
  }

  private getSpeechOutputService(): SpeechOutputService {
    if (!this.speechOutput) {
      const audioOutputProvider =
        process.platform === 'win32'
          ? new WindowsAudioOutputProvider()
          : new LinuxAudioOutputProvider();

      this.speechOutput = new SpeechOutputService(
        new TtsService(),
        audioOutputProvider
      );
    }

    return this.speechOutput;
  }

  private buildRuntimeMetadata(): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      capabilities: {
        audioInput: this.enableAudioInput,
        videoInput: this.enableVideoInput,
        captureVideoFrames: this.captureVideoFrames,
        directSpeechRtpInput: this.hasRealtimeTransport(
          this.getRealtimeMediaRelay().getDescriptor().audioInput
        ),
        meetingAudioRtpOutput: this.hasRealtimeTransport(
          this.getRealtimeMediaRelay().getDescriptor().meetingAudioOutput
        ),
        videoRtpOutput: this.hasRealtimeTransport(
          this.getRealtimeMediaRelay().getDescriptor().videoOutput
        )
      }
    };

    const transport = this.getRealtimeMediaRelay().getDescriptor();

    if (
      this.hasRealtimeTransport(transport.audioInput) ||
      this.hasRealtimeTransport(transport.meetingAudioOutput) ||
      this.hasRealtimeTransport(transport.videoOutput)
    ) {
      metadata.realtimeTransport = transport;
    }

    return metadata;
  }

  private async ensureRealtimeMediaRelay(): Promise<void> {
    const relay = this.getRealtimeMediaRelay();

    if (!relay.isEnabled() || !this.activeMeetingId) {
      return;
    }

    if (this.realtimeMediaAnnounced) {
      return;
    }

    try {
      const transport = await relay.start();
      await this.emitMediaTransportReady({
        meetingId: this.activeMeetingId,
        transport
      });
      this.realtimeMediaAnnounced = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown realtime media relay error';

      this.log('realtime media relay failed', { message });
      await this.emitMediaTransportFailed({
        meetingId: this.activeMeetingId,
        stage: 'unknown',
        error: message
      });
    }
  }

  private getRealtimeMediaRelay(): RtpMediaRelay {
    if (!this.realtimeMediaRelay) {
      this.realtimeMediaRelay = new RtpMediaRelay({
        ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
        audioInput: {
          port: this.parseOptionalInteger(process.env.REALTIME_AGENT_AUDIO_RTP_PORT),
          advertiseHost: process.env.REALTIME_PUBLIC_HOST ?? 'localhost',
          sampleRate: this.parseIntegerWithFallback(
            process.env.REALTIME_AGENT_AUDIO_SAMPLE_RATE,
            24000
          ),
          channels: this.parseIntegerWithFallback(
            process.env.REALTIME_AGENT_AUDIO_CHANNELS,
            1
          )
        },
        meetingAudioOutput: {
          targetUrl: process.env.REALTIME_MEETING_AUDIO_RTP_URL,
          inputDevice: this.audioInputDevice ?? '',
          inputFormat: process.env.MEET_AUDIO_INPUT_FORMAT ?? this.getDefaultAudioInputFormat(),
          sampleRate: this.parseIntegerWithFallback(
            process.env.REALTIME_MEETING_AUDIO_SAMPLE_RATE,
            16000
          ),
          channels: this.parseIntegerWithFallback(
            process.env.REALTIME_MEETING_AUDIO_CHANNELS,
            1
          )
        },
        videoOutput: {
          targetUrl: process.env.REALTIME_VIDEO_RTP_URL,
          fps: this.parseIntegerWithFallback(process.env.REALTIME_VIDEO_FPS, 4)
        },
        onLog: (message, data) => {
          this.log(`realtime relay ${message}`, data);
        }
      });
    }

    return this.realtimeMediaRelay;
  }

  private hasRealtimeTransport(value: unknown): boolean {
    return Boolean(value && typeof value === 'object');
  }

  private parseIntegerWithFallback(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseOptionalInteger(value: string | undefined): number | undefined {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private getDefaultAudioInputFormat(): string {
    if (process.platform === 'win32') {
      return 'dshow';
    }

    if (process.platform === 'darwin') {
      return 'avfoundation';
    }

    return 'pulse';
  }

  private async emitDetectedChatMessage(input: {
    meetingId: string;
    author: string;
    text: string;
    sentAt?: string;
    messageId?: string;
  }): Promise<void> {
    await this.emitEvent({
      type: 'chat.message.detected',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        messageId: input.messageId ?? randomUUID(),
        author: input.author,
        text: input.text,
        sentAt: input.sentAt ?? new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitDetectedCaptionSegment(input: {
    meetingId: string;
    speaker: string;
    text: string;
    startAt?: string;
    segmentId?: string;
  }): Promise<void> {
    await this.emitEvent({
      type: 'caption.segment.detected',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        segmentId: input.segmentId ?? randomUUID(),
        speaker: input.speaker,
        text: input.text,
        startAt: input.startAt ?? new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitDetectedAudioTranscript(
    input: { meetingId: string } & DetectedAudioTranscript
  ): Promise<void> {
    await this.emitEvent({
      type: 'audio.transcript.detected',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        transcriptId: input.transcriptId,
        speaker: input.speaker,
        text: input.text,
        confidence: input.confidence,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        language: input.language,
        source: input.source
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitDetectedVideoFrame(
    input: { meetingId: string } & DetectedVideoFrame
  ): Promise<void> {
    await this.emitEvent({
      type: 'video.frame.detected',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        frameId: input.frameId,
        capturedAt: input.capturedAt,
        width: input.width,
        height: input.height,
        framePath: input.framePath,
        thumbnailPath: input.thumbnailPath
      },
      timestamp: new Date().toISOString()
    });
  }

  private queueLatestVideoFrameEmit(
    input: { meetingId: string } & DetectedVideoFrame
  ): void {
    this.pendingVideoFrame = input;

    if (!this.videoFrameFlushPromise) {
      this.videoFrameFlushPromise = this.flushLatestVideoFrameEmitQueue();
    }
  }

  private async flushLatestVideoFrameEmitQueue(): Promise<void> {
    try {
      while (this.pendingVideoFrame) {
        const frame = this.pendingVideoFrame;
        this.pendingVideoFrame = undefined;

        if (this.isVideoDebugEnabled()) {
          this.log('video frame captured', { framePath: frame.framePath });
        }

        await this.emitDetectedVideoFrame(frame);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown video frame emit error';
      this.log('video frame emit error', { message });
    } finally {
      this.videoFrameFlushPromise = undefined;

      if (this.pendingVideoFrame) {
        this.videoFrameFlushPromise = this.flushLatestVideoFrameEmitQueue();
      }
    }
  }

  private async emitDetectedVideoActivity(
    input: { meetingId: string } & DetectedVideoActivity
  ): Promise<void> {
    await this.emitEvent({
      type: 'video.activity.detected',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        activityId: input.activityId,
        detectedAt: input.detectedAt,
        activeSpeaker: input.activeSpeaker,
        presentationActive: input.presentationActive,
        participantTileCount: input.participantTileCount,
        summary: input.summary,
        metadata: input.metadata
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitMediaTransportReady(input: {
    meetingId: string;
    transport: ReturnType<RtpMediaRelay['getDescriptor']>;
  }): Promise<void> {
    await this.emitEvent({
      type: 'media.transport.ready',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        transport: input.transport
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitMediaTransportFailed(input: {
    meetingId: string;
    stage: 'audio-input' | 'meeting-audio-output' | 'video-output' | 'unknown';
    error: string;
  }): Promise<void> {
    await this.emitEvent({
      type: 'media.transport.failed',
      botId: this.botId,
      meetingId: input.meetingId,
      payload: {
        stage: input.stage,
        error: input.error
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitSpeechOutputCompleted(input: {
    meetingId: string;
    commandId?: string;
    text: string;
    voice?: string;
    durationMs?: number;
    wavPath?: string;
    backend?: string;
  }): Promise<void> {
    await this.emitEvent({
      type: 'speech.output.completed',
      botId: this.botId,
      meetingId: input.meetingId,
      commandId: input.commandId,
      payload: {
        text: input.text,
        voice: input.voice,
        durationMs: input.durationMs,
        wavPath: input.wavPath,
        backend: input.backend
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitSpeechOutputFailed(input: {
    meetingId: string;
    commandId?: string;
    text: string;
    error: string;
  }): Promise<void> {
    await this.emitEvent({
      type: 'speech.output.failed',
      botId: this.botId,
      meetingId: input.meetingId,
      commandId: input.commandId,
      payload: {
        text: input.text,
        error: input.error
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitCommandStarted(command: BotCommand): Promise<void> {
    await this.emitEvent({
      type: 'command.started',
      botId: this.botId,
      meetingId: command.meetingId,
      commandId: command.id,
      payload: {
        commandType: command.type,
        status: 'started'
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitCommandCompleted(
    command: BotCommand,
    result?: Record<string, unknown>
  ): Promise<void> {
    await this.emitEvent({
      type: 'command.completed',
      botId: this.botId,
      meetingId: command.meetingId,
      commandId: command.id,
      payload: {
        commandType: command.type,
        status: 'completed',
        result
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitCommandFailed(command: BotCommand, error: string): Promise<void> {
    await this.emitEvent({
      type: 'command.failed',
      botId: this.botId,
      meetingId: command.meetingId,
      commandId: command.id,
      payload: {
        commandType: command.type,
        status: 'failed',
        error
      },
      timestamp: new Date().toISOString()
    });
  }

  private async sendStatus(status: BotStatus, error?: string): Promise<void> {
    await this.emitEvent({
      type: 'bot.status.changed',
      botId: this.botId,
      meetingId: this.activeMeetingId,
      payload: {
        status,
        error
      },
      timestamp: new Date().toISOString()
    });
  }

  private async emitEvent(event: BotEvent): Promise<void> {
    await this.controlClient.sendEvent(event);
  }

  private logChatObserverDebug(debug: ChatObserverDebugInfo): void {
    this.log('chat observer tick', {
      tick: debug.tick,
      rawCount: debug.rawCount,
      visibleCount: debug.visibleCount,
      ignoredCount: debug.ignoredCount,
      freshCount: debug.freshCount,
      seenCount: debug.seenCount,
      rawSample: debug.rawSample,
      ignoredSample: debug.ignoredSample,
      sampleMessages: debug.sampleMessages,
      diagnostics: debug.diagnostics
    });
  }

  private log(message: string, data?: unknown): void {
    const prefix = `[runtime:${this.botId}]`;

    if (data === undefined) {
      console.log(prefix, message);
      return;
    }

    console.log(prefix, message, data);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
