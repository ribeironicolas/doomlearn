import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { encodeWav, renderSoundtrack } from "../vendor/explainroo/audio/soundtrack.js";
import { type Narration, SceneError } from "@doomlearn/core/media";

/**
 * The `remotion` CLI, whose bundled ffmpeg and ffprobe (the 7.1 line) stand in for system ones: `remotion ffmpeg …`.
 */
export const REMOTION = fileURLToPath(new URL("../node_modules/.bin/remotion", import.meta.url));

/**
 * Milliseconds per second: the narration is timed in ms, the soundtrack and ffmpeg in seconds.
 */
const SECOND_MS = 1000;

/**
 * Renders a scene through the Remotion harness in `remotion/` (narration audio and captions on top),
 * then mixes in music ducked under the voice and a pop per `pop()` entrance, normalized to -14 LUFS.
 * Work files, Remotion's bundle included, stay in a `render` folder next to `out`. Throws `SceneError` when the scene
 * doesn't compile or render; any other step's error propagates unchanged.
 */
export async function render({ tsx, narration }: { tsx: string; narration: Narration }, out: string) {
  const dir = join(dirname(out), "render");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  const harness = fileURLToPath(new URL("../remotion/", import.meta.url));
  for (const file of ["index.ts", "Root.tsx", "Captions.tsx", "harness.tsx", "pages.ts"])
    copyFileSync(join(harness, file), join(dir, file));
  writeFileSync(join(dir, "Scene.tsx"), tsx);
  copyFileSync(narration.audio, join(dir, "public", basename(narration.audio)));

  const inputProps = {
    audio: basename(narration.audio),
    durationMs: narration.durationMs,
    words: narration.words,
    // Each beat's span comes from the narration, which already knows which Words each beat says.
    beats: narration.beats,
  };
  const cues = new Set<number>();
  // The scene's code runs only in these three Remotion steps, so only their errors are the scene's.
  try {
    const serveUrl = await bundle({
      entryPoint: join(dir, "index.ts"),
      publicDir: join(dir, "public"),
      // Without it Remotion makes a bundle folder in os.tmpdir() and never removes it.
      outDir: join(dir, "bundle"),
      // The job folder is outside the workspace, so packages resolve from this package's own node_modules
      // (pnpm links direct deps there; webpack follows the symlinks for transitive ones).
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: ["node_modules", fileURLToPath(new URL("../node_modules", import.meta.url))],
        },
      }),
    });
    const composition = await selectComposition({ serveUrl, id: "Clip", inputProps });
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      colorSpace: "bt709",
      logLevel: "warn",
      outputLocation: join(dir, "video.mp4"),
      // `pop()` in remotion/harness.tsx logs each entrance, in seconds.
      onBrowserLog: ({ text }) => {
        const at = text.match(/^doomlearn:pop (\S+)$/)?.[1];
        if (at) cues.add(Number(at));
      },
    });
  } catch (error) {
    throw new SceneError((error as Error).message, { cause: error });
  }
  const pops = [...cues].sort((a, b) => a - b);
  writeFileSync(join(dir, "cues.json"), JSON.stringify(pops));

  const sound = await renderSoundtrack({
    duration: narration.durationMs / SECOND_MS,
    voiceSpans: narration.beats.map((span) => ({ start: span.startMs / SECOND_MS, end: span.endMs / SECOND_MS })),
    music: { style: "warm", volume: 0.2 },
    sfx: pops.map((t) => ({ name: "pop", t })),
  });
  writeFileSync(join(dir, "sound.wav"), Buffer.from(encodeWav(sound)));
  // `-c:a aac` is ffmpeg's native encoder; the bundled build also has libfdk_aac, used only when asked for by name.
  execFileSync(REMOTION, [
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-i",
    join(dir, "video.mp4"),
    "-i",
    join(dir, "sound.wav"),
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1[a]",
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    // loudnorm pads its output, so trim back to the narration.
    "-t",
    String(narration.durationMs / SECOND_MS),
    out,
  ]);
}
