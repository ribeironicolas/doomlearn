import { and, count, eq, gte, ne } from "drizzle-orm";
import type { Data } from "./data.ts";
import { LANGUAGE_TAGS, LANGUAGES, type Language } from "./languages.ts";
import { deletedConcept } from "./live.ts";
import { Refused } from "./media.ts";
import { NotFound } from "./pronunciation.ts";
import { clips, concepts, JOB_PRIORITY, jobs } from "./schema.ts";
import { workerStatus } from "./status.ts";

/**
 * Thrown for a Translation into a Language the Clip's Concept and Angle already have a Clip in.
 */
export class AlreadyMade extends Error {}

type Clip = typeof clips.$inferSelect;

/**
 * Make in <Language>: the 🌐 sheet of a Clip, and queueing a Translation of it. The worker makes one only when asked.
 */
export function createTranslations(data: Data) {
  const { db, config } = data;

  /**
   * Clip `clipId`. Throws `NotFound` when there is none.
   */
  const clipOf = (clipId: number) => {
    const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
    if (!clip) throw new NotFound(`No Clip #${clipId}`);
    return clip;
  };

  /**
   * The Clip of `clip`'s Concept and Angle in `language`, if there is one.
   */
  const madeIn = (clip: Clip, language: Language) =>
    db
      .select({ clipId: clips.id, file: clips.file, angle: clips.angle })
      .from(clips)
      .where(and(eq(clips.conceptId, clip.conceptId), eq(clips.angle, clip.angle), eq(clips.language, language)))
      .get();

  /**
   * The translate job not done yet for `clip`'s Concept and Angle in `language`, if there is one.
   */
  const unfinished = (clip: Clip, language: Language) =>
    db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, "translate"),
          eq(jobs.conceptId, clip.conceptId),
          eq(jobs.angle, clip.angle),
          eq(jobs.language, language),
          ne(jobs.status, "done"),
        ),
      )
      .get();

  return {
    /**
     * The 🌐 sheet of Clip `clipId`: its Concept, and every other Language with its Clip of this Concept and Angle
     * once made, else its unfinished translate job, whether the daily Clip cap holds it, and the Blocker that holds it
     * (a Blocker naming Languages holds only those).
     */
    sheet(clipId: number) {
      const clip = clipOf(clipId);
      const concept = db.select({ title: concepts.title }).from(concepts).where(eq(concepts.id, clip.conceptId)).get()!;
      const [{ today }] = db
        .select({ today: count() })
        .from(clips)
        .where(gte(clips.createdAt, new Date(new Date().setHours(0, 0, 0, 0))))
        .all();
      // The same count and test as the worker's tick() in pipeline.ts: change both together.
      const capped = today >= config().worker.dailyClipCap;
      const { blockers } = workerStatus(data);
      return {
        concept,
        languages: LANGUAGE_TAGS.filter((language) => language !== clip.language).map((language) => {
          const made = madeIn(clip, language) ?? null;
          const job = made ? undefined : unfinished(clip, language);
          const blocker = job && blockers.find((found) => !found.languages || found.languages.includes(language));
          return {
            language,
            name: LANGUAGES[language].name,
            made,
            job: job ? { id: job.id, status: job.status } : null,
            capped,
            blocker: blocker ? { reason: blocker.reason, until: blocker.until } : null,
          };
        }),
      };
    },

    /**
     * Queues a Translation of Clip `clipId` into `language`, for the same Concept and Angle, and returns its job and
     * whether it was queued now. While one is not done yet (queued, running or stuck) it is returned and nothing is
     * queued. Throws `AlreadyMade` when the Concept and Angle have a Clip in `language`, the Clip's own included, and
     * `Refused` when the Concept is Deleted, which has no entry point to a Translation.
     */
    queue(clipId: number, language: Language) {
      const clip = clipOf(clipId);
      const deleted = db
        .select({ id: concepts.id })
        .from(concepts)
        .where(and(eq(concepts.id, clip.conceptId), deletedConcept))
        .get();
      if (deleted) throw new Refused(`Concept #${clip.conceptId} is Deleted`);
      if (madeIn(clip, language)) throw new AlreadyMade(`Already in ${LANGUAGES[language].name}`);
      const open = unfinished(clip, language);
      if (open) return { ...open, queued: false };
      const job = db
        .insert(jobs)
        .values({
          kind: "translate",
          priority: JOB_PRIORITY.translate,
          conceptId: clip.conceptId,
          angle: clip.angle,
          language,
          fromClipId: clip.id,
        })
        .returning()
        .get();
      return { ...job, queued: true };
    },
  };
}
