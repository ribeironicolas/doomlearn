import { type ExecFileException, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UsageReading } from "@doomlearn/core/usage";
import type { ParsedCall, Provider } from "./agent.ts";

/**
 * Item types that mean the model ran a tool. Any of them fails the call: doomlearn's stages need none.
 * `reasoning`, `error` and `todo_list` are other items a valid call may print.
 */
const TOOL_ITEMS = ["command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search"];

/**
 * A usage-limit failure's message. Written to avoid the U+2019 apostrophe of "You’ve".
 */
const USAGE_LIMIT = /hit your usage limit|out of credits|spend cap/i;

/**
 * Timings: how long to wait after a usage limit when the probe can't tell (15 min), how long a `codex app-server`
 * question or a `codex login status` may take, and the milliseconds per second of a reset time in epoch seconds.
 */
const WAIT = { fallbackMs: 900_000, probeMs: 15_000, secondMs: 1000 };

/**
 * A Usage window's `usedPercent` that is all of it, and the names of the windows the Codex plan has, by length in minutes.
 */
const WINDOW = { fullPercent: 100, names: { 300: "five_hour", 10080: "seven_day" } as Record<number, string> };

/**
 * Flags that keep everything but the stage prompt and input out of a call (R10): the Learner's config and rules,
 * project docs, the built-in instruction blocks, and every tool codex lets a flag turn off.
 */
const ISOLATION = [
  ...["--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only"],
  ...["-c", 'web_search="disabled"', "-c", "features.shell_tool=false", "-c", "project_doc_max_bytes=0"],
  ...["-c", "tools.experimental_request_user_input.enabled=false", "-c", "skills.include_instructions=false"],
  ...["-c", "include_permissions_instructions=false", "-c", "include_collaboration_mode_instructions=false"],
  ...["-c", "include_apps_instructions=false", "-c", "include_environment_context=false"],
  ...["--disable", "multi_agent", "--disable", "apps", "--disable", "plugins", "--disable", "image_generation"],
  ...["--disable", "browser_use", "--disable", "computer_use", "--disable", "sleep_tool"],
];

/**
 * One line of `codex exec --json`, with the fields doomlearn reads.
 */
type CodexEvent = {
  type: string;
  item?: { type: string; text?: string };
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
  message?: string;
};

/**
 * Reads one `codex exec --json` output: one JSON event per line and, when it exited non-zero, why.
 * A call succeeds when its turn completed with a JSON agent message and no tool item appeared.
 * A usage limit is rate-limited, estimated at 15 min until the limits probe says better.
 * Codex reports no cost; `input_tokens` already counts cached input and `output_tokens` reasoning.
 */
