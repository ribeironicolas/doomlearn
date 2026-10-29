import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { contractFiles } from "./contracts.ts";
import { oneShotTool, serverTool, voicelessLanguages } from "./tools.ts";

/**
 * A fake tool process: a Node script standing in for `<venv>/bin/python server.py`, printing `lines` in order,
 * each after reading one stdin line except the first (its ready line).
 */
function fake(...lines: string[]) {
  const script = `
    const lines = ${JSON.stringify(lines)};
    console.log(lines.shift());
    require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
      if (lines.length) console.log(lines.shift());
      else process.exit(0);
    });`;
  return [process.execPath, "-e", script];
}

const READY = JSON.stringify({ ready: true, backend: "fake-cpu" });

/**
 * The pt-BR voice, as a TTS request names it.
 */
const PT_BR = { checkpoint: "pt-br", languageId: "pt", nfkd: false } as const;

test("a tts reply missing a contract field fails at the boundary, naming the field", async () => {
  const tts = serverTool("tts", fake(READY, JSON.stringify({ duration_ms: 1200 })));

  await assert.rejects(tts({ text: "Olá.", out: "/tmp/a.wav", language: PT_BR }), /^Error: tts reply: durationMs: /);
});

test("a server tool answers after its ready line, and the backend speaking is logged", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const align = serverTool("align", fake(READY, JSON.stringify({ words: [{ word: "Olá", startMs: 0, endMs: 420 }] })));

  assert.deepEqual(await align({ audio: "/tmp/a.wav", text: "Olá", language: "Portuguese" }), {
    words: [{ word: "Olá", startMs: 0, endMs: 420 }],
  });
  assert.deepEqual(log.mock.calls, [["align: fake-cpu ready"]]);
  log.mockRestore();
});

test("a model that fails to load is reported as a load failure, not as a reply", async () => {
  const tts = serverTool("tts", fake(JSON.stringify({ error: "RuntimeError('MPS backend out of memory')" })));

  await assert.rejects(tts({ text: "Olá.", out: "/tmp/a.wav", language: PT_BR }), {
    message: "tts failed to load: RuntimeError('MPS backend out of memory')",
  });
});

test("a tool that exits before its ready line is reported as a load failure", async () => {
  const tts = serverTool("tts", [process.execPath, "-e", "process.exit(1)"]);

  await assert.rejects(
    tts({ text: "Olá.", out: "/tmp/a.wav", language: PT_BR }),
    /^Error: tts failed to load: it exited/,
  );
});

test("a failure line in reply to a request rejects that request with its error", async () => {
  const tts = serverTool("tts", fake(READY, JSON.stringify({ error: "KeyError('out')" })));

  await assert.rejects(tts({ text: "Olá.", out: "/tmp/a.wav", language: PT_BR }), {
    message: "tts reply: KeyError('out')",
  });
});

test("a stopped server tool has exited, and the next request starts a fresh runtime", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Replies to every request with its own pid as the one word, and exits 200 ms after its stdin closes.
  const script = `
    console.log(${JSON.stringify(READY)});
    require('node:readline').createInterface({ input: process.stdin }).on('line', () =>
      console.log(JSON.stringify({ words: [{ word: String(process.pid), startMs: 0, endMs: 1 }] })));
    process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));`;
  const align = serverTool("align", [process.execPath, "-e", script]);
  const pid = async () =>
    Number((await align({ audio: "/tmp/a.wav", text: "Olá", language: "Portuguese" })).words[0].word);

  const first = await pid();
  await align.stop();
  assert.throws(() => process.kill(first, 0), { code: "ESRCH" });
  const second = await pid();
  assert.notEqual(second, first);
  await align.stop();
  vi.restoreAllMocks();
});

test("stopping a server tool that never started does nothing", async () => {
  await serverTool("tts", [process.execPath, "-e", "process.exit(1)"]).stop();
});

test("a convert document missing a contract field fails at the boundary, naming the field", async () => {
  const document = JSON.stringify({ title: null, toc: [], pages: ["# Threads"] });

  await assert.rejects(
    oneShotTool("convert", ["book.pdf"], [process.execPath, "-e", `console.log(${JSON.stringify(document)})`]),
    /^Error: convert reply: textless: /,
  );
});

test("the JSON Schema contract files match the Zod contracts (regenerate: pnpm --filter @doomlearn/media contracts)", () => {
  for (const [name, text] of Object.entries(contractFiles()))
    assert.equal(readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8"), text, `${name} is stale`);
});

test("the Languages whose voice's weights are missing are named; pt-BR needs no V3 check", async () => {
  const log = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "checks");
  // Stands in for `weights.py`: logs its arguments, then fails its check when the weights are `missing`.
  const weights = (missing: boolean) => [
    process.execPath,
    "-e",
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(1).join(" ") + "\\n"); process.exit(${missing ? 1 : 0})`,
    "--",
  ];

  assert.deepEqual(await voicelessLanguages(["pt-BR"], weights(true)), []);
  assert.equal(existsSync(log), false);
  assert.deepEqual(await voicelessLanguages(["en", "es", "pt-BR"], weights(true)), ["en", "es"]);
  assert.deepEqual(await voicelessLanguages(["en", "es"], weights(false)), []);
  // One check per voice: en and es share V3.
  assert.equal(readFileSync(log, "utf8"), "--check v3\n--check v3\n");
});
