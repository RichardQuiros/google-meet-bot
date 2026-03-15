import path from 'node:path';
import fs from 'node:fs/promises';
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response
} from 'playwright';

import type { BotRecord, JoinBotInput } from '../types/bot.js';

type JoinDetection =
  | 'joined'
  | 'waiting_for_admission'
  | 'join_button_clicked'
  | 'unknown';

type DebugLogLevel = 'info' | 'warn' | 'error';

type DebugLog = {
  level: DebugLogLevel;
  message: string;
  data?: unknown;
  timestamp: string;
};

export type MicrophoneState = 'enabled' | 'disabled' | 'unknown';

type PreferredMicrophoneSelectionResult = {
  selected: boolean;
  preferredLabel?: string;
  selectedLabel?: string;
  reason:
    | 'selected'
    | 'already-selected'
    | 'not-configured'
    | 'page-not-initialized'
    | 'settings-not-opened'
    | 'control-not-found'
    | 'option-not-found'
    | 'selection-failed';
};

export class MeetBot {
  public record: BotRecord;

  private context?: BrowserContext;
  private page?: Page;
  private lastAppliedPreferredMicrophoneLabel?: string;
  private preferredMicrophoneSelectionAppliedForCurrentJoin = false;

  private readonly logs: DebugLog[] = [];
  private readonly profileDir: string;
  private readonly artifactsDir: string;

  private lastFailedRequests: Array<{
    url: string;
    method: string;
    failure?: string;
  }> = [];

  private lastHttpErrors: Array<{
    url: string;
    status: number;
    statusText: string;
  }> = [];

  constructor(record: BotRecord) {
    this.record = record;

    const safeId = this.record.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.profileDir = path.resolve(process.cwd(), 'tmp', 'profiles', safeId);
    this.artifactsDir = path.resolve(process.cwd(), 'tmp', 'artifacts', safeId);
  }

  async join(options: JoinBotInput = {}): Promise<void> {
    const { camera = false, microphone = false } = options;

    try {
      this.record.error = undefined;
      this.record.status = 'launching';
      this.lastAppliedPreferredMicrophoneLabel = undefined;
      this.preferredMicrophoneSelectionAppliedForCurrentJoin = false;

      await this.page?.close().catch(() => {});
      await this.context?.close().catch(() => {});
      this.page = undefined;
      this.context = undefined;

      await fs.mkdir(this.profileDir, { recursive: true });
      await fs.mkdir(this.artifactsDir, { recursive: true });
      await this.cleanupProfileLockArtifacts();

      this.log('info', 'Launching Chrome persistent context', {
        profileDir: this.profileDir
      });

      this.context = await this.launchChromePersistentContext();

      this.context.setDefaultTimeout(15000);
      this.context.setDefaultNavigationTimeout(60000);

      this.attachContextDiagnostics(this.context);

      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
      await this.installAudioCaptureGuards(this.page);

      if (this.shouldEnableStealthGuards()) {
        await this.installStealthGuards(this.page);
        this.log('info', 'Experimental stealth guards enabled');
      }

      this.attachPageDiagnostics(this.page);

      this.record.status = 'joining';

      await this.warmupGoogle();
      await this.gotoMeet();
      await this.captureRuntimeInfo();

      await this.dismissPossiblePopups();
      await this.fillGuestNameIfNeeded(this.record.displayName);

      const preferredMicrophoneSelection =
        await this.ensurePreferredMicrophoneSelected();

      if (preferredMicrophoneSelection.reason !== 'not-configured') {
        this.log('info', 'Preferred microphone selection attempt during join', preferredMicrophoneSelection);
      }

      if (!camera) {
        await this.tryToggleCameraOff();
      }

      if (!microphone) {
        await this.tryToggleMicrophoneOff();
      }

      await this.randomWait(900, 1400);

      const joinClickResult = await this.tryJoin();

      this.log('info', 'Join click result', { joinClickResult });

      await this.randomWait(4000, 5500);

      const state = await this.detectJoinState();

      this.log('info', 'Detected join state', { state });

      if (state === 'joined') {
        this.record.status = 'joined';
        await this.captureArtifacts('joined');
        return;
      }

      if (
        state === 'waiting_for_admission' ||
        joinClickResult === 'join_button_clicked'
      ) {
        this.record.status = 'waiting_for_admission';
        await this.captureArtifacts('waiting-for-admission');
        return;
      }

      this.record.status = 'failed';
      this.record.error = 'Unable to confirm join state';

      await this.captureArtifacts('join-state-unknown');
    } catch (error) {
      this.record.status = 'failed';
      this.record.error =
        error instanceof Error ? error.message : 'Unknown error';

      this.log('error', 'Join failed', {
        error: this.record.error,
        failedRequests: this.lastFailedRequests.slice(-10),
        httpErrors: this.lastHttpErrors.slice(-10)
      });

      await this.captureArtifacts('join-failed').catch(() => { });
    }
  }

  async close(): Promise<void> {
    try {
      await this.page?.close().catch(() => { });
      await this.context?.close().catch(() => { });
      await this.cleanupProfileLockArtifacts();
    } finally {
      this.page = undefined;
      this.context = undefined;
      this.record.status = 'closed';
    }
  }

