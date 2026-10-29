import { and, asc, eq, inArray, isNotNull, isNull, ne, not, notExists, type SQLWrapper } from "drizzle-orm";
import type { Data } from "./data.ts";
import type { Language } from "./languages.ts";
import { deletedConcept } from "./live.ts";
import { type Angle, chapters, clips, concepts, events, JOB_PRIORITY, jobs, passages, sources } from "./schema.ts";

/**
 * A 🚩 the Learner has not resolved yet.
 */
export const openFlag = and(eq(events.kind, "flag"), isNull(events.resolvedAt));

/**
 * The regenerate jobs not done yet of a Clip's (Concept, Angle, Language), given as values or as the `clips` columns.
 */
const unfinishedRegenerate = (clip: {
  conceptId: number | SQLWrapper;
  angle: Angle | SQLWrapper;
  language: Language | SQLWrapper;
}) =>
  and(
    eq(jobs.kind, "regenerate"),
    eq(jobs.conceptId, clip.conceptId),
    eq(jobs.angle, clip.angle),
    eq(jobs.language, clip.language),
    ne(jobs.status, "done"),
  );

/**
 * What needs the Learner: open 🚩, Concepts not landing, and stuck jobs. All derived from state, nothing stored for it
 * but a 🚩's resolved time.
 */
export function createInbox({ db }: Data, clock = () => new Date()) {
  return {
    /**
     * Open 🚩 oldest first, not-landing Concepts that aren't retired, and stuck jobs (Clip or extraction), none of a
     * Deleted Concept. A 🚩 whose Clip is queued or running for Regenerate is left out until that job is done or stuck.
     */
    list() {
      const flags = db
        .select({
          eventId: events.id,
          clipId: clips.id,
          file: clips.file,
          angle: clips.angle,
          concept: { id: concepts.id, title: concepts.title },
          reason: events.reason,
          note: events.note,
          at: events.at,
        })
        .from(events)
        .innerJoin(clips, eq(events.clipId, clips.id))
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .where(
          and(
            openFlag,
            not(deletedConcept),
            notExists(
              db
                .select()
                .from(jobs)
                .where(and(unfinishedRegenerate(clips), inArray(jobs.status, ["queued", "running"]))),
            ),
          ),
        )
        .orderBy(asc(events.at))
        .all();

      // A not-landing Concept the Learner retired (⏭️) is settled.
      const notLanding = db
        .select()
        .from(concepts)
        .where(and(isNotNull(concepts.notLandingAt), ne(concepts.status, "retired"), not(deletedConcept)))
        .orderBy(asc(concepts.notLandingAt))
        .all()
        .map((concept) => {
          const tried = db
            .select({ id: clips.id, angle: clips.angle })
            .from(clips)
            .where(eq(clips.conceptId, concept.id))
            .orderBy(clips.id)
            .all();
          return {
            concept: { id: concept.id, title: concept.title },
            // Any of its Clips carries a ⏭️ press for the Concept.
            clipId: tried[0].id,
            tried: tried.map((clip) => clip.angle),
            fit: concept.fitAngles.length,
            since: concept.notLandingAt!,
            passages: db
              .select({
                text: passages.text,
                anchor: passages.anchor,
                source: { id: sources.id, title: sources.title },
              })
              .from(passages)
              .innerJoin(sources, eq(passages.sourceId, sources.id))
              .where(eq(passages.conceptId, concept.id))
              .all(),
          };
        });

      const stuck = db
        .select({
          jobId: jobs.id,
          kind: jobs.kind,
          stage: jobs.stage,
          lastError: jobs.lastError,
          angle: jobs.angle,
          language: jobs.language,
          chapter: { title: chapters.title },
          source: { title: sources.title },
          concept: { title: concepts.title },
        })
        .from(jobs)
        .leftJoin(chapters, eq(jobs.chapterId, chapters.id))
        .leftJoin(sources, eq(chapters.sourceId, sources.id))
        .leftJoin(concepts, eq(jobs.conceptId, concepts.id))
        // An extraction job has no Concept, which the predicate reads as not Deleted.
        .where(and(eq(jobs.status, "stuck"), not(deletedConcept)))
        .orderBy(jobs.id)
        .all();

      return { flags, notLanding, stuck };
    },

    /**
     * Takes a 🚩 out of the inbox. Its Clip stays hidden.
     */
    resolve(eventId: number) {
      const resolved = db
        .update(events)
        .set({ resolvedAt: clock() })
        .where(and(eq(events.id, eventId), openFlag))
        .returning()
        .get();
      if (!resolved) throw new Error(`Event #${eventId} is not an open 🚩`);
    },

    /**
     * Queues the 🚩 Clip to be made again in place: same Concept, Angle, Language and script, with the current lexicon.
     * The worker resolves the 🚩 once the new mp4 replaces the old one. Tapping it again while the job is open
     * queues nothing more; a stuck one goes back in the queue, as a retry does.
     */
    regenerate(eventId: number) {
      const clip = db
        .select({ conceptId: clips.conceptId, angle: clips.angle, language: clips.language })
        .from(events)
        .innerJoin(clips, eq(events.clipId, clips.id))
        .where(and(eq(events.id, eventId), openFlag))
        .get();
      if (!clip) throw new Error(`Event #${eventId} is not an open 🚩`);
      db.update(jobs)
        .set({ status: "queued", attempts: 0 })
        .where(and(unfinishedRegenerate(clip), eq(jobs.status, "stuck")))
        .run();
      if (!db.select().from(jobs).where(unfinishedRegenerate(clip)).get())
        db.insert(jobs)
          .values({ kind: "regenerate", priority: JOB_PRIORITY.regenerate, ...clip })
          .run();
    },
  };
}
