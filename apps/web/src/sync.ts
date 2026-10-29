import { QueryClient } from "@tanstack/react-query";
import type { Language } from "@doomlearn/core/languages";
// biome-ignore lint/style/noRestrictedImports: a type only, which the bundle never holds.
import type { createPronunciation } from "@doomlearn/core/pronunciation";

//
// The Feed's link to the Mac, ported from v1 (legacy/app.js, Sync) with its storage keys and shapes unchanged:
// localStorage `queue` and `handled`, Cache Storage `api` and `clips`. Presses the v1 app queued offline flush here.
// The Favorites' Clips stay in their own Cache Storage `favorites`, which the buffer cleanup never touches, and
// localStorage `persisted` says this phone has asked to keep them (persistent storage).
//

/**
 * A Mac off ZeroTier hangs rather than refusing, so a request gives up after `timeoutMs`;
 * the press queue is retried every `retryMs`.
 */
export const SYNC = { timeoutMs: 5000, retryMs: 30_000 };

/**
 * One Clip in the Feed, as `/api/next` lists it.
 */
export type Slot = {
  kind: "new" | "review";
  clipId: number;
  url: string;
  angle: string;
  language: string;
  favorite: boolean;
  concept: { id: number; title: string; days: number | null };
  source: { id: number; title: string };
  passages: Passage[];
};

/**
 * A Favorite, as `/api/favorites` lists it: `flagged` while its Clip is 🚩 and not regenerated yet. A Clip starred here
 * before the Mac lists it has no `source.status`.
 */
export type Favorite = {
  clipId: number;
  url: string;
  angle: string;
  language: string;
  /**
   * `paused` by hand or through its Sources and chapters, unless `deleted`. A Clip starred here before the Mac lists it
   * has neither.
   */
  concept: {
    id: number;
    title: string;
    status: "new" | "scheduled" | "retired";
    days: number | null;
    deleted?: boolean;
    paused?: boolean;
  };
  source: { id: number; title: string; status?: "active" | "paused" };
  flagged: boolean;
};

/**
 * A Passage with its place in its Source.
 */
export type Passage = {
  text: string;
  anchor: { pages?: [number, number]; chapter?: string; section?: string };
  source: { id: number; title: string };
};

/**
 * What `/api/today` reports for the Done screen.
 */
export type Today = {
  counts: { got_it: number; didnt_get: number; know: number; flag: number };
  buffer: { ready: number; generating: number; target: number };
  dueTomorrow: number;
};

/**
 * The inbox's open items: unresolved 🚩, Concepts not landing, and stuck jobs.
 */
export type Inbox = {
  flags: {
    eventId: number;
    clipId: number;
    url: string;
    angle: string;
    concept: { id: number; title: string };
    reason: string | null;
    note: string | null;
    at: string;
  }[];
  notLanding: {
    concept: { id: number; title: string };
    clipId: number;
    tried: string[];
    fit: number;
    since: string;
    passages: Passage[];
  }[];
  stuck: {
    jobId: number;
    kind: "new" | "new_angle" | "regenerate" | "extract_chapter" | "translate";
    stage: string | null;
    lastError: string | null;
    angle: string | null;
    language: Language | null;
    chapter: { title: string } | null;
    source: { title: string } | null;
    concept: { title: string } | null;
  }[];
};

/**
 * A 🚩's fix sheet, as `/api/fix` gives it: the Clip's Language and the 🚩 note, the script's words as the captions
 * show them, each with its beat, its sentence, whether it is a script's own `{shown|spoken}` term, and the chunk of
 * `says` it is in, and what the voice says now for each chunk.
 */
export type FixSheet = {
  language: Language;
  note: string | null;
  words: { text: string; beat: number; sentence: number; markup: boolean; chunk: number }[];
  says: string[];
};

/**
 * A Clip's 🌐 sheet, as `/api/translations` gives it: its Concept, and every other Language with its Clip of this
 * Concept and Angle once made, else its translate job not done yet, whether the daily Clip cap holds it, and the
 * Blocker holding it.
 */
