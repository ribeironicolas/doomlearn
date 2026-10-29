import { parseArgs } from "node:util";
import { Refused } from "@doomlearn/core/media";
import { openData } from "@doomlearn/core/data";
import { localMedia } from "@doomlearn/media/local-media";
import { createSources } from "@doomlearn/core/sources";
import { workerStatus } from "@doomlearn/core/status";
import { usage } from "@doomlearn/core/stats";
import { COST_NOTE } from "@doomlearn/core/usage";
import * as api from "@doomlearn/core/api";
import { z } from "zod";

const {
  positionals: [command, arg],
  values,
} = parseArgs({
  allowPositionals: true,
  options: { title: { type: "string" }, by: { type: "string" }, provider: { type: "string" } },
});

if (command === "stats") {
  // The same grouping and filter as the usage route, every grouping unless one is asked for.
  const query = api.usage.safeParse({ by: values.by, provider: values.provider });
  if (!query.success) {
    console.error(z.prettifyError(query.error));
    process.exit(1);
  }
  const data = openData();
  for (const by of values.by ? [query.data.by] : api.USAGE_GROUPS) {
    console.log(`Agent usage per ${by}`);
    console.table(usage(data, by, { provider: query.data.provider }));
  }
  console.log(`apiEquivalentUsd: ${COST_NOTE}`);
  process.exit(0);
}

const help = `Usage: doomlearn add <file> [--title <title>]
       doomlearn status
       doomlearn retry <jobId>
       doomlearn pause <sourceId>
       doomlearn resume <sourceId>
       doomlearn reconvert <sourceId>
       doomlearn stats [--by provider|stage|day|source|clip] [--provider claude|codex]`;
if (!["add", "status", "retry", "pause", "resume", "reconvert"].includes(command) || (command !== "status" && !arg)) {
  console.error(help);
  process.exit(1);
}

const data = openData();
const sources = createSources(data, localMedia);
try {
  if (command === "add") {
    const source = await sources.add(arg, values);
    console.log(`Added ${source.title} (#${source.id})`);
  } else if (command === "reconvert") {
    console.log(`Reconverted Source #${arg} into ${await sources.reconvert(Number(arg))} chapters`);
  } else if (command === "status") {
    const { sources: perSource, queue } = sources.status();
    for (const source of perSource) {
      const { done, total } = source.chapters;
      const progress = [
        // Chapters extracted only: Clip jobs can still be open, and the Queue line counts them.
        `extracted ${done}/${total}`,
        `${source.concepts} Concepts`,
        ...(source.stuck.length ? [`${source.stuck.length} stuck`] : []),
        ...(source.status === "paused" ? ["paused"] : []),
      ];
      // Titles padded to a column.
      console.log(`#${source.id} ${source.title.padEnd(24)} ${progress.join(" · ")}`);
      for (const { jobId, chapter, attempts, lastError } of source.stuck) {
        console.log(
          `  ✗ ch. ${chapter.seq + 1} "${chapter.title}" (job ${jobId}): stuck after ${attempts} attempts: ${lastError}`,
        );
      }
    }
    const paused = queue.pausedUntil
      ? `paused until ${queue.pausedUntil.toTimeString().slice(0, "HH:MM".length)} (rate limit) · `
      : "";
    // The same job counts, Worker status and Blockers as GET /api/status.
    const { state, job, queue: jobCounts, blockers } = workerStatus(data);
    console.log(
      `Queue: ${jobCounts.running} running · ${jobCounts.queued} queued · ${jobCounts.stuck} stuck · ${paused}buffer ${queue.buffer.clips}/${queue.buffer.target} · today ${queue.today.clips}/${queue.today.cap} Clips`,
    );
    /** A time as local `YYYY-MM-DD HH:MM`. */
    const local = (date: Date) => date.toLocaleString("sv-SE").slice(0, "YYYY-MM-DD HH:MM".length);
    console.log(
      `Worker: ${state}${job ? ` ${job.stage} · job ${job.id}${job.source ? ` (${job.source})` : ""} · since ${local(job.since!)}` : ""}`,
    );
    for (const { reason, until } of blockers) console.log(`  ✗ ${reason}${until ? ` until ${local(until)}` : ""}`);
  } else {
    sources[command as "retry" | "pause" | "resume"](Number(arg));
    console.log(
      `${command === "retry" ? "Requeued job" : command === "pause" ? "Paused Source" : "Resumed Source"} #${arg}`,
    );
  }
} catch (error) {
  console.error((error as Error).message);
  // 2 means the Source was refused (scanned, DRM, duplicate); 1 any other failure.
  process.exit(error instanceof Refused ? 2 : 1);
}
