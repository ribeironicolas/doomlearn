import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createAgent, preflightAgents, renderPrompt } from "./agent.ts";
import { claudeAuthMethod } from "./claude.ts";
import { codexUsage } from "./codex.ts";
import { parseConfig } from "@doomlearn/core/config";
import { openData } from "@doomlearn/core/data";
import { createPipeline } from "@doomlearn/core/pipeline";
import { agentCalls, jobs, usageSnapshots } from "@doomlearn/core/schema";
import { createSources } from "@doomlearn/core/sources";
import { alive } from "@doomlearn/core/status";
import { editConfig, fakeMedia } from "@doomlearn/core/test/fakes";

// Spies on spawn with its real behaviour, so a test can read the options a Provider was started with.
vi.mock("node:child_process", { spy: true });

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A recorded Provider output (see claude.test.ts and codex.test.ts).
 */
function fixture(path: string) {
  return new URL(`./test/${path}`, import.meta.url).pathname;
}

/**
 * Every stage on codex's test model, at `low`.
 */
const ALL_CODEX = Object.fromEntries(
  ["extract", "script", "verify", "split", "scene"].map((stage) => [
    stage,
    { provider: "codex", model: "gpt-6-sol", effort: "low" },
  ]),
);

/**
 * Writes an executable stand-in for a Provider CLI at `dir/name`, running `script`.
 */
async function standIn(dir: string, name: string, script: string) {
  const command = join(dir, name);
  await writeFile(command, `#!/bin/sh\n${script}\n`);
  await chmod(command, 0o755);
  return command;
}

/**
 * A stand-in for `codex`: `exec` records its argv, `CODEX_HOME` and working folder, then prints `exec`'s output;
 * `login status` exits with `login`; `app-server` answers the handshake, then answers the one question with `answer`.
 */
function codexScript({ exec = `cat ${fixture("codex/success.jsonl")}`, login = 0, answer = "{}" } = {}) {
  return `here="$(dirname "$0")"
case "$1" in
  exec) echo "$@" > "$here/argv"; echo "$CODEX_HOME" > "$here/codex_home"; ls -A > "$here/cwd"; ${exec} ;;
  login) touch "$here/login"; [ ${login} = 0 ] && echo "Logged in using ChatGPT" || echo "Not logged in"; exit ${login} ;;
  app-server) touch "$here/app-server"; while read -r line; do case "$line" in
    *'"id":1'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"id":2'*) echo '{"jsonrpc":"2.0","id":2,"result":${answer}}' ;;
  esac; done ;;
esac`;
}

/**
 * A temp DOOMLEARN_HOME with a `.md` Source (so an extraction job exists), a stand-in for `claude` running `script`,
 * and the Learner's real codex home holding an `auth.json`.
 */
async function setup(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
  const file = join(dir, "threads.md");
  await writeFile(file, "# Threads\n\nA thread is one sequence of execution inside a process.\n");
  const command = await standIn(dir, "claude", script);
  const realCodexHome = join(dir, "dot-codex");
  await mkdir(realCodexHome);
  await writeFile(join(realCodexHome, "auth.json"), '{"tokens": "the Learner\'s, never read"}');
  vi.stubEnv("CODEX_HOME", realCodexHome);
  const data = openData(join(dir, "home"));
  const source = await createSources(data, fakeMedia()).add(file);
  const job = data.db.select().from(jobs).get()!;
  return { dir, data, command, source, job, realCodexHome };
}

test("every call writes one agent_calls row with its Provider, model and Effort, failed or not", async () => {
  const { data, command, source, job } = await setup(`cat ${fixture("claude/success.json")}`);
  const agent = createAgent(data, { commands: { claude: command } });
  const ok = await agent.run("verify", { passages: [], beats: [] }, { jobId: job.id });
  assert.deepEqual(ok, { ok: true, output: { ok: true } });

  const failing = createAgent(data, { commands: { claude: `${command}-not-installed` } });
  assert.equal((await failing.run("verify", { passages: [], beats: [] }, { jobId: job.id })).ok, false);

  const rows = data.db.select().from(agentCalls).all();
  assert.deepEqual(
    rows.map(({ stage, jobId, sourceId, isError, provider, model, effort }) => ({
      stage,
      jobId,
      sourceId,
      isError,
      provider,
      model,
      effort,
    })),
    [
      {
        stage: "verify",
        jobId: job.id,
        sourceId: source.id,
        isError: false,
        provider: "claude",
        model: "opus",
        effort: "low",
      },
      {
        stage: "verify",
        jobId: job.id,
        sourceId: source.id,
        isError: true,
        provider: "claude",
        model: "opus",
        effort: "low",
      },
    ],
  );
  assert.equal(rows[0].costUsd, 0.011936);
  assert.equal(rows[0].tokensIn, 2 + 1361);
  assert.equal(rows[0].tokensOut, 52);
  assert.equal(rows[0].error, null);
  assert.match(rows[1].error!, /ENOENT/);
});

