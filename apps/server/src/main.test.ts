import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openData } from "@doomlearn/core/data";
import { createPipeline } from "@doomlearn/core/pipeline";
import { createPronunciation } from "@doomlearn/core/pronunciation";
import { clips, concepts, events, JOB_PRIORITY, jobs, workerStatus } from "@doomlearn/core/schema";
import { createSources } from "@doomlearn/core/sources";
import { alive } from "@doomlearn/core/status";
import { voiceProblem } from "@doomlearn/media/tools";
import { editConfig, fakeAgent, fakeMedia } from "@doomlearn/core/test/fakes";

/**
 * Runs `main.ts` directly (not `pnpm start`, so `prestart` is skipped) on a data folder at `home`.
 */
function start(home: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: { ...process.env, DOOMLEARN_HOME: home },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("main.ts refuses a config.json with an unknown key, printing the prettified error before the media preflight", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: { dailyClipcap: 3 } }));

  const started = start(home);

  assert.equal(started.status, 1);
  assert.match(started.stderr, /config\.json is invalid:\n✖ Unrecognized key: "dailyClipcap"\n {2}→ at worker/);
  // The message alone, not a stack trace.
  assert.doesNotMatch(started.stderr, /\n\s+at /);
  assert.doesNotMatch(started.stderr, /worker blocked/);
});

test("main.ts refuses a lexicon.json that is not JSON, naming it without a stack trace", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  await mkdir(home);
  await writeFile(join(home, "lexicon.json"), '{"thread": "tréd",}');

  const started = start(home);

  assert.equal(started.status, 1);
  assert.match(started.stderr, /lexicon\.json is not valid JSON/);
  assert.doesNotMatch(started.stderr, /\n\s+at /);
});

test("with Codex logged out, the server keeps serving, the worker starts no stage, and the reason is logged on every config change", {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  const port = await freePort();
  const stages = (model: string) =>
    Object.fromEntries(
      ["extract", "script", "verify", "split", "scene"].map((stage) => [
        stage,
        { provider: "codex", model, effort: "low" },
      ]),
    );
  await mkdir(home);
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ agents: { stages: stages("gpt-6-sol") }, server: { port } }),
  );
  // One buffered Clip, made on fakes.
  const data = openData(home);
  const buffered = join(dir, "locks.md");
  await writeFile(buffered, "Locks");
  await createSources(data, fakeMedia({ chapters: [{ title: "ch", text: "Locks" }] })).add(buffered);
  const agent = fakeAgent({
    extract: (chapter) => [{ title: chapter, summary: chapter, angles: ["analogy"], anchor: { chapter } }],
  });
  const pipeline = createPipeline(data, agent, fakeMedia());
  while (await pipeline.tick());
  // A queued extraction job the worker would start if it could.
  const book = join(dir, "threads.md");
  await writeFile(book, "# Threads\n\nA thread is one sequence of execution inside a process.\n");
  await createSources(data, fakeMedia()).add(book);
  // A logged-out codex that records any other call.
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh\n[ "$1" = login ] && { echo "Not logged in"; exit 1; }\ntouch "${join(dir, "called")}"\n`,
  );
  await chmod(join(bin, "codex"), 0o755);

  const server = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: { ...process.env, DOOMLEARN_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let stdout = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  try {
    const blocked = "doomlearn: worker blocked: codex not logged in: run `codex login`";
    await vi.waitFor(() => assert.equal(stderr.split(blocked).length - 1, 1), { timeout: 30_000, interval: 100 });
    const slots = await (await fetch(`http://127.0.0.1:${port}/api/next`)).json();
    assert.deepEqual(
      slots.map((slot: { concept: { title: string }; url: string }) => [slot.concept.title, slot.url]),
      [["Locks", "/clips/1-analogy-2.mp4"]],
    );

    await editConfig(home, { agents: { stages: stages("gpt-6-luna") }, server: { port } });
    await vi.waitFor(() => assert.equal(stderr.split(blocked).length - 1, 2), { timeout: 30_000, interval: 100 });

    // The startup line speaks only for the media preflight, so it never says the worker runs while it is blocked.
    assert.match(stdout, /doomlearn: data in .+, media (ready|blocked)\n/);
    assert.equal(existsSync(join(dir, "called")), false);
    // The buffered Clip's jobs are done; the new Source's job is still queued.
    assert.equal(openData(home).db.select().from(jobs).where(eq(jobs.status, "queued")).all().length, 1);
  } finally {
    server.kill();
  }
});

/**
 * A free port on loopback.
 */
