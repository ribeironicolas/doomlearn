import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Agent, AgentStages } from "./agent.ts";
import { sliceAnchor } from "./anchor.ts";
import type { Config } from "./config.ts";
import { type Data, InvalidLexicon, readLexicon, type Tx } from "./data.ts";
import { type Language, LANGUAGES } from "./languages.ts";
import { writeJson } from "./json.ts";
import { activelyTaught, bufferedClip, deletedConcept, requeueLive } from "./live.ts";
import { type Media, type Narration, SceneError } from "./media.ts";
import { narrate } from "./narration.ts";
import { type Anchor, chapters, clips, concepts, events, JOB_PRIORITY, jobs, passages } from "./schema.ts";
import { checkScript, newTerms, RECIPES, shownBeats } from "./script.ts";
import { gates, publishStage } from "./status.ts";

type Job = typeof jobs.$inferSelect;
type Output<S extends keyof AgentStages> = AgentStages[S]["output"];

/**
 * How many Passages the script and verify read, a Clip's longest narration and the tenth of a second
 * its overrun is rounded up to, and how many times a job whose scene fails to render is requeued.
 */
const LIMIT = { groundingPassages: 3, clipMs: 60_000, tenthMs: 100, sceneRetries: 5 };

/**
 * How a job runs: stages in order, each checkpointed to its file in the job folder,
 * then `finish` applies the result to the database, and may return what to do once that has committed.
 * A stage's returned output is saved as its file; a stage returning nothing writes its file itself,
 * or removes earlier stage files to send the job back to them.
 */
type Plan = {
  stages: { file: string; run: () => Promise<unknown> }[];
  finish: (tx: Tx) => (() => void) | undefined;
};

/**
 * A scene that still doesn't compile or render after its re-sends.
 */
class SceneFailed extends Error {}

/**
 * An agent call that failed (`is_error`, a non-zero exit or a timeout): one attempt of its job.
 */
class AgentFailed extends Error {}

/**
 * An extraction whose every anchor was dropped: re-applying the same answer can't help,
 * so the job parks at once and a retry asks the agent again.
 */
class AnchorsNotFound extends Error {}

/**
 * A rate-limited agent call: the whole queue waits until `retryAt`.
 */
class RateLimited extends Error {
  retryAt: Date;
  /**
   * The agent's error `message`, and when the rate limit lifts.
   */
  constructor(message: string, retryAt: Date) {
    super(message);
    this.retryAt = retryAt;
  }
}

/**
 * What the script stage is sent back with when its script failed a check, verify or the 60 s gate,
 * and how often each of those sent it back since the job was last retried.
 */
type Feedback = { feedback: string; rewrites: Partial<Record<Gate, number>> };

/**
 * The stages that can send a script back for a rewrite; each has its own budget of 2.
 */
type Gate = "check" | "verify" | "duration";

/**
 * Reads a stage's JSON output `file` from the job folder `dir`.
 */
function read<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

/**
 * The worker's job runner. New `{shown|spoken}` terms are added to the Lexicon of the job's Language.
 */
