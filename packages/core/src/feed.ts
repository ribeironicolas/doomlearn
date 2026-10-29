import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, not, sql } from "drizzle-orm";
import type { Data, Tx } from "./data.ts";
import { activelyTaught, bufferedClip, deletedConcept } from "./live.ts";
import { clips, concepts, events, favorites, JOB_PRIORITY, jobs, passages, sources } from "./schema.ts";

type Concept = typeof concepts.$inferSelect;
type Flag = { reason?: string; note?: string };

/**
 * ✅ got it, 🤔 didn't get it, ⏭️ already know, 🚩 this is wrong.
 */
export type Button = Exclude<(typeof events.$inferSelect)["kind"], "seen">;

/**
 * Days until the next Review at each ladder step 0–4.
 */
// biome-ignore lint/style/noMagicNumbers: LADDER is the named constant; the rule only exempts direct property values.
export const LADDER = { days: [1, 3, 7, 21, 60], dayMs: 86_400_000 };

/**
 * The Feed: the next Clips to show, today's counts, caption search, the presses that move Concepts on the ladder, and
 * the Favorites, which move nothing.
 */
export function createFeed({ db, config }: Data, clock = () => new Date()) {
  /**
   * A scheduled Concept's step as its interval in days, which the tag shows, e.g. "Review · 3d"; null otherwise.
   */
  const days = ({ status, ladderStep }: Pick<Concept, "status" | "ladderStep">) =>
    status === "scheduled" ? LADDER.days[ladderStep!] : null;

  /**
   * Moves a Concept one rung up the ladder: a new Concept enters at step 0,
   * and a Concept past the last step retires as graduated, which also ends a Pause.
   */
  function advance(tx: Tx, concept: Concept, at: Date) {
    const step = concept.status === "new" ? 0 : concept.ladderStep! + 1;
    const next =
      step < LADDER.days.length
        ? {
            status: "scheduled" as const,
            ladderStep: step,
            dueAt: new Date(at.getTime() + LADDER.days[step] * LADDER.dayMs),
          }
        : { status: "retired" as const, retiredReason: "graduated" as const, pausedAt: null };
    tx.update(concepts).set(next).where(eq(concepts.id, concept.id)).run();
  }

  /**
   * Writes the event and the state it changes in one transaction; a repeated `clientEventId` changes nothing.
   * ✅ (pressed or implicit) counts once, while the Clip is in today's Feed. A press on a Deleted Concept's Clip, say
   * one queued offline, is only written down: its Concept and the Clip's last seen stay as they were, but a 🚩 still
   * hides the Clip, so it stays out of the Feed after a Restore.
   */
  function record(clipId: number, kind: Button | "seen", clientEventId: string, flag: Flag = {}) {
    const at = clock();
    db.transaction((tx) => {
      const event = tx
        .insert(events)
        .values({ clipId, kind, at, clientEventId, ...flag })
        .onConflictDoNothing()
        .returning()
        .get();
      if (!event) return;
      const deleted = tx
        .select({ id: concepts.id })
        .from(clips)
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .where(and(eq(clips.id, clipId), deletedConcept))
        .get();
      if (deleted) {
        if (kind === "flag") tx.update(clips).set({ hidden: true }).where(eq(clips.id, clipId)).run();
        return;
      }
      const clip = tx
        .update(clips)
        .set({ lastSeenAt: at, ...(kind === "flag" && { hidden: true }) })
        .where(eq(clips.id, clipId))
        .returning()
        .get()!;
      const concept = tx.select().from(concepts).where(eq(concepts.id, clip.conceptId)).get()!;
      /** Updates the pressed Clip's Concept. */
      const set = (values: Partial<Concept>) =>
        tx.update(concepts).set(values).where(eq(concepts.id, concept.id)).run();

      if (kind === "seen" || kind === "got_it") {
        const inFeed = concept.status === "new" || (concept.status === "scheduled" && concept.dueAt! <= at);
        if (inFeed) advance(tx, concept, at);
      } else if (kind === "know") {
        set({ status: "retired", retiredReason: "known", pausedAt: null });
      } else if (kind === "didnt_get") {
        set({
          status: "scheduled",
          ladderStep: 0,
          dueAt: new Date(at.getTime() + LADDER.days[0] * LADDER.dayMs),
          retiredReason: null,
        });
        const used = new Set(
          [
            ...tx.select({ angle: clips.angle }).from(clips).where(eq(clips.conceptId, concept.id)).all(),
            ...tx
              .select({ angle: jobs.angle })
              .from(jobs)
              .where(and(eq(jobs.conceptId, concept.id), inArray(jobs.status, ["queued", "running", "paused"])))
              .all(),
          ].map((row) => row.angle),
        );
        const angle = concept.fitAngles.find((fit) => !used.has(fit));
        // Out of Angles: the Review reuses the least recently seen Clip instead.
        if (angle)
          tx.insert(jobs)
            .values({ kind: "new_angle", priority: JOB_PRIORITY.new_angle, conceptId: concept.id, angle })
            .run();
        else set({ notLandingAt: at });
      }
    });
  }

  return {
    /**
     * The next Clips to show, each with the Passages it is grounded in.
     * Empty when the Feed is done for today.
     */
    next() {
      const now = clock();
      const fresh = db
        .select({ clip: clips, concept: concepts, favorite: favorites.clipId })
        .from(clips)
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .leftJoin(favorites, eq(favorites.clipId, clips.id))
        .where(and(eq(concepts.status, "new"), isNull(clips.lastSeenAt), eq(clips.hidden, false), not(deletedConcept)))
        // Round-robin across Sources: each Source's first Concept, then each one's second, and so on.
        .orderBy(
          sql`row_number() over (partition by ${concepts.sourceId} order by ${concepts.seq})`,
          asc(concepts.sourceId),
        )
        .all()
        .map((row) => ({ ...row, kind: "new" as const }));
      const pickedConcepts = new Set<number>();
      const reviews = db
        .select({ clip: clips, concept: concepts, favorite: favorites.clipId })
        .from(clips)
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .leftJoin(favorites, eq(favorites.clipId, clips.id))
        .where(
          and(eq(concepts.status, "scheduled"), lte(concepts.dueAt, now), eq(clips.hidden, false), not(deletedConcept)),
        )
        // Oldest due first; within a Concept its Clips in the Language of new Clips, then the least recently seen
        // (never seen first), so a Concept with no Clip in that Language still gets its Review.
        .orderBy(
          asc(concepts.dueAt),
          asc(concepts.id),
          desc(sql`${clips.language} = ${config().worker.language}`),
          asc(clips.lastSeenAt),
          asc(clips.id),
        )
        .all()
        .filter((row) => !pickedConcepts.has(row.concept.id) && pickedConcepts.add(row.concept.id))
        .map((row) => ({ ...row, kind: "review" as const }));

      // While the buffer lasts, every third slot is a Review; then the remaining Reviews.
      const slots = fresh.flatMap((row, i) => (i % 2 === 1 && reviews.length ? [row, reviews.shift()!] : [row]));
      slots.push(...reviews);

      return slots.map((row) => ({
        kind: row.kind,
        clipId: row.clip.id,
        file: row.clip.file,
        angle: row.clip.angle,
        language: row.clip.language,
        favorite: row.favorite !== null,
        concept: { id: row.concept.id, title: row.concept.title, days: days(row.concept) },
        source: db
          .select({ id: sources.id, title: sources.title })
          .from(sources)
          .where(eq(sources.id, row.concept.sourceId))
          .get()!,
        passages: db
          .select({ text: passages.text, anchor: passages.anchor, source: { id: sources.id, title: sources.title } })
          .from(passages)
          .innerJoin(sources, eq(passages.sourceId, sources.id))
          .where(eq(passages.conceptId, row.concept.id))
          .all(),
      }));
    },

    /**
     * What the "done for today" screen shows: today's presses (✅ counts a Clip once, implicit or pressed),
     * the buffer as the worker paces it, and how many Reviews are due by the end of tomorrow.
     */
    today() {
      const startOfToday = new Date(clock());
      startOfToday.setHours(0, 0, 0, 0);
      const dayAfterTomorrow = new Date(startOfToday);
      dayAfterTomorrow.setDate(startOfToday.getDate() + 2);
      const counts = db
        .select({
          got_it: sql<number>`count(distinct ${events.clipId}) filter (where ${events.kind} in ('seen', 'got_it'))`,
          didnt_get: sql<number>`count(*) filter (where ${events.kind} = 'didnt_get')`,
          know: sql<number>`count(*) filter (where ${events.kind} = 'know')`,
          flag: sql<number>`count(*) filter (where ${events.kind} = 'flag')`,
        })
        .from(events)
        .where(gte(events.at, startOfToday))
        .get()!;
      // As the worker counts them: only Clips in the Language of new Clips are kept ready.
      const [{ ready }] = db
        .select({ ready: count() })
        .from(clips)
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .where(bufferedClip(config().worker.language))
        .all();
      const [{ generating }] = db
        .select({ generating: count() })
        .from(jobs)
        .where(and(inArray(jobs.kind, ["new", "new_angle"]), inArray(jobs.status, ["queued", "running"])))
        .all();
      const [{ dueTomorrow }] = db
        .select({ dueTomorrow: count() })
        .from(concepts)
        .where(and(eq(concepts.status, "scheduled"), lt(concepts.dueAt, dayAfterTomorrow), not(deletedConcept)))
        .all();
      return {
        counts,
        buffer: { ready, generating, target: config().worker.bufferTarget },
        dueTomorrow,
      };
    },

    /**
     * Applies a button to a Clip's Concept; 🚩 carries a reason and an optional note. Repeating a `clientEventId` is a no-op,
     * so an offline press queue can sync more than once.
     */
    press(clipId: number, button: Button, clientEventId: string, flag: Flag = {}) {
      record(clipId, button, clientEventId, flag);
    },

    /**
     * Clips whose caption has every word of `query` (as a prefix, accents ignored), best match first, Retired Concepts
     * included. 🚩 hidden Clips and Deleted Concepts are left out. Each match in the caption is wrapped in
     * \u0002…\u0003, for the app to mark after escaping.
     */
    search(query: string) {
      const words = query.match(/[\p{L}\p{N}]+/gu);
      if (!words) return [];
      return (
        db
          .select({
            clipId: clips.id,
            file: clips.file,
            angle: clips.angle,
            language: clips.language,
            favorite: favorites.clipId,
            caption: sql<string>`highlight(clips_fts, 0, char(2), char(3))`,
            concept: {
              id: concepts.id,
              title: concepts.title,
              status: concepts.status,
              ladderStep: concepts.ladderStep,
            },
            source: { id: sources.id, title: sources.title },
          })
          .from(sql`clips_fts`)
          .innerJoin(clips, sql`${clips.id} = clips_fts.rowid`)
          .innerJoin(concepts, eq(clips.conceptId, concepts.id))
          .innerJoin(sources, eq(concepts.sourceId, sources.id))
          .leftJoin(favorites, eq(favorites.clipId, clips.id))
          // Each word quoted, so FTS5 syntax in the query is matched as text.
          .where(
            and(
              sql`clips_fts match ${words.map((word) => `"${word}"*`).join(" ")}`,
              eq(clips.hidden, false),
              not(deletedConcept),
            ),
          )
          .orderBy(sql`rank`)
          .all()
          .map(({ concept: { ladderStep, ...concept }, favorite, ...hit }) => ({
            ...hit,
            favorite: favorite !== null,
            concept: { ...concept, days: days({ ...concept, ladderStep }) },
          }))
      );
    },

    /**
     * Keeps a Clip as a Favorite (`on`) or lets it go. Both are idempotent, and neither touches the Concept, its
     * Reviews or the Clip's last seen time. A ⭐ on a Clip that no longer exists, say one queued on the phone, does
     * nothing.
     */
    favorite(clipId: number, on: boolean) {
      if (!db.select({ id: clips.id }).from(clips).where(eq(clips.id, clipId)).get()) return;
      if (on) db.insert(favorites).values({ clipId, createdAt: clock() }).onConflictDoNothing().run();
      else db.delete(favorites).where(eq(favorites.clipId, clipId)).run();
    },

    /**
     * The Favorites, newest first, whatever happened to their Concept, Source or Clip: Retired, Paused, Deleted and 🚩
     * flagged, included. A Concept is `paused` by hand, or when no active Source teaches it in a chapter neither Paused
     * nor Deleted; a Deleted one is not also `paused`.
     */
    favorites() {
      return db
        .select({
          clipId: clips.id,
          file: clips.file,
          angle: clips.angle,
          language: clips.language,
          concept: {
            id: concepts.id,
            title: concepts.title,
            status: concepts.status,
            ladderStep: concepts.ladderStep,
            deleted: sql<boolean>`${deletedConcept}`.mapWith(Boolean),
            paused: sql<boolean>`(${concepts.pausedAt} is not null or not ${activelyTaught(concepts.id)})`.mapWith(
              Boolean,
            ),
          },
          source: { id: sources.id, title: sources.title, status: sources.status },
          flagged: clips.hidden,
        })
        .from(favorites)
        .innerJoin(clips, eq(favorites.clipId, clips.id))
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .innerJoin(sources, eq(concepts.sourceId, sources.id))
        .orderBy(desc(favorites.createdAt), desc(favorites.clipId))
        .all()
        .map(({ concept: { ladderStep, deleted, paused, ...concept }, ...favorite }) => ({
          ...favorite,
          concept: {
            ...concept,
            days: days({ ...concept, ladderStep }),
            deleted,
            paused: !deleted && paused,
          },
        }));
    },

    /**
     * Records a watch. Only a watch to the end counts: it is an implicit ✅.
     * Leaving early records nothing.
     */
    seen(clipId: number, clientEventId: string, { completed }: { completed: boolean }) {
      if (completed) record(clipId, "seen", clientEventId);
    },
  };
}
