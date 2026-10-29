import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { Controls } from "./Controls.tsx";
import type { Toast } from "./Screen.tsx";
import { Globe, TranslateSheet } from "./Translate.tsx";
import { buffered, favorite, flush, isFavorite, type Passage, queryClient, type Slot, send } from "./sync.ts";

/**
 * The Feed's gestures and timings: loops before the end nudge, the delay before a press scrolls on, the long-press hold
 * and how far a finger moves before it's a scroll instead, how far across and how much more across than down a swipe
 * goes, the nudge's peek and when snapping resumes, and the Skipped pass: a scrub forward by more than 0.5 s skips the
 * Pass, and one let go in its first 1 s starts it over.
 */
const UI = {
  nudgeLoops: 3,
  advanceMs: 350,
  longPressMs: 500,
  movePx: 10,
  swipePx: 60,
  swipeRatio: 1.5,
  peekPx: 120,
  peekMs: 450,
  settleMs: 500,
  skipS: 0.5,
  restartS: 1,
};
/**
 * The rail: press kind, emoji, label.
 */
const BUTTONS = [
  ["got_it", "✅", "got it"],
  ["didnt_get", "🤔", "didn’t get it"],
  ["know", "⏭️", "already know"],
  ["flag", "🚩", "wrong"],
] as const;
/**
 * What a 🚩 can say is wrong; every reason hides the Clip.
 */
const REASONS = ["Wrong content", "Pronunciation", "Wrong caption", "Other"];

/**
 * The round icon button at the top: 🔍 📚 📥, a screen's back, the Passage's close.
 */
export const ICON_BTN = "size-10 rounded-full text-[18px]";

/**
 * A round button on a player's rail.
 */
export const RAIL_BTN = "flex size-[52px] flex-col items-center justify-center rounded-full bg-[#0007] text-[24px]";

/**
 * Muted until the first tap, then unmuted for the session.
 */
export const sound = { on: false };

/**
 * A Passage's place in its Source: a page range, or a chapter and section.
 */
export function passagePlace({ source, anchor }: Passage) {
  const [from, to] = anchor.pages ?? [];
  const place = anchor.pages
    ? from === to
      ? `p. ${from}`
      : `pp. ${from}–${to}`
    : [anchor.chapter, anchor.section].filter(Boolean).join(" › ");
  return `${source.title} · ${place}`;
}

/**
 * One Clip's screen: the video, its tag, the button rail and its Passage, with their gestures.
 * It plays only while `current` (on screen) and not `covered` by another screen or its own Passage.
 * Its ⭐ shows "Removed from Favorites · Undo" in the Feed's `toast`.
 */
