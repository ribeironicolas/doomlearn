import { utimesSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, AgentStages } from "../agent.ts";
import type { Language } from "../languages.ts";
import type { Chapter, Media } from "../media.ts";
import { alignerWords } from "../narration.ts";

/**
 * Fake word timing: one word every 400 ms, each spoken for 300 ms.
 */
const WORD = { everyMs: 400, lastsMs: 300 };

type Extracted = AgentStages["extract"]["output"]["new"];

/**
 * Agent port fake: scripted output per stage, recording which stages were called and with what input.
 * `extract` replaces the scripted extraction with one derived from the chapter text.
 */
export function fakeAgent({ extract }: { extract?: (chapter: string) => Extracted } = {}) {
  const calls: (keyof AgentStages)[] = [];
  const inputs: { stage: keyof AgentStages; input: unknown }[] = [];
  const outputs: { [S in keyof AgentStages]: AgentStages[S]["output"] } = {
    extract: {
      new: [
        {
          title: "What is a thread",
          summary: "A thread is one sequence of execution inside a process.",
          angles: ["analogy", "mechanism"],
          anchor: { chapter: "Threads" },
        },
      ],
      attach: [],
    },
    // Within the spoken-word budget, so it passes the script checks.
    script: {
      beats: [
        {
          speech: "Já pensou em fazer duas coisas ao mesmo tempo no seu computador, sem que nada trave?",
          visual: "question",
        },
        {
          speech:
            "Uma thread é como um cozinheiro numa cozinha que segue uma receita, passo a passo, do começo ao fim.",
          visual: "kitchen",
        },
        {
          speech: "O processo é a cozinha inteira, com a despensa, o fogão e todos os utensílios que ficam lá dentro.",
          visual: "process",
        },
        {
          speech:
            "Quando chegam mais cozinheiros, cada um segue a sua própria receita, mas todos dividem a mesma despensa.",
          visual: "cooks",
        },
        {
          speech:
            "Por isso o trabalho anda mais rápido, porque enquanto um espera a água ferver, outro já corta os legumes.",
          visual: "parallel",
        },
        {
          speech:
            "Só que dividir a despensa tem um preço: se dois pegam o mesmo ingrediente juntos, a receita desanda.",
          visual: "collision",
        },
      ],
    },
    // The script above in English, within the en word budget, so it passes the script checks too.
    translate: {
      beats: [
        {
          speech: "Ever tried doing two things at once on your computer, without anything freezing up?",
          visual: "question",
        },
        {
          speech: "A thread is like a cook in a kitchen who follows one recipe, step by step, from start to finish.",
          visual: "kitchen",
        },
        {
          speech: "The process is the whole kitchen, with the pantry, the stove and every tool kept inside it.",
          visual: "process",
        },
        {
          speech: "When more cooks arrive, each one follows a recipe of their own, but they all share the same pantry.",
          visual: "cooks",
        },
        {
          speech:
            "That is why the work goes faster: while one waits for the water to boil, another is already chopping vegetables.",
          visual: "parallel",
        },
        {
          speech:
            "But sharing the pantry has a price: if two grab the same ingredient together, the recipe falls apart.",
          visual: "collision",
        },
      ],
    },
    verify: { ok: true, problems: [] },
    split: {
      concepts: [
        { title: "Threads in a process", summary: "A process can run several threads.", angles: ["analogy"] },
        {
          title: "Threads share memory",
          summary: "Threads in a process share its memory.",
          angles: ["mechanism", "contrast"],
        },
      ],
    },
    scene: { tsx: "export default () => null;" },
  };
  const agent: Agent = {
    run: async (stage, input) => {
      calls.push(stage);
      inputs.push({ stage, input });
      if (stage === "extract" && extract) {
        return {
          ok: true,
          output: { new: extract((input as AgentStages["extract"]["input"]).chapter), attach: [] } as never,
        };
      }
      return { ok: true, output: outputs[stage] as never };
    },
  };
  return { ...agent, calls, inputs };
}

/**
 * The fake TTS's wav: 8 kHz, 8-bit PCM mono, whose silence is the byte 128. A header is 36 bytes before its data size.
 */
const WAV = { rate: 8000, msPerSecond: 1000, bits: 8, fmtBytes: 16, headerBytes: 36, silence: 128 };

/**
 * A silent wav lasting `ms`, so a browser can play what the fake TTS wrote.
 */
function silentWav(ms: number) {
  const samples = Math.round((ms * WAV.rate) / WAV.msPerSecond);
  // In the platform's byte order, which is little-endian on every Mac and Linux box doomlearn runs on, as wav is.
  const u32 = (value: number) => Buffer.from(Uint32Array.of(value).buffer);
  const u16 = (value: number) => Buffer.from(Uint16Array.of(value).buffer);
  return Buffer.concat([
    Buffer.from("RIFF"),
    u32(WAV.headerBytes + samples),
    Buffer.from("WAVEfmt "),
    u32(WAV.fmtBytes),
    // PCM, one channel.
    u16(1),
    u16(1),
    u32(WAV.rate),
    u32(WAV.rate),
    u16(1),
    u16(WAV.bits),
    Buffer.from("data"),
    u32(samples),
    Buffer.alloc(samples, WAV.silence),
  ]);
}

/**
 * Media port fake: writes small stub files instead of running converters, TTS or Remotion (the TTS a silent wav as
 * long as its words), recording the Language of each TTS and align call, and each text the TTS spoke.
 * `chapters` replaces the single scripted chapter every conversion returns.
 */
export function fakeMedia({
  chapters = [{ title: "Threads", text: "A thread is one sequence of execution inside a process.\n" }],
}: {
  chapters?: Chapter[];
} = {}) {
  const calls: { tool: "speak" | "align"; language: Language }[] = [];
  const spoken: { text: string; language: Language }[] = [];
  const media: Media = {
    convert: async () => ({ chapters }),
    async speak(text, out, language) {
      calls.push({ tool: "speak", language });
      spoken.push({ text, language });
      const durationMs = alignerWords(text).length * WORD.everyMs;
      await writeFile(out, silentWav(durationMs));
      return { durationMs };
    },
    align: async (_audio, text, language) => {
      calls.push({ tool: "align", language });
      return alignerWords(text).map((word, i) => ({
        word,
        startMs: i * WORD.everyMs,
        endMs: i * WORD.everyMs + WORD.lastsMs,
      }));
    },
    render: (_scene, out) => writeFile(out, "fake mp4"),
  };
  return { ...media, calls, spoken };
}

/**
 * How far ahead (1 min) a hand edit's mtime is set, so the config's mtime check always sees a change.
 */
const EDIT_LATER_MS = 60_000;

/**
 * The mtime of the last hand edit, so two edits within the same millisecond still get different mtimes.
 */
let lastEditMs = 0;

/**
 * Hand-edits `home`'s config.json to `config`, with a later mtime as an edit seconds later would have.
 * Returns the text written.
 */
export async function editConfig(home: string, config: unknown) {
  const file = join(home, "config.json");
  await writeFile(file, JSON.stringify(config));
  lastEditMs = Math.max(Date.now() + EDIT_LATER_MS, lastEditMs + 1);
  const later = new Date(lastEditMs);
  utimesSync(file, later, later);
  return readFile(file, "utf8");
}
