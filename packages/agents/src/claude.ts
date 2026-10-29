import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AgentResult } from "@doomlearn/core/agent";
import type { UsageReading } from "@doomlearn/core/usage";
import type { ParsedCall, Provider } from "./agent.ts";

/**
 * The final message of `claude -p --output-format json`, with the fields doomlearn reads.
 */
type ClaudeResult = {
  type: "result";
  is_error: boolean;
  api_error_status: number | null;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  /** Keyed by the model id the call resolved to. */
  modelUsage?: Record<string, unknown>;
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
};

type RateLimitEvent = { type: "rate_limit_event"; rate_limit_info: { status: string; resetsAt: number } };

/**
 * A `rate_limit_event`'s `rate_limit_info` as it may arrive: `unifiedWindows` is undocumented and every other
 * field but `status` is optional, so each one is checked before it is read.
 */
type RateLimitInfo = {
  status?: unknown;
  resetsAt?: unknown;
  rateLimitType?: unknown;
  utilization?: unknown;
  unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown } | null>;
};

/**
 * A rate-limited call: the API status claude reports, how long to wait (15 min) when it gives no reset time,
 * and the milliseconds per second of its reset time, which is in epoch seconds.
 */
const RATE_LIMIT = { status: 429, waitMs: 900_000, secondMs: 1000 };

/**
 * How long `claude auth status` may take before the preflight gives up on it.
 */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * The Usage window readings in the call's `rate_limit_event`, in 3 steps: `unifiedWindows` (one reading per window),
 * else the typed `utilization` with `rateLimitType`, else `status` alone. No event, a malformed one or a utilization
 * outside 0-1 (a scale change) gives none: a recent call without readings is how drift shows.
 */
function readUsage(messages: { type: string }[]): UsageReading[] {
  const info = (messages.find((message) => message.type === "rate_limit_event") as { rate_limit_info?: unknown })
    ?.rate_limit_info as RateLimitInfo | undefined;
  if (!info || typeof info !== "object" || typeof info.status !== "string") return [];
  const status = info.status;
  /** A reset time in epoch seconds as a Date, or null. */
  const date = (seconds: unknown) => (typeof seconds === "number" ? new Date(seconds * RATE_LIMIT.secondMs) : null);
  /** Whether a utilization is a fraction, as Claude reports it today. */
  const fraction = (utilization: number) => utilization >= 0 && utilization <= 1;
  const windows = Object.entries(info.unifiedWindows ?? {}).flatMap(([window, value]) =>
    typeof value?.utilization === "number"
      ? [{ window, utilization: value.utilization, resetsAt: value.resetsAt }]
      : [],
  );
  if (windows.some(({ utilization }) => !fraction(utilization))) return [];
  if (windows.length) {
    return windows.map(({ window, utilization, resetsAt }) => ({
      window,
      utilization,
      resetsAt: date(resetsAt),
      status,
      source: "unified",
    }));
  }
  const window = typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown";
  const resetsAt = date(info.resetsAt);
  if (typeof info.utilization === "number" && !fraction(info.utilization)) return [];
  if (typeof info.utilization === "number" && typeof info.rateLimitType === "string") {
    return [{ window, utilization: info.utilization, resetsAt, status, source: "typed" }];
  }
  return [{ window, utilization: null, resetsAt, status, source: "status_only" }];
}

/**
 * Reads one `claude -p` output: the array of messages it printed and, when it exited non-zero, why.
 * A call failed when its result `is_error` or it exited non-zero; its `subtype` reads "success" even on API errors.
 * A 429 is rate-limited: it retries at the `resetsAt` of a rejected `rate_limit_event`, or in 15 min without one.
 */
export function parseClaudeOutput(stdout: string, exitError?: string): ParsedCall {
  let messages: (ClaudeResult | RateLimitEvent | { type: "system" | "assistant" | "user" })[] = [];
  try {
    messages = JSON.parse(stdout);
  } catch {
    // Nothing printed: claude failed before the call, or was killed.
  }
  const result = messages.findLast((message): message is ClaudeResult => message.type === "result");
  const tokens = result?.usage;
  let usage: UsageReading[] = [];
  try {
    usage = readUsage(messages);
  } catch {
    // Never fails the call: the missing readings show as drift.
  }
  /** The call's figures with `outcome`. */
  const call = (outcome: AgentResult<unknown>): ParsedCall => ({
    outcome,
    costUsd: result?.total_cost_usd,
    // Cached input counts too: it is what the call read.
    tokensIn: tokens && tokens.input_tokens + tokens.cache_creation_input_tokens + tokens.cache_read_input_tokens,
    tokensOut: tokens?.output_tokens,
    apiErrorStatus: result?.api_error_status,
    resolvedModel: Object.keys(result?.modelUsage ?? {})[0],
    usage,
  });
  if (result?.api_error_status === RATE_LIMIT.status) {
    const rejected = messages.find(
      (message): message is RateLimitEvent =>
        message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected",
    );
    const retryAt = new Date(
      rejected ? rejected.rate_limit_info.resetsAt * RATE_LIMIT.secondMs : Date.now() + RATE_LIMIT.waitMs,
    );
    return call({ ok: false, error: result.result ?? "Rate limited", retryAt });
  }
  if (result?.is_error || exitError || result?.structured_output === undefined) {
    const error = (result?.is_error && result.result) || exitError || "claude -p returned no structured output";
    return call({ ok: false, error });
  }
  return call({ ok: true, output: result.structured_output });
}

/**
 * Claude Code as a Provider: one `claude -p` call per stage on the Learner's own login (never `--bare`, which skips it),
 * with no tools. Claude has no model list, so a model is not checked; the id it resolved to is logged instead.
 */
export const claude: Provider = {
  invocation: ({ model, effort, prompt, schema }) => ({
    args: [
      "-p",
      "--model",
      model,
      "--effort",
      effort,
      "--system-prompt-file",
      prompt,
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      readFileSync(schema, "utf8"),
    ],
  }),
  parse: parseClaudeOutput,
  /**
   * `claude auth status --json` prints its status, exiting 1 when logged out. Only `loggedIn` and `authMethod` are read.
   */
  async preflight(command) {
    const { status, failure } = await authStatus(command);
    if (!status) return { problems: [`claude auth status failed: ${failure}`], warnings: [] };
    if (!status.loggedIn) return { problems: ["claude not logged in: run `claude auth login`"], warnings: [] };
    return {
      problems: [],
      warnings:
        status.authMethod === "claude.ai"
          ? []
          : [`claude is logged in with ${status.authMethod}, not claude.ai: usage windows unavailable`],
    };
  },
};

/**
 * `claude auth status --json`'s `loggedIn` and `authMethod`, or why it printed no status. Identity fields are dropped.
 */
async function authStatus(command: string) {
  const { stdout, error } = await new Promise<{ stdout: string; error: Error | null }>((resolve) =>
    execFile(command, ["auth", "status", "--json"], { timeout: PREFLIGHT_TIMEOUT_MS }, (error, stdout) =>
      resolve({ stdout, error }),
    ),
  );
  try {
    const { loggedIn, authMethod } = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    return { status: { loggedIn, authMethod } };
  } catch {
    return { failure: error?.message ?? stdout };
  }
}

/**
 * How Claude is logged in (`claude.ai` for a subscription, which alone has Usage windows), or `undefined` when unknown.
 */
export async function claudeAuthMethod(command = "claude") {
  return (await authStatus(command)).status?.authMethod;
}