export type Translations = {
  concept: { title: string };
  languages: {
    language: Language;
    name: string;
    made: { clipId: number; url: string; angle: string } | null;
    job: { id: number; status: "queued" | "running" | "stuck" } | null;
    capped: boolean;
    blocker: { reason: string; until: string | null } | null;
  }[];
};

/**
 * A preview as `/api/preview` reports it: its status and error, the Blocker holding it, whether the worker is
 * finishing a step, loading the voice or speaking it, and its wav once spoken.
 */
export type Preview = ReturnType<ReturnType<typeof createPronunciation>["poll"]> & { wavUrl: string | null };

/**
 * What `/api/sources` reports: each Source's progress and stuck chapters, and the generation queue.
 */
export type SourcesStatus = {
  sources: {
    id: number;
    title: string;
    status: "active" | "paused";
    chapters: { done: number; total: number };
    concepts: number;
    stuck: { jobId: number; chapter: { seq: number; title: string }; lastError: string | null }[];
  }[];
  queue: {
    pausedUntil?: string;
    buffer: { clips: number; target: number };
    today: { clips: number; cap: number };
  };
};

/**
 * A chapter of a Source, as a Source screen Concept names it.
 */
type Place = { source: { id: number; title: string }; chapter: { id: number; seq: number; title: string } };

/**
 * A Source screen, as `/api/sources/:id` gives it: the Source's chapters in book order, each with its state, its stuck
 * extraction job, and the Concepts it teaches in reading order, with their ladder, Passages in that chapter, Clips and
 * the other chapters teaching them.
 */
export type SourceScreen = {
  id: number;
  title: string;
  status: "active" | "paused";
  /**
   * How many steps the ladder has.
   */
  ladderSteps: number;
  chapters: {
    id: number;
    seq: number;
    title: string;
    state: "waiting" | "extracting" | "extracted" | "stuck" | "paused";
    paused: boolean;
    deleted: boolean;
    stuck: { jobId: number; lastError: string | null } | null;
    conceptCount: number;
    concepts: {
      id: number;
      title: string;
      summary: string;
      status: "new" | "scheduled" | "retired";
      ladderStep: number | null;
      dueAt: string | null;
      retiredReason: "known" | "graduated" | null;
      notLandingAt: string | null;
      /**
       * Paused by hand.
       */
      paused: boolean;
      /**
       * Deleted by hand (`deletedByHand`), or with every chapter teaching it.
       */
      deleted: boolean;
      deletedByHand: boolean;
      making: boolean;
      alsoIn: Place[];
      /**
       * The deleted chapters a Concept Deleted with its chapters went with; empty otherwise.
       */
      deletedWith: Place[];
      passages: { id: number; text: string }[];
      clips: {
        clipId: number;
        url: string;
        angle: string;
        language: string;
        seen: boolean;
        flagged: boolean;
        favorite: boolean;
      }[];
    }[];
  }[];
};

/**
 * One reason the worker starts no new stage, as `/api/status` lists it, with when it lifts, if known.
 */
export type Blocker = {
  kind:
    | "stopped"
    | "stopping"
    | "preflight"
    | "invalid_config"
    | "worker_pause"
    | "outside_run_window"
    | "rate_limited"
    | "usage_threshold";
  reason: string;
  until: string | null;
};

/**
 * What `/api/status` reports: the Worker status, the job and stage it is on since when, and every active Blocker.
 */
export type Status = {
  state: "running" | "idle" | "stopping" | "stopped";
  job: { id: number; kind: string; source: string | null; stage: string | null; since: string | null } | null;
  restarts: number;
  blockers: Blocker[];
};

/**
 * A Run window: the days it starts on, from `start` (inclusive) to `end` (exclusive), `HH:MM` Mac local time.
 */
export type RunWindow = { days: string[]; start: string; end: string };

/**
 * Which Provider runs a stage, with its model and Effort in that Provider's own words.
 */
export type StageAgent = { provider: "claude" | "codex"; model: string; effort: string };

/**
 * What `/api/config` reports: the config in use with every default filled in, and its version for the next save.
 */
