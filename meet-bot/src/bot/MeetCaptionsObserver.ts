import type { Page } from 'playwright';

export type DetectedCaptionSegment = {
  segmentId: string;
  speaker: string;
  text: string;
  startAt: string;
};

type ObserverOptions = {
  pollIntervalMs?: number;
  maxSeenSegments?: number;
  ownDisplayNames?: string[];
  skipInitialVisibleSegments?: boolean;
};

type RawCaption = {
  segmentId: string;
  speaker: string;
  text: string;
  startAt: string;
};

export class MeetCaptionsObserver {
  private readonly page: Page;
  private readonly pollIntervalMs: number;
  private readonly maxSeenSegments: number;
  private readonly ownDisplayNames: Set<string>;
  private readonly skipInitialVisibleSegments: boolean;

  private timer?: NodeJS.Timeout;
  private isRunning = false;
  private isTicking = false;
  private initialized = false;

  private readonly seenSegmentIds = new Set<string>();

  constructor(page: Page, options: ObserverOptions = {}) {
    this.page = page;
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
    this.maxSeenSegments = options.maxSeenSegments ?? 500;
    this.ownDisplayNames = new Set(
      (options.ownDisplayNames ?? []).map((name) => this.normalize(name))
    );
    this.skipInitialVisibleSegments = options.skipInitialVisibleSegments ?? true;
  }

  async start(
    onSegments: (segments: DetectedCaptionSegment[]) => Promise<void>
  ): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;

    await this.ensureCaptionsEnabled().catch(() => {});

    this.timer = setInterval(async () => {
      if (!this.isRunning || this.isTicking) return;

      this.isTicking = true;

      try {
        const visibleSegments = await this.readVisibleSegments();

        if (!this.initialized) {
          this.initialized = true;

          if (this.skipInitialVisibleSegments) {
            for (const segment of visibleSegments) {
              this.markSeen(segment.segmentId);
            }
            return;
          }
        }

        const fresh = visibleSegments.filter(
          (segment) => !this.seenSegmentIds.has(segment.segmentId)
        );

        if (fresh.length > 0) {
          for (const segment of fresh) {
            this.markSeen(segment.segmentId);
          }

          await onSegments(fresh);
        }
      } catch {
        // swallow observer tick errors for MVP robustness
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

  async ensureCaptionsEnabled(): Promise<void> {
    if (await this.hasVisibleCaptions().catch(() => false)) {
      return;
    }

    const buttonNames = [
      'Turn on captions',
      'Show captions',
      'Captions',
      'Activar subtítulos',
      'Mostrar subtítulos',
      'Subtítulos'
    ];

    for (const name of buttonNames) {
      const button = this.page.getByRole('button', { name }).first();

      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        await this.page.waitForTimeout(800);
        return;
      }
    }

    // best effort only
  }

  private async hasVisibleCaptions(): Promise<boolean> {
    const result = await this.page.evaluate(() => {
      const selectors = [
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
        '[data-caption-text]',
        '[data-self-name]',
        '[class*="caption"]',
        '[class*="subtitle"]'
      ];

      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        const found = nodes.some((node) => {
          const text = (node.textContent ?? '').trim();
          return text.length > 0;
        });

        if (found) return true;
      }

      return false;
    });

    return result;
  }

  private async readVisibleSegments(): Promise<DetectedCaptionSegment[]> {
    const raw = await this.page.evaluate(() => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? '').replace(/\s+/g, ' ').trim();

      const nodes = Array.from(
        document.querySelectorAll('[aria-live="assertive"], [aria-live="polite"]')
      ).slice(-20);

      const candidates: RawCaption[] = [];

      const fingerprint = (speaker: string, text: string, index: number) =>
        `${normalize(speaker).toLowerCase()}|${normalize(text).toLowerCase()}|${index}`;

      for (let i = 0; i < nodes.length; i += 1) {
        const root = nodes[i] as HTMLElement;
        const fullText = normalize(root.innerText || root.textContent || '');

        if (!fullText) continue;

        const lines = fullText
          .split('\n')
          .map((line) => normalize(line))
          .filter(Boolean);

        if (lines.length === 0) continue;

        let speaker = '';
        let text = '';

        if (lines.length >= 2) {
          speaker = lines[0];
          text = lines.slice(1).join(' ');
        } else {
          text = lines[0];
        }

        const explicitSpeaker =
          root.querySelector('[data-self-name]') ||
          root.querySelector('[data-speaker-name]') ||
          root.querySelector('span') ||
          root.querySelector('div');

        if (!speaker && explicitSpeaker) {
          speaker = normalize(explicitSpeaker.textContent);
        }

        speaker = normalize(speaker || 'Unknown');
        text = normalize(text);

        if (!text) continue;
        if (text.length < 2) continue;

        const attrId =
          root.getAttribute('data-caption-id') ||
          root.getAttribute('data-message-id') ||
          root.getAttribute('id') ||
          root.getAttribute('aria-id');

        candidates.push({
          segmentId: attrId || fingerprint(speaker, text, i),
          speaker,
          text,
          startAt: new Date().toISOString()
        });
      }

      const dedup = new Map<string, RawCaption>();

      for (const item of candidates) {
        const stableKey = `${item.speaker.toLowerCase()}|${item.text.toLowerCase()}`;
        if (!dedup.has(stableKey)) {
          dedup.set(stableKey, item);
        }
      }

      return Array.from(dedup.values()).slice(-15);
    });

    return raw
      .filter((item) => !this.ownDisplayNames.has(this.normalize(item.speaker)))
      .map((item) => ({
        segmentId: item.segmentId,
        speaker: item.speaker,
        text: item.text,
        startAt: item.startAt
      }));
  }

  private markSeen(segmentId: string): void {
    this.seenSegmentIds.add(segmentId);

    if (this.seenSegmentIds.size > this.maxSeenSegments) {
      const ids = [...this.seenSegmentIds];
      const overflow = ids.length - this.maxSeenSegments;

      for (let i = 0; i < overflow; i += 1) {
        this.seenSegmentIds.delete(ids[i]);
      }
    }
  }

  private normalize(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
}