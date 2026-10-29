import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Agent, AgentResult, AgentStages, Beat } from "./agent.ts";
import { openData } from "./data.ts";
import { createFeed } from "./feed.ts";
import type { Chapter } from "./media.ts";
import { defaultLexicon } from "./languages.ts";
import { createPipeline } from "./pipeline.ts";
import { chapters, clips, concepts, jobs, passages } from "./schema.ts";
import { createSources } from "./sources.ts";
import { fakeAgent, fakeMedia } from "./test/fakes.ts";

/**
 * A temp DOOMLEARN_HOME, its lexicon file, and a way to add a Source made of `chapters`.
 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const data = openData(join(dir, "home"));
  const lexicon = join(dir, "home", "lexicon.json");
  return {
    data,
    lexicon,
    async add(name: string, chapters: Chapter[]) {
      const file = join(dir, `${name}.md`);
      await writeFile(file, JSON.stringify(chapters));
      return createSources(data, fakeMedia({ chapters })).add(file);
    },
    drain: async (agent: Agent) => {
      const pipeline = createPipeline(data, agent, fakeMedia());
      while (await pipeline.tick());
    },
  };
}

const THREADS: Chapter = { title: "Threads", text: "A thread is one sequence of execution inside a process.\n" };

/**
 * The fake Agent, with `override` replacing a call's result whenever it returns one.
 * Every call is still recorded in `calls` and `inputs`.
 */
function agentWith(
  override: (stage: keyof AgentStages, input: Record<string, unknown>) => AgentResult<unknown> | undefined,
) {
  const fake = fakeAgent();
  const agent: Agent = {
    run: async (stage, input, served) => {
      const result = await fake.run(stage, input, served);
      return (override(stage, input) ?? result) as never;
    },
  };
  return { ...fake, ...agent };
}

/**
 * A script of `count` spoken words that neither copies nor reads code.
 */
function script(count: number): AgentResult<{ beats: Beat[] }> {
  return {
    ok: true,
    output: { beats: [{ speech: Array.from({ length: count }, (_, i) => `palavra${i}`).join(" "), visual: "v" }] },
  };
}

function inputs<S extends keyof AgentStages>(agent: ReturnType<typeof fakeAgent>, stage: S) {
  return agent.inputs.filter((call) => call.stage === stage).map(({ input }) => input as AgentStages[S]["input"]);
}

//
// Extraction
//

test("extraction creates Concepts with ranked fit_angles and Passages sliced at their anchors, rejecting an anchor not in the chapter", async () => {
  const { data, add, drain } = await setup();
  await add("sync", [
    {
      title: "Sync",
      text: "Intro.\n\n## Mutex\n\nA mutex lets one thread in at a time.\n\n### Locking\n\nLock, then unlock.\n\n## Semaphore\n\nA semaphore counts.\n",
    },
  ]);
  const agent = agentWith((stage) =>
    stage === "extract"
      ? {
          ok: true,
          output: {
            new: [
              {
                title: "Mutex",
                summary: "One at a time.",
                // Listed twice: kept once, since the schema can't forbid it (Codex strict mode refuses uniqueItems).
                angles: ["mechanism", "analogy", "mechanism"],
                anchor: { chapter: "Sync", section: "Mutex" },
              },
              {
                title: "Ghost",
                summary: "Not there.",
                angles: ["analogy"],
                anchor: { chapter: "Sync", section: "Monitor" },
              },
              // A null section, as the extract schema requires for the whole chapter.
              {
                title: "Sync",
                summary: "All of it.",
                angles: ["contrast"],
                anchor: { chapter: "Synchronization", section: null },
              },
            ],
            attach: [],
          },
        }
      : undefined,
  );
  await drain(agent);

  assert.deepEqual(inputs(agent, "extract")[0].title, "Sync");
  assert.equal(data.db.select().from(jobs).get()!.status, "done");
  const created = data.db.select().from(concepts).all();
  assert.deepEqual(
    created.map((concept) => [concept.title, concept.fitAngles, concept.seq]),
    [
      ["Mutex", ["mechanism", "analogy"], 0],
      ["Sync", ["contrast"], 1],
    ],
  );
  assert.deepEqual(
    data.db
      .select({ conceptId: passages.conceptId, anchor: passages.anchor, text: passages.text })
      .from(passages)
      .all(),
    [
      {
        conceptId: created[0].id,
        anchor: { chapter: "Sync", section: "Mutex" },
        text: "## Mutex\n\nA mutex lets one thread in at a time.\n\n### Locking\n\nLock, then unlock.",
      },
      // The anchor names the chapter being extracted, whatever title the agent gave it.
      {
        conceptId: created[1].id,
        anchor: { chapter: "Sync", section: null },
        text: "Intro.\n\n## Mutex\n\nA mutex lets one thread in at a time.\n\n### Locking\n\nLock, then unlock.\n\n## Semaphore\n\nA semaphore counts.",
      },
    ],
  );
});