export type ConfigDoc = {
  version: number;
  config: {
    agents: { stages: Record<string, StageAgent>; timeoutMinutes: number } & Record<string, unknown>;
    worker: {
      bufferTarget: number;
      dailyClipCap: number;
      language: Language;
      paused: boolean;
      pausedUntil: string | null;
      schedule: { windows: RunWindow[] };
      stopAtUsagePercent: { fiveHour?: number; sevenDay?: number } | null;
    } & Record<string, unknown>;
    server: { hosts: string[]; port: number };
  };
};

/**
 * What `/api/usage` reports: each Provider's Usage windows (or why they are unavailable), doomlearn's own consumption
 * as grouped, and past rate-limit pauses.
 */
export type UsageReport = {
  providers: {
    provider: string;
    unavailable: string | null;
    windows: {
      window: string;
      utilization: number | null;
      status: string | null;
      capturedAt: string;
      resetsAt: string | null;
      resetSince: string | null;
    }[];
  }[];
  consumption: {
    key: string;
    calls: number;
    apiEquivalentUsd: number | null;
    tokensIn: number;
    tokensOut: number;
  }[];
  costNote: string;
  pauses: {
    at: string;
    provider: string | null;
    stage: string;
    until: string;
    durationMs: number;
    estimated: boolean;
  }[];
};

/**
 * A time as the screens show it: `HH:MM`, in local time.
 */
export const hhmm = (at: string | Date) => new Date(at).toTimeString().slice(0, "HH:MM".length);

/**
 * A Clip whose caption matches a search, the match marked between \u0002 and \u0003.
 */
export type Hit = {
  clipId: number;
  url: string;
  angle: string;
  language: string;
  favorite: boolean;
  caption: string;
  concept: { id: number; title: string; status: "new" | "scheduled" | "retired"; days: number | null };
  source: { id: number; title: string };
};

/**
 * A press, a watch (as v1 queues them) or a ⭐ waiting to reach the Mac.
 */
type Queued =
  | { path: "/api/favorite"; body: { clipId: number; on: boolean } }
  | { path: "/api/press" | "/api/seen"; body: { clipId: number; clientEventId: string } };

/**
 * The lists as last written this session. Read before localStorage, so a write that storage refused (blocked, or
 * full) is never read back stale; they then hold for this session only.
 */
const memory: Record<string, string> = {};

/**
 * v1's localStorage lists: the press queue and the Clips handled here.
 */
const store = {
  get<T>(key: "queue" | "handled"): T[] {
    try {
      return JSON.parse(memory[key] ?? localStorage.getItem(key) ?? "[]");
    } catch {
      return [];
    }
  },
  set: (key: "queue" | "handled", value: unknown[]) => {
    memory[key] = JSON.stringify(value);
    try {
      localStorage.setItem(key, memory[key]);
    } catch {
      // Blocked: `memory` keeps it for this session.
    }
  },
};

/**
 * No retries and no refetch on focus: the Feed fetches at the moments v1 did, and a failed GET falls back by itself.
 * `always` because the browser can say online while the Mac is unreachable, and the fallback handles both.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, networkMode: "always" } },
});

/**
 * GETs from the Mac, keeping the answer for when it's unreachable. `fresh` is false when the answer is the kept one.
 */
async function getJSON<T>(path: string): Promise<{ value: T | null; fresh: boolean }> {
  let value: T;
  try {
    value = await api<T>(path);
  } catch {
    try {
      const kept = await caches.match(path, { cacheName: "api" });
      return { value: kept ? await kept.json() : null, fresh: false };
    } catch {
      // Cache Storage refused (a private window, the quota): nothing kept to fall back on.
      return { value: null, fresh: false };
    }
  }
  try {
    await (await caches.open("api")).put(path, Response.json(value));
  } catch (error) {
    // Cache Storage refused: the fresh answer still goes through, it just isn't kept.
    console.warn("api cache", error);
  }
  return { value, fresh: true };
}

/**
 * A Feed or Done GET through Query, with v1's last-good fallback as its fetcher. Query is called imperatively on
 * purpose: the Feed fetches at v1's moments (launch, the Done screen, after a press), not when a component subscribes.
 */
export function lastGood<T>(path: string) {
  return queryClient.fetchQuery({ queryKey: ["lastGood", path], queryFn: () => getJSON<T>(path) });
}

