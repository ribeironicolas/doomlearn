import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { Controls } from "./Controls.tsx";
import { FlagSheet, ICON_BTN, RAIL_BTN, Star, sound } from "./Slide.tsx";
import { Globe, TranslateSheet } from "./Translate.tsx";
import { hhmm, post, type Status } from "./sync.ts";

//
// What Search, the inbox, Sources and Settings share: the screen over the Feed, its toast, the Clip player, the
// Worker-status card and v1's classes.
//

/**
 * v1's screen classes: a card, its row of buttons, its muted meta line, a status chip and its colours, and a section
 * heading.
 */
export const CLS = {
  card: "mb-2.5 rounded-xl border border-line bg-card p-3",
  actions: "mt-2.5 flex flex-wrap gap-2",
  meta: "text-muted text-xs",
  chip: "ml-1 inline-block rounded-full border px-2 py-0.5 text-[11px]",
  ok: "border-ok text-ok",
  warn: "border-warn text-warn",
  bad: "border-bad text-bad",
  h2: "mt-5 mb-2 text-[15px] text-muted uppercase tracking-[.04em]",
};

// The other screens take it from here; it lives in sync.ts with the fetch that throws it.
export { UNREACHABLE } from "./sync.ts";

/**
 * How long a toast shows.
 */
const TOAST_MS = 2600;

/**
 * The most Chrome shares in one go: 50 MiB. `navigator.canShare` does not check it.
 */
const SHARE_MAX_BYTES = 52_428_800;

/**
 * An Angle as the screens show it.
 */
export const angleName = (angle: string) => angle.replaceAll("_", " ");

/**
 * A screen over the Feed, which stays mounted and paused under it; ← (or back) closes it.
 */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="fixed inset-0 z-25 overflow-y-auto bg-bg">
      <button
        type="button"
        className={`fixed top-[calc(8px+env(safe-area-inset-top))] left-2.5 z-31 bg-card ${ICON_BTN}`}
        onClick={() => navigate(-1)}
      >
        ←
      </button>
      <div className="mx-auto max-w-[880px] px-4 pt-[calc(56px+env(safe-area-inset-top))] pb-20">
        <h1 className="mb-3 font-bold text-[22px]">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/**
 * A short message at the top for 2.6 s (or `ms`), replacing any still showing, with an Undo (or `label`) when given
 * `undo`. Returns the toast to render and its `show`.
 */
export function useToast() {
  const [shown, setShown] = useState<{ text: string; undo?: () => void; label: string }>();
  const timer = useRef(0);
  /**
   * Shows `message` for `ms`, restarting the timer, with an `undo` button named `label`.
   */
  const show = (message: string, undo?: () => void, { label = "Undo", ms = TOAST_MS } = {}) => {
    clearTimeout(timer.current);
    setShown({ text: message, undo, label });
    timer.current = window.setTimeout(() => setShown(undefined), ms);
  };
  const toast =
    shown &&
    createPortal(
      <div className="fixed top-[calc(60px+env(safe-area-inset-top))] left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl border border-line bg-[#111827f0] px-3.5 py-2.5 text-[13px]">
        {shown.text}
        {shown.undo && (
          <>
            {" · "}
            <button
              type="button"
              className="font-semibold text-accent"
              onClick={() => {
                clearTimeout(timer.current);
                setShown(undefined);
                shown.undo!();
              }}
            >
              {shown.label}
            </button>
          </>
        )}
      </div>,
      document.body,
    );
  return [toast, show] as const;
}

/**
 * A screen's `show` from `useToast`, which its children call.
 */
export type Toast = ReturnType<typeof useToast>[1];

/**
 * The Clip a player plays: a Search hit, a 🚩 or a Favorite. Search hits and Favorites have a Language and a ⭐.
 */
type PlayerClip = {
  clipId: number;
  url: string;
  angle: string;
  language?: string;
  favorite?: boolean;
  concept: { title: string };
};

