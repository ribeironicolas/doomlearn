import type { Anchor, Angle } from "./schema.ts";
import type { Language, WordBudget } from "./languages.ts";
import type { Word } from "./media.ts";

/**
 * One narrated beat of a Clip script: what is said and what is shown.
 */
export type Beat = { speech: string; visual: string };

/**
 * Typed input and structured output of each agent stage.
 */
export type AgentStages = {
  extract: {
    /** `title` is the chapter's, which a chapter anchor names. */
    input: { title: string; chapter: string; concepts: { id: number; title: string; summary: string }[] };
    output: {
      new: { title: string; summary: string; angles: Angle[]; anchor: Anchor }[];
      attach: { conceptId: number; anchor: Anchor }[];
    };
  };
  script: {
    input: {
      concept: { title: string; summary: string };
      passages: string[];
      angle: Angle;
      /** What the Angle's body does after the 1-beat hook. */
      recipe: string;
      words: WordBudget;
      /** Terms the voice already says right, so they need no `{shown|spoken}`. */
      lexicon: string[];
      /** Set when the last script failed a check, verify or the 60 s gate, e.g. "cut 12.4 s". */
      feedback?: string;
    };
    output: { beats: Beat[] };
  };
  /** A Translation: an existing Clip's beats said in the job's Language, with the script's word budget and checks. */
  translate: {
    input: {
      /** The source Clip's Language, as the prompts name it. */
      from: string;
      /** The source Clip's beats, each `{shown|spoken}` term written as its shown text. */
      beats: Beat[];
      passages: string[];
      words: WordBudget;
      /** Terms the voice of the job's Language already says right. */
      lexicon: string[];
      /** Set when the last translation failed a check, verify or the 60 s gate. */
      feedback?: string;
    };
    output: { beats: Beat[] };
  };
  verify: {
    input: { passages: string[]; beats: Beat[] };
    output: { ok: boolean; problems: string[] };
  };
  split: {
    /** `feedback` is why the last script was still too long. */
    input: { concept: { title: string; summary: string }; passages: string[]; feedback: string };
    /** 2–3 smaller Concepts, each taught by the same Passages. */
    output: { concepts: { title: string; summary: string; angles: Angle[] }[] };
  };
  scene: {
    /** `fix` re-sends the previous scene with why it didn't compile or render. */
    input: { beats: Beat[]; words: Word[]; fix?: { tsx: string; error: string } };
    output: { tsx: string };
  };
};

export type AgentResult<T> =
  | { ok: true; output: T }
  | {
      ok: false;
      error: string;
      /**
       * Set when rate-limited: the whole queue waits until then, and the attempt isn't counted.
       */
      retryAt?: Date;
    };

/**
 * Port to the model: one call per stage, returning typed structured output or a typed failure. `served` names the job
 * the call serves and, for a Clip job, its Language, which the script, translate, verify and scene prompts are written
 * for (pt-BR when absent).
 */
export type Agent = {
  run<S extends keyof AgentStages>(
    stage: S,
    input: AgentStages[S]["input"],
    served: { jobId: number; language?: Language },
  ): Promise<AgentResult<AgentStages[S]["output"]>>;
};
