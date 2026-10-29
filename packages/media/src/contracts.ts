import { mkdir, writeFile } from "node:fs/promises";
import { type Language, LANGUAGES } from "@doomlearn/core/languages";
import { z } from "zod";

/**
 * The stdio contract of each media tool, which a backend in any language speaks; Node parses every reply with it.
 * A server tool (tts, align) prints one ready line once its model has loaded, or one failure line and exits, then
 * answers each JSON request line on stdin with one JSON reply line on stdout. A one-shot tool (convert) takes argv
 * and prints one JSON document. Any reply may instead be a failure line. `node src/contracts.ts` writes them to
 * `contracts/` as JSON Schema.
 */
const ready = z.object({
  ready: z.literal(true),
  backend: z.string().describe("Which runtime implementation is speaking, e.g. chatterbox-mps"),
});

export const failure = z.object({ error: z.string() });

export const CONTRACTS = {
  tts: {
    ready,
    request: z.object({
      text: z.string(),
      out: z.string().describe("Path of the wav file to write"),
      language: z
        .object({
          checkpoint: z
            .enum([...new Set(Object.values(LANGUAGES).map(({ tts }) => tts.checkpoint))] as [
              (typeof LANGUAGES)[Language]["tts"]["checkpoint"],
              ...(typeof LANGUAGES)[Language]["tts"]["checkpoint"][],
            ])
            .describe("The Chatterbox pt-br pack, or Multilingual V3"),
          languageId: z.string().describe("Chatterbox's language_id, e.g. pt"),
          nfkd: z.boolean().describe("Whether the text is NFKD-normalized first, as V3's own tokenizer does"),
        })
        .describe("The voice of the Clip's Language"),
    }),
    reply: z.object({ durationMs: z.number().int().describe("Measured from the written audio") }),
  },
  align: {
    ready,
    request: z.object({
      audio: z.string().describe("Path of the wav file"),
      text: z.string(),
      language: z.string().describe("The aligner's name for the Clip's Language, e.g. Portuguese"),
    }),
    reply: z.object({
      words: z.array(z.object({ word: z.string(), startMs: z.number().int(), endMs: z.number().int() })),
    }),
  },
  convert: {
    reply: z.object({
      title: z.string().nullable(),
      toc: z
        .array(z.tuple([z.number().int(), z.string(), z.number().int()]))
        .describe("Outline entries as [level, title, page], page 1-based or -1 for none"),
      pages: z.array(z.string()).describe("Each page as Markdown"),
      textless: z.number().int().describe("How many pages have no text layer"),
    }),
  },
};

/**
 * The generated JSON Schema files, by name under `contracts/`, as their exact text.
 */
export function contractFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [tool, parts] of Object.entries(CONTRACTS))
    for (const [part, schema] of Object.entries(parts)) {
      // A ready or reply line may be a failure line instead.
      const line = part === "request" ? schema : z.union([schema, failure]);
      files[`${tool}.${part}.json`] = `${JSON.stringify(z.toJSONSchema(line, { io: "input" }), null, 2)}\n`;
    }
  return files;
}

if (import.meta.main) {
  const dir = new URL("../contracts/", import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(contractFiles())) await writeFile(new URL(name, dir), text);
}
