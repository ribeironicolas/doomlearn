import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { type Data, openData } from "./data.ts";
import { agentCalls } from "./schema.ts";
import { editConfig } from "./test/fakes.ts";
import { recordUsage, type UsageReading, usageReport } from "./usage.ts";

/**
 * Noon on 2026-10-09, local time: the clock every test starts at.
 */
const NOON = new Date(2026, 9, 9, 12, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOON });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A fresh data folder, every stage on Claude unless `config` says otherwise.
 */
async function setup(config?: object) {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  const data = openData(home);
  if (config) await editConfig(home, config);
  return data;
}

/**
 * Logs one agent call made now and returns its id. By default a Claude call that reached the model turn.
 */
function logCall(data: Data, values: Partial<typeof agentCalls.$inferInsert> = {}) {
  return data.db
    .insert(agentCalls)
    .values({
      stage: "script",
      provider: "claude",
      model: "opus",
      durationMs: 1000,
      isError: false,
      tokensOut: 50,
      at: new Date(),
      ...values,
    })
    .returning()
    .get().id;
}

/**
 * A `unified` Claude reading of `window`.
 */
const reading = (window: string, utilization: number | null, resetsAt: Date): UsageReading => ({
  window,
  utilization,
  resetsAt,
  status: "allowed",
  source: utilization === null ? "status_only" : "unified",
});

/**
 * The scene stage on Codex, so the report lists both Providers.
 */
const SOME_CODEX = { agents: { stages: { scene: { provider: "codex", model: "gpt-6-sol", effort: "low" } } } };

test('each window shows its newest reading with its age, and "reset since HH:MM" once past its reset', async () => {
  const data = await setup();
  recordUsage(data, "claude", [reading("five_hour", 0.1, new Date(2026, 9, 9, 14, 30))], logCall(data));
  vi.advanceTimersByTime(HOUR_MS);
  const callId = logCall(data);
  recordUsage(
    data,
    "claude",
    [reading("five_hour", 0.4, new Date(2026, 9, 9, 14, 30)), reading("seven_day", 0.2, new Date(2026, 9, 12))],
    callId,
  );
  vi.advanceTimersByTime(2 * HOUR_MS);

  const { providers, drift } = usageReport(data, { by: "provider" });

  assert.deepEqual(providers, [
    {
      provider: "claude",
      unavailable: null,
      windows: [
        {
          window: "five_hour",
          utilization: 0.4,
          resetsAt: new Date(2026, 9, 9, 14, 30),
          status: "allowed",
          source: "unified",
          capturedAt: new Date(2026, 9, 9, 13, 0),
          ageMs: 2 * HOUR_MS,
          resetSince: "14:30",
        },
        {
          window: "seven_day",
          utilization: 0.2,
          resetsAt: new Date(2026, 9, 12),
          status: "allowed",
          source: "unified",
          capturedAt: new Date(2026, 9, 9, 13, 0),
          ageMs: 2 * HOUR_MS,
          resetSince: null,
        },
      ],
    },
  ]);
  assert.equal(drift, null);
});

test("a Provider with no reading yet is unavailable, never a healthy 0%", async () => {
  const data = await setup(SOME_CODEX);

  assert.deepEqual(usageReport(data, { by: "provider" }).providers, [
    { provider: "claude", unavailable: "no reading yet", windows: [] },
    { provider: "codex", unavailable: "no reading yet", windows: [] },
  ]);
});

test("an API-key login or a failed Codex probe is unavailable with its reason, the last windows kept with their age", async () => {
  const data = await setup(SOME_CODEX);
  recordUsage(data, "claude", [reading("five_hour", 0.4, new Date(2026, 9, 9, 14))], logCall(data));
  recordUsage(data, "codex", [
    { ...reading("five_hour", 0.3, new Date(2026, 9, 9, 15)), status: null, source: "probe" },
  ]);
  vi.advanceTimersByTime(MINUTE_MS);

  const { providers } = usageReport(data, {
    by: "provider",
    unavailable: { claude: "api_key login has no plan windows", codex: "codex probe timed out" },
  });

  assert.deepEqual(
    providers.map(({ provider, unavailable, windows }) => ({
      provider,
      unavailable,
      windows: windows.map(({ window, utilization, ageMs }) => ({ window, utilization, ageMs })),
    })),
    [
      {
        provider: "claude",
        unavailable: "api_key login has no plan windows",
        windows: [{ window: "five_hour", utilization: 0.4, ageMs: MINUTE_MS }],
      },
      {
        provider: "codex",
        unavailable: "codex probe timed out",
        windows: [{ window: "five_hour", utilization: 0.3, ageMs: MINUTE_MS }],
      },
    ],
  );
});

