import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpeechToTextProvider } from './SpeechToTextProvider.js';

const execFileAsync = promisify(execFile);

export interface DetectedAudioTranscript {
  transcriptId: string;
  speaker: string;
  text: string;
  confidence?: number;
  startedAt: string;
  endedAt?: string;
  language?: string;
  source: 'meeting-audio';
}

export interface AudioObserverDebugInfo {
  stage:
    | 'observer.started'
    | 'capture.started'
    | 'capture.completed'
    | 'stt.completed'
    | 'segments.filtered';
  inputDevice?: string;
  inputFormat?: string;
  wavPath?: string;
  segmentDurationMs?: number;
  transcriptCount?: number;
  freshCount?: number;
  sampleText?: string;
}

type ObserverOptions = {
  inputDevice: string;
  inputFormat?: string;
  ffmpegPath?: string;
  segmentDurationMs?: number;
  cooldownMs?: number;
  outputDir?: string;
  keepSegments?: boolean;
  defaultSpeaker?: string;
};

export class AudioTranscriptObserver {
  private readonly inputDevice: string;
  private readonly inputFormat: string;
  private readonly ffmpegPath: string;
  private readonly segmentDurationMs: number;
  private readonly cooldownMs: number;
  private readonly outputDir: string;
  private readonly keepSegments: boolean;
  private readonly defaultSpeaker: string;

  private isRunning = false;
  private loopPromise?: Promise<void>;
  private resolvedFfmpegPath?: string;
  private readonly recentFingerprints = new Set<string>();

  constructor(
    private readonly speechToTextProvider: SpeechToTextProvider,
    options: ObserverOptions
  ) {
    this.inputFormat =
      options.inputFormat ??
      process.env.MEET_AUDIO_INPUT_FORMAT ??
      this.getDefaultInputFormat();
    this.inputDevice = this.normalizeInputDevice(options.inputDevice);
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.segmentDurationMs = options.segmentDurationMs ?? 5000;
    this.cooldownMs = options.cooldownMs ?? 250;
    this.outputDir =
      options.outputDir ?? path.resolve(process.cwd(), 'tmp', 'audio-input');
    this.keepSegments = options.keepSegments ?? false;
    this.defaultSpeaker = options.defaultSpeaker ?? 'Unknown speaker';
  }

