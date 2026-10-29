import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Reads the Learner's hand-edited JSON file, `config.json` or `lexicon.json`. Throws `Invalid` naming the file
 * when it is missing or not JSON, so each file reports through its own error class.
 */
export function readJson(file: string, Invalid: new (message: string) => Error): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Invalid(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `${file} is missing`
        : `${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/**
 * Writes `value` to `file` as JSON atomically (tmp + rename), so a hand edit or a reader never sees half a file.
 * Shared by `config.json` and `lexicon.json`.
 */
export function writeJson(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
