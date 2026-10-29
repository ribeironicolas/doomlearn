import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LANGUAGES, type Language } from "@doomlearn/core/languages";
import type { z } from "zod";
import { CONTRACTS, failure } from "./contracts.ts";

const run = promisify(execFile);
const MEDIA = fileURLToPath(new URL("..", import.meta.url));
/**
 * The repo-local uv that `pnpm bootstrap` installs.
 */
const UV = join(MEDIA, ".uv/bin/uv");

/**
 * The runtime table: each tool's uv project, its entry script and the script that checks its pinned weights.
 * A Linux or NVIDIA backend adds its own uv project whose entry speaks the same contract (`contracts/`) and a
 * platform branch here.
 */
const RUNTIMES = {
  tts: { project: "python/tts", entry: "server.py", weights: "weights.py" },
  align: { project: "python/align", entry: "server.py", weights: "weights.py" },
  convert: { project: "python/convert", entry: "pdf.py", weights: undefined },
};

type Tool = keyof typeof RUNTIMES;

/**
 * The command that starts `tool`: its venv's Python, spawned directly (no `uv run`, so a stale lock never syncs
 * mid-job; the media preflight blocks it instead), on its entry script.
 */
function command(tool: Tool) {
  const dir = join(MEDIA, RUNTIMES[tool].project);
  return [join(dir, ".venv/bin/python"), join(dir, RUNTIMES[tool].entry)];
}

/**
 * Parses one line a tool printed against its contract. A failure line, or a line missing a field, throws an error
 * starting with `label` and naming the field.
 */
