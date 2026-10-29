import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, test } from "vitest";
import type { AgentStages } from "@doomlearn/core/agent";
import { createAgent } from "@doomlearn/agents/agent";
import { openData } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { localMedia } from "@doomlearn/media/local-media";
import { createPipeline } from "@doomlearn/core/pipeline";
import { agentCalls, clips, jobs } from "@doomlearn/core/schema";
import { createSources } from "@doomlearn/core/sources";
import { createTranslations } from "@doomlearn/core/translations";
import { REMOTION } from "@doomlearn/media/render";

// Pass or fail, the tts and align runtimes exit with the test, so none outlives the vitest worker.
afterAll(localMedia.stop);

/**
 * Every stage on Codex `gpt-6-luna` at `low`, so the smoke spends no Claude quota. A ChatGPT login cannot use
 * `gpt-6-sol`, so it runs on the cheapest model `codex debug models` lists.
 */
const CODEX = { provider: "codex", model: "gpt-6-luna", effort: "low" };

/**
 * One tiny `.md` Source through every real port, into a fresh data folder: `pnpm smoke`. Its first Clip is in en, then
 * translated into pt-BR. Spends real Codex usage and takes minutes, so it never runs in `pnpm test`.
 */
test("smoke: a tiny .md Source becomes an en Clip and its pt-BR Translation through the real ports", {
  skip: !process.env.DOOMLEARN_SMOKE,
  // Two narrations on the CPU TTS, which swaps when the Mac is short of memory.
  timeout: 5_400_000,
}, async () => {
  const startedAt = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-smoke-"));
  const file = join(dir, "threads.md");
  await writeFile(
    file,
    `# Threads

A thread is one sequence of execution inside a process. A process owns memory, open files and other resources;
its threads share all of them, but each thread has its own stack and its own program counter, so each one
knows where it is in the code. Because threads share memory, two threads can read and write the same variable
at the same time. Starting a thread is much cheaper than starting a process, since nothing has to be copied:
the new thread simply begins running inside the memory that is already there.
`,
  );
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      agents: { stages: { extract: CODEX, script: CODEX, verify: CODEX, split: CODEX, scene: CODEX } },
      worker: { language: "en" },
    }),
  );
  const data = openData(home);
  await createSources(data, localMedia).add(file);

  const pipeline = createPipeline(data, createAgent(data), localMedia);
  // Stops at the first Clip: extraction may find more Concepts, each one more Clip to pay for.
  while (!data.db.select().from(clips).get() && (await pipeline.tick()));
  const [slot] = createFeed(data).next();
  assert.ok(slot, `No Clip in the Feed. Jobs: ${JSON.stringify(data.db.select().from(jobs).all())}`);
  const firstAt = Date.now();

  // A translate job outranks the new Clip jobs the buffer queues, so it runs next.
  createTranslations(data).queue(slot.clipId, "pt-BR");
  const translated = () => data.db.select().from(clips).where(eq(clips.language, "pt-BR")).get();
  while (!translated() && (await pipeline.tick()));
  assert.ok(translated(), `No pt-BR Clip. Jobs: ${JSON.stringify(data.db.select().from(jobs).all())}`);

  const made = data.db.select().from(clips).all();
  assert.deepEqual(made.map((clip) => clip.language).toSorted(), ["en", "pt-BR"]);
  const seconds = made.map((clip) => {
    const probe = JSON.parse(
      execFileSync(REMOTION, ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", clip.file], {
        encoding: "utf8",
      }),
    );
    const duration = Number(probe.format.duration);
    assert.ok(duration >= 30 && duration <= 60, `${clip.language} Clip is ${duration} s`);
    assert.deepEqual(probe.streams.map((stream: { codec_type: string }) => stream.codec_type).toSorted(), [
      "audio",
      "video",
    ]);
    // The caption's longest word finds its Clip.
    const [word] = clip.caption.match(/[\p{L}\p{N}]+/gu)!.toSorted((a, b) => b.length - a.length);
    assert.ok(
      createFeed(data)
        .search(word)
        .some((hit) => hit.clipId === clip.id),
      `Search "${word}" misses the ${clip.language} Clip`,
    );
    return duration;
  });

  const calls = data.db.select().from(agentCalls).all();
  assert.deepEqual(
    calls.filter((call) => call.provider !== "codex"),
    [],
    "An agent call ran off Codex",
  );
  const stages = new Set(calls.map((call) => call.stage));
  for (const stage of ["extract", "script", "verify", "scene", "translate"] satisfies (keyof AgentStages)[])
    assert.ok(stages.has(stage), `No agent_calls row for ${stage}`);
  console.table(
    calls.map(({ stage, provider, model, effort, tokensIn, tokensOut, costUsd, durationMs, isError }) => ({
      stage,
      provider,
      model,
      effort,
      tokensIn,
      tokensOut,
      costUsd,
      durationMs,
      isError,
    })),
  );
  console.log(
    made.map((clip, i) => `${clip.language} Clip: ${clip.file} (${seconds[i]} s)`).join("\n"),
    `\nFirst Clip after ${Math.round((firstAt - startedAt) / 1000)} s, Translation after ${Math.round((Date.now() - firstAt) / 1000)} s.`,
    `\nTo watch them, set up ${data.home} as in the README, then: DOOMLEARN_HOME=${data.home} pnpm start`,
  );
});