test("a chapter whose every anchor is dropped is stuck with the count and an example, and a retry asks the agent again", async () => {
  const { data, add, drain } = await setup();
  await add("clean", [
    { title: "Clean Code", text: "Chapter 1: Introduction to Clean Code\n\nClean code reads well.\n" },
  ]);
  const anchor = (section: string) => ({ chapter: "Clean Code", section });
  const agent = agentWith((stage) =>
    stage === "extract"
      ? {
          ok: true,
          output: {
            new: [
              {
                title: "Clean code",
                summary: "Reads well.",
                angles: ["analogy"],
                anchor: anchor("Chapter 1: Introduction to Clean Code"),
              },
              { title: "Naming", summary: "Names matter.", angles: ["analogy"], anchor: anchor("Meaningful Names") },
            ],
            attach: [{ conceptId: 1, anchor: anchor("Functions") }],
          },
        }
      : undefined,
  );
  await drain(agent);

  assert.deepEqual(agent.calls, ["extract"]);
  assert.deepEqual(
    data.db
      .select({ chapter: chapters.status, job: jobs.status, error: jobs.lastError })
      .from(jobs)
      .innerJoin(chapters, eq(chapters.id, jobs.chapterId))
      .all(),
    [
      {
        chapter: "pending",
        job: "stuck",
        error: 'Error: 3/3 anchors not found in the chapter, e.g. section "Chapter 1: Introduction to Clean Code"',
      },
    ],
  );
  assert.deepEqual(data.db.select().from(concepts).all(), []);
  const job = data.db.select().from(jobs).get()!;
  assert.ok(existsSync(join(data.home, "jobs", String(job.id), "extract.rejected.json")));

  createSources(data, fakeMedia()).retry(job.id);
  const retried = fakeAgent();
  await drain(retried);
  assert.equal(retried.calls[0], "extract");
  assert.equal(data.db.select().from(chapters).get()!.status, "extracted");
});

test("a chapter that teaches nothing is still extracted", async () => {
  const { data, add, drain } = await setup();
  await add("preface", [{ title: "Preface", text: "Thanks to my editor.\n" }]);
  await drain(agentWith((stage) => (stage === "extract" ? { ok: true, output: { new: [], attach: [] } } : undefined)));

  assert.deepEqual(
    data.db
      .select({ chapter: chapters.status, job: jobs.status })
      .from(jobs)
      .innerJoin(chapters, eq(chapters.id, jobs.chapterId))
      .all(),
    [{ chapter: "extracted", job: "done" }],
  );
});

test("a newly extracted chapter's Passages carry its chapter", async () => {
  const { data, add, drain } = await setup();
  const source = await add("book", [
    { title: "Intro", text: "Hello.\n" },
    { title: "Threads", text: "Threads run at once.\n" },
  ]);
  await drain(
    fakeAgent({
      extract: (chapter) => [{ title: chapter, summary: chapter, angles: ["analogy"], anchor: { chapter: "any" } }],
    }),
  );

  const [intro, threads] = data.db
    .select()
    .from(chapters)
    .where(eq(chapters.sourceId, source.id))
    .orderBy(chapters.seq)
    .all();
  assert.deepEqual(data.db.select({ text: passages.text, chapterId: passages.chapterId }).from(passages).all(), [
    { text: "Hello.", chapterId: intro.id },
    { text: "Threads run at once.", chapterId: threads.id },
  ]);
});

