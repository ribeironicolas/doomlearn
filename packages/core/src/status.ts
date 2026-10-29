import { count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { type Config, insideRunWindow } from "./config.ts";
import type { Data } from "./data.ts";
import type { Language } from "./languages.ts";
import {
  agentCalls,
  type Blocker,
  chapters,
  concepts,
  jobs,
  sources,
  workerStatus as workerStatusTable,
} from "./schema.ts";
import { usageThreshold } from "./usage.ts";

/**
 * The one `worker_status` row's id.
 */
const ID = 1;

/**
 * How far ahead the next Run window is looked for, a week (which covers every window), in steps of a minute.
 */
const LOOKAHEAD_MS = { week: 604_800_000, minute: 60_000 };

/**
 * Writes `values` into the one `worker_status` row, creating it on first use.
 */
function write({ db }: Pick<Data, "db">, values: Partial<typeof workerStatusTable.$inferInsert>) {
  db.insert(workerStatusTable)
    .values({ id: ID, ...values })
    .onConflictDoUpdate({ target: workerStatusTable.id, set: values })
    .run();
}

/**
 * The server's side of Worker status: the liveness it reads from the forked worker's handle. A crashed worker's
 * `exitReason` and the restarts in the last hour stay until the next fork.
 */
export function publishLiveness(
  data: Pick<Data, "db">,
  {
    liveness,
    exitReason = null,
    restarts = 0,
  }: { liveness: typeof workerStatusTable.$inferSelect.liveness; exitReason?: string | null; restarts?: number },
) {
  write(data, { liveness, exitReason, restarts, serverPid: process.pid });
}

/**
 * The worker's side: the stage it has just started on a job, or on no job (a preview), or `null` once it is over.
 */
export function publishStage(
  data: Pick<Data, "db">,
  stage: { jobId: number | null; stage: string; startedAt: Date } | null,
) {
  write(data, { jobId: stage?.jobId ?? null, stage: stage?.stage ?? null, stageStartedAt: stage?.startedAt ?? null });
}

/**
 * The worker's side: what its agent and media preflights found, each problem a Blocker until fixed. A media problem
 * names the Languages whose previews it holds.
 */
export function publishPreflight(
  data: Pick<Data, "db">,
  problems: (string | { reason: string; languages: Language[] })[],
) {
  write(data, {
    blockers: problems.map((problem) => ({
      kind: "preflight",
      until: null,
      ...(typeof problem === "string" ? { reason: problem } : problem),
    })),
  });
}

/**
 * The Blockers the worker checks at the start of each tick, from their own stores: a Worker pause and the Run windows
 * from config, the rate-limit pause from `agent_calls`, and the usage threshold from `usage_snapshots`.
 */
export function gates({ db }: Pick<Data, "db">, worker: Config["worker"], now: Date): Blocker[] {
  const found: Blocker[] = [];
  if (worker.paused) found.push({ kind: "worker_pause", reason: "Worker pause until resumed", until: null });
  else if (worker.pausedUntil && now < new Date(worker.pausedUntil))
    found.push({ kind: "worker_pause", reason: "Worker pause", until: new Date(worker.pausedUntil) });
  if (!insideRunWindow(worker.schedule, now)) {
    // The next whole minute inside a window. The worker's tick pays for it too: at most about 2.5 ms, a week of minutes.
    const minute = new Date(now).setSeconds(0, 0);
    let until: Date | null = null;
    for (let at = minute + LOOKAHEAD_MS.minute; at <= minute + LOOKAHEAD_MS.week && !until; at += LOOKAHEAD_MS.minute)
      if (insideRunWindow(worker.schedule, new Date(at))) until = new Date(at);
    found.push({ kind: "outside_run_window", reason: "outside the Run windows", until });
  }
  // The Agent port logs a rate-limited call with its retry time, so the pause survives a restart.
  const limited = db
    .select({ provider: agentCalls.provider, retryAt: agentCalls.retryAt })
    .from(agentCalls)
    .where(isNotNull(agentCalls.retryAt))
    .orderBy(desc(agentCalls.retryAt))
    .get();
  // A v1 row has no provider: v1 called Claude only.
  if (limited?.retryAt && now < limited.retryAt)
    found.push({ kind: "rate_limited", reason: `${limited.provider ?? "claude"} rate limit`, until: limited.retryAt });
  const threshold = usageThreshold({ db }, worker.stopAtUsagePercent, now);
  if (threshold) {
    const percent =
      threshold.window === "five_hour" ? worker.stopAtUsagePercent?.fiveHour : worker.stopAtUsagePercent?.sevenDay;
    found.push({
      kind: "usage_threshold",
      reason: `Claude ${threshold.window} Usage window at ${percent}% or more`,
      until: threshold.until,
    });
  }
  return found;
}

/**
 * Whether process `pid` exists. EPERM means it does, under another user.
 */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The Worker status the PWA and `doomlearn status` show: running (on a stage), idle, stopping or stopped; the job and
 * stage it is on since when; the stage alone, which a preview has with no job; the queue's job counts by status; and
 * every active Blocker, with no precedence.
 */
export function workerStatus(data: Pick<Data, "db" | "config" | "configError">, now = new Date()) {
  const { db } = data;
  const status = db.select().from(workerStatusTable).where(eq(workerStatusTable.id, ID)).get();
  // A row left by a server that is gone says nothing about the worker.
  const serverUp = status?.serverPid != null && alive(status.serverPid);
  const liveness = serverUp ? status.liveness : "stopped";
  const blockers: Blocker[] = [];
  if (!serverUp) blockers.push({ kind: "stopped", reason: "server not running: run `pnpm start`", until: null });
  else if (liveness === "stopped")
    blockers.push({ kind: "stopped", reason: status.exitReason ?? "worker not running", until: null });
  else if (liveness === "stopping")
    blockers.push({ kind: "stopping", reason: "stopping after current stage", until: null });
  if (liveness !== "stopped") blockers.push(...status!.blockers);
  const { worker } = data.config();
  const configError = data.configError();
  if (configError) blockers.push({ kind: "invalid_config", reason: configError, until: null });
  blockers.push(...gates(data, worker, now));

  const job =
    liveness !== "stopped" && status?.jobId
      ? db
          .select({ id: jobs.id, kind: jobs.kind, source: sources.title })
          .from(jobs)
          .leftJoin(chapters, eq(chapters.id, jobs.chapterId))
          .leftJoin(concepts, eq(concepts.id, jobs.conceptId))
          .leftJoin(sources, eq(sources.id, sql`coalesce(${chapters.sourceId}, ${concepts.sourceId})`))
          .where(eq(jobs.id, status.jobId))
          .get()
      : undefined;
  const queue = { queued: 0, running: 0, paused: 0, stuck: 0, done: 0, cancelled: 0 };
  for (const { status: name, jobs: total } of db
    .select({ status: jobs.status, jobs: count() })
    .from(jobs)
    .groupBy(jobs.status)
    .all())
    queue[name] = total;
  return {
    state: liveness === "running" ? (job ? "running" : "idle") : liveness,
    job: job ? { ...job, stage: status!.stage, since: status!.stageStartedAt } : null,
    // Set with no job too, while the worker speaks a preview.
    stage: status?.stage ?? null,
    restarts: status?.restarts ?? 0,
    queue,
    blockers,
  };
}
