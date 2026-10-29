import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { eq } from "drizzle-orm";
import type { Agent, AgentStages } from "./agent.ts";
import { type Config, openData } from "./data.ts";
import { createFeed } from "./feed.ts";
import { createInbox } from "./inbox.ts";
import { type Media, Refused } from "./media.ts";
import { createPipeline } from "./pipeline.ts";
import { type Angle, agentCalls, chapters, clips, concepts, events, jobs, sources } from "./schema.ts";
import { createSources } from "./sources.ts";
import { editConfig, fakeAgent, fakeMedia } from "./test/fakes.ts";
import { createTranslations } from "./translations.ts";

/**
 * A temp DOOMLEARN_HOME with `config` as its worker settings, and a folder to write Source files into.
 */
async function setup(config: Partial<Config["worker"]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: config }));
  const data = openData(home);
  return {
    data,
    home,
    async file(name: string, text: string) {
      await writeFile(join(dir, name), text);
      return join(dir, name);
    },
  };
}

/**
 * A fake Agent whose extraction turns each line of a chapter into a Concept titled with that line, fitting `angles`,
 * attaching it to an existing Concept of the same title instead, and fails on a chapter containing "BROKEN".
 */
function lineAgent(angles: Angle[] = ["analogy"]): Agent {
  const fake = fakeAgent();
  return {
    run: async (stage, input, served) => {
      if (stage !== "extract") return fake.run(stage, input, served);
      const { chapter, concepts: known } = input as AgentStages["extract"]["input"];
      if (chapter.includes("BROKEN")) return { ok: false, error: "extraction failed: no Concepts found" };
      const output: AgentStages["extract"]["output"] = { new: [], attach: [] };
      for (const line of chapter.split("\n").filter(Boolean)) {
        const existing = known.find((concept) => concept.title === line);
        if (existing) output.attach.push({ conceptId: existing.id, anchor: { chapter: line } });
        else output.new.push({ title: line, summary: line, angles, anchor: { chapter: line } });
      }
      return { ok: true, output: output as never };
    },
  };
}

test("the title comes from the Source metadata, and --title overrides it", async () => {
  const { data, file } = await setup();
  const media = {
    ...fakeMedia(),
    convert: async () => ({ title: "Operating Systems", chapters: [{ title: "Threads", text: "A thread.\n" }] }),
  };
  const sourcesModule = createSources(data, media);

  assert.equal((await sourcesModule.add(await file("ostep.pdf", "one"))).title, "Operating Systems");
  assert.equal((await sourcesModule.add(await file("ostep2.pdf", "two"), { title: "OSTEP" })).title, "OSTEP");
});

test("a byte-identical re-add is refused as a duplicate and nothing is stored", async () => {
  const { data, home, file } = await setup();
  const sourcesModule = createSources(data, fakeMedia());
  const original = await sourcesModule.add(await file("threads.md", "# Threads\nA thread.\n"));

  await assert.rejects(
    sourcesModule.add(await file("copy.md", "# Threads\nA thread.\n")),
    (error) => error instanceof Refused && /^Already added: threads \(\d{4}-\d\d-\d\d\)$/.test(error.message),
  );
  assert.deepEqual(
    data.db
      .select()
      .from(sources)
      .all()
      .map((source) => source.id),
    [original.id],
  );
  assert.deepEqual(readdirSync(join(home, "sources")), [String(original.id)]);
});

test("a Source the converter refuses (scanned, DRM) is refused with its reason and nothing is stored", async () => {
  const { data, home, file } = await setup();
  for (const reason of [
    "Scanned PDF: 2 of 3 pages have no text layer",
    "DRM-protected ebook: its MOBI header is encrypted",
  ]) {
    const media = {
      ...fakeMedia(),
      convert: async () => {
        throw new Refused(reason);
      },
    };
    await assert.rejects(
      createSources(data, media).add(await file(`${reason.length}.pdf`, reason)),
      new Refused(reason),
    );
  }
  assert.deepEqual(data.db.select().from(sources).all(), []);
  assert.deepEqual(data.db.select().from(jobs).all(), []);
  assert.deepEqual(readdirSync(join(home, "sources")), []);
});