test("a page-range anchor slices a PDF chapter from its first page marker to the page after its last", async () => {
  const { data, add, drain } = await setup();
  await add("pdf", [
    {
      title: "Threads",
      text: "<!-- page 2 -->\nIntro.\n<!-- page 3 -->\nThreads share memory.\n<!-- page 4 -->\nLocks.\n",
    },
  ]);
  await drain(
    agentWith((stage) =>
      stage === "extract"
        ? {
            ok: true,
            output: {
              new: [
                { title: "Sharing", summary: "Shared memory.", angles: ["mechanism"], anchor: { pages: [3, 3] } },
                { title: "Ghost", summary: "Not there.", angles: ["analogy"], anchor: { pages: [7, 8] } },
              ],
              attach: [],
            },
          }
        : undefined,
    ),
  );

  assert.deepEqual(data.db.select({ anchor: passages.anchor, text: passages.text }).from(passages).all(), [
    { anchor: { pages: [3, 3] }, text: "<!-- page 3 -->\nThreads share memory." },
  ]);
});

test("attaching adds a Passage from another Source to an existing Concept, keeping its source, seq and Retired status", async () => {
  const { data, add, drain } = await setup();
  const first = await add("first", [THREADS]);
  await drain(fakeAgent());
  const thread = data.db.select().from(concepts).get()!;
  data.db.update(concepts).set({ status: "retired", retiredReason: "known" }).where(eq(concepts.id, thread.id)).run();

  const second = await add("second", [{ title: "Concurrency", text: "Threads run at once.\n" }]);
  await drain(
    agentWith((stage) =>
      stage === "extract"
        ? {
            ok: true,
            output: {
              new: [],
              attach: [
                { conceptId: thread.id, anchor: { chapter: "Concurrency" } },
                // No such Concept.
                { conceptId: 999, anchor: { chapter: "Concurrency" } },
              ],
            },
          }
        : undefined,
    ),
  );

  assert.deepEqual(
    data.db
      .select({ sourceId: passages.sourceId, text: passages.text })
      .from(passages)
      .where(eq(passages.conceptId, thread.id))
      .all(),
    [
      { sourceId: first.id, text: "A thread is one sequence of execution inside a process." },
      { sourceId: second.id, text: "Threads run at once." },
    ],
  );
  const after = data.db.select().from(concepts).where(eq(concepts.id, thread.id)).get()!;
  assert.deepEqual([after.sourceId, after.seq, after.status], [first.id, thread.seq, "retired"]);
  assert.equal(data.db.select().from(passages).all().length, 2);
});

test("a chapter whose extraction fails 3× is stuck, and the next chapter is still extracted", async () => {
  const { data, add, drain } = await setup();
  await add("book", [{ title: "Broken", text: "Garbled.\n" }, THREADS]);
  const agent = agentWith((stage, input) =>
    stage === "extract" && input.title === "Broken" ? { ok: false, error: "is_error: true" } : undefined,
  );
  await drain(agent);

  // Retried before the next chapter, so chapters are extracted in Source order.
  assert.deepEqual(
    inputs(agent, "extract").map((input) => input.title),
    ["Broken", "Broken", "Broken", "Threads"],
  );
  const extractions = data.db
    .select({
      title: chapters.title,
      chapter: chapters.status,
      job: jobs.status,
      attempts: jobs.attempts,
      error: jobs.lastError,
    })
    .from(jobs)
    .innerJoin(chapters, eq(chapters.id, jobs.chapterId))
    .all();
  assert.deepEqual(extractions, [
    { title: "Broken", chapter: "pending", job: "stuck", attempts: 3, error: "Error: is_error: true" },
    { title: "Threads", chapter: "extracted", job: "done", attempts: 0, error: null },
  ]);
  assert.equal(createFeed(data).next()[0].concept.title, "What is a thread");
});

