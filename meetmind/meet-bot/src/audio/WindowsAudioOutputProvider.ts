import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioOutputProvider, PlayAudioOptions } from './AudioOutputProvider.js';

const execFileAsync = promisify(execFile);

export class WindowsAudioOutputProvider implements AudioOutputProvider {
  private readonly powershellPath: string;

  constructor(options?: { powershellPath?: string }) {
    this.powershellPath =
      options?.powershellPath ??
      process.env.POWERSHELL_PATH ??
      'powershell.exe';
  }

  async play(options: PlayAudioOptions): Promise<{ durationMs: number }> {
    await fs.access(options.wavPath);

    const startedAt = Date.now();
    const escapedPath = options.wavPath.replaceAll("'", "''");

    await execFileAsync(this.powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$player = New-Object System.Media.SoundPlayer '${escapedPath}'; $player.PlaySync();`
    ]);

    return {
      durationMs: Date.now() - startedAt
    };
  }
}
