import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Agent, AgentStages } from "./agent.ts";
import { openData } from "./data.ts";
import type { Language } from "./languages.ts";
import { createFeed } from "./feed.ts";
import { createInbox } from "./inbox.ts";
import { type Media, SceneError } from "./media.ts";
import { createPipeline } from "./pipeline.ts";
import { agentCalls, clips, events, JOB_PRIORITY, jobs, sources } from "./schema.ts";
import { createSources } from "./sources.ts";
import { createTranslations } from "./translations.ts";
import { publishLiveness, workerStatus } from "./status.ts";
import { editConfig, fakeAgent, fakeMedia } from "./test/fakes.ts";
import { recordUsage, type UsageReading } from "./usage.ts";

/**
 * A temp DOOMLEARN_HOME next to a small `.md` Source file.
 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const file = join(dir, "threads.md");
  await writeFile(file, "# Threads\n\nA thread is one sequence of execution inside a process.\n");
  return { home: join(dir, "home"), file };
}

/**
 * A data folder whose Language of new Clips is `language`, holding the `setup()` Source and `files` (name → text),
 * which are written before the folder is opened.
 */
async function openIn(language: Language, files: Record<string, string> = {}) {
  const { home, file } = await setup();
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: { language } }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(home, name), text);
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  return { home, data };
}

test("an added .md Source becomes a Clip in the Feed, grounded in a Passage from it", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  const source = await createSources(data, fakeMedia()).add(file);

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  const [slot] = createFeed(data).next();
  assert.ok(slot);
  assert.ok(existsSync(slot.file));
  assert.equal(slot.concept.title, "What is a thread");
  assert.deepEqual(
    slot.passages.map((passage) => passage.source.id),
    [source.id],
  );
  assert.match(slot.passages[0].text, /A thread is one sequence of execution/);
});

test("a job interrupted after a stage resumes at the next stage", async () => {
  const { home, file } = await setup();
  const before = openData(home);
  await createSources(before, fakeMedia()).add(file);
  const firstAgent = fakeAgent();
  const firstRun = createPipeline(before, firstAgent, fakeMedia());
  while (!firstAgent.calls.includes("script")) await firstRun.tick();
  // The process dies here.
  before.db.$client.close();

  const after = openData(home);
  const agent = fakeAgent();
  const pipeline = createPipeline(after, agent, fakeMedia());
  while (await pipeline.tick());

  assert.deepEqual(agent.calls, ["verify", "scene"]);
  assert.ok(createFeed(after).next().length);
});

/**
 * Wraps the fake Agent to record what each scene call was asked to fix.
 */
function sceneSpy() {
  const fake = fakeAgent();
  const fixes: AgentStages["scene"]["input"]["fix"][] = [];
  const agent: Agent = {
    run: (stage, input, served) => {
      if (stage === "scene") fixes.push((input as AgentStages["scene"]["input"]).fix);
      return fake.run(stage, input, served);
    },
  };
  return { agent, fixes, calls: fake.calls };
}

test("a scene that fails to render is re-sent with the error, and a fixed one becomes the Clip", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const media = fakeMedia();
  let failures = 1;
  const render: Media["render"] = async (scene, out) => {
    if (failures-- > 0) throw new SceneError("Scene.tsx: Unexpected token");
    await media.render(scene, out);
  };
  const { agent, fixes } = sceneSpy();
  const pipeline = createPipeline(data, agent, { ...media, render });
  while (await pipeline.tick());

  assert.deepEqual(fixes, [
    undefined,
    { tsx: "export default () => null;", error: "Error: Scene.tsx: Unexpected token" },
  ]);
  assert.ok(createFeed(data).next().length);
});

test("a scene still failing after 2 re-sends fails the job and requeues its Concept at the scene stage", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const render: Media["render"] = async () => {
    throw new SceneError("Scene.tsx: Unexpected token");
  };
  const { agent, fixes, calls } = sceneSpy();
  const pipeline = createPipeline(data, agent, { ...fakeMedia(), render });
  while (fixes.length < 3) await pipeline.tick();

  assert.equal(fixes.filter(Boolean).length, 2);
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.status, "queued");
  assert.match(job.lastError!, /Unexpected token/);
  assert.deepEqual(createFeed(data).next(), []);

  // Later, it starts over from a fresh scene, keeping its script and narration.
  await pipeline.tick();
  assert.equal(fixes.at(-1), undefined);
  assert.equal(calls.filter((stage) => stage === "script").length, 1);
});

test("a scene failing again after 5 requeues parks the job as stuck", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const render: Media["render"] = async () => {
    throw new SceneError("Scene.tsx: Unexpected token");
  };
  const { agent, fixes } = sceneSpy();
  const pipeline = createPipeline(data, agent, { ...fakeMedia(), render });
  while (await pipeline.tick());

  // The first run plus 5 requeues, each a scene call and 2 re-sends.
  assert.equal(fixes.length, 6 * 3);
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.status, "stuck");
  assert.match(job.lastError!, /Unexpected token/);
});

test("a render failing outside the scene parks the job at once, with no scene call after it", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const render: Media["render"] = async () => {
    throw new Error("ENOENT: no such file or directory, copyfile 'narration.wav'");
  };
  const { agent, fixes } = sceneSpy();
  const pipeline = createPipeline(data, agent, { ...fakeMedia(), render });
  while (await pipeline.tick());

  // The only scene call is the one that wrote the scene.
  assert.deepEqual(fixes, [undefined]);
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.status, "stuck");
  assert.equal(job.attempts, 1);
  assert.match(job.lastError!, /ENOENT: no such file or directory, copyfile 'narration.wav'/);
});

