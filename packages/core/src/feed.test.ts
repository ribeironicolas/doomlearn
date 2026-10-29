import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "vitest";
import { eq } from "drizzle-orm";
import { type Config, openData } from "./data.ts";
import { createFeed } from "./feed.ts";
import { createInbox } from "./inbox.ts";
import { createPipeline } from "./pipeline.ts";
import { type Angle, clips, concepts, events, jobs } from "./schema.ts";
import { createSources } from "./sources.ts";
import { editConfig, fakeAgent, fakeMedia } from "./test/fakes.ts";

const T0 = new Date("2026-10-08T09:00:00Z").getTime();
const DAY = 86_400_000;

/**
 * A temp DOOMLEARN_HOME with one `.md` Source per entry of `sources`. Each Source is a list of chapter
 * texts, and the fake extraction turns each line of a chapter into a Concept titled with that line.
 * With `drain`, the worker runs until idle. The Feed's clock starts at T0 and moves with `at(days)`.
 */
async function setup({
  sources = [["A1"]],
  angles = ["analogy", "mechanism"],
  config = {},
  drain = true,
}: {
  sources?: string[][];
  angles?: Angle[];
  config?: Partial<Config["worker"]>;
  drain?: boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: config }));
  const data = openData(home);
  for (const [i, chapters] of sources.entries()) {
    const file = join(dir, `${i}.md`);
    await writeFile(file, chapters.join("\n"));
    const media = fakeMedia({ chapters: chapters.map((text, seq) => ({ title: `${i}.${seq}`, text })) });
    await createSources(data, media).add(file);
  }
  const agent = fakeAgent({
    extract: (chapter) =>
      chapter
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ title: line, summary: line, angles, anchor: { chapter: line } })),
  });
  const pipeline = createPipeline(data, agent, fakeMedia());
  if (drain) while (await pipeline.tick());

  const clock = { now: new Date(T0) };
  return {
    data,
    agent,
    pipeline,
    feed: createFeed(data, () => clock.now),
    at(days: number) {
      clock.now = new Date(T0 + days * DAY);
    },
    concept(title: string) {
      return data.db.select().from(concepts).where(eq(concepts.title, title)).get()!;
    },
  };
}

test("a new Concept watched to the end enters the ladder at step 0, due in a day", async () => {
  const { feed, at, concept } = await setup();
  const [slot] = feed.next();
  assert.equal(slot.kind, "new");

  feed.seen(slot.clipId, randomUUID(), { completed: true });

  assert.deepEqual(feed.next(), []);
  assert.equal(concept("A1").ladderStep, 0);
  at(1);
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.concept.title]),
    [["review", "A1"]],
  );
});

test("leaving a Clip before the end records nothing", async () => {
  const { data, feed, concept } = await setup();
  const [slot] = feed.next();

  feed.seen(slot.clipId, randomUUID(), { completed: false });

  assert.equal(concept("A1").status, "new");
  assert.deepEqual(data.db.select().from(events).all(), []);
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.clipId]),
    [["new", slot.clipId]],
  );
});

test("a watch to the end counts once", async () => {
  const { feed, at, concept } = await setup();
  const [slot] = feed.next();

  feed.seen(slot.clipId, randomUUID(), { completed: true });
  feed.seen(slot.clipId, randomUUID(), { completed: true });
  assert.equal(concept("A1").ladderStep, 0);

  at(1);
  feed.seen(slot.clipId, randomUUID(), { completed: true });
  feed.seen(slot.clipId, randomUUID(), { completed: true });
  assert.equal(concept("A1").ladderStep, 1);
});

test("✅ moves a Concept up the 1d, 3d, 7d, 21d, 60d ladder, one step per press", async () => {
  const { feed, at, concept } = await setup();
  const [slot] = feed.next();
  let day = 0;
  for (const [step, days] of [1, 3, 7, 21, 60].entries()) {
    feed.press(slot.clipId, "got_it", randomUUID());
    assert.equal(concept("A1").ladderStep, step);
    at(day + days - 0.01);
    assert.deepEqual(feed.next(), [], "no early Reviews");
    day += days;
    at(day);
    assert.deepEqual(
      feed.next().map((s) => [s.kind, s.clipId]),
      [["review", slot.clipId]],
    );
  }
});

