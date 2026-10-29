import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import type { AgentStages } from "@doomlearn/core/agent";
import { openData } from "@doomlearn/core/data";
import { agentCalls, jobs } from "@doomlearn/core/schema";
import { createSources } from "@doomlearn/core/sources";
import { editConfig, fakeMedia } from "@doomlearn/core/test/fakes";
import { configuredStage, createAgent } from "./agent.ts";
import { codex } from "./codex.ts";

// The real Codex path, opt-in with DOOMLEARN_LIVE_CODEX=1 on a Mac logged in to codex with an auth.json:
// the Codex CLI updates itself often, so fakes alone miss argv drift. CI never sets it.
describe.skipIf(!process.env.DOOMLEARN_LIVE_CODEX)("live codex", () => {
  /**
   * A temp data folder with a `.md` Source, so an extraction job exists for the calls' rows.
   */
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "doomlearn-"));
    const file = join(dir, "threads.md");
    await writeFile(file, "# Threads\n\nA thread is one sequence of execution inside a process.\n");
    const data = openData(join(dir, "home"));
    await createSources(data, fakeMedia()).add(file);
    return { data, job: data.db.select().from(jobs).get()! };
  }

  test("zero quota: only the stage prompt and Codex built-ins reach the model", async () => {
    const { data } = await setup();
    const { args, env, cwd } = codex.invocation(
      {
        model: "gpt-6-luna",
        effort: "low",
        prompt: fileURLToPath(new URL("prompts/verify.md", import.meta.url)),
        schema: fileURLToPath(new URL("prompts/verify.schema.json", import.meta.url)),
      },
      data.home,
    );
    // `debug prompt-input` takes only the -c and --disable flags; the model is a -c there.
    const flags = args.flatMap((arg, i) =>
      arg === "-c" || arg === "--disable"
        ? [arg, args[i + 1]]
        : arg === "-m"
          ? ["-c", `model=${JSON.stringify(args[i + 1])}`]
          : [],
    );
    const task = args.at(-1)!;
    const items: {
      role: string;
      content: { text: string }[];
      internal_chat_message_metadata_passthrough: { content_item_kinds: string[] };
    }[] = JSON.parse(execFileSync("codex", ["debug", "prompt-input", ...flags, task], { env, cwd, encoding: "utf8" }));
    rmSync(cwd!, { recursive: true });

    // The multi-agent blocks come from the model catalog: no flag turns them off on codex-cli 0.162.0.
    const builtIn = ["multi_agent.role_instructions", "multi_agent.mode_instructions"];
    const others = items.filter(
      (item) =>
        !item.internal_chat_message_metadata_passthrough.content_item_kinds.every((kind) => builtIn.includes(kind)),
    );
    assert.deepEqual(
      others.map((item) => ({ role: item.role, text: item.content.map((part) => part.text).join("") })),
      [{ role: "user", text: task }],
    );
  });

  /**
   * A tiny input per stage.
   */
  const INPUTS: { [S in keyof AgentStages]: AgentStages[S]["input"] } = {
    extract: {
      title: "Threads",
      chapter: "# Threads\n\nA thread is one sequence of execution inside a process.",
      concepts: [],
    },
    script: {
      concept: { title: "What is a thread", summary: "A thread is one sequence of execution inside a process." },
      passages: ["A thread is one sequence of execution inside a process."],
      angle: "analogy",
      recipe: "Compare it to something familiar, then map each part back.",
      words: { min: 20, max: 40 },
      lexicon: [],
    },
    translate: {
      from: "Brazilian Portuguese",
      beats: [{ speech: "Uma thread é um cozinheiro seguindo uma receita.", visual: "a cook" }],
      passages: ["A thread is one sequence of execution inside a process."],
      words: { min: 5, max: 20 },
      lexicon: [],
    },
    verify: { passages: ["The sky is blue."], beats: [{ speech: "O céu é azul.", visual: "sky" }] },
    split: {
      concept: { title: "Threads", summary: "Threads, their memory and their scheduling." },
      passages: ["A thread is one sequence of execution inside a process. Threads share memory."],
      feedback: "cut 12.4 s",
    },
    scene: {
      beats: [{ speech: "O céu é azul.", visual: "a blue sky" }],
      words: [
        { word: "O", startMs: 0, endMs: 200 },
        { word: "céu", startMs: 200, endMs: 600 },
        { word: "é", startMs: 600, endMs: 800 },
        { word: "azul.", startMs: 800, endMs: 1400 },
      ],
    },
  };

  test.each(Object.keys(INPUTS) as (keyof AgentStages)[])(
    "contract: one %s call on gpt-6-luna at low matches the stage schema",
    { timeout: 600_000 },
    async (stage) => {
      const { data, job } = await setup();
      await editConfig(data.home, {
        agents: { stages: { [configuredStage(stage)]: { provider: "codex", model: "gpt-6-luna", effort: "low" } } },
      });

      const outcome = await createAgent(data).run(stage, INPUTS[stage] as never, { jobId: job.id });

      assert.ok(outcome.ok, JSON.stringify(outcome));
      // translate answers with the script's schema.
      const schema = JSON.parse(
        readFileSync(new URL(`prompts/${configuredStage(stage)}.schema.json`, import.meta.url), "utf8"),
      ) as {
        required: string[];
      };
      // Only the top-level keys: codex's strict mode enforces the rest of the stage schema (nesting, enums) itself.
      assert.deepEqual(Object.keys(outcome.output).sort(), [...schema.required].sort());
      const [call] = data.db.select().from(agentCalls).all();
      assert.deepEqual(
        { provider: call.provider, isError: call.isError, costUsd: call.costUsd },
        { provider: "codex", isError: false, costUsd: null },
      );
      console.log(stage, call.tokensIn, call.tokensOut, call.durationMs, JSON.stringify(outcome.output).slice(0, 300));
    },
  );
});
