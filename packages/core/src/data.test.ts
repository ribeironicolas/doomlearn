import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { onTestFinished, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { InvalidConfig } from "./config.ts";
import { InvalidLexicon, openData } from "./data.ts";
import { createFeed } from "./feed.ts";
import { defaultLexicon } from "./languages.ts";

/**
 * The v1 migration folders, oldest first. The migrator matches applied migrations by folder name,
 * so renaming one would re-run its CREATE TABLE on a Learner's existing database.
 */
const V1_MIGRATIONS = [
  "20261008094711_init",
  "20261008095218_clip_search",
  "20261008122311_split_and_rate_limit",
  "20261008124816_flag_resolved",
];

/**
 * The migration folders in the repo, oldest first.
 */
const MIGRATIONS = readdirSync(fileURLToPath(new URL("../drizzle", import.meta.url))).sort();

test(`the ${V1_MIGRATIONS.length} v1 migration folders keep their names and stay first`, () => {
  const folders = readdirSync(fileURLToPath(new URL("../drizzle", import.meta.url)), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders.slice(0, V1_MIGRATIONS.length), V1_MIGRATIONS);
});

test(`opening an empty data folder applies the ${V1_MIGRATIONS.length} v1 migrations and the caption search triggers`, async () => {
  const data = openData(join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home"));
  const client = data.db.$client;

  const applied = client.prepare("SELECT name FROM __drizzle_migrations ORDER BY id").all();
  assert.deepEqual(
    applied.slice(0, V1_MIGRATIONS.length).map((row) => row.name),
    V1_MIGRATIONS,
  );
  const triggers = client.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
  assert.deepEqual(
    triggers.map((row) => row.name),
    ["clips_fts_delete", "clips_fts_insert", "clips_fts_update"],
  );
  client.close();
});

test("a new data folder's lexicon is seeded with the repo's default terms", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  const data = openData(home);
  const defaults = JSON.parse(readFileSync(defaultLexicon("pt-BR"), "utf8"));
  assert.equal(Object.keys(defaults).length, 27);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "lexicon.json"), "utf8")), defaults);
  assert.deepEqual(data.lexicons["pt-BR"], defaults);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "lexicon.en.json"), "utf8")), {});
  assert.deepEqual(JSON.parse(readFileSync(join(home, "lexicon.es.json"), "utf8")), {});
  assert.deepEqual(data.lexicons.en, {});
  assert.deepEqual(data.lexicons.es, {});
});

test("an existing lexicon gets the default terms it lacks, and the Learner's terms win", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  writeFileSync(join(home, "lexicon.json"), JSON.stringify({ thread: "fio", kubernetes: "cubernétis" }));
  const data = openData(home);
  const learner = JSON.parse(readFileSync(join(home, "lexicon.json"), "utf8"));
  assert.equal(learner.thread, "fio");
  assert.equal(learner.kubernetes, "cubernétis");
  assert.equal(learner.mutex, JSON.parse(readFileSync(defaultLexicon("pt-BR"), "utf8")).mutex);
  assert.equal(Object.keys(learner).length, 28);
  assert.deepEqual(data.lexicons["pt-BR"], learner);
});

test("a data folder gets an empty en and es Lexicon, and its existing lexicon.json stays the pt-BR one, byte for byte", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  // The live file as the Learner keeps it: the default terms and their own, in their own formatting.
  const existing = JSON.stringify({
    ...JSON.parse(readFileSync(defaultLexicon("pt-BR"), "utf8")),
    kubernetes: "cubernétis",
  });
  writeFileSync(join(home, "lexicon.json"), existing);

  const data = openData(home);

  assert.equal(readFileSync(join(home, "lexicon.json"), "utf8"), existing);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "lexicon.en.json"), "utf8")), {});
  assert.deepEqual(JSON.parse(readFileSync(join(home, "lexicon.es.json"), "utf8")), {});
  assert.deepEqual(data.lexicons.en, {});
  assert.deepEqual(data.lexicons.es, {});
  assert.equal(data.lexicons["pt-BR"].kubernetes, "cubernétis");
});

test("an en Lexicon that is not JSON stops startup with an error naming it", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  writeFileSync(join(home, "lexicon.en.json"), "{");
  assert.throws(
    () => openData(home),
    (error) => error instanceof InvalidLexicon && /lexicon\.en\.json is not valid JSON/.test(error.message),
  );
});