function freePort() {
  return new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The server as main.ts runs it, forking `worker` and restarting a crashed one after 50 ms, on a data folder holding a
 * queued extraction job. It runs in its own process group, as in a terminal, so a test can press Ctrl+C on it.
 * `claude` on PATH is a stand-in, logged in unless `loggedOut`, whose call records its pid, its group's sleep and its
 * parent (the worker) in `agent`, takes 2 s, then touches `finished`. `config` adds to the config the server starts on.
 */
async function forkServer(
  worker = fileURLToPath(new URL("./test/worker.ts", import.meta.url)),
  { config = {}, loggedOut = false }: { config?: object; loggedOut?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  const port = await freePort();
  await writeFile(join(home, "config.json"), JSON.stringify({ ...config, server: { port } }));
  const book = join(dir, "threads.md");
  await writeFile(book, "# Threads\n\nA thread is one sequence of execution inside a process.\n");
  await createSources(openData(home), fakeMedia()).add(book);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const success = fileURLToPath(new URL("../../../packages/agents/src/test/claude/success.json", import.meta.url));
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh
[ "$1" = auth ] && { echo '{"loggedIn": ${!loggedOut}, "authMethod": "claude.ai"}'; exit ${loggedOut ? 1 : 0}; }
sleep 2 & echo "$$ $! $PPID" > "${join(dir, "agent")}"
wait
cat "${success}"
touch "${join(dir, "finished")}"
`,
  );
  await chmod(join(bin, "claude"), 0o755);

  const server = spawn(process.execPath, [fileURLToPath(new URL("./test/main.ts", import.meta.url)), worker, "50"], {
    env: { ...process.env, DOOMLEARN_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    detached: true,
  });
  let stdout = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    stdout += chunk;
  });
  const exited = new Promise((resolve) => server.on("exit", resolve));
  /** The agent call's pids, once it has started: the CLI, its sleep and the worker. */
  const agent = async () => {
    await vi.waitFor(() => assert.ok(existsSync(join(dir, "agent"))), { timeout: 20_000, interval: 50 });
    return (await readFile(join(dir, "agent"), "utf8")).trim().split(" ").map(Number);
  };
  return {
    dir,
    home,
    server,
    exited,
    agent,
    output: () => stdout,
    status: async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json(),
    /** Ctrl+C in the server's terminal: SIGINT to its whole process group. */
    ctrlC: () => process.kill(-server.pid!, "SIGINT"),
  };
}

test("the first Ctrl+C lets the running agent call and its stage finish while the server keeps serving, then stops as stopped", {
  timeout: 60_000,
}, async () => {
  const { dir, home, server, exited, agent, output, status, ctrlC } = await forkServer();
  try {
    const [cli, sleep, worker] = await agent();

    ctrlC();

    await vi.waitFor(() => assert.match(output(), /doomlearn: stopping after current stage \(extract, threads\)/), {
      timeout: 5000,
    });
    assert.equal((await status()).state, "stopping");
    assert.ok(alive(cli) && alive(sleep));
    await exited;
    assert.ok(existsSync(join(dir, "finished")));
    assert.equal(openData(home).db.select().from(jobs).get()?.stage, "extract.json");
    // Said by the server itself, so a later process reusing its pid does not show the worker up.
    assert.equal(openData(home).db.select().from(workerStatus).get()?.liveness, "stopped");
    await vi.waitFor(() => assert.deepEqual([cli, sleep, worker].map(alive), [false, false, false]));
  } finally {
    server.kill("SIGKILL");
  }
});

test("under pnpm start, which forwards the Ctrl+C a few ms later, one Ctrl+C still lets the stage finish", {
  timeout: 60_000,
}, async () => {
  const { dir, server, exited, agent, ctrlC } = await forkServer();
  try {
    await agent();

    ctrlC();
    // pnpm's forwarded copy of the same SIGINT, about 5 ms later.
    await setTimeout(5);
    process.kill(server.pid!, "SIGINT");

    await exited;
    assert.ok(existsSync(join(dir, "finished")));
  } finally {
    server.kill("SIGKILL");
  }
});

test("a second Ctrl+C kills the agent call now, leaving no process behind", { timeout: 60_000 }, async () => {
  const { dir, server, exited, agent, output, ctrlC } = await forkServer();
  try {
    const pids = await agent();

    ctrlC();
    await vi.waitFor(() => assert.match(output(), /stopping after current stage/), { timeout: 5000 });
    // A second press, over half a second later.
    await setTimeout(600);
    ctrlC();

    await exited;
    await vi.waitFor(() => assert.deepEqual(pids.map(alive), [false, false, false]), { timeout: 1000 });
    assert.equal(existsSync(join(dir, "finished")), false);
  } finally {
    server.kill("SIGKILL");
  }
});

test("the server exiting kills the worker and its agent call", { timeout: 60_000 }, async () => {
  const { dir, server, agent } = await forkServer();
  const pids = await agent();

  server.kill("SIGKILL");

  await vi.waitFor(() => assert.deepEqual(pids.map(alive), [false, false, false]), { timeout: 5000 });
  assert.equal(existsSync(join(dir, "finished")), false);
});

test("a crashing worker is restarted 3 times, then stays down with the reason and count in status; the server keeps serving", {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const crash = join(dir, "crash.ts");
  await writeFile(
    crash,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(dir, "starts"))}, 'start\\n');\nprocess.exit(1);\n`,
  );
  const { server, status } = await forkServer(crash);
  try {
    await vi.waitFor(
      async () => {
        const { state, restarts, blockers } = await status();
        assert.deepEqual(
          { state, restarts, blockers },
          {
            state: "stopped",
            restarts: 3,
            blockers: [
              {
                kind: "stopped",
                reason: "worker exited with code 1, restarted 3 times in the last hour, staying down",
                until: null,
              },
            ],
          },
        );
      },
      { timeout: 20_000, interval: 100 },
    );
    assert.equal((await readFile(join(dir, "starts"), "utf8")).split("\n").length - 1, 4);
    assert.equal(server.exitCode, null);
  } finally {
    server.kill("SIGKILL");
  }
});

