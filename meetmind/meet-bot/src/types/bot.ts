export type BotStatus =
  | 'created'
  | 'starting'
  | 'launching'
  | 'joining'
  | 'waiting_for_admission'
  | 'joined'
  | 'disconnected'
  | 'recovering'
  | 'failed'
  | 'closed';

export interface CreateBotInput {
  displayName: string;
  meetingUrl: string;
}

export interface JoinBotInput {
  camera?: boolean;
  microphone?: boolean;
}

export interface BotRecord {
  id: string;
  displayName: string;
  meetingUrl: string;
  status: BotStatus;
  error?: string;
}
