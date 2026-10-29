/**
 * Types for the parts of the vendored synth src/render.ts uses; times are in seconds.
 */
export type Soundtrack = { sampleRate: number; length: number; numberOfChannels: number; getChannelData(channel: number): Float32Array };

export function renderSoundtrack(options: {
  duration: number;
  voiceSpans?: { start: number; end: number }[];
  music?: { style: string; volume?: number };
  sfx?: { name: string; t: number; gain?: number }[];
}): Promise<Soundtrack>;

export function encodeWav(buffer: Soundtrack): ArrayBuffer;