test("a rate-limited call is logged with its retry time", async () => {
  const { data, command, job } = await setup(`cat ${fixture("claude/rate-limited-rejected.json")}; exit 1`);
  await createAgent(data, { commands: { claude: command } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );

  const [call] = data.db.select().from(agentCalls).all();
  assert.equal(call.apiErrorStatus, 429);
  assert.deepEqual(call.retryAt, new Date(1791464400 * 1000));
  assert.equal(call.error, "API Error: Request rejected (429) · Rate limited");
});

test("a call over the timeout is killed and counts as one failed attempt", async () => {
  const { data, command, job } = await setup("exec sleep 30");
  const pipeline = createPipeline(
    data,
    createAgent(data, { commands: { claude: command }, timeoutMs: 100 }),
    fakeMedia(),
  );
  await pipeline.tick();

  const after = data.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
  assert.equal(after.attempts, 1);
  assert.match(after.lastError!, /claude timed out/);
  const [call] = data.db.select().from(agentCalls).all();
  assert.equal(call.stage, "extract");
  assert.equal(call.isError, true);
});

test("live: one real call on the Learner login logs a row", {
  skip: !process.env.DOOMLEARN_LIVE_CLAUDE,
  timeout: 900_000,
}, async () => {
  const { data, job } = await setup("");
  vi.unstubAllEnvs();
  const verdict = await createAgent(data).run(
    "verify",
    { passages: ["The sky is blue."], beats: [{ speech: "O céu é azul.", visual: "sky" }] },
    { jobId: job.id },
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const [call] = data.db.select().from(agentCalls).all();
  assert.equal(call.isError, false);
  assert.ok(call.costUsd! > 0);
  console.log(call);
});

test("a call runs in its own process group, and aborting the signal kills it and what it started", async () => {
  const { dir, data, command, job } = await setup(
    'here="$(dirname "$0")"; ps -o pgid= -p $$ | tr -d " " > "$here/pgid"; sleep 30 & echo "$$ $!" > "$here/pids"; wait',
  );
  const controller = new AbortController();
  const call = createAgent(data, { commands: { claude: command }, signal: controller.signal }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );
  await vi.waitFor(() => assert.ok(existsSync(join(dir, "pids"))));
  const pids = (await readFile(join(dir, "pids"), "utf8")).trim().split(" ").map(Number);
  // Its own group, so the terminal's Ctrl+C, sent to doomlearn's group, does not reach it.
  assert.equal(Number(await readFile(join(dir, "pgid"), "utf8")), pids[0]);

  controller.abort();

  assert.equal((await call).ok, false);
  await vi.waitFor(() => assert.deepEqual(pids.map(alive), [false, false]));
});

test("a character the CLI prints across two writes reaches the call whole, on stdout and on stderr", async () => {
  // "á" is the two bytes \303\241, printed apart.
  const split = (text: string) => `printf '${text.replace("á", "\\303'; sleep 0.1; printf '\\241")}'`;
  const ok = await setup(split('[{"type":"result","is_error":false,"structured_output":{"word":"isláis"}}]'));
  const failed = await setup(`{ ${split("isláis")}; } >&2; exit 1`);

  const [output, error] = await Promise.all(
    [ok, failed].map(({ data, command, job }) =>
      createAgent(data, { commands: { claude: command } }).run(
        "verify",
        { passages: [], beats: [] },
        { jobId: job.id },
      ),
    ),
  );

  assert.deepEqual(output, { ok: true, output: { word: "isláis" } });
  assert.deepEqual(error, { ok: false, error: "isláis" });
});

test("a stage runs with its agents.stages model and effort from config.json", async () => {
  const { data, command, job } = await setup(
    `echo "$@" > "$(dirname "$0")/argv"; cat ${fixture("claude/success.json")}`,
  );
  await editConfig(data.home, {
    agents: { stages: { verify: { provider: "claude", model: "sonnet", effort: "high" } } },
  });
  await createAgent(data, { commands: { claude: command } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );
  assert.match(await readFile(join(dirname(command), "argv"), "utf8"), /--model sonnet --effort high /);
});

test("a call is killed after agents.timeoutMinutes", async () => {
  const { data, command, job } = await setup(`cat ${fixture("claude/success.json")}`);
  await editConfig(data.home, { agents: { timeoutMinutes: 2 } });
  vi.mocked(spawn).mockClear();
  await createAgent(data, { commands: { claude: command } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );
  assert.equal((vi.mocked(spawn).mock.calls[0][2] as { timeout: number }).timeout, 2 * 60_000);
});

test("the id a Claude model resolved to is logged once, and again when it changes", async () => {
  const { data, command, job } = await setup(`cat ${fixture("claude/success.json")}`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const agent = createAgent(data, { commands: { claude: command } });
  await agent.run("verify", { passages: [], beats: [] }, { jobId: job.id });
  await agent.run("verify", { passages: [], beats: [] }, { jobId: job.id });
  assert.deepEqual(log.mock.calls, [['doomlearn: claude model "opus" resolved to claude-opus-5-5']]);
  log.mockRestore();
});

test("a config edit during a call leaves its argv as it was, and the next stage uses the new agents settings", async () => {
  const { dir, data, command, job } = await setup(
    `echo "$@" | head -n 1 >> "$(dirname "$0")/argv"; while [ ! -f "$(dirname "$0")/go" ]; do sleep 0.05; done; cat ${fixture("claude/success.json")}`,
  );
  const agent = createAgent(data, { commands: { claude: command } });
  const running = agent.run("verify", { passages: [], beats: [] }, { jobId: job.id });
  await vi.waitFor(() => assert.ok(existsSync(join(dir, "argv"))));
  await editConfig(data.home, {
    agents: { stages: { verify: { provider: "claude", model: "sonnet", effort: "high" } } },
  });
  await writeFile(join(dir, "go"), "");
  await running;
  await agent.run("verify", { passages: [], beats: [] }, { jobId: job.id });

  const [first, next] = (await readFile(join(dir, "argv"), "utf8")).trim().split("\n");
  assert.match(first, /--model opus --effort low /);
  assert.match(next, /--model sonnet --effort high /);
});

test("a codex stage runs isolated: its own CODEX_HOME with auth.json linked, read-only, in an empty folder", async () => {
  const { dir, data, job, realCodexHome } = await setup("");
  const codex = await standIn(dir, "codex", codexScript());
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  const outcome = await createAgent(data, { commands: { codex } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );

  assert.deepEqual(outcome, { ok: true, output: { ok: true, problems: [] } });
  const argv = await readFile(join(dir, "argv"), "utf8");
  assert.match(argv, /^exec --json --ephemeral -C \S+ -m gpt-6-sol -c model_reasoning_effort="low" /);
  assert.match(
    argv,
    /-c model_instructions_file="\S+\/prompts\/pt-BR\/verify\.md" --output-schema \S+\/prompts\/verify\.schema\.json /,
  );
  for (const flag of [
    "--ignore-user-config",
    "-s read-only",
    "-c skills.include_instructions=false",
    "-c include_permissions_instructions=false",
    "-c include_collaboration_mode_instructions=false",
    "-c include_apps_instructions=false",
    "-c include_environment_context=false",
  ]) {
    assert.ok(argv.includes(` ${flag} `), flag);
  }
  assert.equal(await readFile(join(dir, "cwd"), "utf8"), "");
  const home = (await readFile(join(dir, "codex_home"), "utf8")).trim();
  assert.equal(home, join(data.home, "codex-home"));
  assert.equal(readlinkSync(join(home, "auth.json")), join(realCodexHome, "auth.json"));

  const [call] = data.db.select().from(agentCalls).all();
  assert.deepEqual(
    { provider: call.provider, model: call.model, effort: call.effort, costUsd: call.costUsd },
    { provider: "codex", model: "gpt-6-sol", effort: "low", costUsd: null },
  );
  assert.equal(call.tokensIn, 5125);
  assert.equal(call.tokensOut, 19);
});

test("without a real auth.json, codex runs in its own home and the preflight warns that AGENTS.md leaks", async () => {
  const { dir, data, job, realCodexHome } = await setup("");
  vi.stubEnv("CODEX_HOME", join(dir, "keychain-login"));
  const codex = await standIn(dir, "codex", codexScript());
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  await createAgent(data, { commands: { codex } }).run("verify", { passages: [], beats: [] }, { jobId: job.id });
  assert.equal((await readFile(join(dir, "codex_home"), "utf8")).trim(), join(dir, "keychain-login"));

  const { problems, warnings } = await preflightAgents(data.home, data.config(), { codex });
  assert.deepEqual(problems, []);
  assert.match(warnings.join("\n"), /global AGENTS\.md leaks into prompts/);
  assert.ok(existsSync(join(realCodexHome, "auth.json")));
});

test("a codex usage limit retries at the latest reset among the windows at 100%", async () => {
  const { dir, data, job } = await setup("");
  const limits = {
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791528377 } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791528377 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1792096848 },
      },
      base_model_inference: {
        primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792999999 },
        secondary: null,
      },
    },
  };
  const codex = await standIn(
    dir,
    "codex",
    codexScript({ exec: `cat ${fixture("codex/usage-limit.jsonl")}; exit 1`, answer: JSON.stringify(limits) }),
  );
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  const outcome = await createAgent(data, { commands: { codex } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );

  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.retryAt, new Date(1792096848 * 1000));
  const [call] = data.db.select().from(agentCalls).all();
  assert.deepEqual(call.retryAt, new Date(1792096848 * 1000));
});

test("a Claude call saves its Usage window readings, tied to its agent_calls row", async () => {
  const { data, command, job } = await setup(`cat ${fixture("claude/usage-unified.json")}`);
  await createAgent(data, { commands: { claude: command } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );

  const [call] = data.db.select().from(agentCalls).all();
  const rows = data.db.select().from(usageSnapshots).all();
  assert.deepEqual(
    rows.map(({ provider, window, utilization, resetsAt, status, source, callId }) => ({
      provider,
      window,
      utilization,
      resetsAt,
      status,
      source,
      callId,
    })),
    [
      {
        provider: "claude",
        window: "five_hour",
        utilization: 0.13,
        resetsAt: new Date(1791519000 * 1000),
        status: "allowed",
        source: "unified",
        callId: call.id,
      },
      {
        provider: "claude",
        window: "seven_day",
        utilization: 0.03,
        resetsAt: new Date(1792108800 * 1000),
        status: "allowed",
        source: "unified",
        callId: call.id,
      },
    ],
  );
  assert.ok(rows.every((row) => row.capturedAt >= call.at));
});

test("after every codex call the limits probe runs, and its windows are saved tied to the call", async () => {
  const { dir, data, job } = await setup("");
  const limits = {
    rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791528377 } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791528377 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792096848 },
      },
      base_model_inference: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1792999999 } },
    },
  };
  const codex = await standIn(dir, "codex", codexScript({ answer: JSON.stringify(limits) }));
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  const outcome = await createAgent(data, { commands: { codex } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );

  assert.equal(outcome.ok, true);
  const [call] = data.db.select().from(agentCalls).all();
  assert.deepEqual(
    data.db
      .select()
      .from(usageSnapshots)
      .all()
      .map(({ provider, window, utilization, resetsAt, source, callId }) => ({
        provider,
        window,
        utilization,
        resetsAt,
        source,
        callId,
      })),
    [
      {
        provider: "codex",
        window: "five_hour",
        utilization: 0.12,
        resetsAt: new Date(1791528377 * 1000),
        source: "probe",
        callId: call.id,
      },
      {
        provider: "codex",
        window: "seven_day",
        utilization: 0.4,
        resetsAt: new Date(1792096848 * 1000),
        source: "probe",
        callId: call.id,
      },
      {
        provider: "codex",
        window: "base_model_inference seven_day",
        utilization: 0.05,
        resetsAt: new Date(1792999999 * 1000),
        source: "probe",
        callId: call.id,
      },
    ],
  );
});

