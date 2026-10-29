import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { openData } from "./data.ts";
import { agentCalls, concepts, JOB_PRIORITY, jobs } from "./schema.ts";
import { createSources } from "./sources.ts";
import { usage } from "./stats.ts";
import { fakeMedia } from "./test/fakes.ts";

test("stats aggregates agent usage per stage, day, Source and Clip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  await writeFile(join(dir, "threads.md"), "# Threads\n\nA thread is one sequence of execution inside a process.\n");
  const data = openData(join(dir, "home"));
  const source = await createSources(data, fakeMedia()).add(join(dir, "threads.md"), { title: "Threads" });
  const extraction = data.db.select().from(jobs).get()!;
  const concept = data.db
    .insert(concepts)
    .values({ title: "What is a thread", summary: "-", fitAngles: ["analogy"], sourceId: source.id, seq: 0 })
    .returning()
    .get();
  const clip = data.db
    .insert(jobs)
    .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: concept.id, angle: "analogy" })
    .returning()
    .get();
  const day1 = new Date(2026, 9, 7, 12);
  const day2 = new Date(2026, 9, 8, 12);
  const call = {
    provider: "claude" as const,
    sourceId: source.id,
    tokensIn: 100,
    tokensOut: 10,
    durationMs: 1000,
    isError: false,
  };
  data.db
    .insert(agentCalls)
    .values([
      { ...call, stage: "extract", jobId: extraction.id, costUsd: 0.5, at: day1 },
      { ...call, stage: "script", jobId: clip.id, costUsd: 0.25, at: day2 },
      {
        ...call,
        stage: "script",
        jobId: clip.id,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        isError: true,
        apiErrorStatus: 429,
        at: day2,
      },
    ])
    .run();

  const total = (calls: number, errors: number, apiEquivalentUsd: number, tokensIn: number, tokensOut: number) => ({
    calls,
    errors,
    apiEquivalentUsd,
    tokensIn,
    tokensOut,
    durationMs: calls * 1000,
  });
  assert.deepEqual(usage(data, "stage"), [
    { key: "extract", ...total(1, 0, 0.5, 100, 10) },
    { key: "script", ...total(2, 1, 0.25, 100, 10) },
  ]);
  assert.deepEqual(usage(data, "day"), [
    { key: "2026-10-07", ...total(1, 0, 0.5, 100, 10) },
    { key: "2026-10-08", ...total(2, 1, 0.25, 100, 10) },
  ]);
  assert.deepEqual(usage(data, "source"), [{ key: "Threads", ...total(3, 1, 0.75, 200, 20) }]);
  assert.deepEqual(usage(data, "clip"), [{ key: "What is a thread · analogy", ...total(2, 1, 0.25, 100, 10) }]);
});

test("stats group and filter by Provider; Codex reports no cost, so its API-equivalent cost is null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const data = openData(join(dir, "home"));
  const at = new Date(2026, 9, 8, 12);
  data.db
    .insert(agentCalls)
    .values([
      {
        provider: "claude",
        stage: "extract",
        costUsd: 0.5,
        tokensIn: 100,
        tokensOut: 10,
        durationMs: 1000,
        isError: false,
        at,
      },
      {
        provider: "codex",
        stage: "extract",
        costUsd: null,
        tokensIn: 300,
        tokensOut: 30,
        durationMs: 2000,
        isError: false,
        at,
      },
      {
        provider: "codex",
        stage: "script",
        costUsd: null,
        tokensIn: 50,
        tokensOut: 5,
        durationMs: 500,
        isError: true,
        at,
      },
    ])
    .run();

  assert.deepEqual(usage(data, "provider"), [
    { key: "claude", calls: 1, errors: 0, apiEquivalentUsd: 0.5, tokensIn: 100, tokensOut: 10, durationMs: 1000 },
    { key: "codex", calls: 2, errors: 1, apiEquivalentUsd: null, tokensIn: 350, tokensOut: 35, durationMs: 2500 },
  ]);
  assert.deepEqual(usage(data, "stage", { provider: "codex" }), [
    { key: "extract", calls: 1, errors: 0, apiEquivalentUsd: null, tokensIn: 300, tokensOut: 30, durationMs: 2000 },
    { key: "script", calls: 1, errors: 1, apiEquivalentUsd: null, tokensIn: 50, tokensOut: 5, durationMs: 500 },
  ]);
});
