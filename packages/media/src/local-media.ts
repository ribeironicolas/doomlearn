import { LANGUAGES } from "@doomlearn/core/languages";
import type { Media } from "@doomlearn/core/media";
import { convert } from "./convert.ts";
import { render } from "./render.ts";
import { serverTool } from "./tools.ts";

/**
 * The real Media port on the `tts` and `align` runtimes given (tests pass fake tool processes). Each request carries the
 * Clip's Language as its Languages table row says: the voice for TTS, the aligner's language name for alignment.
 * `stop()` ends both runtimes and resolves once both have exited.
 */
export function createLocalMedia(
  tts = serverTool("tts"),
  aligner = serverTool("align"),
): Media & { stop(): Promise<void> } {
  return {
    convert,
    speak: (text, out, language) => tts({ text, out, language: LANGUAGES[language].tts }),
    align: async (audio, text, language) =>
      (await aligner({ audio, text, language: LANGUAGES[language].aligner })).words,
    render,
    stop: async () => {
      await Promise.all([tts.stop(), aligner.stop()]);
    },
  };
}

/**
 * The real Media port on the local runtimes, started on first use.
 */
export const localMedia = createLocalMedia();
