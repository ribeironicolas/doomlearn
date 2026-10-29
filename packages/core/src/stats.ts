import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm";
import type { USAGE_GROUPS } from "./api.ts";
import type { Data } from "./data.ts";
import { agentCalls, concepts, jobs, sources } from "./schema.ts";

/**
 * Agent usage from the `agent_calls` log, totalled per Provider, stage, local day, Source or Clip, optionally for one
 * Provider. Only Clip jobs' calls count toward a Clip, named by its Concept and Angle.
 * Sources and Clips are grouped by id, so two with the same name stay apart.
 * `apiEquivalentUsd` is Claude's list-price estimate, not a bill; Codex reports no cost, so a Codex-only group has null.
 */
export function usage(
  { db }: Data,
  by: (typeof USAGE_GROUPS)[number],
  { provider }: { provider?: "claude" | "codex" } = {},
) {
  const key = {
    provider: sql<string>`${agentCalls.provider}`,
    stage: sql<string>`${agentCalls.stage}`,
    day: sql<string>`date(${agentCalls.at} / 1000, 'unixepoch', 'localtime')`,
    source: sql<string>`${sources.title}`,
    clip: sql<string>`${concepts.title} || ' · ' || ${jobs.angle}`,
  }[by];
  const group = {
    provider: key,
    stage: key,
    day: key,
    source: agentCalls.sourceId,
    clip: sql`${jobs.conceptId}, ${jobs.angle}`,
  }[by];
  return db
    .select({
      key,
      calls: count(),
      errors: sql<number>`sum(${agentCalls.isError})`,
      apiEquivalentUsd: sql<number | null>`sum(${agentCalls.costUsd})`,
      tokensIn: sql<number>`total(${agentCalls.tokensIn})`,
      tokensOut: sql<number>`total(${agentCalls.tokensOut})`,
      durationMs: sql<number>`total(${agentCalls.durationMs})`,
    })
    .from(agentCalls)
    .leftJoin(sources, eq(sources.id, agentCalls.sourceId))
    .leftJoin(jobs, eq(jobs.id, agentCalls.jobId))
    .leftJoin(concepts, eq(concepts.id, jobs.conceptId))
    .where(and(isNotNull(key), provider ? eq(agentCalls.provider, provider) : undefined))
    .groupBy(group)
    .orderBy(asc(key))
    .all();
}
