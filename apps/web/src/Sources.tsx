import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { BTN } from "./Feed.tsx";
import { CLS, Screen, UNREACHABLE, useToast, WorkerCard } from "./Screen.tsx";
import { api, post, type SourcesStatus, type Status } from "./sync.ts";

/**
 * The upload answer for a Source the Mac refuses.
 */
const UPLOAD = { unprocessable: 422 };

/**
 * A progress bar's full width, in percent.
 */
const BAR = { full: 100 };

/**
 * How often Sources and a Source screen re-read the Mac while open and visible.
 */
export const POLL_MS = 3000;

/**
 * Upload with the last refusal (if any), the live Worker status, the queue line, and a card per Source, which opens its
 * Source screen; two columns in the Mac browser. Off the network it says "Mac unreachable" and the drop zone is disabled.
 */
export function Sources() {
  const navigate = useNavigate();
  const [toast, showToast] = useToast();
  const [adding, setAdding] = useState<string>();
  const [refusal, setRefusal] = useState<ReactNode>();
  const [over, setOver] = useState(false);
  const { data, isError, isFetchedAfterMount, refetch } = useQuery({
    queryKey: ["sources"],
    queryFn: () => api<SourcesStatus>("/api/sources"),
    refetchInterval: POLL_MS,
  });
  const worker = useQuery({
    queryKey: ["status"],
    queryFn: () => api<Status>("/api/status"),
    refetchInterval: POLL_MS,
  });
  // Only this visit's answer, and only while the Mac answers: the drop zone works only then.
  const status = isFetchedAfterMount && !isError ? data : undefined;

  /**
   * Sends `file` to the Mac as a new Source, then shows any refusal on top and reloads the Sources.
   */
  const upload = async (file: File) => {
    setAdding(file.name);
    let message: ReactNode = null;
    try {
      // Uploads run as long as the file takes, so no timeout.
      const res = await fetch(`/api/sources?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      if (res.status === UPLOAD.unprocessable) {
        message = (
          <>
            <b>{file.name} refused.</b> {(await res.json()).error}
          </>
        );
      } else if (!res.ok) {
        message = (
          <>
            <b>{file.name} failed</b> ({res.status}).
          </>
        );
      }
    } catch {
      message = (
        <>
          <b>{file.name} not sent.</b> Mac unreachable.
        </>
      );
    }
    setAdding(undefined);
    setRefusal(message);
    refetch();
  };
  /**
   * Runs `call`, then reloads the Sources.
   */
  const act = (call: () => Promise<void>) => () =>
    call().then(
      () => {
        setRefusal(null);
        refetch();
      },
      () => showToast("Mac unreachable: try again."),
    );

  return (
    <Screen title="Sources">
      <label
        className={`block cursor-pointer rounded-xl border-2 border-dashed p-[18px] text-center text-muted ${over ? "border-accent" : "border-line"} ${status ? "" : "pointer-events-none opacity-50"}`}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          if (status && event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]);
        }}
      >
        {adding ? `Adding ${adding}…` : "📄 Add a PDF, .txt, .md, .epub or .azw3"}
        <input
          type="file"
          accept=".pdf,.txt,.md,.epub,.azw3"
          hidden
          disabled={!status}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared, so the same file can be picked again.
            event.target.value = "";
            if (file) upload(file);
          }}
        />
      </label>
      {refusal && <div className={`${CLS.card} mt-2.5 border-bad text-[#fecaca]`}>{refusal}</div>}
      {isError && <p className={CLS.meta}>{UNREACHABLE}</p>}
      {status && (
        <>
          {worker.isFetchedAfterMount && worker.data && (
            <div className="mt-3">
              <WorkerCard status={worker.data} />
            </div>
          )}
          <p className={`mt-3 ${CLS.meta}`}>
            Queue:{" "}
            {status.queue.pausedUntil &&
              // HH:MM, as in the CLI's status.
              `Paused until ${new Date(status.queue.pausedUntil).toLocaleTimeString().slice(0, "HH:MM".length)} (rate limit) · `}
            buffer {status.queue.buffer.clips}/{status.queue.buffer.target} · today {status.queue.today.clips}/
            {status.queue.today.cap} Clips
          </p>
          <h2 className={CLS.h2}>Your Sources</h2>
          <div className="min-[900px]:grid min-[900px]:grid-cols-2 min-[900px]:gap-2.5">
            {status.sources.map((source) => {
              const { done, total } = source.chapters;
              const paused = source.status === "paused";
              const [chip, color] = paused
                ? ["paused", CLS.warn]
                : source.stuck.length
                  ? [`${source.stuck.length} stuck`, CLS.bad]
                  : total && done === total
                    ? ["complete", CLS.ok]
                    : ["extracting", "border-line"];
              return (
                <div key={source.id} className={CLS.card}>
                  <button
                    type="button"
                    className="block w-full text-left"
                    onClick={() => navigate(`/sources/${source.id}`)}
                  >
                    <b>{source.title}</b>
                    <span className={`${CLS.chip} ${color}`}>{chip}</span>
                    <span className="mt-2 mb-1 block h-1.5 overflow-hidden rounded-[3px] bg-line">
                      <span
                        className="block h-full bg-ok"
                        style={{ width: `${total ? (BAR.full * done) / total : 0}%` }}
                      />
                    </span>
                    <span className={`block ${CLS.meta}`}>
                      chapter {done}/{total} · {source.concepts} Concepts
                    </span>
                  </button>
                  {source.stuck.map((job) => (
                    <div
                      key={job.jobId}
                      className="flex items-center justify-between gap-2 border-line border-t py-1.5 text-[13px]"
                    >
                      <span>
                        ✗ ch. {job.chapter.seq + 1} “{job.chapter.title}”: {job.lastError}
                      </span>
                      <button
                        type="button"
                        className={BTN}
                        onClick={act(() => post("/api/retry", { jobId: job.jobId }))}
                      >
                        ↻ Retry
                      </button>
                    </div>
                  ))}
                  <div className={CLS.actions}>
                    <button
                      type="button"
                      className={BTN}
                      onClick={act(() => post(paused ? "/api/resume" : "/api/pause", { sourceId: source.id }))}
                    >
                      {paused ? "▶ Resume" : "⏸ Pause"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <p className={`mt-3 ${CLS.meta}`}>
            Pausing stops new Concepts and Clips from that Source; Reviews and 🤔 go on. Sources are never deleted.
          </p>
        </>
      )}
      {toast}
    </Screen>
  );
}