//
// Script, checks, verify and their retry policy
//

test("the script is asked with its Angle recipe, word budget and lexicon terms", async () => {
  const { add, drain } = await setup();
  await add("book", [THREADS]);
  const agent = fakeAgent();
  await drain(agent);

  const [input] = inputs(agent, "script");
  assert.equal(input.angle, "analogy");
  assert.match(input.recipe, /analogy/);
  assert.deepEqual(input.words, { min: 85, max: 175 });
  assert.ok(input.lexicon.includes("thread"));
});

test("a script failing a check is rewritten with the problem, and the rewrite becomes the Clip", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  const scripts = [script(40)];
  const agent = agentWith((stage) => (stage === "script" ? scripts.shift() : undefined));
  await drain(agent);

  assert.deepEqual(agent.calls, ["extract", "script", "script", "verify", "scene"]);
  assert.deepEqual(
    inputs(agent, "script").map((input) => input.feedback),
    [undefined, "40 spoken words, write at least 85"],
  );
  assert.equal(createFeed(data).next().length, 1);
});

test("a script verify keeps rejecting is rewritten with its problems 2×, then its Concept is stuck and leaves the queue", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  const agent = agentWith((stage) =>
    stage === "verify"
      ? { ok: true, output: { ok: false, problems: ["claims threads never share memory"] } }
      : undefined,
  );
  await drain(agent);

  assert.deepEqual(agent.calls, ["extract", "script", "verify", "script", "verify", "script", "verify"]);
  assert.equal(inputs(agent, "script")[2].feedback, "claims threads never share memory");
  const clipJobs = data.db.select().from(jobs).where(eq(jobs.kind, "new")).all();
  assert.deepEqual(
    clipJobs.map((job) => job.status),
    ["stuck"],
  );
  assert.match(clipJobs[0].lastError!, /claims threads never share memory/);
});

test("a failed agent call in a Clip stage is retried 2×, then the job is stuck", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  let failures = 1;
  const flaky = agentWith((stage) =>
    stage === "verify" && failures-- > 0 ? { ok: false, error: "is_error: true" } : undefined,
  );
  await drain(flaky);
  assert.equal(createFeed(data).next().length, 1);

  await add("more", [{ title: "Locks", text: "A lock lets one thread in.\n" }]);
  const broken = agentWith((stage) => (stage === "verify" ? { ok: false, error: "is_error: true" } : undefined));
  await drain(broken);
  assert.equal(broken.calls.filter((stage) => stage === "verify").length, 3);
  const job = data.db.select().from(jobs).where(eq(jobs.status, "stuck")).get()!;
  assert.equal(job.attempts, 3);
});

test("a script still too long after 2 rewrites splits its Clip-less Concept into Concepts that reuse its Passages", async () => {
  const { data, add, drain } = await setup();
  const source = await add("book", [THREADS]);
  const scripts = [script(200), script(190), script(180)];
  const agent = agentWith((stage) => (stage === "script" ? scripts.shift() : undefined));
  await drain(agent);

  assert.equal(agent.calls.filter((stage) => stage === "split").length, 1);
  const [split] = inputs(agent, "split");
  assert.equal(split.concept.title, "What is a thread");
  assert.equal(split.feedback, "180 spoken words, cut to at most 175");

  const parts = data.db.select().from(concepts).all();
  assert.deepEqual(
    parts.map((concept) => [concept.title, concept.fitAngles, concept.sourceId]),
    [
      ["Threads in a process", ["analogy"], source.id],
      ["Threads share memory", ["mechanism", "contrast"], source.id],
    ],
  );
  const [chapter] = data.db.select().from(chapters).all();
  for (const part of parts) {
    assert.deepEqual(
      data.db
        .select({ text: passages.text, chapterId: passages.chapterId })
        .from(passages)
        .where(eq(passages.conceptId, part.id))
        .all(),
      [{ text: "A thread is one sequence of execution inside a process.", chapterId: chapter.id }],
    );
  }
  assert.deepEqual(data.db.select({ conceptId: clips.conceptId, angle: clips.angle }).from(clips).all(), [
    { conceptId: parts[0].id, angle: "analogy" },
    { conceptId: parts[1].id, angle: "mechanism" },
  ]);
});

