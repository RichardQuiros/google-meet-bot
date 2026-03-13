import type { Page } from 'playwright';

export type DetectedChatMessage = {
  messageId: string;
  author: string;
  text: string;
  sentAt: string;
  isOwnMessage?: boolean;
};

export type ChatObserverDomDiagnostics = {
  activePanelId: string;
  chatRootSummary: string;
  inputVisibleSelectors: string[];
  selectorCounts: Record<string, number>;
  sampleNodes: Array<{
    tagName: string;
    className: string;
    ariaLabel: string;
    text: string;
  }>;
};

export type ChatObserverDebugInfo = {
  tick: number;
  rawCount: number;
  visibleCount: number;
  ignoredCount: number;
  freshCount: number;
  seenCount: number;
  rawSample: Array<Pick<DetectedChatMessage, 'author' | 'text'>>;
  ignoredSample: Array<{
    author: string;
    text: string;
    reason: string;
  }>;
  sampleMessages: Array<Pick<DetectedChatMessage, 'author' | 'text'>>;
  diagnostics: ChatObserverDomDiagnostics;
};

type ObserverOptions = {
  pollIntervalMs?: number;
  maxSeenMessages?: number;
  ownDisplayNames?: string[];
  skipInitialVisibleMessages?: boolean;
};

type RawCandidate = {
  messageId: string;
  author: string;
  text: string;
  sentAt: string;
  isOwnMessage: boolean;
};

type IgnoredCandidate = {
  messageId: string;
  author: string;
  text: string;
  reason: string;
};

const CHAT_INPUT_SELECTORS = [
  'textarea[aria-label="Send a message"]',
  'textarea[aria-label="Enviar un mensaje"]',
  'div[contenteditable="true"][aria-label="Send a message"]',
  'div[contenteditable="true"][aria-label="Enviar un mensaje"]',
  '[role="textbox"][aria-label*="message" i]',
  '[role="textbox"][aria-label*="mensaje" i]'
];

const CHAT_ROOT_RESOLUTION = String.raw`
  const activeChatButton =
    document.querySelector('[aria-label*="chat" i][aria-expanded="true"][aria-controls]') ||
    document.querySelector('[aria-label*="chatear" i][aria-expanded="true"][aria-controls]') ||
    document.querySelector('[data-panel-id="2"][aria-expanded="true"][aria-controls]');

  const activePanelId = activeChatButton?.getAttribute('aria-controls') ?? '';
  const chatRoot =
    (activePanelId ? document.getElementById(activePanelId) : null) ||
    (activePanelId
      ? document.querySelector('[data-panel-container-id="' + activePanelId + '"]')
      : null) ||
    document.querySelector('[data-panel-container-id="sidePanel2"]') ||
    document.querySelector('[data-panel-container-id*="chat" i]') ||
    document.querySelector('[id*="sidePanel2"]') ||
    document
      .querySelector('[aria-label*="Chat with everyone" i]')
      ?.closest('[role="complementary"], [role="dialog"], [data-panel-container-id]') ||
    document;
`;

const READ_CHAT_DIAGNOSTICS_SCRIPT = String.raw`
(() => {
  const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const inputSelectors = ${JSON.stringify(CHAT_INPUT_SELECTORS)};

  ${CHAT_ROOT_RESOLUTION}

  const selectorGroups = {
    messageBlocks: Array.from(chatRoot.querySelectorAll('.RLrADb[data-message-id]')),
    authorLabels: Array.from(chatRoot.querySelectorAll('.poVWob')),
    messageBodies: Array.from(chatRoot.querySelectorAll('[jsname="dTKtvb"]')),
    selfGroups: Array.from(chatRoot.querySelectorAll('.Ss4fHf.ydIQ1d')),
    groupContainers: Array.from(chatRoot.querySelectorAll('.Ss4fHf')),
    ariaLiveChildren: Array.from(chatRoot.querySelectorAll('[aria-live="polite"] > *'))
  };

  const inputVisibleSelectors = inputSelectors.filter((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;

    const htmlEl = el;
    const style = window.getComputedStyle(htmlEl);
    const rect = htmlEl.getBoundingClientRect();

    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0
    );
  });

  const sampleNodes = Array.from(
    new Set(
      Object.values(selectorGroups)
        .flat()
        .slice(-20)
    )
  )
    .slice(-5)
    .map((node) => {
      const el = node;
      return {
        tagName: el.tagName?.toLowerCase() ?? '',
        className: normalize(el.className || ''),
        ariaLabel: normalize(el.getAttribute?.('aria-label')),
        text: normalize(el.innerText || el.textContent || '').slice(0, 160)
      };
    });

  const chatRootSummary = [
    chatRoot.tagName?.toLowerCase() ?? '',
    chatRoot.id ? '#' + chatRoot.id : '',
    chatRoot.getAttribute?.('data-panel-container-id')
      ? '[data-panel-container-id="' + chatRoot.getAttribute('data-panel-container-id') + '"]'
      : ''
  ]
    .filter(Boolean)
    .join('');

  const selectorCounts = Object.fromEntries(
    Object.entries(selectorGroups).map(([key, value]) => [key, value.length])
  );

  return {
    activePanelId,
    chatRootSummary,
    inputVisibleSelectors,
    selectorCounts,
    sampleNodes
  };
})()
`;

