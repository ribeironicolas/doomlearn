import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Refused } from "@doomlearn/core/media";
import { type Config, openData } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { createInbox } from "@doomlearn/core/inbox";
import { LANGUAGE_TAGS } from "@doomlearn/core/languages";
import { createPipeline } from "@doomlearn/core/pipeline";
import { createPronunciation } from "@doomlearn/core/pronunciation";
import {
  agentCalls,
  chapters,
  clips,
  concepts,
  events,
  favorites,
  jobs,
  passages,
  sources,
} from "@doomlearn/core/schema";
import { recordUsage } from "@doomlearn/core/usage";
import { hc } from "hono/client";
import { type AppType, feedApp, serve, type UsageProbes } from "./server.ts";
import { createSources } from "@doomlearn/core/sources";
import { createTranslations } from "@doomlearn/core/translations";
import { editConfig, fakeAgent, fakeMedia } from "@doomlearn/core/test/fakes";
import { publishLiveness, publishPreflight, publishStage } from "@doomlearn/core/status";

/**
 * A data folder with one Source of two Concepts, each with a Clip, and the Feed app called in-process.
 * Uploads are converted by a fake that refuses any file named `scanned.pdf`.
 * POSTs carry the Origin header a browser sends from the app's own page. The usage probes are fakes: Claude is
 * logged in to claude.ai, and the Codex probe fails the test unless `probes` replaces it. The agent preflight a config
 * save runs finds nothing unless `preflight` replaces it.
 */