test("a job parked by a render failing outside the scene renders the same scene again when retried", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  const sources = createSources(data, fakeMedia());
  await sources.add(file);
  const media = fakeMedia();
  const rendered: string[] = [];
  let failures = 1;
  const render: Media["render"] = async (scene, out) => {
    rendered.push(scene.tsx);
    if (failures-- > 0) throw new Error("remotion ffmpeg exited with code 1");
    await media.render(scene, out);
  };
  const { agent, fixes } = sceneSpy();
  const pipeline = createPipeline(data, agent, { ...media, render });
  while (await pipeline.tick());
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.status, "stuck");

  // The scene checkpoint is kept, so the retry resumes at the render.
  sources.retry(job.id);
  while (await pipeline.tick());

  assert.deepEqual(fixes, [undefined]);
  assert.deepEqual(rendered, ["export default () => null;", "export default () => null;"]);
  assert.ok(createFeed(data).next().length);
});

test("a job parked at the verify gate gets its 2 rewrites again when retried, so its rejected script is rewritten", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  const sources = createSources(data, fakeMedia());
  await sources.add(file);
  const fake = fakeAgent();
  // Verify rejects 3 scripts before the job parks, and 1 more after the retry.
  const rejections = ["claims A", "claims B", "claims C", "claims D"];
  const agent: Agent = {
    run: async (stage, input, served) => {
      const result = await fake.run(stage, input, served);
      const problem = stage === "verify" && rejections.shift();
      return problem ? ({ ok: true, output: { ok: false, problems: [problem] } } as never) : result;
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.status, "stuck");
  assert.match(job.lastError!, /Script still failing after 2 rewrites: claims C/);

  fake.calls.length = 0;
  fake.inputs.length = 0;
  sources.retry(job.id);
  while (await pipeline.tick());

  assert.deepEqual(fake.calls, ["verify", "script", "verify", "scene"]);
  const [rewritten] = fake.inputs.filter(({ stage }) => stage === "script");
  assert.equal((rewritten.input as AgentStages["script"]["input"]).feedback, "claims D");
  assert.ok(createFeed(data).next().length);
});

test("a job parked after the script gates resumes at its stage when retried, with no script or verify call", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  const sources = createSources(data, fakeMedia());
  await sources.add(file);
  const fake = fakeAgent();
  // One rewrite before the crash, so the job folder holds rewrite feedback.
  let rejections = 1;
  const agent: Agent = {
    run: async (stage, input, served) => {
      const result = await fake.run(stage, input, served);
      return stage === "verify" && rejections-- > 0
        ? ({ ok: true, output: { ok: false, problems: ["claims A"] } } as never)
        : result;
    },
  };
  const media = fakeMedia();
  let crashes = 1;
  const speak: Media["speak"] = async (text, out, language) => {
    if (crashes-- > 0) throw new Error("The tts runtime exited; its output is in the log above");
    return media.speak(text, out, language);
  };
  const pipeline = createPipeline(data, agent, { ...media, speak });
  while (await pipeline.tick());
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.status, "stuck");
  assert.match(job.lastError!, /The tts runtime exited/);

  fake.calls.length = 0;
  sources.retry(job.id);
  while (await pipeline.tick());

  assert.deepEqual(fake.calls, ["scene"]);
  assert.ok(createFeed(data).next().length);
});

test("narration over 60 s sends the job back to the script stage with the overrun to cut", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const agent = fakeAgent();
  const media = fakeMedia();
  const durations = [72_400, 41_000];
  const pipeline = createPipeline(data, agent, {
    ...media,
    speak: async (text, out, language) => ({
      ...(await media.speak(text, out, language)),
      durationMs: durations.shift()!,
    }),
  });
  while (await pipeline.tick());

  assert.deepEqual(agent.calls, ["extract", "script", "verify", "script", "verify", "scene"]);
  const scripts = agent.inputs
    .filter(({ stage }) => stage === "script")
    .map(({ input }) => input as AgentStages["script"]["input"]);
  assert.equal(scripts[0].feedback, undefined);
  assert.equal(scripts[1].feedback, "cut 12.4 s");
  assert.ok(createFeed(data).next().length);
});

test("a script still over 60 s after 2 rewrites splits its Concept, and parts still over 60 s are parked", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const agent = fakeAgent();
  const media = fakeMedia();
  const pipeline = createPipeline(data, agent, {
    ...media,
    speak: async (text, out, language) => ({ ...(await media.speak(text, out, language)), durationMs: 65_000 }),
  });
  while (await pipeline.tick());

  // 3 scripts, the split, then 3 scripts for each of its 2 parts.
  assert.equal(agent.calls.filter((stage) => stage === "split").length, 1);
  assert.equal(agent.calls.filter((stage) => stage === "script").length, 3 + 2 * 3);
  const parked = data.db.select().from(jobs).where(eq(jobs.kind, "new")).all();
  assert.deepEqual(
    parked.map((job) => job.status),
    ["stuck", "stuck"],
  );
  for (const job of parked) assert.match(job.lastError ?? "", /cut 5 s/);
});

test("a rate-limited call pauses the whole queue until its retry time without counting the attempt", async (t) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const fake = fakeAgent();
  let limited = 1;
  const agent: Agent = {
    run: async (stage, input, served) => {
      if (stage !== "script" || limited-- <= 0) return fake.run(stage, input, served);
      // Like the real port, the rate-limited call is logged with its retry time.
      const retryAt = new Date(Date.now() + 60_000);
      data.db
        .insert(agentCalls)
        .values({
          stage,
          jobId: served.jobId,
          durationMs: 1,
          isError: true,
          apiErrorStatus: 429,
          retryAt,
          at: new Date(),
        })
        .run();
      return { ok: false, error: "API Error: Request rejected (429)", retryAt };
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (limited > 0) await pipeline.tick();

  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new")).get()!;
  assert.equal(job.attempts, 0);
  assert.equal(job.status, "queued");
  vi.advanceTimersByTime(59_000);
  assert.equal(await pipeline.tick(), false);
  // The pause outlives a restart.
  assert.equal(await createPipeline(data, agent, fakeMedia()).tick(), false);
  assert.deepEqual(fake.calls, ["extract"]);

  vi.advanceTimersByTime(1_000);
  while (await pipeline.tick());
  assert.deepEqual(fake.calls, ["extract", "script", "verify", "scene"]);
  assert.ok(createFeed(data).next().length);
});

/**
 * Fake Media that counts the TTS, alignment and render calls.
 */
function countingMedia() {
  const media = fakeMedia();
  const used = { speak: 0, align: 0, render: 0 };
  return {
    used,
    media: {
      ...media,
      speak(...args) {
        used.speak++;
        return media.speak(...args);
      },
      align(...args) {
        used.align++;
        return media.align(...args);
      },
      render(...args) {
        used.render++;
        return media.render(...args);
      },
    } satisfies Media,
  };
}

test("a Worker pause lets the running stage finish, then no stage starts; the worker never writes the file", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const fake = fakeAgent();
  let finishCall = () => {};
  const agent: Agent = {
    run: async (stage, input, served) => {
      await new Promise<void>((resolve) => {
        finishCall = resolve;
      });
      return fake.run(stage, input, served);
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());

  const running = pipeline.tick();
  await vi.waitFor(() => assert.equal(data.db.select().from(jobs).get()?.status, "running"));
  const paused = await editConfig(home, { worker: { paused: true } });
  finishCall();
  assert.equal(await running, true);
  assert.deepEqual(fake.calls, ["extract"]);

  assert.equal(await pipeline.tick(), false);
  assert.deepEqual(fake.calls, ["extract"]);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), paused);
});

