import type { ItemAction } from "@doomlearn/core/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { BTN } from "./Feed.tsx";
import { angleName, CLS, Player, Screen, type Toast, UNREACHABLE, useToast } from "./Screen.tsx";
import { POLL_MS } from "./Sources.tsx";
import { api, post, type SourceScreen } from "./sync.ts";

type Chapter = SourceScreen["chapters"][number];
type Concept = Chapter["concepts"][number];

/**
 * How much of a Passage shows until it is tapped open, in characters.
 */
const FOLDED = { chars: 160 };

/**
 * What a ⋯ menu can do to a chapter or a Concept, and how it names it.
 */
const ACTIONS = {
  pause: "⏸ Pause",
  resume: "▶ Resume",
  delete: "🗑 Delete",
  restore: "↩ Restore",
} as const satisfies Record<ItemAction, string>;

/**
 * Each chapter state's chip colour.
 */
const STATE_CHIP: Record<Chapter["state"], string> = {
  waiting: "border-line",
  extracting: "border-line",
  extracted: CLS.ok,
  stuck: CLS.bad,
  paused: CLS.warn,
};

/**
 * Where a Concept is, in words, on a ladder of `steps` steps; `short` leaves a scheduled Concept's date out.
 */
const stateWords = (concept: Concept, steps: number, short = false) => {
  if (concept.status === "new") return "New, not shown yet";
  if (concept.status === "retired") return `Retired: ${concept.retiredReason}`;
  const step = `step ${concept.ladderStep! + 1} of ${steps}`;
  // en-CA formats the local date as YYYY-MM-DD.
  return short ? step : `Next Review ${new Date(concept.dueAt!).toLocaleDateString("en-CA")} (${step})`;
};

/**
 * A Source's chapters in book order, each opening in place to the Concepts it teaches, with their state, Passages and
 * Clips. A Clip plays in Search's player; a 🚩 one is greyed and does not play. Online only, like Sources.
 */
export function Source() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { pathname, state } = useLocation();
  const [toast, showToast] = useToast();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const { data, isError, isFetchedAfterMount, refetch } = useQuery({
    queryKey: ["source", id],
    // null when the Mac has no such Source, which stops the polling. api() in sync.ts words a refusal "<path>: <status>".
    queryFn: () =>
      api<SourceScreen>(`/api/sources/${id}`).catch((error: Error) => {
        if (error.message.endsWith(": 404")) return null;
        throw error;
      }),
    refetchInterval: ({ state: { data } }) => (data === null ? false : POLL_MS),
  });
  // Only this visit's answer, and only while the Mac answers.
  const source = isFetchedAfterMount && !isError ? data : undefined;
  const played: (Concept["clips"][number] & { concept: Concept; steps: number }) | undefined = state?.clip;
  /**
   * Opens chapter `chapterId` if closed, else closes it.
   */
  const toggle = (chapterId: number) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(chapterId)) next.add(chapterId);
      return next;
    });

  return (
    <Screen title={source?.title ?? "Source"}>
      {isError && <p className={CLS.meta}>{UNREACHABLE}</p>}
      {isFetchedAfterMount && data === null && <p className={CLS.meta}>No such Source.</p>}
      {source?.chapters.map((chapter) => (
        <div key={chapter.id} data-chapter={chapter.seq + 1} className={CLS.card}>
          <div className="flex items-start gap-2">
            <button
              type="button"
              aria-expanded={open.has(chapter.id)}
              className={`block flex-1 text-left ${chapter.deleted ? "opacity-50" : ""}`}
              onClick={() => toggle(chapter.id)}
            >
              <b>
                ch. {chapter.seq + 1} {chapter.title}
              </b>
              <span className={`${CLS.chip} ${chapter.deleted ? "border-line" : STATE_CHIP[chapter.state]}`}>
                {chapter.deleted ? "deleted" : chapter.state}
              </span>
              <span className={`block ${CLS.meta}`}>
                {chapter.conceptCount} Concept{chapter.conceptCount === 1 ? "" : "s"}
              </span>
            </button>
            <Menu
              path={`/api/chapters/${chapter.id}`}
              label={`ch. ${chapter.seq + 1}`}
              actions={chapter.deleted ? ["restore"] : [chapter.paused ? "resume" : "pause", "delete"]}
              done={refetch}
              toast={showToast}
            />
          </div>
          {chapter.stuck && (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[13px]">
              <span>✗ {chapter.stuck.lastError}</span>
              <button
                type="button"
                className={BTN}
                onClick={() =>
                  post("/api/retry", { jobId: chapter.stuck!.jobId }).then(
                    () => refetch(),
                    () => showToast("Mac unreachable: try again."),
                  )
                }
              >
                ↻ Retry
              </button>
            </div>
          )}
          {open.has(chapter.id) &&
            chapter.concepts.map((concept) => (
              <ConceptRow
                key={concept.id}
                concept={concept}
                sourceId={source.id}
                steps={source.ladderSteps}
                done={refetch}
                toast={showToast}
                onPlay={(clip) =>
                  navigate(pathname, { state: { clip: { ...clip, concept, steps: source.ladderSteps } } })
                }
              />
            ))}
        </div>
      ))}
      {played && (
        <Player
          clip={played}
          label={stateWords(played.concept, played.steps, true)}
          buttons={played.concept.deleted ? undefined : "search"}
          toast={showToast}
        />
      )}
      {toast}
    </Screen>
  );
}

