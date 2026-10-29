/**
 * The Languages doomlearn can narrate, time and draw a Clip in, keyed by BCP 47 tag. The config enum, the prompts,
 * the TTS and align requests, the Lexicon files and the script's word budget all read this table, so a new
 * Language is one row here plus a sample.
 * - `name`: the English name the UI and the prompts use.
 * - `tts`: the Chatterbox checkpoint (the pt-br pack, or Multilingual V3), its `language_id`, and whether the text is
 *   NFKD-normalized first, as V3's own tokenizer does.
 * - `aligner`: the language name Qwen3-ForcedAligner takes; it only picks the word splitter.
 * - `words`: the spoken-word budget of a script.
 * - `lexicon`: the Learner's Lexicon file in the data folder, and the repo file (in this package) it starts from.
 * - `prompt`: how the script, verify and scene prompts name the Language, in full and short, and the Respelling rule
 *   for English terms: the Language's letter names and two examples. A Language with no rule (English) has its
 *   scripts write numbers as words instead.
 */
export const LANGUAGES = {
  "pt-BR": {
    name: "Portuguese",
    tts: { checkpoint: "pt-br", languageId: "pt", nfkd: false },
    aligner: "Portuguese",
    words: { min: 85, max: 175 },
    // Shown term → what the PT-BR voice says instead: English terms get Brazilian-dev respellings, acronyms get
    // Portuguese letter names with the last one stressed. Matched as whole words, ignoring case. Tunable by
    // ear; to share a tuned term, copy it into lexicon.default.json by hand.
    lexicon: { file: "lexicon.json", default: "lexicon.default.json" },
    prompt: {
      name: "Brazilian Portuguese",
      short: "PT-BR",
      respelling: {
        letters: "Portuguese letter names, stressing the last",
        examples: ["{garbage collector|gár bitch colétor}", "{GC|gê cê}"],
      },
    },
  },
  en: {
    name: "English",
    tts: { checkpoint: "v3", languageId: "en", nfkd: true },
    aligner: "English",
    // English is spoken faster, so it needs more words to fill a Clip.
    words: { min: 85, max: 200 },
    lexicon: { file: "lexicon.en.json", default: "lexicon.en.default.json" },
    prompt: { name: "English", short: "English", respelling: null },
  },
  es: {
    name: "Spanish",
    tts: { checkpoint: "v3", languageId: "es", nfkd: true },
    aligner: "Spanish",
    words: { min: 85, max: 175 },
    lexicon: { file: "lexicon.es.json", default: "lexicon.es.default.json" },
    prompt: {
      name: "Spanish",
      short: "Spanish",
      respelling: { letters: "Spanish letter names", examples: ["{garbage collector|gárbich coléctor}", "{GC|ge ce}"] },
    },
  },
} as const;

/**
 * A Language's BCP 47 tag.
 */
export type Language = keyof typeof LANGUAGES;

/**
 * A script's spoken-word budget, as a row's `words` holds it.
 */
export type WordBudget = { min: number; max: number };

/**
 * Every Language's tag, in the table's order.
 */
export const LANGUAGE_TAGS = Object.keys(LANGUAGES) as [Language, ...Language[]];

/**
 * The repo's default Lexicon of `language`, which seeds and tops up the Learner's file in the data folder.
 */
export const defaultLexicon = (language: Language) =>
  new URL(`../${LANGUAGES[language].lexicon.default}`, import.meta.url);
