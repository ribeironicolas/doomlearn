import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { useToast } from "./Screen.tsx";
import { Slide, sound } from "./Slide.tsx";
import {
  api,
  type Blocker,
  flush,
  hhmm,
  type Inbox,
  lastGood,
  next,
  queryClient,
  queued,
  SYNC,
  type Slot,
  type Status,
  syncFavorites,
  type Today,
} from "./sync.ts";

/**
 * What the Done screen shows: today's numbers (or the last synced ones), the inbox, presses waiting to sync, and the
 * Blockers that keep new Clips from coming (none known while the Mac is unreachable).
 */
type DoneState = { today: Today | null; fresh: boolean; inbox: Inbox | null; queued: number; blockers: Blocker[] };

/**
 * A small outlined button, as on the Done screen's inbox card.
 */
export const BTN = "rounded-lg border border-line px-2.5 py-1.5 text-[13px]";

/**
 * The inbox's open items: 🚩, not landing, stuck.
 */
export const inboxCount = ({ flags, notLanding, stuck }: Inbox) => flags.length + notLanding.length + stuck.length;

/**
 * The Feed: one Clip per screen, then the Done screen. It stays mounted under every other screen, which pauses it.
 */
export function Feed() {
  const covered = useLocation().pathname !== "/";
  const [slots, setSlots] = useState<Slot[]>([]);
  /** The Clip on screen. */
  const [current, setCurrent] = useState<number>();
  const [done, setDone] = useState<DoneState>();
  const [hint, setHint] = useState(true);
  const [toast, showToast] = useToast();
  const feed = useRef<HTMLElement>(null);
  const end = useRef<HTMLElement>(null);
  const observer = useRef<IntersectionObserver>(null);
  /** Clip ids already on screen. */
  const rendered = useRef(new Set<number>());

  /**
   * Syncs, then appends the Feed's slots not on screen yet. Returns the first new slide, if any.
   */
  const load = async () => {
    const added = (await next()).filter((slot) => !rendered.current.has(slot.clipId));
    for (const slot of added) rendered.current.add(slot.clipId);
    // Rendered now, so the caller can scroll to it.
    if (added.length) flushSync(() => setSlots((shown) => [...shown, ...added]));
    return added.length ? feed.current!.querySelector(`[data-clip="${added[0].clipId}"]`) : null;
  };

  /**
   * Fills the Done screen: today's presses, the buffer, tomorrow's Reviews; or scrolls to Clips made meanwhile.
   */
  const showEnd = async () => {
    // Clips the worker made since the Feed loaded come before the Done screen.
    const added = await load();
    if (added) return added.scrollIntoView({ behavior: "smooth" });
    // The Worker status, fetched once here and never polled, is online only: an old one would give a wrong reason.
    const [today, inbox, status] = await Promise.all([
      lastGood<Today>("/api/today"),
      lastGood<Inbox>("/api/inbox"),
      api<Status>("/api/status").catch(() => ({ blockers: [] as Blocker[] })),
    ]);
    setDone({
      today: today.value,
      fresh: today.fresh,
      inbox: inbox.value,
      queued: queued(),
      blockers: status.blockers,
    });
    if (inbox.value) queryClient.setQueryData(["inbox"], inbox.value);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount; load and showEnd only touch refs and setters.
  useEffect(() => {
    // Plays only the Clip on screen; reaching the Done screen refreshes it.
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (target === end.current) {
            if (isIntersecting) {
              setCurrent(undefined);
              showEnd();
            }
          } else {
            const clipId = Number((target as HTMLElement).dataset.clip);
            setCurrent((on) => (isIntersecting ? clipId : on === clipId ? undefined : on));
          }
        }
      },
      { threshold: 0.6 },
    );
    // Scroll snap would keep the Done screen, the only slide at first, in view; open on the first Clip instead.
    load().then(() => {
      feed.current!.scrollTo({ top: 0 });
      observer.current!.observe(end.current!);
      // The phone keeps its copy of every Favorite from launch on, so they play, download and share with the Mac off.
      syncFavorites();
    });
    addEventListener("online", flush);
    const retry = setInterval(flush, SYNC.retryMs);
    /**
     * The first tap anywhere unmutes for the session; a tap on the video then doesn't also pause it.
     */
    const unmute = (event: MouseEvent) => {
      sound.on = true;
      setHint(false);
      for (const video of document.querySelectorAll("video")) video.muted = false;
      if ((event.target as Element).matches("video")) event.stopPropagation();
    };
    document.addEventListener("click", unmute, { capture: true, once: true });
    return () => {
      observer.current!.disconnect();
      removeEventListener("online", flush);
      clearInterval(retry);
      document.removeEventListener("click", unmute, { capture: true });
    };
  }, []);

  return (
    <>
      <main ref={feed} className="h-dvh snap-y snap-mandatory overflow-y-scroll">
        {slots.map((slot) => (
          <Slide
            key={slot.clipId}
            slot={slot}
            current={slot.clipId === current}
            covered={covered}
            observe={(el) => observer.current!.observe(el)}
            toast={showToast}
          />
        ))}
        <section ref={end} className="flex h-dvh snap-start flex-col justify-center gap-3 p-6">
          {done && <Done {...done} />}
        </section>
      </main>
      {hint && (
        <div className="pointer-events-none fixed top-[45%] left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#000a] px-4 py-2.5 text-sm">
          Tap for sound 🔊
        </div>
      )}
      {toast}
    </>
  );
}

/**
 * "Done for today": today's presses, the buffer, tomorrow's Reviews, why no new Clips are coming, and the inbox; no
 * early Reviews.
 */
function Done({ today, fresh, inbox, queued, blockers }: DoneState) {
  const navigate = useNavigate();
  const lines = [];
  if (today) {
    const { counts, buffer, dueTomorrow } = today;
    lines.push(
      `Today: ✅ ${counts.got_it} · 🤔 ${counts.didnt_get} · ⏭️ ${counts.know} · 🚩 ${counts.flag}`,
      `Generating ${buffer.generating} · buffer ${buffer.ready}/${buffer.target}`,
      `Tomorrow: ${dueTomorrow} Review${dueTomorrow === 1 ? "" : "s"} due.`,
    );
  }
  if (blockers.length) {
    const reasons = blockers.map(({ reason, until }) => (until ? `${reason} until ${hhmm(until)}` : reason));
    lines.push(`No new Clips: ${reasons.join(" · ")}`);
  }
  if (!fresh) lines.push(today ? "Mac unreachable: these numbers are from the last sync." : "Mac unreachable.");
  if (queued) lines.push(`${queued} press${queued === 1 ? "" : "es"} waiting to sync.`);
  lines.push("No early Reviews, on purpose.");
  return (
    <>
      <h2 className="font-bold text-[26px]">Done for today 🌙</h2>
      {lines.map((line) => (
        <p key={line} className="text-muted">
          {line}
        </p>
      ))}
      {inbox && (
        <div className="mb-2.5 rounded-xl border border-line bg-card p-3">
          <b>📥 {inboxCount(inbox)} to look at</b>
          <div className="text-muted text-xs">
            {inbox.flags.length} 🚩 · {inbox.notLanding.length} not landing · {inbox.stuck.length} stuck
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => navigate("/inbox")}>
              Open inbox
            </button>
            <button type="button" className={BTN} onClick={() => navigate("/sources")}>
              Sources
            </button>
          </div>
        </div>
      )}
    </>
  );
}
