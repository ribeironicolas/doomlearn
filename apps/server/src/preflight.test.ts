import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Language } from "@doomlearn/core/languages";
import { test } from "vitest";
import { preflight } from "./preflight.ts";

/**
 * A data folder, and an mkcert CA root holding `rootCA.pem`, in a fresh temp folder.
 */
async function folders() {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-preflight-"));
  const home = join(dir, "home");
  const caRoot = join(dir, "mkcert");
  await mkdir(home);
  await mkdir(caRoot);
  await writeFile(join(caRoot, "rootCA.pem"), "");
  return { home, caRoot };
}

/**
 * A Mac where every command answers (`mkcert -CAROOT` with `caRoot`), and the commands it was asked to run.
 */
function installed(caRoot: string) {
  const ran: string[] = [];
  const run = async (command: string, args: string[]) => {
    ran.push(command);
    return command === "mkcert" ? `${caRoot}\n` : `${command} ${args.join(" ")}`;
  };
  return { ran, run };
}

/**
 * Where nothing is installed.
 */
const nothing = async () => undefined;

const MAC = { node: "24.18.1", platform: "darwin", arch: "arm64" } as const;

/**
 * Media environments that are ready, on a uv-managed Python 3.12.
 */
const ready = async () => ({
  problems: [],
  toolProblems: [],
  voiceless: [],
  interpreters: ["Python 3.12.15 at /home/learner/.local/share/uv/python/cpython-3.12.15-macos-aarch64-none"],
});

test("on a ready Mac every prerequisite is ✓ and start goes on", async () => {
  const { home, caRoot } = await folders();
  await mkdir(join(home, "tls"));
  await writeFile(join(home, "tls", "cert.pem"), "");
  await writeFile(join(home, "tls", "key.pem"), "");

  const report = await preflight(home, { ...MAC, run: installed(caRoot).run, media: ready });

  assert.deepEqual(report, {
    blocked: false,
    lines: [
      "✓ Node 24.18.1",
      "✓ macOS on Apple Silicon",
      "✓ Calibre",
      "✓ python3",
      "✓ media environments on Python 3.12.15 at /home/learner/.local/share/uv/python/cpython-3.12.15-macos-aarch64-none",
      "✓ mkcert CA",
      "✓ TLS cert",
      "✓ ZeroTier",
      "✓ claude",
    ],
  });
});

test("a miss prints ✗ with its install hint, and start goes on; ZeroTier is only a warning", async () => {
  const { home } = await folders();

  const report = await preflight(home, {
    node: "24.0.0",
    platform: "linux",
    arch: "x64",
    run: nothing,
    media: async () => ({
      problems: ["tts environment outdated: run `pnpm bootstrap`", "align weights missing: run `pnpm bootstrap`"],
      toolProblems: ["tts environment outdated: run `pnpm bootstrap`", "align weights missing: run `pnpm bootstrap`"],
      voiceless: [],
      interpreters: [],
    }),
  });

  assert.deepEqual(report, {
    blocked: false,
    lines: [
      "✓ Node 24.0.0",
      "✗ not macOS on Apple Silicon (linux x64): TTS and alignment run only there, the Feed still serves",
      "✗ Calibre not found, so ebook Sources cannot convert: brew install --cask calibre",
      "✗ python3 not found, so `pnpm bootstrap` cannot install uv: xcode-select --install, or brew install python",
      "✗ tts environment outdated: run `pnpm bootstrap`",
      "✗ align weights missing: run `pnpm bootstrap`",
      "✗ mkcert not found, needed for phone access: brew install mkcert",
      "✗ no TLS cert, so the Feed is on this Mac only: phone access is in docs/OPS.md",
      "⚠ ZeroTier not found, needed for phone access: brew install --cask zerotier-one",
      "✗ claude not found, needed by the stages set to it: brew install --cask claude-code",
    ],
  });
});

test("Node older than 24 blocks start", async () => {
  const { home, caRoot } = await folders();

  const report = await preflight(home, { ...MAC, node: "22.18.0", run: installed(caRoot).run, media: ready });

  assert.equal(report.blocked, true);
  assert.equal(report.lines[0], "✗ Node 22.18.0 is too old, doomlearn needs 24 or later: brew install node");
});

test("a non-loopback host without a cert blocks start, with the mkcert command; the CA not installed does not", async () => {
  const { home } = await folders();
  await writeFile(join(home, "config.json"), JSON.stringify({ server: { hosts: ["127.0.0.1", "10.147.17.5"] } }));
  const emptyCaRoot = await mkdtemp(join(tmpdir(), "doomlearn-ca-"));

  const report = await preflight(home, { ...MAC, run: installed(emptyCaRoot).run, media: ready });

  assert.equal(report.blocked, true);
  const tls = join(home, "tls");
  assert.deepEqual(
    report.lines.filter((line) => line.startsWith("✗")),
    [
      "✗ mkcert CA not installed, needed for phone access: mkcert -install",
      `✗ no TLS cert for 10.147.17.5, so start refuses: mkdir -p ${tls} && mkcert -cert-file ${join(tls, "cert.pem")} -key-file ${join(tls, "key.pem")} localhost 127.0.0.1 10.147.17.5`,
    ],
  );
});

test("codex is checked only when a stage is set to it", async () => {
  const { home, caRoot } = await folders();
  const mac = installed(caRoot);
  await preflight(home, { ...MAC, run: mac.run, media: ready });
  assert.ok(!mac.ran.includes("codex"));

  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ agents: { stages: { script: { provider: "codex", model: "gpt-6-sol", effort: "low" } } } }),
  );
  const report = await preflight(home, { ...MAC, run: nothing, media: ready });

  assert.ok(report.lines.includes("✗ codex not found, needed by the stages set to it: brew install --cask codex"));
  assert.ok(
    report.lines.includes("✗ claude not found, needed by the stages set to it: brew install --cask claude-code"),
  );
});

test("the media check asks for the voice of the Language of new Clips, and a missing one is a ✗ that does not block", async () => {
  const { home, caRoot } = await folders();
  await writeFile(join(home, "config.json"), JSON.stringify({ worker: { language: "en" } }));
  const asked: Language[][] = [];
  const media = async (languages: Language[] = []) => {
    asked.push(languages);
    return {
      problems: ["tts weights for English missing: run `pnpm bootstrap`"],
      toolProblems: [],
      voiceless: ["en" as const],
      interpreters: [],
    };
  };

  const report = await preflight(home, { ...MAC, run: installed(caRoot).run, media });

  assert.deepEqual(asked, [["en"]]);
  assert.ok(report.lines.includes("✗ tts weights for English missing: run `pnpm bootstrap`"));
  assert.equal(report.blocked, false);
});

test("a config.json start would refuse or rewrite is left to start, and the defaults are checked", async () => {
  const { home, caRoot } = await folders();
  // A v1 file: start backs it up and rewrites it; preflight never writes.
  await writeFile(join(home, "config.json"), JSON.stringify({ zerotierIp: "10.147.17.5" }));

  const report = await preflight(home, { ...MAC, run: installed(caRoot).run, media: ready });

  assert.equal(report.blocked, false);
  assert.equal(
    report.lines.at(-1),
    "⚠ config.json not checked here: `pnpm start` validates it, and rewrites a v1 file",
  );
  assert.ok(report.lines.includes("✓ claude"));
});