export function Slide({
  slot,
  current,
  covered,
  observe,
  toast,
}: {
  slot: Slot;
  current: boolean;
  covered: boolean;
  observe: (el: HTMLElement) => void;
  toast: Toast;
}) {
  const el = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [clean, setClean] = useState(false);
  const [nudging, setNudging] = useState(false);
  // The tag's full text shows while `more`; "more" offers it only when two lines cut it short.
  const [more, setMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const tagText = useRef<HTMLSpanElement>(null);
  // The Clip's URL once it's buffered: the video reads it from one source only.
  const [src, setSrc] = useState<string>();
  /**
   * Gesture state that never re-renders: as v1 kept it in closures.
   */
  const gesture = useRef({
    ended: false,
    loops: 0,
    skipped: false,
    longPressed: false,
    pressed: false,
    timer: 0,
    nudgeTimer: 0,
    x0: 0,
    y0: 0,
    tx: 0,
    ty: 0,
  });
  const navigate = useNavigate();
  // The 🚩 sheet, the 🌐 sheet and the Passage are history entries with no URL, so the back gesture closes them.
  const { state } = useLocation();
  const flagging = state?.flag === slot.clipId;
  const translating = state?.translate === slot.clipId;
  const reading = state?.passage === slot.clipId;
  // A Clip the 🌐 sheet plays covers this one.
  const playingOther = translating && !!state?.playing;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only arriving on screen or leaving it resets the Clip.
  useEffect(() => {
    if (current) {
      video.current!.currentTime = 0;
      return;
    }
    gesture.current.loops = 0;
    gesture.current.skipped = false;
    setClean(false);
    setNudging(false);
    setMore(false);
    // A nudge cut short must not pull the Feed back to this Clip, nor leave snapping off.
    clearTimeout(gesture.current.nudgeTimer);
    el.current!.parentElement!.style.scrollSnapType = "";
    if (reading) navigate(-1);
  }, [current]);

  useEffect(() => {
    buffered(slot.url).then(() => setSrc(slot.url));
  }, [slot.url]);

  // A screen, the Passage or a Clip the 🌐 sheet plays over the Clip pauses it where it is; closing them resumes it
  // with its loop count.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a Clip on screen starts once its source arrives.
  useEffect(() => {
    const v = video.current!;
    if (current && !covered && !reading && !playingOther) {
      v.muted = !sound.on;
      v.play().catch(() => {});
    } else v.pause();
  }, [current, covered, reading, playingOther, src]);

  const tag = `${slot.concept.title} · ${slot.source.title} · ${slot.angle.replaceAll("_", " ")}`;
  // Measured while clamped only: open, nothing overflows, and "more" must stay known to close it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text and the clamp are what change the overflow.
  useLayoutEffect(() => {
    if (!more) setTruncated(tagText.current!.scrollHeight > tagText.current!.clientHeight);
  }, [tag, more]);

  /**
   * Peeks at what's below and leaves a bouncing hint, so it's clear this Clip is over.
   */
  const nudge = () => {
    setNudging(true);
    // Peeks 120 px down, then back after 0.45 s, and snaps again once settled.
    const feed = el.current!.parentElement!;
    const top = el.current!.offsetTop;
    feed.style.scrollSnapType = "none";
    feed.scrollTo({ top: top + UI.peekPx, behavior: "smooth" });
    gesture.current.nudgeTimer = window.setTimeout(() => {
      feed.scrollTo({ top, behavior: "smooth" });
      gesture.current.nudgeTimer = window.setTimeout(() => (feed.style.scrollSnapType = ""), UI.settleMs);
    }, UI.peekMs);
  };

  /**
   * Shows or hides this Clip's Passage, which pauses the Clip while it shows.
   */
  const read = (on: boolean) => (on ? navigate("/", { state: { passage: slot.clipId } }) : navigate(-1));

  /**
   * Records a press, then auto-advances after 0.35 s; only the first press on a Clip counts.
   */
  const press = (button: string, flag?: { reason: string; note?: string }) => {
    gesture.current.pressed = true;
    send("/api/press", { clipId: slot.clipId, button, ...flag });
    // A 🚩, or a 🤔 out of Angles, adds an inbox item; offline, the badge catches up later.
    flush().then(() => queryClient.refetchQueries({ queryKey: ["inbox"] }));
    setTimeout(
      () => (el.current!.nextElementSibling as HTMLElement).scrollIntoView({ behavior: "smooth" }),
      UI.advanceMs,
    );
  };

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the Clip's touch gestures; its rail buttons are the controls a keyboard reaches. */}
      <section
        ref={(node) => {
          el.current = node;
          if (node) observe(node);
        }}
        data-clip={slot.clipId}
        className="relative h-dvh snap-start snap-always overflow-hidden bg-black touch-pan-y"
        // Long-press hides the rail and tag for this Clip only; leaving the Clip brings them back.
        onPointerDown={(event) => {
          gesture.current.longPressed = false;
          if ((event.target as Element).closest("button, aside")) return;
          Object.assign(gesture.current, { x0: event.clientX, y0: event.clientY });
          gesture.current.timer = window.setTimeout(() => {
            setClean((on) => !on);
            gesture.current.longPressed = true;
          }, UI.longPressMs);
        }}
        // Moving further than a few pixels is a scroll, not a long-press.
        onPointerMove={(event) => {
          const { x0, y0, timer } = gesture.current;
          if (Math.hypot(event.clientX - x0, event.clientY - y0) > UI.movePx) clearTimeout(timer);
        }}
        onPointerUp={() => clearTimeout(gesture.current.timer)}
        onPointerCancel={() => clearTimeout(gesture.current.timer)}
        onContextMenu={(event) => event.preventDefault()}
        // A sideways swipe, far enough across and clearly more across than down, shows the Passage or goes back.
        onTouchStart={(event) =>
          Object.assign(gesture.current, { tx: event.touches[0].clientX, ty: event.touches[0].clientY })
        }
        onTouchEnd={(event) => {
          const dx = event.changedTouches[0].clientX - gesture.current.tx;
          const dy = event.changedTouches[0].clientY - gesture.current.ty;
          if (Math.abs(dx) > UI.swipePx && Math.abs(dx) > UI.swipeRatio * Math.abs(dy)) read(!reading);
        }}
      >
        <video
          ref={video}
          playsInline
          muted
          preload="metadata"
          src={src}
          className="block h-full w-full select-none object-cover [-webkit-touch-callout:none]"
          // The end counts as an implicit ✅ once, then the Clip loops; after 3 loops, nudge to scroll on. A Skipped pass
          // counts as neither, and the next Pass starts unskipped.
          onEnded={() => {
            if (gesture.current.skipped) gesture.current.skipped = false;
            else {
              if (!gesture.current.ended) send("/api/seen", { clipId: slot.clipId, completed: true });
              gesture.current.ended = true;
              if (++gesture.current.loops === UI.nudgeLoops) nudge();
            }
            video.current!.play().catch(() => {});
          }}
          onClick={() => {
            if (gesture.current.longPressed) return;
            video.current!.paused ? video.current!.play().catch(() => {}) : video.current!.pause();
          }}
        />
        {/* At the bottom left, below the burned-in captions: the cover-fit video fills the height, so its clear strip
            (y > 1700 of 1920) starts 88.5% down. Two lines at most, and clear of the rail on the right. The clamp sits
            on the inner text, not the padded pill, so the pill's padding can't show the top of a third line. Its bottom
            edge sits where a two-line pill starting at 89% ends, open or closed, so open it grows up over the captions;
            on a short screen it stops 48 px above the bottom, clear of the speed chip. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a tap opens and closes the tag; it stays a div so a long-press on it still hides the overlays. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: screen readers get the full text; the clamp is visual only. */}
        <div
          className={`absolute right-[68px] left-3 flex w-fit items-end gap-1 rounded-lg bg-[#0009] px-2 py-1 text-xs transition-opacity duration-200 bottom-[max(calc(11%-2.5rem),calc(env(safe-area-inset-bottom)+48px))] ${clean ? "pointer-events-none opacity-0" : ""}`}
          onClick={() => {
            if (truncated && !gesture.current.longPressed) setMore(!more);
          }}
        >
          <span ref={tagText} className={more ? "" : "line-clamp-2"}>
            <b className="font-semibold text-accent">
              {slot.kind === "review" ? `Review · ${slot.concept.days}d` : "New"}
            </b>{" "}
            · {tag}
          </span>
          {truncated && !more && <b className="shrink-0 font-semibold text-[#ddd]">more</b>}
        </div>
        {/* 38% down, or higher on a short screen: its six buttons (382 px) end above the tag pill, which with its offset
            from the bottom takes up to 118 px. */}
        <div
          className={`absolute top-[min(38%,calc(100%-500px))] right-2 flex flex-col gap-3.5 transition-opacity duration-200 ${clean ? "pointer-events-none opacity-0" : ""}`}
        >
          {BUTTONS.map(([button, emoji, label]) => (
            <button
              key={button}
              type="button"
              data-button={button}
              className={RAIL_BTN}
              onClick={() => {
                if (gesture.current.pressed) return;
                // 🚩 asks its reason first; closing the sheet cancels it.
                if (button === "flag") navigate("/", { state: { flag: slot.clipId } });
                else press(button);
              }}
            >
              {emoji}
              <small className="-mt-0.5 text-[9px] text-[#ddd]">{label}</small>
            </button>
          ))}
          {/* Not presses: they neither scroll on nor count as handled. */}
          <Star clipId={slot.clipId} favorite={slot.favorite} toast={toast} />
          <Globe onClick={() => navigate("/", { state: { translate: slot.clipId } })} />
        </div>
        <Controls
          video={video}
          hidden={clean}
          onScrub={(from, to) => {
            if (to - from > UI.skipS) gesture.current.skipped = true;
            if (to < UI.restartS) gesture.current.skipped = false;
          }}
        />
        <aside
          className={`absolute inset-0 overflow-y-auto bg-[#0b0f17f2] px-5 pt-[calc(56px+env(safe-area-inset-top))] pb-10 transition-transform duration-[250ms] ${reading ? "" : "translate-x-full"}`}
        >
          <button
            type="button"
            className={`absolute top-[calc(8px+env(safe-area-inset-top))] right-2.5 bg-[#0008] ${ICON_BTN}`}
            onClick={() => read(false)}
          >
            ✕
          </button>
          {slot.passages.map((passage) => (
            <div key={`${passage.source.id}-${passage.text}`}>
              <p className="mt-4 mb-1.5 text-[13px] text-accent">{passagePlace(passage)}</p>
              <p className="whitespace-pre-wrap">{passage.text}</p>
            </div>
          ))}
        </aside>
        {nudging && (
          <div className="pointer-events-none absolute bottom-[calc(6%+env(safe-area-inset-bottom))] left-1/2 animate-nudge whitespace-nowrap rounded-full bg-[#000b] px-3.5 py-2 text-[13px] [transform:translateX(-50%)]">
            ↑ That’s the end, swipe up for the next one
          </div>
        )}
      </section>
      {/* Outside the section, so its gestures don't see taps on the sheet. */}
      {flagging && (
        <FlagSheet
          title={slot.concept.title}
          onClose={() => navigate(-1)}
          onFlag={(flag) => {
            navigate(-1);
            press("flag", flag);
          }}
        />
      )}
      {translating && <TranslateSheet clipId={slot.clipId} onClose={() => navigate(-1)} toast={toast} />}
    </>
  );
}

