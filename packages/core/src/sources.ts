import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { and, count, countDistinct, eq, gte, inArray, max, ne, sql } from "drizzle-orm";
import type { ItemAction } from "./api.ts";
import type { Data } from "./data.ts";
import { LADDER } from "./feed.ts";
import { bufferedClip, deletedConcept, requeueLive } from "./live.ts";
import { type Media, Refused } from "./media.ts";
import { NotFound } from "./pronunciation.ts";
import { agentCalls, chapters, clips, concepts, favorites, JOB_PRIORITY, jobs, passages, sources } from "./schema.ts";

type SourceType = (typeof sources.type.enumValues)[number];

/**
 * The statuses of the Clip jobs a delete cancels. A stuck one stays stuck, out of the Inbox while its Concept is
 * Deleted.
 */
const CANCELLABLE_STATUSES = ["queued", "paused", "running"] as const;

/**
 * The columns a pause, resume, delete or restore of a chapter or Concept sets, stamped now.
 */
const stamp = (action: ItemAction) =>
  ({
    pause: { pausedAt: new Date() },
    resume: { pausedAt: null },
    delete: { deletedAt: new Date() },
    restore: { deletedAt: null },
  })[action];

/**
 * The extraction jobs of a Source's chapters.
 */
const extractionOf = (sourceId: number) =>
  and(
    eq(jobs.kind, "extract_chapter"),
    sql`${jobs.chapterId} in (select ${chapters.id} from ${chapters} where ${chapters.sourceId} = ${sourceId})`,
  );

/**
 * The Learner's Sources: adding or reconverting one, their status, and pausing, resuming or retrying their work.
 */
