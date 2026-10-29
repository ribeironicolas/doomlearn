import type { Beat } from "./agent.ts";
import type { WordBudget } from "./languages.ts";
import { alignerWords } from "./narration.ts";
import type { Angle } from "./schema.ts";

/**
 * What each Angle's body does after the 1-beat hook.
 */
export const RECIPES: Record<Angle, string> = {
  concrete_example: "Walk through one specific, realistic example step by step, then say the general idea it shows.",
  analogy: "Map the idea onto one familiar everyday thing, point by point, then say where the analogy breaks.",
  mechanism: "Explain how it works inside, step by step, each step causing the next.",
  contrast:
    "Set it against what it is most often confused with, or the alternative, and show what differs and why it matters.",
};

/**
 * A `{shown|spoken}` term: what the captions show and what the voice says.
 */
const TERM = /\{([^|}]+)\|([^}]+)\}/g;

/**
 * A whitespace-separated spoken token that reads as code: code punctuation, a call, snake_case,
 * lowerCamelCase or a dotted name.
 */
const CODE = /[`{}[\];=<>]|\p{L}\(|[\p{L}\d]_[\p{L}\d]|^\p{Ll}+\p{Lu}|\p{L}\.\p{L}/u;

/**
 * The deterministic checks a script must pass before verify: its Language's spoken-word budget `words` (enough to
 * explain the Concept, few enough to fit in 60 s), no run of 8 consecutive words copied from any Passage, and no code
 * read aloud. Returns what to fix, and whether the script is too long (which may end in a split).
 */
export function checkScript(beats: Beat[], passages: string[], words: WordBudget) {
  const speech = beats.map((beat) => beat.speech).join(" ");
  const spoken = speech.replace(TERM, "$2");
  const problems: string[] = [];

  const count = alignerWords(spoken).length;
  if (count > words.max) problems.push(`${count} spoken words, cut to at most ${words.max}`);
  if (count < words.min) problems.push(`${count} spoken words, write at least ${words.min}`);

  // Runs of 8 consecutive words (the shortest copy rejected), compared ignoring case and punctuation.
  const run = 8;
  /** Every run of `run` consecutive words in `text`. */
  const runs = (text: string) => {
    const words = alignerWords(text.toLowerCase());
    return words.slice(0, Math.max(0, words.length - run + 1)).map((_, i) => words.slice(i, i + run).join(" "));
  };
  const copied = new Set(passages.flatMap(runs));
  const copy = runs(speech.replace(TERM, "$1")).find((run) => copied.has(run));
  if (copy) problems.push(`copies "${copy}" from a Passage, say it in your own words`);

  const code = spoken.split(/\s+/).filter((token) => CODE.test(token));
  if (code.length) problems.push(`reads code aloud: ${code.join(", ")}, describe what it does instead`);

  return { problems, tooLong: count > words.max };
}

/**
 * `beats` as the captions show them: each `{shown|spoken}` term written as its shown text.
 */
export const shownBeats = (beats: Beat[]) =>
  beats.map((beat) => ({ ...beat, speech: beat.speech.replace(TERM, "$1") }));

/**
 * The script's `{shown|spoken}` terms the lexicon doesn't have yet, matched ignoring case.
 * A term the script writes in several capitalizations is one new term, under its first spelling.
 */
export function newTerms(beats: Beat[], lexicon: Record<string, string>) {
  const known = new Set(Object.keys(lexicon).map((term) => term.toLowerCase()));
  const terms: Record<string, string> = {};
  for (const beat of beats) {
    for (const [, shown, spoken] of beat.speech.matchAll(TERM)) {
      if (known.has(shown.toLowerCase())) continue;
      known.add(shown.toLowerCase());
      terms[shown] = spoken;
    }
  }
  return terms;
}