test("a lexicon.json that is not JSON stops startup with an error naming it", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  writeFileSync(join(home, "lexicon.json"), '{"thread": "tréd",}');
  assert.throws(
    () => openData(home),
    (error) =>
      error instanceof InvalidLexicon &&
      !(error instanceof InvalidConfig) &&
      /lexicon\.json is not valid JSON/.test(error.message),
  );
});

test("a v1 database with rows is copied to doomlearn.db.pre-<migration>.bak before the first v2 migration, keeping older copies", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  // A v1 database: only the v1 migrations applied, and one logged Claude call.
  const v1Folder = join(home, "..", "v1-drizzle");
  for (const name of V1_MIGRATIONS)
    cpSync(fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)), join(v1Folder, name), { recursive: true });
  const v1 = new DatabaseSync(join(home, "doomlearn.db"));
  v1.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: v1 }), { migrationsFolder: v1Folder });
  v1.exec(
    "INSERT INTO claude_calls (stage, duration_ms, is_error, at, cost_usd) VALUES ('extract', 1200, 0, 1791452831000, 0.5)",
  );
  // Left open, as a running v1 server would, so the row is still in the WAL.
  writeFileSync(join(home, "doomlearn.db.pre-20261008124816_flag_resolved.bak"), "an older backup");

  const data = openData(home);

  const firstV2 = MIGRATIONS[V1_MIGRATIONS.length];
  const backup = new DatabaseSync(join(home, `doomlearn.db.pre-${firstV2}.bak`), { readOnly: true });
  assert.deepEqual(
    backup
      .prepare("SELECT stage, cost_usd FROM claude_calls")
      .all()
      .map((row) => ({ ...row })),
    [{ stage: "extract", cost_usd: 0.5 }],
  );
  assert.equal(
    readFileSync(join(home, "doomlearn.db.pre-20261008124816_flag_resolved.bak"), "utf8"),
    "an older backup",
  );
  // The renamed table keeps the row, logged as a Claude call.
  assert.deepEqual(
    data.db.$client
      .prepare("SELECT stage, cost_usd, provider, model, effort, error FROM agent_calls")
      .all()
      .map((row) => ({ ...row })),
    [{ stage: "extract", cost_usd: 0.5, provider: "claude", model: null, effort: null, error: null }],
  );
  v1.close();
});

test("a new data folder is not backed up", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  openData(home);
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith(".bak")),
    [],
  );
  assert.equal(existsSync(join(home, "doomlearn.db")), true);
});

test("a stray file in the migrations folder (a .DS_Store) is not a pending migration", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  openData(home);
  const stray = fileURLToPath(new URL("../drizzle/.DS_Store", import.meta.url));
  writeFileSync(stray, "");
  try {
    openData(home);
  } finally {
    rmSync(stray);
  }
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith(".bak")),
    [],
  );
});

test("a database with agent calls is backed up before the usage_snapshots migration, which adds an empty table", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  // Every migration before usage_snapshots applied, and one logged call.
  const before = MIGRATIONS.slice(0, MIGRATIONS.indexOf("20261009022712_usage_snapshots"));
  const folder = join(home, "..", "drizzle-before");
  for (const name of before)
    cpSync(fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)), join(folder, name), { recursive: true });
  const client = new DatabaseSync(join(home, "doomlearn.db"));
  migrate(drizzle({ client }), { migrationsFolder: folder });
  client.exec(
    "INSERT INTO agent_calls (stage, provider, duration_ms, is_error, at) VALUES ('extract', 'claude', 1200, 0, 1791452831000)",
  );
  client.close();

  const data = openData(home);

  const backup = new DatabaseSync(join(home, "doomlearn.db.pre-20261009022712_usage_snapshots.bak"), {
    readOnly: true,
  });
  assert.deepEqual({ ...backup.prepare("SELECT count(*) AS calls FROM agent_calls").get() }, { calls: 1 });
  assert.deepEqual({ ...data.db.$client.prepare("SELECT count(*) AS rows FROM usage_snapshots").get() }, { rows: 0 });
});

