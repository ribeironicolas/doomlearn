import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { Agent, AgentResult, AgentStages } from "@doomlearn/core/agent";
import type { Config } from "@doomlearn/core/config";
import type { Data } from "@doomlearn/core/data";
import { type Language, LANGUAGES } from "@doomlearn/core/languages";
import { agentCalls, chapters, concepts, jobs } from "@doomlearn/core/schema";
import { recordUsage, type UsageReading } from "@doomlearn/core/usage";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";

/**
 * The name `agents.stages` gives a Provider.
 */
type ProviderName = Config["agents"]["stages"][keyof Config["agents"]["stages"]]["provider"];

/**
 * A stage set to a Provider, with that Provider's model and Effort words.
 */
export type ProviderStage = { stage: keyof AgentStages; model: string; effort: string };

/**
 * What a Provider's parser reads from one call's output. `costUsd` is null when the Provider reports no cost.
 */
export type ParsedCall = {
  outcome: AgentResult<unknown>;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
  /** The HTTP status of an API error, when the Provider reports one. */
  apiErrorStatus?: number | null;
  /** The model id the Provider resolved the configured model to, when it says. */
  resolvedModel?: string;
  /** The Usage window readings the output carried, when the Provider prints them. */
  usage?: UsageReading[];
};

/**
 * The process for one stage call. A `cwd` is a fresh empty folder, removed after the call.
 */
export type Invocation = { args: string[]; env?: NodeJS.ProcessEnv; cwd?: string };

/**
 * Startup and config-change checks of one Provider: problems block the worker, warnings are only logged.
 */
export type Preflight = { problems: string[]; warnings: string[] };

/**
 * One agent CLI doomlearn drives: how to call it for a stage, how to read what it printed,
 * and what to check before the worker uses it.
 */
export type Provider = {
  /** The call for one stage, given its model, Effort, absolute prompt file and absolute schema file. */
  invocation(call: { model: string; effort: string; prompt: string; schema: string }, home: string): Invocation;
  parse(stdout: string, exitError?: string): ParsedCall;
  /**
   * For a Provider whose output carries no Usage windows: reads them after every call, `undefined` when it can't.
   * A rate-limited call then retries at the latest reset among the windows used up, or else at the parser's estimate.
   */
  limits?(command: string, invocation: Invocation): Promise<UsageReading[] | undefined>;
  /** Whether the Provider is ready for the stages set to it. Identity fields are never kept. */
  preflight(command: string, home: string, stages: ProviderStage[]): Promise<Preflight>;
};

/**
 * The command run for each Provider, by default its own name on `PATH`. A seam for tests.
 */
export type Commands = { [P in ProviderName]?: string };

/**
 * Every Provider, by the name `agents.stages` uses for it.
 */
const PROVIDERS: { [P in ProviderName]: Provider } = { claude, codex };

/**
 * Each stage's system prompt and the JSON Schema its structured output must match, shared by every Provider.
 * The scene prompt is the Remotion harness's own doc, which lives beside the harness in `@doomlearn/media`.
 * A prompt is a template that `renderPrompt` writes for a Language.
 */
const STAGES: { [S in keyof AgentStages]: { prompt: string; schema: string } } = {
  extract: { prompt: "prompts/extract.md", schema: "prompts/extract.schema.json" },
  script: { prompt: "prompts/script.md", schema: "prompts/script.schema.json" },
  // A Translation answers beats, as a script does.
  translate: { prompt: "prompts/translate.md", schema: "prompts/script.schema.json" },
  verify: { prompt: "prompts/verify.md", schema: "prompts/verify.schema.json" },
  split: { prompt: "prompts/split.md", schema: "prompts/split.schema.json" },
  scene: { prompt: import.meta.resolve("@doomlearn/media/scene-api.md"), schema: "prompts/scene.schema.json" },
};

