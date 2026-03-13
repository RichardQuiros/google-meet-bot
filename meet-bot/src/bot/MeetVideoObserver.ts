import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';

export interface DetectedVideoFrame {
  frameId: string;
  capturedAt: string;
  width?: number;
  height?: number;
  framePath?: string;
  thumbnailPath?: string;
}

export interface DetectedVideoActivity {
  activityId: string;
  detectedAt: string;
  activeSpeaker?: string;
  presentationActive?: boolean;
  participantTileCount?: number;
  summary: string;
  metadata?: Record<string, unknown>;
}

type ObserverOptions = {
  pollIntervalMs?: number;
  captureFrames?: boolean;
  detectActivity?: boolean;
  outputDir?: string;
  jpegQuality?: number;
};

export class MeetVideoObserver {
  private readonly pollIntervalMs: number;
  private readonly captureFrames: boolean;
  private readonly detectActivityEnabled: boolean;
  private readonly outputDir: string;
  private readonly jpegQuality: number;

  private timer?: NodeJS.Timeout;
  private isRunning = false;
  private isTicking = false;
  private lastActivitySignature?: string;

  constructor(
    private readonly page: Page,
    options: ObserverOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.captureFrames = options.captureFrames ?? true;
    this.detectActivityEnabled = options.detectActivity ?? false;
    this.outputDir = options.outputDir ?? path.resolve(process.cwd(), 'tmp', 'video-frames');
    this.jpegQuality = options.jpegQuality ?? 45;
  }

  async start(callbacks: {
    onFrame?: (frame: DetectedVideoFrame) => Promise<void>;
    onActivity?: (activity: DetectedVideoActivity) => Promise<void>;
    onError?: (error: Error) => void;
  }): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    if (this.captureFrames) {
      await fs.mkdir(this.outputDir, { recursive: true });
    }

    this.timer = setInterval(async () => {
      if (!this.isRunning || this.isTicking || this.page.isClosed()) {
        return;
      }

      this.isTicking = true;

      try {
        if (this.captureFrames && callbacks.onFrame) {
          const frame = await this.captureFrame();
          await callbacks.onFrame(frame);
        }

        if (this.detectActivityEnabled && callbacks.onActivity) {
          const activity = await this.detectActivity();
          const signature = JSON.stringify({
            activeSpeaker: activity.activeSpeaker ?? '',
            presentationActive: activity.presentationActive ?? false,
            participantTileCount: activity.participantTileCount ?? 0,
            summary: activity.summary
          });

          if (signature !== this.lastActivitySignature) {
            this.lastActivitySignature = signature;
            await callbacks.onActivity(activity);
          }
        }
      } catch (error) {
        callbacks.onError?.(error instanceof Error ? error : new Error('Unknown video observer error'));
      } finally {
        this.isTicking = false;
      }
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async captureFrame(): Promise<DetectedVideoFrame> {
    const capturedAt = new Date().toISOString();
    const frameId = randomUUID();
    const viewport = this.page.viewportSize() ?? undefined;
    const framePath = path.join(this.outputDir, `${capturedAt.replace(/[:.]/g, '-')}-${frameId}.jpg`);

    await this.page.screenshot({
      path: framePath,
      type: 'jpeg',
      quality: this.jpegQuality,
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css'
    });

    return {
      frameId,
      capturedAt,
      width: viewport?.width,
      height: viewport?.height,
      framePath
    };
  }

  private async detectActivity(): Promise<DetectedVideoActivity> {
    const detectedAt = new Date().toISOString();
    const metadata = await this.page.evaluate(() => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? '').replace(/\s+/g, ' ').trim();

      const bodyText = normalize(document.body?.innerText);
      const lines = bodyText
        .split('\n')
        .map((line) => normalize(line))
        .filter(Boolean);

      const selectors = [
        '[data-is-presenting="true"]',
        '[aria-label*="presenting"]',
        '[aria-label*="Presenting"]',
        '[aria-label*="presentando"]',
        '[aria-label*="sharing"]'
      ];

      const presentationActive =
        selectors.some((selector) => document.querySelector(selector)) ||
        /(presenting|presentando|sharing screen|screen share|compartiendo pantalla)/i.test(bodyText);

      const speakingLike = Array.from(document.querySelectorAll('[aria-label], [data-participant-id]'))
        .map((node) => normalize((node as HTMLElement).getAttribute('aria-label')))
        .find((label) => /(speaking|hablando|talking)/i.test(label));

      const activeSpeaker =
        speakingLike?.split(',')[0] ||
        lines.find((line) => /(speaking|hablando|presenting|presentando)/i.test(line)) ||
        undefined;

      const participantTileCount = document.querySelectorAll('video, [data-participant-id]').length;

      return {
        activeSpeaker,
        presentationActive,
        participantTileCount,
        title: document.title,
        url: window.location.href
      };
    });

    const summaryParts = [
      metadata.presentationActive ? 'presentation active' : 'presentation inactive',
      metadata.activeSpeaker ? `active speaker: ${metadata.activeSpeaker}` : 'active speaker unknown',
      `tiles: ${metadata.participantTileCount ?? 0}`
    ];

    return {
      activityId: randomUUID(),
      detectedAt,
      activeSpeaker: metadata.activeSpeaker,
      presentationActive: metadata.presentationActive,
      participantTileCount: metadata.participantTileCount,
      summary: summaryParts.join(' | '),
      metadata
    };
  }
}