export function createPipeline({ db, home, config, lexicons, lexiconFile }: Data, agent: Agent, media: Media) {
  /**
   * Runs one agent stage for `job`, in its Language, and returns its output.
   * Throws `RateLimited` when the call is rate-limited, `AgentFailed` on any other failure.
   */
  async function ask<S extends keyof AgentStages>(stage: S, input: AgentStages[S]["input"], job: Job) {
    const result = await agent.run(stage, input, {
      jobId: job.id,
      language: job.language ?? undefined,
    });
    if (!result.ok)
      throw result.retryAt ? new RateLimited(result.error, result.retryAt) : new AgentFailed(result.error);
    return result.output;
  }

  /**
   * The Lexicon of `language`, re-read from its file, so a Lexicon edit reaches the next stage without a restart.
   * A missing file keeps the terms in use. A file broken by a hand edit throws `InvalidLexicon` when `strict` (a
   * regenerate, the Learner's way to hear their edit, parks on it); otherwise it is logged and its last good terms
   * are kept, `broken`.
   */
  function lexicon(language: Language, strict = false) {
    try {
      const current = readLexicon(lexiconFile(language));
      if (current) lexicons[language] = current;
      return { terms: lexicons[language], broken: false };
    } catch (error) {
      if (strict || !(error instanceof InvalidLexicon)) throw error;
      console.error(`${error.message}\nKeeping the last good lexicon.`);
      return { terms: lexicons[language], broken: true };
    }
  }

  /**
   * Jobs the worker may run: an extraction while its chapter is not Paused, a Clip job while its Concept is not
   * Deleted, and a `new` job only while its Concept is not Paused, by hand or through its Sources and chapters.
   */
  const runnable = () =>
    and(
      inArray(jobs.status, ["queued", "running"]),
      or(
        and(
          eq(jobs.kind, "extract_chapter"),
          sql`exists (select 1 from ${chapters} where ${chapters.id} = ${jobs.chapterId} and ${chapters.pausedAt} is null)`,
        ),
        and(
          ne(jobs.kind, "extract_chapter"),
          sql`exists (select 1 from ${concepts} where ${concepts.id} = ${jobs.conceptId} and not ${deletedConcept}
            and (${jobs.kind} <> 'new' or (${concepts.pausedAt} is null and ${activelyTaught(jobs.conceptId)})))`,
        ),
      ),
    );

  /**
   * Queues a Clip job for the next Concept that has none,
   * while the buffer is below target and today's Clips are below the cap.
   */
  function fillBufferGap(clipsToday: number, { bufferTarget, dailyClipCap, language }: Config["worker"]) {
    // Only Clips in the Language of new Clips are kept ready: an unseen one in another Language doesn't hold back a
    // new Clip.
    const [{ unseen }] = db
      .select({ unseen: count() })
      .from(clips)
      .innerJoin(concepts, eq(clips.conceptId, concepts.id))
      .where(bufferedClip(language))
      .all();
    // A Translation adds a Clip today, but the Learner asked for it: it counts toward the cap, never the buffer.
    const [{ pending, translations }] = db
      .select({
        pending: sql<number>`count(*) filter (where ${inArray(jobs.kind, ["new", "new_angle"])})`,
        translations: sql<number>`count(*) filter (where ${eq(jobs.kind, "translate")})`,
      })
      .from(jobs)
      .where(runnable())
      .all();
    if (unseen + pending >= bufferTarget || clipsToday + pending + translations >= dailyClipCap) return;

    // Round-robin across Sources, each in its seq order: a new Concept's turn counts the ones
    // already queued, so a Source that has had more turns waits for the others.
    const fresh = db
      .select({
        id: concepts.id,
        fitAngles: concepts.fitAngles,
        sourceId: concepts.sourceId,
        turn: sql<number>`row_number() over (partition by ${concepts.sourceId} order by ${concepts.seq})`.as("turn"),
      })
      .from(concepts)
      .where(
        and(eq(concepts.status, "new"), isNull(concepts.pausedAt), not(deletedConcept), activelyTaught(concepts.id)),
      )
      .as("fresh");
    const concept = db
      .select()
      .from(fresh)
      .where(notExists(db.select().from(jobs).where(eq(jobs.conceptId, fresh.id))))
      .orderBy(asc(fresh.turn), asc(fresh.sourceId))
      .get();
    if (concept) {
      db.insert(jobs)
        .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: concept.id, angle: concept.fitAngles[0] })
        .run();
    }
  }

  /**
   * An extraction job's plan: the extract stage on its chapter, then the Concepts and Passages it found,
   * each Passage sliced at its anchor.
   */
  function extraction(job: Job, dir: string): Plan {
    const chapter = db.select().from(chapters).where(eq(chapters.id, job.chapterId!)).get()!;
    const text = readFileSync(
      join(home, "sources", String(chapter.sourceId), "chapters", `${chapter.seq}.txt`),
      "utf8",
    );
    return {
      stages: [
        {
          file: "extract.json",
          run: () => {
            const known = db
              .select({ id: concepts.id, title: concepts.title, summary: concepts.summary })
              .from(concepts)
              .all();
            return ask("extract", { title: chapter.title, chapter: text, concepts: known }, job);
          },
        },
      ],
      finish(tx) {
        const found = read<Output<"extract">>(dir, "extract.json");
        // Code slices each Passage at its anchor, so the agent never copies text.
        // An anchor whose text isn't in this chapter is dropped, so every Concept stays grounded.
        const dropped: Anchor[] = [];
        /**
         * The Passage text at `anchor`, or undefined (and the anchor recorded as dropped) when it isn't in the chapter.
         */
        const slice = (anchor: Anchor) => {
          const passage = sliceAnchor(text, anchor);
          if (!passage) dropped.push(anchor);
          // A chapter anchor names the chapter being extracted, whatever title the agent gave it.
          return (
            passage && {
              sourceId: chapter.sourceId,
              chapterId: chapter.id,
              anchor: "chapter" in anchor ? { ...anchor, chapter: chapter.title } : anchor,
              text: passage,
            }
          );
        };
        for (const concept of found.new) {
          const passage = slice(concept.anchor);
          if (!passage) continue;
          const [{ seq }] = tx
            .select({ seq: count() })
            .from(concepts)
            .where(eq(concepts.sourceId, chapter.sourceId))
            .all();
          const { id } = tx
            .insert(concepts)
            .values({
              title: concept.title,
              summary: concept.summary,
              // An Angle listed twice is kept once: the schema can't forbid it (Codex strict mode refuses uniqueItems).
              fitAngles: [...new Set(concept.angles)],
              sourceId: chapter.sourceId,
              seq,
            })
            .returning()
            .get();
          tx.insert(passages)
            .values({ ...passage, conceptId: id })
            .run();
        }
        for (const { conceptId, anchor } of found.attach) {
          const passage = slice(anchor);
          // An id the agent made up has no Concept to attach to.
          if (passage && tx.select().from(concepts).where(eq(concepts.id, conceptId)).get())
            tx.insert(passages)
              .values({ ...passage, conceptId })
              .run();
        }
        if (dropped.length) {
          const total = found.new.length + found.attach.length;
          const names = dropped.map((anchor) =>
            "pages" in anchor
              ? `pages ${anchor.pages.join("-")}`
              : anchor.section
                ? `section "${anchor.section}"`
                : `chapter "${anchor.chapter}"`,
          );
          // Every anchor dropped: the answer is lost, not empty, so the transaction rolls back
          // and the job parks with the chapter still pending. The answer is kept aside to inspect,
          // and a retry asks the agent again.
          if (dropped.length === total) {
            renameSync(join(dir, "extract.json"), join(dir, "extract.rejected.json"));
            throw new AnchorsNotFound(`${total}/${total} anchors not found in the chapter, e.g. ${names[0]}`);
          }
          console.warn(
            `Job #${job.id}: ${dropped.length}/${total} anchors not found in chapter "${chapter.title}": ${names.join(", ")}`,
          );
        }
        tx.update(chapters).set({ status: "extracted" }).where(eq(chapters.id, chapter.id)).run();
        // A Concept that went with its chapter is back once this chapter teaches it, and so are its cancelled jobs.
        requeueLive(tx);
      },
    };
  }

  /**
   * A Clip job's plan: script, verify, narration, scene and render, with the script rewritten when a gate fails,
   * then the Clip added to the Feed, all in the job's Language. A regenerate starts at the narration with its Clip's
   * stored script and the current Lexicon, then replaces that Clip's mp4 in place and resolves its 🚩. A translate
   * job's script is its source Clip's beats translated into the job's Language, which then goes through the same gates
   * and becomes a new Clip.
   */
  function clip(job: Job, dir: string): Plan {
    const concept = db.select().from(concepts).where(eq(concepts.id, job.conceptId!)).get()!;
    const angle = job.angle!;
    // Set by the time a Clip job runs: at insert for a regenerate or a translate job, when it first starts for a new
    // Clip.
    const language = job.language!;
    const regenerated =
      job.kind === "regenerate"
        ? db
            .select()
            .from(clips)
            .where(and(eq(clips.conceptId, concept.id), eq(clips.angle, angle), eq(clips.language, language)))
            .get()!
        : undefined;
    const fromClip =
      job.kind === "translate" ? db.select().from(clips).where(eq(clips.id, job.fromClipId!)).get()! : undefined;
    const grounded = db.select().from(passages).where(eq(passages.conceptId, concept.id)).all();
    // The script and verify read the 3 shortest Passages, to keep their input small.
    const grounding = grounded
      .map((passage) => passage.text)
      .toSorted((a, b) => a.length - b.length)
      .slice(0, LIMIT.groundingPassages);
    /** The script stage's beats, or the regenerated Clip's. */
    const beats = (): Output<"script">["beats"] =>
      regenerated ? JSON.parse(regenerated.script) : read<Output<"script">>(dir, "script.json").beats;
    /** The narration stage's audio and word timings. */
    const narration = () => read<Narration>(dir, "narration.json");

    /**
     * Sends the job back to the script stage with `feedback`, up to 2× per gate, so a script that never
     * passes can't burn quota in a loop. After that, a script still too long splits its Concept once, if it
     * has no Clip yet; anything else fails the job, and the Concept leaves the queue.
     */
    async function rewrite(feedback: string, tooLong: boolean, gate: Gate) {
      const { rewrites } = existsSync(join(dir, "feedback.json"))
        ? read<Feedback>(dir, "feedback.json")
        : { rewrites: {} as Feedback["rewrites"] };
      const done = rewrites[gate] ?? 0;
      if (done < 2) {
        writeFileSync(
          join(dir, "feedback.json"),
          JSON.stringify({ feedback, rewrites: { ...rewrites, [gate]: done + 1 } } satisfies Feedback),
        );
        for (const file of ["script.json", "verify.json"]) rmSync(join(dir, file), { force: true });
        return;
      }
      const hasClip = db.select().from(clips).where(eq(clips.conceptId, concept.id)).get();
      // A Concept that came out of a split is never split again, so splits never cascade.
      if (!tooLong || hasClip || concept.fromSplit)
        throw new Error(`Script still failing after 2 rewrites: ${feedback}`);

      const split = await ask("split", { concept, passages: grounding, feedback }, job);
      // An Angle listed twice is kept once, as at extraction.
      const [first, ...rest] = split.concepts.map((part) => ({ ...part, angles: [...new Set(part.angles)] }));
      db.transaction((tx) => {
        // The Concept becomes the first part and keeps this job; the others get their jobs now.
        tx.update(concepts)
          .set({ title: first.title, summary: first.summary, fitAngles: first.angles, fromSplit: true })
          .where(eq(concepts.id, concept.id))
          .run();
        tx.update(jobs).set({ angle: first.angles[0] }).where(eq(jobs.id, job.id)).run();
        for (const part of rest) {
          const { id } = tx
            .insert(concepts)
            .values({
              title: part.title,
              summary: part.summary,
              fitAngles: part.angles,
              sourceId: concept.sourceId,
              seq: concept.seq,
              fromSplit: true,
            })
            .returning()
            .get();
          for (const { sourceId, chapterId, anchor, text } of grounded)
            tx.insert(passages).values({ conceptId: id, sourceId, chapterId, anchor, text }).run();
          tx.insert(jobs)
            .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: id, angle: part.angles[0] })
            .run();
        }
      });
      // This job starts over at the script stage, for the first part.
      rmSync(dir, { recursive: true });
    }

    return {
      stages: [
        {
          file: "script.json",
          run: async () => {
            const feedback = existsSync(join(dir, "feedback.json"))
              ? read<Feedback>(dir, "feedback.json").feedback
              : undefined;
            const { words } = LANGUAGES[language];
            const known = Object.keys(lexicon(language).terms);
            // A Translation reads its source's beats as shown, so no Respelling of the source's Language leaks into it.
            const from = fromClip && shownBeats(JSON.parse(fromClip.script));
            const script = fromClip
              ? await ask(
                  "translate",
                  {
                    from: LANGUAGES[fromClip.language].prompt.name,
                    beats: from!,
                    passages: grounding,
                    words,
                    lexicon: known,
                    feedback,
                  },
                  job,
                )
              : await ask(
                  "script",
                  { concept, passages: grounding, angle, recipe: RECIPES[angle], words, lexicon: known, feedback },
                  job,
                );
            const { problems, tooLong } = checkScript(
              script.beats,
              grounded.map((passage) => passage.text),
              words,
            );
            // A Translation keeps its source's scene: the same beats, in order, each with its visual.
            if (
              from &&
              (script.beats.length !== from.length || script.beats.some((beat, i) => beat.visual !== from[i].visual))
            )
              problems.push(`keep the source's ${from.length} beats in order, each with its visual unchanged`);
            if (problems.length) return rewrite(problems.join("; "), tooLong, "check");
            // Proposed respellings go in without waiting for the Learner, who can tune them in the Lexicon later.
            // The file is read again after the agent call, which takes minutes, so the Learner's hand edits made
            // meanwhile (a tuned respelling, a deleted term) win, and are used from now on. A deleted file keeps the
            // terms in use, so it is written again whole. A file broken by a hand edit is left for the Learner to fix,
            // like config.json: the script already cost an agent call, so the new terms are only used in memory.
            const { terms: current, broken } = lexicon(language);
            const terms = newTerms(script.beats, current);
            if (!Object.keys(terms).length) return script;
            if (broken) {
              Object.assign(current, terms);
              return script;
            }
            lexicons[language] = { ...terms, ...current };
            writeJson(lexiconFile(language), lexicons[language]);
            return script;
          },
        },
        {
          file: "verify.json",
          run: async () => {
            const verdict = await ask("verify", { passages: grounding, beats: beats() }, job);
            return verdict.ok ? verdict : rewrite(verdict.problems.join("; "), false, "verify");
          },
        },
        {
          file: "narration.json",
          run: async () => {
            // The Lexicon as the file has it now, so a Respelling the Learner tuned reaches the next Clip, and a
            // regenerate, without a restart. A regenerate parks on a broken file, so the Learner sees their edit failed.
            const narration = await narrate(media, beats(), dir, lexicon(language, !!regenerated).terms, language);
            // A Clip runs at most 60 s; over that, the script is rewritten shorter and verified again.
            const overMs = narration.durationMs - LIMIT.clipMs;
            if (overMs <= 0) return narration;
            // Rounded up to a tenth of a second, so cutting what it says is always enough.
            const cut = `cut ${Math.ceil(overMs / LIMIT.tenthMs) / 10} s`;
            // A regenerate keeps its script, so it parks instead.
            if (regenerated) throw new Error(`Over 60 s with the current lexicon: ${cut}`);
            return rewrite(cut, true, "duration");
          },
        },
        {
          file: "scene.json",
          run: () => ask("scene", { beats: beats(), words: narration().words }, job),
        },
        {
          file: "clip.mp4",
          run: async () => {
            let { tsx } = read<Output<"scene">>(dir, "scene.json");
            const script = beats();
            const spoken = narration();
            for (let resent = 0; ; resent++) {
              try {
                await media.render({ tsx, narration: spoken }, join(dir, "clip.mp4"));
                return;
              } catch (error) {
                // A harness failure isn't the scene's: it parks the job, keeping the scene for a retry.
                if (!(error instanceof SceneError)) throw error;
                // Re-sent with its error up to 2×; then the job goes back to the queue for a fresh scene.
                if (resent === 2) {
                  rmSync(join(dir, "scene.json"));
                  throw new SceneFailed(String(error));
                }
                ({ tsx } = await ask(
                  "scene",
                  { beats: script, words: spoken.words, fix: { tsx, error: String(error) } },
                  job,
                ));
                // Checkpointed, so a crash mid-retry resumes with the corrected scene.
                writeFileSync(join(dir, "scene.json"), JSON.stringify({ tsx }));
              }
            }
          },
        },
      ].filter((stage) => !regenerated || !["script.json", "verify.json"].includes(stage.file)),
      finish(tx) {
        if (regenerated) {
          // A new name, so no cache on the phone serves the old mp4 under its URL. The Clip row keeps its id, so its
          // events stay attached, and it is back in the Feed as unseen.
          const file = join(home, "clips", `${concept.id}-${angle}-${job.id}.mp4`);
          tx.update(clips).set({ file, hidden: false, lastSeenAt: null }).where(eq(clips.id, regenerated.id)).run();
          tx.update(events)
            .set({ resolvedAt: new Date() })
            .where(and(eq(events.clipId, regenerated.id), eq(events.kind, "flag"), isNull(events.resolvedAt)))
            .run();
          renameSync(join(dir, "clip.mp4"), file);
          // The old mp4 goes only once the row points at the new one.
          return () => rmSync(regenerated.file, { force: true });
        }
        const script = beats();
        // Named after its job too, so Clips of one Concept and Angle in several Languages never share a file.
        const file = join(home, "clips", `${concept.id}-${angle}-${job.id}.mp4`);
        const caption = script.map((beat) => beat.speech).join(" ");
        tx.insert(clips)
          .values({
            conceptId: concept.id,
            angle,
            language,
            script: JSON.stringify(script),
            caption,
            file,
          })
          .run();
        // Moved last, so a failed insert leaves the mp4 in the job folder instead of orphaned in clips.
        renameSync(join(dir, "clip.mp4"), file);
      },
    };
  }

  const plans = {
    extract_chapter: extraction,
    new: clip,
    new_angle: clip,
    regenerate: clip,
    translate: clip,
  };

  return {
    /**
     * The Languages the worker needs a voice for: the Language of new Clips and every queued or running job's.
     */
    languages() {
      const queued = db
        .selectDistinct({ language: jobs.language })
        .from(jobs)
        .where(and(inArray(jobs.status, ["queued", "running"]), isNotNull(jobs.language)))
        .all();
      return [...new Set([config().worker.language, ...queued.map((job) => job.language!)])].sort();
    },

    /**
     * Advances the highest-priority job by one stage, resuming at its first missing stage file. A job in one of
     * `voiceless` (Languages whose voice is not installed) waits, and the other jobs run.
     * Returns false when there is nothing to do, during a Worker pause or outside the Run windows,
     * while the queue is paused by a rate limit, or at a usage threshold.
     */
    async tick(voiceless: Language[] = []) {
      // A Worker pause, being outside every Run window, a rate-limit pause or a usage threshold starts no stage;
      // a stage already running has finished. One read per tick, so the whole tick sees one config.
      const { worker } = config();
      if (gates({ db }, worker, new Date()).length) return false;
      const [{ clipsToday }] = db
        .select({ clipsToday: count() })
        .from(clips)
        .where(gte(clips.createdAt, new Date(new Date().setHours(0, 0, 0, 0))))
        .all();
      fillBufferGap(clipsToday, worker);
      // The same count and test as the 🌐 sheet's in translations.ts: change both together.
      const capped = clipsToday >= worker.dailyClipCap;
      // A job without a Language needs no voice, unless it is a new Clip job, which takes the Language of new Clips.
      // Only the pick skips them: fillBufferGap still counts them, so the buffer does not refill past its target.
      const voiced = voiceless.length
        ? or(
            notInArray(jobs.language, voiceless),
            and(
              isNull(jobs.language),
              voiceless.includes(worker.language) ? notInArray(jobs.kind, ["new", "new_angle"]) : undefined,
            ),
          )
        : undefined;
      const picked = db
        .select()
        .from(jobs)
        // At the cap only extraction and regenerates run, which add no Clip.
        .where(and(runnable(), voiced, capped ? inArray(jobs.kind, ["extract_chapter", "regenerate"]) : undefined))
        // A job left running by a crash goes first; a requeued Clip job goes after fresh ones of its priority,
        // while chapters stay in Source order.
        .orderBy(
          desc(sql`${jobs.status} = 'running'`),
          desc(jobs.priority),
          asc(sql`case when ${jobs.kind} = 'extract_chapter' then 0 else ${jobs.attempts} end`),
          asc(jobs.id),
        )
        .get();
      if (!picked) return false;
      // A new Clip job takes the Language of new Clips when it first starts: a queued one follows a switch, and a
      // started, resumed or retried one keeps its own. A regenerate has its Clip's from the start, a translate job its
      // target.
      const job = {
        ...picked,
        language: picked.language ?? (picked.kind === "new" || picked.kind === "new_angle" ? worker.language : null),
      };

      const dir = join(home, "jobs", String(job.id));
      mkdirSync(dir, { recursive: true });
      const { stages, finish } = plans[job.kind](job, dir);
      const next = stages.find((stage) => !existsSync(join(dir, stage.file)));
      // Only a job still running is updated: one paused or cancelled while its stage ran stays so.
      const stillRunning = and(eq(jobs.id, job.id), eq(jobs.status, "running"));
      // A job cancelled since it was picked (the server deletes its chapter or Concept) does not start.
      const started = db
        .update(jobs)
        .set({ status: "running", language: job.language })
        .where(and(eq(jobs.id, job.id), inArray(jobs.status, ["queued", "running"])))
        .returning()
        .get();
      if (!started) return true;
      try {
        if (next) {
          // The stage as the Learner names it: the render writes the Clip itself.
          const stage = next.file === "clip.mp4" ? "render" : next.file.replace(".json", "");
          publishStage({ db }, { jobId: job.id, stage, startedAt: new Date() });
          const output = await next.run();
          // Written atomically, so a crash never leaves a half-written checkpoint.
          if (output !== undefined) {
            writeFileSync(join(dir, `${next.file}.tmp`), JSON.stringify(output));
            renameSync(join(dir, `${next.file}.tmp`), join(dir, next.file));
          }
          db.update(jobs).set({ stage: next.file }).where(stillRunning).run();
        } else {
          const committed = db.transaction((tx) => {
            // A job cancelled since its last stage writes nothing, and keeps its stage files for a Restore to resume.
            if (!tx.update(jobs).set({ status: "done" }).where(stillRunning).returning().get()) return undefined;
            return { after: finish(tx) };
          });
          if (committed) {
            committed.after?.();
            rmSync(dir, { recursive: true });
          }
        }
      } catch (error) {
        // Rate-limited: the queue pauses and the attempt isn't counted.
        if (error instanceof RateLimited) {
          db.update(jobs)
            .set({ status: "queued", lastError: String(error) })
            .where(stillRunning)
            .run();
          return true;
        }
        // A failed scene requeues its job up to 5×; a failed agent call or extraction retries up to 2×,
        // except one whose every anchor was dropped; anything else (a script still failing its gates, a render
        // failing outside the scene) parks the job.
        const retries =
          error instanceof SceneFailed
            ? LIMIT.sceneRetries
            : error instanceof AnchorsNotFound
              ? 0
              : error instanceof AgentFailed || job.kind === "extract_chapter"
                ? 2
                : 0;
        const requeue = job.attempts < retries;
        db.update(jobs)
          .set({ status: requeue ? "queued" : "stuck", attempts: job.attempts + 1, lastError: String(error) })
          .where(stillRunning)
          .run();
      } finally {
        publishStage({ db }, null);
      }
      return true;
    },
  };
}
