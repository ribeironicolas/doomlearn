import { LANGUAGES } from "@doomlearn/core/languages";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { BTN } from "./Feed.tsx";
import { FixSheet } from "./Fix.tsx";
import { angleName, CLS, Player, Screen, UNREACHABLE, useToast } from "./Screen.tsx";
import { passagePlace } from "./Slide.tsx";
import { api, type Inbox as Items, type Passage, post } from "./sync.ts";

/**
 * Open 🚩, not-landing Concepts and stuck jobs, each with its actions. A 🚩 queued for Regenerate leaves the list
 * until its job is done or stuck. A 🚩 Pronunciation also opens the fix sheet. A Clip and a Passage open over it
 * as history entries with no URL. Off the network it says "Mac unreachable" and shows no actions.
 */
export function Inbox() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const [toast, showToast] = useToast();
  // The 📥 badge's query, so the badge follows what this screen shows.
  const { data, isError, isFetchedAfterMount, refetch } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api<Items>("/api/inbox"),
  });
  // Only this visit's answer: never the badge's older one.
  const inbox = isFetchedAfterMount && !isError ? data : undefined;
  /**
   * Runs `call`, then toasts `done` and reloads the inbox.
   */
  const act = (call: () => Promise<void>, done: string) => () =>
    call().then(
      () => {
        showToast(done);
        refetch();
      },
      () => showToast("Mac unreachable: try again."),
    );
  const flag = state?.hit === undefined ? undefined : inbox?.flags[state.hit];
  const reading = state?.read === undefined ? undefined : inbox?.notLanding[state.read];
  const fixing = state?.fix === undefined ? undefined : inbox?.flags[state.fix];

  return (
    <Screen title="Inbox">
      {isError && <p className={CLS.meta}>{UNREACHABLE}</p>}
      {inbox && (
        <>
          <h2 className={CLS.h2}>🚩 Flagged Clips ({inbox.flags.length})</h2>
          {inbox.flags.map((item, i) => (
            <div key={item.eventId} data-testid="flag" className={CLS.card}>
              <b>{item.concept.title}</b>
              <span className={`${CLS.chip} ${item.reason === "Pronunciation" ? CLS.warn : CLS.bad}`}>
                {item.reason ?? "Wrong"}
              </span>
              <div className={CLS.meta}>
                {angleName(item.angle)} · {new Date(item.at).toLocaleString()}
              </div>
              {item.note && <div>“{item.note}”</div>}
              <div className={CLS.actions}>
                <button type="button" className={BTN} onClick={() => navigate("/inbox", { state: { hit: i } })}>
                  ▶ View Clip
                </button>
                <button
                  type="button"
                  className={BTN}
                  onClick={act(() => post("/api/resolve", { eventId: item.eventId }), "🚩 Resolved.")}
                >
                  Resolved
                </button>
                <button
                  type="button"
                  className={BTN}
                  onClick={act(
                    () => post("/api/regenerate", { eventId: item.eventId }),
                    "↻ Regenerating: back in the Feed once remade.",
                  )}
                >
                  ↻ Regenerate
                </button>
                {item.reason === "Pronunciation" && (
                  <button type="button" className={BTN} onClick={() => navigate("/inbox", { state: { fix: i } })}>
                    🗣️ Fix pronunciation
                  </button>
                )}
              </div>
            </div>
          ))}
          <h2 className={CLS.h2}>Not landing ({inbox.notLanding.length})</h2>
          {inbox.notLanding.map((item, i) => (
            <div key={item.concept.id} className={CLS.card}>
              <b>{item.concept.title}</b>
              <span className={`${CLS.chip} ${CLS.warn}`}>
                {item.tried.length}/{item.fit} Angles
              </span>
              <div className={CLS.meta}>
                Tried {item.tried.map(angleName).join(", ")} · since {new Date(item.since).toLocaleDateString()}.
                Reviews reuse its least recently seen Clip.
              </div>
              <div className={CLS.actions}>
                <button type="button" className={BTN} onClick={() => navigate("/inbox", { state: { read: i } })}>
                  Read the Passage
                </button>
                <button
                  type="button"
                  className={BTN}
                  onClick={act(
                    () =>
                      post("/api/press", { clipId: item.clipId, button: "know", clientEventId: crypto.randomUUID() }),
                    "⏭️ Retired.",
                  )}
                >
                  ⏭️ Retire
                </button>
              </div>
            </div>
          ))}
          <h2 className={CLS.h2}>Stuck jobs ({inbox.stuck.length})</h2>
          {inbox.stuck.map((job) => {
            const extraction = job.kind === "extract_chapter";
            const what = extraction
              ? "Extraction"
              : job.kind === "translate"
                ? `Translation into ${LANGUAGES[job.language!].name}`
                : "Clip";
            return (
              <div key={job.jobId} className={CLS.card}>
                <b>
                  {extraction
                    ? `${job.source?.title} · ${job.chapter?.title}`
                    : `${job.concept?.title} · ${angleName(job.angle ?? "")}`}
                </b>
                <span className={`${CLS.chip} ${CLS.bad}`}>stuck</span>
                <div className={CLS.meta}>
                  {what} · {job.stage ? `after ${job.stage}` : "at the first stage"}
                </div>
                <div>{job.lastError}</div>
                <div className={CLS.actions}>
                  <button
                    type="button"
                    className={BTN}
                    onClick={act(() => post("/api/retry", { jobId: job.jobId }), "↻ Back in the queue.")}
                  >
                    ↻ Retry
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
      {flag && <Player clip={flag} label="🚩" toast={showToast} />}
      {fixing && (
        <FixSheet
          eventId={fixing.eventId}
          title={fixing.concept.title}
          onClose={() => navigate(-1)}
          onSaved={() => {
            navigate(-1);
            showToast("Fix saved: regenerating, back in the Feed once remade.");
            refetch();
          }}
        />
      )}
      {reading && (
        <PassageSheet title={reading.concept.title} passages={reading.passages} onClose={() => navigate(-1)} />
      )}
      {toast}
    </Screen>
  );
}

/**
 * A Concept's Passages, each with its place in its Source, as a bottom sheet over everything. Tapping outside it
 * closes it.
 */
function PassageSheet({ title, passages, onClose }: { title: string; passages: Passage[]; onClose: () => void }) {
  return createPortal(
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-39 bg-[#0008]" onClick={onClose} />
      <div className="fixed right-0 bottom-0 left-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-[18px] border-line border-t bg-card px-4 pt-[18px] pb-[calc(18px+env(safe-area-inset-bottom))]">
        <h3 className="mb-2.5 font-bold text-[1.17em]">{title}</h3>
        {passages.map((passage) => (
          <div key={`${passage.source.id}-${passage.text}`}>
            <p className="mt-3 mb-1.5 text-[13px] text-accent">{passagePlace(passage)}</p>
            <p className="whitespace-pre-wrap">{passage.text}</p>
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
}
