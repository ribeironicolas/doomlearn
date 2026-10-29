import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { eq } from "drizzle-orm";
import type { Agent, AgentStages } from "./agent.ts";
import { InvalidLexicon, openData } from "./data.ts";
import { createFeed } from "./feed.ts";
import { LANGUAGE_TAGS, type Language } from "./languages.ts";
import { createPipeline } from "./pipeline.ts";
import { createPronunciation } from "./pronunciation.ts";
import { clips, events, jobs, previews } from "./schema.ts";
import { createSources } from "./sources.ts";
import { publishLiveness, publishPreflight, publishStage } from "./status.ts";
import { fakeAgent, fakeMedia } from "./test/fakes.ts";

/**
 * The fake agent's script with a Respelling of its own in beat 2, whose first sentence ends there.
 */
const scripted = (await fakeAgent().run("script", {} as never, { jobId: 0 })) as {
  output: AgentStages["script"]["output"];
};
const BEATS = scripted.output.beats.map((beat, i) =>
  i === 1
    ? {
        ...beat,
        speech:
          "Uma thread é como um cozinheiro numa cozinha. Ele segue uma {receita|rêssêita}, passo a passo, do começo ao fim.",
      }
    : beat,
);

/**
 * A data folder whose Language of new Clips is `language`, with two Clips of that script (Concepts A1 and A2), the
 * first flagged 🚩 Pronunciation with a note. The worker is up and idle.
 */
async function setup(language: Language = "pt-BR") {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: { language } }));
  const data = openData(home);
  await writeFile(join(dir, "ostep.md"), "ostep");
  await createSources(data, fakeMedia({ chapters: [{ title: "Threads", text: "A1\nA2" }] })).add(join(dir, "ostep.md"));
  const fake = fakeAgent({
    extract: (chapter) =>
      chapter
        .split("\n")
        .map((line) => ({ title: line, summary: line, angles: ["analogy"], anchor: { chapter: line } })),
  });
  const agent: Agent = {
    run: (stage, input, served) =>
      stage === "script"
        ? Promise.resolve({ ok: true, output: { beats: BEATS } as AgentStages["script"]["output"] as never })
        : fake.run(stage, input, served),
  };
  const media = fakeMedia();
  const pipeline = createPipeline(data, agent, media);
  while (await pipeline.tick());
  const feed = createFeed(data);
  const [flagged, other] = data.db.select().from(clips).orderBy(clips.id).all();
  feed.press(flagged.id, "flag", randomUUID(), { reason: "Pronunciation", note: "Deve ser rêceita" });
  const eventId = data.db.select().from(events).where(eq(events.kind, "flag")).get()!.id;
  publishLiveness(data, { liveness: "running" });
  return { home, data, media, pipeline, flagged, other, eventId, fix: createPronunciation(data) };
}

/**
 * Serves the queued previews on `media` with nothing holding them, as the worker does between its steps.
 */
const serve = (fix: ReturnType<typeof createPronunciation>, media = fakeMedia()) =>
  fix.serve(media, { languages: LANGUAGE_TAGS, held: () => undefined, loading: () => false });

test("the fix sheet shows the script as the captions do, each word with its beat, its sentence and what the voice says", async () => {
  const { fix, eventId, data } = await setup();

  const sheet = fix.sheet(eventId);

  assert.equal(sheet.language, "pt-BR");
  assert.equal(sheet.note, "Deve ser rêceita");
  const beat2 = sheet.words.filter((word) => word.beat === 1);
  assert.deepEqual(
    beat2.map((word) => [word.text, word.sentence]),
    [
      ["Uma", 0],
      ["thread", 0],
      ["é", 0],
      ["como", 0],
      ["um", 0],
      ["cozinheiro", 0],
      ["numa", 0],
      ["cozinha.", 0],
      ["Ele", 1],
      ["segue", 1],
      ["uma", 1],
      ["receita,", 1],
      ["passo", 1],
      ["a", 1],
      ["passo,", 1],
      ["do", 1],
      ["começo", 1],
      ["ao", 1],
      ["fim.", 1],
    ],
  );
  // What the voice says now: a script's own Respelling is one word, and a multi-word Lexicon term one chunk.
  const says = (word: (typeof beat2)[number]) => sheet.says[word.chunk];
  assert.equal(says(beat2[11]), "rêssêita,");
  assert.equal(says(beat2[1]), "tréd");
  assert.equal(says(beat2[7]), "cozinha.");
  assert.deepEqual(
    beat2.filter((word) => word.markup).map((word) => word.text),
    ["receita,"],
  );
  const lexicon = JSON.parse(readFileSync(data.lexiconFile("pt-BR"), "utf8"));
  await writeFile(data.lexiconFile("pt-BR"), JSON.stringify({ ...lexicon, "passo a passo": "pásso a pásso" }));
  const [first, , last] = fix
    .sheet(eventId)
    .words.filter((word) => word.beat === 1)
    .slice(12, 15);
  assert.equal(first.chunk, last.chunk);
  assert.equal(fix.sheet(eventId).says[first.chunk], "pásso a pásso,");
});