test("outside every Run window the worker starts no TTS, alignment or render, and resumes inside one", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const agent = fakeAgent();
  const { media, used } = countingMedia();
  const pipeline = createPipeline(data, agent, media);
  // Up to the narration stage, which is TTS and alignment.
  while (!agent.calls.includes("verify")) await pipeline.tick();

  const hhmm = (hoursFromNow: number) => {
    const at = new Date(Date.now() + hoursFromNow * 3_600_000);
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  };
  await editConfig(home, { worker: { schedule: { windows: [{ start: hhmm(2), end: hhmm(3) }] } } });
  assert.equal(await pipeline.tick(), false);
  assert.deepEqual(used, { speak: 0, align: 0, render: 0 });

  await editConfig(home, { worker: { schedule: { windows: [{ start: hhmm(-1), end: hhmm(1) }] } } });
  while (await pipeline.tick());
  assert.ok(used.speak && used.align && used.render);
  assert.ok(createFeed(data).next().length);
});

test("a past pausedUntil is ignored, and the file is left as it is", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const config = await editConfig(home, { worker: { pausedUntil: new Date(Date.now() - 60_000).toISOString() } });

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  assert.ok(createFeed(data).next().length);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
});

/**
 * A Claude reading of `window` at `utilization`, resetting `resetsInMs` from now.
 */
const claudeReading = (window: string, utilization: number | null, resetsInMs: number): UsageReading => ({
  window,
  utilization,
  resetsAt: new Date(Date.now() + resetsInMs),
  status: "allowed",
  source: utilization === null ? "status_only" : "unified",
});

test("at a usage threshold the worker starts no stage until that Usage window resets", async (t) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  await editConfig(home, { worker: { stopAtUsagePercent: { fiveHour: 90, sevenDay: 80 } } });
  recordUsage(data, "claude", [claudeReading("five_hour", 0.5, 3_600_000), claudeReading("seven_day", 0.8, 7_200_000)]);
  const agent = fakeAgent();
  const pipeline = createPipeline(data, agent, fakeMedia());

  assert.equal(await pipeline.tick(), false);
  vi.advanceTimersByTime(7_199_000);
  assert.equal(await pipeline.tick(), false);
  assert.deepEqual(agent.calls, []);

  vi.advanceTimersByTime(1_000);
  while (await pipeline.tick());
  assert.ok(createFeed(data).next().length);
});

test("unknown or stale usage never pauses the worker, and only Claude windows are read", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  await editConfig(home, { worker: { stopAtUsagePercent: { fiveHour: 50, sevenDay: 50 } } });
  // No reading yet.
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  assert.equal(await pipeline.tick(), true);
  // A full window that has already reset, a newer status-only reading over a full one, and a full Codex window.
  recordUsage(data, "claude", [claudeReading("seven_day", 1, -1)]);
  recordUsage(data, "claude", [claudeReading("five_hour", 0.99, 3_600_000)]);
  recordUsage(data, "claude", [claudeReading("five_hour", null, 3_600_000)]);
  recordUsage(data, "codex", [{ ...claudeReading("five_hour", 1, 3_600_000), source: "probe" }]);

  while (await pipeline.tick());
  assert.ok(createFeed(data).next().length);
});

test("with stopAtUsagePercent off, a full Usage window pauses nothing, as in v1", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  recordUsage(data, "claude", [claudeReading("five_hour", 1, 3_600_000), claudeReading("seven_day", 1, 3_600_000)]);

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());
  assert.ok(createFeed(data).next().length);
});

test("the worker publishes the stage it is running, since when, and clears it once the stage is over", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  publishLiveness(data, { liveness: "running" });
  const fake = fakeAgent();
  let finishCall = () => {};
  const agent: Agent = {
    run: async (stage, input, served) => {
      await new Promise<void>((resolve) => {
        finishCall = resolve;
      });
      return fake.run(stage, input, served);
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());

  const before = new Date();
  const running = pipeline.tick();
  await vi.waitFor(() => assert.equal(workerStatus(data).state, "running"));
  const { job } = workerStatus(data);
  assert.deepEqual(
    { ...job, since: undefined },
    {
      id: 1,
      kind: "extract_chapter",
      source: "threads",
      stage: "extract",
      since: undefined,
    },
  );
  assert.ok(job?.since && job.since >= before);

  finishCall();
  await running;
  assert.deepEqual({ state: workerStatus(data).state, job: workerStatus(data).job }, { state: "idle", job: null });
});

/**
 * A Source made into its one Clip, then 🚩 flagged and queued for Regenerate from the Inbox.
 */
