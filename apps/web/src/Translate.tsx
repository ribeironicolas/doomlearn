import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { BTN } from "./Feed.tsx";
import { CLS, Player, type Toast } from "./Screen.tsx";
import { RAIL_BTN } from "./Slide.tsx";
import { api, hhmm, orRefusal, type Translations, UNREACHABLE } from "./sync.ts";

/**
 * One Language's row of the 🌐 sheet.
 */
type Row = Translations["languages"][number];

/**
 * How often the sheet asks again while a Translation is queued or running.
 */
const POLL_MS = 3000;

/**
 * The 🌐 on a rail. Its sheet is a history entry with no URL, so back closes it.
 */
export function Globe({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" data-button="translate" className={RAIL_BTN} onClick={onClick}>
      🌐<small className="-mt-0.5 text-[9px] text-[#ddd]">language</small>
    </button>
  );
}

/**
 * The 🌐 sheet of a Clip, as a bottom sheet over everything: every Language but the Clip's own, each with "Make in
 * <Language>", greyed "Already in <Language>" with ▶ Play once its Clip is made, or what its Translation is waiting
 * for. ▶ Play opens that Clip in a player, as a history entry with no URL. Tapping outside the sheet closes it.
 */
export function TranslateSheet({ clipId, onClose, toast }: { clipId: number; onClose: () => void; toast: Toast }) {
  const navigate = useNavigate();
  const { pathname, state } = useLocation();
  const {
    data: sheet,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["translations", clipId],
    queryFn: () => api<Translations>(`/api/translations?clipId=${clipId}`),
    refetchInterval: ({ state: { data } }) =>
      data?.languages.some((row) => row.job?.status === "queued" || row.job?.status === "running") ? POLL_MS : false,
  });
  const playing: Row | undefined = state?.playing;
  if (playing?.made && sheet)
    return <Player clip={{ ...playing.made, concept: sheet.concept }} label={playing.name} toast={toast} />;

  /**
   * Queues the Translation into `row`'s Language; one already queued, from another tab say, is not queued again.
   */
  const make = async (row: Row) => {
    try {
      const { queued } = await (await orRefusal("/api/translate", { clipId, language: row.language })).json();
      toast(`${queued ? "Queued" : "Already queued"}: ${row.name} translation of ${sheet!.concept.title}`);
    } catch (error) {
      toast((error as Error).message);
    }
    refetch();
  };

  /**
   * What `row`'s Translation is doing, or null when there is none.
   */
  const waiting = ({ name, job, capped, blocker }: Row) => {
    if (!job) return null;
    if (job.status === "stuck") return "Stuck: ↻ Retry it from the Inbox";
    if (job.status === "queued" && capped) return "Waiting for tomorrow: daily Clip cap";
    if (job.status === "queued" && blocker)
      return blocker.until ? `${blocker.reason} until ${hhmm(blocker.until)}` : blocker.reason;
    return `Making in ${name}…`;
  };

  return createPortal(
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-39 bg-[#0008]" onClick={onClose} />
      <div
        data-testid="translate-sheet"
        className="fixed right-0 bottom-0 left-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-[18px] border-line border-t bg-card px-4 pt-[18px] pb-[calc(18px+env(safe-area-inset-bottom))]"
      >
        <h3 className="mb-2.5 font-bold text-[1.17em]">🌐 Make “{sheet?.concept.title ?? "…"}” in another Language</h3>
        {isError && !sheet && <p className={CLS.meta}>{UNREACHABLE}</p>}
        {sheet?.languages.map((row) => {
          const wait = waiting(row);
          return (
            <div key={row.language} data-language={row.language} className={CLS.card}>
              {row.made ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted">Already in {row.name}</span>
                  <button
                    type="button"
                    className={BTN}
                    onClick={() => navigate(pathname, { state: { ...state, playing: row } })}
                  >
                    ▶ Play
                  </button>
                </div>
              ) : wait ? (
                <p className="text-[13px]">
                  <b>{row.name}</b> · {wait}
                </p>
              ) : (
                <button
                  type="button"
                  className="w-full rounded-[10px] bg-accent px-4 py-3 font-semibold text-black"
                  onClick={() => make(row)}
                >
                  Make in {row.name}
                  <small className="block font-normal text-[11px]">about 5 minutes</small>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>,
    document.body,
  );
}
