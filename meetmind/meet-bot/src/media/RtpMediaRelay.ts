import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  RealtimeMediaTransportDescriptor,
  RtpAudioTransportDescriptor,
  RtpVideoTransportDescriptor
} from '../types/control.js';

type RelayLogger = (message: string, data?: unknown) => void;

type AudioInputConfig = {
  port?: number;
  advertiseHost: string;
  sampleRate: number;
  channels: number;
  outputDevice?: string;
};

type MeetingAudioOutputConfig = {
  targetUrl?: string;
  inputDevice: string;
  inputFormat: string;
  sampleRate: number;
  channels: number;
};

type VideoOutputConfig = {
  targetUrl?: string;
  fps: number;
};

type RtpMediaRelayOptions = {
  ffmpegPath?: string;
  tempDir?: string;
  audioInput?: AudioInputConfig;
  meetingAudioOutput?: MeetingAudioOutputConfig;
  videoOutput?: VideoOutputConfig;
  onLog?: RelayLogger;
};

type ParsedRtpTarget = {
  host: string;
  port: number;
};

export class RtpMediaRelay {
  private readonly ffmpegPath: string;
  private readonly tempDir: string;
  private readonly audioInput?: AudioInputConfig;
  private readonly meetingAudioOutput?: MeetingAudioOutputConfig;
  private readonly videoOutput?: VideoOutputConfig;
  private readonly onLog?: RelayLogger;
  private readonly descriptor: RealtimeMediaTransportDescriptor;

  private isRunning = false;
  private audioInputProcess?: ChildProcess;
  private meetingAudioOutputProcess?: ChildProcess;
  private videoOutputProcess?: ChildProcess;
  private audioInputRestartTimer?: NodeJS.Timeout;
  private meetingAudioOutputRestartTimer?: NodeJS.Timeout;
  private audioInputSdpPath?: string;
  private pendingVideoFrame?: Buffer;
  private videoFramePump?: Promise<void>;

  constructor(options: RtpMediaRelayOptions) {
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.tempDir =
      options.tempDir ?? path.resolve(process.cwd(), 'tmp', 'rtp-media');
    this.audioInput = options.audioInput?.port ? options.audioInput : undefined;
    this.meetingAudioOutput =
      options.meetingAudioOutput?.targetUrl &&
      options.meetingAudioOutput.inputDevice.trim()
        ? options.meetingAudioOutput
        : undefined;
    this.videoOutput =
      options.videoOutput?.targetUrl && options.videoOutput.fps > 0
        ? options.videoOutput
        : undefined;
    this.onLog = options.onLog;
    this.descriptor = this.buildDescriptor();
  }

  isEnabled(): boolean {
    return Boolean(
      this.audioInput ||
        this.meetingAudioOutput ||
        this.videoOutput
    );
  }

  getDescriptor(): RealtimeMediaTransportDescriptor {
    return this.descriptor;
  }

