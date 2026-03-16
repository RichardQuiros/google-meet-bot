import { randomUUID } from 'node:crypto';
import { RuntimeAgent } from '../control/RuntimeAgent.js';

export type SupervisorState = 'created' | 'starting' | 'running' | 'stopped' | 'failed';

export interface SupervisedBotRecord {
  botId: string;
  displayName: string;
  controlBaseUrl: string;
  runtimeUrl?: string;
  state: SupervisorState;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
}

type SupervisorEntry = {
  agent: RuntimeAgent;
  record: SupervisedBotRecord;
  startPromise?: Promise<void>;
};

export class RuntimeSupervisor {
  private readonly bots = new Map<string, SupervisorEntry>();

  createBot(input: {
    botId?: string;
    displayName: string;
    controlBaseUrl: string;
    runtimeUrl?: string;
    autoStart?: boolean;
  }): SupervisedBotRecord {
    const botId = input.botId ?? randomUUID();
    const now = new Date().toISOString();

    const existing = this.bots.get(botId);
    if (existing) {
      return existing.record;
    }

    const agent = new RuntimeAgent({
      botId,
      displayName: input.displayName,
      controlBaseUrl: input.controlBaseUrl,
      runtimeUrl: input.runtimeUrl
    });

    const record: SupervisedBotRecord = {
      botId,
      displayName: input.displayName,
      controlBaseUrl: input.controlBaseUrl,
      runtimeUrl: input.runtimeUrl,
      state: 'created',
      createdAt: now
    };

    this.bots.set(botId, { agent, record });

    if (input.autoStart ?? true) {
      this.startBot(botId);
    }

    return record;
  }

  listBots(): SupervisedBotRecord[] {
    return [...this.bots.values()].map((entry) => entry.record);
  }

  getBot(botId: string): SupervisedBotRecord | undefined {
    return this.bots.get(botId)?.record;
  }

  startBot(botId: string): SupervisedBotRecord | undefined {
    const entry = this.bots.get(botId);
    if (!entry) {
      return undefined;
    }

    if (entry.record.state === 'running' || entry.record.state === 'starting') {
      return entry.record;
    }

    entry.record.state = 'starting';
    entry.record.startedAt = new Date().toISOString();
    entry.record.stoppedAt = undefined;
    entry.record.lastError = undefined;

    entry.startPromise = entry.agent
      .start()
      .then(() => {
        const current = this.bots.get(botId);
        if (!current) {
          return;
        }

        current.record.state = 'stopped';
        current.record.stoppedAt = new Date().toISOString();
      })
      .catch((error) => {
        const current = this.bots.get(botId);
        if (!current) {
          return;
        }

        current.record.state = 'failed';
        current.record.stoppedAt = new Date().toISOString();
        current.record.lastError =
          error instanceof Error ? error.message : 'Unknown supervisor error';
      });

    entry.record.state = 'running';
    return entry.record;
  }

  async stopBot(botId: string): Promise<SupervisedBotRecord | undefined> {
    const entry = this.bots.get(botId);
    if (!entry) {
      return undefined;
    }

    await entry.agent.stop();
    entry.record.state = 'stopped';
    entry.record.stoppedAt = new Date().toISOString();
    return entry.record;
  }

  async restartBot(botId: string): Promise<SupervisedBotRecord | undefined> {
    const entry = this.bots.get(botId);
    if (!entry) {
      return undefined;
    }

    await entry.agent.stop();
    entry.record.state = 'stopped';
    entry.record.stoppedAt = new Date().toISOString();
    return this.startBot(botId);
  }

  async removeBot(botId: string): Promise<boolean> {
    const entry = this.bots.get(botId);
    if (!entry) {
      return false;
    }

    await entry.agent.stop().catch(() => {});
    this.bots.delete(botId);
    return true;
  }
}