test("a last Claude call that carried only a status says the CLI reported no windows", async () => {
  const data = await setup();
  recordUsage(data, "claude", [reading("five_hour", 0.4, new Date(2026, 9, 9, 14))], logCall(data));
  vi.advanceTimersByTime(MINUTE_MS);
  recordUsage(data, "claude", [reading("five_hour", null, new Date(2026, 9, 9, 14))], logCall(data));

  const [claude] = usageReport(data, { by: "provider" }).providers;
  assert.equal(claude.unavailable, "the Claude CLI reported no windows on its last call");
  assert.equal(claude.windows[0].utilization, null);
});

test("drift: the last Claude call that reached the model turn saved no reading", async () => {
  const data = await setup();
  recordUsage(data, "claude", [reading("five_hour", 0.4, new Date(2026, 9, 9, 14))], logCall(data));
  vi.advanceTimersByTime(MINUTE_MS);
  const silent = logCall(data);

  const { providers, drift } = usageReport(data, { by: "provider" });
  assert.deepEqual(drift, { callId: silent, at: new Date(NOON.getTime() + MINUTE_MS) });
  assert.equal(providers[0].unavailable, "the Claude CLI reported no usage on its last call");
});

test("drift skips Codex calls, calls that failed before the model turn, and an API-key login", async () => {
  const data = await setup(SOME_CODEX);
  recordUsage(data, "claude", [reading("five_hour", 0.4, new Date(2026, 9, 9, 14))], logCall(data));
  vi.advanceTimersByTime(MINUTE_MS);
  logCall(data, { provider: "codex", costUsd: null });
  // A 400 answered before the model turn, and a call killed before it printed anything.
  logCall(data, { isError: true, apiErrorStatus: 400, tokensOut: 0 });
  logCall(data, { isError: true, tokensOut: null });

  assert.equal(usageReport(data, { by: "provider" }).drift, null);

  logCall(data);
  assert.equal(
    usageReport(data, { by: "provider", unavailable: { claude: "api_key login has no plan windows" } }).drift,
    null,
  );
});

test("past rate-limit pauses list when, Provider, stage, until and duration; a Codex 15 min fallback is estimated", async () => {
  const data = await setup(SOME_CODEX);
  const at = (hour: number) => new Date(2026, 9, 9, hour);
  logCall(data, { stage: "extract", at: at(8), isError: true, apiErrorStatus: 429, retryAt: at(10) });
  const probed = logCall(data, { provider: "codex", stage: "scene", at: at(9), isError: true, retryAt: at(11) });
  recordUsage(data, "codex", [{ ...reading("five_hour", 1, at(11)), status: null, source: "probe" }], probed);
  const fallback = new Date(at(10).getTime() + 15 * MINUTE_MS);
  logCall(data, { provider: "codex", stage: "script", at: at(10), isError: true, retryAt: fallback });

  assert.deepEqual(usageReport(data, { by: "provider" }).pauses, [
    { at: at(10), provider: "codex", stage: "script", until: fallback, durationMs: 15 * MINUTE_MS, estimated: true },
    { at: at(9), provider: "codex", stage: "scene", until: at(11), durationMs: 2 * HOUR_MS, estimated: false },
    { at: at(8), provider: "claude", stage: "extract", until: at(10), durationMs: 2 * HOUR_MS, estimated: false },
  ]);
});

test("consumption is grouped as asked, for one Provider if asked, with the cost labelled API-equivalent", async () => {
  const data = await setup(SOME_CODEX);
  logCall(data, { stage: "extract", costUsd: 0.5, tokensIn: 100, tokensOut: 10 });
  logCall(data, { provider: "codex", stage: "scene", costUsd: null, tokensIn: 300, tokensOut: 30 });

  const report = usageReport(data, { by: "stage", provider: "codex" });
  assert.deepEqual(report.consumption, [
    { key: "scene", calls: 1, errors: 0, apiEquivalentUsd: null, tokensIn: 300, tokensOut: 30, durationMs: 1000 },
  ]);
  assert.match(report.costNote, /API-equivalent/);
});
