import { spawn, type ChildProcess } from 'node:child_process';
import type { RtpAudioTransportDescriptor } from '../types.js';

export interface RtpAudioInputSenderOptions {
  targetHost?: string;
  ffmpegPath?: string;
}

export class RtpAudioInputSender {
  private readonly ffmpegPath: string;
  private readonly targetHost: string;
  private readonly child: ChildProcess;
  private readonly exitPromise: Promise<void>;

  constructor(
    private readonly transport: RtpAudioTransportDescriptor,
    options: RtpAudioInputSenderOptions = {}
  ) {
    if (transport.transport !== 'rtp' || transport.direction !== 'recvonly') {
      throw new Error('RtpAudioInputSender requires an RTP recvonly transport descriptor');
    }

    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.targetHost = options.targetHost ?? transport.host;
    this.child = spawn(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        'nobuffer',
        '-flags',
        'low_delay',
        '-f',
        's16le',
        '-ar',
        String(transport.sampleRate),
        '-ac',
        String(transport.channels),
        '-i',
        'pipe:0',
        '-acodec',
        'pcm_s16be',
        '-payload_type',
        '96',
        '-f',
        'rtp',
        `rtp://${this.targetHost}:${transport.port}`
      ],
      {
        env: { ...process.env },
        stdio: ['pipe', 'ignore', 'pipe']
      }
    );

    let stderr = '';

    this.child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    this.exitPromise = new Promise<void>((resolve, reject) => {
      this.child.on('error', reject);
      this.child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? 'unknown'}`));
      });
    });
  }

  writePcm(chunk: Buffer | Uint8Array): void {
    if (!this.child.stdin?.writable) {
      throw new Error('RTP audio sender is not writable');
    }

    this.child.stdin.write(Buffer.from(chunk));
  }

  getSdp(): string {
    return this.transport.sdp;
  }

  getTarget(): { host: string; port: number } {
    return {
      host: this.targetHost,
      port: this.transport.port
    };
  }

  async close(): Promise<void> {
    if (this.child.stdin?.writable) {
      this.child.stdin.end();
    }

    await this.exitPromise;
  }
}