const READ_VISIBLE_MESSAGES_SCRIPT = String.raw`
(() => {
  const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

  ${CHAT_ROOT_RESOLUTION}

  const messageBlocks = Array.from(
    chatRoot.querySelectorAll('.RLrADb[data-message-id]')
  ).slice(-120);

  const candidates = messageBlocks
    .map((messageEl, index) => {
      const group = messageEl.closest('.Ss4fHf');
      const contentRoot =
        messageEl.querySelector('[jsname="dTKtvb"]') ||
        messageEl.querySelector('.ptNLrf') ||
        messageEl;

      const author = normalize(
        group?.querySelector('.poVWob')?.textContent ||
        group?.querySelector('[data-participant-name]')?.textContent ||
        ''
      );

      const text = normalize(
        contentRoot?.innerText ||
        contentRoot?.textContent ||
        ''
      )
        .replace(/\bPin message\b/gi, '')
        .trim();

      const messageId = normalize(messageEl.getAttribute('data-message-id'));
      const ownLike = Boolean(
        group?.classList.contains('ydIQ1d') ||
        messageEl.querySelector('.chmVPb') ||
        (!author && group)
      );

      if (!messageId || !text) {
        return null;
      }

      return {
        messageId: messageId || ('unknown|' + index),
        author,
        text,
        sentAt: new Date().toISOString(),
        isOwnMessage: ownLike
      };
    })
    .filter(Boolean);

  const dedup = new Map();

  for (const item of candidates) {
    const stableKey = item.messageId || (normalize(item.author) + '|' + normalize(item.text));
    const existing = dedup.get(stableKey);

    if (!existing || item.text.length > existing.text.length) {
      dedup.set(stableKey, item);
    }
  }

  return Array.from(dedup.values()).slice(-30);
})()
`;

export class MeetChatObserver {
  private readonly page: Page;
  private readonly pollIntervalMs: number;
  private readonly maxSeenMessages: number;
  private readonly ownDisplayNames: Set<string>;
  private readonly skipInitialVisibleMessages: boolean;

  private timer?: NodeJS.Timeout;
  private isRunning = false;
  private isTicking = false;
  private initialized = false;
  private tickCount = 0;

  private readonly seenMessageIds = new Set<string>();

  constructor(page: Page, options: ObserverOptions = {}) {
    this.page = page;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.maxSeenMessages = options.maxSeenMessages ?? 500;
    this.ownDisplayNames = new Set(
      (options.ownDisplayNames ?? []).map((name) => this.normalize(name))
    );
    this.skipInitialVisibleMessages = options.skipInitialVisibleMessages ?? false;
  }

  async start(
    onMessages: (messages: DetectedChatMessage[]) => Promise<void>,
    onError?: (error: Error) => void,
    onDebug?: (info: ChatObserverDebugInfo) => void
  ): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;

    await this.ensureChatPanelOpen().catch(() => {});

    const runTick = async (): Promise<void> => {
      if (!this.isRunning || this.isTicking) return;

      this.isTicking = true;
      this.tickCount += 1;

      try {
        const rawCandidates = await this.readRawCandidates();
        const visibleMessages = this.filterCandidates(rawCandidates);
        const ignoredCandidates = this.collectIgnoredCandidates(rawCandidates);
        const fresh = visibleMessages.filter(
          (message) => !this.seenMessageIds.has(message.messageId)
        );

        if (onDebug && (this.tickCount === 1 || this.tickCount % 5 === 0 || fresh.length > 0)) {
          const diagnostics = await this.collectDomDiagnostics().catch(
            (): ChatObserverDomDiagnostics => ({
              activePanelId: '',
              chatRootSummary: 'diagnostics-error',
              inputVisibleSelectors: [],
              selectorCounts: {},
              sampleNodes: []
            })
          );

          onDebug({
            tick: this.tickCount,
            rawCount: rawCandidates.length,
            visibleCount: visibleMessages.length,
            ignoredCount: ignoredCandidates.length,
            freshCount: fresh.length,
            seenCount: this.seenMessageIds.size,
            rawSample: rawCandidates.slice(-3).map((message) => ({
              author: message.author,
              text: message.text
            })),
            ignoredSample: ignoredCandidates.slice(-3).map((message) => ({
              author: message.author,
              text: message.text,
              reason: message.reason
            })),
            sampleMessages: visibleMessages.slice(-3).map((message) => ({
              author: message.author,
              text: message.text
            })),
            diagnostics
          });
        }

        if (!this.initialized) {
          this.initialized = true;

          if (this.skipInitialVisibleMessages) {
            for (const message of visibleMessages) {
              this.markSeen(message.messageId);
            }
            return;
          }
        }

        if (fresh.length > 0) {
          for (const message of fresh) {
            this.markSeen(message.messageId);
          }

          await onMessages(fresh);
        }
      } catch (error) {
        onError?.(
          error instanceof Error ? error : new Error('Unknown chat observer error')
        );
      } finally {
        this.isTicking = false;
      }
    };

