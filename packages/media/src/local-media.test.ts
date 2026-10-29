import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Beat } from "@doomlearn/core/agent";
import { openData } from "@doomlearn/core/data";
import { createLocalMedia, localMedia } from "./local-media.ts";
import { defaultLexicon } from "@doomlearn/core/languages";
import { narrate } from "@doomlearn/core/narration";
import { chapters } from "@doomlearn/core/schema";
import { createSources } from "@doomlearn/core/sources";
import { serverTool } from "./tools.ts";

/**
 * The "what is a thread" script from the voice prototype, as beats.
 */
const THREAD: Beat[] = [
  {
    speech: "Sabe quando o seu app congela enquanto baixa um arquivo? É porque ele está fazendo tudo numa thread só.",
    visual: "frozen app",
  },
  { speech: "Uma thread é uma linha de execução dentro de um processo.", visual: "process box" },
  { speech: "Um processo pode ter várias threads, e todas compartilham a mesma memória.", visual: "shared memory" },
  {
    speech: "Enquanto uma thread espera a resposta de uma API, outra continua desenhando a tela.",
    visual: "two lanes",
  },
  { speech: "A CPU alterna entre elas tão rápido que parece que tudo roda ao mesmo tempo.", visual: "cpu switching" },
  {
    speech:
      "Mas memória compartilhada cobra um preço: se duas threads mexem no mesmo dado juntas, nasce uma race condition.",
    visual: "collision",
  },
  { speech: "Por isso existe o mutex, uma trava que deixa só uma thread entrar por vez.", visual: "lock" },
];

function shownWords(beats: Beat[]) {
  return beats.map((beat) => beat.speech).join(" ");
}

test("a .md and a .txt Source are split into chapters at their headings, titled after the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const home = join(dir, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), "{}");
  await writeFile(join(dir, "threads.md"), "Intro text.\n# Threads\nA thread runs.\n# Locks\nA lock guards.\n");
  await writeFile(join(dir, "notes.txt"), "# Memory\nThe heap grows.\n");
  const data = openData(home);
  const sourcesModule = createSources(data, localMedia);
  const md = await sourcesModule.add(join(dir, "threads.md"));
  const txt = await sourcesModule.add(join(dir, "notes.txt"), { title: "My notes" });

  assert.equal(md.title, "threads");
  assert.equal(txt.title, "My notes");
  const titles = (sourceId: number) =>
    data.db
      .select()
      .from(chapters)
      .where(eq(chapters.sourceId, sourceId))
      .orderBy(chapters.seq)
      .all()
      .map((chapter) => chapter.title);
  assert.deepEqual(titles(md.id), ["threads", "Threads", "Locks"]);
  assert.deepEqual(titles(txt.id), ["Memory"]);
  assert.equal(readFileSync(join(home, "sources", String(md.id), "chapters", "1.txt"), "utf8"), "A thread runs.\n");
});

/**
 * A fake tool process standing in for a tts or align server: it appends each request line to `log` and answers it
 * with `reply`.
 */
function recording(log: string, reply: unknown) {
  const script = `
    const { appendFileSync } = require('node:fs');
    console.log(JSON.stringify({ ready: true, backend: 'fake-cpu' }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      appendFileSync(${JSON.stringify(log)}, line + '\\n');
      console.log(${JSON.stringify(JSON.stringify(reply))});
    });`;
  return [process.execPath, "-e", script];
}

test("each TTS request carries its Language's voice, and each align request its aligner language name", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
    const media = createLocalMedia(
      serverTool("tts", recording(join(dir, "tts"), { durationMs: 1200 })),
      serverTool("align", recording(join(dir, "align"), { words: [] })),
    );

    for (const language of ["pt-BR", "en", "es"] as const) {
      await media.speak("Hi.", join(dir, `${language}.wav`), language);
      await media.align(join(dir, `${language}.wav`), "Hi.", language);
    }
    await media.stop();

    const requests = async (tool: string) =>
      (await readFile(join(dir, tool), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).language);
    assert.deepEqual(await requests("tts"), [
      { checkpoint: "pt-br", languageId: "pt", nfkd: false },
      { checkpoint: "v3", languageId: "en", nfkd: true },
      { checkpoint: "v3", languageId: "es", nfkd: true },
    ]);
    assert.deepEqual(await requests("align"), ["Portuguese", "English", "Spanish"]);
  } finally {
    log.mockRestore();
  }
});

/**
 * Runs the real Chatterbox + Qwen3 aligner runtimes: `DOOMLEARN_REAL_MEDIA=1 pnpm exec vitest run packages/media/src/local-media.test.ts`
 * after `pnpm bootstrap`. Listen to the printed wav to compare it with the prototype's winning clip.
 */
test("the real voice port narrates the thread script with timings for every shown word", {
  skip: !process.env.DOOMLEARN_REAL_MEDIA,
  timeout: 600_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-voice-"));
  const narration = await narrate(
    localMedia,
    THREAD,
    dir,
    JSON.parse(readFileSync(defaultLexicon("pt-BR"), "utf8")),
    "pt-BR",
  );

  assert.ok(existsSync(narration.audio));
  assert.equal(narration.words.map((word) => word.word).join(" "), shownWords(THREAD));
  console.log(`narration: ${narration.audio} (${narration.durationMs} ms)`);
});

/**
 * Runs the real Multilingual V3 voice and aligner: `DOOMLEARN_REAL_MEDIA=1 pnpm exec vitest run
 * packages/media/src/local-media.test.ts` after `pnpm bootstrap`. Listen to the printed wavs.
 */
test("the real voice port speaks and times a short en and a short es sentence through Multilingual V3", {
  skip: !process.env.DOOMLEARN_REAL_MEDIA,
  timeout: 900_000,
}, async () => {
  const sentences = {
    en: "A thread is one line of execution inside a process, and the CPU switches between threads very fast.",
    es: "Un hilo es una línea de ejecución dentro de un proceso, y la CPU alterna entre hilos muy rápido.",
  };
  for (const [language, speech] of Object.entries(sentences) as ["en" | "es", string][]) {
    const dir = await mkdtemp(join(tmpdir(), `doomlearn-voice-${language}-`));
    const narration = await narrate(localMedia, [{ speech, visual: "thread" }], dir, {}, language);

    assert.ok(existsSync(narration.audio));
    assert.equal(narration.words.map((word) => word.word).join(" "), speech);
    console.log(`${language} narration: ${narration.audio} (${narration.durationMs} ms)`);
  }
  await localMedia.stop();
});