test("a codex usage limit retries in 15 min when the probe fails", async () => {
  const { dir, data, job } = await setup("");
  const codex = await standIn(
    dir,
    "codex",
    codexScript({ exec: `cat ${fixture("codex/usage-limit.jsonl")}; exit 1`, answer: "null" }),
  );
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  const before = Date.now();
  const outcome = await createAgent(data, { commands: { codex } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );

  assert.ok(!outcome.ok && outcome.retryAt);
  assert.ok(existsSync(join(dir, "app-server")));
  assert.deepEqual(data.db.select().from(usageSnapshots).all(), []);
  assert.ok(outcome.retryAt.getTime() >= before + 15 * 60_000 && outcome.retryAt.getTime() <= Date.now() + 15 * 60_000);
});

test("preflight checks only the Providers the config uses", async () => {
  const { dir, data, command } = await setup(
    `touch "$(dirname "$0")/claude-checked"; echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "x@y.z"}'`,
  );
  const codex = await standIn(dir, "codex", codexScript());

  assert.deepEqual(await preflightAgents(data.home, data.config(), { claude: command, codex }), {
    problems: [],
    warnings: [],
  });
  assert.ok(existsSync(join(dir, "claude-checked")));
  assert.equal(existsSync(join(dir, "login")), false);
});

test("a logged-out Claude blocks the worker, and a login other than claude.ai only warns", async () => {
  const { dir, data } = await setup("");
  const loggedOut = await standIn(dir, "claude-out", `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`);
  const apiKey = await standIn(dir, "claude-key", `echo '{"loggedIn": true, "authMethod": "api_key"}'`);

  assert.deepEqual(await preflightAgents(data.home, data.config(), { claude: loggedOut }), {
    problems: ["claude not logged in: run `claude auth login`"],
    warnings: [],
  });
  assert.deepEqual(await preflightAgents(data.home, data.config(), { claude: apiKey }), {
    problems: [],
    warnings: ["claude is logged in with api_key, not claude.ai: usage windows unavailable"],
  });
});

test("a logged-out Codex blocks the worker with how to fix it", async () => {
  const { dir, data } = await setup("");
  const codex = await standIn(dir, "codex", codexScript({ login: 1 }));
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  assert.deepEqual(await preflightAgents(data.home, data.config(), { codex }), {
    problems: ["codex not logged in: run `codex login`"],
    warnings: [],
  });
});

test("a Codex model or Effort missing from model/list only warns", async () => {
  const { dir, data } = await setup("");
  const models = {
    data: [
      { model: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }] },
      { model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "max" }] },
    ],
  };
  const codex = await standIn(dir, "codex", codexScript({ answer: JSON.stringify(models) }));
  await editConfig(data.home, {
    agents: {
      stages: {
        ...ALL_CODEX,
        script: { provider: "codex", model: "gpt-6-luna", effort: "ultra" },
        scene: { provider: "codex", model: "gpt-5.5", effort: "low" },
      },
    },
  });

  assert.deepEqual(await preflightAgents(data.home, data.config(), { codex }), {
    problems: [],
    warnings: [
      'codex model "gpt-6-luna" (script) does not support Effort "ultra"',
      'codex model "gpt-5.5" (scene) is not in codex\'s model list',
    ],
  });
});