async function flaggedForRegenerate() {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const firstRun = createPipeline(data, fakeAgent(), fakeMedia());
  while (await firstRun.tick());
  const feed = createFeed(data);
  const [slot] = feed.next();
  feed.press(slot.clipId, "flag", "flag-1", { reason: "Pronunciation" });
  const inbox = createInbox(data);
  inbox.regenerate(inbox.list().flags[0].eventId);
  return { home, data, feed, inbox, slot };
}

test("a regenerate keeps the Clip's id, script and events, redoes narration, scene and render, and resolves its 🚩", async () => {
  const { home, data, feed, inbox, slot } = await flaggedForRegenerate();
  // The Learner tunes a respelling by hand after the worker started.
  const lexicon = JSON.parse(await readFile(join(home, "lexicon.json"), "utf8"));
  await writeFile(join(home, "lexicon.json"), JSON.stringify({ ...lexicon, thread: "fiozinho" }));
  const before = data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get()!;
  // The item leaves the Inbox once queued.
  assert.deepEqual(inbox.list().flags, []);

  const agent = fakeAgent();
  const media = fakeMedia();
  const spoken: string[] = [];
  const pipeline = createPipeline(data, agent, {
    ...media,
    speak: (text, out, language) => {
      spoken.push(text);
      return media.speak(text, out, language);
    },
    render: (_scene, out) => writeFile(out, "regenerated mp4"),
  });
  while (await pipeline.tick());

  assert.deepEqual(agent.calls, ["scene"]);
  assert.ok(spoken.some((text) => text.includes("fiozinho")));
  const after = data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get()!;
  assert.deepEqual([after.script, after.caption, after.hidden], [before.script, before.caption, false]);
  assert.equal(await readFile(after.file, "utf8"), "regenerated mp4");
  assert.equal(existsSync(before.file), false);
  // The Clip is back in the Feed, its 🚩 resolved and still attached to it.
  assert.deepEqual(
    feed.next().map((next) => next.clipId),
    [slot.clipId],
  );
  const [flag] = data.db.select().from(events).where(eq(events.clipId, slot.clipId)).all();
  assert.equal(flag.kind, "flag");
  assert.ok(flag.resolvedAt);
  assert.deepEqual(inbox.list(), { flags: [], notLanding: [], stuck: [] });
});

test("Regenerate on a flagged pt-BR Clip remakes only that Clip when an en Clip of its Concept and Angle exists", async () => {
  const { home, data, slot } = await flaggedForRegenerate();
  const flagged = data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get()!;
  await writeFile(join(home, "clips", "en.mp4"), "en mp4");
  const en = data.db
    .insert(clips)
    .values({ ...flagged, id: undefined, language: "en", file: join(home, "clips", "en.mp4") })
    .returning()
    .get();

  const pipeline = createPipeline(data, fakeAgent(), {
    ...fakeMedia(),
    render: (_scene, out) => writeFile(out, "regenerated mp4"),
  });
  while (await pipeline.tick());

  assert.deepEqual(
    data.db.select({ kind: jobs.kind, language: jobs.language }).from(jobs).where(eq(jobs.kind, "regenerate")).all(),
    [{ kind: "regenerate", language: "pt-BR" }],
  );
  const after = data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get()!;
  assert.equal(await readFile(after.file, "utf8"), "regenerated mp4");
  assert.deepEqual(data.db.select().from(clips).where(eq(clips.id, en.id)).get(), en);
  assert.equal(await readFile(en.file, "utf8"), "en mp4");
});

test("a queued translate job runs, and so does the rest of the queue", async () => {
  const { data, slot } = await flaggedForRegenerate();
  createTranslations(data).queue(slot.clipId, "en");

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  assert.deepEqual(
    data.db
      .select({ kind: jobs.kind, status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.kind, ["regenerate", "translate"]))
      .all(),
    [
      { kind: "regenerate", status: "done" },
      { kind: "translate", status: "done" },
    ],
  );
});

test("a regenerate runs at the daily Clip cap, as it adds no Clip", async () => {
  const { home, data, slot } = await flaggedForRegenerate();
  await editConfig(home, { worker: { dailyClipCap: 1 } });

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  assert.equal(data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get()!.hidden, false);
});

test("a failed regenerate leaves the old Clip and its 🚩 as they were, and is stuck in the Inbox", async () => {
  const { data, inbox, slot } = await flaggedForRegenerate();
  const before = data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get()!;
  const render: Media["render"] = async () => {
    throw new Error("remotion ffmpeg exited with code 1");
  };

  const pipeline = createPipeline(data, fakeAgent(), { ...fakeMedia(), render });
  while (await pipeline.tick());

  assert.deepEqual(data.db.select().from(clips).where(eq(clips.id, slot.clipId)).get(), before);
  assert.equal(await readFile(before.file, "utf8"), "fake mp4");
  const { flags, stuck } = inbox.list();
  assert.deepEqual(
    flags.map((flag) => [flag.clipId, flag.reason]),
    [[slot.clipId, "Pronunciation"]],
  );
  assert.deepEqual(
    stuck.map((job) => [job.kind, job.stage]),
    [["regenerate", "scene.json"]],
  );
  assert.match(stuck[0].lastError!, /remotion ffmpeg exited with code 1/);
});

test("a regenerate whose narration runs over 60 s with the current lexicon is stuck, its script never rewritten", async () => {
  const { data, inbox } = await flaggedForRegenerate();
  const agent = fakeAgent();
  const media = fakeMedia();
  const pipeline = createPipeline(data, agent, {
    ...media,
    speak: async (text, out, language) => ({ ...(await media.speak(text, out, language)), durationMs: 61_250 }),
  });
  while (await pipeline.tick());

  assert.deepEqual(agent.calls, []);
  const [job] = inbox.list().stuck;
  assert.equal(job.kind, "regenerate");
  assert.match(job.lastError!, /Over 60 s with the current lexicon: cut 1.3 s/);
});

test("a regenerate whose Lexicon a hand edit broke is stuck naming the file, so the Learner sees their edit failed", async () => {
  const { home, data, inbox } = await flaggedForRegenerate();
  await writeFile(join(home, "lexicon.json"), '{ "thread": ');

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  const [job] = inbox.list().stuck;
  assert.equal(job.kind, "regenerate");
  assert.match(job.lastError!, /lexicon\.json is not valid JSON/);
});