test("a split part with an Angle listed twice keeps it once", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  const scripts = [script(200), script(190), script(180)];
  const agent = agentWith((stage) =>
    stage === "script"
      ? scripts.shift()
      : stage === "split"
        ? {
            ok: true,
            output: {
              concepts: [
                { title: "Threads in a process", summary: "Several threads.", angles: ["analogy", "analogy"] },
                {
                  title: "Threads share memory",
                  summary: "Shared memory.",
                  angles: ["mechanism", "contrast", "mechanism"],
                },
              ],
            },
          }
        : undefined,
  );
  await drain(agent);

  assert.deepEqual(
    data.db
      .select()
      .from(concepts)
      .all()
      .map((concept) => concept.fitAngles),
    [["analogy"], ["mechanism", "contrast"]],
  );
});

test("a script still too long for a Concept that has a Clip is stuck, not split", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  await drain(fakeAgent());
  const feed = createFeed(data);
  feed.press(feed.next()[0].clipId, "didnt_get", randomUUID());

  const agent = agentWith((stage) => (stage === "script" ? script(200) : undefined));
  await drain(agent);

  assert.deepEqual(agent.calls, ["script", "script", "script"]);
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new_angle")).get()!;
  assert.equal(job.status, "stuck");
  assert.match(job.lastError!, /200 spoken words, cut to at most 175/);
});

test("checks and verify each get their own 2 rewrites", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  const scripts = [script(40), script(40)];
  const verdicts = [false, false].map(
    (ok) => ({ ok: true, output: { ok, problems: ["claims threads never share memory"] } }) as const,
  );
  const agent = agentWith((stage) =>
    stage === "script" ? scripts.shift() : stage === "verify" ? verdicts.shift() : undefined,
  );
  await drain(agent);

  assert.deepEqual(agent.calls, [
    "extract",
    "script",
    "script",
    "script",
    "verify",
    "script",
    "verify",
    "script",
    "verify",
    "scene",
  ]);
  assert.equal(createFeed(data).next().length, 1);
});

test("a Concept that came out of a split is never split again: still too long, it is stuck", async () => {
  const { data, add, drain } = await setup();
  await add("book", [THREADS]);
  const agent = agentWith((stage) => (stage === "script" ? script(200) : undefined));
  await drain(agent);

  assert.equal(agent.calls.filter((stage) => stage === "split").length, 1);
  assert.deepEqual(
    data.db
      .select({ fromSplit: concepts.fromSplit, job: jobs.status })
      .from(concepts)
      .innerJoin(jobs, eq(jobs.conceptId, concepts.id))
      .all(),
    [
      { fromSplit: true, job: "stuck" },
      { fromSplit: true, job: "stuck" },
    ],
  );
});

