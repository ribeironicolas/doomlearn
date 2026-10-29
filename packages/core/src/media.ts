import type { Language } from "./languages.ts";

/**
 * A chapter of converted Source text. In a PDF chapter, a line `<!-- page N -->` starts each page,
 * so a Passage can be sliced by page range.
 */
export type Chapter = { title: string; text: string };

/**
 * A Source converted to chapters, with the title from its metadata when it has one.
 */
export type Converted = { title?: string; chapters: Chapter[] };

/**
 * Why a request was refused: a Source at add (scanned, DRM, duplicate; nothing of it is stored), a pause of a Retired
 * Concept, a pause or resume of a Deleted chapter or Concept, or a Translation of a Deleted Concept's Clip.
 */
export class Refused extends Error {}

/**
 * Why a scene failed to compile or render: its own code broke, so the scene agent can fix it.
 * Any other render error is the harness's.
 */
export class SceneError extends Error {}

/**
 * A word (spoken by the aligner, shown in a Narration) and where it sits in the narration audio.
 */
export type Word = { word: string; startMs: number; endMs: number };

/**
 * The spoken audio of a script and its timings: each shown Word, and each beat's span (`beats[i]` is beat i),
 * both from the same mapping, so the render never counts a beat's Words again.
 */
export type Narration = {
  audio: string;
  durationMs: number;
  words: Word[];
  beats: { startMs: number; endMs: number }[];
};

/**
 * Port to local media tools: Source conversion, TTS + alignment, and render + mix.
 */
export type Media = {
  /**
   * Splits a Source into chapters, text before the first one titled `name` (the file's name unless given).
   * Throws `Refused` for a scanned PDF or a DRM'd ebook.
   */
  convert(file: string, name?: string): Promise<Converted>;
  /**
   * Speaks `text` in `language`, with that Language's voice, into the wav at `out`.
   * The duration is measured from the written audio.
   */
  speak(text: string, out: string, language: Language): Promise<{ durationMs: number }>;
  /**
   * Times each word of `text` in `audio`, spoken in `language`, split into words the way the aligner splits them.
   */
  align(audio: string, text: string, language: Language): Promise<Word[]>;
  /**
   * Writes the finished mp4. Throws `SceneError` when the scene doesn't compile or render;
   * any other error (the work folder, the soundtrack, the mix) propagates unchanged and means the harness failed.
   */
  render(scene: { tsx: string; narration: Narration }, out: string): Promise<void>;
};
