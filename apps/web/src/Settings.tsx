import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { USAGE_GROUPS } from "@doomlearn/core/api";
import { LANGUAGE_TAGS, LANGUAGES, type Language } from "@doomlearn/core/languages";
import { BTN } from "./Feed.tsx";
import { CLS, Screen, UNREACHABLE, useToast, WorkerCard } from "./Screen.tsx";
import {
  api,
  type ConfigDoc,
  hhmm,
  queryClient,
  type RunWindow,
  type StageAgent,
  type Status,
  SYNC,
  type UsageReport,
} from "./sync.ts";

/**
 * The Worker pause chips and how long each pauses for; `null` pauses until resumed. UI presets, not config keys.
 */
const PAUSE = { "1 h": 3_600_000, "8 h": 28_800_000, "until I resume": null };

/**
 * A Run window's days, in config order (from Sunday, as `Date.getDay()` numbers them); the form lists Monday first.
 */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Each Provider's Effort words, and the models its datalist suggests. A model is free text: the Mac warns, never
 * refuses, when Codex does not list it.
 */
const PROVIDERS = {
  claude: { efforts: ["low", "medium", "high", "xhigh", "max"], models: ["opus", "sonnet", "haiku"] },
  codex: {
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
  },
};

/**
 * The agent stages, in pipeline order.
 */
const STAGES = ["extract", "script", "verify", "split", "scene"];

/**
 * Each group doomlearn's own consumption can be grouped by, as `/api/usage?by=` names it, with its label. Keyed by
 * every group, so a group the server adds fails typecheck until it has a label.
 */
const GROUPS: Record<(typeof USAGE_GROUPS)[number], string> = {
  provider: "Provider",
  stage: "stage",
  day: "day",
  source: "Source",
  clip: "Clip",
};

/**
 * Percent of a whole Usage window or bar, and minutes in a millisecond count.
 */
const UNIT = { percent: 100, minuteMs: 60_000 };

/**
 * A tab's sticky Save, which lights up once the form changed.
 */
const SAVE =
  "sticky bottom-4 mt-4 w-full rounded-xl border border-line bg-card py-2.5 font-semibold enabled:border-accent enabled:bg-accent enabled:text-bg disabled:opacity-50";

/**
 * A config save's answer when a newer edit on the Mac would be overwritten.
 */
const CONFIG_SAVE = { conflict: 409 };

/**
 * Settings, online only: the Worker, Usage and Agents tabs. Each config save is one PUT with the version it read;
 * on 409 the form reloads from the file.
 */
export function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const [toast, showToast] = useToast();
  // The last save's preflight warnings, e.g. a Codex model its list lacks; they never block a save.
  const [warnings, setWarnings] = useState<string[]>([]);
  const { data, isError, isFetchedAfterMount, refetch } = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigDoc>("/api/config"),
  });
  // Only this visit's answer, and only while the Mac answers: a save needs a live version.
  const doc = isFetchedAfterMount && !isError ? data : undefined;

  /**
   * Saves `sections` over the config in one PUT, then reloads it and the Worker status. Returns the preflight's
   * warnings, or `undefined` when nothing was saved.
   */
  const save = async (sections: Partial<ConfigDoc["config"]>): Promise<string[] | undefined> => {
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: doc!.version, ...sections }),
        signal: AbortSignal.timeout(SYNC.timeoutMs),
      });
      if (res.status === CONFIG_SAVE.conflict) {
        showToast("config changed on the Mac");
        await refetch();
        return;
      }
      if (!res.ok) {
        // A refused value comes with the Mac's reason, e.g. one under the bound its schema enforces; any other failure
        // may have no JSON body.
        const { error } = await res.json().catch(() => ({}));
        showToast(`Not saved: ${error ?? `the Mac refused it (${res.status}).`}`);
        return;
      }
      const { warnings } = await res.json();
      await Promise.all([refetch(), queryClient.refetchQueries({ queryKey: ["status"] })]);
      return warnings;
    } catch {
      showToast("Mac unreachable: not saved.");
    }
  };

  return (
    <Screen title="Settings">
      <div role="tablist" className="mb-3 flex gap-1.5">
        {(["worker", "usage", "agents"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={`${BTN} capitalize ${tab === name ? "border-accent text-accent" : ""}`}
            // Replaced, so back closes Settings whichever tab is open.
            onClick={() => navigate(`/settings/${name}`, { replace: true })}
          >
            {name}
          </button>
        ))}
      </div>
      {isError && tab !== "usage" && <p className={CLS.meta}>{UNREACHABLE}</p>}
      {/* Keyed by version: a save or a reload starts the form over from the file. */}
      {doc && tab === "worker" && <Worker key={doc.version} doc={doc} save={save} />}
      {tab === "usage" && <Usage />}
      {doc && tab === "usage" && <Threshold key={doc.version} doc={doc} save={save} />}
      {doc && tab === "agents" && (
        <Agents
          key={doc.version}
          doc={doc}
          warnings={warnings}
          save={async (sections) => setWarnings((await save(sections)) ?? [])}
        />
      )}
      {toast}
    </Screen>
  );
}