/**
 * Plays one Clip full-screen, over the screen that opened it, as a history entry with no URL. Nothing it plays is
 * recorded: watching from here never moves the ladder. A tap pauses or resumes it, and it has the Feed's scrub line and
 * speed chip. Its `buttons`: Search's 🤔 (which un-retires a Retired Concept) and 🚩, sent straight to the Mac, then
 * ⭐ and 🌐 (gone once 🚩 hides the Clip); or a Favorite's ⭐, Download and Share. A Clip its 🌐 sheet plays pauses it.
 */
export function Player({
  clip,
  label,
  buttons,
  toast,
}: {
  clip: PlayerClip;
  label: string;
  buttons?: "search" | "favorite";
  toast: Toast;
}) {
  const navigate = useNavigate();
  const { pathname, state } = useLocation();
  const [pressed, setPressed] = useState<"didnt_get" | "flag">();
  const video = useRef<HTMLVideoElement>(null);
  const playingOther = buttons === "search" && !!state?.playing;
  /**
   * Whether a Clip from the 🌐 sheet paused this one, so only its close resumes it; on mount, autoPlay starts it.
   */
  const pausedForOther = useRef(false);
  useEffect(() => {
    if (playingOther) video.current!.pause();
    else if (pausedForOther.current) video.current!.play().catch(() => {});
    pausedForOther.current = playingOther;
  }, [playingOther]);
  /**
   * Records 🤔 or a 🚩 with its reason; offline, nothing is recorded or queued.
   */
  const press = async (button: "didnt_get" | "flag", flag?: { reason: string; note?: string }) => {
    try {
      await post("/api/press", { clipId: clip.clipId, button, clientEventId: crypto.randomUUID(), ...flag });
      setPressed(button);
      toast(flag ? "🚩 Logged; this Clip is hidden." : "🤔 Back to step 0, due tomorrow.");
    } catch {
      toast("Mac unreachable: nothing was recorded.");
    }
  };
  return createPortal(
    <div data-testid="player" className="fixed inset-0 z-30 bg-black">
      <video
        ref={video}
        autoPlay
        loop
        playsInline
        muted={!sound.on}
        src={clip.url}
        className="block h-full w-full object-cover"
        onClick={() => (video.current!.paused ? video.current!.play().catch(() => {}) : video.current!.pause())}
      />
      <Controls video={video} />
      <button
        type="button"
        className={`fixed top-[calc(8px+env(safe-area-inset-top))] left-2.5 z-31 bg-card ${ICON_BTN}`}
        onClick={() => navigate(-1)}
      >
        ←
      </button>
      <div className="absolute top-[calc(56px+env(safe-area-inset-top))] right-3 left-3 w-fit rounded-full bg-[#0009] px-2 py-1 text-xs">
        <b className="font-semibold text-accent">{label}</b> · {clip.concept.title} · {angleName(clip.angle)}
      </div>
      {buttons && (
        <div className="absolute top-[38%] right-2 flex flex-col gap-3.5">
          {buttons === "search" && !pressed && (
            <>
              <button type="button" className={RAIL_BTN} onClick={() => press("didnt_get")}>
                🤔<small className="-mt-0.5 text-[9px] text-[#ddd]">didn’t get it</small>
              </button>
              <button
                type="button"
                className={RAIL_BTN}
                // The reasons sheet is a history entry too: back closes it and keeps the player.
                onClick={() => navigate(pathname, { state: { ...state, flagging: true } })}
              >
                🚩<small className="-mt-0.5 text-[9px] text-[#ddd]">wrong</small>
              </button>
            </>
          )}
          <Star clipId={clip.clipId} favorite={!!clip.favorite} toast={toast} />
          {buttons === "search" && pressed !== "flag" && (
            <Globe onClick={() => navigate(pathname, { state: { ...state, translating: true } })} />
          )}
          {buttons === "favorite" && <DownloadShare clip={clip} toast={toast} />}
        </div>
      )}
      {buttons === "search" && state?.translating && (
        <TranslateSheet clipId={clip.clipId} onClose={() => navigate(-1)} toast={toast} />
      )}
      {state?.flagging && (
        <FlagSheet
          title={clip.concept.title}
          onClose={() => navigate(-1)}
          onFlag={(flag) => {
            navigate(-1);
            press("flag", flag);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/**
 * A Favorite's Download and Share. The file is read when the player opens, from the phone's cache (else the Mac), so a
 * tap shares it within the tap's user activation and both work with the Mac off. It is the stored Clip, unchanged,
 * named `<concept-title-slug>-<angle>-<language>.mp4`. Share is left out where the browser can't share a file.
 */
function DownloadShare({ clip, toast }: { clip: PlayerClip; toast: Toast }) {
  const [file, setFile] = useState<{ file: File; href: string }>();
  const [failed, setFailed] = useState(false);
  const slug = clip.concept.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const name = `${slug}-${clip.angle}-${clip.language}.mp4`;
  useEffect(() => {
    let href = "";
    let cancelled = false;
    (async () => {
      const res = (await caches.match(clip.url).catch(() => undefined)) ?? (await fetch(clip.url));
      if (!res.ok) return setFailed(true);
      const read = new File([await res.blob()], name, { type: "video/mp4" });
      // The player closed while reading: no URL, so nothing is left unrevoked.
      if (cancelled) return;
      href = URL.createObjectURL(read);
      setFile({ file: read, href });
    })().catch(() => {
      // Not on the phone and the Mac unreachable: Download falls back to the URL, and Share says so.
      setFailed(true);
    });
    return () => {
      cancelled = true;
      URL.revokeObjectURL(href);
    };
  }, [clip.url, name]);
  const canShare = useMemo(
    () => navigator.canShare?.({ files: [new File([], name, { type: "video/mp4" })] }) ?? false,
    [name],
  );
  /**
   * Opens the share sheet with the mp4 alone. A cancel is silent, and so is a tap while the file is still being read.
   */
  const share = async () => {
    if (!file) {
      if (failed) toast("Mac unreachable: this Clip isn’t on the phone.");
      return;
    }
    if (file.file.size > SHARE_MAX_BYTES) return toast("Over 50 MiB: too large to share.");
    try {
      await navigator.share({ files: [file.file] });
    } catch (error) {
      if ((error as Error).name !== "AbortError") toast(`Share failed: ${(error as Error).message}`);
    }
  };
  return (
    <>
      <a href={file?.href ?? clip.url} download={name} className={RAIL_BTN}>
        ⬇️<small className="-mt-0.5 text-[9px] text-[#ddd]">download</small>
      </a>
      {canShare && (
        <button type="button" className={RAIL_BTN} onClick={share}>
          📤<small className="-mt-0.5 text-[9px] text-[#ddd]">share</small>
        </button>
      )}
    </>
  );
}

/**
 * The Worker status: running (on which stage, since when), idle, stopping or stopped, and every active Blocker with
 * its reason and until-time.
 */
export function WorkerCard({ status }: { status: Status }) {
  const { state, job, restarts, blockers } = status;
  // A Blocker turns an up worker's chip amber.
  const color = { running: CLS.ok, idle: CLS.ok, stopping: CLS.warn, stopped: CLS.bad }[state];
  const chip = blockers.length && color === CLS.ok ? CLS.warn : color;
  return (
    <div data-testid="worker-status" className={CLS.card}>
      <b>Worker {state}</b>
      {job && (
        <span>
          : {job.stage} · {job.source ?? job.kind}
          {job.since && ` since ${hhmm(job.since)}`}
        </span>
      )}
      <span className={`${CLS.chip} ${chip}`}>{blockers.length ? `${blockers.length} blocked` : "ok"}</span>
      {blockers.map((blocker) => (
        <div key={blocker.kind + blocker.reason} className="mt-1.5 text-[13px]">
          ⏸ {blocker.reason}
          {blocker.until && ` until ${hhmm(blocker.until)}`}
        </div>
      ))}
      {restarts > 0 && <div className={CLS.meta}>Restarted {restarts}× in the last hour.</div>}
    </div>
  );
}
