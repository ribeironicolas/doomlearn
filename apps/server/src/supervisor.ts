import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Data } from "@doomlearn/core/data";
import { publishLiveness, workerStatus } from "@doomlearn/core/status";

/**
 * A crashed worker is restarted after 30 s, at most 3 times an hour; after that it stays down.
 */
const RESTART = { delayMs: 30_000, max: 3, perMs: 3_600_000 };

/**
 * Milliseconds per second, to say the restart delay in seconds.
 */
const SECOND_MS = 1000;

/**
 * SIGINTs this close together are one Ctrl+C: `pnpm start` forwards the terminal's SIGINT about 5 ms after it arrives.
 */
const SAME_CTRL_C_MS = 500;

/**
 * Forks the worker and keeps its liveness, from the fork handle, in the Worker status. A crash never stops the server.
 * The worker runs in its own process group, so Ctrl+C reaches the server alone: the first one stops the worker after
 * its current stage while the server keeps serving, the second stops it now; the server exits once it is down.
 * `file` and `restartDelayMs` are seams for tests.
 */
export function superviseWorker(
  data: Data,
  { file = fileURLToPath(new URL("./worker.ts", import.meta.url)), restartDelayMs = RESTART.delayMs } = {},
) {
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  let lastSigint = 0;
  /** When each restart in the last hour happened. */
  const restarts: number[] = [];

  /**
   * Forks the worker and watches it exit.
   */
  const start = () => {
    const worker = fork(file, { detached: true });
    child = worker;
    while (restarts.length && restarts[0] <= Date.now() - RESTART.perMs) restarts.shift();
    publishLiveness(data, { liveness: "running", restarts: restarts.length });
    worker.on("exit", (code, signal) => {
      child = undefined;
      if (stopping) {
        // Said here, not left to the pid check, which a later process reusing the pid would fool.
        publishLiveness(data, { liveness: "stopped", restarts: restarts.length });
        process.exit(0);
      }
      while (restarts.length && restarts[0] <= Date.now() - RESTART.perMs) restarts.shift();
      const down = restarts.length >= RESTART.max;
      const exitReason = `worker ${signal ? `killed by ${signal}` : `exited with code ${code}`}, ${
        down
          ? `restarted ${restarts.length} times in the last hour, staying down`
          : `restarting in ${restartDelayMs / SECOND_MS} s`
      }`;
      console.error(`doomlearn: ${exitReason}`);
      publishLiveness(data, { liveness: "stopped", exitReason, restarts: restarts.length });
      if (!down)
        timer = setTimeout(() => {
          restarts.push(Date.now());
          start();
        }, restartDelayMs);
    });
  };

  process.on("SIGINT", () => {
    if (Date.now() - lastSigint < SAME_CTRL_C_MS) return;
    lastSigint = Date.now();
    clearTimeout(timer);
    if (!child) process.exit(0);
    if (stopping) {
      console.log("doomlearn: stopping now");
      // The worker and its media tools; it kills its agent calls itself.
      process.kill(-child.pid!, "SIGINT");
      return;
    }
    stopping = true;
    const { job } = workerStatus(data);
    console.log(`doomlearn: stopping after current stage (${job ? `${job.stage}, ${job.source}` : "idle"})`);
    publishLiveness(data, { liveness: "stopping", restarts: restarts.length });
    child.kill("SIGINT");
  });
  start();
}