    await runTick();
    this.timer = setInterval(() => {
      void runTick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async ensureChatPanelOpen(): Promise<void> {
    for (const selector of CHAT_INPUT_SELECTORS) {
      const input = this.page.locator(selector).first();
      if (await input.isVisible().catch(() => false)) {
        return;
      }
    }

    const buttonNames = [
      'Chat with everyone',
      'Open chat',
      'Chat',
      'Chatear con todos',
      'Abrir chat'
    ];

    for (const name of buttonNames) {
      const button = this.page.getByRole('button', { name }).first();

      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        await this.page.waitForTimeout(700);
        return;
      }
    }

    const fallbackButtons = [
      'button[aria-label*="chat" i]',
      'button[aria-label*="message" i]',
      'button[aria-label*="mensaje" i]'
    ];

    for (const selector of fallbackButtons) {
      const button = this.page.locator(selector).first();

      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        await this.page.waitForTimeout(700);
        return;
      }
    }

    await this.page.keyboard.press('Control+Alt+c').catch(() => {});
    await this.page.waitForTimeout(700).catch(() => {});
  }

  async probe(): Promise<{
    rawCount: number;
    visibleCount: number;
    ignoredCount: number;
    rawSample: Array<Pick<DetectedChatMessage, 'author' | 'text'>>;
    ignoredSample: Array<{ author: string; text: string; reason: string }>;
    sample: Array<Pick<DetectedChatMessage, 'author' | 'text'>>;
    diagnostics: ChatObserverDomDiagnostics;
  }> {
    const rawCandidates = await this.readRawCandidates();
    const ignoredCandidates = this.collectIgnoredCandidates(rawCandidates);
    const messages = this.filterCandidates(rawCandidates);

    return {
      rawCount: rawCandidates.length,
      visibleCount: messages.length,
      ignoredCount: ignoredCandidates.length,
      rawSample: rawCandidates.slice(-3).map((message) => ({
        author: message.author,
        text: message.text
      })),
      ignoredSample: ignoredCandidates.slice(-3).map((message) => ({
        author: message.author,
        text: message.text,
        reason: message.reason
      })),
      sample: messages.slice(-3).map((message) => ({
        author: message.author,
        text: message.text
      })),
      diagnostics: await this.collectDomDiagnostics()
    };
  }

  private async readRawCandidates(): Promise<RawCandidate[]> {
    await this.ensureChatPanelOpen().catch(() => {});
    return (await this.page.evaluate(READ_VISIBLE_MESSAGES_SCRIPT)) as RawCandidate[];
  }

  private filterCandidates(raw: RawCandidate[]): DetectedChatMessage[] {
    return raw
      .filter((item) => !this.getIgnoreReason(item))
      .map((item) => ({
        messageId: item.messageId,
        author: item.author,
        text: item.text,
        sentAt: item.sentAt,
        isOwnMessage: item.isOwnMessage
      }));
  }

  private collectIgnoredCandidates(raw: RawCandidate[]): IgnoredCandidate[] {
    return raw
      .map((item) => ({
        messageId: item.messageId,
        author: item.author,
        text: item.text,
        reason: this.getIgnoreReason(item)
      }))
      .filter((item): item is IgnoredCandidate => Boolean(item.reason));
  }

  private getIgnoreReason(message: RawCandidate): string | undefined {
    if (message.isOwnMessage) return 'own-message';
    if (!message.author || !message.text) return 'missing-author-or-text';

    const author = this.normalize(message.author);
    const text = this.normalize(message.text);
    const isOwnByName = this.ownDisplayNames.has(author);

    if (isOwnByName) return 'own-message';
    if (!author || !text) return 'missing-author-or-text';
    if (author === text) return 'author-equals-text';
    if (text.length < 1) return 'empty-text';

    const noisyTexts = [
      'send a message',
      'enviar un mensaje',
      'chat with everyone',
      'chatear con todos'
    ];

    if (noisyTexts.includes(text)) return 'noise-text';

    return undefined;
  }

  private async collectDomDiagnostics(): Promise<ChatObserverDomDiagnostics> {
    return (await this.page.evaluate(
      READ_CHAT_DIAGNOSTICS_SCRIPT
    )) as ChatObserverDomDiagnostics;
  }

  private markSeen(messageId: string): void {
    this.seenMessageIds.add(messageId);

    if (this.seenMessageIds.size > this.maxSeenMessages) {
      const ids = [...this.seenMessageIds];
      const overflow = ids.length - this.maxSeenMessages;

      for (let i = 0; i < overflow; i += 1) {
        this.seenMessageIds.delete(ids[i]);
      }
    }
  }

  private normalize(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
}