test.each(["pt-BR", "en"] as const)(
  "a %s preview speaks the tapped sentence with every unsaved fix and the other Lexicon entries, in the Clip's Language",
  async (language) => {
    const { fix, eventId, data, flagged } = await setup(language);
    await writeFile(data.lexiconFile(language), JSON.stringify({ thread: "tréd", cozinheiro: "kuzinhêro" }));
    const media = fakeMedia();

    const id = fix.preview(eventId, { beat: 1, sentence: 1 }, [
      { term: "receita", respelling: "rêceita" },
      { term: "começo", respelling: "comêsso" },
    ]);
    assert.equal(fix.poll(id).status, "queued");
    await serve(fix, media);

    assert.deepEqual(media.spoken, [{ text: "Ele segue uma rêceita, passo a passo, do comêsso ao fim.", language }]);
    const row = data.db.select().from(previews).where(eq(previews.id, id)).get()!;
    assert.equal(row.clipId, flagged.id);
    assert.equal(fix.poll(id).status, "done");
    assert.ok(existsSync(row.wavPath!));

    // The other sentence of the beat, with the Lexicon's own entries.
    fix.preview(eventId, { beat: 1, sentence: 0 }, []);
    await serve(fix, media);
    assert.equal(media.spoken[1].text, "Uma tréd é como um kuzinhêro numa cozinha.");
  },
);

test("a two-word fix picked across a comma changes the preview, before and after Save", async () => {
  const { fix, eventId } = await setup();
  const media = fakeMedia();
  // The sheet's term for the words "passo," and "do": each without its punctuation.
  const fixes = [{ term: "passo do", respelling: "pásso dô" }];

  fix.preview(eventId, { beat: 1, sentence: 1 }, fixes);
  await serve(fix, media);
  fix.save(eventId, fixes);
  fix.preview(eventId, { beat: 1, sentence: 1 }, []);
  await serve(fix, media);

  assert.deepEqual(
    media.spoken.map((call) => call.text),
    Array(2).fill("Ele segue uma rêssêita, passo a pásso dô começo ao fim."),
  );
});

test("a new preview supersedes the queued previews of the same Clip, and only it is spoken", async () => {
  const { fix, eventId } = await setup();
  const media = fakeMedia();

  const first = fix.preview(eventId, { beat: 1, sentence: 1 }, [{ term: "receita", respelling: "rêceita" }]);
  const second = fix.preview(eventId, { beat: 1, sentence: 1 }, [{ term: "receita", respelling: "rrêceita" }]);
  await serve(fix, media);

  assert.equal(fix.poll(first).status, "superseded");
  assert.equal(fix.poll(second).status, "done");
  assert.deepEqual(
    media.spoken.map((call) => call.text),
    ["Ele segue uma rrêceita, passo a passo, do começo ao fim."],
  );
});

test("the wav is removed and the row played after its first fetch; a second fetch gets nothing", async () => {
  const { fix, eventId, data } = await setup();
  const id = fix.preview(eventId, { beat: 0, sentence: 0 }, []);
  await serve(fix);
  const { wavPath } = data.db.select().from(previews).where(eq(previews.id, id)).get()!;
  const wav = await readFile(wavPath!);

  assert.deepEqual(fix.takeWav(id), wav);

  assert.equal(existsSync(wavPath!), false);
  assert.equal(fix.poll(id).status, "played");
  assert.equal(fix.takeWav(id), undefined);
});

