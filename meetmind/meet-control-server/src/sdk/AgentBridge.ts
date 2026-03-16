import type { MeetAgent, LiveInputEvent, LiveVideoFrame } from './MeetAgent.js';

export type AgentBridgeTextInput = {
  kind: 'text';
  modality: LiveInputEvent['kind'];
  text: string;
  speaker: string;
  occurredAt: string;
  raw: LiveInputEvent;
};

export type AgentBridgeImageInput = {
  kind: 'image';
  modality: 'videoFrame';
  frameId: string;
  occurredAt: string;
  image: ArrayBuffer;
  imageUrl: string;
  mimeType: 'image/jpeg';
  raw: LiveVideoFrame;
};

export type AgentBridgeInput = AgentBridgeTextInput | AgentBridgeImageInput;

export type AgentBridgeAction =
  | {
      type: 'chat';
      text: string;
      awaitCompletion?: boolean;
      timeoutMs?: number;
    }
  | {
      type: 'speak';
      text: string;
      voice?: string;
      rate?: number;
      pitch?: number;
      volume?: number;
      awaitCompletion?: boolean;
      timeoutMs?: number;
    };

export type AgentBridgeHandler = (
  input: AgentBridgeInput
) =>
  | void
  | AgentBridgeAction
  | AgentBridgeAction[]
  | Promise<void | AgentBridgeAction | AgentBridgeAction[]>;

export interface StartAgentBridgeOptions {
  onInput: AgentBridgeHandler;
  onError?: (error: Error) => void;
  includeVideoFrames?: boolean;
}

export function startAgentBridge(
  agent: MeetAgent,
  options: StartAgentBridgeOptions
): () => void {
  let stopped = false;
  let actionQueue = Promise.resolve();

  const handleError = (error: unknown) => {
    options.onError?.(
      error instanceof Error ? error : new Error('Unknown agent bridge error')
    );
  };

  const enqueueActions = (actions: void | AgentBridgeAction | AgentBridgeAction[]) => {
    const list = normalizeActions(actions);

    if (list.length === 0 || stopped) {
      return;
    }

    actionQueue = actionQueue
      .then(async () => {
        for (const action of list) {
          if (stopped) {
            return;
          }

          await dispatchAction(agent, action);
        }
      })
      .catch(handleError);
  };

  const handleInput = async (input: AgentBridgeInput) => {
    try {
      const actions = await options.onInput(input);
      enqueueActions(actions);
    } catch (error) {
      handleError(error);
    }
  };

  const stopLiveSession = agent.startLiveSession({
    onInput: async (input) => {
      await handleInput(toTextInput(input));
    },
    onVideoFrame: options.includeVideoFrames === false
      ? undefined
      : async (frame) => {
          await handleInput(toImageInput(frame));
        },
    onError: options.onError
  });

  return () => {
    stopped = true;
    stopLiveSession();
  };
}

function normalizeActions(
  actions: void | AgentBridgeAction | AgentBridgeAction[]
): AgentBridgeAction[] {
  if (!actions) {
    return [];
  }

  return Array.isArray(actions) ? actions : [actions];
}

async function dispatchAction(agent: MeetAgent, action: AgentBridgeAction): Promise<void> {
  switch (action.type) {
    case 'chat':
      if (action.awaitCompletion === false) {
        await agent.chat(action.text);
        return;
      }

      await agent.chatAndWait(action.text, action.timeoutMs);
      return;
    case 'speak':
      if (action.awaitCompletion === false) {
        await agent.say(action.text, {
          voice: action.voice,
          rate: action.rate,
          pitch: action.pitch,
          volume: action.volume
        });
        return;
      }

      await agent.sayAndWait(
        action.text,
        {
          voice: action.voice,
          rate: action.rate,
          pitch: action.pitch,
          volume: action.volume
        },
        action.timeoutMs
      );
      return;
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`Unsupported agent bridge action: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function toTextInput(input: LiveInputEvent): AgentBridgeTextInput {
  return {
    kind: 'text',
    modality: input.kind,
    text: input.text,
    speaker: input.speaker,
    occurredAt: input.occurredAt,
    raw: input
  };
}

function toImageInput(frame: LiveVideoFrame): AgentBridgeImageInput {
  return {
    kind: 'image',
    modality: 'videoFrame',
    frameId: frame.event.payload.frameId,
    occurredAt: frame.event.payload.capturedAt,
    image: frame.image,
    imageUrl: frame.imageUrl,
    mimeType: 'image/jpeg',
    raw: frame
  };
}
