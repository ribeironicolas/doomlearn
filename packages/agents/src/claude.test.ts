import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parseClaudeOutput } from "./claude.ts";

/**
 * Outputs recorded from `claude -p` 2.1.293 with the pipeline's flags: a real call on the Learner's login,
 * and 400/429 answers from a local mock API. The `rejected` rate_limit_event is spliced into
 * the 429 from the shape of a real `allowed` one, since a real rejection hasn't been seen yet.
 */
function recorded(name: string) {
  return readFileSync(new URL(`./test/claude/${name}.json`, import.meta.url), "utf8");
}

test("a successful call yields its structured output, its cost, its tokens and the model id it resolved to", () => {
  const { outcome, costUsd, tokensIn, tokensOut, resolvedModel } = parseClaudeOutput(recorded("success"));
  assert.deepEqual(outcome, { ok: true, output: { ok: true } });
  assert.equal(costUsd, 0.011936);
  // Cached input counts too: it is what the call read.
  assert.equal(tokensIn, 2 + 1361);
  assert.equal(tokensOut, 52);
  assert.equal(resolvedModel, "claude-opus-5-5");
});

test("an API error fails the call even though its subtype reads success", () => {
  const { outcome } = parseClaudeOutput(recorded("error"), "exit 1");
  assert.deepEqual(outcome, { ok: false, error: "API Error: 400 Bad request" });
});

test("a 429 without a rate_limit_event retries in 15 min", () => {
  const before = Date.now();
  const { outcome } = parseClaudeOutput(recorded("rate-limited"), "exit 1");
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.retryAt);
  assert.ok(outcome.retryAt.getTime() >= before + 15 * 60_000 && outcome.retryAt.getTime() <= Date.now() + 15 * 60_000);
});

test("a 429 with a rejected rate_limit_event retries at its resetsAt", () => {
  const { outcome } = parseClaudeOutput(recorded("rate-limited-rejected"), "exit 1");
  assert.deepEqual(outcome, {
    ok: false,
    error: "API Error: Request rejected (429) · Rate limited",
    retryAt: new Date(1791464400 * 1000),
  });
});

test("a non-zero exit without output fails with why it exited", () => {
  const { outcome } = parseClaudeOutput("", "Error: --json-schema is not valid JSON");
  assert.deepEqual(outcome, { ok: false, error: "Error: --json-schema is not valid JSON" });
});

//
// Usage windows from the rate_limit_event. `usage-unified` is a real haiku call on 2.1.295 (2026-10-09);
// the typed-only, status-only and missing variants are cut from it, and the rejected one is the 429 above.
//

test("a rate_limit_event with unifiedWindows yields one reading per window", () => {
  const { outcome, usage } = parseClaudeOutput(recorded("usage-unified"));
  assert.equal(outcome.ok, true);
  assert.deepEqual(usage, [
    {
      window: "five_hour",
      utilization: 0.13,
      resetsAt: new Date(1791519000 * 1000),
      status: "allowed",
      source: "unified",
    },
    {
      window: "seven_day",
      utilization: 0.03,
      resetsAt: new Date(1792108800 * 1000),
      status: "allowed",
      source: "unified",
    },
  ]);
});

test("without unifiedWindows, the typed utilization and rateLimitType yield one reading", () => {
  assert.deepEqual(parseClaudeOutput(recorded("usage-typed-only")).usage, [
    {
      window: "five_hour",
      utilization: 0.13,
      resetsAt: new Date(1791519000 * 1000),
      status: "allowed",
      source: "typed",
    },
  ]);
});

test("with only a status, the reading has no utilization", () => {
  assert.deepEqual(parseClaudeOutput(recorded("usage-status-only")).usage, [
    {
      window: "five_hour",
      utilization: null,
      resetsAt: new Date(1791519000 * 1000),
      status: "allowed",
      source: "status_only",
    },
  ]);
});

test("no rate_limit_event yields no reading, and the call still succeeds", () => {
  const { outcome, usage } = parseClaudeOutput(recorded("usage-missing"));
  assert.equal(outcome.ok, true);
  assert.deepEqual(usage, []);
});

test("a rejected rate_limit_event is read like any other", () => {
  const { usage } = parseClaudeOutput(recorded("rate-limited-rejected"), "exit 1");
  assert.deepEqual(
    usage?.map(({ window, utilization, status }) => ({ window, utilization, status })),
    [
      { window: "five_hour", utilization: 1, status: "rejected" },
      { window: "seven_day", utilization: 0.27, status: "rejected" },
    ],
  );
});

test("a malformed rate_limit_event or one on a 0-100 scale yields no reading and never fails the call", () => {
  const messages = JSON.parse(recorded("usage-unified"));
  const withInfo = (info: unknown) =>
    JSON.stringify(
      messages.map((m: { type: string }) => (m.type === "rate_limit_event" ? { ...m, rate_limit_info: info } : m)),
    );
  for (const info of [
    "allowed",
    null,
    { status: "allowed", unifiedWindows: { five_hour: { utilization: 13, resetsAt: 1791519000 } } },
    { status: "allowed", rateLimitType: "five_hour", utilization: 72 },
  ]) {
    const { outcome, usage } = parseClaudeOutput(withInfo(info));
    assert.equal(outcome.ok, true, JSON.stringify(info));
    assert.deepEqual(usage, [], JSON.stringify(info));
  }
});