  async start(): Promise<RealtimeMediaTransportDescriptor> {
    if (!this.isEnabled()) {
      return {};
    }

    if (this.isRunning) {
      return this.descriptor;
    }

    await fs.mkdir(this.tempDir, { recursive: true });

    try {
      if (this.audioInput) {
        await this.startAudioInput();
      }

      if (this.meetingAudioOutput) {
        this.startMeetingAudioOutput();
      }

      if (this.videoOutput) {
        this.startVideoOutput();
      }

      await this.verifyWarmup();
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.isRunning = true;
    return this.descriptor;
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.pendingVideoFrame = undefined;
    this.clearRestartTimer('audio-input');
    this.clearRestartTimer('meeting-audio-output');

    this.killProcess(this.audioInputProcess);
    this.killProcess(this.meetingAudioOutputProcess);
    this.killProcess(this.videoOutputProcess);

    this.audioInputProcess = undefined;
    this.meetingAudioOutputProcess = undefined;
    this.videoOutputProcess = undefined;

    if (this.audioInputSdpPath) {
      await fs.unlink(this.audioInputSdpPath).catch(() => {});
      this.audioInputSdpPath = undefined;
    }
  }

  async pushVideoFrame(framePath: string): Promise<void> {
    if (!this.videoOutputProcess?.stdin || !framePath) {
      return;
    }

    const nextFrame = await fs.readFile(framePath);
    this.pendingVideoFrame = nextFrame;

    if (!this.videoFramePump) {
      this.videoFramePump = this.flushPendingVideoFrames();
    }
  }

  private async flushPendingVideoFrames(): Promise<void> {
    try {
      while (this.pendingVideoFrame) {
        const stdin = this.videoOutputProcess?.stdin;

        if (!stdin?.writable) {
          break;
        }

        const frame = this.pendingVideoFrame;
        this.pendingVideoFrame = undefined;

        const canContinue = stdin.write(frame);

        if (!canContinue) {
          await new Promise<void>((resolve) => {
            stdin.once('drain', () => resolve());
          });
        }
      }
    } finally {
      this.videoFramePump = undefined;

      if (this.pendingVideoFrame) {
        this.videoFramePump = this.flushPendingVideoFrames();
      }
    }
  }

  private buildDescriptor(): RealtimeMediaTransportDescriptor {
    return {
      audioInput: this.audioInput ? this.buildAudioInputDescriptor(this.audioInput) : undefined,
      meetingAudioOutput: this.meetingAudioOutput
        ? this.buildMeetingAudioOutputDescriptor(this.meetingAudioOutput)
        : undefined,
      videoOutput: this.videoOutput
        ? this.buildVideoOutputDescriptor(this.videoOutput)
        : undefined
    };
  }

  private buildAudioInputDescriptor(config: AudioInputConfig): RtpAudioTransportDescriptor {
    return {
      transport: 'rtp',
      host: config.advertiseHost,
      port: config.port!,
      codec: 'L16',
      sampleRate: config.sampleRate,
      channels: config.channels,
      direction: 'recvonly',
      sdp: buildAudioSdp({
        host: '0.0.0.0',
        port: config.port!,
        sampleRate: config.sampleRate,
        channels: config.channels,
        direction: 'recvonly',
        sessionName: 'MeetBot Agent Audio Input'
      })
    };
  }

  private buildMeetingAudioOutputDescriptor(
    config: MeetingAudioOutputConfig
  ): RtpAudioTransportDescriptor {
    const target = parseRtpTarget(config.targetUrl!);

    return {
      transport: 'rtp',
      host: target.host,
      port: target.port,
      codec: 'L16',
      sampleRate: config.sampleRate,
      channels: config.channels,
      direction: 'sendonly',
      sdp: buildAudioSdp({
        host: '0.0.0.0',
        port: target.port,
        sampleRate: config.sampleRate,
        channels: config.channels,
        direction: 'sendonly',
        sessionName: 'MeetBot Meeting Audio Output'
      })
    };
  }

  private buildVideoOutputDescriptor(config: VideoOutputConfig): RtpVideoTransportDescriptor {
    const target = parseRtpTarget(config.targetUrl!);

    return {
      transport: 'rtp',
      host: target.host,
      port: target.port,
      codec: 'JPEG',
      fps: config.fps,
      direction: 'sendonly',
      sdp: buildVideoSdp({
        host: '0.0.0.0',
        port: target.port,
        direction: 'sendonly',
        sessionName: 'MeetBot Video Output'
      })
    };
  }

  private async startAudioInput(): Promise<void> {
    const descriptor = this.descriptor.audioInput;

    if (!descriptor || !this.audioInput) {
      return;
    }

    this.audioInputSdpPath = path.join(
      this.tempDir,
      `audio-input-${descriptor.port}.sdp`
    );

    await fs.writeFile(this.audioInputSdpPath, `${descriptor.sdp}\n`, 'utf8');

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-protocol_whitelist',
      'file,udp,rtp',
      '-listen_timeout',
      process.env.REALTIME_AGENT_AUDIO_LISTEN_TIMEOUT_S ?? '3600',
      '-reorder_queue_size',
      '0',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-max_delay',
      '0',
      '-i',
      this.audioInputSdpPath,
      '-ac',
      String(this.audioInput.channels),
      '-ar',
      String(this.audioInput.sampleRate),
      '-stream_name',
      'meetbot-rtp-audio-input'
    ];

    const audioFilter = (process.env.REALTIME_AGENT_AUDIO_FILTER ?? '').trim();
    if (audioFilter) {
      args.push('-af', audioFilter);
    }

    args.push(
      '-f',
      'pulse',
      'default'
    );

    this.audioInputProcess = this.spawnProcess('audio-input', args, {
      PULSE_SINK: this.audioInput.outputDevice?.trim() || undefined
    });
  }

  private startMeetingAudioOutput(): void {
    if (!this.meetingAudioOutput) {
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-f',
      this.meetingAudioOutput.inputFormat,
      '-i',
      this.meetingAudioOutput.inputDevice,
      '-ac',
      String(this.meetingAudioOutput.channels),
      '-ar',
      String(this.meetingAudioOutput.sampleRate),
      '-c:a',
      'pcm_s16be',
      '-payload_type',
      '96',
      '-f',
      'rtp',
      this.meetingAudioOutput.targetUrl!
    ];

    this.meetingAudioOutputProcess = this.spawnProcess('meeting-audio-output', args);
  }

  private startVideoOutput(): void {
    if (!this.videoOutput) {
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-use_wallclock_as_timestamps',
      '1',
      '-f',
      'image2pipe',
      '-framerate',
      String(this.videoOutput.fps),
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'copy',
      '-f',
      'rtp',
      this.videoOutput.targetUrl!
    ];

    this.videoOutputProcess = this.spawnProcess('video-output', args);
  }

