import { TtsService, type SynthesizeSpeechOptions } from '../audio/TtsService.js';
import type { AudioOutputProvider } from '../audio/AudioOutputProvider.js';

export type SpeakOptions = SynthesizeSpeechOptions;

export class SpeechOutputService {
  constructor(
    private readonly ttsService: TtsService,
    private readonly audioOutputProvider: AudioOutputProvider
  ) {}

  getDebugConfig(): Record<string, unknown> {
    return {
      tts: this.ttsService.getDebugConfig(),
      audioOutputProvider: this.audioOutputProvider.constructor.name
    };
  }

  async speak(
    options: SpeakOptions
  ): Promise<{ durationMs: number; wavPath: string; backend: string }> {
    const tts = await this.ttsService.synthesizeToWav(options);

    const playback = await this.audioOutputProvider.play({
      wavPath: tts.wavPath,
      text: options.text
    });

    return {
      durationMs: playback.durationMs,
      wavPath: tts.wavPath,
      backend: tts.backend
    };
  }
}
