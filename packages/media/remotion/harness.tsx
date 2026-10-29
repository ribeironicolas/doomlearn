// The helpers a scene is written against (see api.md), fed by the input props the render passes in.
import React from "react";
import { AbsoluteFill, getInputProps, spring, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import type { Word } from "./pages";

export const FPS = 30;
/**
 * Milliseconds per second: narration times are in ms, frames are counted per second.
 */
export const SECOND_MS = 1000;

/**
 * What the render passes in: the narration audio file (served from the public dir),
 * its decoded duration, its words and each beat's span.
 */
export const CLIP = getInputProps() as {
  audio: string;
  durationMs: number;
  words: Word[];
  beats: { startMs: number; endMs: number }[];
};

/** The frame at `ms` into the narration. */
const frameAt = (ms: number) => Math.round((ms / SECOND_MS) * FPS);
/** `s` lowercased, without punctuation. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();

/**
 * Frame where the nth (1-based) spoken occurrence of `word` starts.
 * Case and punctuation are ignored; a multi-word token matches whole or by any of its words.
 */
export const w = (word: string, n = 1) => {
  const q = norm(word);
  const hits = CLIP.words.filter((x) => norm(x.word) === q || norm(x.word).split(" ").includes(q));
  if (!hits[n - 1])
    throw new Error(`w("${word}", ${n}): the narration has only ${hits.length} occurrence(s) of "${word}"`);
  return frameAt(hits[n - 1].startMs);
};

/** Start frame of each beat, 1-based: BEAT[1] is the first beat. */
export const BEAT: Record<number, number> = Object.fromEntries(
  CLIP.beats.map((beat, i) => [i + 1, frameAt(beat.startMs)]),
);

/**
 * Renders children only for absolute frames [from, to), fading in/out over `fade` frames.
 * Unlike <Sequence>, it does not shift time: frames inside stay absolute.
 */
export const Show: React.FC<{ from: number; to?: number; fade?: number; children: React.ReactNode }> = ({
  from,
  to = Infinity,
  fade = 6,
  children,
}) => {
  const f = useCurrentFrame();
  if (f < from || f >= to) return null;
  const opacity = fade ? Math.min(1, (f - from + 1) / fade, (to - f) / fade) : 1;
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

/** Clean sans font family (Inter 500/700/800). */
export const { fontFamily: FONT } = loadFont("normal", { weights: ["500", "700", "800"], subsets: ["latin"] });

/** Dark background, light text, flat accent colors. */
export const COLOR = {
  bg: "#101828",
  panel: "#1D2939",
  line: "#475467",
  text: "#FFFFFF",
  muted: "#98A2B3",
  blue: "#2E90FA",
  green: "#12B76A",
  red: "#F04438",
  orange: "#F79009",
  purple: "#7A5AF8",
  yellow: "#FDB022",
};

const cued = new Set<number>();

/**
 * 0→1 spring entrance starting at frame `at` (0 before it).
 * Each distinct `at` also logs a pop sound cue, in seconds, which src/render.ts collects from the browser.
 */
export const pop = (frame: number, at: number) => {
  if (!cued.has(at)) {
    cued.add(at);
    console.log(`doomlearn:pop ${at / FPS}`);
  }
  return spring({ frame: frame - at, fps: FPS, config: { damping: 14 } });
};