test("✅ at step 4 retires the Concept as graduated", async () => {
  const { feed, at, concept } = await setup();
  const [slot] = feed.next();
  for (const day of [0, 1, 4, 11, 32, 92]) {
    at(day);
    feed.press(slot.clipId, "got_it", randomUUID());
  }

  assert.deepEqual([concept("A1").status, concept("A1").retiredReason], ["retired", "graduated"]);
  at(1000);
  assert.deepEqual(feed.next(), []);
});

test("🤔 resets to step 0, due tomorrow, and queues a Clip with the next fitting Angle", async () => {
  const { feed, at, concept, pipeline } = await setup();
  const [slot] = feed.next();
  feed.press(slot.clipId, "got_it", randomUUID());
  at(1);
  feed.press(slot.clipId, "got_it", randomUUID());
  at(4);

  feed.press(slot.clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());

  assert.equal(concept("A1").ladderStep, 0);
  assert.deepEqual(feed.next(), []);
  at(5);
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.angle]),
    [["review", "mechanism"]],
  );
});

test("🤔 with no fitting Angle left reuses the least recently seen Clip and marks the Concept not landing", async () => {
  const { feed, at, concept, pipeline, agent } = await setup();
  const [first] = feed.next();
  feed.press(first.clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());
  at(1);
  const [second] = feed.next();
  assert.equal(second.angle, "mechanism");
  const scripts = agent.calls.filter((stage) => stage === "script").length;

  feed.press(second.clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());

  assert.equal(agent.calls.filter((stage) => stage === "script").length, scripts, "no generation");
  assert.deepEqual(concept("A1").notLandingAt, new Date(T0 + DAY));
  at(2);
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.clipId]),
    [["review", first.clipId]],
  );
});

test("⏭️ retires the Concept as known", async () => {
  const { feed, at, concept } = await setup();
  const [slot] = feed.next();

  feed.press(slot.clipId, "know", randomUUID());

  assert.deepEqual([concept("A1").status, concept("A1").retiredReason], ["retired", "known"]);
  at(1000);
  assert.deepEqual(feed.next(), []);
});

test("a Paused Concept that retires by ⏭️ or by graduating is no longer Paused", async () => {
  const { data, feed, at, concept } = await setup({ sources: [["A1\nA2"]] });
  const [a1, a2] = feed.next();
  data.db
    .update(concepts)
    .set({ pausedAt: new Date(T0) })
    .run();

  feed.press(a1.clipId, "know", randomUUID());
  for (const day of [0, 1, 4, 11, 32, 92]) {
    at(day);
    feed.press(a2.clipId, "got_it", randomUUID());
  }
  for (const slot of [a1, a2]) feed.favorite(slot.clipId, true);

  assert.deepEqual(
    ["A1", "A2"].map((title) => [concept(title).retiredReason, concept(title).pausedAt]),
    [
      ["known", null],
      ["graduated", null],
    ],
  );
  assert.deepEqual(
    createSources(data, fakeMedia())
      .source(concept("A1").sourceId)!
      .chapters.flatMap((chapter) => chapter.concepts.map((row) => [row.title, row.paused])),
    [
      ["A1", false],
      ["A2", false],
    ],
  );
  assert.deepEqual(
    feed.favorites().map((fav) => [fav.concept.title, fav.concept.paused]),
    [
      ["A2", false],
      ["A1", false],
    ],
  );
});