//
// Language of new Clips
//

test("a new job takes the Language of new Clips when it starts, and keeps it after a crash and another switch", async () => {
  const { home, file } = await setup();
  const before = openData(home);
  await createSources(before, fakeMedia()).add(file);
  const firstAgent = fakeAgent();
  const firstRun = createPipeline(before, firstAgent, fakeMedia());
  while (!before.db.select().from(jobs).where(eq(jobs.status, "done")).get()) await firstRun.tick();
  const [extraction] = before.db.select().from(jobs).all();
  const queued = before.db
    .insert(jobs)
    .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: 1, angle: "analogy" })
    .returning()
    .get();
  assert.equal(queued.language, null);

  await editConfig(home, { worker: { language: "en" } });
  while (!firstAgent.calls.includes("script")) await firstRun.tick();
  assert.equal(before.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()!.language, "en");
  // The process dies after the script stage, and the Learner switches again before it restarts.
  before.db.$client.close();
  await editConfig(home, { worker: { language: "es" } });

  const after = openData(home);
  while (await createPipeline(after, fakeAgent(), fakeMedia()).tick());

  assert.equal(after.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()!.language, "en");
  assert.equal(after.db.select().from(jobs).where(eq(jobs.id, extraction.id)).get()!.language, null);
  const [clip] = after.db.select().from(clips).all();
  assert.equal(clip.language, "en");
  assert.equal(clip.file, join(home, "clips", `1-analogy-${queued.id}.mp4`));
  assert.ok(existsSync(clip.file));
});

test("a Clip made before the job-named files keeps its path when a new Clip of its Concept is made", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());
  const [made] = data.db.select().from(clips).all();
  // As the previous version named it.
  const old = join(home, "clips", `${made.conceptId}-${made.angle}.mp4`);
  data.db.update(clips).set({ file: old }).where(eq(clips.id, made.id)).run();
  await writeFile(old, "old mp4");

  createFeed(data).press(made.id, "didnt_get", "didnt-1");
  while (await pipeline.tick());

  const [kept, angled] = data.db.select().from(clips).orderBy(clips.id).all();
  assert.equal(kept.file, old);
  assert.equal(await readFile(old, "utf8"), "old mp4");
  const job = data.db.select().from(jobs).where(eq(jobs.kind, "new_angle")).get()!;
  assert.equal(angled.file, join(home, "clips", `${made.conceptId}-mechanism-${job.id}.mp4`));
});

test("a regenerate carries its Clip's Language, made when the setting was en, after a switch back to pt-BR", async () => {
  const { home, data } = await openIn("en");
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());
  const feed = createFeed(data);
  const [slot] = feed.next();
  assert.equal(slot.language, "en");
  feed.press(slot.clipId, "flag", "flag-1", { reason: "Pronunciation" });
  await editConfig(home, {});
  const inbox = createInbox(data);

  inbox.regenerate(inbox.list().flags[0].eventId);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.kind, "regenerate")).get()!.language, "en");
  while (await pipeline.tick());

  assert.deepEqual(data.db.select({ kind: jobs.kind, language: jobs.language }).from(jobs).orderBy(jobs.id).all(), [
    { kind: "extract_chapter", language: null },
    { kind: "new", language: "en" },
    { kind: "regenerate", language: "en" },
  ]);
  assert.deepEqual(data.db.select({ id: clips.id, language: clips.language, hidden: clips.hidden }).from(clips).all(), [
    { id: slot.clipId, language: "en", hidden: false },
  ]);
});

test("an en regenerate waits while the en voice is missing, and a pt-BR Clip is still made", async () => {
  const { home, data } = await openIn("en");
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());
  const feed = createFeed(data);
  const [slot] = feed.next();
  // A new Angle in pt-BR, and a regenerate of the en Clip.
  await editConfig(home, {});
  feed.press(slot.clipId, "didnt_get", "didnt-1");
  feed.press(slot.clipId, "flag", "flag-1", { reason: "Pronunciation" });
  const inbox = createInbox(data);
  inbox.regenerate(inbox.list().flags[0].eventId);

  while (await pipeline.tick(["en", "es"]));

  const status = () =>
    data.db.select({ kind: jobs.kind, language: jobs.language, status: jobs.status }).from(jobs).orderBy(jobs.id).all();
  assert.deepEqual(status().slice(2), [
    { kind: "new_angle", language: "pt-BR", status: "done" },
    { kind: "regenerate", language: "en", status: "queued" },
  ]);
  assert.deepEqual(data.db.select({ language: clips.language }).from(clips).orderBy(clips.id).all(), [
    { language: "en" },
    { language: "pt-BR" },
  ]);

  // `pnpm bootstrap` fetched the voice.
  while (await pipeline.tick());

  assert.equal(status().at(-1)!.status, "done");
});

test("while the voice of the Language of new Clips is missing, extraction runs and its new Clip job waits", async () => {
  const { data } = await openIn("es");
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());

  while (await pipeline.tick(["en", "es"]));

  assert.deepEqual(
    data.db.select({ kind: jobs.kind, language: jobs.language, status: jobs.status }).from(jobs).orderBy(jobs.id).all(),
    [
      { kind: "extract_chapter", language: null, status: "done" },
      { kind: "new", language: null, status: "queued" },
    ],
  );
  assert.deepEqual(pipeline.languages(), ["es"]);

  while (await pipeline.tick());

  assert.deepEqual(data.db.select({ language: clips.language }).from(clips).all(), [{ language: "es" }]);
});

/**
 * The fake Agent with its script stage answering `beats` instead, recording the Language each call was served in.
 */
function scriptedAgent(beats: (scriptCall: number) => AgentStages["script"]["output"]["beats"]) {
  const fake = fakeAgent();
  const served: { stage: keyof AgentStages; language?: string }[] = [];
  const agent: Agent = {
    run: async (stage, input, call) => {
      served.push({ stage, language: call.language });
      const result = await fake.run(stage, input, call);
      return stage === "script"
        ? { ok: true, output: { beats: beats(fake.calls.filter((s) => s === "script").length) } as never }
        : result;
    },
  };
  return { agent, served, calls: fake.calls, inputs: fake.inputs };
}

