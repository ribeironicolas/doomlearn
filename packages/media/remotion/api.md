# Scene: Remotion 4 (clean motion graphics)

You write ONE TypeScript React file: the visual layer of a Clip, a vertical narrated explainer video the Learner watches in a phone feed. The harness renders it with Remotion 4 (React 19) at 1080×1920, 30 fps, for as long as the narration, and adds the narration audio, the word captions and the sound on top. **Do not draw captions or subtitles.** Return the whole file as `tsx`.

The input gives the beats (what is said and what to show) and the word timings of the narration. On-screen text is {{language}}, with technical terms kept in English. A beat word written `{shown|spoken}` is one word in the timings, spelled as `shown`.

If the input has `fix`, your previous scene failed to compile or render: `fix.tsx` is that file and `fix.error` the error. Return the corrected complete file.

## File shape
- `export default function Scene()` returning an `<AbsoluteFill>` that paints the full background (`COLOR.bg`).
- Imports allowed: `react`, `remotion`, `./harness`. Nothing else: no other packages, files, images, fonts or network.
- Draw with plain React: absolutely positioned `<div>`s (CSS borders, radii, gradients) and inline `<svg>`.

## Remotion rules
- Every animation derives from `useCurrentFrame()` (absolute frame) through `interpolate`, `spring`, `Easing` or the helpers. No CSS transitions/animations, no `Date`, no `Math.random()`, no timers, no state.
- Pass `{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}` to `interpolate` unless you want overshoot.
- Never use `<Sequence>` or `<Series>`: they shift time and every frame here is absolute. Use `<Show>`.
- Coordinates are absolute px on the 1080×1920 canvas.

## Layout
- Visuals inside the safe area: x 60–1020, y 160–1360, centred on x 540.
- Keep clear: the caption band y 1380–1650 and the bottom y > 1700.
- Labels are at least 48 px.
- Never put text over a filled shape: labels sit beside or below shapes, on the background.
- No emoji, anywhere.
- Nothing moves over text: keep moving elements on paths that never cross a label.

## `./harness`
- `w(word, n = 1)`: frame where the nth spoken occurrence of `word` starts. Case and punctuation are ignored, and a multi-word token matches whole or by any of its words: `w('memory')`, `w('thread', 2)`, `w('race condition')`. It throws if that occurrence doesn't exist, so count occurrences in the word timings.
- `BEAT[n]`: start frame of beat n, 1-based (`BEAT[1]` is the first beat).
- `<Show from={a} to={b} fade={6}>…</Show>` renders its children only for frames [a, b), fading in and out over `fade` frames. Leave out `to` to keep them until the end. Time is not shifted. Typically one `<Show>` per beat from `BEAT[n]` to `BEAT[n + 1]` (beat 1 from 0, the last beat with no `to`).
- `pop(frame, at)`: a 0→1 spring starting at frame `at` (0 before it). Use it for scale, opacity and slide-in entrances. Each `pop()` also plays a pop sound at `at`, so use it for entrances only.
- `FPS`: 30.
- `FONT`: Inter font family (weights 500, 700, 800).
- `COLOR`: `bg, panel, line, text, muted, blue, green, red, orange, purple, yellow` (dark background, light text, flat accents).

## Style
Clean flat motion graphics: dark background, bold rounded shapes, flat colors, labels of 1–3 words, one idea on screen at a time. Every element enters with a spring on the word that names it (`pop(frame, w('…'))`). Keep something moving during long beats.

## Example
```tsx
import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {w, BEAT, Show, pop, FONT, COLOR} from './harness';

export default function Scene() {
  const frame = useCurrentFrame();
  const box = pop(frame, w('process'));
  const line = interpolate(frame, [w('thread', 2), w('thread', 2) + 15], [0, 640], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: COLOR.bg, fontFamily: FONT}}>
      <Show from={BEAT[3]} to={BEAT[4]}>
        <div style={{position: 'absolute', left: 140, top: 400, width: 800, height: 600, borderRadius: 40, background: COLOR.panel, transform: `scale(${box})`}} />
        <div style={{position: 'absolute', left: 140, top: 1060, width: 800, textAlign: 'center', color: COLOR.text, fontSize: 72, fontWeight: 800, opacity: box}}>process</div>
        <div style={{position: 'absolute', left: 200, top: 690, width: line, height: 16, borderRadius: 8, background: COLOR.green}} />
      </Show>
    </AbsoluteFill>
  );
}
```
