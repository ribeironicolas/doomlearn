import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parseCodexOutput } from "./codex.ts";

/**
 * Outputs of `codex exec --json` 0.162.0. `success` and `error` (an unknown model) are recorded from real calls with
 * doomlearn's argv. `usage-limit` is built from codex's source strings: unverified until a real lockout is captured.
 * `non-tool-items` is `success` with the valid non-tool items spliced in, in the shapes codex's exec events define.
 */
function recorded(name: string) {
  return readFileSync(new URL(`./test/codex/${name}.jsonl`, import.meta.url), "utf8");
}

test("a successful call yields its parsed agent message, tokens from input_tokens and output_tokens, and no cost", () => {
  assert.deepEqual(parseCodexOutput(recorded("success")), {
    outcome: { ok: true, output: { ok: true, problems: [] } },
    tokensIn: 5125,
    tokensOut: 19,
    costUsd: null,
  });
});

test("a failed turn fails the call with its message", () => {
  const { outcome, tokensIn } = parseCodexOutput(recorded("error"), "exit 1");
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : "", /The 'no-such-model' model is not supported/);
  assert.equal(!outcome.ok && outcome.retryAt, undefined);
  assert.equal(tokensIn, undefined);
});

test("a usage limit (unverified fixture) is rate-limited, retrying in 15 min until the probe says better", () => {
  const before = Date.now();
  const { outcome } = parseCodexOutput(recorded("usage-limit"), "exit 1");
  assert.ok(!outcome.ok && outcome.retryAt);
  assert.match(outcome.error, /hit your usage limit/);
  assert.ok(outcome.retryAt.getTime() >= before + 15 * 60_000 && outcome.retryAt.getTime() <= Date.now() + 15 * 60_000);
});

test.each([
  "You’ve hit your usage limit for GPT-6-Sol. Switch to another model now, or try again at 3:45 PM.",
  "Your workspace is out of credits. Add credits to continue.",
  "You hit your spend cap for this month.",
])('"%s" is a usage limit', (message) => {
  const { outcome } = parseCodexOutput(`${JSON.stringify({ type: "turn.failed", error: { message } })}\n`, "exit 1");
  assert.ok(!outcome.ok && outcome.retryAt);
});

test.each(["command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search"])(
  "a %s item fails the call, even when the turn completed",
  (type) => {
    const lines = recorded("success").split("\n");
    lines.splice(2, 0, JSON.stringify({ type: "item.started", item: { id: "item_9", type, status: "in_progress" } }));
    const { outcome, tokensIn } = parseCodexOutput(lines.join("\n"));
    assert.deepEqual(outcome, { ok: false, error: `codex used a tool (${type}), which doomlearn does not allow` });
    assert.equal(tokensIn, 5125);
  },
);

test("reasoning, error and todo_list items do not fail a call", () => {
  assert.deepEqual(parseCodexOutput(recorded("non-tool-items")).outcome, {
    ok: true,
    output: { ok: true, problems: [] },
  });
});

test("a non-zero exit without output fails with why it exited", () => {
  assert.deepEqual(parseCodexOutput("", "Not logged in").outcome, { ok: false, error: "Not logged in" });
});

test("a completed turn whose message is not JSON fails the call", () => {
  const lines = recorded("success").replace('{\\"ok\\":true,\\"problems\\":[]}', "Sure! Here it is.");
  assert.deepEqual(parseCodexOutput(lines).outcome, {
    ok: false,
    error: "codex exec returned no JSON message: Sure! Here it is.",
  });
});