/**
 * A script of `count` spoken words in 5 beats.
 */
function wordyBeats(count: number) {
  const words = Array.from({ length: count }, (_, i) => `palavra${i}`);
  return Array.from({ length: 5 }, (_, beat) => ({
    speech: words.filter((_, i) => i % 5 === beat).join(" "),
    visual: `beat ${beat}`,
  }));
}

test.each([
  { language: "en", words: { min: 85, max: 200 }, feedback: undefined, made: 1 },
  { language: "pt-BR", words: { min: 85, max: 175 }, feedback: "190 spoken words, cut to at most 175", made: 0 },
] as const)(
  "a 190-word $language script gets the $language word budget, and is sent back with $feedback",
  async ({ language, words, feedback, made }) => {
    const { data } = await openIn(language);
    const { agent, calls, inputs } = scriptedAgent(() => wordyBeats(190));
    const media = fakeMedia();
    // Short enough for the 60 s gate, which is the same in every Language.
    const pipeline = createPipeline(data, agent, { ...media, speak: async () => ({ durationMs: 50_000 }) });
    while (calls.filter((stage) => stage === "script").length < 2 && (await pipeline.tick()));

    const scripts = inputs.filter((call) => call.stage === "script") as { input: AgentStages["script"]["input"] }[];
    assert.deepEqual(scripts[0].input.words, words);
    assert.equal(scripts[1]?.input.feedback, feedback);
    assert.equal(data.db.select().from(clips).all().length, made);
  },
);

test("an en job's agent calls are served in en, get the en Lexicon's terms, and its new terms go to lexicon.en.json only", async () => {
  const { home, data } = await openIn("en", {
    "lexicon.en.json": JSON.stringify({ Kubernetes: "koo ber net ease" }),
  });
  const ptBR = await readFile(join(home, "lexicon.json"), "utf8");
  const { agent, served, inputs } = scriptedAgent(() => [
    { speech: "Picture a {GC|gee see} sweeping a kitchen while two cooks share one pantry.", visual: "gc" },
    ...wordyBeats(100),
  ]);
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  assert.deepEqual(
    served.filter((call) => call.stage !== "extract").map((call) => [call.stage, call.language]),
    [
      ["script", "en"],
      ["verify", "en"],
      ["scene", "en"],
    ],
  );
  const [script] = inputs.filter((call) => call.stage === "script") as { input: AgentStages["script"]["input"] }[];
  assert.deepEqual(script.input.lexicon, ["Kubernetes"]);
  assert.deepEqual(JSON.parse(await readFile(join(home, "lexicon.en.json"), "utf8")), {
    Kubernetes: "koo ber net ease",
    GC: "gee see",
  });
  assert.equal(await readFile(join(home, "lexicon.json"), "utf8"), ptBR);
});

test.each(["en", "pt-BR"] as const)("a %s job's narration speaks and aligns in its Language", async (language) => {
  const { data } = await openIn(language);
  const media = fakeMedia();
  const pipeline = createPipeline(data, fakeAgent(), media);
  while (await pipeline.tick());

  assert.deepEqual(media.calls, [
    { tool: "speak", language },
    { tool: "align", language },
  ]);
});

test("a Lexicon entry written to the file between two jobs is spoken by the second job's narration, with no restart", async () => {
  const { home, file } = await setup();
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const media = fakeMedia();
  const spoken: string[] = [];
  const pipeline = createPipeline(data, fakeAgent(), {
    ...media,
    speak: (text, out, language) => {
      spoken.push(text);
      return media.speak(text, out, language);
    },
  });
  while (await pipeline.tick());
  const lexicon = JSON.parse(await readFile(join(home, "lexicon.json"), "utf8"));
  await writeFile(join(home, "lexicon.json"), JSON.stringify({ ...lexicon, despensa: "dispênça" }));

  const [made] = data.db.select().from(clips).all();
  createFeed(data).press(made.id, "didnt_get", "didnt-1");
  while (await pipeline.tick());

  assert.equal(spoken.length, 2);
  assert.doesNotMatch(spoken[0], /dispênça/);
  assert.match(spoken[1], /dispênça/);
});

//
// Make in another Language
//

/**
 * A data folder whose one pt-BR Clip is made, with the Feed and the module that queues its Translations.
 */
async function madeInPortuguese(files: Record<string, string> = {}) {
  const { home, data } = await openIn("pt-BR", files);
  while (await createPipeline(data, fakeAgent(), fakeMedia()).tick());
  const [source] = data.db.select().from(clips).all();
  return { home, data, source, translations: createTranslations(data) };
}

test("a translation runs translate, checks, verify, narration, scene and render, and adds an unseen Clip in its Language that Search finds", async () => {
  const { home, data, source, translations } = await madeInPortuguese();
  const job = translations.queue(source.id, "en");
  const agent = fakeAgent();
  const media = fakeMedia();
  const pipeline = createPipeline(data, agent, media);
  while (await pipeline.tick());

  assert.deepEqual(agent.calls, ["translate", "verify", "scene"]);
  assert.deepEqual(media.calls, [
    { tool: "speak", language: "en" },
    { tool: "align", language: "en" },
  ]);
  const made = data.db.select().from(clips).where(eq(clips.language, "en")).get()!;
  assert.deepEqual([made.conceptId, made.angle, made.lastSeenAt], [source.conceptId, source.angle, null]);
  assert.equal(made.file, join(home, "clips", `${source.conceptId}-${source.angle}-${job.id}.mp4`));
  assert.ok(existsSync(made.file));
  assert.deepEqual(
    createFeed(data)
      .search("pantry")
      .map((hit) => [hit.clipId, hit.language]),
    [[made.id, "en"]],
  );
  assert.deepEqual(data.db.select().from(clips).where(eq(clips.id, source.id)).get(), source);
});

