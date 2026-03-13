import type {
  BotCommand,
  BotEvent,
  BotRegistration
} from '../types/control.js';

type ControlClientOptions = {
  requestTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  commandWaitMs?: number;
};

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

export class ControlClient {
  private readonly requestTimeoutMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly commandWaitMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly botId: string,
    options: ControlClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
    this.retryCount = options.retryCount ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 750;
    this.commandWaitMs = options.commandWaitMs ?? 3000;
  }

  async registerBot(input: BotRegistration): Promise<void> {
    await this.request<void>('/internal/bots/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    });
  }

  async sendEvent(event: BotEvent): Promise<void> {
    await this.request<void>('/internal/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });
  }

  async getNextCommand(waitMs = this.commandWaitMs): Promise<BotCommand | null> {
    const data = await this.request<{ command: BotCommand | null }>(
      `/internal/bots/${this.botId}/commands/next?waitMs=${Math.max(0, waitMs)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        timeoutMs: Math.max(this.requestTimeoutMs, waitMs + 5000)
      }
    );

    return data.command ?? null;
  }

  private async request<T>(path: string, init: RequestOptions): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      const { timeoutMs, ...requestInit } = init;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs ?? this.requestTimeoutMs
      );

      try {
        const response = await fetch(this.resolveUrl(path), {
          ...requestInit,
          signal: controller.signal
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          const error = new Error(
            `Control request failed: ${response.status} ${response.statusText}${body ? ` | ${body}` : ''}`
          );

          if (response.status >= 500 && attempt < this.retryCount) {
            lastError = error;
            await this.sleep(this.retryDelayMs * (attempt + 1));
            continue;
          }

          throw error;
        }

        if (response.status === 204) {
          return undefined as T;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown control client error');

        if (attempt >= this.retryCount) {
          break;
        }

        await this.sleep(this.retryDelayMs * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new Error('Control request failed');
  }

  private resolveUrl(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