async function setup(
  config: object = {},
  probes: Partial<UsageProbes> = {},
  preflight = async (_config: Config) => ({ problems: [] as string[], warnings: [] as string[] }),
) {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  const data = openData(home);
  await writeFile(join(dir, "book.md"), "C1\nC2");
  await createSources(data, fakeMedia({ chapters: [{ title: "ch", text: "C1\nC2" }] })).add(join(dir, "book.md"));
  const agent = fakeAgent({
    extract: (chapter) =>
      chapter
        .split("\n")
        .map((line) => ({ title: line, summary: line, angles: ["analogy"], anchor: { chapter: line } })),
  });
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  const media = fakeMedia();
  const uploads = {
    ...media,
    convert: async (file: string) => {
      if (file.endsWith("/scanned.pdf")) throw new Refused("Scanned PDF: 2 of 3 pages have no text layer");
      return media.convert(file);
    },
  };
  const modules = {
    feed: createFeed(data),
    sources: createSources(data, uploads),
    inbox: createInbox(data),
    pronunciation: createPronunciation(data),
    translations: createTranslations(data),
    probes: {
      codex: async () => {
        throw new Error("the Codex probe ran with no stage on Codex");
      },
      claudeAuthMethod: async () => "claude.ai",
      ...probes,
    },
    preflight,
  };
  const app = feedApp(data, modules);
  const fetch = async (path: string, init?: RequestInit) => app.request(path, init);
  return {
    data,
    modules,
    home,
    fetch,
    post: (path: string, body: object | string) =>
      fetch(path, {
        method: "POST",
        headers: { origin: "http://localhost" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    concept: (title: string) => data.db.select().from(concepts).where(eq(concepts.title, title)).get()!,
  };
}

test("GET /api/next is the Feed’s next slots, each Clip as a URL the app can fetch", async () => {
  const { fetch } = await setup();

  const slots = await (await fetch("/api/next")).json();

  assert.deepEqual(
    slots.map(
      (slot: { kind: string; concept: { title: string }; source: { title: string }; url: string; file?: string }) => [
        slot.kind,
        slot.concept.title,
        slot.source.title,
        slot.url,
        slot.file,
      ],
    ),
    [
      ["new", "C1", "book", "/clips/1-analogy-2.mp4", undefined],
      ["new", "C2", "book", "/clips/2-analogy-3.mp4", undefined],
    ],
  );
});

test("/api/next items and Search hits carry their Clip's Language", async () => {
  const { data, fetch, concept } = await setup();
  data.db
    .update(clips)
    .set({ language: "en" })
    .where(eq(clips.conceptId, concept("C2").id))
    .run();

  const slots = await (await fetch("/api/next")).json();
  const hits = await (await fetch("/api/search?q=thread")).json();

  const byClip = ({ clipId, language }: { clipId: number; language: string }) => ({ clipId, language });
  assert.deepEqual(slots.map(byClip), [
    { clipId: 1, language: "pt-BR" },
    { clipId: 2, language: "en" },
  ]);
  assert.deepEqual(hits.map(byClip), [
    { clipId: 1, language: "pt-BR" },
    { clipId: 2, language: "en" },
  ]);
});

test("a press synced twice with its client event id is applied once", async () => {
  const { data, fetch, post, concept } = await setup();
  const [slot] = await (await fetch("/api/next")).json();
  const press = { clipId: slot.clipId, button: "didnt_get", clientEventId: randomUUID() };

  assert.equal((await post("/api/press", press)).status, 204);
  assert.equal((await post("/api/press", press)).status, 204);

  assert.equal(data.db.select().from(events).all().length, 1);
  assert.equal(concept("C1").ladderStep, 0);
});

test("🚩 is sent with its reason; a watch to the end is an implicit ✅", async () => {
  const { data, fetch, post, concept } = await setup();
  const [first, second] = await (await fetch("/api/next")).json();

  await post("/api/press", {
    clipId: first.clipId,
    button: "flag",
    clientEventId: randomUUID(),
    reason: "Wrong content",
  });
  await post("/api/seen", { clipId: second.clipId, clientEventId: randomUUID(), completed: true });

  assert.deepEqual(data.db.select({ kind: events.kind, reason: events.reason }).from(events).all(), [
    { kind: "flag", reason: "Wrong content" },
    { kind: "seen", reason: null },
  ]);
  assert.equal(concept("C2").ladderStep, 0);
  assert.deepEqual(await (await fetch("/api/next")).json(), []);
});

test("GET /api/today is the end screen’s summary", async () => {
  const { fetch } = await setup({ worker: { bufferTarget: 5 } });

  assert.deepEqual(await (await fetch("/api/today")).json(), {
    counts: { got_it: 0, didnt_get: 0, know: 0, flag: 0 },
    buffer: { ready: 2, generating: 0, target: 5 },
    dueTomorrow: 0,
  });
});

test("a press the Feed rejects answers 500 so the app drops it instead of retrying forever", async () => {
  const { fetch, post } = await setup();

  assert.equal((await post("/api/press", { clipId: 999, button: "got_it", clientEventId: randomUUID() })).status, 500);
  assert.equal((await fetch("/api/next")).status, 200);
});

test("a press posted with no Content-Type, as the legacy app sends it, is applied like any other", async () => {
  const { data, fetch } = await setup();
  const [slot] = await (await fetch("/api/next")).json();
  const body = new TextEncoder().encode(
    JSON.stringify({ clipId: slot.clipId, button: "got_it", clientEventId: randomUUID() }),
  );
  const press = new Request("http://localhost/api/press", {
    method: "POST",
    headers: { origin: "http://localhost" },
    body,
  });
  assert.equal(press.headers.get("content-type"), null);

  assert.equal((await fetch(press.url, press)).status, 204);
  assert.deepEqual(data.db.select({ kind: events.kind }).from(events).all(), [{ kind: "got_it" }]);
});

test("a malformed request answers 400 with the zod error tree, and changes nothing", async () => {
  const { data, post } = await setup();

  const res = await post("/api/press", { clipId: "one", button: "meh", clientEventId: randomUUID() });
  assert.equal(res.status, 400);
  const { properties } = await res.json();
  assert.deepEqual(Object.keys(properties), ["clipId", "button"]);
  assert.equal((await post("/api/press", "{not json")).status, 400);
  assert.equal((await post("/api/pause", {})).status, 400);
  assert.deepEqual(data.db.select().from(events).all(), []);
});

test("a JSON body over 64 KB answers 413", async () => {
  const { post } = await setup();

  const res = await post("/api/press", {
    clipId: 1,
    button: "flag",
    clientEventId: randomUUID(),
    note: "x".repeat(64 * 1024),
  });
  assert.equal(res.status, 413);
});

test('an upload over 200 MB answers 413 "file over 200 MB"', async () => {
  const { data, fetch } = await setup();

  const res = await fetch("/api/sources?name=huge.pdf", {
    method: "POST",
    headers: { origin: "http://localhost", "content-length": String(200 * 1024 * 1024 + 1) },
    body: "bytes",
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "file over 200 MB" });
  assert.equal(data.db.select().from(sources).all().length, 1);
});

test("a POST from another site is refused with 403, so a page open on the Mac cannot press for the Learner", async () => {
  const { data, fetch } = await setup();
  const [slot] = await (await fetch("/api/next")).json();

  const res = await fetch("/api/press", {
    method: "POST",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ clipId: slot.clipId, button: "know", clientEventId: randomUUID() }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(data.db.select().from(events).all(), []);
});

test("POST /api/favorite on and off is idempotent and ignores an unknown Clip; /api/next items and Search hits carry favorite", async () => {
  const { fetch, post } = await setup();
  // Each Clip's favorite, as /api/next and Search show it.
  const starred = async () => {
    const byClip = ({ clipId, favorite }: { clipId: number; favorite: boolean }) => [clipId, favorite];
    return [
      (await (await fetch("/api/next")).json()).map(byClip),
      (await (await fetch("/api/search?q=thread")).json()).map(byClip),
    ];
  };

  for (const on of [true, true]) assert.equal((await post("/api/favorite", { clipId: 2, on })).status, 204);
  assert.deepEqual(await starred(), [
    [
      [1, false],
      [2, true],
    ],
    [
      [1, false],
      [2, true],
    ],
  ]);

  for (const on of [false, false]) assert.equal((await post("/api/favorite", { clipId: 2, on })).status, 204);
  assert.deepEqual(await starred(), [
    [
      [1, false],
      [2, false],
    ],
    [
      [1, false],
      [2, false],
    ],
  ]);
  assert.equal((await post("/api/favorite", { clipId: 2 })).status, 400);
  // A ⭐ queued on the phone for a Clip gone since.
  assert.equal((await post("/api/favorite", { clipId: 99, on: true })).status, 204);
  assert.deepEqual(await (await fetch("/api/favorites")).json(), []);
});

test("GET /api/favorites lists newest first with Concept, Angle, Language, Source, Concept and Source state, flag and file URL", async () => {
  const { data, fetch, post, concept } = await setup();
  await post("/api/favorite", { clipId: 1, on: true });
  await post("/api/favorite", { clipId: 2, on: true });
  // Clip 1 starred first, so the order is by time.
  data.db
    .update(favorites)
    .set({ createdAt: new Date(0) })
    .where(eq(favorites.clipId, 1))
    .run();
  await post("/api/press", { clipId: 2, button: "flag", clientEventId: randomUUID(), reason: "Other" });
  await post("/api/press", { clipId: 1, button: "know", clientEventId: randomUUID() });
  data.db.update(sources).set({ status: "paused" }).run();

  const list = await (await fetch("/api/favorites")).json();

  assert.deepEqual(list, [
    {
      clipId: 2,
      url: "/clips/2-analogy-3.mp4",
      angle: "analogy",
      language: "pt-BR",
      // Paused through its Source.
      concept: { id: concept("C2").id, title: "C2", status: "new", days: null, deleted: false, paused: true },
      source: { id: 1, title: "book", status: "paused" },
      flagged: true,
    },
    {
      clipId: 1,
      url: "/clips/1-analogy-2.mp4",
      angle: "analogy",
      language: "pt-BR",
      concept: { id: concept("C1").id, title: "C1", status: "retired", days: null, deleted: false, paused: true },
      source: { id: 1, title: "book", status: "paused" },
      flagged: false,
    },
  ]);
});

test("search answers over HTTP with each Clip as a URL", async () => {
  const { fetch } = await setup();

  const hits = await (await fetch("/api/search?q=thread")).json();

  assert.deepEqual(
    hits.map((hit: { concept: { title: string }; url: string; file?: string }) => [
      hit.concept.title,
      hit.url,
      hit.file,
    ]),
    [
      ["C1", "/clips/1-analogy-2.mp4", undefined],
      ["C2", "/clips/2-analogy-3.mp4", undefined],
    ],
  );
});

test("a 🚩 with reason and note shows in the inbox until resolved", async () => {
  const { fetch, post } = await setup();
  const [slot] = await (await fetch("/api/next")).json();
  await post("/api/press", {
    clipId: slot.clipId,
    button: "flag",
    clientEventId: randomUUID(),
    reason: "Pronunciation",
    note: "catchê",
  });

  const { flags } = await (await fetch("/api/inbox")).json();
  assert.deepEqual(
    flags.map((flag: { reason: string; note: string; url: string }) => [flag.reason, flag.note, flag.url]),
    [["Pronunciation", "catchê", "/clips/1-analogy-2.mp4"]],
  );

  assert.equal((await post("/api/resolve", { eventId: flags[0].eventId })).status, 204);
  assert.deepEqual((await (await fetch("/api/inbox")).json()).flags, []);
});

test("Regenerate on a 🚩 queues its Clip's regenerate and takes it out of the inbox", async () => {
  const { data, fetch, post } = await setup();
  const [slot] = await (await fetch("/api/next")).json();
  await post("/api/press", { clipId: slot.clipId, button: "flag", clientEventId: randomUUID(), reason: "Wrong" });
  const { flags } = await (await fetch("/api/inbox")).json();

  assert.equal((await post("/api/regenerate", { eventId: flags[0].eventId })).status, 204);

  assert.deepEqual((await (await fetch("/api/inbox")).json()).flags, []);
  assert.deepEqual(
    data.db
      .select({ kind: jobs.kind, status: jobs.status, conceptId: jobs.conceptId, angle: jobs.angle })
      .from(jobs)
      .where(eq(jobs.kind, "regenerate"))
      .all(),
    [{ kind: "regenerate", status: "queued", conceptId: slot.concept.id, angle: slot.angle }],
  );
});

/**
 * The first Clip flagged 🚩 Pronunciation, and its event id.
 */
async function flagged({ fetch, post }: Awaited<ReturnType<typeof setup>>) {
  const [slot] = await (await fetch("/api/next")).json();
  await post("/api/press", {
    clipId: slot.clipId,
    button: "flag",
    clientEventId: randomUUID(),
    reason: "Pronunciation",
  });
  const { flags } = await (await fetch("/api/inbox")).json();
  return { slot, eventId: flags[0].eventId as number };
}

test("the fix sheet of a 🚩 lists the script's words with their beat and sentence, and what the voice says for each", async () => {
  const app = await setup();
  const { eventId } = await flagged(app);

  const sheet = await (await app.fetch(`/api/fix?eventId=${eventId}`)).json();

  assert.equal(sheet.language, "pt-BR");
  assert.deepEqual(sheet.words.slice(0, 2), [
    { text: "Já", beat: 0, sentence: 0, markup: false, chunk: 0 },
    { text: "pensou", beat: 0, sentence: 0, markup: false, chunk: 1 },
  ]);
  const thread = sheet.words.find((word: { text: string }) => word.text === "thread");
  assert.deepEqual([thread.beat, sheet.says[thread.chunk]], [1, "tréd"]);
});

test("a preview answers {status, error, wavUrl, blocker} on create and poll; its wav is served once it is spoken, once", async () => {
  const app = await setup();
  const { data, fetch, post, modules } = app;
  const { eventId } = await flagged(app);
  publishLiveness(data, { liveness: "running" });

  const created = await post("/api/preview", {
    eventId,
    beat: 1,
    sentence: 0,
    fixes: [{ term: "cozinheiro", respelling: "kuzinhêro" }],
  });
  assert.equal(created.status, 201);
  const { id, ...queued } = await created.json();
  assert.deepEqual(queued, { status: "queued", error: null, blocker: null, step: "next", wavUrl: null });

  await modules.pronunciation.serve(fakeMedia(), {
    languages: LANGUAGE_TAGS,
    held: () => undefined,
    loading: () => false,
  });
  const done = await (await fetch(`/api/preview?id=${id}`)).json();
  assert.deepEqual(done, {
    status: "done",
    error: null,
    blocker: null,
    step: null,
    wavUrl: `/api/preview/wav?id=${id}`,
  });

  const wav = await fetch(done.wavUrl);
  assert.equal(wav.headers.get("content-type"), "audio/wav");
  assert.equal(
    Buffer.from(await wav.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "RIFF",
  );
  const again = await fetch(done.wavUrl);
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { error: `No wav for preview #${id}` });
  assert.equal((await (await fetch(`/api/preview?id=${id}`)).json()).status, "played");
});

test("with the worker stopped or a media problem in the Clip's Language, the preview poll returns the Blocker's text", async () => {
  const app = await setup();
  const { data, fetch, post } = app;
  const { eventId } = await flagged(app);
  const { id } = await (await post("/api/preview", { eventId, beat: 0, sentence: 0, fixes: [] })).json();
  /** The poll's Blocker. */
  const blocker = async () => (await (await fetch(`/api/preview?id=${id}`)).json()).blocker;

  assert.equal(await blocker(), "server not running: run `pnpm start`");
  publishLiveness(data, { liveness: "stopped", exitReason: "worker exited with code 1" });
  assert.equal(await blocker(), "worker exited with code 1");
  publishLiveness(data, { liveness: "running" });
  publishPreflight(data, [
    "codex not logged in: run `codex login`",
    { reason: "tts environment outdated: run `pnpm bootstrap`", languages: ["pt-BR", "en", "es"] },
  ]);
  assert.equal(await blocker(), "tts environment outdated: run `pnpm bootstrap`");
  publishPreflight(data, ["codex not logged in: run `codex login`"]);
  assert.equal(await blocker(), null);
});

test("Save writes the fixes to the Clip's Language Lexicon and queues one regenerate; a bad Respelling or Lexicon is refused", async () => {
  const app = await setup();
  const { data, home, post } = app;
  const { slot, eventId } = await flagged(app);
  const lexicon = join(home, "lexicon.json");
  const regenerates = () => data.db.select().from(jobs).where(eq(jobs.kind, "regenerate")).all();

  assert.equal((await post("/api/fix", { eventId, fixes: [{ term: "Thread", respelling: "—" }] })).status, 400);
  await writeFile(lexicon, '{"thread": "tréd",}');
  const broken = await post("/api/fix", { eventId, fixes: [{ term: "Thread", respelling: "trréd" }] });
  assert.equal(broken.status, 409);
  assert.match((await broken.json()).error, /lexicon\.json is not valid JSON/);
  assert.equal(await readFile(lexicon, "utf8"), '{"thread": "tréd",}');
  assert.deepEqual(regenerates(), []);

  await writeFile(lexicon, JSON.stringify({ thread: "tréd", despensa: "dispensa" }));
  assert.equal((await post("/api/fix", { eventId, fixes: [{ term: "Thread", respelling: "trréd" }] })).status, 204);
  assert.equal((await post("/api/fix", { eventId, fixes: [{ term: "receita", respelling: "rêceita" }] })).status, 204);

  assert.deepEqual(JSON.parse(await readFile(lexicon, "utf8")), {
    despensa: "dispensa",
    Thread: "trréd",
    receita: "rêceita",
  });
  assert.deepEqual(
    regenerates().map((job) => [job.conceptId, job.status]),
    [[slot.concept.id, "queued"]],
  );
});

test("the fix sheet, a preview and Save answer 404 for a 🚩 that is not open, and the poll for an unknown preview", async () => {
  const app = await setup();
  const { fetch, post } = app;
  const { eventId } = await flagged(app);
  await post("/api/resolve", { eventId });
  const preview = { eventId, beat: 0, sentence: 0, fixes: [] };

  for (const res of [
    await fetch(`/api/fix?eventId=${eventId}`),
    await post("/api/fix", { eventId, fixes: [{ term: "thread", respelling: "trréd" }] }),
    await post("/api/preview", preview),
    await fetch("/api/preview?id=999"),
  ]) {
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /is not an open 🚩|No preview #999/);
  }
});

test("an uploaded Source is added under its file name; a refused one answers 422 with the reason", async () => {
  const { data, fetch } = await setup();
  const upload = (name: string) =>
    fetch(`/api/sources?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: `bytes of ${name}`,
    });

  const added = await upload("ostep.md");
  assert.equal(added.status, 201);
  assert.equal((await added.json()).title, "ostep");

  const refused = await upload("scanned.pdf");
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: "Scanned PDF: 2 of 3 pages have no text layer" });
  assert.deepEqual(await upload("notes.docx").then((res) => res.json()), {
    error: "Unsupported Source type: notes.docx",
  });
  assert.deepEqual(data.db.select({ title: sources.title }).from(sources).all(), [
    { title: "book" },
    { title: "ostep" },
  ]);
});

test("the Sources screen reads status, pauses, resumes and retries over HTTP", async () => {
  const { data, fetch, post } = await setup();
  const status = async () => (await (await fetch("/api/sources")).json()).sources[0];

  assert.equal((await post("/api/pause", { sourceId: 1 })).status, 204);
  assert.equal((await status()).status, "paused");
  assert.equal((await post("/api/resume", { sourceId: 1 })).status, 204);
  assert.deepEqual([(await status()).status, (await status()).chapters], ["active", { done: 1, total: 1 }]);

  const job = data.db.select().from(jobs).get()!;
  data.db.update(jobs).set({ status: "stuck" }).where(eq(jobs.id, job.id)).run();
  assert.equal((await post("/api/retry", { jobId: job.id })).status, 204);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, "queued");
});

test("GET /api/sources/:id lists chapters in book order with state and Concept count, each Concept with its ladder, Passages, Clips and other chapters", async () => {
  const { data, fetch, home, concept } = await setup();
  await writeFile(join(home, "paper.pdf"), "%PDF");
  await createSources(
    data,
    fakeMedia({
      chapters: [
        { title: "Locks", text: "" },
        { title: "Waiting", text: "" },
        { title: "Running", text: "" },
        { title: "Paused", text: "" },
        { title: "Queued", text: "" },
      ],
    }),
  ).add(join(home, "paper.pdf"));
  const [c1, c2] = [concept("C1"), concept("C2")];
  const due = new Date("2026-11-01T09:00:00Z");
  const since = new Date("2026-10-18T09:00:00Z");
  // C1's seq comes after C2's and C3's, so only reading order puts it first.
  data.db
    .update(concepts)
    .set({ status: "scheduled", ladderStep: 2, dueAt: due, seq: 9 })
    .where(eq(concepts.id, c1.id))
    .run();
  data.db
    .update(concepts)
    .set({ status: "retired", retiredReason: "known", notLandingAt: since })
    .where(eq(concepts.id, c2.id))
    .run();
  const [c1Clip, c2Clip] = [c1, c2].map((c) => data.db.select().from(clips).where(eq(clips.conceptId, c.id)).get()!);
  data.db.update(clips).set({ lastSeenAt: since }).where(eq(clips.id, c1Clip.id)).run();
  data.db.update(clips).set({ hidden: true }).where(eq(clips.id, c2Clip.id)).run();
  const en = data.db
    .insert(clips)
    .values({ conceptId: c1.id, angle: "analogy", language: "en", script: "[]", caption: "c", file: "/x/en.mp4" })
    .returning()
    .get();
  data.db.insert(favorites).values({ clipId: en.id }).run();
  // The paper's first chapter is extracted and teaches C1 too; its second is stuck, its third extracting, its fourth
  // paused and its fifth queued.
  const [locks, waiting, running, paused] = data.db
    .select()
    .from(chapters)
    .where(eq(chapters.sourceId, 2))
    .orderBy(chapters.seq)
    .all();
  data.db.update(jobs).set({ status: "running" }).where(eq(jobs.chapterId, running.id)).run();
  data.db.update(jobs).set({ status: "paused" }).where(eq(jobs.chapterId, paused.id)).run();
  data.db.update(chapters).set({ status: "extracted" }).where(eq(chapters.id, locks.id)).run();
  data.db.update(jobs).set({ status: "done" }).where(eq(jobs.chapterId, locks.id)).run();
  data.db
    .update(jobs)
    .set({ status: "stuck", lastError: "Error: no anchors" })
    .where(eq(jobs.chapterId, waiting.id))
    .run();
  data.db
    .insert(passages)
    .values({ conceptId: c1.id, sourceId: 2, chapterId: locks.id, anchor: { pages: [3, 3] }, text: "Locks guard." })
    .run();
  // C3, taught by the book, has no Clip and a queued new job.
  const [ch] = data.db.select().from(chapters).where(eq(chapters.sourceId, 1)).all();
  const c3 = data.db
    .insert(concepts)
    .values({ title: "C3", summary: "s3", fitAngles: ["analogy"], sourceId: 1, seq: 2 })
    .returning()
    .get();
  data.db
    .insert(passages)
    .values({ conceptId: c3.id, sourceId: 1, chapterId: ch.id, anchor: { chapter: "ch" }, text: "C3" })
    .run();
  data.db.insert(jobs).values({ kind: "new", priority: 1, conceptId: c3.id, angle: "analogy" }).run();

  const book = await (await fetch("/api/sources/1")).json();
  const paper = await (await fetch("/api/sources/2")).json();

  assert.deepEqual(
    book.chapters.map((c: { seq: number; title: string; state: string; conceptCount: number }) => [
      c.seq,
      c.title,
      c.state,
      c.conceptCount,
    ]),
    [[0, "ch", "extracted", 3]],
  );
  const [first, second, third] = book.chapters[0].concepts;
  assert.deepEqual(first, {
    id: c1.id,
    title: "C1",
    summary: "C1",
    status: "scheduled",
    ladderStep: 2,
    dueAt: due.toISOString(),
    retiredReason: null,
    notLandingAt: null,
    paused: false,
    deleted: false,
    deletedByHand: false,
    deletedWith: [],
    making: false,
    alsoIn: [{ source: { id: 2, title: "paper" }, chapter: { id: locks.id, seq: 0, title: "Locks" } }],
    passages: [{ id: 1, text: "C1\nC2" }],
    clips: [
      {
        clipId: c1Clip.id,
        url: "/clips/1-analogy-2.mp4",
        angle: "analogy",
        language: "pt-BR",
        seen: true,
        flagged: false,
        favorite: false,
      },
      {
        clipId: en.id,
        url: "/clips/en.mp4",
        angle: "analogy",
        language: "en",
        seen: false,
        flagged: false,
        favorite: true,
      },
    ],
  });
  assert.deepEqual(
    [second.title, second.status, second.retiredReason, second.notLandingAt, second.clips[0].flagged],
    ["C2", "retired", "known", since.toISOString(), true],
  );
  assert.deepEqual([third.title, third.clips, third.making, third.alsoIn], ["C3", [], true, []]);

  assert.deepEqual(
    paper.chapters.map(
      (c: { title: string; state: string; conceptCount: number; stuck: unknown; concepts: { title: string }[] }) => [
        c.title,
        c.state,
        c.conceptCount,
        c.stuck,
        c.concepts.map((x) => x.title),
      ],
    ),
    [
      ["Locks", "extracted", 1, null, ["C1"]],
      [
        "Waiting",
        "stuck",
        0,
        {
          jobId: data.db.select().from(jobs).where(eq(jobs.chapterId, waiting.id)).get()!.id,
          lastError: "Error: no anchors",
        },
        [],
      ],
      ["Running", "extracting", 0, null, []],
      ["Paused", "paused", 0, null, []],
      ["Queued", "waiting", 0, null, []],
    ],
  );
  assert.equal(book.ladderSteps, 5);
  // From the paper's side, C1 is also in the book's chapter.
  assert.deepEqual(paper.chapters[0].concepts[0].alsoIn, [
    { source: { id: 1, title: "book" }, chapter: { id: ch.id, seq: 0, title: "ch" } },
  ]);
  assert.equal((await fetch("/api/sources/99")).status, 404);
});

test("pause, resume, delete and restore of a chapter and a Concept answer 204 and show in GET /api/sources/:id; a pause of a Retired or Deleted one 409", async () => {
  const { fetch, post, concept, data } = await setup();
  const [ch] = data.db.select().from(chapters).where(eq(chapters.sourceId, 1)).all();
  /**
   * The book's chapter and its Concepts as the Source screen shows them.
   */
  const screen = async () => {
    const [chapter] = (await (await fetch("/api/sources/1")).json()).chapters;
    return {
      chapter: [chapter.state, chapter.paused, chapter.deleted],
      concepts: chapter.concepts.map(
        (c: {
          title: string;
          paused: boolean;
          deleted: boolean;
          deletedByHand: boolean;
          deletedWith: { chapter: { seq: number } }[];
        }) => [c.title, c.paused, c.deleted, c.deletedByHand, c.deletedWith.map((place) => place.chapter.seq)],
      ),
    };
  };
  /**
   * POSTs an action to a chapter's or Concept's route, and gives its status.
   */
  const act = async (path: string) => (await post(path, {})).status;

  assert.equal(await act(`/api/chapters/${ch.id}/pause`), 204);
  assert.equal(await act(`/api/concepts/${concept("C1").id}/pause`), 204);
  assert.equal(await act(`/api/concepts/${concept("C2").id}/delete`), 204);
  assert.deepEqual(await screen(), {
    chapter: ["paused", true, false],
    concepts: [
      ["C1", true, false, false, []],
      ["C2", false, true, true, []],
    ],
  });

  assert.equal(await act(`/api/chapters/${ch.id}/resume`), 204);
  assert.equal(await act(`/api/concepts/${concept("C1").id}/resume`), 204);
  assert.equal(await act(`/api/chapters/${ch.id}/delete`), 204);
  assert.deepEqual(await screen(), {
    chapter: ["extracted", false, true],
    concepts: [
      ["C1", false, true, false, [ch.seq]],
      ["C2", false, true, true, []],
    ],
  });
  // A Deleted chapter or Concept, by hand or with its chapter, can be restored, not paused or resumed.
  assert.equal(await act(`/api/chapters/${ch.id}/pause`), 409);
  assert.equal(await act(`/api/concepts/${concept("C1").id}/pause`), 409);
  assert.equal(await act(`/api/concepts/${concept("C2").id}/resume`), 409);

  assert.equal(await act(`/api/chapters/${ch.id}/restore`), 204);
  assert.equal(await act(`/api/concepts/${concept("C2").id}/restore`), 204);
  assert.deepEqual(await screen(), {
    chapter: ["extracted", false, false],
    concepts: [
      ["C1", false, false, false, []],
      ["C2", false, false, false, []],
    ],
  });

  data.db
    .update(concepts)
    .set({ status: "retired", retiredReason: "known" })
    .where(eq(concepts.id, concept("C1").id))
    .run();
  assert.equal(await act(`/api/concepts/${concept("C1").id}/pause`), 409);
  assert.equal(await act("/api/concepts/99/delete"), 404);
  assert.equal(await act(`/api/chapters/99/restore`), 404);
  assert.equal(await act(`/api/chapters/${ch.id}/erase`), 400);
});

test("GET /api/sources/:id of a just-added Source has every chapter waiting with no Concepts", async () => {
  const { data, fetch, home } = await setup();
  await writeFile(join(home, "paper.pdf"), "%PDF");
  await createSources(
    data,
    fakeMedia({
      chapters: [
        { title: "Locks", text: "" },
        { title: "Waiting", text: "" },
      ],
    }),
  ).add(join(home, "paper.pdf"));

  const fresh = await (await fetch("/api/sources/2")).json();

  assert.deepEqual(
    fresh.chapters.map((c: { state: string; conceptCount: number; concepts: unknown[] }) => [
      c.state,
      c.conceptCount,
      c.concepts,
    ]),
    [
      ["waiting", 0, []],
      ["waiting", 0, []],
    ],
  );
});

test("Clips are served with byte ranges, so video can seek and loop", async () => {
  const { fetch } = await setup();

  const whole = await fetch("/clips/1-analogy-2.mp4");
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(await whole.text(), "fake mp4");
  const part = await fetch("/clips/1-analogy-2.mp4", { headers: { range: "bytes=5-" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 5-7/8");
  assert.equal(await part.text(), "mp4");
  assert.equal((await fetch("/clips/..%2Fconfig.json")).status, 404);
});

test("the built PWA is served at the same origin: its page on every app path, its service worker at /sw.js", async () => {
  const { data, modules } = await setup();
  const web = await mkdtemp(join(tmpdir(), "doomlearn-web-"));
  await writeFile(join(web, "index.html"), '<div id="root"></div>');
  await writeFile(join(web, "sw.js"), "// sw");
  const app = feedApp(data, modules, web);

  for (const path of ["/", "/search", "/inbox", "/sources"])
    assert.equal(await (await app.request(path)).text(), '<div id="root"></div>', path);
  const sw = await app.request("/sw.js");
  assert.match(sw.headers.get("content-type")!, /^text\/javascript\b/);
  assert.equal(await sw.text(), "// sw");
  // A missing API route or Clip is a 404, never the app's page.
  assert.equal((await app.request("/api/nope")).status, 404);
  assert.equal((await app.request("/clips/nope.mp4")).status, 404);
});

test("with a cert, serve() listens over HTTPS on every server.hosts entry only, never on other interfaces", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  await mkdir(join(dir, "tls"));
  // Stands in for the mkcert cert.
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost"].concat([
      "-keyout",
      join(dir, "tls", "key.pem"),
      "-out",
      join(dir, "tls", "cert.pem"),
    ]),
    { stdio: "ignore" },
  );
  // ::1 stands in for the ZeroTier IP.
  await writeFile(join(dir, "config.json"), JSON.stringify({ server: { hosts: ["127.0.0.1", "::1"] } }));
  const servers = serve(openData(dir), 0);
  t.onTestFinished(() => {
    for (const server of servers) server.close();
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.once("listening", resolve))));
  const [local, zerotier] = servers.map((server) => server.address() as AddressInfo);

  assert.deepEqual([local.address, zerotier.address], ["127.0.0.1", "::1"]);
  const status = await new Promise((resolve) =>
    httpsRequest({ host: "::1", port: zerotier.port, path: "/api/today", rejectUnauthorized: false }, (res) =>
      resolve(res.statusCode),
    ).end(),
  );
  assert.equal(status, 200);
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal && address.family === "IPv4");
  if (lan) {
    const error = await new Promise((resolve) =>
      request({ host: lan.address, port: local.port }).on("error", resolve).end(),
    );
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNREFUSED");
  }
});

test("serve() listens on the port in config.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  await mkdir(join(dir, "tls"));
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost"].concat([
      "-keyout",
      join(dir, "tls", "key.pem"),
      "-out",
      join(dir, "tls", "cert.pem"),
    ]),
    { stdio: "ignore" },
  );
  // A port free right now, found by letting the OS pick one.
  const free = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => free.once("listening", resolve));
  const { port } = free.address() as AddressInfo;
  await new Promise((resolve) => free.close(resolve));
  await writeFile(join(dir, "config.json"), JSON.stringify({ server: { hosts: ["127.0.0.1", "::1"], port } }));

  const servers = serve(openData(dir));
  t.onTestFinished(() => {
    for (const server of servers) server.close();
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.once("listening", resolve))));

  assert.deepEqual(
    servers.map((server) => (server.address() as AddressInfo).port),
    [port, port],
  );
});

test("with no cert and only loopback hosts, serve() serves plain HTTP on 127.0.0.1 and logs the mkcert steps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});
  const servers = serve(openData(dir), 0);
  t.onTestFinished(() => {
    for (const server of servers) server.close();
    logged.mockRestore();
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.once("listening", resolve))));

  assert.deepEqual(
    servers.map((server) => (server.address() as AddressInfo).address),
    ["127.0.0.1"],
  );
  const { port } = servers[0].address() as AddressInfo;
  const status = await new Promise((resolve) =>
    request({ host: "127.0.0.1", port, path: "/api/today" }, (res) => resolve(res.statusCode)).end(),
  );
  assert.equal(status, 200);
  const log = logged.mock.calls.flat().join("\n");
  assert.match(log, /mkcert -cert-file \S+cert\.pem -key-file \S+key\.pem/);
  assert.match(log, /add your ZeroTier IP to server\.hosts/);
});

test("serve() refuses to start with a non-loopback host and no cert, saying how to make one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  await writeFile(join(dir, "config.json"), JSON.stringify({ server: { hosts: ["127.0.0.1", "10.147.17.5"] } }));
  assert.throws(() => serve(openData(dir), 0), /No TLS cert.*mkcert .*10\.147\.17\.5/s);
});

//
// GET /api/usage
//

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The scene stage on Codex, so the usage route probes it.
 */
const SCENE_ON_CODEX = { agents: { stages: { scene: { provider: "codex", model: "gpt-6-sol", effort: "low" } } } };

test("GET /api/usage shows each Usage window, own consumption grouped as asked, and past rate-limit pauses", async () => {
  const { data, fetch } = await setup();
  const at = new Date(2026, 9, 9, 8);
  const callId = data.db
    .insert(agentCalls)
    .values({
      stage: "script",
      provider: "claude",
      model: "opus",
      costUsd: 0.25,
      tokensIn: 100,
      tokensOut: 10,
      durationMs: 1000,
      isError: false,
      at,
    })
    .returning()
    .get().id;
  recordUsage(
    data,
    "claude",
    [
      {
        window: "five_hour",
        utilization: 0.4,
        resetsAt: new Date(Date.now() + 3_600_000),
        status: "allowed",
        source: "unified",
      },
    ],
    callId,
  );
  data.db
    .insert(agentCalls)
    .values({
      stage: "extract",
      provider: "claude",
      durationMs: 1,
      isError: true,
      apiErrorStatus: 429,
      retryAt: new Date(2026, 9, 9, 10),
      at,
    })
    .run();

  const response = await fetch("/api/usage?by=stage");

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.providers.map(
      ({
        provider,
        unavailable,
        windows,
      }: {
        provider: string;
        unavailable: string | null;
        windows: { window: string; utilization: number }[];
      }) => ({
        provider,
        unavailable,
        windows: windows.map(({ window, utilization }) => ({ window, utilization })),
      }),
    ),
    [{ provider: "claude", unavailable: null, windows: [{ window: "five_hour", utilization: 0.4 }] }],
  );
  assert.deepEqual(body.consumption, [
    { key: "extract", calls: 1, errors: 1, apiEquivalentUsd: null, tokensIn: 0, tokensOut: 0, durationMs: 1 },
    { key: "script", calls: 1, errors: 0, apiEquivalentUsd: 0.25, tokensIn: 100, tokensOut: 10, durationMs: 1000 },
  ]);
  assert.match(body.costNote, /API-equivalent/);
  assert.deepEqual(body.pauses, [
    {
      at: at.toISOString(),
      provider: "claude",
      stage: "extract",
      until: new Date(2026, 9, 9, 10).toISOString(),
      durationMs: 7_200_000,
      estimated: false,
    },
  ]);
});

test("GET /api/usage says an API-key login has no plan windows, and refuses an unknown grouping", async () => {
  const { fetch } = await setup({}, { claudeAuthMethod: async () => "api_key" });

  const { providers } = await (await fetch("/api/usage")).json();
  assert.deepEqual(providers, [{ provider: "claude", unavailable: "api_key login has no plan windows", windows: [] }]);
  assert.equal((await fetch("/api/usage?by=week")).status, 400);
});

test("GET /api/usage waits for the Codex probe when a stage uses Codex, saving and showing its windows", async () => {
  const resetsAt = new Date(Date.now() + 3_600_000);
  const { data, fetch } = await setup(SCENE_ON_CODEX, {
    codex: async () => [{ window: "five_hour", utilization: 0.3, resetsAt, status: null, source: "probe" }],
  });

  const { providers } = await (await fetch("/api/usage?provider=codex")).json();

  assert.deepEqual(providers[1], {
    provider: "codex",
    unavailable: null,
    windows: [
      {
        window: "five_hour",
        utilization: 0.3,
        resetsAt: resetsAt.toISOString(),
        status: null,
        source: "probe",
        capturedAt: providers[1].windows[0].capturedAt,
        ageMs: providers[1].windows[0].ageMs,
        resetSince: null,
      },
    ],
  });
  assert.equal(
    data.db.$client.prepare("SELECT count(*) AS n FROM usage_snapshots WHERE provider = 'codex'").get()!.n,
    1,
  );
});

test("GET /api/usage shows a failed or timed-out Codex probe as unavailable, answering within 3 s", async () => {
  const failed = await setup(SCENE_ON_CODEX, { codex: async () => undefined });
  const { providers } = await (await failed.fetch("/api/usage")).json();
  assert.deepEqual(providers[1], { provider: "codex", unavailable: "codex probe failed", windows: [] });

  const hanging = await setup(SCENE_ON_CODEX, { codex: () => new Promise(() => {}) });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = hanging.fetch("/api/usage");
  await vi.advanceTimersByTimeAsync(2_999);
  let answered = false;
  void pending.then(() => {
    answered = true;
  });
  await Promise.resolve();
  assert.equal(answered, false);
  await vi.advanceTimersByTimeAsync(1);
  const timedOut = await (await pending).json();
  assert.deepEqual(timedOut.providers[1], { provider: "codex", unavailable: "codex probe timed out", windows: [] });
});

/**
 * `/api/status`'s Blockers, by kind, with their until-times as the JSON carries them.
 */
async function blockers(fetch: (path: string) => Promise<Response>) {
  const { blockers } = await (await fetch("/api/status")).json();
  return blockers as { kind: string; reason: string; until: string | null }[];
}

test("GET /api/status shows a running worker idle, its queue counts by status, and no Blocker", async () => {
  const { data, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });

  assert.deepEqual(await (await fetch("/api/status")).json(), {
    state: "idle",
    job: null,
    stage: null,
    restarts: 0,
    queue: { queued: 0, running: 0, paused: 0, stuck: 0, done: 3, cancelled: 0 },
    blockers: [],
  });
});

test("GET /api/status shows the job and stage the worker is on, since when", async () => {
  const { data, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  const [job] = data.db.select().from(jobs).where(eq(jobs.kind, "new")).all();
  const since = new Date();
  publishStage(data, { jobId: job.id, stage: "scene", startedAt: since });

  const status = await (await fetch("/api/status")).json();
  assert.equal(status.state, "running");
  assert.deepEqual(status.job, { id: job.id, kind: "new", source: "book", stage: "scene", since: since.toISOString() });

  publishStage(data, null);
  assert.equal((await (await fetch("/api/status")).json()).state, "idle");
});

test("a worker that is not running is a stopped Blocker: no server, or a crash with its restart count", async () => {
  const { data, fetch } = await setup();
  assert.deepEqual(await blockers(fetch), [
    { kind: "stopped", reason: "server not running: run `pnpm start`", until: null },
  ]);

  publishLiveness(data, { liveness: "stopped", exitReason: "worker exited with code 1, staying down", restarts: 3 });
  const status = await (await fetch("/api/status")).json();
  assert.equal(status.state, "stopped");
  assert.equal(status.restarts, 3);
  assert.deepEqual(status.blockers, [
    { kind: "stopped", reason: "worker exited with code 1, staying down", until: null },
  ]);
});

test("a worker asked to stop is a stopping Blocker, still showing its stage", async () => {
  const { data, fetch } = await setup();
  publishLiveness(data, { liveness: "stopping" });
  const [job] = data.db.select().from(jobs).all();
  publishStage(data, { jobId: job.id, stage: "extract", startedAt: new Date() });

  const status = await (await fetch("/api/status")).json();
  assert.equal(status.state, "stopping");
  assert.equal(status.job.stage, "extract");
  assert.deepEqual(status.blockers, [{ kind: "stopping", reason: "stopping after current stage", until: null }]);
});

test("each preflight failure the worker found is a Blocker while it runs", async () => {
  const { data, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  publishPreflight(data, ["codex not logged in: run `codex login`", "tts environment outdated: run `pnpm bootstrap`"]);

  assert.deepEqual(await blockers(fetch), [
    { kind: "preflight", reason: "codex not logged in: run `codex login`", until: null },
    { kind: "preflight", reason: "tts environment outdated: run `pnpm bootstrap`", until: null },
  ]);
});

test("a config.json broken at runtime is an invalid-config Blocker naming the problem", async () => {
  const { data, home, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await editConfig(home, { worker: { dailyClipcap: 3 } });

  const [blocker] = await blockers(fetch);
  logged.mockRestore();
  assert.equal(blocker.kind, "invalid_config");
  assert.match(blocker.reason, /config\.json is invalid:\n✖ Unrecognized key: "dailyClipcap"/);

  await editConfig(home, {});
  assert.deepEqual(await blockers(fetch), []);
});

test("a Worker pause is a Blocker until its time, or until resumed; a past pausedUntil is none", async () => {
  const { data, home, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  const until = new Date(Date.now() + 3_600_000);
  await editConfig(home, { worker: { pausedUntil: until.toISOString() } });
  assert.deepEqual(await blockers(fetch), [
    { kind: "worker_pause", reason: "Worker pause", until: until.toISOString() },
  ]);

  await editConfig(home, { worker: { paused: true } });
  assert.deepEqual(await blockers(fetch), [
    { kind: "worker_pause", reason: "Worker pause until resumed", until: null },
  ]);

  await editConfig(home, { worker: { pausedUntil: new Date(Date.now() - 60_000).toISOString() } });
  assert.deepEqual(await blockers(fetch), []);
});

test("outside every Run window is a Blocker until the next window opens", async () => {
  const { data, home, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  // A window opening at the top of the hour two hours from now, which may be tomorrow.
  const opens = new Date();
  opens.setHours(opens.getHours() + 2, 0, 0, 0);
  const hh = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:00`;
  await editConfig(home, {
    worker: { schedule: { windows: [{ start: hh(opens), end: hh(new Date(opens.getTime() + 3_600_000)) }] } },
  });

  assert.deepEqual(await blockers(fetch), [
    { kind: "outside_run_window", reason: "outside the Run windows", until: opens.toISOString() },
  ]);
});

test("a rate-limited Provider is a Blocker until its retry time", async () => {
  const { data, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  const retryAt = new Date(Date.now() + 600_000);
  data.db
    .insert(agentCalls)
    .values({ stage: "script", provider: "codex", durationMs: 1, isError: true, retryAt, at: new Date() })
    .run();

  assert.deepEqual(await blockers(fetch), [
    { kind: "rate_limited", reason: "codex rate limit", until: retryAt.toISOString() },
  ]);
});

test("a Claude Usage window at its threshold is a Blocker until it resets; every active Blocker is listed", async () => {
  const { data, home, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  const resetsAt = new Date(Date.now() + 3_600_000);
  recordUsage(data, "claude", [
    { window: "five_hour", utilization: 0.95, resetsAt, status: "allowed", source: "unified" },
  ]);
  await editConfig(home, { worker: { paused: true, stopAtUsagePercent: { fiveHour: 90 } } });

  assert.deepEqual(await blockers(fetch), [
    { kind: "worker_pause", reason: "Worker pause until resumed", until: null },
    { kind: "usage_threshold", reason: "Claude five_hour Usage window at 90% or more", until: resetsAt.toISOString() },
  ]);
});

/**
 * A config save from the PWA: `sections` at `version`, from the app's own page.
 */
const save = (fetch: (path: string, init?: RequestInit) => Promise<Response>, version: number, sections: object) =>
  fetch("/api/config", {
    method: "PUT",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ version, ...sections }),
  });

test("GET /api/config is the config with its version; a PUT at that version saves the section sparse and atomically", async () => {
  const preflighted: Config[] = [];
  const { home, fetch } = await setup({ server: { port: 9443 } }, {}, async (config) => {
    preflighted.push(config);
    return { problems: [], warnings: ['codex model "gpt-6-sol" (scene) is not in codex\'s model list'] };
  });
  const got = await (await fetch("/api/config")).json();
  assert.equal(got.config.worker.bufferTarget, 10);
  assert.equal(got.config.server.port, 9443);

  const worker = { ...got.config.worker, bufferTarget: 4 };
  const agents = {
    ...got.config.agents,
    stages: { ...got.config.agents.stages, scene: { provider: "codex", model: "gpt-6-sol", effort: "low" } },
  };
  const saved = await save(fetch, got.version, { worker, agents });

  assert.equal(saved.status, 200);
  const reply = await saved.json();
  // The Codex model warning comes back without blocking the save.
  assert.deepEqual(reply.warnings, ['codex model "gpt-6-sol" (scene) is not in codex\'s model list']);
  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")), {
    $schema: "./config.schema.json",
    agents: { stages: { scene: { provider: "codex", model: "gpt-6-sol", effort: "low" } } },
    worker: { bufferTarget: 4 },
    server: { port: 9443 },
  });
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.equal(preflighted[0].agents.stages.scene.provider, "codex");
  const again = await (await fetch("/api/config")).json();
  assert.equal(again.version, reply.version);
  assert.equal(again.config.worker.bufferTarget, 4);
});

test("a PUT /api/config at a stale version is 409 and the hand edit stays", async () => {
  const { home, fetch } = await setup();
  const { config, version } = await (await fetch("/api/config")).json();
  const edited = await editConfig(home, { worker: { dailyClipCap: 3 } });

  const saved = await save(fetch, version, { worker: { ...config.worker, paused: true } });

  assert.equal(saved.status, 409);
  assert.deepEqual(await saved.json(), { error: "config changed on disk, reload" });
  assert.equal(await readFile(join(home, "config.json"), "utf8"), edited);
});

test("while config.json is broken on disk, a PUT /api/config at its version is 409 naming the problem, and the hand edit stays", async () => {
  const { home, fetch } = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const edited = await editConfig(home, { worker: { dailyClipcap: 3 } });
  const { config, version } = await (await fetch("/api/config")).json();

  const saved = await save(fetch, version, { worker: { ...config.worker, paused: true } });
  logged.mockRestore();

  assert.equal(saved.status, 409);
  assert.match((await saved.json()).error, /config\.json is invalid:\n✖ Unrecognized key: "dailyClipcap"/);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), edited);
});

test("each section a PUT /api/config sends replaces the saved one whole: keys it leaves out go back to their defaults", async () => {
  const { home, fetch } = await setup();
  await editConfig(home, { worker: { bufferTarget: 4 } });
  const { version } = await (await fetch("/api/config")).json();

  assert.equal((await save(fetch, version, { worker: { paused: true } })).status, 200);

  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")).worker, { paused: true });
});

test("a section a PUT /api/config leaves out stays as saved", async () => {
  const { home, fetch } = await setup();
  const scene = { provider: "codex", model: "gpt-6-sol", effort: "low" };
  await editConfig(home, { agents: { stages: { scene } } });
  const { version } = await (await fetch("/api/config")).json();

  assert.equal((await save(fetch, version, { worker: { paused: true } })).status, 200);

  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")).agents, { stages: { scene } });
});

test("a PUT /api/config with a server key, or a value the schema refuses, is 400 naming the problem and changes nothing", async () => {
  const { home, fetch } = await setup();
  const before = await readFile(join(home, "config.json"), "utf8");
  const { config, version } = await (await fetch("/api/config")).json();

  assert.equal((await save(fetch, version, { server: { port: 9000 } })).status, 400);
  const refused = await save(fetch, version, { worker: { ...config.worker, bufferTarget: -1 } });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "✖ Too small: expected number to be >=0\n  → at worker.bufferTarget");
  assert.equal((await save(fetch, version, { worker: { ...config.worker, bufferTaget: 4 } })).status, 400);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), before);
});