test("status shows per-Source progress with stuck chapters, and the queue line", async () => {
  const { data, file } = await setup({ bufferTarget: 4, dailyClipCap: 6 });
  const media = fakeMedia({
    chapters: [
      { title: "Threads", text: "Thread\nProcess\n" },
      { title: "Locks", text: "BROKEN\n" },
    ],
  });
  const sourcesModule = createSources(data, media);
  const source = await sourcesModule.add(await file("ostep.md", "ostep"));
  const pipeline = createPipeline(data, lineAgent(), fakeMedia());
  while (await pipeline.tick());

  const stuck = data.db.select().from(jobs).where(eq(jobs.status, "stuck")).get()!;
  assert.deepEqual(sourcesModule.status(), {
    sources: [
      {
        id: source.id,
        title: "ostep",
        status: "active",
        chapters: { done: 1, total: 2 },
        concepts: 2,
        stuck: [
          {
            jobId: stuck.id,
            chapter: { seq: 1, title: "Locks" },
            attempts: stuck.attempts,
            lastError: stuck.lastError,
          },
        ],
      },
    ],
    queue: { pausedUntil: undefined, buffer: { clips: 2, target: 4 }, today: { clips: 2, cap: 6 } },
  });
  assert.match(stuck.lastError!, /no Concepts found/);

  const retryAt = new Date(Date.now() + 60_000);
  data.db
    .insert(agentCalls)
    .values({ stage: "script", durationMs: 1, isError: true, apiErrorStatus: 429, retryAt, at: new Date() })
    .run();
  assert.deepEqual(sourcesModule.status().queue.pausedUntil, retryAt);
});

test("retry requeues a stuck job with its attempts reset, and only a stuck one", async () => {
  const { data, file } = await setup();
  let broken = true;
  const agent: Agent = {
    run: (stage, input, served) =>
      broken && stage === "extract"
        ? Promise.resolve({ ok: false, error: "boom" })
        : lineAgent().run(stage, input, served),
  };
  const sourcesModule = createSources(data, fakeMedia({ chapters: [{ title: "Threads", text: "Thread\n" }] }));
  await sourcesModule.add(await file("ostep.md", "ostep"));
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());
  const job = data.db.select().from(jobs).where(eq(jobs.status, "stuck")).get()!;
  assert.ok(job.attempts > 0);

  sourcesModule.retry(job.id);
  const requeued = data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.attempts, 0);
  assert.throws(() => sourcesModule.retry(job.id), /not stuck/);

  broken = false;
  while (await pipeline.tick());
  assert.deepEqual(sourcesModule.status().sources[0].chapters, { done: 1, total: 1 });
});

test("pausing a Source stops its extraction, and resume continues from the next unextracted chapter", async () => {
  const { data, file } = await setup();
  const sourcesModule = createSources(
    data,
    fakeMedia({
      chapters: [
        { title: "Threads", text: "Thread\n" },
        { title: "Locks", text: "Lock\n" },
      ],
    }),
  );
  const source = await sourcesModule.add(await file("ostep.md", "ostep"));
  const agent = fakeAgent();
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (!sourcesModule.status().sources[0].chapters.done) await pipeline.tick();

  sourcesModule.pause(source.id);
  while (await pipeline.tick());
  const [status] = sourcesModule.status().sources;
  assert.equal(status.status, "paused");
  assert.deepEqual(status.chapters, { done: 1, total: 2 });

  sourcesModule.resume(source.id);
  while (await pipeline.tick());
  assert.equal(agent.calls.filter((stage) => stage === "extract").length, 2);
  assert.deepEqual(sourcesModule.status().sources[0].chapters, { done: 2, total: 2 });
});

test("pausing a Source parks its stuck chapters too, and resume retries them with attempts reset", async () => {
  const { data, file } = await setup();
  let broken = true;
  const agent: Agent = {
    run: (stage, input, served) =>
      broken && stage === "extract"
        ? Promise.resolve({ ok: false, error: "boom" })
        : lineAgent().run(stage, input, served),
  };
  const sourcesModule = createSources(data, fakeMedia({ chapters: [{ title: "Threads", text: "Thread\n" }] }));
  const source = await sourcesModule.add(await file("ostep.md", "ostep"));
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());
  const job = data.db.select().from(jobs).where(eq(jobs.status, "stuck")).get()!;

  sourcesModule.pause(source.id);
  assert.throws(() => sourcesModule.retry(job.id), /not stuck/);

  broken = false;
  sourcesModule.resume(source.id);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.attempts, 0);
  while (await pipeline.tick());
  assert.deepEqual(sourcesModule.status().sources[0].chapters, { done: 1, total: 1 });
});

