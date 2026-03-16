import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioOutputProvider, PlayAudioOptions } from './AudioOutputProvider.js';

const execFileAsync = promisify(execFile);

export class LinuxAudioOutputProvider implements AudioOutputProvider {
  private readonly backend: 'paplay' | 'pw-play' | 'aplay';
  private readonly device?: string;

  constructor(options?: {
    backend?: 'paplay' | 'pw-play' | 'aplay';
    device?: string;
  }) {
    this.backend =
      options?.backend ??
      (process.env.AUDIO_OUTPUT_BACKEND as 'paplay' | 'pw-play' | 'aplay') ??
      'paplay';
    this.device = options?.device ?? process.env.AUDIO_OUTPUT_DEVICE;
  }

  async play(options: PlayAudioOptions): Promise<{ durationMs: number }> {
    await fs.access(options.wavPath);

    const startedAt = Date.now();

    switch (this.backend) {
      case 'paplay':
        await this.playWithPaPlay(options.wavPath);
        break;
      case 'pw-play':
        await this.playWithPwPlay(options.wavPath);
        break;
      case 'aplay':
        await this.playWithAPlay(options.wavPath);
        break;
      default:
        throw new Error(`Unsupported Linux audio backend: ${this.backend}`);
    }

    return {
      durationMs: Date.now() - startedAt
    };
  }

  private async playWithPaPlay(wavPath: string): Promise<void> {
    const env = { ...process.env };

    if (this.device) {
      env.PULSE_SINK = this.device;
    }

    await execFileAsync('paplay', [wavPath], { env });
  }

  private async playWithPwPlay(wavPath: string): Promise<void> {
    const args = this.device ? ['--target', this.device, wavPath] : [wavPath];

    await execFileAsync('pw-play', args, {
      env: { ...process.env }
    });
  }

  private async playWithAPlay(wavPath: string): Promise<void> {
    const args = this.device ? ['-D', this.device, wavPath] : [wavPath];

    await execFileAsync('aplay', args, {
      env: { ...process.env }
    });
  }
}