test("previews older than 1 h are swept: their wavs removed and their rows played; newer ones stay", async () => {
  const { fix, eventId, data } = await setup();
  const old = fix.preview(eventId, { beat: 0, sentence: 0 }, []);
  await serve(fix);
  const fresh = fix.preview(eventId, { beat: 1, sentence: 0 }, []);
  await serve(fix);
  data.db
    .update(previews)
    .set({ createdAt: new Date(Date.now() - 61 * 60_000) })
    .where(eq(previews.id, old))
    .run();
  const path = (id: number) => data.db.select().from(previews).where(eq(previews.id, id)).get()!.wavPath!;

  fix.sweep({ startup: true });

  assert.equal(existsSync(path(old)), false);
  assert.equal(fix.poll(old).status, "played");
  assert.ok(existsSync(path(fresh)));
  assert.equal(fix.poll(fresh).status, "done");
});

test("a preview left speaking by a crashed worker is spoken again after a restart, or failed when over 1 h old", async () => {
  const { fix, eventId, data } = await setup();
  const id = fix.preview(eventId, { beat: 0, sentence: 0 }, []);
  const stale = fix.preview(eventId, { beat: 1, sentence: 0 }, []);
  data.db.update(previews).set({ status: "speaking" }).run();
  data.db
    .update(previews)
    .set({ createdAt: new Date(Date.now() - 61 * 60_000) })
    .where(eq(previews.id, stale))
    .run();

  fix.sweep({ startup: true });
  await serve(fix);

  assert.equal(fix.poll(id).status, "done");
  assert.deepEqual(
    { status: fix.poll(stale).status, error: fix.poll(stale).error },
    { status: "failed", error: "The worker restarted" },
  );
});

test("a queued preview in a Language the media preflight has not checked waits for the next round", async () => {
  const { fix, eventId } = await setup("es");
  const media = fakeMedia();
  const id = fix.preview(eventId, { beat: 0, sentence: 0 }, []);
  assert.deepEqual(fix.languages(), ["es"]);

  await fix.serve(media, { languages: ["pt-BR"], held: () => undefined, loading: () => false });

  assert.equal(fix.poll(id).status, "queued");
  assert.deepEqual(media.spoken, []);
});

test("a preview the media preflight holds fails with the Blocker's reason, and the TTS is not called", async () => {
  const { fix, eventId } = await setup("en");
  const media = fakeMedia();
  const id = fix.preview(eventId, { beat: 0, sentence: 0 }, []);

  await fix.serve(media, {
    languages: LANGUAGE_TAGS,
    held: (language) => (language === "en" ? "tts weights for English missing: run `pnpm bootstrap`" : undefined),
    loading: () => false,
  });

  assert.deepEqual(
    { status: fix.poll(id).status, error: fix.poll(id).error },
    { status: "failed", error: "tts weights for English missing: run `pnpm bootstrap`" },
  );
  assert.deepEqual(media.spoken, []);
});

test("the poll says the worker is finishing a step, loading a voice or speaking, and gives the Blocker that holds it", async () => {
  const { fix, eventId, data } = await setup("es");
  const id = fix.preview(eventId, { beat: 0, sentence: 0 }, []);
  assert.deepEqual(fix.poll(id), { status: "queued", error: null, blocker: null, step: "next" });

  publishStage(data, { jobId: 1, stage: "narration", startedAt: new Date() });
  assert.equal(fix.poll(id).step, "waiting");
  publishStage(data, null);
  // Another Clip's preview is speaking: it has a stage and no job.
  publishStage(data, { jobId: null, stage: "preview", startedAt: new Date() });
  assert.equal(fix.poll(id).step, "waiting");
  publishStage(data, null);

  // The Spanish voice is missing; the English one does not hold a Spanish preview.
  publishPreflight(data, [
    "codex not logged in: run `codex login`",
    { reason: "tts weights for English missing: run `pnpm bootstrap`", languages: ["en"] },
  ]);
  assert.equal(fix.poll(id).blocker, null);
  publishPreflight(data, [{ reason: "tts weights for Spanish missing: run `pnpm bootstrap`", languages: ["es"] }]);
  assert.equal(fix.poll(id).blocker, "tts weights for Spanish missing: run `pnpm bootstrap`");
  publishPreflight(data, []);

  publishLiveness(data, { liveness: "stopped", exitReason: "worker exited with code 1" });
  assert.equal(fix.poll(id).blocker, "worker exited with code 1");
  publishLiveness(data, { liveness: "running" });

  // While it speaks: first loading the voice, when the Language needs another one than the TTS holds.
  const steps: (string | null)[] = [];
  /**
   * Media whose TTS records preview `preview`'s step while it speaks it.
   */
  const recording = (preview: number) => ({
    ...fakeMedia(),
    speak: async () => {
      steps.push(fix.poll(preview).step);
      return { durationMs: 1 };
    },
  });
  await fix.serve(recording(id), {
    languages: LANGUAGE_TAGS,
    held: () => undefined,
    loading: (language) => language === "es",
  });
  const again = fix.preview(eventId, { beat: 0, sentence: 0 }, []);
  await fix.serve(recording(again), { languages: LANGUAGE_TAGS, held: () => undefined, loading: () => false });
  assert.deepEqual(steps, ["loading", "speaking"]);
});

