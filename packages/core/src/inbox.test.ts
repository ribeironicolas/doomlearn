import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { eq } from "drizzle-orm";
import type { Agent, AgentStages } from "./agent.ts";
import { openData } from "./data.ts";
import { createFeed } from "./feed.ts";
import { createInbox } from "./inbox.ts";
import { createPipeline } from "./pipeline.ts";
import { jobs } from "./schema.ts";
import { createSources } from "./sources.ts";
import { fakeAgent, fakeMedia } from "./test/fakes.ts";

/**
 * One Source whose first chapter teaches A1, A2 and A3 with one fitting Angle each, and whose second chapter's
 * extraction always fails. A3's script always fails too. The worker runs until idle, leaving both jobs stuck.
 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), "{}");
  const data = openData(home);
  await writeFile(join(dir, "ostep.md"), "ostep");
  const media = fakeMedia({
    chapters: [
      { title: "Threads", text: "A1\nA2\nA3" },
      { title: "Locks", text: "BROKEN" },
    ],
  });
  await createSources(data, media).add(join(dir, "ostep.md"));
  const fake = fakeAgent({
    extract: (chapter) =>
      chapter
        .split("\n")
        .map((line) => ({ title: line, summary: line, angles: ["analogy"], anchor: { chapter: line } })),
  });
  const agent: Agent = {
    run: (stage, input, served) => {
      const broken =
        (stage === "extract" && (input as AgentStages["extract"]["input"]).chapter === "BROKEN") ||
        (stage === "script" && (input as AgentStages["script"]["input"]).concept.title === "A3");
      return broken ? Promise.resolve({ ok: false, error: `${stage} failed` }) : fake.run(stage, input, served);
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());
  return { data, feed: createFeed(data), inbox: createInbox(data) };
}

test("the inbox lists open 🚩 with reason and note, not-landing Concepts, and stuck jobs", async () => {
  const { feed, inbox } = await setup();
  const [a1, a2] = feed.next();
  feed.press(a1.clipId, "didnt_get", randomUUID());
  feed.press(a2.clipId, "flag", randomUUID(), { reason: "Pronunciation", note: "cache came out as catchê" });

  const { flags, notLanding, stuck } = inbox.list();

  assert.deepEqual(
    flags.map((flag) => [flag.clipId, flag.concept.title, flag.angle, flag.reason, flag.note]),
    [[a2.clipId, "A2", "analogy", "Pronunciation", "cache came out as catchê"]],
  );
  assert.ok(flags[0].at instanceof Date);
  assert.deepEqual(
    notLanding.map((item) => [
      item.concept.title,
      item.clipId,
      item.tried,
      item.fit,
      item.passages.map((passage) => passage.text),
    ]),
    [["A1", a1.clipId, ["analogy"], 1, ["A1\nA2\nA3"]]],
  );
  assert.ok(notLanding[0].since instanceof Date);
  assert.deepEqual(
    stuck.map((job) => [job.kind, job.stage, job.source, job.chapter, job.concept, job.angle]),
    [
      ["extract_chapter", null, { title: "ostep" }, { title: "Locks" }, null, null],
      ["new", null, null, null, { title: "A3" }, "analogy"],
    ],
  );
  assert.match(stuck[0].lastError!, /extract failed/);
  assert.match(stuck[1].lastError!, /script failed/);
});

test("resolving a 🚩 takes it out of the inbox; ⏭️ on a not-landing Concept retires it out", async () => {
  const { feed, inbox } = await setup();
  const [a1, a2] = feed.next();
  feed.press(a1.clipId, "didnt_get", randomUUID());
  feed.press(a2.clipId, "flag", randomUUID(), { reason: "Wrong caption" });
  const [flag] = inbox.list().flags;

  inbox.resolve(flag.eventId);
  feed.press(inbox.list().notLanding[0].clipId, "know", randomUUID());

  const { flags, notLanding, stuck } = inbox.list();
  assert.deepEqual([flags, notLanding, stuck.length], [[], [], 2]);
  assert.throws(() => inbox.resolve(flag.eventId), /not an open 🚩/);
});

test("Regenerate on a 🚩 queues one job however often it is tapped, and puts a stuck one back in the queue", async () => {
  const { data, feed, inbox } = await setup();
  const [a1] = feed.next();
  feed.press(a1.clipId, "flag", randomUUID(), { reason: "Pronunciation" });
  const [flag] = inbox.list().flags;
  /** The regenerate jobs' statuses. */
  const regenerates = () =>
    data.db
      .select({ status: jobs.status, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.kind, "regenerate"))
      .all();

  inbox.regenerate(flag.eventId);
  inbox.regenerate(flag.eventId);
  assert.deepEqual(regenerates(), [{ status: "queued", attempts: 0 }]);
  assert.deepEqual(inbox.list().flags, []);

  data.db.update(jobs).set({ status: "stuck", attempts: 3 }).where(eq(jobs.kind, "regenerate")).run();
  assert.deepEqual(
    inbox.list().flags.map((item) => item.eventId),
    [flag.eventId],
  );
  inbox.regenerate(flag.eventId);
  assert.deepEqual(regenerates(), [{ status: "queued", attempts: 0 }]);

  inbox.resolve(flag.eventId);
  assert.throws(() => inbox.regenerate(flag.eventId), /not an open 🚩/);
});