test("a database with jobs is backed up before the worker_status migration", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  const migration = MIGRATIONS.find((name) => name.endsWith("_worker_status"))!;
  const folder = join(home, "..", "drizzle-before");
  for (const name of MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration)))
    cpSync(fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)), join(folder, name), { recursive: true });
  const client = new DatabaseSync(join(home, "doomlearn.db"));
  migrate(drizzle({ client }), { migrationsFolder: folder });
  client.exec("INSERT INTO jobs (kind, priority, created_at) VALUES ('new', 1, 1791452831000)");
  client.close();

  const data = openData(home);

  const backup = new DatabaseSync(join(home, `doomlearn.db.pre-${migration}.bak`), { readOnly: true });
  assert.deepEqual({ ...backup.prepare("SELECT count(*) AS jobs FROM jobs").get() }, { jobs: 1 });
  assert.deepEqual({ ...data.db.$client.prepare("SELECT count(*) AS rows FROM worker_status").get() }, { rows: 0 });
});

test("a Concept's Angle takes one Clip per Language: another Language is accepted, a same-Language duplicate refused", async () => {
  const client = openData(join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home")).db.$client;
  client.exec(`
    INSERT INTO sources (title, type, sha256, created_at) VALUES ('ostep', 'md', 'abc', 0);
    INSERT INTO concepts (title, summary, fit_angles, source_id, seq, created_at) VALUES ('Threads', 's', '[]', 1, 0, 0);
    INSERT INTO clips (concept_id, angle, script, caption, file, created_at) VALUES (1, 'analogy', '[]', 'um fio', 'a.mp4', 0);
  `);
  /** Adds a Clip of Threads' analogy in `language`. */
  const insert = (language: string) =>
    client
      .prepare(
        "INSERT INTO clips (concept_id, angle, language, script, caption, file, created_at) VALUES (1, 'analogy', ?, '[]', 'a thread', 'b.mp4', 0)",
      )
      .run(language);

  insert("en");
  assert.throws(() => insert("en"), /UNIQUE constraint failed: clips\.concept_id, clips\.angle, clips\.language/);
  assert.throws(() => insert("pt-BR"), /UNIQUE constraint failed/);
  assert.deepEqual(
    client
      .prepare("SELECT id, language FROM clips ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 1, language: "pt-BR" },
      { id: 2, language: "en" },
    ],
  );
});

test("the clip_language migration keeps Clip ids, events and caption search, and stamps jobs pt-BR except unstarted Clip jobs and extraction", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  mkdirSync(home);
  const migration = MIGRATIONS.find((name) => name.endsWith("_clip_language"))!;
  const folder = join(home, "..", "drizzle-before");
  for (const name of MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration)))
    cpSync(fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)), join(folder, name), { recursive: true });
  const client = new DatabaseSync(join(home, "doomlearn.db"));
  migrate(drizzle({ client }), { migrationsFolder: folder });
  client.exec(`
    INSERT INTO sources (title, type, sha256, created_at) VALUES ('ostep', 'md', 'abc', 0);
    INSERT INTO concepts (title, summary, fit_angles, source_id, seq, created_at) VALUES ('Threads', 's', '[]', 1, 0, 0);
    INSERT INTO clips (id, concept_id, angle, script, caption, file, created_at) VALUES (7, 1, 'analogy', '[]', 'um fio de execução', 'a.mp4', 0);
    INSERT INTO events (clip_id, kind, at) VALUES (7, 'seen', 0);
    INSERT INTO jobs (kind, priority, status, created_at) VALUES
      ('new', 1, 'queued', 0), ('new_angle', 2, 'queued', 0), ('new', 1, 'running', 0), ('new_angle', 2, 'stuck', 0),
      ('new', 1, 'done', 0), ('regenerate', 3, 'queued', 0), ('extract_chapter', 0, 'queued', 0),
      ('extract_chapter', 0, 'done', 0), ('new', 1, 'paused', 0);
  `);
  client.close();

  const after = openData(home).db.$client;

  assert.deepEqual(
    after
      .prepare("SELECT kind, status, language FROM jobs ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { kind: "new", status: "queued", language: null },
      { kind: "new_angle", status: "queued", language: null },
      { kind: "new", status: "running", language: "pt-BR" },
      { kind: "new_angle", status: "stuck", language: "pt-BR" },
      { kind: "new", status: "done", language: "pt-BR" },
      { kind: "regenerate", status: "queued", language: "pt-BR" },
      { kind: "extract_chapter", status: "queued", language: null },
      { kind: "extract_chapter", status: "done", language: null },
      { kind: "new", status: "paused", language: "pt-BR" },
    ],
  );
  assert.deepEqual(
    after
      .prepare("SELECT clips.id, language, events.kind FROM clips JOIN events ON events.clip_id = clips.id")
      .all()
      .map((row) => ({ ...row })),
    [{ id: 7, language: "pt-BR", kind: "seen" }],
  );
  assert.deepEqual(
    { ...after.prepare("SELECT rowid FROM clips_fts WHERE clips_fts MATCH 'execucao'").get() },
    { rowid: 7 },
  );
  assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
});