test("a failing media preflight is a preflight Blocker in status, while the server keeps serving", {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const worker = join(dir, "worker.ts");
  await writeFile(
    worker,
    `import { openData } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/data.ts", import.meta.url)))};
import { work } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};
await work(openData(), { checkMedia: async () => ({ problems: ['tts environment outdated: run \`pnpm bootstrap\`'], toolProblems: ['tts environment outdated: run \`pnpm bootstrap\`'], voiceless: [], interpreters: [] }) });
`,
  );
  const { server, status } = await forkServer(worker);
  try {
    await vi.waitFor(
      async () =>
        assert.deepEqual((await status()).blockers, [
          {
            kind: "preflight",
            reason: "tts environment outdated: run `pnpm bootstrap`",
            until: null,
            languages: ["pt-BR", "en", "es"],
          },
        ]),
      { timeout: 20_000, interval: 100 },
    );
  } finally {
    server.kill("SIGKILL");
  }
});

test("a missing V3 voice is a Blocker that holds back only the en and es jobs, and is checked again until it is there", {
  timeout: 90_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const weights = join(dir, "v3-weights");
  const worker = join(dir, "worker.ts");
  // Fake agent and media, and a media preflight whose V3 weights are there once `weights` exists.
  await writeFile(
    worker,
    `import { existsSync } from "node:fs";
import { openData } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/data.ts", import.meta.url)))};
import { LANGUAGES } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/languages.ts", import.meta.url)))};
import { fakeAgent, fakeMedia } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/test/fakes.ts", import.meta.url)))};
import { work } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};
await work(openData(), {
  media: fakeMedia(),
  agent: fakeAgent({ extract: (chapter) => [{ title: chapter, summary: chapter, angles: ["analogy"], anchor: { chapter } }] }),
  checkMedia: async (languages) => {
    const voiceless = existsSync(${JSON.stringify(weights)})
      ? []
      : languages.filter((language) => LANGUAGES[language].tts.checkpoint === "v3");
    return {
      problems: voiceless.map((language) => \`tts weights for \${LANGUAGES[language].name} missing: run \\\`pnpm bootstrap\\\`\`),
      toolProblems: [],
      voiceless,
      interpreters: [],
    };
  },
});
`,
  );
  const { home, server, status } = await forkServer(worker);
  const { port } = JSON.parse(await readFile(join(home, "config.json"), "utf8")).server;
  const data = openData(home);
  /**
   * The preflight Blockers' reasons, once they are `reasons`.
   */
  const blocked = (reasons: string[]) =>
    vi.waitFor(
      async () =>
        assert.deepEqual(
          (await status()).blockers
            .filter((blocker: { kind: string }) => blocker.kind === "preflight")
            .map((blocker: { reason: string }) => blocker.reason),
          reasons,
        ),
      { timeout: 20_000, interval: 100 },
    );
  /**
   * The Languages of the Clips, once there are `count`.
   */
  const made = (count: number) =>
    vi.waitFor(
      () => {
        const languages = data.db.select({ language: clips.language }).from(clips).orderBy(clips.id).all();
        assert.equal(languages.length, count);
        return languages.map(({ language }) => language);
      },
      { timeout: 20_000, interval: 100 },
    );
  const regenerate = () => data.db.select().from(jobs).where(eq(jobs.kind, "regenerate")).get()!;
  try {
    // pt-BR, and no en or es job: the missing V3 weights block nothing, and a pt-BR Clip is made.
    await blocked([]);
    assert.deepEqual(await made(1), ["pt-BR"]);

    // An en Clip the Learner flagged, and its regenerate.
    const ptBR = data.db.select().from(clips).get()!;
    data.db
      .insert(clips)
      .values({ ...ptBR, id: undefined, language: "en", file: join(home, "clips", "en.mp4"), createdAt: undefined })
      .run();
    data.db
      .insert(jobs)
      .values({
        kind: "regenerate",
        priority: JOB_PRIORITY.regenerate,
        conceptId: ptBR.conceptId,
        angle: ptBR.angle,
        language: "en",
      })
      .run();
    await blocked(["tts weights for English missing: run `pnpm bootstrap`"]);

    // A new Source in pt-BR still becomes a Clip, while the en regenerate waits.
    const book = join(dir, "locks.md");
    await writeFile(book, "Locks");
    await createSources(data, fakeMedia({ chapters: [{ title: "ch", text: "Locks" }] })).add(book);
    assert.deepEqual(await made(3), ["pt-BR", "en", "pt-BR"]);
    assert.equal(regenerate().status, "queued");

    await editConfig(home, { server: { port }, worker: { language: "es" } });
    await blocked([
      "tts weights for English missing: run `pnpm bootstrap`",
      "tts weights for Spanish missing: run `pnpm bootstrap`",
    ]);

    // `pnpm bootstrap` fetched them: checked again with no config change, and the regenerate runs.
    await writeFile(weights, "");
    await blocked([]);
    await vi.waitFor(() => assert.equal(regenerate().status, "done"), { timeout: 20_000, interval: 100 });
  } finally {
    server.kill("SIGKILL");
  }
});

