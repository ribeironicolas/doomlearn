import { and, eq, isNull, ne, not, type SQLWrapper, sql } from "drizzle-orm";
import type { Tx } from "./data.ts";
import type { Language } from "./languages.ts";
import { chapters, clips, concepts, jobs, passages, sources } from "./schema.ts";

/**
 * Whether the `concepts` row in scope is Deleted: by hand (`deleted_at` set), or with its chapters, when every Passage
 * of it lies in a deleted chapter. A Passage with no chapter counts as in a live chapter. Every reader leaves a Deleted
 * Concept out, but the Source screen and Favorites.
 */
export const deletedConcept = sql`(${concepts.deletedAt} is not null or (
  exists (select 1 from ${passages} inner join ${chapters} on ${chapters.id} = ${passages.chapterId}
    where ${passages.conceptId} = ${concepts.id} and ${chapters.deletedAt} is not null)
  and not exists (select 1 from ${passages} left join ${chapters} on ${chapters.id} = ${passages.chapterId}
    where ${passages.conceptId} = ${concepts.id} and ${chapters.deletedAt} is null)
))`;

/**
 * Whether the `clips` row in scope counts toward the buffer: unseen, not hidden, in `language`, and its Concept not
 * Deleted. The query joins `concepts` on the Clip's Concept.
 */
export const bufferedClip = (language: Language) =>
  and(isNull(clips.lastSeenAt), eq(clips.hidden, false), eq(clips.language, language), not(deletedConcept));

/**
 * Whether Concept `conceptId` has a Passage in an active Source, in a chapter neither Paused nor Deleted (or in no
 * chapter). One taught only by Paused Sources or chapters gets no new-Concept Clip, and its queued job waits until one
 * of them is resumed.
 */
export const activelyTaught = (conceptId: SQLWrapper) =>
  sql`exists (select 1 from ${passages}
    inner join ${sources} on ${sources.id} = ${passages.sourceId}
    left join ${chapters} on ${chapters.id} = ${passages.chapterId}
    where ${passages.conceptId} = ${conceptId} and ${sources.status} = 'active'
      and ${chapters.pausedAt} is null and ${chapters.deletedAt} is null)`;

/**
 * Requeues every cancelled job whose chapter or Concept is live again: after a Restore, or once a live chapter teaches
 * a Concept that went with its chapter. A job of a Concept still Deleted, say one deleted by hand, stays cancelled. An
 * extraction goes back paused while its Source is Paused, with its attempts reset, as a Source's Resume does.
 */
export function requeueLive(tx: Tx) {
  tx.update(jobs)
    .set({
      status: sql`case when exists (select 1 from ${chapters} inner join ${sources} on ${sources.id} = ${chapters.sourceId}
        where ${chapters.id} = ${jobs.chapterId} and ${sources.status} = 'paused') then 'paused' else 'queued' end`,
      attempts: 0,
      cancelledBy: null,
    })
    .where(
      and(
        eq(jobs.status, "cancelled"),
        eq(jobs.kind, "extract_chapter"),
        sql`exists (select 1 from ${chapters} where ${chapters.id} = ${jobs.chapterId} and ${chapters.deletedAt} is null)`,
      ),
    )
    .run();
  tx.update(jobs)
    .set({ status: "queued", cancelledBy: null })
    .where(
      and(
        eq(jobs.status, "cancelled"),
        ne(jobs.kind, "extract_chapter"),
        sql`exists (select 1 from ${concepts} where ${concepts.id} = ${jobs.conceptId} and not ${deletedConcept})`,
      ),
    )
    .run();
}
