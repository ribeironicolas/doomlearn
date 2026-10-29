import { openData } from "@doomlearn/core/data";
import { serve } from "../server.ts";
import { superviseWorker } from "../supervisor.ts";

// main.ts forking `argv[2]` as its worker and restarting a crashed one after `argv[3]` ms, for the fork tests.
const data = openData();
serve(data);
superviseWorker(data, { file: process.argv[2], restartDelayMs: Number(process.argv[3]) });
// Exits when the test that spawned it is gone and its stdin pipe closes, as when a test run is killed mid-test: the
// server runs detached, so it would outlive the run, and its worker with it.
process.stdin.resume().on("end", () => process.exit(1));