test("a preview is spoken during a Worker pause, outside the Run windows, at the daily cap and with an agent problem", {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const worker = join(dir, "worker.ts");
  const spoken = join(dir, "spoken.jsonl");
  // Fake media whose TTS logs what it says, and a media preflight that finds nothing.
  await writeFile(
    worker,
    `import { appendFileSync } from "node:fs";
import { openData } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/data.ts", import.meta.url)))};
import { fakeMedia } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/test/fakes.ts", import.meta.url)))};
import { work } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};
const media = fakeMedia();
await work(openData(), {
  media: {
    ...media,
    speak: (text, out, language) => {
      appendFileSync(${JSON.stringify(spoken)}, JSON.stringify({ text, language }) + "\\n");
      return media.speak(text, out, language);
    },
  },
  checkMedia: async () => ({ problems: [], toolProblems: [], voiceless: [], interpreters: [] }),
});
`,
  );
  // The only Run window is on another day of the week than today.
  const elsewhere = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][(new Date().getDay() + 3) % 7];
  const { home, server, status } = await forkServer(worker, {
    config: {
      worker: {
        paused: true,
        dailyClipCap: 0,
        language: "es",
        schedule: { windows: [{ days: [elsewhere], start: "03:00", end: "04:00" }] },
      },
    },
    loggedOut: true,
  });
  const data = openData(home);
  try {
    await vi.waitFor(
      async () =>
        assert.deepEqual(
          (await status()).blockers.map((blocker: { kind: string; reason: string }) => blocker.reason),
          ["claude not logged in: run `claude auth login`", "Worker pause until resumed", "outside the Run windows"],
        ),
      { timeout: 20_000, interval: 100 },
    );
    // A 🚩 Pronunciation on a Spanish Clip.
    const [concept] = data.db
      .insert(concepts)
      .values({ title: "Threads", summary: "Threads", fitAngles: ["analogy"], sourceId: 1, seq: 0 })
      .returning()
      .all();
    const [clip] = data.db
      .insert(clips)
      .values({
        conceptId: concept.id,
        angle: "analogy",
        language: "es",
        script: JSON.stringify([{ speech: "Un thread comparte la memoria. Fin.", visual: "x" }]),
        caption: "",
        file: join(home, "clips", "1.mp4"),
      })
      .returning()
      .all();
    const [flag] = data.db
      .insert(events)
      .values({ clipId: clip.id, kind: "flag", at: new Date(), reason: "Pronunciation" })
      .returning()
      .all();
    const pronunciation = createPronunciation(data);

    const id = pronunciation.preview(flag.id, { beat: 0, sentence: 0 }, [{ term: "thread", respelling: "zred" }]);

    await vi.waitFor(() => assert.equal(pronunciation.poll(id).status, "done"), { timeout: 20_000, interval: 100 });
    assert.deepEqual(
      (await readFile(spoken, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [{ text: "Un zred comparte la memoria.", language: "es" }],
    );

    // Resumed and inside a Run window, with the daily cap still 0: the cap alone does not hold a preview.
    const configFile = join(home, "config.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    await writeFile(
      configFile,
      JSON.stringify({
        ...config,
        worker: { ...config.worker, paused: false, schedule: { windows: [{ start: "00:00", end: "00:00" }] } },
      }),
    );
    await vi.waitFor(
      async () =>
        assert.deepEqual(
          (await status()).blockers.map((blocker: { kind: string; reason: string }) => blocker.reason),
          ["claude not logged in: run `claude auth login`"],
        ),
      { timeout: 20_000, interval: 100 },
    );
    const capped = pronunciation.preview(flag.id, { beat: 0, sentence: 0 }, []);
    await vi.waitFor(() => assert.equal(pronunciation.poll(capped).status, "done"), {
      timeout: 20_000,
      interval: 100,
    });
    assert.equal(data.db.select().from(clips).all().length, 1);
  } finally {
    server.kill("SIGKILL");
  }
});

test("a preview in a Language no job needs is held by that Language's missing voice, and nothing is spoken", {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const worker = join(dir, "worker.ts");
  const spoken = join(dir, "spoken.jsonl");
  // Fake media whose TTS logs what it says, and a media preflight that finds the es voice missing when asked for es.
  await writeFile(
    worker,
    `import { appendFileSync } from "node:fs";
import { openData } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/data.ts", import.meta.url)))};
import { fakeMedia } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/src/test/fakes.ts", import.meta.url)))};
import { voiceProblem } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/media/src/tools.ts", import.meta.url)))};
import { work } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};
const media = fakeMedia();
await work(openData(), {
  media: {
    ...media,
    speak: (text, out, language) => {
      appendFileSync(${JSON.stringify(spoken)}, JSON.stringify({ text, language }) + "\\n");
      return media.speak(text, out, language);
    },
  },
  checkMedia: async (languages) => {
    const voiceless = languages.filter((language) => language === "es");
    return { problems: voiceless.map(voiceProblem), toolProblems: [], voiceless, interpreters: [] };
  },
});
`,
  );
  const { home, server, status } = await forkServer(worker, {
    config: { worker: { paused: true, language: "pt-BR" } },
  });
  const data = openData(home);
  try {
    await vi.waitFor(
      async () =>
        assert.deepEqual(
          (await status()).blockers.map((blocker: { reason: string }) => blocker.reason),
          ["Worker pause until resumed"],
        ),
      { timeout: 20_000, interval: 100 },
    );
    // A 🚩 Pronunciation on a Spanish Clip, with no es job queued.
    const [concept] = data.db
      .insert(concepts)
      .values({ title: "Threads", summary: "Threads", fitAngles: ["analogy"], sourceId: 1, seq: 0 })
      .returning()
      .all();
    const [clip] = data.db
      .insert(clips)
      .values({
        conceptId: concept.id,
        angle: "analogy",
        language: "es",
        script: JSON.stringify([{ speech: "Un thread comparte la memoria.", visual: "x" }]),
        caption: "",
        file: join(home, "clips", "1.mp4"),
      })
      .returning()
      .all();
    const [flag] = data.db
      .insert(events)
      .values({ clipId: clip.id, kind: "flag", at: new Date(), reason: "Pronunciation" })
      .returning()
      .all();
    const pronunciation = createPronunciation(data);

    const id = pronunciation.preview(flag.id, { beat: 0, sentence: 0 }, [{ term: "thread", respelling: "zred" }]);

    await vi.waitFor(() => assert.equal(pronunciation.poll(id).status, "failed"), { timeout: 20_000, interval: 100 });
    assert.equal(pronunciation.poll(id).error, voiceProblem("es"));
    assert.equal(existsSync(spoken), false);
  } finally {
    server.kill("SIGKILL");
  }
});