test("a Paused Concept's Clip is still translated, while its new Clip job waits", async () => {
  const { data, source, translations } = await madeInPortuguese();
  const [{ id }] = data.db.select().from(sources).all();
  createSources(data, fakeMedia()).pause(id);
  const fresh = data.db
    .insert(jobs)
    .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: source.conceptId, angle: "mechanism" })
    .returning()
    .get();
  const job = translations.queue(source.id, "en");
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  const status = (jobId: number) => data.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status;
  assert.deepEqual([status(job.id), status(fresh.id)], ["done", "queued"]);
  assert.ok(data.db.select().from(clips).where(eq(clips.language, "en")).get());
});

test("the translate call gets the source beats as shown and the target Lexicon's keys, and its new terms go to that Lexicon", async () => {
  const { home, data, source, translations } = await madeInPortuguese({
    "lexicon.en.json": JSON.stringify({ Kubernetes: "koo ber net ease" }),
  });
  // The source Clip says a term with its pt-BR Respelling.
  const beats = JSON.parse(source.script);
  beats[1].speech = "Uma {thread|tréd} é como um cozinheiro numa cozinha que segue uma receita, passo a passo.";
  data.db
    .update(clips)
    .set({ script: JSON.stringify(beats) })
    .where(eq(clips.id, source.id))
    .run();
  const ptBR = await readFile(join(home, "lexicon.json"), "utf8");
  const fake = fakeAgent();
  const inputs: AgentStages["translate"]["input"][] = [];
  const agent: Agent = {
    run: async (stage, input, served) => {
      if (stage !== "translate") return fake.run(stage, input, served);
      inputs.push(input as AgentStages["translate"]["input"]);
      const { output } = (await fake.run(stage, input, served)) as { output: AgentStages["translate"]["output"] };
      output.beats[0].speech = "Ever had a {GC|gee see} pause freeze two things you ran at once?";
      return { ok: true, output: output as never };
    },
  };
  translations.queue(source.id, "en");
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].from, "Brazilian Portuguese");
  assert.equal(
    inputs[0].beats[1].speech,
    "Uma thread é como um cozinheiro numa cozinha que segue uma receita, passo a passo.",
  );
  assert.deepEqual(
    inputs[0].beats.map((beat) => beat.visual),
    beats.map((beat: { visual: string }) => beat.visual),
  );
  assert.deepEqual(inputs[0].lexicon, ["Kubernetes"]);
  assert.deepEqual(inputs[0].words, { min: 85, max: 200 });
  assert.deepEqual(JSON.parse(await readFile(join(home, "lexicon.en.json"), "utf8")), {
    Kubernetes: "koo ber net ease",
    GC: "gee see",
  });
  assert.equal(await readFile(join(home, "lexicon.json"), "utf8"), ptBR);
});

test("a translate job runs behind a regenerate and ahead of a new Clip job", async () => {
  const { data, source, translations } = await madeInPortuguese();
  const feed = createFeed(data);
  const fresh = data.db
    .insert(jobs)
    .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: source.conceptId, angle: "mechanism" })
    .returning()
    .get();
  const translate = translations.queue(source.id, "en");
  feed.press(source.id, "flag", "flag-1", { reason: "Pronunciation" });
  const inbox = createInbox(data);
  inbox.regenerate(inbox.list().flags[0].eventId);
  const fake = fakeAgent();
  const order: number[] = [];
  const agent: Agent = {
    run: (stage, input, served) => {
      if (!order.includes(served.jobId)) order.push(served.jobId);
      return fake.run(stage, input, served);
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  const regenerate = data.db.select().from(jobs).where(eq(jobs.kind, "regenerate")).get()!;
  assert.deepEqual(order, [regenerate.id, translate.id, fresh.id]);
});

test("at the daily Clip cap a translate job waits while extraction and regenerates still run, then runs the next day", async () => {
  const { home, data, source, translations } = await madeInPortuguese();
  await editConfig(home, { worker: { dailyClipCap: 1 } });
  const translate = translations.queue(source.id, "en");
  const feed = createFeed(data);
  feed.press(source.id, "flag", "flag-1", { reason: "Pronunciation" });
  const inbox = createInbox(data);
  inbox.regenerate(inbox.list().flags[0].eventId);
  const another = join(dirname(home), "processes.md");
  await writeFile(another, "# Processes\n\nA process holds its threads.\n");
  await createSources(data, fakeMedia()).add(another);

  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());
  while (await pipeline.tick());

  const status = (kind: "translate" | "regenerate" | "extract_chapter") =>
    data.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.kind, kind))
      .all()
      .map((job) => job.status);
  assert.deepEqual(status("translate"), ["queued"]);
  assert.deepEqual(status("regenerate"), ["done"]);
  assert.deepEqual(status("extract_chapter"), ["done", "done"]);
  assert.deepEqual(
    translations.sheet(source.id).languages.find((row) => row.language === "en"),
    {
      language: "en",
      name: "English",
      made: null,
      job: { id: translate.id, status: "queued" },
      capped: true,
      blocker: { reason: "server not running: run `pnpm start`", until: null },
    },
  );

  // Tomorrow: today's Clip was made yesterday.
  data.db
    .update(clips)
    .set({ createdAt: new Date(Date.now() - 86_400_000) })
    .run();
  while (await pipeline.tick());

  assert.deepEqual(status("translate"), ["done"]);
});

test("a queued translate job counts toward the daily Clip cap of the buffer fill, never toward its buffer", async () => {
  const { home, data, source, translations } = await openTwoConcepts();
  translations.queue(source.id, "en");
  const newJobs = () => data.db.select().from(jobs).where(eq(jobs.kind, "new")).all().length;
  // The en voice is missing, so the translation waits and only the buffer fill acts.
  const pipeline = createPipeline(data, fakeAgent(), fakeMedia());

  // 1 Clip today + 1 Translation reach a cap of 2: the second Concept gets no job.
  await editConfig(home, { worker: { bufferTarget: 5, dailyClipCap: 2 } });
  await pipeline.tick(["en"]);
  assert.equal(newJobs(), 1);

  // 1 unseen Clip under a buffer of 2: the Translation does not fill it, so the second Concept gets its job.
  await editConfig(home, { worker: { bufferTarget: 2, dailyClipCap: 10 } });
  await pipeline.tick(["en"]);
  assert.equal(newJobs(), 2);
});