/**
 * GETs from the Mac's API. Throws when the Mac is unreachable or refuses.
 */
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.timeout(SYNC.timeoutMs) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/**
 * What a screen shows when the Mac doesn't answer; its forms are disabled meanwhile.
 */
export const UNREACHABLE = "Mac unreachable. Try again once it’s back.";

/**
 * A GET to the Mac's API, or a POST with `body` as JSON. Throws `UNREACHABLE` when the Mac doesn't answer, and the
 * Mac's own message, or else the status, when it refuses.
 */
export async function orRefusal(path: string, body?: object) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(SYNC.timeoutMs),
  }).catch(() => undefined);
  if (!res) throw new Error(UNREACHABLE);
  if (!res.ok) throw new Error((await res.json().catch(() => undefined))?.error ?? `${path}: ${res.status}`);
  return res;
}

/**
 * POSTs `body` to the Mac's API as JSON. Throws when the Mac is unreachable or refuses.
 */
export async function post(path: string, body: object) {
  const res = await fetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SYNC.timeoutMs),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}

/**
 * Presses waiting to sync.
 */
export const queued = () => store.get("queue").length;

/**
 * The Feed's last list of upcoming slots, which the buffer is kept from.
 */
let upcoming: Slot[] = [];

/**
 * Queues a press or a watch to the end, marks its Clip as handled here, tops the cached buffer back up, and tries to sync.
 */
export function send(path: "/api/press" | "/api/seen", body: { clipId: number } & Record<string, unknown>) {
  store.set("queue", [...store.get<Queued>("queue"), { path, body: { ...body, clientEventId: crypto.randomUUID() } }]);
  store.set("handled", [...store.get<number>("handled"), body.clipId]);
  upcoming = upcoming.filter((slot) => slot.clipId !== body.clipId);
  keepBuffer(upcoming);
  flush();
}

/**
 * Each Clip's last ⭐ this session, so a player opened from older data shows it.
 */
const stars = new Map<number, boolean>();

/**
 * Whether a Clip is a Favorite on this phone: its last ⭐ this session or still waiting to sync, else `mac`, what the
 * Mac last said.
 */
export const isFavorite = (clipId: number, mac: boolean) => {
  const last = store
    .get<Queued>("queue")
    .findLast(
      (item): item is Extract<Queued, { path: "/api/favorite" }> =>
        item.path === "/api/favorite" && item.body.clipId === clipId,
    );
  return stars.get(clipId) ?? last?.body.on ?? mac;
};

/**
 * Queues a ⭐ like a press, so it reaches the Mac once it is back, but leaves the Clip in the Feed. Once the Mac has
 * every ⭐, the phone's Favorites follow.
 */
export function favorite(clipId: number, on: boolean) {
  stars.set(clipId, on);
  store.set("queue", [...store.get<Queued>("queue"), { path: "/api/favorite", body: { clipId, on } }]);
  flush().then(() => {
    if (!queued()) syncFavorites();
  });
}

/**
 * The `favorites` cache sync in progress, which the next one waits for.
 */
let caching = Promise.resolve();

/**
 * The Favorites, from the Mac or else the last good list, with this phone's ⭐ not synced yet: an un-star taken out,
 * and an upcoming Clip starred here put first. A fresh list also syncs the `favorites` cache, after the list is
 * returned: new Favorites in, un-starred ones out, and a regenerated Clip under its new URL. Cache syncs run one at a
 * time in call order, so an older one never puts back a Clip that a newer one let go. The first Favorite this phone
 * caches asks for persistent storage, whatever the answer.
 */
export async function syncFavorites() {
  const { value, fresh } = await lastGood<Favorite[]>("/api/favorites");
  const mac = (value ?? []).filter((item) => isFavorite(item.clipId, true));
  const list = [
    ...upcoming
      .filter((slot) => isFavorite(slot.clipId, slot.favorite) && !mac.some((item) => item.clipId === slot.clipId))
      .map(
        ({ kind, concept, passages, favorite, ...slot }): Favorite => ({
          ...slot,
          concept: { ...concept, status: kind === "new" ? "new" : "scheduled" },
          flagged: false,
        }),
      ),
    ...mac,
  ];
  if (!fresh) return list;
  const keep = list.map((item) => new URL(item.url, location.href).href);
  caching = caching.then(async () => {
    try {
      const cache = await caches.open("favorites");
      const kept = (await cache.keys()).map((request) => request.url);
      for (const url of kept) if (!keep.includes(url)) await cache.delete(url);
      const missing = keep.filter((url) => !kept.includes(url));
      for (const url of missing) await cache.add(url).catch((error) => console.warn("favorites", url, error));
      if (missing.length && !localStorage.getItem("persisted")) {
        localStorage.setItem("persisted", "true");
        void navigator.storage.persist().catch(() => {});
      }
    } catch (error) {
      // Cache Storage refused: a Favorite streams from the Mac instead.
      console.warn("favorites", error);
    }
  });
  return list;
}