test("🚩 hides that Clip with its reason and note, leaving the schedule unchanged", async () => {
  const { data, feed, at, concept, pipeline } = await setup();
  const [first] = feed.next();
  feed.press(first.clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());
  at(1);
  const [second] = feed.next();
  const before = concept("A1");

  feed.press(second.clipId, "flag", randomUUID(), { reason: "Pronunciation", note: "thread sounds wrong" });

  assert.deepEqual(concept("A1"), before);
  assert.deepEqual(
    data.db
      .select({ kind: events.kind, reason: events.reason, note: events.note })
      .from(events)
      .where(eq(events.clipId, second.clipId))
      .all(),
    [{ kind: "flag", reason: "Pronunciation", note: "thread sounds wrong" }],
  );
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.clipId]),
    [["review", first.clipId]],
  );
});

test("the same press sent twice with the same client event id changes state once", async () => {
  const { data, feed, concept } = await setup();
  const [slot] = feed.next();
  const id = randomUUID();

  feed.press(slot.clipId, "didnt_get", id);
  feed.press(slot.clipId, "didnt_get", id);

  assert.equal(concept("A1").notLandingAt, null);
  assert.equal(data.db.select().from(events).all().length, 1);
});

test("with 60 due Concepts and a full buffer, at most 1 in 3 slots is a Review, oldest due first, then done for today", async () => {
  const lines = Array.from({ length: 70 }, (_, i) => `C${i}`);
  const { feed, at } = await setup({ sources: [[lines.join("\n")]], config: { bufferTarget: 70, dailyClipCap: 70 } });
  const due = feed.next().slice(0, 60).reverse();
  // Pressed a minute apart, last slot first, so due order differs from Clip order.
  due.forEach((slot, i) => {
    at(i / 1440);
    feed.press(slot.clipId, "got_it", randomUUID());
  });

  at(2);
  const slots = feed.next();

  assert.equal(slots.length, 70);
  const buffer = slots.slice(0, 15).map((slot) => slot.kind);
  assert.equal(buffer.filter((kind) => kind === "new").length, 10);
  for (let i = 0; i + 3 <= buffer.length; i++) {
    assert.ok(buffer.slice(i, i + 3).filter((kind) => kind === "review").length <= 1, `slots ${i} to ${i + 2}`);
  }
  assert.deepEqual(
    slots.filter((slot) => slot.kind === "review").map((slot) => slot.clipId),
    due.map((slot) => slot.clipId),
  );

  for (const slot of slots) feed.press(slot.clipId, "got_it", randomUUID());
  assert.deepEqual(feed.next(), []);
});

test("new Concepts alternate across Sources, each in its seq order", async () => {
  const { feed } = await setup({ sources: [["A1\nA2", "A3"], ["B1\nB2"]] });

  assert.deepEqual(
    feed.next().map((slot) => slot.concept.title),
    ["A1", "B1", "A2", "B2", "A3"],
  );
});

//
// Generation pacing
//

test("the worker queues Clip jobs only for the buffer gap", async () => {
  const { feed, pipeline, agent } = await setup({ sources: [["C1\nC2\nC3\nC4\nC5"]], config: { bufferTarget: 3 } });
  const scripts = () => agent.calls.filter((stage) => stage === "script").length;
  assert.equal(scripts(), 3);
  assert.equal(feed.next().length, 3);

  feed.seen(feed.next()[0].clipId, randomUUID(), { completed: true });
  while (await pipeline.tick());

  assert.equal(scripts(), 4);
  assert.equal(feed.next().length, 3);
});

test("the worker fills the buffer gap round-robin across Sources", async () => {
  const { feed, pipeline } = await setup({ sources: [["A1\nA2\nA3"], ["B1"]], config: { bufferTarget: 2 } });
  assert.deepEqual(
    feed.next().map((slot) => slot.concept.title),
    ["A1", "A2"],
  );

  feed.seen(feed.next()[0].clipId, randomUUID(), { completed: true });
  while (await pipeline.tick());

  assert.deepEqual(
    feed.next().map((slot) => [slot.concept.title, slot.angle]),
    [
      ["A2", "analogy"],
      ["B1", "analogy"],
    ],
  );
});