  async start(
    onTranscripts: (transcripts: DetectedAudioTranscript[]) => Promise<void>,
    onError?: (error: Error) => void,
    onDebug?: (info: AudioObserverDebugInfo) => void
  ): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    await fs.mkdir(this.outputDir, { recursive: true });
    this.resolvedFfmpegPath = await this.resolveFfmpegPath();
    onDebug?.({
      stage: 'observer.started',
      inputDevice: this.inputDevice,
      inputFormat: this.inputFormat,
      segmentDurationMs: this.segmentDurationMs
    });
    this.loopPromise = this.runLoop(onTranscripts, onError, onDebug);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = undefined;
  }

  private async runLoop(
    onTranscripts: (transcripts: DetectedAudioTranscript[]) => Promise<void>,
    onError?: (error: Error) => void,
    onDebug?: (info: AudioObserverDebugInfo) => void
  ): Promise<void> {
    while (this.isRunning) {
      const startedAt = new Date().toISOString();
      const segmentId = `${Date.now()}-${randomUUID()}`;
      const wavPath = path.join(this.outputDir, `${segmentId}.wav`);

      try {
        onDebug?.({
          stage: 'capture.started',
          wavPath,
          inputDevice: this.inputDevice,
          inputFormat: this.inputFormat,
          segmentDurationMs: this.segmentDurationMs
        });
        await this.captureSegment(wavPath);
        onDebug?.({
          stage: 'capture.completed',
          wavPath,
          inputDevice: this.inputDevice,
          inputFormat: this.inputFormat,
          segmentDurationMs: this.segmentDurationMs
        });

        const segments = await this.speechToTextProvider.transcribeFile(wavPath);
        onDebug?.({
          stage: 'stt.completed',
          wavPath,
          transcriptCount: segments.length,
          sampleText: segments[0]?.text
        });

        const fresh = segments
          .map((segment, index) => this.normalizeSegment(segmentId, startedAt, segment, index))
          .filter((segment) => segment.text)
          .filter((segment) => !this.hasSeenFingerprint(segment));

        onDebug?.({
          stage: 'segments.filtered',
          wavPath,
          transcriptCount: segments.length,
          freshCount: fresh.length,
          sampleText: fresh[0]?.text
        });

        if (fresh.length > 0) {
          fresh.forEach((segment) => this.markFingerprint(segment));
          await onTranscripts(fresh);
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error('Unknown audio observer error'));
      } finally {
        if (!this.keepSegments) {
          await fs.unlink(wavPath).catch(() => {});
        }
      }

      if (this.isRunning && this.cooldownMs > 0) {
        await this.sleep(this.cooldownMs);
      }
    }
  }

  private async captureSegment(wavPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        this.inputFormat,
        '-i',
        this.inputDevice,
        '-t',
        (this.segmentDurationMs / 1000).toFixed(2),
        '-ac',
        '1',
        '-ar',
        '16000',
        wavPath
      ];

      const ffmpegExecutable = this.resolvedFfmpegPath ?? this.ffmpegPath;

      const child = spawn(ffmpegExecutable, args, {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe']
      });

      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `Unable to locate ffmpeg executable "${ffmpegExecutable}". Set FFMPEG_PATH to the full path of ffmpeg.exe`
            )
          );
          return;
        }

        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? 'unknown'}`));
      });
    });
  }

  private normalizeSegment(
    segmentId: string,
    startedAt: string,
    segment: {
      text: string;
      speaker?: string;
      confidence?: number;
      startedAt?: string;
      endedAt?: string;
      language?: string;
    },
    index: number
  ): DetectedAudioTranscript {
    return {
      transcriptId: `${segmentId}-${index}`,
      speaker: segment.speaker?.trim() || this.defaultSpeaker,
      text: segment.text.trim(),
      confidence: segment.confidence,
      startedAt: segment.startedAt ?? startedAt,
      endedAt: segment.endedAt,
      language: segment.language,
      source: 'meeting-audio'
    };
  }

  private hasSeenFingerprint(segment: DetectedAudioTranscript): boolean {
    return this.recentFingerprints.has(this.fingerprint(segment));
  }

  private markFingerprint(segment: DetectedAudioTranscript): void {
    this.recentFingerprints.add(this.fingerprint(segment));

    if (this.recentFingerprints.size > 200) {
      const fingerprints = [...this.recentFingerprints];
      const overflow = fingerprints.length - 200;

      for (let index = 0; index < overflow; index += 1) {
        this.recentFingerprints.delete(fingerprints[index]);
      }
    }
  }

  private fingerprint(segment: DetectedAudioTranscript): string {
    return `${segment.speaker.toLowerCase()}|${segment.text.toLowerCase()}`;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getDefaultInputFormat(): string {
    if (process.platform === 'win32') {
      return 'dshow';
    }

    if (process.platform === 'darwin') {
      return 'avfoundation';
    }

    return 'pulse';
  }

  private normalizeInputDevice(inputDevice: string): string {
    const trimmed = inputDevice.trim();

    if (this.inputFormat === 'dshow' && !/^(audio|video)=/i.test(trimmed)) {
      return `audio=${trimmed}`;
    }

    return trimmed;
  }

  private async resolveFfmpegPath(): Promise<string> {
    if (this.ffmpegPath.includes(path.sep) || this.ffmpegPath.includes('/')) {
      try {
        const stats = await fs.stat(this.ffmpegPath);
        if (stats.isDirectory()) {
          return path.join(
            this.ffmpegPath,
            process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
          );
        }
      } catch {
        // fall through and use the provided path as-is
      }

      return this.ffmpegPath;
    }

    if (process.platform !== 'win32') {
      return this.ffmpegPath;
    }

    for (const candidate of [this.ffmpegPath, `${this.ffmpegPath}.exe`]) {
      try {
        const { stdout } = await execFileAsync('where.exe', [candidate], {
          env: { ...process.env }
        });
        const resolved = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);

        if (resolved) {
          return resolved;
        }
      } catch {
        // keep trying fallbacks
      }
    }

    return this.ffmpegPath;
  }

  getDebugConfig(): {
    inputDevice: string;
    inputFormat: string;
    ffmpegPath: string;
    resolvedFfmpegPath?: string;
    segmentDurationMs: number;
    cooldownMs: number;
    outputDir: string;
    keepSegments: boolean;
    defaultSpeaker: string;
  } {
    return {
      inputDevice: this.inputDevice,
      inputFormat: this.inputFormat,
      ffmpegPath: this.ffmpegPath,
      resolvedFfmpegPath: this.resolvedFfmpegPath,
      segmentDurationMs: this.segmentDurationMs,
      cooldownMs: this.cooldownMs,
      outputDir: this.outputDir,
      keepSegments: this.keepSegments,
      defaultSpeaker: this.defaultSpeaker
    };
  }
}
