export interface PlayAudioOptions {
  wavPath: string;
  text: string;
}

export interface AudioOutputProvider {
  play(options: PlayAudioOptions): Promise<{ durationMs: number }>;
}