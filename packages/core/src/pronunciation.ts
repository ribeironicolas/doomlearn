import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import type { Beat } from "./agent.ts";
import { type Data, readLexicon } from "./data.ts";
import { createInbox, openFlag } from "./inbox.ts";
import { writeJson } from "./json.ts";
import type { Language } from "./languages.ts";
import type { Media } from "./media.ts";
import { spokenChunks, TOKEN } from "./narration.ts";
import { clips, events, previews } from "./schema.ts";
import { publishStage, workerStatus } from "./status.ts";

/**
 * A word the Learner fixed in the sheet: the shown words they picked, and the Respelling the voice should say.
 */
export type Fix = { term: string; respelling: string };

/**
 * Thrown for a 🚩 that is not open, or a sentence, preview or Clip that does not exist.
 */
export class NotFound extends Error {}

/**
 * How long a preview's wav is kept when nobody fetches it: 1 h.
 */
const KEEP_MS = 3_600_000;

/**
 * The stage the worker publishes while it speaks a preview, and while it first loads the voice the preview needs.
 */
const STAGE = { preview: "preview", voice: "voice" };

/**
 * `lexicon` with each fix in it, replacing an entry for the same term in another capitalization.
 */
function withFixes(lexicon: Record<string, string>, fixes: Fix[]) {
  const fixed = { ...lexicon };
  for (const { term, respelling } of fixes) {
    for (const key of Object.keys(fixed)) if (key.toLowerCase() === term.toLowerCase()) delete fixed[key];
    fixed[term] = respelling;
  }
  return fixed;
}

/**
 * Fixing a pronunciation from a 🚩: the fix sheet's words, previews the worker speaks in the Clip's Language before
 * the Learner saves, and Save, which writes the fixes to that Language's Lexicon and regenerates the flagged Clip.
 */