function parse<T extends z.ZodType>(label: string, schema: T, line: string): z.output<T> {
  const json = JSON.parse(line);
  const failed = failure.safeParse(json);
  if (failed.success) throw new Error(`${label}: ${failed.data.error}`);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${label}: ${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * A long-running server tool (tts, align), answering each request with one reply line.
 * Started on first use, so the CLI and the fake-port tests never spawn it; the first request waits for its ready
 * line, and it only holds the process open while a request is in flight. `stop()` ends the runtime and resolves
 * once it has exited; a later request starts a fresh one.
 */
export function serverTool<T extends "tts" | "align">(tool: T, argv = command(tool)) {
  const contract = CONTRACTS[tool];
  let child: { python: ChildProcessByStdio<Writable, Readable, null>; lines: AsyncIterator<string> } | undefined;

  /**
   * The next line the tool prints, or undefined once it has exited.
   */
  async function next() {
    const stdout = child!.python.stdout as Socket;
    stdout.ref();
    const line = await child!.lines.next();
    stdout.unref();
    if (line.done) child = undefined;
    return line.done ? undefined : line.value;
  }

  /**
   * Closes the runtime's stdin, which is its own shutdown, and resolves once its process has exited.
   * A SIGTERM would skip Python's exit, and PyTorch's resource tracker would warn about leaked semaphores.
   */
  async function stop() {
    const python = child?.python;
    child = undefined;
    if (!python || python.exitCode !== null || python.signalCode !== null) return;
    // Held while it exits, so the process waits for it.
    python.ref();
    const exited = once(python, "exit");
    python.stdin.end();
    await exited;
  }

  type Reply = z.output<(typeof CONTRACTS)[T]["reply"]>;
  /**
   * Sends one request and returns its reply, starting the runtime first when none is running.
   */
  async function ask(request: z.input<(typeof CONTRACTS)[T]["request"]>): Promise<Reply> {
    if (!child) {
      const python = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
      python.on("error", (error) => console.error(`${tool} runtime: ${error.message}`));
      python.unref();
      (python.stdin as Socket).unref();
      child = { python, lines: createInterface({ input: python.stdout })[Symbol.asyncIterator]() };
      const line = await next();
      if (line === undefined) throw new Error(`${tool} failed to load: it exited; its output is in the log above`);
      try {
        console.log(`${tool}: ${parse(`${tool} failed to load`, contract.ready, line).backend} ready`);
      } catch (error) {
        child?.python.kill();
        child = undefined;
        throw error;
      }
    }
    child.python.stdin.write(`${JSON.stringify(request)}\n`);
    const line = await next();
    if (line === undefined) throw new Error(`The ${tool} runtime exited; its output is in the log above`);
    // TypeScript cannot narrow the reply schema by `T`.
    return parse(`${tool} reply`, contract.reply, line) as Reply;
  }
  return Object.assign(ask, { stop });
}

/**
 * Runs a one-shot tool (convert) on `args` and parses the one JSON document it prints.
 */
export async function oneShotTool(tool: "convert", args: string[], argv = command(tool)) {
  const { stdout } = await run(argv[0], [...argv.slice(1), ...args], { maxBuffer: Infinity });
  return parse(`${tool} reply`, CONTRACTS[tool].reply, stdout);
}

/**
 * The Languages among `languages` whose voice is not in the HF cache: one `weights.py --check <checkpoint>` per voice,
 * run through `weights` (a seam for tests).
 */
export async function voicelessLanguages(
  languages: Language[],
  weights = [
    join(MEDIA, RUNTIMES.tts.project, ".venv/bin/python"),
    join(MEDIA, RUNTIMES.tts.project, RUNTIMES.tts.weights),
  ],
) {
  // pt-BR's voice is the one the bare `weights.py --check` of mediaPreflight looks for, so it is not checked twice.
  const voices = new Set(
    languages
      .map((language) => LANGUAGES[language].tts.checkpoint)
      .filter((voice) => voice !== LANGUAGES["pt-BR"].tts.checkpoint),
  );
  const missing = new Set<string>();
  for (const voice of voices)
    await run(weights[0], [...weights.slice(1), "--check", voice]).catch(() => missing.add(voice));
  return languages.filter((language) => missing.has(LANGUAGES[language].tts.checkpoint));
}

/**
 * The media preflight's problem for a Language whose voice is missing.
 */
export const voiceProblem = (language: Language) =>
  `tts weights for ${LANGUAGES[language].name} missing: run \`pnpm bootstrap\``;

/**
 * The media preflight: checks each tool's venv against its lock (`uv sync --locked --check`, ~20 ms) and that its
 * pinned weights are in the HF cache, the voices of `languages` included, without installing or downloading anything.
 * Returns one problem per tool or Language that is not ready, e.g. "tts environment outdated: run `pnpm bootstrap`";
 * none means the worker may start. `voiceless` are the Languages whose voice is missing, each also one of
 * `problems` ("tts weights for English missing: run `pnpm bootstrap`"): they block only the jobs in those Languages.
 * `toolProblems` are the other `problems`, which block every job.
 * A venv not on uv's own Python 3.12 is outdated (`python-preference` in each `pyproject.toml`). `interpreters` names
 * the distinct Pythons the ready venvs run on, e.g. "Python 3.12.15 at ~/.local/share/uv/python/cpython-3.12.15-…".
 */
export async function mediaPreflight(languages: Language[] = []) {
  const tools = await Promise.all(
    Object.entries(RUNTIMES).map(async ([tool, { project, weights }]) => {
      const dir = join(MEDIA, project);
      const python = join(dir, ".venv/bin/python");
      try {
        await run(UV, ["sync", "--locked", "--check", "--no-python-downloads", "--project", dir]);
      } catch {
        return { tool, problem: `${tool} environment outdated: run \`pnpm bootstrap\`` };
      }
      try {
        if (weights) await run(python, [join(dir, weights), "--check"]);
      } catch {
        return { tool, problem: `${tool} weights missing: run \`pnpm bootstrap\`` };
      }
      const script = "import platform, sys; print('Python', platform.python_version(), 'at', sys.base_prefix)";
      return { tool, interpreter: (await run(python, ["-c", script])).stdout.trim() };
    }),
  );
  const toolProblems = tools.flatMap(({ problem }) => problem ?? []);
  // A missing tts environment or pt-br voice already says to run `pnpm bootstrap`.
  const voiceless = tools.some(({ tool, problem }) => tool === "tts" && problem)
    ? []
    : await voicelessLanguages(languages);
  const problems = [...toolProblems, ...voiceless.map(voiceProblem)];
  return {
    problems,
    toolProblems,
    voiceless,
    interpreters: [...new Set(tools.flatMap(({ interpreter }) => interpreter ?? []))],
  };
}
