import type { USAGE_GROUPS } from "./api.ts";
import { and, asc, desc, eq, gt, inArray, isNotNull, max, notExists, type SQL } from "drizzle-orm";
import type { Config } from "./config.ts";
import type { Data } from "./data.ts";
import { agentCalls, usageSnapshots } from "./schema.ts";
import { usage } from "./stats.ts";

/**
 * A Provider, as `agents.stages` and the logs name it.
 */
type ProviderName = "claude" | "codex";

/**
 * One reading of a Usage window, as a Provider reports it. `utilization` is 0-1, or null when the Provider
 * gave only a status. `source` says how it was read: Claude's `unifiedWindows`, its typed `utilization`, its
 * `status` alone, or the Codex limits probe.
 */
export type UsageReading = {
  window: string;
  utilization: number | null;
  resetsAt: Date | null;
  status: string | null;
  source: "unified" | "typed" | "status_only" | "probe";
};

/**
 * Appends `readings` of `provider`'s Usage windows as captured now, tied to the agent call they came with, if any.
 */
export function recordUsage(
  { db }: Pick<Data, "db">,
  provider: ProviderName,
  readings: UsageReading[],
  callId?: number,
) {
  if (!readings.length) return;
  const capturedAt = new Date();
  db.insert(usageSnapshots)
    .values(readings.map((reading) => ({ ...reading, provider, callId, capturedAt })))
    .run();
}

/**
 * Percent in a whole Usage window: thresholds are percentages, readings fractions.
 */
const FULL_PERCENT = 100;

/**
 * The Claude Usage window `worker.stopAtUsagePercent` stops the worker for at `now`, and until when: one whose newest
 * reading is at or above its threshold and has not reset yet. Fails open: no threshold, no reading, a reading with no
 * utilization or one past its reset never stops it.
 */
export function usageThreshold(
  { db }: Pick<Data, "db">,
  thresholds: Config["worker"]["stopAtUsagePercent"],
  now: Date,
): { window: string; until: Date } | undefined {
  for (const [window, threshold] of [
    ["five_hour", thresholds?.fiveHour],
    ["seven_day", thresholds?.sevenDay],
  ] as const) {
    if (threshold === undefined) continue;
    // The table is append-only, so the highest id is the newest reading.
    const reading = db
      .select()
      .from(usageSnapshots)
      .where(and(eq(usageSnapshots.provider, "claude"), eq(usageSnapshots.window, window)))
      .orderBy(desc(usageSnapshots.id))
      .get();
    // Utilization comes in 1% steps, so 0.29 is 29%, not 28.999….
    if (reading?.utilization != null && reading.resetsAt && now < reading.resetsAt) {
      if (Math.round(reading.utilization * FULL_PERCENT) >= threshold) return { window, until: reading.resetsAt };
    }
  }
}

/**
 * What the usage screen shows next to doomlearn's own consumption.
 */
export const COST_NOTE = "Claude cost is API-equivalent: its list price, not a bill. Codex reports no cost.";

/**
 * The Usage windows of each Provider a stage is set to, doomlearn's own consumption grouped `by` (for one `provider`
 * if given), past rate-limit pauses, and parse drift, as of `now`.
 * A window is its newest reading, with its age and, once past its reset, "reset since HH:MM". A Provider is
 * `unavailable` with a reason (`unavailable` passes the ones only the caller knows: an API-key login, a failed probe)
 * when it has no reading yet, or its last Claude call carried no usage or only a status. Its last readings stay listed.
 * Drift is the last Claude call that reached the model turn (it printed output tokens) without a saved reading; it is
 * derived, never stored, and not looked for under an API-key login. v1 calls, which name no model, are not looked at.
 */
export function usageReport(
  data: Data,
  {
    by,
    provider,
    unavailable = {},
    now = new Date(),
  }: {
    by: (typeof USAGE_GROUPS)[number];
    provider?: ProviderName;
    unavailable?: Partial<Record<ProviderName, string>>;
    now?: Date;
  },
) {
  const { db } = data;
  const lastClaudeCall = db
    .select({ callId: agentCalls.id, at: agentCalls.at })
    .from(agentCalls)
    .where(and(eq(agentCalls.provider, "claude"), isNotNull(agentCalls.model), gt(agentCalls.tokensOut, 0)))
    .orderBy(desc(agentCalls.id))
    .get();
  const drift =
    lastClaudeCall &&
    !unavailable.claude &&
    !db.select().from(usageSnapshots).where(eq(usageSnapshots.callId, lastClaudeCall.callId)).get()
      ? lastClaudeCall
      : null;
  const newestIds = db
    .select({ id: max(usageSnapshots.id) })
    .from(usageSnapshots)
    .groupBy(usageSnapshots.provider, usageSnapshots.window);
  const used = [...new Set(Object.values(data.config().agents.stages).map((stage) => stage.provider))].sort();
  const providers = used.map((name) => {
    const windows = db
      .select()
      .from(usageSnapshots)
      .where(and(eq(usageSnapshots.provider, name), inArray(usageSnapshots.id, newestIds)))
      .orderBy(asc(usageSnapshots.id))
      .all()
      .map(({ window, utilization, resetsAt, status, source, capturedAt }) => ({
        window,
        utilization,
        resetsAt,
        status,
        source,
        capturedAt,
        ageMs: now.getTime() - capturedAt.getTime(),
        resetSince: resetsAt && now >= resetsAt ? resetsAt.toTimeString().slice(0, "HH:MM".length) : null,
      }));
    const last = windows.at(-1);
    const reason =
      unavailable[name] ??
      (!windows.length
        ? "no reading yet"
        : name === "claude" && drift
          ? "the Claude CLI reported no usage on its last call"
          : name === "claude" && last?.utilization === null
            ? "the Claude CLI reported no windows on its last call"
            : null);
    return { provider: name, unavailable: reason, windows };
  });
  const pauses = db
    .select({
      at: agentCalls.at,
      provider: agentCalls.provider,
      stage: agentCalls.stage,
      until: agentCalls.retryAt,
      // A Codex reset the probe did not confirm is the parser's 15 min estimate.
      estimated: and(
        eq(agentCalls.provider, "codex"),
        notExists(
          db
            .select()
            .from(usageSnapshots)
            .where(and(eq(usageSnapshots.callId, agentCalls.id), eq(usageSnapshots.resetsAt, agentCalls.retryAt))),
        ),
      ) as SQL<number>,
    })
    .from(agentCalls)
    .where(isNotNull(agentCalls.retryAt))
    .orderBy(desc(agentCalls.at))
    .all()
    .map(({ until, estimated, ...pause }) => ({
      ...pause,
      until: until as Date,
      durationMs: (until as Date).getTime() - pause.at.getTime(),
      estimated: Boolean(estimated),
    }));
  return { providers, consumption: usage(data, by, { provider }), costNote: COST_NOTE, pauses, drift };
}