export function createPronunciation(data: Data) {
  const { db, home, lexiconFile } = data;
  const inbox = createInbox(data);

  /**
   * The open 🚩 `eventId`'s Clip and note. Throws `NotFound` when it is not an open 🚩.
   */
  function flagged(eventId: number) {
    const flag = db
      .select({ clipId: clips.id, language: clips.language, script: clips.script, note: events.note })
      .from(events)
      .innerJoin(clips, eq(events.clipId, clips.id))
      .where(and(eq(events.id, eventId), openFlag))
      .get();
    if (!flag) throw new NotFound(`Event #${eventId} is not an open 🚩`);
    return { ...flag, beats: JSON.parse(flag.script) as Beat[] };
  }

  /**
   * The Lexicon of `language` as its file has it now; the last good one when the file is missing.
   * Throws `InvalidLexicon` when the file is not JSON.
   */
  const lexicon = (language: Language) => readLexicon(lexiconFile(language)) ?? data.lexicons[language];

  /**
   * A beat's tokens, each with the index of its sentence: a sentence ends after a token ending in `.`, `!` or `?`.
   */
  function tokens(beat: Beat) {
    let sentence = 0;
    return [...beat.speech.matchAll(TOKEN)].map((match) => {
      const token = { match, sentence };
      if (/[.!?]$/.test(match[0])) sentence++;
      return token;
    });
  }

  return {
    /**
     * What the fix sheet shows for the 🚩 `eventId`: the Clip's Language and the 🚩 note, the script's words as the
     * captions show them (a script's own `{shown|spoken}` term is one word, marked `markup`), each with its beat, its
     * sentence and the chunk of `says` it is in, and `says`: what the voice says now for each chunk, with the
     * Language's Lexicon.
     */
    sheet(eventId: number) {
      const { language, note, beats } = flagged(eventId);
      const chunks = spokenChunks(beats, lexicon(language));
      // The chunk each token of the script is in, in script order, as `spokenChunks` took them.
      const owners = chunks.flatMap((chunk, i) => Array<number>(chunk.tokens).fill(i));
      const words = beats
        .flatMap((beat, index) =>
          tokens(beat).map(({ match: [text, lead, shown, , trail], sentence }) => ({
            text: shown ? `${lead}${shown}${trail}` : text,
            beat: index,
            sentence,
            markup: Boolean(shown),
          })),
        )
        .map((word, i) => ({ ...word, chunk: owners[i] }));
      return { language, note, words, says: chunks.map((chunk) => chunk.spoken) };
    },

    /**
     * Queues a preview of sentence `at` of the 🚩 Clip `eventId`: what narration would say there with `fixes` and the
     * rest of the Clip's Language Lexicon. It supersedes the Clip's queued previews. Returns its id.
     */
    preview(eventId: number, at: { beat: number; sentence: number }, fixes: Fix[]) {
      const { clipId, language, beats } = flagged(eventId);
      const speech = tokens(beats[at.beat] ?? { speech: "", visual: "" })
        .filter((token) => token.sentence === at.sentence)
        .map((token) => token.match[0])
        .join(" ");
      if (!speech) throw new NotFound(`The Clip has no sentence ${at.sentence + 1} in beat ${at.beat + 1}`);
      const text = spokenChunks([{ speech, visual: "" }], withFixes(lexicon(language), fixes))
        .map((chunk) => chunk.spoken)
        .join(" ");
      return db.transaction((tx) => {
        tx.update(previews)
          .set({ status: "superseded" })
          .where(and(eq(previews.clipId, clipId), eq(previews.status, "queued")))
          .run();
        return tx.insert(previews).values({ clipId, language, text }).returning().get().id;
      });
    },

    /**
     * Where preview `id` is: its status and error; while queued, the Blocker that holds it (the worker stopped or
     * stopping, or a media problem in its Language), if any; and, while it waits or is spoken, whether the worker
     * is finishing a step first (a job's stage or another preview), taking it next (within its idle poll, 5 s),
     * loading the Language's voice, or speaking it.
     */
    poll(id: number) {
      const row = db.select().from(previews).where(eq(previews.id, id)).get();
      if (!row) throw new NotFound(`No preview #${id}`);
      const { status, error } = row;
      let blocker: string | null = null;
      let step: "waiting" | "next" | "loading" | "speaking" | null = null;
      const worker = workerStatus(data);
      if (status === "queued") {
        blocker =
          worker.blockers.find(
            (found) => found.kind === "stopped" || found.kind === "stopping" || found.languages?.includes(row.language),
          )?.reason ?? null;
        step = worker.job || worker.stage ? "waiting" : "next";
      }
      if (status === "speaking") {
        step = worker.stage === STAGE.voice ? "loading" : "speaking";
      }
      return { status, error, blocker, step };
    },

    /**
     * Preview `id`'s wav, once: the file is removed and the row marked played. `undefined` when it is not spoken yet,
     * or was played already.
     */
    takeWav(id: number) {
      const row = db
        .update(previews)
        .set({ status: "played" })
        .where(and(eq(previews.id, id), eq(previews.status, "done")))
        .returning()
        .get();
      if (!row) return;
      const wav = readFileSync(row.wavPath!);
      rmSync(row.wavPath!, { force: true });
      return wav;
    },

    /**
     * Writes `fixes` into the 🚩 Clip `eventId`'s Language Lexicon, read again first so hand edits are kept, then
     * queues the Clip's ↻ Regenerate (none when one is unfinished), which resolves the 🚩 once the remade Clip is in
     * place. Throws `InvalidLexicon` and writes nothing when the file is not JSON.
     */
    save(eventId: number, fixes: Fix[]) {
      const { language } = flagged(eventId);
      writeJson(lexiconFile(language), withFixes(lexicon(language), fixes));
      inbox.regenerate(eventId);
    },

    /**
     * The Languages of the queued previews, for the worker's media preflight.
     */
    languages() {
      return db
        .selectDistinct({ language: previews.language })
        .from(previews)
        .where(eq(previews.status, "queued"))
        .all()
        .map((row) => row.language);
    },

    /**
     * The worker's side: speaks every queued preview in `languages` (those the media preflight checked), oldest
     * first, into `<home>/previews/<id>.wav`. One whose Language a media problem `held` fails with that problem as its
     * error. While it speaks, it publishes a preview stage, or a voice stage when the TTS is `loading` the Language's
     * voice first, for `poll` to read. The stage has no job, so the Worker status still shows the worker idle.
     */
    async serve(
      media: Media,
      {
        languages,
        held,
        loading,
      }: {
        languages: Language[];
        held: (language: Language) => string | undefined;
        loading: (language: Language) => boolean;
      },
    ) {
      for (;;) {
        const row = db
          .update(previews)
          .set({ status: "speaking" })
          .where(
            eq(
              previews.id,
              db
                .select({ id: previews.id })
                .from(previews)
                .where(and(eq(previews.status, "queued"), inArray(previews.language, languages)))
                .orderBy(asc(previews.id))
                .limit(1),
            ),
          )
          .returning()
          .get();
        if (!row) return;
        const { language } = row;
        const problem = held(language);
        if (problem) {
          db.update(previews).set({ status: "failed", error: problem }).where(eq(previews.id, row.id)).run();
          continue;
        }
        const dir = join(home, "previews");
        mkdirSync(dir, { recursive: true });
        const wavPath = join(dir, `${row.id}.wav`);
        publishStage(data, {
          jobId: null,
          stage: loading(language) ? STAGE.voice : STAGE.preview,
          startedAt: new Date(),
        });
        try {
          await media.speak(row.text, wavPath, language);
          db.update(previews).set({ status: "done", wavPath }).where(eq(previews.id, row.id)).run();
        } catch (error) {
          db.update(previews)
            .set({ status: "failed", error: String(error) })
            .where(eq(previews.id, row.id))
            .run();
        } finally {
          publishStage(data, null);
        }
      }
    },

    /**
     * The worker's side: removes the wavs of previews over 1 h old that nobody fetched, marking them played. At
     * `startup`, a preview a crashed worker left speaking is queued again, or failed when it is over 1 h old.
     */
    sweep({ startup }: { startup: boolean }) {
      const kept = new Date(Date.now() - KEEP_MS);
      if (startup) {
        db.update(previews)
          .set({ status: "queued" })
          .where(and(eq(previews.status, "speaking"), gt(previews.createdAt, kept)))
          .run();
        db.update(previews)
          .set({ status: "failed", error: "The worker restarted" })
          .where(eq(previews.status, "speaking"))
          .run();
      }
      const old = db
        .update(previews)
        .set({ status: "played" })
        .where(and(eq(previews.status, "done"), lt(previews.createdAt, kept)))
        .returning()
        .all();
      for (const row of old) rmSync(row.wavPath!, { force: true });
    },
  };
}