/**
 * The Worker tab: the Worker status with every Blocker; the Worker pause, which a chip saves at once; the Run windows,
 * the Clips kept ready and per day and the Language of new Clips, saved with Save; host and port.
 */
function Worker({ doc, save }: { doc: ConfigDoc; save: (sections: Partial<ConfigDoc["config"]>) => unknown }) {
  const { worker, server } = doc.config;
  const [windows, setWindows] = useState(worker.schedule.windows);
  const [bufferTarget, setBufferTarget] = useState(String(worker.bufferTarget));
  const [dailyClipCap, setDailyClipCap] = useState(String(worker.dailyClipCap));
  const [language, setLanguage] = useState(worker.language);
  const { data: status } = useQuery({ queryKey: ["status"], queryFn: () => api<Status>("/api/status") });
  /**
   * Changes the `i`th Run window.
   */
  const edit = (i: number, change: Partial<RunWindow>) =>
    setWindows(windows.map((window, at) => (at === i ? { ...window, ...change } : window)));
  /**
   * Saves the Worker pause at once: `until` a time, until resumed (`paused`), or lifted.
   */
  const pause = (paused: boolean, until: number | null) =>
    save({ worker: { ...worker, paused, pausedUntil: until ? new Date(until).toISOString() : null } });
  const pausedUntil = worker.pausedUntil && Date.now() < new Date(worker.pausedUntil).getTime() && worker.pausedUntil;
  const edited = { ...worker, bufferTarget: Number(bufferTarget), dailyClipCap: Number(dailyClipCap), language };
  // A pause saves at once and starts the form over from the file, so it waits while the form is unsaved.
  const dirty =
    JSON.stringify(windows) !== JSON.stringify(worker.schedule.windows) ||
    edited.bufferTarget !== worker.bufferTarget ||
    edited.dailyClipCap !== worker.dailyClipCap ||
    edited.language !== worker.language;
  return (
    <>
      {status && <WorkerCard status={status} />}
      <h2 className={CLS.h2}>Worker pause</h2>
      {worker.paused || pausedUntil ? (
        <div className={`${CLS.card} flex items-center justify-between`}>
          <span>{pausedUntil ? `Paused until ${hhmm(pausedUntil)}` : "Paused until you resume"}</span>
          <button type="button" className={BTN} disabled={dirty} onClick={() => pause(false, null)}>
            Resume
          </button>
        </div>
      ) : (
        <div className={CLS.actions}>
          {Object.entries(PAUSE).map(([label, ms]) => (
            <button
              key={label}
              type="button"
              className={BTN}
              disabled={dirty}
              onClick={() => pause(ms === null, ms && Date.now() + ms)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <p className={`mt-2 ${CLS.meta}`}>The running stage finishes; no new one starts. Buffered Clips keep playing.</p>

      <h2 className={CLS.h2}>Run windows</h2>
      {!windows.length && <p className={CLS.meta}>No Run windows: the worker may run any time.</p>}
      {windows.map((window, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: windows have no id, and only Remove reorders them.
        <div key={i} data-testid="run-window" className={CLS.card}>
          <div className="flex flex-wrap gap-2">
            {[...DAYS.slice(1), DAYS[0]].map((day) => (
              <label key={day} className="flex items-center gap-1 capitalize">
                <input
                  type="checkbox"
                  checked={window.days.includes(day)}
                  onChange={(event) =>
                    edit(i, {
                      days: DAYS.filter((d) => (d === day ? event.target.checked : window.days.includes(d))),
                    })
                  }
                />
                {day}
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <label className="flex items-center gap-1">
              Start
              <input
                type="time"
                required
                className="rounded border border-line bg-bg px-1"
                value={window.start}
                onChange={(event) => edit(i, { start: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-1">
              End
              <input
                type="time"
                required
                className="rounded border border-line bg-bg px-1"
                value={window.end}
                onChange={(event) => edit(i, { end: event.target.value })}
              />
            </label>
            <button
              type="button"
              className={`${BTN} ml-auto`}
              onClick={() => setWindows(windows.filter((_, at) => at !== i))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className={BTN}
        onClick={() => setWindows([...windows, { days: DAYS, start: "09:00", end: "17:00" }])}
      >
        + Run window
      </button>
      <p className={`mt-2 ${CLS.meta}`}>
        Mac local time. An end before the start crosses midnight; an end equal to the start is the whole day.
      </p>

      <h2 className={CLS.h2}>Clips</h2>
      <NumberInput label="Clips kept ready" value={bufferTarget} set={setBufferTarget} min={0} />
      <NumberInput label="New Clips per day" value={dailyClipCap} set={setDailyClipCap} min={0} />
      <label className="mt-1.5 flex items-center justify-between gap-2">
        Language of new Clips
        <select
          className="rounded border border-line bg-bg px-1 py-0.5"
          value={language}
          onChange={(event) => setLanguage(event.target.value as Language)}
        >
          {LANGUAGE_TAGS.map((tag) => (
            <option key={tag} value={tag}>
              {LANGUAGES[tag].name} ({tag})
            </option>
          ))}
        </select>
      </label>
      <p className={`mt-2 ${CLS.meta}`}>A Clip already started keeps its own Language.</p>

      <h2 className={CLS.h2}>Server</h2>
      <p className={CLS.meta}>
        {server.hosts.join(", ")} · port {server.port} · applies on restart
      </p>
      <button
        type="button"
        className={SAVE}
        // A window needs a day and both times, and each number a value; the Mac would refuse it.
        disabled={
          !dirty ||
          !bufferTarget ||
          !dailyClipCap ||
          windows.some((window) => !window.days.length || !window.start || !window.end)
        }
        onClick={() => save({ worker: { ...edited, schedule: { windows } } })}
      >
        Save
      </button>
    </>
  );
}

/**
 * The Agents tab: each stage's Provider, model and Effort, and the agent call timeout, saved together with Save.
 */
function Agents({
  doc,
  warnings,
  save,
}: {
  doc: ConfigDoc;
  warnings: string[];
  save: (sections: Partial<ConfigDoc["config"]>) => unknown;
}) {
  const { agents } = doc.config;
  const [stages, setStages] = useState(agents.stages);
  const [timeoutMinutes, setTimeoutMinutes] = useState(String(agents.timeoutMinutes));
  const edited = { ...agents, stages, timeoutMinutes: Number(timeoutMinutes) };
  /**
   * Changes one stage's agent.
   */
  const edit = (stage: string, change: Partial<StageAgent>) =>
    setStages({ ...stages, [stage]: { ...stages[stage], ...change } });
  return (
    <>
      {Object.entries(PROVIDERS).map(([provider, { models }]) => (
        <datalist key={provider} id={`models-${provider}`}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ))}
      {STAGES.map((stage) => {
        const agent = stages[stage];
        return (
          <div key={stage} data-testid={`stage-${stage}`} className={CLS.card}>
            <b className="capitalize">{stage}</b>
            <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
              <label htmlFor={`${stage}-provider`}>Provider</label>
              <select
                id={`${stage}-provider`}
                className="rounded border border-line bg-bg px-1 py-0.5"
                value={agent.provider}
                // Each Provider has its own models and Effort words, so both are picked again.
                onChange={(event) =>
                  edit(stage, { provider: event.target.value as StageAgent["provider"], model: "", effort: "" })
                }
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
              <label htmlFor={`${stage}-model`}>Model</label>
              <input
                id={`${stage}-model`}
                list={`models-${agent.provider}`}
                className="rounded border border-line bg-bg px-1 py-0.5"
                value={agent.model}
                onChange={(event) => edit(stage, { model: event.target.value })}
              />
              <label htmlFor={`${stage}-effort`}>Effort</label>
              <select
                id={`${stage}-effort`}
                className="rounded border border-line bg-bg px-1 py-0.5"
                value={agent.effort}
                onChange={(event) => edit(stage, { effort: event.target.value })}
              >
                {!agent.effort && <option value="">pick one</option>}
                {PROVIDERS[agent.provider].efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })}
      <NumberInput label="Agent timeout (min)" value={timeoutMinutes} set={setTimeoutMinutes} min={1} />
      {warnings.map((warning) => (
        <p key={warning} className="mt-2 text-sm text-warn">
          ⚠ {warning}
        </p>
      ))}
      <p className={`mt-2 ${CLS.meta}`}>
        A change applies to the next stage that starts; a running call keeps its own.
      </p>
      <button
        type="button"
        className={SAVE}
        disabled={
          JSON.stringify(edited) === JSON.stringify(agents) ||
          !timeoutMinutes ||
          Object.values(stages).some((agent) => !agent.model || !agent.effort)
        }
        onClick={() => save({ agents: edited })}
      >
        Save
      </button>
    </>
  );
}

/**
 * A labelled number input within the bounds the config schema enforces. It keeps the text as typed, so a cleared
 * field stays empty instead of turning into 0.
 */
function NumberInput({
  label,
  value,
  set,
  min,
  max,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  min: number;
  max?: number;
}) {
  return (
    <label className="mt-1.5 flex items-center justify-between gap-2">
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className="w-20 rounded border border-line bg-bg px-1 py-0.5"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    </label>
  );
}

/**
 * The usage threshold under the Usage tab, saved with Save: no stage starts while the latest Claude Usage window is
 * at or above it. An empty field is off for that window, and both empty is off.
 */
function Threshold({ doc, save }: { doc: ConfigDoc; save: (sections: Partial<ConfigDoc["config"]>) => unknown }) {
  const { worker } = doc.config;
  const [fiveHour, setFiveHour] = useState(String(worker.stopAtUsagePercent?.fiveHour ?? ""));
  const [sevenDay, setSevenDay] = useState(String(worker.stopAtUsagePercent?.sevenDay ?? ""));
  const stopAtUsagePercent =
    fiveHour || sevenDay
      ? { fiveHour: fiveHour ? Number(fiveHour) : undefined, sevenDay: sevenDay ? Number(sevenDay) : undefined }
      : null;
  return (
    <>
      <h2 className={CLS.h2}>Usage threshold</h2>
      <NumberInput label="5-hour %" value={fiveHour} set={setFiveHour} min={1} max={UNIT.percent} />
      <NumberInput label="7-day %" value={sevenDay} set={setSevenDay} min={1} max={UNIT.percent} />
      <p className={`mt-2 ${CLS.meta}`}>Claude only. Empty is off. Unknown or stale usage never stops the worker.</p>
      <button
        type="button"
        className={SAVE}
        disabled={JSON.stringify(stopAtUsagePercent) === JSON.stringify(worker.stopAtUsagePercent)}
        onClick={() => save({ worker: { ...worker, stopAtUsagePercent } })}
      >
        Save
      </button>
    </>
  );
}

/**
 * The Usage tab, read fresh each time it opens (which probes Codex): each Provider's Usage windows, doomlearn's own
 * consumption grouped as picked, and past rate-limit pauses.
 */
function Usage() {
  const [by, setBy] = useState<(typeof USAGE_GROUPS)[number]>("provider");
  const { data, isError, isFetchedAfterMount } = useQuery({
    queryKey: ["usage", by],
    queryFn: () => api<UsageReport>(`/api/usage?by=${by}`),
  });
  if (isError) return <p className={CLS.meta}>{UNREACHABLE}</p>;
  // Only this visit's answer: an old reading must never look current.
  if (!isFetchedAfterMount || !data) return null;
  return (
    <>
      {data.providers.map(({ provider, unavailable, windows }) => (
        <section key={provider}>
          <h2 className={`${CLS.h2} capitalize`}>{provider}</h2>
          {unavailable && <p className="text-sm text-warn">unavailable: {unavailable}</p>}
          {windows.map(({ window, utilization, status, capturedAt, resetsAt, resetSince }) => (
            <div
              key={window}
              data-testid={`window-${provider}-${window}`}
              // An unavailable or reset window keeps its last value, greyed.
              className={`${CLS.card} ${unavailable || resetSince ? "opacity-50" : ""}`}
            >
              <div className="flex justify-between text-sm">
                <span>{window.replaceAll("_", " ")}</span>
                <span className={CLS.meta}>
                  {/* Times in the phone's timezone, like every other time here, not the Mac's. */}
                  {resetSince
                    ? `reset since ${hhmm(resetsAt!)}`
                    : `${utilization === null ? status : `${Math.round(utilization * UNIT.percent)}%`} · as of ${hhmm(capturedAt)}`}
                  {/* A reset after today, e.g. the 7-day window's, also names its day. */}
                  {resetsAt &&
                    !resetSince &&
                    ` · resets ${new Date(resetsAt).toDateString() === new Date().toDateString() ? "" : `${new Date(resetsAt).toLocaleDateString(undefined, { weekday: "short" })} `}${hhmm(resetsAt)}`}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-[3px] bg-line">
                <div
                  data-testid="bar"
                  className="h-full bg-accent"
                  style={{ width: `${Math.round((utilization ?? 0) * UNIT.percent)}%` }}
                />
              </div>
            </div>
          ))}
        </section>
      ))}

      <h2 className={CLS.h2}>doomlearn’s own use</h2>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {Object.entries(GROUPS).map(([group, label]) => (
          <button
            key={group}
            type="button"
            aria-pressed={by === group}
            className={`${BTN} ${by === group ? "border-accent text-accent" : ""}`}
            onClick={() => setBy(group as (typeof USAGE_GROUPS)[number])}
          >
            {label}
          </button>
        ))}
      </div>
      <table className="w-full text-left text-sm">
        <thead className={CLS.meta}>
          <tr>
            <th className="font-normal">{GROUPS[by]}</th>
            <th className="font-normal">calls</th>
            <th className="font-normal">tokens in / out</th>
            <th className="font-normal">API-equivalent $</th>
          </tr>
        </thead>
        <tbody>
          {data.consumption.map((row) => (
            <tr key={row.key} className="border-line border-t">
              <td className="py-1">{row.key}</td>
              <td>{row.calls}</td>
              <td>
                {row.tokensIn} / {row.tokensOut}
              </td>
              <td>{row.apiEquivalentUsd === null ? "—" : `$${row.apiEquivalentUsd.toFixed(2)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`mt-2 ${CLS.meta}`}>{data.costNote}</p>

      <h2 className={CLS.h2}>Rate-limit pauses</h2>
      {!data.pauses.length && <p className={CLS.meta}>None so far.</p>}
      {data.pauses.map((pause) => (
        <p key={pause.at} data-testid="pause" className="border-line border-t py-1.5 text-sm">
          {new Date(pause.at).toLocaleDateString()} {hhmm(pause.at)} · {pause.provider ?? "claude"} · {pause.stage} ·
          until {hhmm(pause.until)}
          {pause.estimated && " (estimated)"} · {Math.round(pause.durationMs / UNIT.minuteMs)} min
        </p>
      ))}
    </>
  );
}