/**
 * The flush in progress, so a second call joins it instead of sending the queue twice.
 */
let flushing: Promise<void> | undefined;
/**
 * Sends the queue in order. Stops at the first network failure and leaves the rest for the next try.
 */
export function flush() {
  flushing ??= (async () => {
    try {
      for (let queue = store.get<Queued>("queue"); queue.length; queue = store.get<Queued>("queue")) {
        const res = await fetch(queue[0].path, {
          method: "POST",
          body: JSON.stringify(queue[0].body),
          signal: AbortSignal.timeout(SYNC.timeoutMs),
        });
        // The Mac answered, so this press is settled; a rejected one would fail on every retry.
        if (!res.ok) console.error(`${queue[0].path} rejected`, res.status, queue[0]);
        store.set("queue", store.get("queue").slice(1));
      }
    } catch {
      // Mac unreachable: retried on reconnect, on the next interval, or on the next press.
    }
    // Reset in .finally(), which always runs after the assignment, even when the queue was empty.
  })().finally(() => (flushing = undefined));
  return flushing;
}

/**
 * Each Clip's buffering, by URL, in Feed order: settles once the Clip is in the cache, or once buffering it failed.
 */
const buffering = new Map<string, Promise<void>>();

/**
 * Settles once the Clip at `url` is buffered, or won't be; a Clip not being buffered settles at once.
 * Chrome fails a video whose Range requests are answered first by the network and then by the cache, so a Slide
 * plays its Clip only from here on.
 */
export const buffered = (url: string) => buffering.get(new URL(url, location.href).href) ?? Promise.resolve();

/**
 * Keeps the Feed's upcoming Clips in the cache the service worker plays them from, and drops the rest.
 * A Clip that fails to buffer is retried on the next call; offline, it then can't play.
 */
async function keepBuffer(slots: Slot[]) {
  const keep = slots.map((slot) => new URL(slot.url, location.href).href);
  // Registered before the first await, so the Slides about to render find their Clip's buffering.
  for (const url of buffering.keys()) if (!keep.includes(url)) buffering.delete(url);
  const pending = keep
    .filter((url) => !buffering.has(url))
    .map((url) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      buffering.set(url, promise);
      return { url, resolve };
    });
  try {
    const cache = await caches.open("clips");
    for (const request of await cache.keys()) if (!keep.includes(request.url)) await cache.delete(request);
    for (const { url, resolve } of pending) {
      if (!(await cache.match(url))) {
        await cache.add(url).catch((error) => {
          buffering.delete(url);
          console.warn("buffer", url, error);
        });
      }
      resolve();
    }
  } catch (error) {
    // Cache Storage refused (a private window, the quota): the Feed streams from the Mac instead.
    for (const { url, resolve } of pending) {
      buffering.delete(url);
      resolve();
    }
    console.warn("buffer", error);
  }
}

/**
 * Syncs, then returns the Feed's upcoming slots: the Mac's list less the Clips handled here and not synced yet.
 */
export async function next() {
  await flush();
  const { value: slots, fresh } = await lastGood<Slot[]>("/api/next");
  // The Mac has every press, so its list is the truth again.
  if (fresh && !store.get("queue").length) store.set("handled", []);
  const handled = new Set(store.get<number>("handled"));
  upcoming = (slots ?? [])
    .filter((slot) => !handled.has(slot.clipId))
    .map((slot) => ({ ...slot, favorite: isFavorite(slot.clipId, slot.favorite) }));
  if (fresh) keepBuffer(upcoming);
  return upcoming;
}