export function parseCodexOutput(stdout: string, exitError?: string): ParsedCall {
  const events = stdout.split("\n").flatMap((line): CodexEvent[] => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const usage = events.findLast((event) => event.type === "turn.completed")?.usage;
  /** The call's figures with `outcome`. */
  const call = (outcome: ParsedCall["outcome"]): ParsedCall => ({
    outcome,
    tokensIn: usage?.input_tokens,
    tokensOut: usage?.output_tokens,
    costUsd: null,
  });
  const tool = events.find((event) => event.item && TOOL_ITEMS.includes(event.item.type))?.item?.type;
  if (tool) return call({ ok: false, error: `codex used a tool (${tool}), which doomlearn does not allow` });
  const failure =
    events.findLast((event) => event.type === "turn.failed")?.error?.message ??
    events.findLast((event) => event.type === "error")?.message;
  if (failure && USAGE_LIMIT.test(failure)) {
    return call({ ok: false, error: failure, retryAt: new Date(Date.now() + WAIT.fallbackMs) });
  }
  const message = events.findLast((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    ?.item?.text;
  if (failure || exitError || !usage || message === undefined) {
    return call({ ok: false, error: failure || exitError || "codex exec returned no message" });
  }
  try {
    return call({ ok: true, output: JSON.parse(message) });
  } catch {
    return call({ ok: false, error: `codex exec returned no JSON message: ${message}` });
  }
}

/**
 * The `CODEX_HOME` doomlearn runs codex under: `codex-home` in the data folder, whose `auth.json` is a symlink to the
 * Learner's real one (never a copy: a refresh writes through the link), so the Learner's global AGENTS.md, skills and
 * config stay out of prompts. Without a real `auth.json` (a Keychain login), it falls back to the real home, with a warning.
 */
function codexHome(home: string): { dir: string; warning?: string } {
  const real = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const auth = join(real, "auth.json");
  if (!existsSync(auth)) {
    return {
      dir: real,
      warning: `codex has no ${auth} (a Keychain login?): running it in its own home, so the global AGENTS.md leaks into prompts`,
    };
  }
  const dir = join(home, "codex-home");
  const link = join(dir, "auth.json");
  mkdirSync(dir, { recursive: true });
  let target: string | undefined;
  try {
    target = readlinkSync(link);
  } catch {}
  if (target !== auth) {
    rmSync(link, { force: true });
    symlinkSync(auth, link);
  }
  return { dir };
}

/**
 * Asks `codex app-server` (experimental) one JSON-RPC question over stdio, after its handshake.
 * Resolves the result, or `undefined` on any failure or after `timeoutMs` (15 s). It needs no model quota.
 */
function askAppServer<T>(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  method: string,
  params: unknown,
  timeoutMs = WAIT.probeMs,
) {
  return new Promise<T | undefined>((resolve) => {
    const child = spawn(command, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    /** Writes one JSON-RPC message as a line. */
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    /** Resolves once, stopping the server. */
    const done = (result?: T) => {
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(done, timeoutMs);
    child.on("error", () => done());
    child.on("exit", () => done());
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { id?: number; result?: T };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method, params });
      }
      if (message.id === 2) done(message.result);
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "doomlearn", title: null, version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
  });
}

/**
 * One limit of `account/rateLimits/read`: its usage windows.
 */
type RateLimit = { primary?: RateLimitWindow; secondary?: RateLimitWindow } | null;
/**
 * One usage window of a limit: how much is used, how long it is, and when it resets, in epoch seconds.
 */
type RateLimitWindow = { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;

/**
 * The Usage windows `codex app-server`'s `account/rateLimits/read` reports, named by length (`five_hour`,
 * `seven_day`), with the limit's id first for any limit but `codex` (e.g. `base_model_inference seven_day`).
 * `undefined` when the probe fails or takes over `timeoutMs`.
 */
async function readLimits(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs?: number,
): Promise<UsageReading[] | undefined> {
  const limits = await askAppServer<{ rateLimits?: RateLimit; rateLimitsByLimitId?: Record<string, RateLimit> }>(
    command,
    env,
    "account/rateLimits/read",
    null,
    timeoutMs,
  );
  if (!limits) return undefined;
  return Object.entries(limits.rateLimitsByLimitId ?? { codex: limits.rateLimits }).flatMap(([id, limit]) =>
    [limit?.primary, limit?.secondary].flatMap((window) => {
      if (!window) return [];
      const name = WINDOW.names[window.windowDurationMins] ?? `${window.windowDurationMins} min`;
      return [
        {
          window: id === "codex" ? name : `${id} ${name}`,
          utilization: window.usedPercent / WINDOW.fullPercent,
          resetsAt: new Date(window.resetsAt * WAIT.secondMs),
          status: null,
          source: "probe" as const,
        },
      ];
    }),
  );
}

/**
 * Codex's Usage windows for the usage screen, read under doomlearn's codex home in the data folder `home`;
 * `undefined` when the probe fails or takes over `timeoutMs`.
 */
export async function codexUsage(
  home: string,
  { command = "codex", timeoutMs }: { command?: string; timeoutMs?: number },
) {
  let dir: string;
  try {
    dir = codexHome(home).dir;
  } catch {
    return undefined;
  }
  return readLimits(command, { ...process.env, CODEX_HOME: dir }, timeoutMs);
}

/**
 * Codex as a Provider: `codex exec --json` in a fresh empty folder, read-only, isolated from the Learner's own
 * instructions and config, with structured output from the stage schema. The stage input arrives as its `<stdin>` block.
 */
export const codex: Provider = {
  invocation({ model, effort, prompt, schema }, home) {
    const cwd = mkdtempSync(join(tmpdir(), "doomlearn-codex-"));
    return {
      args: [
        "exec",
        "--json",
        "--ephemeral",
        ...["-C", cwd, "-m", model, "-c", `model_reasoning_effort="${effort}"`],
        ...["-c", `model_instructions_file=${JSON.stringify(prompt)}`, "--output-schema", schema],
        ...ISOLATION,
        "Answer the JSON input below as your instructions say.",
      ],
      env: { ...process.env, CODEX_HOME: codexHome(home).dir },
      cwd,
    };
  },
  parse: parseCodexOutput,
  /**
   * The Usage windows from the limits probe. `exec` prints only a localized reset time.
   */
  limits: (command, { env }) => readLimits(command, env),
  /**
   * `codex login status` exits non-zero when logged out; nothing it prints is kept. Each stage's model and Effort are
   * then checked against `model/list`, which only ever warns: the catalog changes often.
   */
  async preflight(command, home, stages) {
    let isolated: ReturnType<typeof codexHome>;
    try {
      isolated = codexHome(home);
    } catch (error) {
      // E.g. EACCES on the data folder: block the worker, never crash the server.
      return { problems: [`codex home unavailable: ${(error as Error).message}`], warnings: [] };
    }
    const { dir, warning } = isolated;
    const env = { ...process.env, CODEX_HOME: dir };
    const warnings = warning ? [warning] : [];
    const error = await new Promise<ExecFileException | null>((resolve) =>
      execFile(command, ["login", "status"], { env, timeout: WAIT.probeMs }, (error) => resolve(error)),
    );
    if (error) {
      const problem =
        error.code === "ENOENT"
          ? "codex not found: install it, or set no stage to codex"
          : "codex not logged in: run `codex login`";
      return { problems: [problem], warnings };
    }
    const list = await askAppServer<{
      data?: { model: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[];
    }>(command, env, "model/list", { includeHidden: true });
    if (!list?.data)
      return { problems: [], warnings: [...warnings, "codex model list unavailable: models not checked"] };
    for (const { stage, model, effort } of stages) {
      const listed = list.data.find((entry) => entry.model === model);
      if (!listed) warnings.push(`codex model "${model}" (${stage}) is not in codex's model list`);
      else if (!listed.supportedReasoningEfforts.some((supported) => supported.reasoningEffort === effort)) {
        warnings.push(`codex model "${model}" (${stage}) does not support Effort "${effort}"`);
      }
    }
    return { problems: [], warnings };
  },
};