/**
 * A ⭐ on a rail: filled while the Clip is a Favorite. A tap keeps it or lets it go at once, online or not; letting it
 * go offers Undo.
 */
export function Star({ clipId, favorite: initial, toast }: { clipId: number; favorite: boolean; toast: Toast }) {
  const known = isFavorite(clipId, initial);
  const [on, setOn] = useState(known);
  // Shown again, say back in the Feed after a ⭐ on this Clip in another player: that ⭐ wins.
  useEffect(() => setOn(known), [known]);
  /**
   * Keeps the Clip (`keep`) or lets it go.
   */
  const star = (keep: boolean) => {
    favorite(clipId, keep);
    setOn(keep);
    if (!keep) toast("Removed from Favorites", () => star(true));
  };
  return (
    <button type="button" data-button="favorite" aria-pressed={on} className={RAIL_BTN} onClick={() => star(!on)}>
      {on ? "⭐" : "☆"}
      <small className="-mt-0.5 text-[9px] text-[#ddd]">favorite</small>
    </button>
  );
}

/**
 * Asks why a Clip is wrong, as a bottom sheet over everything: a reason and an optional note.
 * Tapping outside it closes it.
 */
export function FlagSheet({
  title,
  onClose,
  onFlag,
}: {
  title: string;
  onClose: () => void;
  onFlag: (flag: { reason: string; note?: string }) => void;
}) {
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState("");
  return createPortal(
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-39 bg-[#0008]" onClick={onClose} />
      <div className="fixed right-0 bottom-0 left-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-[18px] border-line border-t bg-card px-4 pt-[18px] pb-[calc(18px+env(safe-area-inset-bottom))]">
        <h3 className="mb-2.5 font-bold text-[1.17em]">🚩 What’s wrong in “{title}”?</h3>
        {REASONS.map((option) => (
          <button
            key={option}
            type="button"
            className={`mb-2 block w-full rounded-[10px] border p-3 text-left ${option === reason ? "border-accent" : "border-line"}`}
            onClick={() => setReason(option)}
          >
            {option}
          </button>
        ))}
        <textarea
          rows={2}
          placeholder="Optional note, e.g. “cache” came out as “catchê”"
          className="mt-1 mb-2.5 w-full rounded-[10px] border border-line bg-bg p-2.5 text-fg"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          className="w-full rounded-[10px] bg-accent px-4 py-3 font-semibold text-black"
          onClick={() => onFlag({ reason, ...(note.trim() && { note: note.trim() }) })}
        >
          Hide this Clip and log it
        </button>
      </div>
    </>,
    document.body,
  );
}