  private spawnProcess(
    stage: 'audio-input' | 'meeting-audio-output' | 'video-output',
    args: string[],
    extraEnv?: Record<string, string | undefined>
  ): ChildProcess {
    const child = spawn(this.ffmpegPath, args, {
      env: {
        ...process.env,
        PULSE_LATENCY_MSEC: process.env.PULSE_LATENCY_MSEC ?? '30',
        ...extraEnv
      },
      stdio: ['pipe', 'ignore', 'pipe']
    });

    let stderr = '';

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      this.onLog?.(`${stage} process error`, {
        message: error.message
      });
    });

    child.on('close', (code) => {
      const isCurrentProcess = this.getStageProcess(stage) === child;
      if (isCurrentProcess) {
        this.setStageProcess(stage, undefined);
      }

      if (!this.isRunning) {
        return;
      }

      this.onLog?.(`${stage} process exited`, {
        code,
        stderr: stderr.trim() || undefined
      });

      if (isCurrentProcess && (stage === 'audio-input' || stage === 'meeting-audio-output')) {
        this.scheduleRestart(stage);
      }
    });

    this.onLog?.(`${stage} process started`, {
      ffmpegPath: this.ffmpegPath,
      args,
      env: extraEnv
    });

    return child;
  }

  private killProcess(child?: ChildProcess): void {
    if (!child || child.killed) {
      return;
    }

    child.kill('SIGTERM');
  }

  private getStageProcess(
    stage: 'audio-input' | 'meeting-audio-output' | 'video-output'
  ): ChildProcess | undefined {
    if (stage === 'audio-input') {
      return this.audioInputProcess;
    }

    if (stage === 'meeting-audio-output') {
      return this.meetingAudioOutputProcess;
    }

    return this.videoOutputProcess;
  }

  private setStageProcess(
    stage: 'audio-input' | 'meeting-audio-output' | 'video-output',
    child: ChildProcess | undefined
  ): void {
    if (stage === 'audio-input') {
      this.audioInputProcess = child;
      return;
    }

    if (stage === 'meeting-audio-output') {
      this.meetingAudioOutputProcess = child;
      return;
    }

    this.videoOutputProcess = child;
  }

  private clearRestartTimer(stage: 'audio-input' | 'meeting-audio-output'): void {
    const timer =
      stage === 'audio-input'
        ? this.audioInputRestartTimer
        : this.meetingAudioOutputRestartTimer;

    if (timer) {
      clearTimeout(timer);
    }

    if (stage === 'audio-input') {
      this.audioInputRestartTimer = undefined;
    } else {
      this.meetingAudioOutputRestartTimer = undefined;
    }
  }

  private scheduleRestart(stage: 'audio-input' | 'meeting-audio-output'): void {
    this.clearRestartTimer(stage);

    const timer = setTimeout(() => {
      void this.restartStage(stage);
    }, 500);

    if (stage === 'audio-input') {
      this.audioInputRestartTimer = timer;
    } else {
      this.meetingAudioOutputRestartTimer = timer;
    }
  }

  private async restartStage(stage: 'audio-input' | 'meeting-audio-output'): Promise<void> {
    this.clearRestartTimer(stage);

    if (!this.isRunning) {
      return;
    }

    this.onLog?.(`${stage} restart scheduled`);

    try {
      if (stage === 'audio-input') {
        await this.startAudioInput();
      } else {
        this.startMeetingAudioOutput();
      }
    } catch (error) {
      this.onLog?.(`${stage} restart failed`, {
        message: error instanceof Error ? error.message : String(error)
      });
      this.scheduleRestart(stage);
    }
  }

  private async verifyWarmup(): Promise<void> {
    await this.sleep(200);

    const stages: Array<
      ['audio-input' | 'meeting-audio-output' | 'video-output', ChildProcess | undefined]
    > = [
      ['audio-input', this.audioInputProcess],
      ['meeting-audio-output', this.meetingAudioOutputProcess],
      ['video-output', this.videoOutputProcess]
    ];

    const failedStage = stages.find(([, child]) => child && child.exitCode !== null);

    if (failedStage) {
      throw new Error(`Realtime media relay failed during ${failedStage[0]} startup`);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function parseRtpTarget(targetUrl: string): ParsedRtpTarget {
  const target = new URL(targetUrl);

  if (target.protocol !== 'rtp:') {
    throw new Error(`Unsupported RTP target protocol: ${target.protocol}`);
  }

  const port = Number.parseInt(target.port, 10);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid RTP target port: ${targetUrl}`);
  }

  return {
    host: target.hostname,
    port
  };
}

function buildAudioSdp(input: {
  host: string;
  port: number;
  sampleRate: number;
  channels: number;
  direction: 'sendonly' | 'recvonly';
  sessionName: string;
}): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    `s=${input.sessionName}`,
    `c=IN IP4 ${input.host}`,
    't=0 0',
    `m=audio ${input.port} RTP/AVP 96`,
    `a=rtpmap:96 L16/${input.sampleRate}/${input.channels}`,
    `a=${input.direction}`
  ].join('\n');
}

function buildVideoSdp(input: {
  host: string;
  port: number;
  direction: 'sendonly' | 'recvonly';
  sessionName: string;
}): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    `s=${input.sessionName}`,
    `c=IN IP4 ${input.host}`,
    't=0 0',
    `m=video ${input.port} RTP/AVP 26`,
    `a=${input.direction}`
  ].join('\n');
}
