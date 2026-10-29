import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Beat } from "./agent.ts";
import type { Language } from "./languages.ts";
import type { Media, Narration } from "./media.ts";
import { splitPunctuation } from "./respelling.ts";

/**
 * Splits text into words the way Qwen3-ForcedAligner does for space-separated languages:
 * split on whitespace, keep only letters, digits and apostrophes, drop what's left empty.
 */
export function alignerWords(text: string) {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}']/gu, ""))
    .filter(Boolean);
}

/**
 * One token of a beat's speech: a script's `{shown|spoken}` term with any punctuation around it, or a plain
 * whitespace-separated token. Groups: lead, shown term, spoken term, trail.
 */
export const TOKEN = /(\S*?)\{([^|}]+)\|([^}]+)\}(\S*)|\S+/gu;

/**
 * What the voice says for each shown chunk of `beats`, with the beat it is in, its count of aligner words and how many
 * `TOKEN`s of the speech it took.
 * A `lexicon` term (whole words, ignoring case, longest first) is said as its Respelling, and so is a script's own
 * `{shown|spoken}` term whose shown text, without the punctuation around it, is a `lexicon` key: the Learner's fix wins
 * over the script's. Any other `{shown|spoken}` term is said as the script wrote it.
 * The chunks' `tokens` add up to every `TOKEN` of `beats`, in order: the fix sheet maps each word to its chunk by them.
 */
export function spokenChunks(beats: Beat[], lexicon: Record<string, string>) {
  const terms = Object.keys(lexicon)
    .map((term) => term.split(" "))
    .sort((a, b) => b.length - a.length);
  const keys = new Map(Object.keys(lexicon).map((term) => [term.toLowerCase(), term]));
  // Each token also carries the index of the beat it is in.
  const tokens = beats.flatMap((beat, index) =>
    [...beat.speech.matchAll(TOKEN)].map((match) => Object.assign(match, { beat: index })),
  );
  const chunks: { shown: string; spoken: string; count: number; beat: number; tokens: number }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const [, lead, shownTerm, spokenTerm, trail] = tokens[i];
    const { beat } = tokens[i];
    // The longest lexicon term whose words are the plain tokens starting here.
    const term = shownTerm
      ? undefined
      : terms.find((words) =>
          words.every(
            (word, k) =>
              tokens[i + k] &&
              !tokens[i + k][2] &&
              splitPunctuation(tokens[i + k][0]).word.toLowerCase() === word.toLowerCase(),
          ),
        );
    const taken = tokens.slice(i, i + (term?.length ?? 1)).map((match) => match[0]);
    i += taken.length;
    let shown = taken.join(" ");
    let spoken = shown;
    if (shownTerm) {
      shown = `${lead}${shownTerm}${trail}`;
      const bare = splitPunctuation(shown);
      const key = keys.get(bare.word.toLowerCase());
      spoken = key ? `${bare.lead}${lexicon[key]}${bare.trail}` : `${lead}${spokenTerm}${trail}`;
    }
    if (term)
      spoken = `${splitPunctuation(taken[0]).lead}${lexicon[term.join(" ")]}${splitPunctuation(taken.at(-1)!).trail}`;
    const count = alignerWords(spoken).length;
    // A token with no words (a lone dash) is shown with the word before it.
    const before = chunks.at(-1);
    if (!count && before) {
      before.shown += ` ${shown}`;
      before.spoken += ` ${spoken}`;
      before.tokens += taken.length;
    } else chunks.push({ shown, spoken, count, beat, tokens: taken.length });
  }
  return chunks;
}

/**
 * Speaks beats in `language` into `dir` and times each shown word, saying what `spokenChunks` gives for `lexicon`.
 * Each shown chunk is timed by the span of the spoken words it became, and each beat by the span of its chunks.
 * That mapping needs the aligner's word list to be ours word for word, so a mismatch redoes the TTS once.
 */
export async function narrate(
  media: Media,
  beats: Beat[],
  dir: string,
  lexicon: Record<string, string>,
  language: Language,
): Promise<Narration> {
  const chunks = spokenChunks(beats, lexicon);
  // Each beat needs a spoken Word of its own to have a span: one saying only a dash, or whose words a lexicon term
  // from the beat before took, has none, so it fails here instead of as a missing span in the render.
  const silent = beats.findIndex((_, index) => !chunks.some((chunk) => chunk.beat === index && chunk.count));
  if (silent !== -1) throw new Error(`Beat ${silent + 1} has no spoken word of its own to time`);

  const text = chunks.map((chunk) => chunk.spoken).join(" ");
  const audio = join(dir, "narration.wav");
  for (let attempt = 1; ; attempt++) {
    const { durationMs } = await media.speak(text, audio, language);
    const aligned = await media.align(audio, text, language);
    if (
      isDeepStrictEqual(
        aligned.map((word) => word.word),
        alignerWords(text),
      )
    ) {
      let at = 0;
      const spans: Narration["beats"] = [];
      const words = chunks.flatMap((chunk) => {
        const span = aligned.slice(at, at + chunk.count);
        at += chunk.count;
        if (!span.length) return [];
        const word = { word: chunk.shown, startMs: span[0].startMs, endMs: span.at(-1)!.endMs };
        spans[chunk.beat] = { startMs: spans[chunk.beat]?.startMs ?? word.startMs, endMs: word.endMs };
        return [word];
      });
      return { audio, durationMs, words, beats: spans };
    }
    // The first attempt plus one redo.
    if (attempt === 2)
      throw new Error(
        `Aligner words still differ from the spoken words after a TTS redo: ${aligned.map((word) => word.word).join(" ")}`,
      );
  }
}