/**
 * A stage's system prompt written for `language`: the script, translate, verify and scene prompts name it, and the
 * script's and translate's rule for English terms is its Respelling rule, or numbers as words for a Language with none
 * (English).
 */
export function renderPrompt(stage: keyof AgentStages, language: Language) {
  const { name, short, respelling } = LANGUAGES[language].prompt;
  const terms = respelling
    ? `Write any other English term as \`{shown|spoken}\`: how the captions show it, then a respelling a ${short} voice reads right, e.g. \`${respelling.examples[0]}\`; spell acronyms with ${respelling.letters}, e.g. \`${respelling.examples[1]}\`.`
    : "Write numbers as words, e.g. `four hundred four`, never `404`.";
  return readFileSync(new URL(STAGES[stage].prompt, import.meta.url), "utf8")
    .replaceAll("{{language}}", name)
    .replaceAll("{{short}}", short)
    .replaceAll("{{terms}}", terms);
}

/**
 * Milliseconds per minute, to turn `agents.timeoutMinutes` into spawn's timeout.
 */
const MINUTE_MS = 60_000;

/**
 * The `agents.stages` entry `stage` runs on: translate runs on the script's, so it has no entry of its own.
 */
export const configuredStage = (stage: keyof AgentStages) => (stage === "translate" ? "script" : stage);

/**
 * The real Agent port: each stage runs on the Provider, model and Effort its `agents.stages` entry names when the
 * stage starts (translate on the script's), under the Learner's own login, and each call is timed and logged as one
 * `agent_calls` row.
 * A call is killed after `agents.timeoutMinutes`. Each call runs in its own process group, so the terminal's first
 * Ctrl+C lets it finish; aborting `signal` kills every running call with what it started, so none is left spending the
 * Learner's plan. `commands` and `timeoutMs` (over the config's timeout) are seams for tests.
 */
