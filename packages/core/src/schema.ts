import { integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { LANGUAGE_TAGS, type Language } from "./languages.ts";

/**
 * The fixed set of body structures a Clip can use after its hook.
 * (Concept, Angle, Language) is unique per Clip.
 */
export const ANGLES = ["concrete_example", "analogy", "mechanism", "contrast"] as const;
export type Angle = (typeof ANGLES)[number];

/**
 * Where a Passage sits in its Source: a page range (PDF) or a TOC chapter/section (ebook, text).
 */
export type Anchor = { pages: [number, number] } | { chapter: string; section?: string | null };

/**
 * Higher runs first: a 🚩 Clip the Learner asked to regenerate, then new-Angle Clips and Translations, then
 * new-Concept Clips, then chapter extraction.
 */
export const JOB_PRIORITY = { regenerate: 3, new_angle: 2, translate: 2, new: 1, extract_chapter: 0 } as const;

/**
 * A `created_at` column, set to the insert time.
 */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  type: text("type", { enum: ["pdf", "txt", "md", "epub", "azw3"] }).notNull(),
  status: text("status", { enum: ["active", "paused"] })
    .notNull()
    .default("active"),
  sha256: text("sha256").notNull().unique(),
  createdAt: createdAt(),
});

export const chapters = sqliteTable("chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("source_id")
    .notNull()
    .references(() => sources.id),
  /**
   * Position in the Source; also names the chapter text file.
   */
  seq: integer("seq").notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["pending", "extracted"] })
    .notNull()
    .default("pending"),
  pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});

export const concepts = sqliteTable("concepts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status", { enum: ["new", "scheduled", "retired"] })
    .notNull()
    .default("new"),
  /**
   * 0–4 on the 1d → 3d → 7d → 21d → 60d ladder; null while new.
   */
  ladderStep: integer("ladder_step"),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  retiredReason: text("retired_reason", { enum: ["known", "graduated"] }),
  notLandingAt: integer("not_landing_at", { mode: "timestamp_ms" }),
  /**
   * Ranked best fit first; written once at extraction.
   */
  fitAngles: text("fit_angles", { mode: "json" }).$type<Angle[]>().notNull(),
  /**
   * First Source the Concept appeared in; with `seq` it drives round-robin.
   */
  sourceId: integer("source_id")
    .notNull()
    .references(() => sources.id),
  seq: integer("seq").notNull(),
  /**
   * Came out of a split, so it is never split again.
   */
  fromSplit: integer("from_split", { mode: "boolean" }).notNull().default(false),
  pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
  /**
   * Set only by a delete by hand; a Concept that goes with its chapter keeps it null.
   */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

export const passages = sqliteTable("passages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conceptId: integer("concept_id")
    .notNull()
    .references(() => concepts.id),
  sourceId: integer("source_id")
    .notNull()
    .references(() => sources.id),
  anchor: text("anchor", { mode: "json" }).$type<Anchor>().notNull(),
  /**
   * The chapter the Passage was extracted from; null only for a Passage the chapter_id backfill could not map.
   */
  chapterId: integer("chapter_id").references(() => chapters.id),
  /**
   * Sliced from the converted Source text, never written by the agent.
   */
  text: text("text").notNull(),
});

export const clips = sqliteTable(
  "clips",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conceptId: integer("concept_id")
      .notNull()
      .references(() => concepts.id),
    angle: text("angle", { enum: ANGLES }).notNull(),
    /**
     * The BCP 47 tag of the Language the Clip is spoken and captioned in.
     */
    language: text("language", { enum: LANGUAGE_TAGS }).notNull().default("pt-BR"),
    script: text("script").notNull(),
    caption: text("caption").notNull(),
    file: text("file").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.conceptId, t.angle, t.language)],
);

/**
 * Append-only history; state lives in the columns each event changes.
 */
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clipId: integer("clip_id")
    .notNull()
    .references(() => clips.id),
  kind: text("kind", { enum: ["seen", "got_it", "didnt_get", "know", "flag"] }).notNull(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  reason: text("reason"),
  note: text("note"),
  /**
   * When the Learner marked a 🚩 resolved in the inbox; the one column of an event that changes after it's written.
   */
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  /** Makes offline press syncs idempotent. */
  clientEventId: text("client_event_id").unique(),
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /**
   * `regenerate` remakes the Clip of its (Concept, Angle, Language) in place, from the Clip's stored script.
   */
  kind: text("kind", { enum: ["new", "new_angle", "regenerate", "translate", "extract_chapter"] }).notNull(),
  priority: integer("priority").notNull(),
  status: text("status", { enum: ["queued", "running", "paused", "stuck", "done", "cancelled"] })
    .notNull()
    .default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /**
   * Last stage completed; the stage files in the job folder are the source of truth for resuming.
   */
  stage: text("stage"),
  chapterId: integer("chapter_id").references(() => chapters.id),
  conceptId: integer("concept_id").references(() => concepts.id),
  angle: text("angle", { enum: ANGLES }),
  /**
   * The Language the job's Clip is made in. Null on extraction jobs and on `new` and `new_angle` jobs (those still
   * queued at the clip_language migration, and every one queued since); their Clip takes the `clips.language` default.
   */
  language: text("language", { enum: LANGUAGE_TAGS }),
  /**
   * The Clip a `translate` job makes its Clip from.
   */
  fromClipId: integer("from_clip_id").references(() => clips.id),
  /**
   * The delete that cancelled the job, `chapter:<id>` or `concept:<id>`, for the Learner and for debugging. A Restore
   * does not read it: a cancelled job is requeued once its chapter or Concept is live again.
   */
  cancelledBy: text("cancelled_by"),
  createdAt: createdAt(),
});