test("a codex home that cannot be set up blocks the worker instead of throwing", async () => {
  const { dir, data } = await setup("");
  const codex = await standIn(dir, "codex", codexScript());
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });
  // A file where the codex-home folder should be.
  await writeFile(join(data.home, "codex-home"), "");

  const { problems } = await preflightAgents(data.home, data.config(), { codex });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^codex home unavailable: /);
});

test("the usage screen probes read Codex windows under the codex home, and how Claude is logged in", async () => {
  const { dir, data } = await setup("");
  const limits = { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1791528377 } } };
  const codex = await standIn(dir, "codex", codexScript({ answer: JSON.stringify(limits) }));
  const failing = await standIn(dir, "codex-failing", codexScript({ answer: "null" }));
  const claude = await standIn(dir, "claude", `echo '{"loggedIn": true, "authMethod": "api_key", "email": "x@y.z"}'`);

  assert.deepEqual(await codexUsage(data.home, { command: codex }), [
    { window: "five_hour", utilization: 0.07, resetsAt: new Date(1791528377 * 1000), status: null, source: "probe" },
  ]);
  assert.equal(await codexUsage(data.home, { command: failing }), undefined);
  assert.equal(await claudeAuthMethod(claude), "api_key");
});

test("the pt-BR script, verify and scene prompts render to their golden fixtures, byte for byte", () => {
  for (const stage of ["script", "verify", "scene"] as const)
    assert.equal(renderPrompt(stage, "pt-BR"), readFileSync(fixture(`prompts/${stage}.pt-BR.md`), "utf8"), stage);
});

