import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openData } from "@doomlearn/core/data";
import { agentCalls, chapters, concepts, JOB_PRIORITY, jobs, passages, sources } from "@doomlearn/core/schema";
import { publishLiveness, publishStage } from "@doomlearn/core/status";
import { editConfig } from "@doomlearn/core/test/fakes";

/**
 * Runs `doomlearn <args>` on the data folder `home`.
 */
function doomlearn(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args], {
    env: { ...process.env, DOOMLEARN_HOME: home },
    encoding: "utf8",
    timeout: 30_000,
  });
}

// Four CLI processes: on a loaded CI runner they take over the default 5 s.
test("stats groups agent usage by Provider and keeps one Provider, with the cost labelled API-equivalent", {
  timeout: 30_000,
}, async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  const at = new Date(2026, 9, 9, 12);
  openData(home)
    .db.insert(agentCalls)
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
      { provider: "codex", stage: "scene", tokensIn: 300, tokensOut: 30, durationMs: 2000, isError: false, at },
    ])
    .run();

  const byProvider = doomlearn(home, "stats", "--by", "provider");
  assert.equal(byProvider.status, 0, byProvider.stderr);
  assert.match(byProvider.stdout, /Agent usage per provider/);
  assert.match(byProvider.stdout, /'claude' .* 0\.5 /);
  assert.match(byProvider.stdout, /'codex' .* null /);
  assert.match(byProvider.stdout, /API-equivalent/);
  assert.doesNotMatch(byProvider.stdout, /Agent usage per stage/);

  const codexStages = doomlearn(home, "stats", "--by", "stage", "--provider", "codex");
  assert.match(codexStages.stdout, /'scene'/);
  assert.doesNotMatch(codexStages.stdout, /'extract'/);

  const everything = doomlearn(home, "stats");
  for (const by of ["provider", "stage", "day", "source", "clip"])
    assert.match(everything.stdout, new RegExp(`Agent usage per ${by}`));

  const wrong = doomlearn(home, "stats", "--by", "week");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /by/);
});

test("status prints the Worker status and every active Blocker with its until-time, as the PWA gets them", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  const data = openData(home);
  const retryAt = new Date(2099, 0, 1, 14, 30);
  data.db
    .insert(agentCalls)
    .values({ stage: "script", provider: "claude", durationMs: 1, isError: true, retryAt, at: new Date() })
    .run();
  await editConfig(home, { worker: { paused: true } });

  const stopped = doomlearn(home, "status");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /^Worker: stopped$/m);
  assert.match(stopped.stdout, /^ {2}✗ server not running: run `pnpm start`$/m);
  assert.match(stopped.stdout, /^ {2}✗ Worker pause until resumed$/m);
  assert.match(stopped.stdout, /^ {2}✗ claude rate limit until 2099-01-01 14:30$/m);
  assert.match(stopped.stdout, /^Queue: 0 running · 0 queued · 0 stuck · paused until 14:30 \(rate limit\) · buffer /m);

  // This process stands in for the server, with the worker on a stage.
  publishLiveness(data, { liveness: "running" });
  publishStage(data, {
    jobId: data.db.insert(jobs).values({ kind: "new", priority: 1 }).returning().get().id,
    stage: "scene",
    startedAt: new Date(2099, 0, 1, 9, 12),
  });
  const running = doomlearn(home, "status");
  assert.match(running.stdout, /^Worker: running scene · job 1 · since 2099-01-01 09:12$/m);
  assert.doesNotMatch(running.stdout, /server not running/);
});

test("status says a Source's chapters are extracted, not complete, while its Clip job runs, and counts the open jobs", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  const { db } = openData(home);
  const source = db.insert(sources).values({ title: "Pro Git", type: "md", sha256: "-" }).returning().get();
  db.insert(chapters).values({ sourceId: source.id, seq: 0, title: "Getting Started", status: "extracted" }).run();
  const concept = db
    .insert(concepts)
    .values({ title: "What is Git", summary: "-", fitAngles: ["analogy"], sourceId: source.id, seq: 0 })
    .returning()
    .get();
  db.insert(passages)
    .values({ conceptId: concept.id, sourceId: source.id, anchor: { chapter: "Getting Started" }, text: "-" })
    .run();
  // Left running by a worker killed mid-stage, with no Clip yet.
  db.insert(jobs)
    .values({ kind: "new", priority: JOB_PRIORITY.new, conceptId: concept.id, angle: "analogy", status: "running" })
    .run();

  const status = doomlearn(home, "status");
  assert.equal(status.status, 0, status.stderr);
  const line = status.stdout.split("\n").find((text) => text.startsWith("#1 "))!;
  assert.doesNotMatch(line, /complete/);
  assert.match(line, /extracted 1\/1 · 1 Concepts$/);
  assert.match(status.stdout, /^Queue: 1 running · 0 queued · 0 stuck · buffer 0\/\d+ · today 0\/\d+ Clips$/m);
});