test("a script's {shown|spoken} term missing from the lexicon is added to the data folder's copy, and the job goes on", async () => {
  const { data, add, drain, lexicon } = await setup();
  const repoDefault = await readFile(defaultLexicon("pt-BR"), "utf8");
  await add("book", [THREADS]);
  const fake = fakeAgent();
  const { beats } = ((await fake.run("script", {} as never, { jobId: 0 })) as { output: { beats: Beat[] } }).output;
  const marked = [{ speech: `O {garbage collector|gár bitch colétor} e a {thread|trédi}.`, visual: "gc" }, ...beats];
  const agent = agentWith((stage) => (stage === "script" ? { ok: true, output: { beats: marked } } : undefined));
  // The Learner tunes a respelling by hand while the worker runs.
  const tuned = JSON.parse(await readFile(lexicon, "utf8"));
  await writeFile(lexicon, JSON.stringify({ ...tuned, mutex: "mútequis" }));
  await drain(agent);

  const terms = JSON.parse(await readFile(lexicon, "utf8"));
  assert.equal(terms.mutex, "mútequis");
  assert.equal(terms["garbage collector"], "gár bitch colétor");
  // A term the lexicon already has keeps its tuned respelling.
  assert.equal(terms.thread, "tréd");
  assert.equal(createFeed(data).next().length, 1);
  // The repo's default is never written, so a generated Clip leaves `git status` clean.
  assert.equal(await readFile(defaultLexicon("pt-BR"), "utf8"), repoDefault);
});

test("a term the Learner deletes from lexicon.json by hand stays deleted when the worker adds one", async () => {
  const { add, drain, lexicon } = await setup();
  await add("book", [THREADS]);
  const fake = fakeAgent();
  const { beats } = ((await fake.run("script", {} as never, { jobId: 0 })) as { output: { beats: Beat[] } }).output;
  const marked = [{ speech: "O {garbage collector|gár bitch colétor}.", visual: "gc" }, ...beats];
  const agent = agentWith((stage) => (stage === "script" ? { ok: true, output: { beats: marked } } : undefined));
  const { mutex: _, ...rest } = JSON.parse(await readFile(lexicon, "utf8"));
  await writeFile(lexicon, JSON.stringify(rest));
  await drain(agent);

  const terms = JSON.parse(await readFile(lexicon, "utf8"));
  assert.equal(terms.mutex, undefined);
  assert.equal(terms["garbage collector"], "gár bitch colétor");
});

test("a lexicon.json deleted while the worker runs is written again with the terms in use and the new one", async () => {
  const { data, add, drain, lexicon } = await setup();
  await add("book", [THREADS]);
  const fake = fakeAgent();
  const { beats } = ((await fake.run("script", {} as never, { jobId: 0 })) as { output: { beats: Beat[] } }).output;
  const marked = [{ speech: "O {garbage collector|gár bitch colétor}.", visual: "gc" }, ...beats];
  const agent = agentWith((stage) => (stage === "script" ? { ok: true, output: { beats: marked } } : undefined));
  const inUse = { ...data.lexicons["pt-BR"] };
  await rm(lexicon);
  await drain(agent);

  // The default and tuned respellings in use are kept, not only the new term.
  assert.deepEqual(JSON.parse(await readFile(lexicon, "utf8")), { ...inUse, "garbage collector": "gár bitch colétor" });
  assert.equal(createFeed(data).next().length, 1);
});

test("a lexicon.json broken by a hand edit is logged and left as it is, and the script stage still completes", async () => {
  const { data, add, drain, lexicon } = await setup();
  await add("book", [THREADS]);
  const fake = fakeAgent();
  const { beats } = ((await fake.run("script", {} as never, { jobId: 0 })) as { output: { beats: Beat[] } }).output;
  const marked = [{ speech: "O {garbage collector|gár bitch colétor}.", visual: "gc" }, ...beats];
  const agent = agentWith((stage) => (stage === "script" ? { ok: true, output: { beats: marked } } : undefined));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await writeFile(lexicon, '{ "mutex": ');
  await drain(agent);

  assert.match(
    String(logged.mock.calls[0]?.[0]),
    /lexicon\.json is not valid JSON.*\nKeeping the last good lexicon\./s,
  );
  logged.mockRestore();
  // The Learner's file waits for their fix; the new term is used from now on.
  assert.equal(await readFile(lexicon, "utf8"), '{ "mutex": ');
  assert.equal(data.lexicons["pt-BR"]["garbage collector"], "gár bitch colétor");
  assert.equal(data.db.select().from(jobs).where(eq(jobs.status, "stuck")).all().length, 0);
  assert.equal(createFeed(data).next().length, 1);
});