test("a PUT /api/config saves worker.language; an unknown Language is 400; a config without it reads as pt-BR", async () => {
  // A config with hosts only, no worker.language.
  const { home, fetch } = await setup({ server: { hosts: ["127.0.0.1", "10.147.17.5"] } });
  const { config, version } = await (await fetch("/api/config")).json();
  assert.equal(config.worker.language, "pt-BR");

  const refused = await save(fetch, version, { worker: { ...config.worker, language: "fr" } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /expected one of "pt-BR"\|"en"\|"es"\n {2}→ at worker\.language/);

  assert.equal((await save(fetch, version, { worker: { ...config.worker, language: "en" } })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")).worker, { language: "en" });
  assert.equal((await (await fetch("/api/config")).json()).config.worker.language, "en");
});

test("the status and config routes are typed for the PWA’s hc client", async () => {
  const { data, fetch } = await setup();
  publishLiveness(data, { liveness: "running" });
  const client = hc<AppType>("http://localhost", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(String(input).replace("http://localhost", ""), init),
    headers: { origin: "http://localhost" },
  });

  const status = await (await client.api.status.$get()).json();
  const { config, version } = await (await client.api.config.$get()).json();
  const saved = await client.api.config.$put({ json: { version, worker: { ...config.worker, dailyClipCap: 5 } } });

  assert.equal(status.state, "idle");
  assert.equal(saved.status, 200);
  if (saved.status === 200) assert.deepEqual((await saved.json()).warnings, []);
});

test("POST /api/translate queues one translate job per Concept, Angle and Language, and GET /api/translations shows each Language's state", async () => {
  const { data, home, fetch, post, concept } = await setup();
  publishLiveness(data, { liveness: "running" });
  const source = data.db
    .select()
    .from(clips)
    .where(eq(clips.conceptId, concept("C1").id))
    .get()!;
  /** The 🌐 sheet's row for `language`. */
  const row = async (language: string) =>
    (await (await fetch(`/api/translations?clipId=${source.id}`)).json()).languages.find(
      (found: { language: string }) => found.language === language,
    );
  assert.deepEqual(await row("es"), {
    language: "es",
    name: "Spanish",
    made: null,
    job: null,
    capped: false,
    blocker: null,
  });

  const queued = await post("/api/translate", { clipId: source.id, language: "en" });
  assert.equal(queued.status, 200);
  const job = await queued.json();
  assert.deepEqual(
    [job.kind, job.language, job.fromClipId, job.conceptId, job.angle],
    ["translate", "en", source.id, source.conceptId, source.angle],
  );
  assert.equal(job.queued, true);
  const twice = await (await post("/api/translate", { clipId: source.id, language: "en" })).json();
  assert.deepEqual([twice.id, twice.queued], [job.id, false]);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.kind, "translate")).all().length, 1);
  assert.deepEqual((await row("en")).job, { id: job.id, status: "queued" });

  // Its voice is missing: only its Language is held.
  publishPreflight(data, [{ reason: "tts weights for English missing: run `pnpm bootstrap`", languages: ["en"] }]);
  assert.deepEqual((await row("en")).blocker, {
    reason: "tts weights for English missing: run `pnpm bootstrap`",
    until: null,
  });
  await post("/api/translate", { clipId: source.id, language: "es" });
  assert.equal((await row("es")).blocker, null);
  // 2 Clips made today reach a cap of 2.
  await editConfig(home, { worker: { dailyClipCap: 2 } });
  assert.equal((await row("en")).capped, true);

  await editConfig(home, {});
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());
  const made = data.db.select().from(clips).where(eq(clips.language, "en")).get()!;
  assert.deepEqual((await row("en")).made, {
    clipId: made.id,
    angle: made.angle,
    url: `/clips/${made.conceptId}-${made.angle}-${job.id}.mp4`,
  });
  assert.equal((await row("en")).job, null);

  const again = await post("/api/translate", { clipId: source.id, language: "en" });
  assert.deepEqual([again.status, await again.json()], [409, { error: "Already in English" }]);
  assert.equal((await post("/api/translate", { clipId: source.id, language: "fr" })).status, 400);
  assert.equal((await post("/api/translate", { clipId: 999, language: "en" })).status, 404);
  assert.equal((await fetch("/api/translations?clipId=999")).status, 404);
});

test("POST /api/translate on a Deleted Concept's Clip answers 409 and queues no job", async () => {
  const { data, post, concept } = await setup();
  const clip = data.db
    .select()
    .from(clips)
    .where(eq(clips.conceptId, concept("C1").id))
    .get()!;
  assert.equal((await post(`/api/concepts/${concept("C1").id}/delete`, {})).status, 204);

  const refused = await post("/api/translate", { clipId: clip.id, language: "en" });
  assert.deepEqual([refused.status, await refused.json()], [409, { error: `Concept #${concept("C1").id} is Deleted` }]);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.kind, "translate")).all().length, 0);
});
