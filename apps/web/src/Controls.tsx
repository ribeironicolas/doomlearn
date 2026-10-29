import { type PointerEvent, type RefObject, useEffect, useReducer, useState } from "react";

/**
 * The speeds the chip cycles through, the localStorage key that keeps the chosen one on this phone, and how far short
 * of the end a scrub stops, so a drag never ends a Pass by itself.
 */
// biome-ignore lint/style/noMagicNumbers: PLAYBACK is the named constant; the rule only exempts direct property values.
const PLAYBACK = { speeds: [1, 1.25, 1.5, 2], speedKey: "speed", endGapS: 0.1 };

/**
 * The speed every Clip plays at. 1x when storage holds none or can't be read.
 */
let speed = (() => {
  try {
    const saved = Number(localStorage.getItem(PLAYBACK.speedKey));
    return PLAYBACK.speeds.includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
})();

/**
 * Plays `v` at the chosen speed: loading a source resets the rate to the default, and each Clip has its own video.
 */
const apply = (v: HTMLVideoElement) => {
  v.defaultPlaybackRate = speed;
  v.playbackRate = speed;
};

/**
 * A time as m:ss.
 */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * A player's controls over its `video`: the thin scrub line at the bottom edge, the elapsed / total label while
 * dragging, and the speed chip while paused. `hidden` hides them with the overlays. `onScrub` gets the time a drag
 * started from and the time it let go at.
 */
export function Controls({
  video,
  hidden = false,
  onScrub,
}: {
  video: RefObject<HTMLVideoElement | null>;
  hidden?: boolean;
  onScrub?: (from: number, to: number) => void;
}) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  // The time the drag started from and whether the Clip was playing then; null when no drag is on.
  const [drag, setDrag] = useState<{ from: number; playing: boolean } | null>(null);

  useEffect(() => {
    const v = video.current!;
    /**
     * Applies the chosen speed on each play.
     */
    const play = () => apply(v);
    const redraw = ["timeupdate", "play", "pause", "ratechange", "durationchange", "seeked"];
    // Also now: an autoplaying video can start before this effect runs.
    play();
    v.addEventListener("play", play);
    for (const type of redraw) v.addEventListener(type, render);
    return () => {
      v.removeEventListener("play", play);
      for (const type of redraw) v.removeEventListener(type, render);
    };
  }, [video]);

  /**
   * Seeks to the finger's place on the line, short of the end.
   */
  const seek = (event: PointerEvent<HTMLElement>) => {
    const v = video.current!;
    const { left, width } = event.currentTarget.getBoundingClientRect();
    const at = Math.min(Math.max((event.clientX - left) / width, 0), 1);
    v.currentTime = Math.min(at * v.duration, v.duration - PLAYBACK.endGapS);
  };

  /**
   * Ends a drag: reports it and resumes the Clip if it was playing when the drag started.
   */
  const release = () => {
    if (!drag) return;
    const v = video.current!;
    onScrub?.(drag.from, v.currentTime);
    if (drag.playing) v.play().catch(() => {});
    setDrag(null);
  };

  const v = video.current;
  const [elapsed, total] = [v?.currentTime ?? 0, v?.duration || 0];
  const fade = `transition-opacity duration-200 ${hidden ? "pointer-events-none opacity-0" : ""}`;
  return (
    <>
      {/* About 24 px above the gesture bar. Its touches and presses stop here, so a scrub never opens the Passage
          nor starts the long-press, and touch-none keeps the Feed from scrolling under the finger. */}
      <div
        data-scrub
        className={`absolute right-0 bottom-[env(safe-area-inset-bottom)] left-0 h-6 touch-none ${fade}`}
        onTouchStart={(event) => event.stopPropagation()}
        onTouchEnd={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          const v = video.current!;
          if (!v.duration) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ from: v.currentTime, playing: !v.paused });
          v.pause();
          seek(event);
        }}
        onPointerMove={(event) => drag && seek(event)}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-[#fff4]">
          <div
            className="h-full origin-left bg-accent"
            style={{ transform: `scaleX(${total ? elapsed / total : 0})` }}
          />
        </div>
      </div>
      {drag && (
        <div className="pointer-events-none absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+28px)] rounded-full bg-[#0009] px-2 py-0.5 text-xs tabular-nums">
          {clock(elapsed)} / {clock(total)}
        </div>
      )}
      {/* Bottom left, just above the line's hit area and under the tag pill (which ends about 46 px above the line on the
          Pixel 4 app, open or closed): the one strip clear of the captions and the rail. A tap changes the
          speed and leaves the Clip paused. */}
      {v?.paused && !drag && (
        <button
          type="button"
          className={`absolute bottom-[calc(env(safe-area-inset-bottom)+24px)] left-3 rounded-full bg-[#0009] px-2.5 py-0.5 font-semibold text-xs ${fade}`}
          onClick={() => {
            speed = PLAYBACK.speeds[(PLAYBACK.speeds.indexOf(speed) + 1) % PLAYBACK.speeds.length];
            apply(v);
            try {
              localStorage.setItem(PLAYBACK.speedKey, String(speed));
            } catch {
              // Not kept on this phone; this session still plays at it.
            }
          }}
        >
          {speed}x
        </button>
      )}
    </>
  );
}