test("the worker stops generating Clips at the daily cap, 🤔 ones included", async () => {
  const { feed, pipeline, agent } = await setup({ sources: [["C1\nC2\nC3\nC4\nC5"]], config: { dailyClipCap: 2 } });
  const scripts = () => agent.calls.filter((stage) => stage === "script").length;
  assert.equal(scripts(), 2);

  feed.press(feed.next()[0].clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());

  assert.equal(scripts(), 2);
});

test("the worker runs 🤔 Clips, then new-Concept Clips, then extraction", async () => {
  const { feed, pipeline, agent } = await setup({ sources: [["A\nB", "C"]], drain: false });
  while (!feed.next().length) await pipeline.tick();
  feed.press(feed.next()[0].clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());

  assert.deepEqual(
    agent.inputs.flatMap(({ stage, input }) => {
      if (stage === "extract") return [`extract ${(input as { chapter: string }).chapter}`];
      if (stage !== "script") return [];
      const { concept, angle } = input as { concept: { title: string }; angle: Angle };
      return [`${concept.title} ${angle}`];
    }),
    ["extract A\nB", "A analogy", "A mechanism", "B analogy", "extract C", "C analogy"],
  );
});

//
// End screen
//

test("today() counts the day’s ✅ 🤔 ⏭️ 🚩, the buffer and tomorrow’s due Reviews", async () => {
  const { feed, at } = await setup({ sources: [["C1\nC2\nC3\nC4\nC5\nC6"]], config: { bufferTarget: 6 } });
  const [watched, got, didnt, known, flagged] = feed.next();
  // A watch to the end then ✅ on the same Clip is one ✅.
  feed.seen(watched.clipId, randomUUID(), { completed: true });
  feed.press(watched.clipId, "got_it", randomUUID());
  feed.press(got.clipId, "got_it", randomUUID());
  feed.press(didnt.clipId, "didnt_get", randomUUID());
  feed.press(known.clipId, "know", randomUUID());
  feed.press(flagged.clipId, "flag", randomUUID(), { reason: "Wrong content" });

  assert.deepEqual(feed.today(), {
    counts: { got_it: 2, didnt_get: 1, know: 1, flag: 1 },
    buffer: { ready: 1, generating: 1, target: 6 },
    dueTomorrow: 3,
  });
  at(1);
  assert.deepEqual(feed.today().counts, { got_it: 0, didnt_get: 0, know: 0, flag: 0 });
});

test("a slot carries what the tag shows: New or Review with its step as days, Concept, Source, Angle", async () => {
  const { feed, at } = await setup();
  const [fresh] = feed.next();
  assert.deepEqual([fresh.kind, fresh.concept.days, fresh.source.title, fresh.angle], ["new", null, "0", "analogy"]);

  feed.press(fresh.clipId, "got_it", randomUUID());
  at(1);
  const [review] = feed.next();
  assert.deepEqual([review.kind, review.concept.days], ["review", 1]);
});

test("search finds Clips by caption, accent-insensitive, Retired Concepts included, with the match marked", async () => {
  const { data, feed } = await setup({ sources: [["A1\nA2\nA3"]] });
  const [a1, a2, a3] = feed.next();
  const caption = (clipId: number, text: string) =>
    data.db.update(clips).set({ caption: text }).where(eq(clips.id, clipId)).run();
  caption(a1.clipId, "Threads dividem a memória do processo.");
  caption(a2.clipId, "Sem memória compartilhada.");
  caption(a3.clipId, "Nada a ver.");
  feed.press(a1.clipId, "got_it", randomUUID());
  feed.press(a2.clipId, "know", randomUUID());

  assert.deepEqual(
    feed
      .search("memoria")
      .map((hit) => [
        hit.concept.title,
        hit.concept.status,
        hit.concept.days,
        hit.source.title,
        hit.angle,
        hit.caption,
      ]),
    [
      ["A2", "retired", null, "0", "analogy", "Sem \u0002memória\u0003 compartilhada."],
      ["A1", "scheduled", 1, "0", "analogy", "Threads dividem a \u0002memória\u0003 do processo."],
    ],
  );
  assert.deepEqual(feed.search('"); drop'), []);
});