test("a Source paused while its extraction call runs stays paused when the call fails", async () => {
  const { data, file } = await setup();
  const sourcesModule = createSources(data, fakeMedia({ chapters: [{ title: "Threads", text: "Thread\n" }] }));
  const source = await sourcesModule.add(await file("ostep.md", "ostep"));
  const agent: Agent = {
    run: async () => {
      sourcesModule.pause(source.id);
      return { ok: false, error: "boom" };
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  assert.deepEqual(data.db.select({ status: jobs.status }).from(jobs).all(), [{ status: "paused" }]);
});

test("a paused Source stops Clips for Concepts only it teaches, but not for one an active Source also teaches", async () => {
  // At a daily cap of 0 only extraction runs, so both Sources are extracted before any Clip.
  const { data, home, file } = await setup({ dailyClipCap: 0 });
  const paused = await createSources(data, fakeMedia({ chapters: [{ title: "A", text: "Only in A\nShared\n" }] })).add(
    await file("a.md", "a"),
  );
  await createSources(data, fakeMedia({ chapters: [{ title: "B", text: "Shared\n" }] })).add(await file("b.md", "b"));
  const extracting = createPipeline(data, lineAgent(), fakeMedia());
  while (await extracting.tick());
  createSources(data, fakeMedia()).pause(paused.id);

  await writeFile(join(home, "config.json"), JSON.stringify({}));
  const reopened = openData(home);
  const pipeline = createPipeline(reopened, lineAgent(), fakeMedia());
  while (await pipeline.tick());
  const clipped = () =>
    reopened.db
      .select({ title: concepts.title })
      .from(clips)
      .innerJoin(concepts, eq(clips.conceptId, concepts.id))
      .all()
      .map((row) => row.title);
  assert.deepEqual(clipped(), ["Shared"]);

  createSources(reopened, fakeMedia()).resume(paused.id);
  while (await pipeline.tick());
  assert.deepEqual(clipped().sort(), ["Only in A", "Shared"]);
});

test("a Clip job held by a pause runs once an active Source also teaches its Concept", async () => {
  const { data, file } = await setup();
  const paused = await createSources(data, fakeMedia({ chapters: [{ title: "A", text: "Thread\n" }] })).add(
    await file("a.md", "a"),
  );
  const pipeline = createPipeline(data, lineAgent(), fakeMedia());
  while (!data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()) await pipeline.tick();
  createSources(data, fakeMedia()).pause(paused.id);

  await createSources(data, fakeMedia({ chapters: [{ title: "B", text: "Thread\n" }] })).add(await file("b.md", "b"));
  while (await pipeline.tick());
  assert.equal(data.db.select().from(concepts).all().length, 1);
  assert.equal(data.db.select().from(clips).all().length, 1);
});

test("pausing a Source holds a Clip job already queued for a Concept only it teaches, and resume picks it up", async () => {
  const { data, file } = await setup();
  const sourcesModule = createSources(data, fakeMedia({ chapters: [{ title: "Threads", text: "Thread\n" }] }));
  const source = await sourcesModule.add(await file("ostep.md", "ostep"));
  const agent = fakeAgent();
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (!agent.calls.includes("script")) await pipeline.tick();

  sourcesModule.pause(source.id);
  while (await pipeline.tick());
  assert.deepEqual(data.db.select().from(clips).all(), []);

  sourcesModule.resume(source.id);
  while (await pipeline.tick());
  assert.equal(data.db.select().from(clips).all().length, 1);
  // It resumed at its next stage instead of starting over.
  assert.equal(agent.calls.filter((stage) => stage === "script").length, 1);
});

test("reconvert replaces the chapters of a Source without Concepts from its stored original, and queues their extraction", async () => {
  const { data, home, file } = await setup();
  const source = await createSources(data, fakeMedia({ chapters: [{ title: "Beginning", text: "Everything\n" }] })).add(
    await file("clean.md", "clean"),
  );
  const [old] = data.db.update(jobs).set({ status: "done" }).returning().all();
  data.db
    .insert(agentCalls)
    .values({ stage: "extract", jobId: old.id, sourceId: source.id, durationMs: 1, isError: false, at: new Date() })
    .run();
  let convertedWith: string[] = [];
  const media = {
    ...fakeMedia(),
    convert: async (...args: string[]) => {
      convertedWith = args;
      return {
        chapters: [
          { title: "Threads", text: "Thread\n" },
          { title: "Locks", text: "Lock\n" },
        ],
      };
    },
  };
  const sourcesModule = createSources(data, media);

  assert.equal(await sourcesModule.reconvert(source.id), 2);
  const dir = join(home, "sources", String(source.id));
  assert.deepEqual(convertedWith, [join(dir, "original.md"), "clean"]);
  assert.deepEqual(readdirSync(join(dir, "chapters")).sort(), ["0.txt", "1.txt"]);
  assert.equal(readFileSync(join(dir, "chapters", "1.txt"), "utf8"), "Lock\n");
  assert.deepEqual(
    data.db
      .select({ kind: jobs.kind, status: jobs.status, chapter: chapters.title })
      .from(jobs)
      .innerJoin(chapters, eq(jobs.chapterId, chapters.id))
      .orderBy(chapters.seq)
      .all(),
    [
      { kind: "extract_chapter", status: "queued", chapter: "Threads" },
      { kind: "extract_chapter", status: "queued", chapter: "Locks" },
    ],
  );
  // The old extraction's Claude call still counts for the Source.
  assert.deepEqual(data.db.select({ jobId: agentCalls.jobId, sourceId: agentCalls.sourceId }).from(agentCalls).all(), [
    { jobId: null, sourceId: source.id },
  ]);

  const pipeline = createPipeline(data, lineAgent(), fakeMedia());
  while (await pipeline.tick());
  assert.equal(sourcesModule.status().sources[0].concepts, 2);
});

test("reconvert keeps a Paused Source paused: its new chapters wait for resume", async () => {
  const { data, file } = await setup();
  const sourcesModule = createSources(data, fakeMedia());
  const source = await sourcesModule.add(await file("clean.md", "clean"));
  sourcesModule.pause(source.id);

  await sourcesModule.reconvert(source.id);
  assert.deepEqual(data.db.select({ status: jobs.status }).from(jobs).all(), [{ status: "paused" }]);
});

test("reconvert refuses a Source that has Concepts, and leaves it as it was", async () => {
  const { data, file } = await setup();
  const sourcesModule = createSources(data, fakeMedia({ chapters: [{ title: "Threads", text: "Thread\n" }] }));
  const source = await sourcesModule.add(await file("ostep.md", "ostep"));
  const pipeline = createPipeline(data, lineAgent(), fakeMedia());
  while (await pipeline.tick());
  const before = data.db.select().from(chapters).all();

  await assert.rejects(
    sourcesModule.reconvert(source.id),
    new Error(`Source #${source.id} has 1 Concepts: reconverting it would lose them`),
  );
  await assert.rejects(sourcesModule.reconvert(999), new Error("No Source #999"));
  assert.deepEqual(data.db.select().from(chapters).all(), before);
});

//
// Pausing and deleting chapters and Concepts
//

/**
 * One day, in ms.
 */
const DAY = 86_400_000;

/**
 * A temp DOOMLEARN_HOME with a Source (`book.md`) whose chapters `ch0`, `ch1`, … are `texts`, each line a Concept that
 * fits two Angles, at a daily cap of 0, so `drain` extracts the chapters but makes no Clip until `lift` raises the cap.
 * The pipeline runs on `media`.
 */
async function book(
  texts: string[],
  { media = fakeMedia() as Media, ...config }: Partial<Config["worker"]> & { media?: Media } = {},
) {
  const { data, home, file } = await setup({ ...config, dailyClipCap: 0 });
  const sourcesModule = createSources(
    data,
    fakeMedia({ chapters: texts.map((text, seq) => ({ title: `ch${seq}`, text })) }),
  );
  const source = await sourcesModule.add(await file("book.md", "book"));
  const pipeline = createPipeline(data, lineAgent(["analogy", "mechanism"]), media);
  const concept = (title: string) => data.db.select().from(concepts).where(eq(concepts.title, title)).get()!;
  return {
    data,
    file,
    pipeline,
    sourcesModule,
    chapterRows: data.db.select().from(chapters).where(eq(chapters.sourceId, source.id)).orderBy(chapters.seq).all(),
    async drain() {
      while (await pipeline.tick());
    },
    lift: (worker: Partial<Config["worker"]> = {}) => editConfig(home, { worker: { ...config, ...worker } }),
    concept,
    /**
     * The first Clip of Concept `title`.
     */
    clipOf: (title: string) =>
      data.db
        .select()
        .from(clips)
        .where(eq(clips.conceptId, concept(title).id))
        .get()!,
    /**
     * Every Clip, as `<Concept> <Angle> <Language>`, sorted.
     */
    made: () =>
      data.db
        .select({ title: concepts.title, angle: clips.angle, language: clips.language })
        .from(clips)
        .innerJoin(concepts, eq(clips.conceptId, concepts.id))
        .all()
        .map((row) => `${row.title} ${row.angle} ${row.language}`)
        .sort(),
    /**
     * The Source screen's Concepts by title, from every chapter, with whether each is Deleted.
     */
    deleted: (sourceId = source.id) =>
      Object.fromEntries(
        sourcesModule
          .source(sourceId)!
          .chapters.flatMap((chapter) => chapter.concepts)
          .map((row) => [row.title, row.deleted]),
      ),
  };
}

test("a Paused Concept and a Paused chapter get no new-Concept Clip while their Reviews, 🤔 new-Angle Clips and Translations go on; an unextracted Paused chapter waits; Resume lifts both", async () => {
  const { chapterRows, clipOf, concept, data, drain, lift, made, sourcesModule } = await book([
    "Alpha\nAlef\n",
    "Beta\nBet\n",
    "Gamma\n",
  ]);
  const [, ch1, ch2] = chapterRows;
  sourcesModule.chapter(ch2.id, "pause");
  await drain();
  sourcesModule.concept(concept("Alef").id, "pause");
  sourcesModule.concept(concept("Bet").id, "pause");
  await lift({ dailyClipCap: 15 });
  await drain();
  assert.deepEqual(made(), ["Alpha analogy pt-BR", "Beta analogy pt-BR"]);

  // Alpha is Paused by hand and Beta through its chapter; Bet is resumed by hand but its chapter is Paused.
  sourcesModule.concept(concept("Alpha").id, "pause");
  sourcesModule.chapter(ch1.id, "pause");
  sourcesModule.concept(concept("Bet").id, "resume");
  const now = Date.now();
  const feed = createFeed(data, () => new Date(now));
  feed.press(clipOf("Alpha").id, "didnt_get", randomUUID());
  feed.press(clipOf("Beta").id, "didnt_get", randomUUID());
  createTranslations(data).queue(clipOf("Alpha").id, "en");
  createTranslations(data).queue(clipOf("Beta").id, "en");
  await drain();
  assert.deepEqual(made(), [
    "Alpha analogy en",
    "Alpha analogy pt-BR",
    "Alpha mechanism pt-BR",
    "Beta analogy en",
    "Beta analogy pt-BR",
    "Beta mechanism pt-BR",
  ]);
  assert.equal(data.db.select().from(chapters).where(eq(chapters.id, ch2.id)).get()!.status, "pending");
  // Their Reviews come up as due, with no shift for the pause.
  const later = createFeed(data, () => new Date(now + DAY));
  assert.deepEqual(
    later.next().map((slot) => [slot.kind, slot.concept.title]),
    [
      ["review", "Alpha"],
      ["review", "Beta"],
    ],
  );

  sourcesModule.concept(concept("Alpha").id, "resume");
  sourcesModule.concept(concept("Alef").id, "resume");
  sourcesModule.chapter(ch1.id, "resume");
  sourcesModule.chapter(ch2.id, "resume");
  await drain();
  assert.deepEqual(
    made().filter((clip) => clip.endsWith("analogy pt-BR")),
    ["Alef analogy pt-BR", "Alpha analogy pt-BR", "Bet analogy pt-BR", "Beta analogy pt-BR", "Gamma analogy pt-BR"],
  );
});

test("a Deleted Concept leaves the Feed, its Reviews, the buffer fill, Search, the Inbox and the Feed counts", async () => {
  const { clipOf, concept, data, drain, lift, made, sourcesModule } = await book(["Fresh\nDue\nFlagged\nKept\n"], {
    bufferTarget: 3,
  });
  await drain();
  sourcesModule.concept(concept("Kept").id, "pause");
  await lift({ dailyClipCap: 15 });
  await drain();
  const now = Date.now();
  const feed = createFeed(data, () => new Date(now));
  feed.seen(clipOf("Due").id, randomUUID(), { completed: true });
  data.db
    .update(concepts)
    .set({ notLandingAt: new Date(now) })
    .where(eq(concepts.id, concept("Due").id))
    .run();
  feed.press(clipOf("Flagged").id, "flag", randomUUID(), { reason: "wrong" });
  data.db
    .insert(jobs)
    .values({ kind: "new_angle", priority: 2, status: "stuck", conceptId: concept("Due").id, angle: "mechanism" })
    .run();
  const later = createFeed(data, () => new Date(now + DAY));
  const inbox = createInbox(data);
  /**
   * What each reader shows, by Concept title.
   */
  const shown = () => ({
    feed: later.next().map((slot) => [slot.kind, slot.concept.title]),
    search: later
      .search("thread")
      .map((hit) => hit.concept.title)
      .sort(),
    flags: inbox.list().flags.map((flag) => flag.concept.title),
    notLanding: inbox.list().notLanding.map((row) => row.concept.title),
    stuck: inbox.list().stuck.map((row) => row.concept?.title),
    ready: later.today().buffer.ready,
    dueTomorrow: later.today().dueTomorrow,
    buffered: sourcesModule.status().queue.buffer.clips,
  });
  assert.deepEqual(shown(), {
    feed: [
      ["new", "Fresh"],
      ["review", "Due"],
    ],
    search: ["Due", "Fresh"],
    flags: ["Flagged"],
    notLanding: ["Due"],
    stuck: ["Due"],
    ready: 1,
    dueTomorrow: 1,
    buffered: 1,
  });

  for (const title of ["Fresh", "Due", "Flagged"]) sourcesModule.concept(concept(title).id, "delete");
  assert.deepEqual(shown(), {
    feed: [],
    search: [],
    flags: [],
    notLanding: [],
    stuck: [],
    ready: 0,
    dueTomorrow: 0,
    buffered: 0,
  });
  // Fresh's unseen Clip no longer fills the buffer of 1, so Kept gets its Clip.
  await lift({ dailyClipCap: 15, bufferTarget: 1 });
  sourcesModule.concept(concept("Kept").id, "resume");
  await drain();
  assert.ok(made().includes("Kept analogy pt-BR"));
});

test("deleting a chapter takes only the Concepts no other live chapter or Source teaches, and cancels their Clip jobs and its waiting extraction; a cancelled job never runs", async () => {
  const { chapterRows, concept, data, deleted, drain, file, lift, made, pipeline, sourcesModule } = await book([
    "Solo\nShared\nCross\n",
    "Shared\n",
    "Later\n",
  ]);
  const [ch0, , ch2] = chapterRows;
  await createSources(data, fakeMedia({ chapters: [{ title: "paper", text: "Cross\n" }] })).add(
    await file("paper.md", "paper"),
  );
  sourcesModule.chapter(ch2.id, "delete");
  await drain();
  await lift({ dailyClipCap: 15 });
  // Solo, first in seq order, has its Clip job started.
  const soloJob = () =>
    data.db
      .select()
      .from(jobs)
      .where(eq(jobs.conceptId, concept("Solo").id))
      .get();
  for (let ticks = 0; soloJob()?.status !== "running"; ticks++) {
    assert.ok(ticks < 20, "Solo's Clip job never started");
    await pipeline.tick();
  }
  const started = soloJob()!;

  sourcesModule.chapter(ch0.id, "delete");
  await drain();

  assert.deepEqual(deleted(), { Solo: true, Shared: false, Cross: false });
  assert.deepEqual(made(), ["Cross analogy pt-BR", "Shared analogy pt-BR"]);
  assert.deepEqual(
    data.db
      .select({ kind: jobs.kind, status: jobs.status, cancelledBy: jobs.cancelledBy })
      .from(jobs)
      .where(eq(jobs.status, "cancelled"))
      .orderBy(jobs.id)
      .all(),
    [
      { kind: "extract_chapter", status: "cancelled", cancelledBy: `chapter:${ch2.id}` },
      { kind: "new", status: "cancelled", cancelledBy: `chapter:${ch0.id}` },
    ],
  );
  assert.equal(concept("Later"), undefined);
  // It stopped at the stage it was running: no stage after the script ran.
  assert.equal(soloJob()!.stage, started.stage);
  assert.equal(started.stage, "script.json");
});

test("a job cancelled during a fake-media stage stays cancelled, writes no Clip and keeps its stage files", async () => {
  let deleteDuringRender = () => {};
  const media = fakeMedia();
  const { concept, data, drain, lift, made, sourcesModule } = await book(["Alpha\n"], {
    media: {
      ...media,
      render: async (scene, out) => {
        deleteDuringRender();
        await media.render(scene, out);
      },
    },
  });
  await drain();
  deleteDuringRender = () => sourcesModule.concept(concept("Alpha").id, "delete");
  await lift({ dailyClipCap: 15 });
  await drain();

  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.deepEqual([job.status, job.cancelledBy], ["cancelled", `concept:${concept("Alpha").id}`]);
  assert.deepEqual(made(), []);
  assert.ok(existsSync(join(data.home, "jobs", String(job.id), "clip.mp4")));
});

test("Restore requeues the cancelled jobs whose chapter or Concept is live again and brings the ladder back as it was; a chapter's Restore leaves a Concept deleted by hand Deleted", async () => {
  const { chapterRows, clipOf, concept, data, deleted, drain, lift, made, sourcesModule } = await book([
    "Alpha\nHand\n",
    "Beta\n",
  ]);
  const [ch0, ch1] = chapterRows;
  await drain();
  await lift({ dailyClipCap: 15 });
  await drain();
  const feed = createFeed(data);
  feed.seen(clipOf("Alpha").id, randomUUID(), { completed: true });
  const ladder = () => {
    const { status, ladderStep, dueAt } = concept("Alpha");
    return { status, ladderStep, dueAt };
  };
  const before = ladder();
  const translations = createTranslations(data);
  for (const title of ["Alpha", "Hand", "Beta"]) translations.queue(clipOf(title).id, "en");

  sourcesModule.concept(concept("Hand").id, "delete");
  sourcesModule.chapter(ch0.id, "delete");
  sourcesModule.chapter(ch1.id, "delete");
  assert.deepEqual(deleted(), { Alpha: true, Hand: true, Beta: true });
  sourcesModule.chapter(ch0.id, "restore");
  assert.deepEqual(deleted(), { Alpha: false, Hand: true, Beta: true });
  /**
   * Each translate job's Concept and status.
   */
  const translateJobs = () =>
    data.db
      .select({ title: concepts.title, status: jobs.status, cancelledBy: jobs.cancelledBy })
      .from(jobs)
      .innerJoin(concepts, eq(jobs.conceptId, concepts.id))
      .where(eq(jobs.kind, "translate"))
      .orderBy(jobs.id)
      .all();
  assert.deepEqual(translateJobs(), [
    { title: "Alpha", status: "queued", cancelledBy: null },
    { title: "Hand", status: "cancelled", cancelledBy: `concept:${concept("Hand").id}` },
    { title: "Beta", status: "cancelled", cancelledBy: `chapter:${ch1.id}` },
  ]);
  assert.deepEqual(ladder(), before);
  await drain();
  assert.deepEqual(
    made().filter((clip) => clip.endsWith(" en")),
    ["Alpha analogy en"],
  );

  sourcesModule.concept(concept("Hand").id, "restore");
  await drain();
  assert.deepEqual(
    made().filter((clip) => clip.endsWith(" en")),
    ["Alpha analogy en", "Hand analogy en"],
  );
});

test("restoring an unextracted chapter requeues its extraction with its attempts reset, paused while its Source is Paused", async () => {
  const { chapterRows, data, deleted, drain, sourcesModule } = await book(["Alpha\n", "Beta\n", "Gamma\n"]);
  const [, ch1, ch2] = chapterRows;
  /**
   * The extraction job of chapter `chapterId`.
   */
  const extraction = (chapterId: number) =>
    data.db
      .select({ status: jobs.status, attempts: jobs.attempts, cancelledBy: jobs.cancelledBy })
      .from(jobs)
      .where(eq(jobs.chapterId, chapterId))
      .get();
  sourcesModule.pause(ch2.sourceId);
  data.db.update(jobs).set({ attempts: 2 }).where(eq(jobs.chapterId, ch2.id)).run();
  sourcesModule.chapter(ch2.id, "delete");
  assert.deepEqual(extraction(ch2.id), { status: "cancelled", attempts: 2, cancelledBy: `chapter:${ch2.id}` });
  sourcesModule.chapter(ch2.id, "restore");
  assert.deepEqual(extraction(ch2.id), { status: "paused", attempts: 0, cancelledBy: null });

  sourcesModule.resume(ch2.sourceId);
  data.db.update(jobs).set({ attempts: 2 }).where(eq(jobs.chapterId, ch1.id)).run();
  sourcesModule.chapter(ch1.id, "delete");
  sourcesModule.chapter(ch1.id, "restore");
  assert.deepEqual(extraction(ch1.id), { status: "queued", attempts: 0, cancelledBy: null });
  await drain();
  assert.deepEqual(deleted(), { Alpha: false, Beta: false, Gamma: false });
});

test("restoring one of two deleted chapters that teach a Concept requeues the job the other chapter's delete cancelled", async () => {
  const { chapterRows, clipOf, data, drain, lift, made, sourcesModule } = await book(["Both\n", "Both\n"]);
  const [ch0, ch1] = chapterRows;
  await drain();
  await lift({ dailyClipCap: 15 });
  await drain();
  createTranslations(data).queue(clipOf("Both").id, "en");
  /**
   * The translate job's status and the delete that cancelled it.
   */
  const translateJob = () =>
    data.db
      .select({ status: jobs.status, cancelledBy: jobs.cancelledBy })
      .from(jobs)
      .where(eq(jobs.kind, "translate"))
      .get();

  sourcesModule.chapter(ch0.id, "delete");
  assert.deepEqual(translateJob(), { status: "queued", cancelledBy: null });
  sourcesModule.chapter(ch1.id, "delete");
  assert.deepEqual(translateJob(), { status: "cancelled", cancelledBy: `chapter:${ch1.id}` });
  sourcesModule.chapter(ch0.id, "restore");
  assert.deepEqual(translateJob(), { status: "queued", cancelledBy: null });
  await drain();
  assert.deepEqual(made(), ["Both analogy en", "Both analogy pt-BR"]);
});

test("a Concept deleted by hand stays Deleted when a new Source teaches it; one that went with its chapter comes back with its ladder, Clips and jobs", async () => {
  const { chapterRows, clipOf, concept, data, deleted, drain, file, lift, made, sourcesModule } = await book([
    "Hand\nWent\n",
  ]);
  const [ch0] = chapterRows;
  await drain();
  await lift({ dailyClipCap: 15 });
  await drain();
  const now = Date.now();
  const feed = createFeed(data, () => new Date(now));
  for (const title of ["Hand", "Went"]) feed.seen(clipOf(title).id, randomUUID(), { completed: true });
  const went = concept("Went");
  createTranslations(data).queue(clipOf("Went").id, "en");
  sourcesModule.concept(concept("Hand").id, "delete");
  sourcesModule.chapter(ch0.id, "delete");

  const paper = await createSources(data, fakeMedia({ chapters: [{ title: "again", text: "Hand\nWent\n" }] })).add(
    await file("again.md", "again"),
  );
  await drain();

  assert.equal(data.db.select().from(concepts).all().length, 2);
  assert.deepEqual(deleted(paper.id), { Hand: true, Went: false });
  assert.deepEqual([concept("Went").ladderStep, concept("Went").dueAt], [went.ladderStep, went.dueAt]);
  assert.deepEqual(made(), ["Hand analogy pt-BR", "Went analogy en", "Went analogy pt-BR"]);
  assert.deepEqual(
    createFeed(data, () => new Date(now + DAY))
      .next()
      .map((slot) => [slot.kind, slot.concept.title, slot.language]),
    [["review", "Went", "pt-BR"]],
  );
});

test("an offline press on a Deleted Concept's Clip is written down and leaves its last seen and the ladder; a 🚩 still hides it after a Restore", async () => {
  const { clipOf, concept, data, drain, lift, sourcesModule } = await book(["Alpha\n"]);
  await drain();
  await lift({ dailyClipCap: 15 });
  await drain();
  const clip = clipOf("Alpha");
  sourcesModule.concept(concept("Alpha").id, "delete");
  const before = concept("Alpha");

  const feed = createFeed(data);
  feed.seen(clip.id, randomUUID(), { completed: true });
  feed.press(clip.id, "didnt_get", randomUUID());
  feed.press(clip.id, "flag", randomUUID(), { reason: "wrong" });

  assert.deepEqual(
    data.db
      .select({ kind: events.kind })
      .from(events)
      .where(eq(events.clipId, clip.id))
      .all()
      .map((row) => row.kind),
    ["seen", "didnt_get", "flag"],
  );
  assert.deepEqual(clipOf("Alpha"), { ...clip, hidden: true });
  assert.deepEqual(concept("Alpha"), before);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.kind, "new_angle")).get(), undefined);

  // Restored, the flagged Clip stays out of the Feed and its 🚩 waits in the Inbox.
  sourcesModule.concept(concept("Alpha").id, "restore");
  assert.ok(!feed.next().some((slot) => slot.clipId === clip.id));
  assert.deepEqual(
    createInbox(data)
      .list()
      .flags.map((flag) => [flag.clipId, flag.reason]),
    [[clip.id, "wrong"]],
  );
});

