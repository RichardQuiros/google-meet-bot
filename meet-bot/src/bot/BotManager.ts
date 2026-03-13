import { randomUUID } from 'crypto';
import { MeetBot } from './MeetBot.js';
import type { BotRecord, CreateBotInput, JoinBotInput } from '../types/bot.js';

export class BotManager {
  private bots = new Map<string, MeetBot>();

  create(input: CreateBotInput): BotRecord {
    const id = randomUUID();

    const record: BotRecord = {
      id,
      displayName: input.displayName,
      meetingUrl: input.meetingUrl,
      status: 'created'
    };

    const bot = new MeetBot(record);
    this.bots.set(id, bot);

    return record;
  }

  list(): BotRecord[] {
    return [...this.bots.values()].map(bot => bot.record);
  }

  get(id: string): MeetBot | undefined {
    return this.bots.get(id);
  }

  async join(id: string, input: JoinBotInput): Promise<BotRecord | null> {
    const bot = this.bots.get(id);
    if (!bot) return null;

    void bot.join(input);
    return bot.record;
  }

  async remove(id: string): Promise<boolean> {
    const bot = this.bots.get(id);
    if (!bot) return false;

    await bot.close();
    this.bots.delete(id);
    return true;
  }
}