export function createSources({ db, home, config }: Data, media: Media) {
  return {
    /**
     * Adds a Source: copies the original and its per-chapter text into the data folder,
     * and queues one extraction job per chapter.
     * Throws `Refused`, with nothing stored, for a duplicate, a scanned PDF or a DRM'd ebook.
     */
    async add(file: string, { title }: { title?: string } = {}) {
      const type = extname(file).slice(1).toLowerCase() as SourceType;
      if (!sources.type.enumValues.includes(type)) throw new Refused(`Unsupported Source type: ${basename(file)}`);
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const duplicate = db.select().from(sources).where(eq(sources.sha256, sha256)).get();
      // en-CA formats the local date as YYYY-MM-DD.
      if (duplicate)
        throw new Refused(`Already added: ${duplicate.title} (${duplicate.createdAt.toLocaleDateString("en-CA")})`);
      const converted = await media.convert(file);

      // Files are written inside the transaction so a failed write rolls the Source back.
      return db.transaction((tx) => {
        const source = tx
          .insert(sources)
          .values({ title: title ?? converted.title ?? basename(file, extname(file)), type, sha256 })
          .returning()
          .get();
        const dir = join(home, "sources", String(source.id));
        mkdirSync(join(dir, "chapters"), { recursive: true });
        copyFileSync(file, join(dir, `original.${type}`));
        converted.chapters.forEach((chapter, seq) => {
          writeFileSync(join(dir, "chapters", `${seq}.txt`), chapter.text);
          const { id } = tx
            .insert(chapters)
            .values({ sourceId: source.id, seq, title: chapter.title })
            .returning()
            .get();
          tx.insert(jobs)
            .values({ kind: "extract_chapter", priority: JOB_PRIORITY.extract_chapter, chapterId: id })
            .run();
        });
        return source;
      });
    },

    /**
     * Converts a Source's stored original again (say, after a converter fix), replacing its chapters
     * and their extraction jobs with fresh ones, held if the Source is Paused. Returns how many chapters it has now.
     * Refused once the Source has Concepts, so nothing the Learner has seen is lost. Its past Claude
     * calls stay counted for it, unlinked from the deleted jobs.
     */
    async reconvert(id: number) {
      const source = db.select().from(sources).where(eq(sources.id, id)).get();
      if (!source) throw new Error(`No Source #${id}`);
      const dir = join(home, "sources", String(id));
      const converted = await media.convert(join(dir, `original.${source.type}`), source.title);

      // Concepts are counted here rather than before converting, as extraction may have added some meanwhile.
      return db.transaction((tx) => {
        const [{ concepts }] = tx
          .select({ concepts: countDistinct(passages.conceptId) })
          .from(passages)
          .where(eq(passages.sourceId, id))
          .all();
        if (concepts) throw new Error(`Source #${id} has ${concepts} Concepts: reconverting it would lose them`);
        tx.update(agentCalls)
          .set({ jobId: null })
          .where(inArray(agentCalls.jobId, tx.select({ id: jobs.id }).from(jobs).where(extractionOf(id))))
          .run();
        tx.delete(jobs).where(extractionOf(id)).run();
        tx.delete(chapters).where(eq(chapters.sourceId, id)).run();
        // The new chapter files are written aside and swapped in last, so a failure leaves the old ones in place.
        const fresh = join(dir, "chapters.new");
        rmSync(fresh, { recursive: true, force: true });
        mkdirSync(fresh);
        converted.chapters.forEach((chapter, seq) => {
          writeFileSync(join(fresh, `${seq}.txt`), chapter.text);
          const { id: chapterId } = tx
            .insert(chapters)
            .values({ sourceId: id, seq, title: chapter.title })
            .returning()
            .get();
          tx.insert(jobs)
            .values({
              kind: "extract_chapter",
              priority: JOB_PRIORITY.extract_chapter,
              chapterId,
              status: source.status === "paused" ? "paused" : "queued",
            })
            .run();
        });
        rmSync(join(dir, "chapters"), { recursive: true, force: true });
        renameSync(fresh, join(dir, "chapters"));
        return converted.chapters.length;
      });
    },

    /**
     * Per Source: chapters extracted, Concepts it teaches and its stuck chapters.
     * Then the queue: when a rate-limit pause ends (if one holds), unseen Clips in the Language of new Clips against the
     * buffer target, and today's Clips against the daily cap.
     */
    status() {
      const perSource = db
        .select()
        .from(sources)
        .orderBy(sources.id)
        .all()
        .map((source) => {
          const [progress] = db
            .select({ done: sql<number>`count(*) filter (where ${chapters.status} = 'extracted')`, total: count() })
            .from(chapters)
            .where(eq(chapters.sourceId, source.id))
            .all();
          const [{ concepts }] = db
            .select({ concepts: countDistinct(passages.conceptId) })
            .from(passages)
            .where(eq(passages.sourceId, source.id))
            .all();
          const stuck = db
            .select({
              jobId: jobs.id,
              chapter: { seq: chapters.seq, title: chapters.title },
              attempts: jobs.attempts,
              lastError: jobs.lastError,
            })
            .from(jobs)
            .innerJoin(chapters, eq(jobs.chapterId, chapters.id))
            .where(and(eq(chapters.sourceId, source.id), eq(jobs.status, "stuck")))
            .orderBy(chapters.seq)
            .all();
          return { id: source.id, title: source.title, status: source.status, chapters: progress, concepts, stuck };
        });
      // As the worker counts them: only Clips in the Language of new Clips are kept ready.
      const [{ buffered }] = db
        .select({ buffered: count() })
        .from(clips)
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .where(bufferedClip(config().worker.language))
        .all();
      const [{ today }] = db
        .select({ today: count() })
        .from(clips)
        .where(gte(clips.createdAt, new Date(new Date().setHours(0, 0, 0, 0))))
        .all();
      const [{ retryAt }] = db
        .select({ retryAt: max(agentCalls.retryAt) })
        .from(agentCalls)
        .all();
      return {
        sources: perSource,
        queue: {
          pausedUntil: retryAt && retryAt > new Date() ? retryAt : undefined,
          buffer: { clips: buffered, target: config().worker.bufferTarget },
          today: { clips: today, cap: config().worker.dailyClipCap },
        },
      };
    },

    /**
     * The Source screen of Source `id`, or undefined when there is none: its chapters in book order, each with its state
     * (from its extraction job), its stuck job, and the Concepts it teaches in reading order (by their first Passage
     * in it). Each Concept has its ladder, its Passages in that chapter, its Clips, the other chapters teaching it, and
     * whether its first Clip is being made. `ladderSteps` is how many steps the ladder has.
     */
    source(id: number) {
      const source = db
        .select({ id: sources.id, title: sources.title, status: sources.status })
        .from(sources)
        .where(eq(sources.id, id))
        .get();
      if (!source) return undefined;
      const rows = db
        .select({ chapter: chapters, job: { id: jobs.id, status: jobs.status, lastError: jobs.lastError } })
        .from(chapters)
        .leftJoin(jobs, and(eq(jobs.chapterId, chapters.id), eq(jobs.kind, "extract_chapter")))
        .where(eq(chapters.sourceId, id))
        .orderBy(chapters.seq)
        .all();
      const taught = db
        .select({
          chapterId: passages.chapterId,
          passage: { id: passages.id, text: passages.text },
          concept: concepts,
        })
        .from(passages)
        .innerJoin(concepts, eq(passages.conceptId, concepts.id))
        .innerJoin(chapters, eq(passages.chapterId, chapters.id))
        .where(eq(chapters.sourceId, id))
        .orderBy(passages.id)
        .all();
      const ids = [...new Set(taught.map((row) => row.concept.id))];
      const clipsOf = Map.groupBy(
        db
          .select({
            conceptId: clips.conceptId,
            clipId: clips.id,
            file: clips.file,
            angle: clips.angle,
            language: clips.language,
            lastSeenAt: clips.lastSeenAt,
            hidden: clips.hidden,
            favorite: favorites.clipId,
          })
          .from(clips)
          .leftJoin(favorites, eq(favorites.clipId, clips.id))
          .where(inArray(clips.conceptId, ids))
          .orderBy(clips.id)
          .all()
          .map(({ lastSeenAt, hidden, favorite, ...clip }) => ({
            ...clip,
            seen: lastSeenAt !== null,
            flagged: hidden,
            favorite: favorite !== null,
          })),
        (clip) => clip.conceptId,
      );
      // Every chapter, of any Source, that teaches one of these Concepts.
      const places = db
        .selectDistinct({
          conceptId: passages.conceptId,
          source: { id: sources.id, title: sources.title },
          chapter: { id: chapters.id, seq: chapters.seq, title: chapters.title },
          deleted: sql<boolean>`${chapters.deletedAt} is not null`.mapWith(Boolean),
        })
        .from(passages)
        .innerJoin(chapters, eq(passages.chapterId, chapters.id))
        .innerJoin(sources, eq(chapters.sourceId, sources.id))
        .where(inArray(passages.conceptId, ids))
        .orderBy(sources.id, chapters.seq)
        .all();
      const placesOf = Map.groupBy(places, (place) => place.conceptId);
      const taughtIn = Map.groupBy(taught, (row) => row.chapterId);
      // Concepts whose first Clip is queued or being made.
      const making = new Set(
        db
          .select({ conceptId: jobs.conceptId })
          .from(jobs)
          .where(and(eq(jobs.kind, "new"), inArray(jobs.status, ["queued", "running"]), inArray(jobs.conceptId, ids)))
          .all()
          .map((row) => row.conceptId),
      );
      // Deleted by hand, or with every chapter teaching them.
      const deleted = new Set(
        db
          .select({ id: concepts.id })
          .from(concepts)
          .where(and(inArray(concepts.id, ids), deletedConcept))
          .all()
          .map((row) => row.id),
      );
      return {
        ...source,
        ladderSteps: LADDER.days.length,
        chapters: rows.map(({ chapter, job }) => {
          // Ordered by first Passage, as `taught` is.
          const listed = new Map<
            number,
            { concept: typeof concepts.$inferSelect; passages: (typeof taught)[number]["passage"][] }
          >();
          for (const row of taughtIn.get(chapter.id) ?? []) {
            if (!listed.has(row.concept.id)) listed.set(row.concept.id, { concept: row.concept, passages: [] });
            listed.get(row.concept.id)!.passages.push(row.passage);
          }
          let state: "waiting" | "extracting" | "extracted" | "stuck" | "paused" = "waiting";
          if (chapter.pausedAt) state = "paused";
          else if (chapter.status === "extracted") state = "extracted";
          else if (job?.status === "running") state = "extracting";
          else if (job?.status === "stuck" || job?.status === "paused") state = job.status;
          return {
            id: chapter.id,
            seq: chapter.seq,
            title: chapter.title,
            state,
            paused: chapter.pausedAt !== null,
            deleted: chapter.deletedAt !== null,
            stuck: state === "stuck" ? { jobId: job!.id, lastError: job!.lastError } : null,
            conceptCount: listed.size,
            concepts: [...listed.values()].map(({ concept, passages }) => ({
              id: concept.id,
              title: concept.title,
              summary: concept.summary,
              status: concept.status,
              ladderStep: concept.ladderStep,
              dueAt: concept.dueAt,
              retiredReason: concept.retiredReason,
              notLandingAt: concept.notLandingAt,
              paused: concept.pausedAt !== null,
              deleted: deleted.has(concept.id),
              deletedByHand: concept.deletedAt !== null,
              making: making.has(concept.id),
              // A deleted chapter leaves the "also in" of the Concepts it shares.
              alsoIn: (placesOf.get(concept.id) ?? [])
                .filter((place) => !place.deleted && place.chapter.id !== chapter.id)
                .map(({ source, chapter }) => ({ source, chapter })),
              // The deleted chapters a Concept went with: any of their Restores brings it back.
              deletedWith:
                deleted.has(concept.id) && concept.deletedAt === null
                  ? (placesOf.get(concept.id) ?? [])
                      .filter((place) => place.deleted)
                      .map(({ source, chapter }) => ({ source, chapter }))
                  : [],
              passages,
              clips: (clipsOf.get(concept.id) ?? []).map(({ conceptId, ...clip }) => clip),
            })),
          };
        }),
      };
    },

    /**
     * Requeues a stuck job with its attempts reset. Nothing is ever retried automatically.
     * Each script gate gets its 2 rewrites again, and the script stage still gets the last feedback,
     * so a script that failed its gates is rewritten instead of failing on the first check.
     */
    retry(jobId: number) {
      const retried = db
        .update(jobs)
        .set({ status: "queued", attempts: 0 })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "stuck")))
        .returning()
        .get();
      if (!retried) throw new Error(`Job #${jobId} is not stuck`);
      // The pipeline counts each gate's rewrites in the job folder.
      const file = join(home, "jobs", String(jobId), "feedback.json");
      if (existsSync(file)) {
        const { feedback } = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(file, JSON.stringify({ feedback, rewrites: {} }));
      }
    },

    /**
     * Pauses a Source: its chapters stop being extracted, stuck ones included, and Concepts taught only
     * by Paused Sources get no new-Concept Clip (the worker checks that). Reviews and 🤔 new-Angle Clips go on.
     */
    pause(id: number) {
      db.transaction((tx) => {
        if (!tx.update(sources).set({ status: "paused" }).where(eq(sources.id, id)).returning().get())
          throw new Error(`No Source #${id}`);
        tx.update(jobs)
          .set({ status: "paused" })
          .where(and(extractionOf(id), inArray(jobs.status, ["queued", "running", "stuck"])))
          .run();
      });
    },

    /**
     * Resumes a Paused Source: extraction continues from its next unextracted chapter, a stuck one
     * retried with its attempts reset, and its `new` Concepts get Clips again.
     */
    resume(id: number) {
      db.transaction((tx) => {
        if (!tx.update(sources).set({ status: "active" }).where(eq(sources.id, id)).returning().get())
          throw new Error(`No Source #${id}`);
        tx.update(jobs)
          .set({ status: "queued", attempts: 0 })
          .where(and(extractionOf(id), eq(jobs.status, "paused")))
          .run();
      });
    },

    /**
     * Pauses, resumes, deletes or restores chapter `id`. A Paused chapter is a Paused Source scoped to it: it is not
     * extracted while it waits, and a Concept it alone teaches gets no new-Concept Clip (the worker checks both).
     * A delete is soft: its extraction, if not done, is cancelled, and so are the Clip jobs of every Concept no other
     * live chapter teaches, which go with it. A Restore requeues them, but a Concept deleted by hand stays Deleted.
     * Throws `NotFound` when there is no such chapter, and `Refused` for a pause or resume of a Deleted one.
     */
    chapter(id: number, action: ItemAction) {
      db.transaction((tx) => {
        const chapter = tx.select({ deletedAt: chapters.deletedAt }).from(chapters).where(eq(chapters.id, id)).get();
        if (!chapter) throw new NotFound(`No chapter #${id}`);
        if ((action === "pause" || action === "resume") && chapter.deletedAt)
          throw new Refused(`Chapter #${id} is Deleted: it can be restored, not paused or resumed`);
        tx.update(chapters).set(stamp(action)).where(eq(chapters.id, id)).run();
        if (action === "restore") requeueLive(tx);
        if (action !== "delete") return;
        const cancelled = { status: "cancelled", cancelledBy: `chapter:${id}` } as const;
        tx.update(jobs)
          .set(cancelled)
          .where(and(eq(jobs.kind, "extract_chapter"), eq(jobs.chapterId, id), ne(jobs.status, "done")))
          .run();
        tx.update(jobs)
          .set(cancelled)
          .where(
            and(
              ne(jobs.kind, "extract_chapter"),
              inArray(jobs.status, CANCELLABLE_STATUSES),
              inArray(
                jobs.conceptId,
                tx
                  .select({ id: concepts.id })
                  .from(concepts)
                  .innerJoin(passages, eq(passages.conceptId, concepts.id))
                  .where(and(eq(passages.chapterId, id), deletedConcept)),
              ),
            ),
          )
          .run();
      });
    },

    /**
     * Pauses, resumes, deletes or restores Concept `id`. A Paused Concept gets no new-Concept Clip; its Reviews, unseen
     * Clips, 🤔 new-Angle Clips and Translations go on. A delete is soft and cancels its Clip jobs; a Restore requeues
     * them, and brings its ladder back as it was. Throws `NotFound` when there is no such Concept, and `Refused` for a
     * pause of a Retired one, which can only be deleted, and for a pause or resume of a Deleted one.
     */
    concept(id: number, action: ItemAction) {
      db.transaction((tx) => {
        const concept = tx
          .select({ status: concepts.status, deleted: sql<boolean>`${deletedConcept}`.mapWith(Boolean) })
          .from(concepts)
          .where(eq(concepts.id, id))
          .get();
        if (!concept) throw new NotFound(`No Concept #${id}`);
        if ((action === "pause" || action === "resume") && concept.deleted)
          throw new Refused(`Concept #${id} is Deleted: it can be restored, not paused or resumed`);
        if (action === "pause" && concept.status === "retired")
          throw new Refused(`Concept #${id} is Retired: it can be deleted, not paused`);
        tx.update(concepts).set(stamp(action)).where(eq(concepts.id, id)).run();
        if (action === "restore") requeueLive(tx);
        if (action === "delete")
          tx.update(jobs)
            .set({ status: "cancelled", cancelledBy: `concept:${id}` })
            .where(and(eq(jobs.conceptId, id), inArray(jobs.status, CANCELLABLE_STATUSES)))
            .run();
      });
    },
  };
}