test("on a new data folder, a Clip inserted after every migration is found by caption search", async () => {
  const data = openData(join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home"));
  data.db.$client.exec(`
    INSERT INTO sources (title, type, sha256, created_at) VALUES ('ostep', 'md', 'abc', 0);
    INSERT INTO concepts (title, summary, fit_angles, source_id, seq, created_at) VALUES ('Threads', 's', '[]', 1, 0, 0);
    INSERT INTO clips (concept_id, angle, language, script, caption, file, created_at) VALUES (1, 'analogy', 'en', '[]', 'a thread of execution', 'a.mp4', 0);
  `);

  assert.deepEqual(
    createFeed(data)
      .search("thread")
      .map(({ clipId, language }) => ({ clipId, language })),
    [{ clipId: 1, language: "en" }],
  );
});

test("the chapter_id backfill maps a title anchor and a PDF page anchor, logs a Passage matching no chapter or two, and runs once", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  const before = openData(home).db.$client;
  before.exec(`
    INSERT INTO sources (id, title, type, sha256, created_at) VALUES (1, 'book', 'azw3', 'a', 0), (2, 'paper', 'pdf', 'b', 0);
    INSERT INTO chapters (id, source_id, seq, title, status) VALUES
      (10, 1, 0, 'Intro', 'extracted'), (11, 1, 1, 'Threads', 'extracted'),
      (12, 1, 2, 'Twice', 'extracted'), (13, 1, 3, 'Twice', 'extracted'),
      (20, 2, 0, 'Intro', 'extracted'), (21, 2, 1, 'Locks', 'extracted');
    INSERT INTO concepts (id, title, summary, fit_angles, source_id, seq, created_at) VALUES (1, 'Threads', 's', '[]', 1, 0, 0);
    INSERT INTO passages (id, concept_id, source_id, anchor, text) VALUES
      (1, 1, 1, '{"chapter":"Threads","section":null}', 't'),
      (2, 1, 2, '{"pages":[4,5]}', 'p'),
      (3, 1, 1, '{"chapter":"Ghost"}', 'g'),
      (4, 1, 1, '{"chapter":"Twice"}', 'w');
  `);
  before.close();
  mkdirSync(join(home, "sources", "2", "chapters"), { recursive: true });
  writeFileSync(join(home, "sources", "2", "chapters", "0.txt"), "<!-- page 1 -->\nA\n<!-- page 2 -->\nB\n");
  writeFileSync(
    join(home, "sources", "2", "chapters", "1.txt"),
    "<!-- page 3 -->\nC\n<!-- page 4 -->\nD\n<!-- page 5 -->\nE\n",
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  const after = openData(home).db.$client;

  assert.deepEqual(
    after
      .prepare("SELECT id, chapter_id FROM passages ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 1, chapter_id: 11 },
      { id: 2, chapter_id: 21 },
      { id: 3, chapter_id: null },
      { id: 4, chapter_id: null },
    ],
  );
  assert.deepEqual(warn.mock.calls, [
    ['Passage #3 maps to no chapter of Source #1: {"chapter":"Ghost"}'],
    ['Passage #4 maps to 2 chapters of Source #1: {"chapter":"Twice"}'],
  ]);
  after.close();

  const again = openData(home).db.$client;
  assert.deepEqual({ ...again.prepare("SELECT total_changes() AS changes").get() }, { changes: 0 });
});
