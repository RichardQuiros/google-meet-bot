import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TtsBackend = 'piper' | 'windows-native';

export interface TtsResult {
  wavPath: string;
  text: string;
  backend: TtsBackend;
}

export interface SynthesizeSpeechOptions {
  text: string;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface TtsDebugConfig {
  backend: TtsBackend;
  outputDir: string;
  inputDir: string;
  piperPath?: string;
  modelPath?: string;
  powershellPath?: string;
}

export class TtsService {
  private readonly outputDir: string;
  private readonly inputDir: string;
  private readonly piperPath: string;
  private readonly modelPath: string;
  private readonly powershellPath: string;
  private readonly backend: TtsBackend;

  constructor(options?: {
    outputDir?: string;
    inputDir?: string;
    piperPath?: string;
    modelPath?: string;
    powershellPath?: string;
    backend?: TtsBackend;
  }) {
    this.outputDir =
      options?.outputDir ?? process.env.TTS_OUTPUT_DIR ?? path.resolve(process.cwd(), 'tmp', 'tts');
    this.inputDir =
      options?.inputDir ?? process.env.TTS_INPUT_DIR ?? path.resolve(process.cwd(), 'tmp', 'tts-input');
    this.piperPath = options?.piperPath ?? process.env.PIPER_PATH ?? 'piper';
    this.modelPath = options?.modelPath ?? process.env.PIPER_MODEL ?? '';
    this.powershellPath =
      options?.powershellPath ?? process.env.POWERSHELL_PATH ?? 'powershell.exe';
    this.backend = this.resolveBackend(options?.backend ?? process.env.TTS_BACKEND);
  }

  getDebugConfig(): TtsDebugConfig {
    return {
      backend: this.backend,
      outputDir: this.outputDir,
      inputDir: this.inputDir,
      piperPath: this.backend === 'piper' ? this.piperPath : undefined,
      modelPath: this.modelPath || undefined,
      powershellPath:
        this.backend === 'windows-native' ? this.powershellPath : undefined
    };
  }

  async synthesizeToWav(input: string | SynthesizeSpeechOptions): Promise<TtsResult> {
    const options = typeof input === 'string' ? { text: input } : input;
    const text = options.text.trim();

    if (!text) {
      throw new Error('Text is required for TTS synthesis');
    }

    await fs.mkdir(this.outputDir, { recursive: true });
    await fs.mkdir(this.inputDir, { recursive: true });

    const id = `${Date.now()}-${randomUUID()}`;
    const inputPath = path.join(this.inputDir, `${id}.txt`);
    const wavPath = path.join(this.outputDir, `${id}.wav`);

    await fs.writeFile(inputPath, text, 'utf8');

    if (this.backend === 'windows-native') {
      await this.runWindowsNativeTts(inputPath, wavPath, options);
    } else {
      if (!this.modelPath) {
        throw new Error('PIPER_MODEL is required');
      }

      await this.runPiper(wavPath, text);
    }

    return {
      wavPath,
      text,
      backend: this.backend
    };
  }

  private async runPiper(wavPath: string, text: string): Promise<void> {
    const resolvedPiperPath = await this.resolvePiperPath();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        resolvedPiperPath,
        ['--model', this.modelPath, '--output_file', wavPath],
        {
          env: { ...process.env },
          stdio: ['pipe', 'ignore', 'pipe']
        }
      );

      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `Unable to start Piper from "${resolvedPiperPath}". Set PIPER_PATH to the Piper executable or set TTS_BACKEND=windows-native for local Windows testing.`
            )
          );
          return;
        }

        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `piper exited with code ${code ?? 'unknown'}`));
      });

      child.stdin.write(text);
      child.stdin.end();
    });
  }

  private async runWindowsNativeTts(
    inputPath: string,
    wavPath: string,
    options: SynthesizeSpeechOptions
  ): Promise<void> {
    const command = this.buildWindowsNativeCommand(inputPath, wavPath, options);

    try {
      await execFileAsync(this.powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Unable to start PowerShell from "${this.powershellPath}". Set POWERSHELL_PATH to powershell.exe or switch TTS_BACKEND back to piper.`
        );
      }

      throw error;
    }
  }

  private buildWindowsNativeCommand(
    inputPath: string,
    wavPath: string,
    options: SynthesizeSpeechOptions
  ): string {
    const rate = this.normalizeWindowsRate(options.rate);
    const volume = this.normalizeWindowsVolume(options.volume);
    const voiceSelection = options.voice
      ? `$synth.SelectVoice('${this.escapePowerShellString(options.voice)}')`
      : '';

    return [
      'Add-Type -AssemblyName System.Speech',
      `$text = [System.IO.File]::ReadAllText('${this.escapePowerShellString(inputPath)}')`,
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'try {',
      voiceSelection,
      `$synth.Rate = ${rate}`,
      `$synth.Volume = ${volume}`,
      `$synth.SetOutputToWaveFile('${this.escapePowerShellString(wavPath)}')`,
      '$synth.Speak($text)',
      '} finally {',
      '  if ($null -ne $synth) {',
      '    $synth.Dispose()',
      '  }',
      '}'
    ]
      .filter(Boolean)
      .join('; ');
  }

  private resolveBackend(requestedBackend?: string): TtsBackend {
    const normalized = requestedBackend?.trim().toLowerCase();

    if (normalized === 'windows-native' || normalized === 'native-windows') {
      return 'windows-native';
    }

    if (normalized === 'piper') {
      return 'piper';
    }

    if (process.platform === 'win32' && !this.modelPath) {
      return 'windows-native';
    }

    return 'piper';
  }

  private async resolvePiperPath(): Promise<string> {
    if (!this.piperPath) {
      return process.platform === 'win32' ? 'piper.exe' : 'piper';
    }

    const looksLikePath =
      path.isAbsolute(this.piperPath) ||
      this.piperPath.includes(path.sep) ||
      this.piperPath.includes('/');

    if (!looksLikePath) {
      return this.piperPath;
    }

    try {
      const stat = await fs.stat(this.piperPath);

      if (stat.isDirectory()) {
        return path.join(
          this.piperPath,
          process.platform === 'win32' ? 'piper.exe' : 'piper'
        );
      }
    } catch {
      return this.piperPath;
    }

    return this.piperPath;
  }

  private normalizeWindowsRate(rate?: number): number {
    if (typeof rate !== 'number' || Number.isNaN(rate)) {
      return 0;
    }

    if (rate >= -10 && rate <= 10) {
      return Math.round(rate);
    }

    return Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)));
  }

  private normalizeWindowsVolume(volume?: number): number {
    if (typeof volume !== 'number' || Number.isNaN(volume)) {
      return 100;
    }

    if (volume >= 0 && volume <= 1) {
      return Math.round(volume * 100);
    }

    return Math.max(0, Math.min(100, Math.round(volume)));
  }

  private escapePowerShellString(value: string): string {
    return value.replaceAll("'", "''");
  }
}