test("search leaves out 🚩 hidden Clips", async () => {
  const { feed } = await setup();
  const [slot] = feed.next();
  assert.equal(feed.search("thread").length, 1);

  feed.press(slot.clipId, "flag", randomUUID(), { reason: "Wrong content" });

  assert.deepEqual(feed.search("thread"), []);
});

test("🤔 from search on a Retired Concept puts it back at step 0 and queues a Clip with a new Angle", async () => {
  const { data, feed, concept } = await setup();
  const [slot] = feed.next();
  feed.press(slot.clipId, "know", randomUUID());
  const [hit] = feed.search("thread");
  assert.equal(hit.concept.status, "retired");

  feed.press(hit.clipId, "didnt_get", randomUUID());

  assert.deepEqual(
    [concept("A1").status, concept("A1").ladderStep, concept("A1").retiredReason],
    ["scheduled", 0, null],
  );
  assert.deepEqual(
    data.db.select({ kind: jobs.kind, angle: jobs.angle }).from(jobs).where(eq(jobs.status, "queued")).all(),
    [{ kind: "new_angle", angle: "mechanism" }],
  );
});

test("⭐ on and off leaves the ladder, Feed order, Reviews, Retired and last seen unchanged", async () => {
  const { data, feed, at } = await setup({ sources: [["A1\nA2\nA3"]] });
  const [first, second, third] = feed.next();
  feed.press(first.clipId, "got_it", randomUUID());
  feed.press(second.clipId, "know", randomUUID());
  at(1);
  // Every row a ⭐ could touch, and the Feed as the app gets it less the ⭐ itself.
  const snapshot = () => ({
    concepts: data.db.select().from(concepts).all(),
    clips: data.db.select().from(clips).all(),
    events: data.db.select().from(events).all(),
    jobs: data.db.select().from(jobs).all(),
    next: feed.next().map(({ favorite, ...slot }) => slot),
  });
  const before = snapshot();
  assert.deepEqual(
    before.next.map((slot) => [slot.kind, slot.clipId]),
    [
      ["new", third.clipId],
      ["review", first.clipId],
    ],
  );

  for (const clip of [first, second, third]) feed.favorite(clip.clipId, true);
  feed.favorite(third.clipId, true);
  feed.favorite(first.clipId, false);

  assert.deepEqual(snapshot(), before);
  assert.deepEqual(
    feed.next().map((slot) => [slot.clipId, slot.favorite]),
    [
      [third.clipId, true],
      [first.clipId, false],
    ],
  );
});

test("a Favorite stays after its Concept is Retired and its Clip is flagged, and lists its current file after a regenerate", async () => {
  const { data, feed, concept } = await setup();
  const [slot] = feed.next();
  feed.favorite(slot.clipId, true);

  feed.press(slot.clipId, "know", randomUUID());
  feed.press(slot.clipId, "flag", randomUUID(), { reason: "Pronunciation" });

  assert.deepEqual(
    feed.favorites().map((fav) => [fav.clipId, fav.concept.status, fav.flagged]),
    [[slot.clipId, "retired", true]],
  );
  // Flagged Clips stay out of the Feed and Search, Favorite or not.
  assert.deepEqual(feed.search("thread"), []);

  const inbox = createInbox(data);
  inbox.regenerate(inbox.list().flags[0].eventId);
  const [job] = data.db.select().from(jobs).where(eq(jobs.kind, "regenerate")).all();
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  const [favorite] = feed.favorites();
  assert.deepEqual(
    [favorite.clipId, favorite.flagged, basename(favorite.file)],
    [slot.clipId, false, `${concept("A1").id}-analogy-${job.id}.mp4`],
  );
});

