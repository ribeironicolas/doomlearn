import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { InvalidConfig, type Config, loadConfig, parseConfig } from "./config.ts";
import { readJson, writeJson } from "./json.ts";
import { defaultLexicon, LANGUAGE_TAGS, LANGUAGES, type Language } from "./languages.ts";
import { chapters, passages } from "./schema.ts";

export type { Config };

/**
 * The data folder, its config, its Lexicons and its migrated database.
 */
export type Data = ReturnType<typeof openData>;

/**
 * A transaction on the Learner's database, as `db.transaction` hands it to its callback.
 */
export type Tx = Parameters<Parameters<Data["db"]["transaction"]>[0]>[0];

/**
 * A Lexicon file (`lexicon.json`, `lexicon.en.json`, …) that is not JSON. Not an `InvalidConfig`: that names
 * `config.json` alone.
 */
export class InvalidLexicon extends Error {}

/**
 * A Lexicon file of the Learner's, or `undefined` when it is missing. Throws `InvalidLexicon` naming it when it is not
 * JSON.
 */
export function readLexicon(file: string): Record<string, string> | undefined {
  return existsSync(file) ? (readJson(file, InvalidLexicon) as Record<string, string>) : undefined;
}

/**
 * Gives each Passage extracted before Passages recorded their chapter (the chapter_passages migration) its chapter, read
 * from its anchor: a title anchor names a chapter of its Source; a page anchor's first page lies in a chapter file's
 * `<!-- page n -->` range, which only the file on disk holds. A Passage that maps to no single chapter stays null and is
 * logged. Only null rows are read, so a second run changes nothing; it logs a Passage left null again on every open.
 */
function backfillChapters(db: ReturnType<typeof drizzle>, home: string) {
  const unmapped = db.select().from(passages).where(isNull(passages.chapterId)).all();
  if (!unmapped.length) return;
  const all = db.select().from(chapters).all();
  /**
   * Each chapter file's first and last marked page, read once; none when it has no page marker or no file.
   */
  const ranges = new Map<number, [number, number] | undefined>();
  /**
   * The first and last page chapter `chapter`'s file marks.
   */
  const rangeOf = (chapter: (typeof all)[number]) => {
    if (!ranges.has(chapter.id)) {
      const file = join(home, "sources", String(chapter.sourceId), "chapters", `${chapter.seq}.txt`);
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const pages = [...text.matchAll(/^<!-- page (\d+) -->$/gm)].map((match) => Number(match[1]));
      ranges.set(chapter.id, pages.length ? [Math.min(...pages), Math.max(...pages)] : undefined);
    }
    return ranges.get(chapter.id);
  };
  db.transaction((tx) => {
    for (const passage of unmapped) {
      const { anchor } = passage;
      const found = all.filter((chapter) => {
        if (chapter.sourceId !== passage.sourceId) return false;
        if (!("pages" in anchor)) return chapter.title === anchor.chapter;
        const range = rangeOf(chapter);
        return range !== undefined && range[0] <= anchor.pages[0] && anchor.pages[0] <= range[1];
      });
      if (found.length === 1)
        tx.update(passages).set({ chapterId: found[0].id }).where(eq(passages.id, passage.id)).run();
      else
        console.warn(
          `Passage #${passage.id} maps to ${found.length ? `${found.length} chapters` : "no chapter"} of Source #${passage.sourceId}: ${JSON.stringify(anchor)}`,
        );
    }
  });
}

/**
 * Opens the data folder, creating it, its config, its Lexicons and its database on first use.
 * Migrations are applied every time, so the CLI and the server both work on a fresh folder; a database that
 * already holds data is backed up first.
 * Throws `InvalidConfig`, with the problems listed, when `config.json` is invalid, and `InvalidLexicon` when a
 * Lexicon file is not JSON.
 */
export function openData(home = process.env.DOOMLEARN_HOME ?? join(homedir(), "doomlearn")) {
  for (const dir of ["sources", "jobs", "clips"]) mkdirSync(join(home, dir), { recursive: true });

  const configFile = join(home, "config.json");
  let config = loadConfig(home);
  let loadedMtime: number | undefined = statSync(configFile).mtimeMs;
  /** Why the file on disk is not the config in use, while it is broken or missing. */
  let configError: string | undefined;

  // Each Language's Lexicon, which the worker adds new terms to: seeded from the repo's default for that Language and
  // topped up with default terms it lacks, the Learner's own Respellings winning. The repo's copies are never written.
  const lexicons = {} as Record<Language, Record<string, string>>;
  /**
   * The Learner's Lexicon file of `language`, in the data folder.
   */
  const lexiconFile = (language: Language) => join(home, LANGUAGES[language].lexicon.file);
  for (const language of LANGUAGE_TAGS) {
    const learnerTerms = readLexicon(lexiconFile(language));
    lexicons[language] = {
      ...JSON.parse(readFileSync(defaultLexicon(language), "utf8")),
      ...learnerTerms,
    };
    if (!learnerTerms || !isDeepStrictEqual(lexicons[language], learnerTerms))
      writeJson(lexiconFile(language), lexicons[language]);
  }

  // The CLI writes while the server runs, so wait on a locked database instead of failing.
  const client = new DatabaseSync(join(home, "doomlearn.db"), { timeout: 5000 });
  client.exec("PRAGMA journal_mode = WAL");
  const db = drizzle({ client });
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  // Before migrations change a database already in use, copy it as it was to `doomlearn.db.pre-<migration>.bak`,
  // named after the first pending one. VACUUM INTO includes what is still in the WAL, which a file copy misses.
  // Every copy is kept; one that exists already is from a migration that failed and rolled back.
  const applied = client.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get()
    ? client
        .prepare("SELECT name FROM __drizzle_migrations")
        .all()
        .map((row) => row.name)
    : [];
  // A migration is a folder holding `migration.sql`, as drizzle's migrator reads them, so a `.DS_Store` is not one.
  const [pending] = readdirSync(migrationsFolder)
    .sort()
    .filter((name) => !applied.includes(name) && existsSync(join(migrationsFolder, name, "migration.sql")));
  const backup = join(home, `doomlearn.db.pre-${pending}.bak`);
  if (applied.length && pending && !existsSync(backup)) client.prepare("VACUUM INTO ?").run(backup);
  migrate(db, { migrationsFolder });
  backfillChapters(db, home);

  return {
    home,
    db,
    /**
     * Each Language's Lexicon as last read: the worker keeps it as the last good copy while a file is broken.
     */
    lexicons,
    lexiconFile,
    /**
     * The current settings. A changed `config.json` (by mtime) is re-read; an invalid one is logged
     * once and the last good settings are kept.
     */
    config() {
      // A missing file counts as a change too, so it is logged once like an invalid one.
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(configFile).mtimeMs;
      } catch {}
      if (mtimeMs !== loadedMtime) {
        loadedMtime = mtimeMs;
        try {
          config = parseConfig(readJson(configFile, InvalidConfig), configFile);
          configError = undefined;
        } catch (error) {
          configError = (error as Error).message;
          console.error(`${configError}\nKeeping the last good config.`);
        }
      }
      return config;
    },
    /**
     * Why `config.json` is not in use (broken or missing) as of the last `config()`, or `undefined` when it is.
     */
    configError: () => configError,
  };
}