test("a Favorite stays when its Concept is Deleted, with its Clip and mp4, and says so; one Paused by hand or through its chapter says Paused", async () => {
  const { chapterRows, clipOf, concept, data, drain, lift, sourcesModule } = await book(["Alpha\nHand\n", "Beta\n"]);
  const [ch0, ch1] = chapterRows;
  await drain();
  await lift({ dailyClipCap: 15 });
  await drain();
  const feed = createFeed(data);
  for (const title of ["Alpha", "Hand", "Beta"]) feed.favorite(clipOf(title).id, true);

  sourcesModule.chapter(ch0.id, "delete");
  sourcesModule.chapter(ch0.id, "restore");
  sourcesModule.concept(concept("Alpha").id, "delete");
  sourcesModule.concept(concept("Hand").id, "pause");
  sourcesModule.chapter(ch1.id, "pause");

  assert.deepEqual(
    feed.favorites().map(({ concept }) => [concept.title, concept.deleted, concept.paused]),
    [
      ["Beta", false, true],
      ["Hand", false, true],
      ["Alpha", true, false],
    ],
  );
  const alpha = clipOf("Alpha");
  assert.ok(existsSync(alpha.file));
  sourcesModule.chapter(ch1.id, "delete");
  assert.deepEqual(
    feed.favorites().map(({ concept }) => [concept.title, concept.deleted, concept.paused]),
    [
      ["Beta", true, false],
      ["Hand", false, true],
      ["Alpha", true, false],
    ],
  );
});

test("pausing a Retired Concept is refused, and an unknown chapter or Concept is not found", async () => {
  const { concept, data, deleted, drain, sourcesModule } = await book(["Alpha\n"]);
  await drain();
  data.db.update(concepts).set({ status: "retired", retiredReason: "known" }).run();

  assert.throws(() => sourcesModule.concept(concept("Alpha").id, "pause"), Refused);
  assert.equal(concept("Alpha").pausedAt, null);
  sourcesModule.concept(concept("Alpha").id, "delete");
  assert.deepEqual(deleted(), { Alpha: true });
  assert.throws(() => sourcesModule.concept(999, "delete"), /No Concept #999/);
  assert.throws(() => sourcesModule.chapter(999, "pause"), /No chapter #999/);
});