test("a second Agent on the same data folder keeps the first one's prompt files, and rewrites a stale one on first use", async () => {
  const { data, command, job } = await setup(`cat ${fixture("claude/success.json")}`);
  const file = join(data.home, "prompts", "pt-BR", "verify.md");
  await createAgent(data, { commands: { claude: command } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id },
  );
  await writeFile(file, "a prompt from before an upgrade");

  const second = createAgent(data, { commands: { claude: command } });
  assert.equal(readFileSync(file, "utf8"), "a prompt from before an upgrade");
  await second.run("verify", { passages: [], beats: [] }, { jobId: job.id });
  assert.equal(readFileSync(file, "utf8"), renderPrompt("verify", "pt-BR"));
});

test("the en script prompt writes numbers as words and asks for no Respelling; the es one respells for a Spanish voice", () => {
  const en = renderPrompt("script", "en");
  assert.match(en, /teaches one Concept, in English,/);
  assert.match(en, /Write numbers as words/);
  assert.doesNotMatch(en, /respelling|letter names|\{shown\|spoken\}`:/i);

  const es = renderPrompt("script", "es");
  assert.match(es, /teaches one Concept, in Spanish,/);
  assert.match(
    es,
    /then a respelling a Spanish voice reads right, e\.g\. `\{[^}]+\}`; spell acronyms with Spanish letter names/,
  );
  assert.doesNotMatch(es, /Portuguese|PT-BR|Write numbers as words/);

  for (const language of ["en", "es"] as const) {
    assert.doesNotMatch(renderPrompt("verify", language), /Portuguese/);
    assert.doesNotMatch(renderPrompt("scene", language), /Portuguese/);
  }
});

test("a stage call for an en job reaches the Provider with the en prompt", async () => {
  const { dir, data, job } = await setup("");
  const codex = await standIn(dir, "codex", codexScript());
  await editConfig(data.home, { agents: { stages: ALL_CODEX } });

  await createAgent(data, { commands: { codex } }).run(
    "verify",
    { passages: [], beats: [] },
    { jobId: job.id, language: "en" },
  );

  const [, prompt] = (await readFile(join(dir, "argv"), "utf8")).match(/model_instructions_file="(\S+)"/)!;
  assert.equal(await readFile(prompt, "utf8"), renderPrompt("verify", "en"));
  assert.match(renderPrompt("verify", "en"), /Speech is in English;/);
});

test("the translate prompt is written for its target Language, keeps each beat, and respells by that Language's rule", () => {
  const en = renderPrompt("translate", "en");
  assert.match(en, /into English,/);
  assert.match(en, /the same number of beats, in the same order/);
  assert.match(en, /`visual` is the source beat's `visual`, unchanged/);
  assert.match(en, /Write numbers as words/);
  assert.doesNotMatch(en, /Portuguese|PT-BR|\{\{/);

  const es = renderPrompt("translate", "es");
  assert.match(es, /into Spanish,/);
  assert.match(es, /then a respelling a Spanish voice reads right/);

  assert.match(renderPrompt("translate", "pt-BR"), /into Brazilian Portuguese,[\s\S]*in PT-BR,/);
});

test("a translate call runs on agents.stages.script's Provider, model and Effort, and config has no translate key", async () => {
  const { dir, data, job } = await setup("");
  const codex = await standIn(dir, "codex", codexScript());
  await editConfig(data.home, {
    agents: { stages: { script: { provider: "codex", model: "gpt-6-sol", effort: "low" } } },
  });

  await createAgent(data, { commands: { codex } }).run(
    "translate",
    { from: "Brazilian Portuguese", beats: [], passages: [], words: { min: 85, max: 200 }, lexicon: [] },
    { jobId: job.id, language: "en" },
  );

  const argv = await readFile(join(dir, "argv"), "utf8");
  assert.match(argv, /gpt-6-sol/);
  const [, prompt] = argv.match(/model_instructions_file="(\S+)"/)!;
  assert.equal(await readFile(prompt, "utf8"), renderPrompt("translate", "en"));
  const [call] = data.db.select().from(agentCalls).all();
  assert.deepEqual([call.stage, call.provider, call.model, call.effort], ["translate", "codex", "gpt-6-sol", "low"]);
  assert.throws(
    () => parseConfig({ agents: { stages: { translate: { provider: "codex", model: "gpt-6-sol", effort: "low" } } } }),
    /translate/,
  );
});