test("Favorites list newest first with the Concept, its state, Angle, Language and Source; un-starred ones leave", async () => {
  const { feed, at } = await setup({ sources: [["A1\nA2\nA3"]], angles: ["mechanism"] });
  const [first, second, third] = feed.next();
  feed.press(first.clipId, "got_it", randomUUID());
  feed.favorite(first.clipId, true);
  at(1);
  feed.favorite(second.clipId, true);
  at(2);
  feed.favorite(third.clipId, true);
  feed.favorite(second.clipId, false);

  assert.deepEqual(
    feed.favorites().map(({ file, ...fav }) => fav),
    [
      {
        clipId: third.clipId,
        angle: "mechanism",
        language: "pt-BR",
        concept: { id: third.concept.id, title: "A3", status: "new", days: null, deleted: false, paused: false },
        source: { id: third.source.id, title: "0", status: "active" },
        flagged: false,
      },
      {
        clipId: first.clipId,
        angle: "mechanism",
        language: "pt-BR",
        concept: { id: first.concept.id, title: "A1", status: "scheduled", days: 1, deleted: false, paused: false },
        source: { id: first.source.id, title: "0", status: "active" },
        flagged: false,
      },
    ],
  );
});

//
// Language of new Clips
//

test("a due Concept plays its Clip in the Language of new Clips first, else its least recently seen in any Language", async () => {
  const { data, feed, at } = await setup();
  const [pt] = feed.next();
  feed.press(pt.clipId, "got_it", randomUUID());
  const row = data.db.select().from(clips).where(eq(clips.id, pt.clipId)).get()!;
  // An en Clip of the same Concept and Angle, seen after the pt-BR one.
  const en = data.db
    .insert(clips)
    .values({ ...row, id: undefined, language: "en", lastSeenAt: new Date(T0 + 1000) })
    .returning()
    .get();
  at(1);

  await editConfig(data.home, { worker: { language: "en" } });
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.clipId, s.language]),
    [["review", en.id, "en"]],
  );
  await editConfig(data.home, { worker: { language: "es" } });
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.clipId, s.language]),
    [["review", pt.clipId, "pt-BR"]],
  );
});

test("an unseen Clip in another Language is not kept ready, so the worker makes one in the Language of new Clips", async () => {
  const { data, feed, pipeline } = await setup({ sources: [["C1\nC2"]], config: { bufferTarget: 1 } });
  assert.equal(feed.today().buffer.ready, 1);

  await editConfig(data.home, { worker: { bufferTarget: 1, language: "en" } });
  assert.equal(feed.today().buffer.ready, 0);
  assert.equal(createSources(data, fakeMedia()).status().queue.buffer.clips, 0);
  while (await pipeline.tick());

  assert.deepEqual(
    data.db
      .select({ title: concepts.title, language: clips.language })
      .from(clips)
      .innerJoin(concepts, eq(clips.conceptId, concepts.id))
      .orderBy(clips.id)
      .all(),
    [
      { title: "C1", language: "pt-BR" },
      { title: "C2", language: "en" },
    ],
  );
  assert.equal(feed.today().buffer.ready, 1);
});

test("🤔 queues a new-Angle Clip in the Language set when it starts; out of Angles it queues nothing and the Review replays a Clip", async () => {
  const { data, feed, at, pipeline } = await setup();
  const [first] = feed.next();
  feed.press(first.clipId, "didnt_get", randomUUID());
  // Switched after the 🤔, before the worker starts its Clip.
  await editConfig(data.home, { worker: { language: "en" } });
  while (await pipeline.tick());
  const angled = data.db.select().from(clips).where(eq(clips.angle, "mechanism")).get()!;
  assert.equal(angled.language, "en");
  at(1);
  const [review] = feed.next();
  assert.equal(review.clipId, angled.id);

  feed.press(review.clipId, "didnt_get", randomUUID());
  while (await pipeline.tick());

  assert.deepEqual(
    data.db.select({ kind: jobs.kind, language: jobs.language }).from(jobs).where(eq(jobs.kind, "new_angle")).all(),
    [{ kind: "new_angle", language: "en" }],
  );
  at(2);
  // The en Clip, seen more recently than the pt-BR one, is in the Language of new Clips.
  assert.deepEqual(
    feed.next().map((s) => [s.kind, s.clipId]),
    [["review", angled.id]],
  );
});