  private async launchChromePersistentContext(): Promise<BrowserContext> {
    try {
      return await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        channel: process.env.MEET_CHROME_CHANNEL || 'chrome',
        executablePath: process.env.MEET_CHROME_PATH || undefined,
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/Panama',
        permissions: ['microphone', 'camera'],
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-audio-track-processing',
          '--disable-features=WebRtcAllowInputVolumeAdjustment',
          '--auto-accept-camera-and-microphone-capture'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      });
    } catch (error) {
      if (!this.isProfileLockError(error)) {
        throw error;
      }

      this.log('warn', 'Chrome profile lock detected, cleaning up lock artifacts and retrying once');
      await this.cleanupProfileLockArtifacts();

      return chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        channel: process.env.MEET_CHROME_CHANNEL || 'chrome',
        executablePath: process.env.MEET_CHROME_PATH || undefined,
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/Panama',
        permissions: ['microphone', 'camera'],
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-audio-track-processing',
          '--disable-features=WebRtcAllowInputVolumeAdjustment',
          '--auto-accept-camera-and-microphone-capture'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      });
    }
  }

  private isProfileLockError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /profile appears to be in use|process_singleton_posix|singletonlock/i.test(message);
  }

  private async cleanupProfileLockArtifacts(): Promise<void> {
    const lockArtifacts = [
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie'
    ];

    await Promise.all(
      lockArtifacts.map(async (entry) => {
        const target = path.join(this.profileDir, entry);

        await fs.rm(target, {
          force: true,
          recursive: true
        }).catch(() => {});
      })
    );
  }

  getLogs(): DebugLog[] {
    return [...this.logs];
  }

  private async warmupGoogle(): Promise<void> {
    if (!this.page) return;

    this.log('info', 'Warming up browser on google.com');

    await this.page.goto('https://www.google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await this.randomWait(1800, 2600);
  }

  private async gotoMeet(): Promise<void> {
    if (!this.page) return;

    this.log('info', 'Navigating to meeting URL', {
      meetingUrl: this.record.meetingUrl
    });

    await this.page.goto(this.record.meetingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await this.randomWait(2200, 3200);
  }

  private attachContextDiagnostics(context: BrowserContext): void {
    context.on('page', (page) => {
      this.log('info', 'New page created', { url: page.url() });
      this.attachPageDiagnostics(page);
    });
  }

  private attachPageDiagnostics(page: Page): void {
    page.on('crash', () => {
      this.record.status = 'disconnected';
      this.log('error', 'Page crashed');
    });

    page.on('close', () => {
      if (
        this.record.status === 'joined' ||
        this.record.status === 'waiting_for_admission'
      ) {
        this.record.status = 'disconnected';
      }
    });

    page.on('console', (msg) => {
      const type = msg.type();

      if (type === 'error' || type === 'warning') {
        this.log(type === 'error' ? 'error' : 'warn', 'Browser console message', {
          type,
          text: msg.text()
        });
      }
    });

    page.on('pageerror', (err) => {
      this.log('error', 'Page runtime error', {
        message: err.message,
        stack: err.stack
      });
    });

    page.on('requestfailed', (request: Request) => {
      const item = {
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText
      };

      this.lastFailedRequests.push(item);
      this.lastFailedRequests = this.lastFailedRequests.slice(-50);

      this.log('warn', 'Request failed', item);
    });

    page.on('response', async (response: Response) => {
      const status = response.status();

      if (status >= 400) {
        const item = {
          url: response.url(),
          status,
          statusText: response.statusText()
        };

        this.lastHttpErrors.push(item);
        this.lastHttpErrors = this.lastHttpErrors.slice(-50);

        if (
          response.url().includes('ResolveMeetingSpace') ||
          response.url().includes('/$rpc/')
        ) {
          this.log('warn', 'Important HTTP error response detected', item);
        }
      }
    });
  }

  private async installStealthGuards(page: Page): Promise<void> {
    await page.addInitScript(`
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => undefined,
          configurable: true
        });
      } catch {}
    `);
  }

  private async installAudioCaptureGuards(page: Page): Promise<void> {
    await page.addInitScript(`
      try {
        const audioOverrides = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          googTypingNoiseDetection: false,
          googAudioMirroring: false
        };

        const patchConstraints = (constraints) => {
          if (!constraints || !constraints.audio) {
            return constraints;
          }

          if (constraints.audio === true) {
            return {
              ...constraints,
              audio: { ...audioOverrides }
            };
          }

          if (typeof constraints.audio === 'object') {
            return {
              ...constraints,
              audio: {
                ...constraints.audio,
                ...audioOverrides
              }
            };
          }

          return constraints;
        };

        if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
          const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = (constraints) =>
            originalGetUserMedia(patchConstraints(constraints));
        }
      } catch {}
    `);
  }

  private shouldEnableStealthGuards(): boolean {
    return /^(1|true|yes)$/i.test(process.env.MEET_ENABLE_STEALTH_GUARDS ?? '');
  }

  private async captureRuntimeInfo(): Promise<void> {
    if (!this.page) return;

    const data = await this.page.evaluate(() => {
      const nav = navigator as Navigator & {
        webdriver?: boolean;
        userAgentData?: {
          brands?: Array<{ brand: string; version: string }>;
          mobile?: boolean;
          platform?: string;
        };
      };

      return {
        locationHref: window.location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        webdriver: nav.webdriver,
        userAgentData: nav.userAgentData
          ? {
            brands: nav.userAgentData.brands,
            mobile: nav.userAgentData.mobile,
            platform: nav.userAgentData.platform
          }
          : null
      };
    });

    this.log('info', 'Runtime info', data);
  }

  private async dismissPossiblePopups(): Promise<void> {
    if (!this.page) return;

    const buttonTexts = [
      'Got it',
      'Dismiss',
      'Close',
      'OK',
      'Aceptar',
      'Entendido',
      'Cerrar'
    ];

    for (const text of buttonTexts) {
      const button = this.page.getByRole('button', { name: text }).first();

      if (await button.isVisible().catch(() => false)) {
        await button.click({ delay: this.randomInt(40, 110) }).catch(() => { });
        this.log('info', 'Dismissed popup/button', { text });
        await this.randomWait(250, 500);
      }
    }
  }

  private async fillGuestNameIfNeeded(displayName: string): Promise<void> {
    if (!this.page) return;

    const selectors = [
      'input[aria-label="Your name"]',
      'input[aria-label="Enter your name"]',
      'input[aria-label*="name"]',
      'input[placeholder="Your name"]',
      'input[placeholder*="name"]',
      'input[type="text"]'
    ];

    for (const selector of selectors) {
      const input = this.page.locator(selector).first();

      if (await input.isVisible().catch(() => false)) {
        await input.click({ delay: this.randomInt(30, 90) }).catch(() => { });
        await this.randomWait(150, 350);

        try {
          await input.fill('');
        } catch { }

        await input.type(displayName, {
          delay: this.randomInt(65, 130)
        });

        this.log('info', 'Filled guest name', { selector, displayName });
        await this.randomWait(250, 500);
        return;
      }
    }

    this.log('warn', 'Guest name input not found');
  }

  private async tryToggleCameraOff(): Promise<boolean> {
    return this.tryClickByNames([
      'Turn off camera',
      'Turn camera off',
      'Camera off',
      'Desactivar cámara',
      'Apagar cámara'
    ]);
  }

  private async tryToggleMicrophoneOff(): Promise<boolean> {
    return this.tryClickByNames([
      'Turn off microphone',
      'Turn microphone off',
      'Mute microphone',
      'Microphone off',
      'Desactivar micrófono',
      'Apagar micrófono',
      'Silenciar micrófono'
    ]);
  }

  private async tryJoin(): Promise<JoinDetection> {
    if (!this.page) return 'unknown';

    const joinTexts = [
      'Ask to join',
      'Join now',
      'Request to join',
      'Solicitar unirse',
      'Unirse ahora'
    ];

    for (const text of joinTexts) {
      const button = this.page.getByRole('button', { name: text }).first();

      if (await button.isVisible().catch(() => false)) {
        await this.randomWait(350, 700);
        await button.click({ delay: this.randomInt(40, 100) }).catch(() => { });
        this.log('info', 'Clicked join button', { text });
        return 'join_button_clicked';
      }
    }

    return 'unknown';
  }

  private async detectJoinState(): Promise<JoinDetection> {
    if (!this.page) return 'unknown';

    const url = this.page.url();
    const bodyText = (await this.safeInnerText('body')).toLowerCase();
    const meetingCode = this.extractMeetingCode(this.record.meetingUrl);

    if (meetingCode && url.includes(meetingCode)) {
      if (
        bodyText.includes('you asked to join') ||
        bodyText.includes('asking to join') ||
        bodyText.includes('waiting for someone in the call to let you in') ||
        bodyText.includes('solicitaste unirte') ||
        bodyText.includes('esperando que alguien te admita')
      ) {
        return 'waiting_for_admission';
      }
    }

    const leaveCallButtonNames = [
      'Leave call',
      'Hang up',
      'Exit call',
      'Abandonar llamada',
      'Salir de la llamada',
      'Colgar'
    ];

    for (const name of leaveCallButtonNames) {
      const leaveButton = this.page.getByRole('button', { name }).first();
      if (await leaveButton.isVisible().catch(() => false)) {
        return 'joined';
      }
    }

    const inCallHints = [
      'meeting details',
      'people',
      'chat with everyone',
      'raise hand',
      'detalles de la reunión',
      'personas',
      'chatear con todos',
      'levantar la mano'
    ];

    for (const hint of inCallHints) {
      if (bodyText.includes(hint)) {
        return 'joined';
      }
    }

    return 'unknown';
  }

  private async tryClickByNames(names: string[]): Promise<boolean> {
    if (!this.page) return false;

    for (const name of names) {
      const button = this.page.getByRole('button', { name }).first();

      if (await button.isVisible().catch(() => false)) {
        await this.randomWait(150, 350);
        await button.click({ delay: this.randomInt(35, 90) }).catch(() => { });
        this.log('info', 'Clicked button', { name });
        await this.randomWait(250, 500);
        return true;
      }
    }

    return false;
  }

  private async captureArtifacts(prefix: string): Promise<void> {
    if (!this.page) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(this.artifactsDir, `${prefix}-${timestamp}`);

    await this.page.screenshot({
      path: `${base}.png`,
      fullPage: true
    });

    const html = await this.page.content();
    await fs.writeFile(`${base}.html`, html, 'utf8');

    const meta = {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      status: this.record.status,
      error: this.record.error,
      logs: this.logs.slice(-50),
      failedRequests: this.lastFailedRequests.slice(-20),
      httpErrors: this.lastHttpErrors.slice(-20)
    };

    await fs.writeFile(`${base}.json`, JSON.stringify(meta, null, 2), 'utf8');

    this.log('info', 'Artifacts captured', {
      screenshot: `${base}.png`,
      html: `${base}.html`,
      meta: `${base}.json`
    });
  }

  private async safeInnerText(selector: string): Promise<string> {
    if (!this.page) return '';

    const locator = this.page.locator(selector).first();
    return locator.innerText().catch(() => '');
  }

  private extractMeetingCode(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    } catch {
      return '';
    }
  }

  private async randomWait(minMs: number, maxMs: number): Promise<void> {
    if (!this.page) return;
    await this.page.waitForTimeout(this.randomInt(minMs, maxMs));
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private log(level: DebugLogLevel, message: string, data?: unknown): void {
    this.logs.push({
      level,
      message,
      data,
      timestamp: new Date().toISOString()
    });

    if (this.logs.length > 300) {
      this.logs.splice(0, this.logs.length - 300);
    }
  }

  async sendChatMessage(text: string): Promise<void> {
    if (!this.page) {
      throw new Error('Bot page is not initialized');
    }

    await this.openChatPanelIfNeeded();

    const inputSelectors = [
      'textarea[aria-label="Send a message"]',
      'textarea[aria-label="Enviar un mensaje"]',
      'div[contenteditable="true"][aria-label="Send a message"]',
      'div[contenteditable="true"][aria-label="Enviar un mensaje"]',
      '[role="textbox"][aria-label*="message" i]',
      '[role="textbox"][aria-label*="mensaje" i]'
    ];

    let messageBoxFound = false;

    for (const selector of inputSelectors) {
      const input = this.page.locator(selector).first();

      if (await input.isVisible().catch(() => false)) {
        await input.click({ delay: this.randomInt(30, 80) }).catch(() => { });
        await this.randomWait(150, 300);

        if (selector.startsWith('textarea')) {
          await input.fill('');
          await input.type(text, { delay: this.randomInt(25, 60) });
        } else {
          await input.fill('').catch(() => { });
          await this.page.keyboard.type(text, {
            delay: this.randomInt(25, 60)
          });
        }

        messageBoxFound = true;
        break;
      }
    }

    if (!messageBoxFound) {
      throw new Error('Chat input not found');
    }

    await this.randomWait(150, 300);
    await this.page.keyboard.press('Enter');

    this.log('info', 'Chat message sent', { text });
  }

  async getMicrophoneState(): Promise<{ state: MicrophoneState; label?: string }> {
    const buttonInfo = await this.findVisibleMicrophoneButton();

    if (!buttonInfo) {
      return { state: 'unknown' };
    }

    return {
      state: this.classifyMicrophoneLabel(buttonInfo.label),
      label: buttonInfo.label
    };
  }

  async ensureMicrophoneEnabled(): Promise<{
    changed: boolean;
    state: MicrophoneState;
    label?: string;
  }> {
    const before = await this.getMicrophoneState();

    if (before.state === 'enabled') {
      return {
        changed: false,
        state: before.state,
        label: before.label
      };
    }

    if (before.state !== 'disabled') {
      return {
        changed: false,
        state: before.state,
        label: before.label
      };
    }

    const buttonInfo = await this.findVisibleMicrophoneButton();

    if (!buttonInfo) {
      return {
        changed: false,
        state: 'unknown',
        label: before.label
      };
    }

    await this.randomWait(120, 260);
    await buttonInfo.button.click({ delay: this.randomInt(35, 90) }).catch(() => {});
    await this.randomWait(500, 900);

    const after = await this.getMicrophoneState();
    const changed = after.state === 'enabled';

    this.log(
      changed ? 'info' : 'warn',
      changed ? 'Microphone enabled for speech output' : 'Unable to enable microphone for speech output',
      {
        beforeLabel: before.label,
        afterLabel: after.label
      }
    );

    return {
      changed,
      state: after.state,
      label: after.label ?? before.label
    };
  }

  async ensurePreferredMicrophoneSelected(): Promise<PreferredMicrophoneSelectionResult> {
    const preferredCandidates = this.getPreferredMicrophoneCandidates();
    const preferredLabel = preferredCandidates[0];

    if (!preferredLabel) {
      return {
        selected: false,
        reason: 'not-configured'
      };
    }

    if (!this.page) {
      return {
        selected: false,
        preferredLabel,
        reason: 'page-not-initialized'
      };
    }

    const settingsDialog = await this.openSettingsDialog();

    if (!settingsDialog) {
      if (
        this.preferredMicrophoneSelectionAppliedForCurrentJoin &&
        this.lastAppliedPreferredMicrophoneLabel &&
        this.matchesPreferredMicrophone(this.lastAppliedPreferredMicrophoneLabel, preferredCandidates)
      ) {
        return {
          selected: true,
          preferredLabel,
          selectedLabel: this.lastAppliedPreferredMicrophoneLabel,
          reason: 'already-selected'
        };
      }

      return {
        selected: false,
        preferredLabel,
        reason: 'settings-not-opened'
      };
    }

    try {
      await this.focusAudioSettingsTab(settingsDialog);

      const control = await this.findVisibleMicrophoneControl(settingsDialog);

      if (!control) {
        return {
          selected: false,
          preferredLabel,
          reason: 'control-not-found'
        };
      }

      const currentValue = this.normalizeDeviceLabel(
        (await this.readControlLabel(control)) ?? ''
      );

      if (currentValue && this.matchesPreferredMicrophone(currentValue, preferredCandidates)) {
        this.lastAppliedPreferredMicrophoneLabel = currentValue;
        this.preferredMicrophoneSelectionAppliedForCurrentJoin = true;

        return {
          selected: true,
          preferredLabel,
          selectedLabel: currentValue,
          reason: 'already-selected'
        };
      }

      const selectedLabel = await this.selectControlOption(control, preferredCandidates);

      if (!selectedLabel) {
        return {
          selected: false,
          preferredLabel,
          reason: 'option-not-found'
        };
      }

      const verifiedValue = this.normalizeDeviceLabel(
        (await this.readControlLabel(control)) ?? selectedLabel
      );

      if (!this.matchesPreferredMicrophone(verifiedValue || selectedLabel, preferredCandidates)) {
        return {
          selected: false,
          preferredLabel,
          selectedLabel: verifiedValue || selectedLabel,
          reason: 'selection-failed'
        };
      }

      this.lastAppliedPreferredMicrophoneLabel = verifiedValue || selectedLabel;
      this.preferredMicrophoneSelectionAppliedForCurrentJoin = true;

      return {
        selected: true,
        preferredLabel,
        selectedLabel: verifiedValue || selectedLabel,
        reason: 'selected'
      };
    } finally {
      await this.closeSettingsDialog(settingsDialog);
    }
  }

  private async openChatPanelIfNeeded(): Promise<void> {
    if (!this.page) return;

    const inputSelectors = [
      'textarea[aria-label="Send a message"]',
      'textarea[aria-label="Enviar un mensaje"]',
      'div[contenteditable="true"][aria-label="Send a message"]',
      'div[contenteditable="true"][aria-label="Enviar un mensaje"]',
      '[role="textbox"][aria-label*="message" i]',
      '[role="textbox"][aria-label*="mensaje" i]'
    ];

    for (const selector of inputSelectors) {
      const input = this.page.locator(selector).first();
      if (await input.isVisible().catch(() => false)) {
        return;
      }
    }

    const chatButtonNames = [
      'Chat with everyone',
      'Open chat',
      'Chat',
      'Chatear con todos',
      'Abrir chat'
    ];

    for (const name of chatButtonNames) {
      const button = this.page.getByRole('button', { name }).first();

      if (await button.isVisible().catch(() => false)) {
        await this.randomWait(150, 350);
        await button.click({ delay: this.randomInt(35, 90) }).catch(() => { });
        await this.randomWait(400, 800);
        this.log('info', 'Chat panel opened', { buttonName: name });
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
        await this.randomWait(150, 350);
        await button.click({ delay: this.randomInt(35, 90) }).catch(() => {});
        await this.randomWait(400, 800);
        this.log('info', 'Chat panel opened via fallback selector', { selector });
        return;
      }
    }

    await this.page.keyboard.press('Control+Alt+c').catch(() => {});
    await this.randomWait(400, 800);

    for (const selector of inputSelectors) {
      const input = this.page.locator(selector).first();
      if (await input.isVisible().catch(() => false)) {
        this.log('info', 'Chat panel opened via keyboard shortcut');
        return;
      }
    }

    throw new Error('Unable to open chat panel');
  }

  getPage(): Page | undefined {
    if (!this.page || this.page.isClosed()) {
      return undefined;
    }

    return this.page;
  }

  private async findVisibleMicrophoneButton(): Promise<{
    button: Locator;
    label: string;
  } | undefined> {
    if (!this.page) {
      return undefined;
    }

    const selectors = [
      'button[aria-label*="microphone" i]',
      'button[aria-label*="micr" i]',
      '[role="button"][aria-label*="microphone" i]',
      '[role="button"][aria-label*="micr" i]'
    ];

    for (const selector of selectors) {
      const matches = this.page.locator(selector);
      const count = Math.min(await matches.count().catch(() => 0), 6);

      for (let index = 0; index < count; index += 1) {
        const button = matches.nth(index);

        if (!(await button.isVisible().catch(() => false))) {
          continue;
        }

        const label = (await button.getAttribute('aria-label').catch(() => null))
          ?.trim();

        if (!label) {
          continue;
        }

        return { button, label };
      }
    }

    return undefined;
  }

  private getPreferredMicrophoneLabel(): string | undefined {
    const rawValue =
      process.env.MEET_PREFERRED_MICROPHONE_LABEL ??
      process.env.MEET_AUDIO_SOURCE_DESCRIPTION ??
      process.env.MEET_AUDIO_SOURCE_NAME ??
      process.env.WINDOWS_MEETING_MICROPHONE_HINT ??
      process.env.WINDOWS_MEETING_LOOPBACK_HINT ??
      process.env.MEET_AUDIO_INPUT_DEVICE;

    if (!rawValue) {
      return undefined;
    }

    return rawValue.replace(/^audio=/i, '').trim() || undefined;
  }

  private getPreferredMicrophoneCandidates(): string[] {
    const rawCandidates = [
      process.env.MEET_PREFERRED_MICROPHONE_LABEL,
      process.env.MEET_AUDIO_SOURCE_DESCRIPTION,
      process.env.MEET_AUDIO_SOURCE_NAME,
      process.env.WINDOWS_MEETING_MICROPHONE_HINT,
      process.env.WINDOWS_MEETING_LOOPBACK_HINT,
      process.env.MEET_AUDIO_INPUT_DEVICE
    ];

    const uniqueCandidates = new Map<string, string>();

    for (const candidate of rawCandidates.flatMap((value) => this.expandDeviceLabelCandidates(value))) {
      const normalized = this.normalizeDeviceLabel(candidate);

      if (!normalized || uniqueCandidates.has(normalized)) {
        continue;
      }

      uniqueCandidates.set(normalized, candidate);
    }

    return [...uniqueCandidates.values()];
  }

  private expandDeviceLabelCandidates(value: string | undefined): string[] {
    if (!value) {
      return [];
    }

    const trimmed = value.replace(/^audio=/i, '').trim();

    if (!trimmed) {
      return [];
    }

    const variants = new Set<string>([trimmed]);

    variants.add(trimmed.replace(/[_-]+/g, ' '));
    variants.add(trimmed.replace(/\./g, ' '));

    if (/\.monitor$/i.test(trimmed)) {
      variants.add(trimmed.replace(/\.monitor$/i, ''));
    }

    return [...variants].filter(Boolean);
  }

  private async openSettingsDialog(): Promise<Locator | undefined> {
    if (!this.page) {
      return undefined;
    }

    const existingDialog = await this.findVisibleSettingsDialog();
    if (existingDialog) {
      return existingDialog;
    }

    const settingsButtonNames = [
      'Settings',
      'Configuracion',
      'Configuración'
    ];

    await this.revealCallControls();

    for (const name of settingsButtonNames) {
      const directButton = this.page.getByRole('button', { name }).first();

      if (await directButton.isVisible().catch(() => false)) {
        await directButton.click({ delay: this.randomInt(35, 90) }).catch(() => {});
        return this.waitForVisibleSettingsDialog();
      }
    }

    const moreOptionsNames = [
      'More options',
      'More options menu',
      'Options',
      'Mas opciones',
      'Más opciones',
      'Menu de opciones',
      'Menú de opciones'
    ];

    for (const name of moreOptionsNames) {
      const moreOptionsButton = this.page.getByRole('button', { name }).first();

      if (!(await moreOptionsButton.isVisible().catch(() => false))) {
        continue;
      }

      await moreOptionsButton.click({ delay: this.randomInt(35, 90) }).catch(() => {});
      await this.randomWait(250, 500);

      for (const settingsName of settingsButtonNames) {
        const menuItem = this.page.getByRole('menuitem', { name: settingsName }).first();

        if (await menuItem.isVisible().catch(() => false)) {
          await menuItem.click({ delay: this.randomInt(35, 90) }).catch(() => {});
          return this.waitForVisibleSettingsDialog();
        }

        const settingsButton = this.page.getByRole('button', { name: settingsName }).first();
        if (await settingsButton.isVisible().catch(() => false)) {
          await settingsButton.click({ delay: this.randomInt(35, 90) }).catch(() => {});
          return this.waitForVisibleSettingsDialog();
        }
      }

      await this.page.keyboard.press('Escape').catch(() => {});
      await this.randomWait(150, 300);
    }

    const fallbackMoreOptionsButtons = [
      this.page.locator('button[aria-label*="options" i]').first(),
      this.page.locator('button[aria-label*="opciones" i]').first(),
      this.page.locator('button[aria-label*="more" i]').first()
    ];

    for (const moreOptionsButton of fallbackMoreOptionsButtons) {
      if (!(await moreOptionsButton.isVisible().catch(() => false))) {
        continue;
      }

      await moreOptionsButton.click({ delay: this.randomInt(35, 90) }).catch(() => {});
      await this.randomWait(250, 500);

      for (const settingsName of settingsButtonNames) {
        const menuItem = this.page.getByRole('menuitem', { name: settingsName }).first();

        if (await menuItem.isVisible().catch(() => false)) {
          await menuItem.click({ delay: this.randomInt(35, 90) }).catch(() => {});
          return this.waitForVisibleSettingsDialog();
        }

        const settingsButton = this.page.getByRole('button', { name: settingsName }).first();
        if (await settingsButton.isVisible().catch(() => false)) {
          await settingsButton.click({ delay: this.randomInt(35, 90) }).catch(() => {});
          return this.waitForVisibleSettingsDialog();
        }
      }

      await this.page.keyboard.press('Escape').catch(() => {});
      await this.randomWait(150, 300);
    }

    return undefined;
  }

  private async waitForVisibleSettingsDialog(
    timeoutMs = 2500
  ): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const dialog = await this.findVisibleSettingsDialog();

      if (dialog) {
        return dialog;
      }

      await this.randomWait(120, 220);
    }

    return undefined;
  }

  private async revealCallControls(): Promise<void> {
    if (!this.page) {
      return;
    }

    const viewport = this.page.viewportSize();

    if (viewport) {
      const centerX = Math.max(24, Math.floor(viewport.width / 2));
      const lowerY = Math.max(24, viewport.height - 56);

      await this.page.mouse.move(centerX, lowerY).catch(() => {});
      await this.randomWait(120, 220);
      return;
    }

    await this.page.mouse.move(680, 712).catch(() => {});
    await this.randomWait(120, 220);
  }

  private async findVisibleSettingsDialog(): Promise<Locator | undefined> {
    if (!this.page) {
      return undefined;
    }

    const selectors = [
      '[jsname="rZHESd"]',
      '.VfPpkd-cnG4Wd',
      '[role="dialog"]'
    ];

    for (const selector of selectors) {
      const dialogs = this.page.locator(selector);
      const count = Math.min(await dialogs.count().catch(() => 0), 5);

      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);

        if (!(await dialog.isVisible().catch(() => false))) {
          continue;
        }

        const hasSettingsHeading = await dialog
          .locator('h1, [role="heading"]')
          .filter({ hasText: /(settings|configur)/i })
          .first()
          .isVisible()
          .catch(() => false);

        const hasSettingsTablist = await dialog
          .locator('[role="tablist"][aria-label*="Settings" i], [role="tablist"][aria-label*="Configur" i]')
          .first()
          .isVisible()
          .catch(() => false);

        if (hasSettingsHeading || hasSettingsTablist) {
          return dialog;
        }

        const text = await dialog.innerText().catch(() => '');

        if (/(settings|configur|audio|video|microphone|speaker|camera|micr)/i.test(text)) {
          return dialog;
        }
      }
    }

    return undefined;
  }

  private async focusAudioSettingsTab(settingsDialog: Locator): Promise<void> {
    const audioTabNames = ['Audio'];

    for (const name of audioTabNames) {
      const tab = settingsDialog.getByRole('tab', { name }).first();

      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ delay: this.randomInt(35, 90) }).catch(() => {});
        await this.randomWait(250, 500);
        return;
      }
    }
  }

  private async findVisibleMicrophoneControl(
    settingsDialog: Locator
  ): Promise<Locator | undefined> {
    const namedControls = [
      settingsDialog.locator('[data-device-type="1"] button[aria-label*="microphone" i]').first(),
      settingsDialog.locator('[data-device-type="1"] button[aria-label*="micr" i]').first(),
      settingsDialog.locator('[data-device-type="1"] [role="button"][aria-haspopup="menu"]').first(),
      settingsDialog.locator('[data-device-type="1"] button').first(),
      settingsDialog.getByRole('combobox', { name: /microphone|micr/i }).first(),
      settingsDialog.locator('select[aria-label*="microphone" i]').first(),
      settingsDialog.locator('select[aria-label*="micr" i]').first(),
      settingsDialog.locator('[role="combobox"][aria-label*="microphone" i]').first(),
      settingsDialog.locator('[role="combobox"][aria-label*="micr" i]').first()
    ];

    for (const control of namedControls) {
      if (await control.isVisible().catch(() => false)) {
        return control;
      }
    }

    const genericComboboxes = settingsDialog.getByRole('combobox');
    const comboboxCount = Math.min(await genericComboboxes.count().catch(() => 0), 3);

    for (let index = 0; index < comboboxCount; index += 1) {
      const control = genericComboboxes.nth(index);

      if (await control.isVisible().catch(() => false)) {
        return control;
      }
    }

    const genericSelects = settingsDialog.locator('select');
    const selectCount = Math.min(await genericSelects.count().catch(() => 0), 3);

    for (let index = 0; index < selectCount; index += 1) {
      const control = genericSelects.nth(index);

      if (await control.isVisible().catch(() => false)) {
        return control;
      }
    }

    return undefined;
  }

  private async selectControlOption(
    control: Locator,
    preferredLabels: string[]
  ): Promise<string | undefined> {
    const tagName = await control.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');

    if (tagName === 'select') {
      const options = control.locator('option');
      const count = Math.min(await options.count().catch(() => 0), 20);

      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        const optionLabel = this.normalizeDeviceLabel(
          (await option.innerText().catch(() => '')) ||
          (await option.getAttribute('label').catch(() => null)) ||
          (await option.getAttribute('value').catch(() => null)) ||
          ''
        );

        if (!optionLabel || !this.matchesPreferredMicrophone(optionLabel, preferredLabels)) {
          continue;
        }

        await control.selectOption({ index }).catch(() => {});
        await this.randomWait(250, 500);
        return optionLabel;
      }

      return undefined;
    }

    await control.click({ delay: this.randomInt(35, 90) }).catch(() => {});
    await this.randomWait(250, 500);

    const option = await this.findVisibleOptionByLabel(preferredLabels);

    if (!option) {
      await this.page?.keyboard.press('Escape').catch(() => {});
      await this.randomWait(150, 300);
      return undefined;
    }

    const optionLabel = this.normalizeDeviceLabel(
      (await option.innerText().catch(() => '')) ||
      (await option.getAttribute('aria-label').catch(() => null)) ||
      ''
    );

    await option.click({ delay: this.randomInt(35, 90) }).catch(() => {});
    await this.randomWait(250, 500);

    return optionLabel || preferredLabels[0];
  }

  private async findVisibleOptionByLabel(preferredLabels: string[]): Promise<Locator | undefined> {
    if (!this.page) {
      return undefined;
    }

    for (const preferredLabel of preferredLabels) {
      const exactMatchPatterns = [
        this.page.getByRole('option', { name: new RegExp(this.escapeRegex(preferredLabel), 'i') }).first(),
        this.page.getByRole('menuitemradio', { name: new RegExp(this.escapeRegex(preferredLabel), 'i') }).first(),
        this.page.getByRole('button', { name: new RegExp(this.escapeRegex(preferredLabel), 'i') }).first()
      ];

      for (const locator of exactMatchPatterns) {
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    }

    const candidates = this.page.locator('[role="option"], [role="menuitemradio"], [data-value]');
    const count = Math.min(await candidates.count().catch(() => 0), 30);

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);

      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      const candidateLabel = this.normalizeDeviceLabel(
        (await candidate.innerText().catch(() => '')) ||
        (await candidate.getAttribute('aria-label').catch(() => null)) ||
        (await candidate.getAttribute('data-value').catch(() => null)) ||
        ''
      );

      if (candidateLabel && this.matchesPreferredMicrophone(candidateLabel, preferredLabels)) {
        return candidate;
      }
    }

    return undefined;
  }

  private async closeSettingsDialog(settingsDialog: Locator): Promise<void> {
    const closeButtonNames = ['Close', 'Done', 'Cerrar', 'Listo', 'Guardar', 'Back', 'Atras', 'Atrás'];

    for (const name of closeButtonNames) {
      const button = settingsDialog.getByRole('button', { name }).first();

      if (await button.isVisible().catch(() => false)) {
        await button.click({ delay: this.randomInt(35, 90) }).catch(() => {});
        await this.randomWait(250, 500);

        if (!(await settingsDialog.isVisible().catch(() => false))) {
          return;
        }
      }
    }

    const dialogBox = await settingsDialog.boundingBox().catch(() => null);

    if (dialogBox && this.page) {
      const topRightCloseX = Math.max(dialogBox.x + 16, dialogBox.x + dialogBox.width - 36);
      const topRightCloseY = dialogBox.y + 32;

      await this.page.mouse.click(topRightCloseX, topRightCloseY).catch(() => {});
      await this.randomWait(200, 350);

      if (!(await settingsDialog.isVisible().catch(() => false))) {
        return;
      }
    }

    await this.page?.keyboard.press('Escape').catch(() => {});
    await this.randomWait(150, 300);

    if (!(await settingsDialog.isVisible().catch(() => false))) {
      return;
    }

    await this.page?.mouse.click(24, 24).catch(() => {});
    await this.randomWait(150, 300);
  }

  private async readControlLabel(control: Locator): Promise<string | undefined> {
    const inputValue = await control.inputValue().catch(() => '');
    if (inputValue) {
      return inputValue;
    }

    const visibleLabel = await control
      .locator('[jsname="V67aGc"], .VfPpkd-vQzf8d')
      .first()
      .innerText()
      .catch(() => '');

    if (visibleLabel) {
      return visibleLabel;
    }

    const ariaLabel = await control.getAttribute('aria-label').catch(() => '');
    if (ariaLabel) {
      return ariaLabel;
    }

    const innerText = await control.innerText().catch(() => '');
    return innerText || undefined;
  }

  private classifyMicrophoneLabel(label: string): MicrophoneState {
    const normalized = label.trim().toLowerCase();

    if (
      /(turn on microphone|unmute microphone|microphone off|activar micr|encender micr|quitar silencio)/i.test(
        normalized
      )
    ) {
      return 'disabled';
    }

    if (
      /(turn off microphone|mute microphone|microphone on|silenciar micr|desactivar micr|apagar micr)/i.test(
        normalized
      )
    ) {
      return 'enabled';
    }

    return 'unknown';
  }

  private normalizeDeviceLabel(value: string): string {
    const repairedValue =
      /[ÃÂ]/.test(value) && value.length > 0
        ? Buffer.from(value, 'latin1').toString('utf8')
        : value;

    return repairedValue
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private includesNormalized(value: string, expected: string): boolean {
    return this.normalizeDeviceLabel(value).includes(this.normalizeDeviceLabel(expected));
  }

  private matchesPreferredMicrophone(value: string, expectedCandidates: string[]): boolean {
    return expectedCandidates.some((candidate) => this.includesNormalized(value, candidate));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