test("Save writes the fixes to the Clip's Language Lexicon, replacing another capitalization, and queues one regenerate", async () => {
  const { fix, eventId, data, flagged } = await setup("en");
  await writeFile(data.lexiconFile("en"), JSON.stringify({ Receita: "rêssêita", thread: "tréd" }));
  const ptBR = await readFile(data.lexiconFile("pt-BR"), "utf8");

  fix.save(eventId, [
    { term: "receita", respelling: "rêceita" },
    { term: "passo a passo", respelling: "pásso a pásso" },
  ]);
  fix.save(eventId, [{ term: "fim", respelling: "fíin" }]);

  assert.deepEqual(JSON.parse(await readFile(data.lexiconFile("en"), "utf8")), {
    thread: "tréd",
    receita: "rêceita",
    "passo a passo": "pásso a pásso",
    fim: "fíin",
  });
  assert.equal(await readFile(data.lexiconFile("pt-BR"), "utf8"), ptBR);
  assert.deepEqual(
    data.db
      .select({ kind: jobs.kind, status: jobs.status, conceptId: jobs.conceptId, language: jobs.language })
      .from(jobs)
      .where(eq(jobs.kind, "regenerate"))
      .all(),
    [{ kind: "regenerate", status: "queued", conceptId: flagged.conceptId, language: "en" }],
  );
});

test("Save refuses to overwrite a Lexicon file that is not JSON, and queues nothing", async () => {
  const { fix, eventId, data } = await setup();
  await writeFile(data.lexiconFile("pt-BR"), '{"thread": "tréd",}');

  assert.throws(() => fix.save(eventId, [{ term: "receita", respelling: "rêceita" }]), InvalidLexicon);

  assert.equal(await readFile(data.lexiconFile("pt-BR"), "utf8"), '{"thread": "tréd",}');
  assert.deepEqual(data.db.select().from(jobs).where(eq(jobs.kind, "regenerate")).all(), []);
});

test("after Save the remade Clip says the fix over the script's Respelling and resolves the 🚩; other Clips are unchanged", async () => {
  const { fix, eventId, data, flagged, other } = await setup();
  const media = fakeMedia();
  const pipeline = createPipeline(data, fakeAgent(), media);

  fix.save(eventId, [{ term: "Receita", respelling: "rêceita" }]);
  while (await pipeline.tick());

  assert.equal(media.spoken.length, 1);
  assert.match(media.spoken[0].text, /segue uma rêceita, passo/);
  const remade = data.db.select().from(clips).where(eq(clips.id, flagged.id)).get()!;
  assert.notEqual(remade.file, flagged.file);
  assert.ok(data.db.select().from(events).where(eq(events.id, eventId)).get()!.resolvedAt);
  assert.deepEqual(data.db.select().from(clips).where(eq(clips.id, other.id)).get(), other);
});

test("a fix saved while the worker runs reaches the next new Clip's narration, with no restart", async () => {
  const { fix, eventId, data, pipeline, media } = await setup();
  media.spoken.length = 0;

  fix.save(eventId, [{ term: "cozinheiro", respelling: "kuzinhêro" }]);
  // A third Concept, so a new Clip is made next.
  const book = join(data.home, "..", "locks.md");
  await writeFile(book, "locks");
  await createSources(data, fakeMedia({ chapters: [{ title: "Locks", text: "A3" }] })).add(book);
  while (await pipeline.tick());

  // The regenerate and the new Clip both say it.
  assert.equal(media.spoken.length, 2);
  for (const call of media.spoken) assert.match(call.text, /um kuzinhêro numa/);
});