/**
 * A chapter's or Concept's ⋯ menu: each of `actions` is posted to `path` (`/api/chapters/<id>` or
 * `/api/concepts/<id>`), then `done` runs. A delete asks for no confirmation: it shows "Deleted · Restore" for 5 s.
 */
function Menu({
  path,
  label,
  actions,
  done,
  toast,
}: {
  path: string;
  label: string;
  actions: ItemAction[];
  done: () => void;
  toast: Toast;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Once open it scrolls into view, as a row low on the screen opens it below the fold; a tap anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector("[role=menu]")?.scrollIntoView({ block: "nearest" });
    /**
     * Closes the menu on a tap outside it.
     */
    const close = (event: MouseEvent) => !box.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  /**
   * Posts `action`, then refreshes the screen.
   */
  const act = (action: ItemAction) =>
    post(`${path}/${action}`, {}).then(
      () => {
        done();
        // The Restore stays 5 s, longer than other toasts.
        if (action === "delete") toast("Deleted", () => act("restore"), { label: "Restore", ms: 5000 });
      },
      () => toast("Mac unreachable: try again."),
    );
  if (!actions.length) return null;
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        aria-label={`More for ${label}`}
        aria-expanded={open}
        className={BTN}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-10 mt-1 flex flex-col overflow-hidden rounded-lg border border-line bg-card"
        >
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className="whitespace-nowrap px-3.5 py-2.5 text-left text-[13px]"
              onClick={() => {
                setOpen(false);
                act(action);
              }}
            >
              {ACTIONS[action]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One Concept under a chapter: its title, state, summary, the other chapters teaching it, its Passages in this chapter
 * (each cut short until tapped) and its Clips, or why it has none, and its ⋯ menu. A Retired Concept can be deleted,
 * not paused; a Deleted one is greyed, with Restore when it was deleted by hand, else with the deleted chapters it went
 * with, whose Restore brings it back.
 */
function ConceptRow({
  concept,
  sourceId,
  steps,
  onPlay,
  done,
  toast,
}: {
  concept: Concept;
  sourceId: number;
  steps: number;
  onPlay: (clip: Concept["clips"][number]) => void;
  done: () => void;
  toast: Toast;
}) {
  const [full, setFull] = useState<Set<number>>(new Set());
  let actions: ItemAction[] = ["delete"];
  if (concept.deleted) actions = concept.deletedByHand ? ["restore"] : [];
  else if (concept.status !== "retired") actions = [concept.paused ? "resume" : "pause", "delete"];
  return (
    <div data-concept={concept.id} className="mt-2 border-line border-t pt-2">
      <div className="flex items-start gap-2">
        <div className={`flex-1 ${concept.deleted ? "opacity-50" : ""}`}>
          <b>{concept.title}</b>
          {concept.notLandingAt && <span className={`${CLS.chip} ${CLS.bad}`}>Not landing</span>}
          {concept.paused && !concept.deleted && <span className={`${CLS.chip} ${CLS.warn}`}>Paused</span>}
          {concept.deleted && <span className={`${CLS.chip} border-line`}>Deleted</span>}
          <div className={CLS.meta}>{stateWords(concept, steps)}</div>
          {concept.deletedWith.length > 0 && (
            <div className={CLS.meta}>
              deleted with{" "}
              {concept.deletedWith
                .map(({ source, chapter }) =>
                  [source.id !== sourceId && source.title, `ch. ${chapter.seq + 1} ${chapter.title}`]
                    .filter(Boolean)
                    .join(", "),
                )
                .join("; ")}
            </div>
          )}
        </div>
        <Menu path={`/api/concepts/${concept.id}`} label={concept.title} actions={actions} done={done} toast={toast} />
      </div>
      <div className={concept.deleted ? "opacity-50" : ""}>
        <p className="mt-1 text-[13px]">{concept.summary}</p>
        {concept.alsoIn.length > 0 && (
          <p className={`mt-1 ${CLS.meta}`}>
            also in{" "}
            {concept.alsoIn
              .map(({ source, chapter }) => `${source.title}, ch. ${chapter.seq + 1} ${chapter.title}`)
              .join("; ")}
          </p>
        )}
        {concept.passages.map((passage) => {
          const className = "mt-1.5 block w-full whitespace-pre-wrap rounded-lg bg-bg p-2 text-left text-[13px]";
          if (passage.text.length <= FOLDED.chars)
            return (
              <p key={passage.id} data-passage className={className}>
                {passage.text}
              </p>
            );
          const shown = full.has(passage.id);
          return (
            <button
              key={passage.id}
              type="button"
              data-passage
              aria-expanded={shown}
              className={className}
              onClick={() => setFull((was) => new Set(was).add(passage.id))}
            >
              {shown ? passage.text : `${passage.text.slice(0, FOLDED.chars)}…`}
            </button>
          );
        })}
        <div className={CLS.actions}>
          {concept.clips.length === 0 && (
            <span className={CLS.meta}>{concept.making ? "Clip being made" : "No Clip yet"}</span>
          )}
          {concept.clips.map((clip) => (
            <button
              key={clip.clipId}
              type="button"
              data-clip={clip.clipId}
              className={`${BTN} disabled:opacity-40`}
              disabled={clip.flagged}
              onClick={() => onPlay(clip)}
            >
              {clip.flagged ? "🚩" : "▶"} {angleName(clip.angle)} · {clip.language} ·{" "}
              {clip.flagged ? "flagged" : clip.seen ? "seen" : "unseen"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