/**
 * One row per agent call, from either Provider. Renamed from `claude_calls`; its v1 rows are Claude calls.
 */
export const agentCalls = sqliteTable("agent_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stage: text("stage").notNull(),
  provider: text("provider", { enum: ["claude", "codex"] }),
  /**
   * The model and Effort as configured for the stage, not the id the Provider resolved them to.
   */
  model: text("model"),
  effort: text("effort"),
  jobId: integer("job_id").references(() => jobs.id),
  sourceId: integer("source_id").references(() => sources.id),
  costUsd: real("cost_usd"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  durationMs: integer("duration_ms").notNull(),
  isError: integer("is_error", { mode: "boolean" }).notNull(),
  apiErrorStatus: integer("api_error_status"),
  /**
   * Why a failed call failed.
   */
  error: text("error"),
  /**
   * Set on a rate-limited call: the whole queue is paused until the latest one.
   */
  retryAt: integer("retry_at", { mode: "timestamp_ms" }),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Append-only: one row per Usage window per reading, from a Claude call's `rate_limit_event` (`callId` set) or from
 * the Codex limits probe (after a Codex call, or when usage is asked for). The newest row per window is the current one.
 */
export const usageSnapshots = sqliteTable("usage_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider", { enum: ["claude", "codex"] }).notNull(),
  /** As the Provider names it, e.g. `five_hour`, `seven_day`. */
  window: text("window").notNull(),
  /** 0-1; null when the Provider reported only a status. */
  utilization: real("utilization"),
  resetsAt: integer("resets_at", { mode: "timestamp_ms" }),
  status: text("status"),
  source: text("source", { enum: ["unified", "typed", "status_only", "probe"] }).notNull(),
  callId: integer("call_id").references(() => agentCalls.id),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * The Learner's Favorites: a Clip is one while its row exists.
 */
export const favorites = sqliteTable("favorites", {
  clipId: integer("clip_id")
    .primaryKey()
    .references(() => clips.id),
  createdAt: createdAt(),
});

/**
 * A sentence the worker speaks for the fix sheet to play, in the Clip's Language, before the Learner saves a fix.
 */
export const previews = sqliteTable("previews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clipId: integer("clip_id")
    .notNull()
    .references(() => clips.id),
  language: text("language", { enum: LANGUAGE_TAGS }).notNull(),
  text: text("text").notNull(),
  status: text("status", { enum: ["queued", "speaking", "done", "failed", "superseded", "played"] })
    .notNull()
    .default("queued"),
  wavPath: text("wav_path"),
  error: text("error"),
  createdAt: createdAt(),
});

/**
 * A reason the worker will not start a new stage, with when it lifts, if known. Several can be active at once.
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
  until: Date | null;
  /** For a media preflight failure: the Languages whose previews it holds too (all of them, or a voice's own). */
  languages?: Language[];
};

/**
 * One row (id 1): the Worker status the server and `doomlearn status` read. The server writes the liveness it gets
 * from the forked worker's handle; the worker writes the stage it is running and the Blockers only it can see.
 */
export const workerStatus = sqliteTable("worker_status", {
  id: integer("id").primaryKey(),
  /** From the fork handle: whether the worker process is up, asked to stop after its stage, or down. */
  liveness: text("liveness", { enum: ["running", "stopping", "stopped"] })
    .notNull()
    .default("stopped"),
  /** The server process that forked the worker, so a reader can tell a row left by a server that is gone. */
  serverPid: integer("server_pid"),
  /** Why the worker last went down, e.g. `exited with code 1`. */
  exitReason: text("exit_reason"),
  /** How many times a crashed worker was restarted in the last hour. */
  restarts: integer("restarts").notNull().default(0),
  jobId: integer("job_id").references(() => jobs.id),
  stage: text("stage"),
  stageStartedAt: integer("stage_started_at", { mode: "timestamp_ms" }),
  /** The preflight failures the worker found, as Blockers. */
  blockers: text("blockers", { mode: "json" }).$type<Blocker[]>().notNull().default([]),
});