export function createAgent(
  { db, home, config }: Data,
  { commands = {}, timeoutMs, signal }: { commands?: Commands; timeoutMs?: number; signal?: AbortSignal } = {},
): Agent {
  // The id each configured model last resolved to (Claude reports it), so the log names it once, and again when it moves.
  const resolvedModels = new Map<string, string>();
  // Each stage's prompt for each Language, as Providers read a prompt file: each file in the data folder's `prompts/`
  // is written again on its first use by this Agent, so a prompt changed by an upgrade is never read stale. Nothing
  // is deleted, so another Agent on the same data folder never loses a file its running call reads.
  const prompts = new Map<string, string>();
  /**
   * The file holding `stage`'s prompt for `language`, written on first use.
   */
  const promptFile = (stage: keyof AgentStages, language: Language) => {
    const key = `${language}/${stage}`;
    if (!prompts.has(key)) {
      const file = join(home, "prompts", language, `${stage}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderPrompt(stage, language));
      prompts.set(key, file);
    }
    return prompts.get(key)!;
  };
  return {
    async run(stage, input, { jobId, language = "pt-BR" }) {
      const { agents } = config();
      const { provider: name, model, effort } = agents.stages[configuredStage(stage)];
      const provider = PROVIDERS[name];
      const command = commands[name] ?? name;
      const timeout = timeoutMs ?? agents.timeoutMinutes * MINUTE_MS;
      const invocation = provider.invocation(
        {
          model,
          effort,
          prompt: promptFile(stage, language),
          schema: fileURLToPath(new URL(STAGES[stage].schema, import.meta.url)),
        },
        home,
      );
      const at = new Date();
      const { stdout, exitError } = await new Promise<{ stdout: string; exitError?: string }>((resolve) => {
        // Detached: its own process group, which the abort kills whole.
        const child = spawn(command, invocation.args, {
          env: invocation.env,
          cwd: invocation.cwd,
          timeout,
          detached: true,
        });
        /**
         * Kills the call's process group: the CLI and anything it started.
         */
        const kill = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGTERM");
          } catch {
            // ESRCH: the group is gone already. Nothing else can fail: the group is doomlearn's own child, same user.
          }
        };
        signal?.addEventListener("abort", kill, { once: true });
        // No size cap, unlike execFile's 64 MB maxBuffer: a call's output is bounded by its timeout instead.
        let [stdout, stderr] = ["", ""];
        // Decoded as UTF-8 across chunks, so a character split between two writes stays whole.
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        /**
         * Settles the call once, with why it failed, if it did.
         */
        const settle = (failure?: string) => {
          signal?.removeEventListener("abort", kill);
          resolve({
            stdout,
            // Only spawn's timeout sets `killed`; an abort kills the group directly.
            exitError: child.killed ? `${name} timed out after ${timeout} ms` : failure,
          });
        };
        child.on("error", (error) => settle(error.message));
        child.on("close", (code, killedBy) =>
          settle(code === 0 ? undefined : stderr.trim() || `${command} exited with ${code ?? killedBy}`),
        );
        // A stand-in that never reads stdin exits before it is written to.
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(input));
      });
      const durationMs = Date.now() - at.getTime();
      if (invocation.cwd) rmSync(invocation.cwd, { recursive: true, force: true });
      const call = provider.parse(stdout, exitError);
      const limits = await provider.limits?.(command, invocation);
      let { outcome } = call;
      const usedUp = (limits ?? []).flatMap(({ utilization, resetsAt }) =>
        utilization !== null && utilization >= 1 && resetsAt ? [resetsAt.getTime()] : [],
      );
      if (!outcome.ok && outcome.retryAt && usedUp.length)
        outcome = { ...outcome, retryAt: new Date(Math.max(...usedUp)) };
      if (call.resolvedModel && resolvedModels.get(model) !== call.resolvedModel) {
        resolvedModels.set(model, call.resolvedModel);
        console.log(`doomlearn: ${name} model "${model}" resolved to ${call.resolvedModel}`);
      }

      const job = db
        .select({ chapterSource: chapters.sourceId, conceptSource: concepts.sourceId })
        .from(jobs)
        .leftJoin(chapters, eq(chapters.id, jobs.chapterId))
        .leftJoin(concepts, eq(concepts.id, jobs.conceptId))
        .where(eq(jobs.id, jobId))
        .get();
      const { id: callId } = db
        .insert(agentCalls)
        .values({
          stage,
          provider: name,
          model,
          effort,
          jobId,
          sourceId: job?.chapterSource ?? job?.conceptSource,
          costUsd: call.costUsd,
          tokensIn: call.tokensIn,
          tokensOut: call.tokensOut,
          durationMs,
          isError: !outcome.ok,
          apiErrorStatus: call.apiErrorStatus,
          error: outcome.ok ? undefined : outcome.error,
          retryAt: outcome.ok ? undefined : outcome.retryAt,
          at,
        })
        .returning({ id: agentCalls.id })
        .get();
      recordUsage({ db }, name, call.usage ?? limits ?? [], callId);
      return outcome as AgentResult<AgentStages[typeof stage]["output"]>;
    },
  };
}

/**
 * Checks only the Providers `config` uses, each for the stages set to it, at startup and on every config change.
 */
export async function preflightAgents(home: string, config: Config, commands: Commands = {}): Promise<Preflight> {
  const stages = (Object.keys(config.agents.stages) as (keyof Config["agents"]["stages"])[]).map((stage) => ({
    stage,
    ...config.agents.stages[stage],
  }));
  const results = await Promise.all(
    (Object.keys(PROVIDERS) as ProviderName[]).flatMap((name) => {
      const used = stages.filter((stage) => stage.provider === name);
      return used.length ? [PROVIDERS[name].preflight(commands[name] ?? name, home, used)] : [];
    }),
  );
  return {
    problems: results.flatMap((result) => result.problems),
    warnings: results.flatMap((result) => result.warnings),
  };
}
