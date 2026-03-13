export interface TranscriptSegment {
  text: string;
  speaker?: string;
  confidence?: number;
  startedAt?: string;
  endedAt?: string;
  language?: string;
}

export interface SpeechToTextProvider {
  transcribeFile(inputPath: string): Promise<TranscriptSegment[]>;
}
