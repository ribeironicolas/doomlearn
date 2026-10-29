import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { captionAt, captionPages } from "../remotion/pages.ts";
import { type Narration, SceneError } from "@doomlearn/core/media";
import { REMOTION, render } from "./render.ts";

const FIXTURE = fileURLToPath(new URL("../remotion/fixture/", import.meta.url));
/**
 * The first three beats of the "what is a thread" prototype Clip:
 * their `script`, real narration, its word timings and beat spans; `scene.tsx` next to it is a small scene over them.
 */
const fixture: Omit<Narration, "audio"> = JSON.parse(readFileSync(join(FIXTURE, "narration.json"), "utf8"));

/**
 * Every browser console line of every render, passed through to `render`'s own handler.
 */
const browserLogs = vi.hoisted(() => [] as string[]);
vi.mock("@remotion/renderer", async (importOriginal) => {
  const renderer = await importOriginal<typeof import("@remotion/renderer")>();
  return {
    ...renderer,
    renderMedia: (options: Parameters<typeof renderer.renderMedia>[0]) =>
      renderer.renderMedia({
        ...options,
        onBrowserLog: (log) => {
          browserLogs.push(log.text);
          options.onBrowserLog?.(log);
        },
      }),
  };
});

test("caption pages hold at most 4 words and never cross a sentence end", () => {
  assert.deepEqual(
    captionPages(fixture.words).map((page) => page.tokens.map((token) => token.text.trim())),
    [
      ["Sabe", "quando", "o", "seu"],
      ["app", "congela", "enquanto", "baixa"],
      ["um", "arquivo?"],
      ["É", "porque", "ele", "está"],
      ["fazendo", "tudo", "numa", "thread"],
      ["só."],
      ["Uma", "thread", "é", "uma"],
      ["linha", "de", "execução", "dentro"],
      ["de", "um", "processo."],
    ],
  );
});

test("the active caption word is the last one already spoken, lit through pauses", () => {
  const pages = captionPages(fixture.words);
  const active = (ms: number) => {
    const { page, active } = captionAt(pages, ms)!;
    return page.tokens[active].text.trim();
  };
  // "congela" is spoken 1280–1680 ms.
  assert.equal(active(1500), "congela");
  // The pause after "arquivo?" runs 2880–3760 ms.
  assert.equal(active(3500), "arquivo?");
});

test("a fixture scene renders to a 1080×1920 mp4 as long as its narration, with a pop per pop() at -14 LUFS", {
  timeout: 600_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-render-"));
  const out = join(dir, "clip.mp4");
  const narration = {
    audio: join(FIXTURE, "narration.mp3"),
    durationMs: fixture.durationMs,
    words: fixture.words,
    beats: fixture.beats,
  };
  // The render's own temp dir, so anything it leaves in os.tmpdir() shows up next to `out`.
  vi.stubEnv("TMPDIR", dir);
  await render({ tsx: readFileSync(join(FIXTURE, "scene.tsx"), "utf8"), narration }, out);
  vi.unstubAllEnvs();
  assert.deepEqual(readdirSync(dir).toSorted(), ["clip.mp4", "render"]);
  assert.ok(existsSync(join(dir, "render", "bundle", "index.html")), "no bundle in the work folder");

  const probe = JSON.parse(
    execFileSync(
      REMOTION,
      ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", out],
      {
        encoding: "utf8",
      },
    ),
  );
  const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  assert.deepEqual([video.width, video.height], [1080, 1920]);
  // Within one frame of the decoded narration.
  assert.ok(
    Math.abs(Number(probe.format.duration) * 1000 - fixture.durationMs) < 1000 / 30,
    `duration ${probe.format.duration}`,
  );

  // The scene calls pop() on frames 10, 34, 158 and 264 (twice on 264, which is one entrance).
  const cues = JSON.parse(readFileSync(join(out, "..", "render", "cues.json"), "utf8"));
  assert.deepEqual(
    cues,
    [10, 34, 158, 264].map((frame) => frame / 30),
  );

  // loudnorm prints the integrated loudness as `input_i` in a JSON summary on stderr (the bundled
  // ffmpeg has no ebur128). Its encoders are allowlisted, so the null output needs an explicit pcm codec.
  const { stderr } = spawnSync(
    REMOTION,
    [
      "ffmpeg",
      "-nostats",
      "-i",
      out,
      "-vn",
      "-af",
      "loudnorm=print_format=json",
      "-c:a",
      "pcm_s16le",
      "-f",
      "null",
      "-",
    ],
    {
      encoding: "utf8",
    },
  );
  const lufs = Number(stderr.match(/"input_i" : "(-?[\d.]+)"/)![1]);
  assert.ok(Math.abs(lufs + 14) <= 1, `loudness ${lufs} LUFS`);
});

test("caption text stays right after a page whose words share a start time", { timeout: 600_000 }, async () => {
  const out = join(await mkdtemp(join(tmpdir(), "doomlearn-render-")), "clip.mp4");
  // Logs the caption spans' text on each frame; the scene itself draws no span.
  const tsx = `
    import { useEffect } from "react";
    import { useCurrentFrame } from "remotion";
    export default function Scene() {
      const frame = useCurrentFrame();
      useEffect(() => {
        const text = [...document.querySelectorAll("span")].map((span) => span.textContent).join("");
        console.log("caption " + frame + " " + text);
      });
      return null;
    }`;
  await render({ tsx, narration: { audio: join(FIXTURE, "narration.mp3"), ...fixture } }, out);

  // "o" and "seu" both start at 800 ms on the first page; the second page runs 1120–2400 ms (frames 34–71).
  const captions = new Map(
    browserLogs.flatMap((line) => {
      const [, frame, text] = line.match(/^caption (\d+) (.*)$/s) ?? [];
      return frame ? [[Number(frame), text]] : [];
    }),
  );
  for (let frame = 34; frame <= 71; frame++)
    assert.equal(captions.get(frame), "app congela enquanto baixa", `frame ${frame}`);
});

test("a scene that doesn't compile rejects with a SceneError carrying the bundler's message", {
  timeout: 600_000,
}, async () => {
  const out = join(await mkdtemp(join(tmpdir(), "doomlearn-render-")), "clip.mp4");
  const tsx = "export default function Scene() { return <div>; }";
  await assert.rejects(
    render({ tsx, narration: { audio: join(FIXTURE, "narration.mp3"), ...fixture } }, out),
    (error) => error instanceof SceneError && /Scene\.tsx/.test(error.message),
  );
});

test("a failure outside the scene rejects with an error that isn't a SceneError", async () => {
  const out = join(await mkdtemp(join(tmpdir(), "doomlearn-render-")), "clip.mp4");
  const tsx = readFileSync(join(FIXTURE, "scene.tsx"), "utf8");
  await assert.rejects(
    render({ tsx, narration: { audio: join(FIXTURE, "missing.mp3"), ...fixture } }, out),
    (error) => !(error instanceof SceneError) && /ENOENT/.test(String(error)),
  );
});
