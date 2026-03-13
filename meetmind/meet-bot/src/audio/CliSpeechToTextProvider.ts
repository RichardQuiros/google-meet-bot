import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpeechToTextProvider, TranscriptSegment } from './SpeechToTextProvider.js';

const execAsync = promisify(exec);

type CliSpeechToTextProviderOptions = {
  commandTemplate?: string;
  outputFormat?: 'json' | 'text';
  defaultSpeaker?: string;
  shell?: string;
  cwd?: string;
};

export class CliSpeechToTextProvider implements SpeechToTextProvider {
  private readonly commandTemplate: string;
  private readonly outputFormat: 'json' | 'text';
  private readonly defaultSpeaker: string;
  private readonly shell?: string;
  private readonly cwd?: string;

  constructor(options: CliSpeechToTextProviderOptions = {}) {
    this.commandTemplate =
      options.commandTemplate ??
      process.env.STT_COMMAND ??
      this.getBundledCommandTemplate();
    this.outputFormat =
      options.outputFormat ?? (process.env.STT_OUTPUT_FORMAT as 'json' | 'text') ?? 'json';
    this.defaultSpeaker = options.defaultSpeaker ?? process.env.STT_DEFAULT_SPEAKER ?? 'Unknown speaker';
    this.shell = options.shell ?? process.env.STT_SHELL;
    this.cwd = options.cwd ?? process.env.STT_CWD;
  }

  isConfigured(): boolean {
    return Boolean(this.commandTemplate.trim());
  }

  async transcribeFile(inputPath: string): Promise<TranscriptSegment[]> {
    if (!this.commandTemplate) {
      throw new Error('STT_COMMAND is required when audio input is enabled');
    }

    const command = this.commandTemplate.replaceAll('{input}', this.quoteShellArg(inputPath));
    const { stdout } = await execAsync(command, {
      cwd: this.cwd,
      env: { ...process.env },
      shell: this.shell,
      maxBuffer: 20 * 1024 * 1024
    });

    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    return this.outputFormat === 'json'
      ? this.parseJsonSegments(trimmed)
      : this.parseTextSegments(trimmed);
  }

  private parseJsonSegments(raw: string): TranscriptSegment[] {
    const parsed = JSON.parse(raw) as
      | TranscriptSegment[]
      | {
          text?: string;
          speaker?: string;
          confidence?: number;
          language?: string;
          segments?: Array<Record<string, unknown>>;
        };

    if (Array.isArray(parsed)) {
      return parsed.map((segment) => this.normalizeSegment(segment));
    }

    if (Array.isArray(parsed.segments)) {
      return parsed.segments
        .map((segment) => this.normalizeSegment(segment))
        .filter((segment) => segment.text);
    }

    if (parsed.text) {
      return [
        this.normalizeSegment({
          text: parsed.text,
          speaker: parsed.speaker,
          confidence: parsed.confidence,
          language: parsed.language
        })
      ];
    }

    return [];
  }

  private parseTextSegments(raw: string): TranscriptSegment[] {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({
        text,
        speaker: this.defaultSpeaker
      }));
  }

  private normalizeSegment(segment: Record<string, unknown> | TranscriptSegment): TranscriptSegment {
    const candidate = segment as Record<string, unknown>;
    const text = this.getString(segment.text) ?? '';

    return {
      text,
      speaker: this.getString(segment.speaker) ?? this.defaultSpeaker,
      confidence: this.getNumber(segment.confidence) ?? this.getNumber(candidate.probability),
      startedAt: this.getString(segment.startedAt) ?? this.getString(candidate.start),
      endedAt: this.getString(segment.endedAt) ?? this.getString(candidate.end),
      language: this.getString(segment.language)
    };
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private quoteShellArg(value: string): string {
    if (process.platform === 'win32') {
      return `"${value.replaceAll('"', '""')}"`;
    }

    return `'${value.replaceAll("'", "'\"'\"'")}'`;
  }

  private getBundledCommandTemplate(): string {
    const bundledScriptPath = path.resolve(process.cwd(), 'scripts', 'faster_whisper_transcribe.py');
    if (!fs.existsSync(bundledScriptPath)) {
      return '';
    }

    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    return `${pythonCommand} ${this.quoteShellArg(bundledScriptPath)} {input}`;
  }
}