/**
 * A data folder whose Source teaches two Concepts, the first made into one unseen pt-BR Clip and the second with no job
 * yet, as a buffer of 1 leaves them.
 */
async function openTwoConcepts() {
  const { home, file } = await setup();
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: { bufferTarget: 1 } }));
  const data = openData(home);
  await createSources(data, fakeMedia()).add(file);
  const agent = fakeAgent({
    extract: () => [
      {
        title: "What is a thread",
        summary: "A thread runs inside a process.",
        angles: ["analogy"],
        anchor: { chapter: "Threads" },
      },
      {
        title: "What is a process",
        summary: "A process holds threads.",
        angles: ["analogy"],
        anchor: { chapter: "Threads" },
      },
    ],
  });
  while (await createPipeline(data, agent, fakeMedia()).tick());
  const [source] = data.db.select().from(clips).all();
  assert.equal(data.db.select().from(jobs).where(eq(jobs.kind, "new")).all().length, 1);
  return { home, data, source, translations: createTranslations(data) };
}

test("a translation failing a gate is rewritten 2×, then stuck in the Inbox, and ↻ Retry requeues it", async () => {
  const { data, source, translations } = await madeInPortuguese();
  const job = translations.queue(source.id, "en");
  let failing = true;
  const fake = fakeAgent();
  const feedback: (string | undefined)[] = [];
  const agent: Agent = {
    run: async (stage, input, served) => {
      if (stage === "translate") {
        feedback.push((input as AgentStages["translate"]["input"]).feedback);
        if (failing)
          return {
            ok: true,
            output: {
              beats: [
                { speech: "Too short.", visual: "x" },
                { speech: "Yes.", visual: "y" },
              ],
            } as never,
          };
      }
      return fake.run(stage, input, served);
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  const problem =
    "3 spoken words, write at least 85; keep the source's 6 beats in order, each with its visual unchanged";
  assert.deepEqual(feedback, [undefined, problem, problem]);
  const { stuck } = createInbox(data).list();
  assert.deepEqual(
    stuck.map((row) => [row.jobId, row.kind, row.concept?.title]),
    [[job.id, "translate", "What is a thread"]],
  );
  assert.match(stuck[0].lastError!, /Script still failing after 2 rewrites/);

  createSources(data, fakeMedia()).retry(job.id);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, "queued");
  failing = false;
  while (await pipeline.tick());

  assert.equal(data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, "done");
  assert.ok(data.db.select().from(clips).where(eq(clips.language, "en")).get());
});

test("a translation that changes a visual or drops a beat fails the check gate, is rewritten 2×, then stuck", async () => {
  const { data, source, translations } = await madeInPortuguese();
  const job = translations.queue(source.id, "en");
  const fake = fakeAgent();
  const feedback: (string | undefined)[] = [];
  let calls = 0;
  const agent: Agent = {
    run: async (stage, input, served) => {
      if (stage !== "translate") return fake.run(stage, input, served);
      feedback.push((input as AgentStages["translate"]["input"]).feedback);
      const { output } = structuredClone(await fake.run(stage, input, served)) as {
        output: AgentStages["translate"]["output"];
      };
      // Within the word budget, so only the guard fails it.
      calls++;
      if (calls === 1) output.beats[1].visual = "restaurant";
      if (calls === 2 || calls === 3) output.beats.splice(4, 1);
      return { ok: true, output: output as never };
    },
  };
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());

  const problem = "keep the source's 6 beats in order, each with its visual unchanged";
  assert.deepEqual(feedback, [undefined, problem, problem]);
  const [stuck] = createInbox(data).list().stuck;
  assert.deepEqual([stuck.jobId, stuck.stage], [job.id, "script.json"]);
  assert.match(stuck.lastError!, /Script still failing after 2 rewrites/);
  assert.equal(data.db.select().from(clips).where(eq(clips.language, "en")).get(), undefined);

  createSources(data, fakeMedia()).retry(job.id);
  while (await pipeline.tick());

  assert.equal(data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, "done");
  assert.ok(data.db.select().from(clips).where(eq(clips.language, "en")).get());
});

test("queueing a Translation twice queues one job; a Language with a Clip is refused, and the sheet shows it made", async () => {
  const { data, source, translations } = await madeInPortuguese();
  const first = translations.queue(source.id, "en");
  assert.deepEqual(
    [first.kind, first.priority, first.language, first.fromClipId, first.conceptId, first.angle, first.queued],
    ["translate", JOB_PRIORITY.translate, "en", source.id, source.conceptId, source.angle, true],
  );
  const again = translations.queue(source.id, "en");
  assert.deepEqual([again.id, again.queued], [first.id, false]);
  assert.equal(data.db.select().from(jobs).where(eq(jobs.kind, "translate")).all().length, 1);
  assert.throws(() => translations.queue(source.id, "pt-BR"), /Already in Portuguese/);

  while (await createPipeline(data, fakeAgent(), fakeMedia()).tick());

  const made = data.db.select().from(clips).where(eq(clips.language, "en")).get()!;
  assert.throws(() => translations.queue(source.id, "en"), /Already in English/);
  const sheet = translations.sheet(source.id);
  assert.deepEqual(sheet.concept, { title: "What is a thread" });
  assert.deepEqual(
    sheet.languages.map((row) => [row.language, row.made?.clipId ?? null, row.job]),
    [
      ["en", made.id, null],
      ["es", null, null],
    ],
  );
  // From the en Clip, its source's Language is the one made.
  assert.deepEqual(
    translations.sheet(made.id).languages.map((row) => [row.language, row.made?.clipId ?? null]),
    [
      ["pt-BR", source.id],
      ["es", null],
    ],
  );
});
