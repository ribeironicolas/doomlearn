# R14: data-migration facts for doomlearn v2

Scratch work: `$P2/r14/` (`$P2` = `scratchpad/phase2`). `kit/` holds the rename experiment, `kit2/` the NOT NULL variant and `kit3/` the table-recreate variant. Each one is a copy of `drizzle/`, `drizzle.config.ts` and `src/schema.ts`, with `node_modules` symlinked from the repo. `doomlearn-copy.db` is the live DB copy. Nothing in `~/doomlearn` was written. One side effect: a read-only WAL open updates the `-shm` mtime, while `doomlearn.db` and `-wal` keep their mtimes (`ls -la ~/doomlearn/doomlearn.db*` before and after).

## Question

The question is what v2 has to carry from v1, and how to carry it without losing data. It breaks into six parts:
1. Drizzle's release status.
2. How drizzle-kit handles the `claude_calls` to `agent_calls` rename and the new `usage_snapshots` table (R3 §5, R4 §2).
3. The real data in `~/doomlearn`.
4. The PWA offline queue (R6 open question 3).
5. Where `lexicon.json` lives.
6. The config.json v1 to v2 mapping (R8 open question 6).

## Findings (with evidence)

### F1. Drizzle 1.0 is still RC. Stay on rc.4, pinned exactly
- `npm view drizzle-orm dist-tags --json`: `"latest": "0.45.4"`, `"rc": "1.0.0-rc.4"`, `"rc5": "1.0.0-rc.5-5935859"` (a preview build). drizzle-kit has the same tags (`"latest": "0.31.11"`, `"rc": "1.0.0-rc.4"`). npm has no `1.0.0` version.
- `npm view drizzle-orm time`: `1.0.0-rc.4` was published 2026-06-27, rc.5 previews on 2026-08-11 and 2026-09-09, and `0.45.4` on 2026-10-08. The newest GitHub releases are `0.45.4`, `0.45.3`, `drizzle-kit@0.31.11` and `v1.0.0-rc.4` (`gh api repos/drizzle-team/drizzle-orm/releases`).
- `0.45.4` has **no** `node-sqlite` export: 0 of its 447 export keys match. rc.4 exports `./node-sqlite`, `./node-sqlite/driver`, `./node-sqlite/session` and `./node-sqlite/migrator` (`node -e` over `package.json` exports). Moving to "stable" would therefore drop the driver that the standing storage decision relies on.
- The rc.5 preview tarball declares only 2 export keys. The packaging changed, and I did not dig further. Treat rc.5 as unknown until it gets the `rc` tag.
- The rc.4 notes that touch us (https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4): "Split SQLite into async, effect versions", "moved generic SQLite async/sync migrators to `sqlite-core/async/session` as `migrateSync`", and "Removed RQBv1 from sqlite". The repo already runs on rc.4 (lockfile `drizzle-orm` and `drizzle-kit` both `1.0.0-rc.4`), so none of this is new to v2.
- `package.json` has `"drizzle-orm": "^1.0.0-rc.4"`. A caret on a prerelease also matches later `1.0.0-rc.N` and `1.x`, and a new pnpm lockfile would resolve to whatever `rc` points at that day.

### F2. Rename: non-interactive in CI and agents, rows kept, needs a hints file
Test: `kit/src/schema.ts` renames `claudeCalls`/`claude_calls` to `agentCalls`/`agent_calls`. It adds `provider` (`notNull().default('claude')`) and the nullable `model`, `effort`, `reasoning_tokens` and `subtype`, plus R4's `usage_snapshots`.
- `drizzle-kit generate --name agent_calls </dev/null` (text mode, non-TTY) **does not prompt**. It prints `missing_hints: 2 unresolved decisions`, with one "Rename or create" each for `agent_calls` and `usage_snapshots`, then `Re-run with --hints '<json-array>'. Exit code 2.`, and writes nothing.
- `--output json` returns `{"status":"missing_hints","unresolved":[{"type":"rename_or_create","kind":"table","entity":["public","agent_calls"]},…]}`, also with exit 2. The rule is `interactive = output === 'text' && !!process.stdin.isTTY` (`node_modules/drizzle-kit/skills/drizzle-output-modes/SKILL.md`). In a real terminal it would prompt instead.
- With `--hints-file ../hints.json`:
  ```json
  [{"type":"rename","kind":"table","from":["public","claude_calls"],"to":["public","agent_calls"]},
   {"type":"create","kind":"table","entity":["public","usage_snapshots"]}]
  ```
  the result is `{"status":"ok",…"migration_path":"drizzle/20261008205056_agent_calls/migration.sql"}` with exit 0. The SQL:
  ```sql
  CREATE TABLE `usage_snapshots` (…);
  ALTER TABLE `claude_calls` RENAME TO `agent_calls`;
  ALTER TABLE `agent_calls` ADD `provider` text DEFAULT 'claude' NOT NULL;
  ALTER TABLE `agent_calls` ADD `model` text;   -- effort, reasoning_tokens, subtype likewise
  ```
  This is an in-place rename with no drop and no copy. The hint format is documented in `node_modules/drizzle-kit/skills/drizzle-hints/SKILL.md`. On SQLite the first tuple slot is a `'public'` placeholder.
- A second `generate` run returns `{"status":"no_changes"}`, and `drizzle-kit check --output json` returns `{"status":"ok"}`. The snapshot records `"renames":["claude_calls->agent_calls"]` and keeps the FK names as `fk_claude_calls_*`, which matches the DB, so the snapshot and the DB do not drift.
- I applied it with the app's own migrator (`drizzle-orm/node-sqlite/migrator`, script `kit/apply.mjs`) to a copy of the live DB. The result: `agent_calls 76` (it was `claude_calls 76`), all 76 rows have `provider='claude'` and a null `model`, and `clips 15`, `clips_fts 15`, `events 25`, `jobs 26` and `concepts 58` are unchanged. The FTS `MATCH` still returns 15 rows, the 3 triggers are present, and `pragma foreign_key_check` returns `[]` and `integrity_check` returns `ok`.
- **A trap** (`kit2/`): if `model` is `notNull()` with no default, `generate` still answers `ok` and does not raise `confirm_data_loss` (it cannot see the rows), and it emits `ALTER TABLE agent_calls ADD model text NOT NULL`. Applying it fails with `Cannot add a NOT NULL column with default value NULL`. The migrator wraps all pending migrations in one `BEGIN … ROLLBACK` (`node_modules/drizzle-orm/sqlite-core/async/session.js:204-214`), and the DB copy was left intact (`claude_calls` still has 76 rows and `__drizzle_migrations` still has 4). New columns on tables that hold rows must be nullable or have a default. The tests catch this only if they migrate a DB that already has rows.

### F3. The hand-written FTS5 migration survives a rename. A table recreate breaks it
- `20261008095218_clip_search` is a `--custom` migration. Its `snapshot.json` DDL is byte-identical to init's, apart from `id`/`prevIds` (`diff` printed `SAME_DDL`). drizzle-kit therefore does not know `clips_fts` exists and never tries to drop it: `generate` gave `no_changes` after the rename.
- The migrator decides what to run **by folder name only**: `getMigrationsToRun` filters on `dbNamesSet.has(lm.name)` (`node_modules/drizzle-orm/migrator.utils.js`). The live DB lists all 4 v1 names (`select * from __drizzle_migrations`). Two consequences follow. Moving `drizzle/` to `packages/core/drizzle/` is safe as long as the folder names stay the same. Squashing or regenerating the history would make v2 re-run `CREATE TABLE chapters` on the owner's DB and fail.
- **Recreate test** (`kit3/`): giving `clips.script` a default makes drizzle-kit emit the SQLite recreate (`PRAGMA foreign_keys=OFF; CREATE __new_clips; INSERT…SELECT; DROP TABLE clips; RENAME`).
  - With the app's connection it fails with `FOREIGN KEY constraint failed` on `DROP TABLE clips`. `PRAGMA foreign_keys=OFF` has no effect inside the migrator's transaction, and `node:sqlite` enforces FKs by default. It rolls back cleanly.
  - With `new DatabaseSync(path, { enableForeignKeyConstraints: false })` it applies, but the result has `triggers: 0`. A new clip with caption `zzqtest` then gives `match 'zzqtest'` → `0`. **Search silently stops indexing new Clips.**
  - Rule for v2: any migration that recreates `clips` (or a table that FKs point to) must be reviewed by hand. It needs a custom migration that also recreates the 3 triggers and runs `INSERT INTO clips_fts(clips_fts) VALUES('rebuild')`. None of R3, R4, R6 or R8 needs a recreate. All their changes are `ADD COLUMN` or `CREATE TABLE`.

### F4. What the live data folder holds (read-only)
- `config.json` (36 bytes): `{"zerotierIp": "<zerotier-ip>"}`. That is the only key. Everything else comes from defaults.
- Rows (from the `.backup` copy): `sources 1`, `chapters 10`, `concepts 58`, `passages 59`, `clips 15`, `clips_fts 15`, `events 25` (seen 11, got_it 7, flag 6, didnt_get 1), `jobs 26`, `claude_calls 76` (extract 16 rows/$1.82, scene 15/$1.72, script 23/$1.04, verify 22/$0.93, 0 errors, 0 with `retry_at`), `__drizzle_migrations 4`.
- Jobs: 10 `extract_chapter` done, 15 `new` done, and **1 `new_angle` queued with `stage` null**. `jobs/` is empty (`du -sh` 0B), so no job is mid-stage. The queued job starts from scratch under v2.
- Sizes: `clips/` 39M (15 mp4), `sources/` 3.3M (one imported ebook plus `chapters/`), `doomlearn.db` 96K plus a 2.9M `-wal`, `server.log` 1.0M, and `tls/{cert,key}.pem`.
- **The manual backups are empty.** `doomlearn.db.bak-before-reconvert` is 4096 bytes and has `select count(*) from sqlite_master` → `0`. The likely cause is that it was made with `cp` while the data sat in `-wal`. v2's upgrade backup must use `node:sqlite` `backup()` or `VACUUM INTO`. Both worked on Node v24.18.1: `backup()` copied 164 pages, and the copy had `claude_calls` 76 rows; `VACUUM INTO` gave `clips` 15 rows.

### F5. The PWA offline queue: the risk is the cached v1 client, not the queue format
- `web/app.js:35-38`: `store` is a `localStorage` JSON array per key. `'queue'` holds `[{ path: '/api/press' | '/api/seen', body: {clipId, button?, reason?, note?, completed?, clientEventId} }]` (`:78`, `:175`, `:194`). `'handled'` holds `[clipId,…]` (`:79`) and is cleared when a fresh `/api/next` arrives with an empty queue (`:123`).
- The caches are `'shell'` (`web/sw.js:7`: `/`, `/app.js`, manifest, icons), `'api'` (GET answers, `app.js:62`) and `'clips'` (buffered mp4, `app.js:110`). The SW is registered at `/sw.js` (`app.js:640`).
- **Data-loss path:** `flush()` removes an item even on a non-OK answer (`app.js:94-96`: "a rejected one would fail on every retry"). The shell is stale-while-revalidate (`sw.js:21-31`), so the **first launch after the upgrade runs the cached v1 `app.js`**. That client posts its queue to `/api/press` and `/api/seen`. If v2 has only `POST /events`, they get 404s, and the queued presses are logged and **dropped**.
- localStorage, caches and the SW are per origin. If v2 serves on a different host or port than `https://<zerotier-ip>:8443`, the v1 queue becomes invisible (it is not lost, just never sent).

### F6. lexicon.json: one module-level object, mutated by the worker, committed by hand
`grep -rn -i lexicon src python remotion docs …`:
- `src/narration.ts:7` `LEXICON_FILE = new URL('./lexicon.json', import.meta.url)`. `:15` `LEXICON` is parsed once at import. `:43-62` `narrate` reads it.
- `src/pipeline.ts:8` imports it. `:69` `createPipeline(…, lexicon = LEXICON_FILE)`. `:262` sends `Object.keys(LEXICON)` to the script stage. `:271-274` **write**: `Object.assign(LEXICON, newTerms(...))`, then `writeFileSync(lexicon, …)`.
- `src/script.ts:64` `newTerms(beats, lexicon)` is pure.
- `src/agent.ts:30` defines the input type. `src/prompts/script.md:8,21` describe the input.
- Tests: `stages.test.ts:24-34,404-415` and `smoke.test.ts:35-41` pass a temp copy. That copy only redirects the write. Reads still use the global `LEXICON` from `src/`, and `Object.assign` mutates it in-process (`pipeline.ts:273`).
- Current state: 27 terms, 696 bytes. The working tree is clean (`git status --short src/lexicon.json` is empty). Worker additions were committed by hand, so the owner tunes the lexicon in git today. That fits the standing decision "the lexicon is versioned in the repo".

### F7. config.json v1 → v2 (R8 §R7 schema)
| v1 key (data.ts:10-25) | v2 key | Note |
|---|---|---|
| `bufferTarget` | `worker.bufferTarget` | |
| `dailyClipCap` | `worker.dailyClipCap` | |
| `port` | `server.port` | |
| `zerotierIp` (required, `server.ts:140`) | `server.hosts: ['127.0.0.1', ip]` | v1 binds both (`server.ts:146`) |
| (hard-coded `tls/cert.pem`, `tls/key.pem`, `server.ts:139`) | `server.tls.{cert,key}` default | same files |
| `claude.<stage>.{model,effort}` | `agents.stages.<stage> = {provider:'claude', model, effort}` | stages extract/script/verify/split/scene |
The owner's real file maps to `{"server":{"hosts":["127.0.0.1","<zerotier-ip>"]}}`. R8 also writes the whole validated config on every PWA save (`PUT /api/config`, tmp file then rename).

## Recommendation for doomlearn v2

Migration steps, in order. Each one keeps `pnpm test` green.

1. **Pin Drizzle exactly**: `"drizzle-orm": "1.0.0-rc.4"`, `"drizzle-kit": "1.0.0-rc.4"`, with no caret. Write an ADR: "0.45 has no node-sqlite; move only when 1.0.0 ships with `./node-sqlite`." Re-check `dist-tags` when R7's tooling bump runs.
2. **Move the migrations folder unchanged** into the core package (`git mv drizzle packages/core/drizzle`). Keep all 4 folder names. Update the `migrationsFolder` URL in `data.ts`. Add a CI step `drizzle-kit check --output json`, plus a test that fails if an existing migration folder is renamed or removed (compare against a committed list).
3. **Add a v1 fixture test** before any schema change. Build a DB by applying only the 4 v1 migrations, insert rows into every table (including a clip, so FTS has a row), then open it with `openData` and assert row counts, `MATCH` on the old caption, a trigger on a newly inserted clip, and `foreign_key_check` = `[]`. This catches F2's NOT NULL trap and F3's trigger loss, which fresh-DB tests cannot see.
4. **Schema change**: generate with a committed hints file, so agents and CI reproduce it. Run `drizzle-kit generate --name agent_calls --output json --hints-file drizzle/hints/agent_calls.json`. New columns on `agent_calls` must be nullable or have a default (`provider` default `'claude'`). `model` and `effort` stay null for the 76 v1 rows, and the UI shows "unknown". Do not backfill from config: the owner never set models, so the defaults would be a guess.
5. **Backup before migrating, automatically.** In `openData`, if `__drizzle_migrations` has pending entries and the DB already has rows, call `node:sqlite` `backup(db, 'doomlearn.db.pre-v2-<ts>.bak')` (or `VACUUM INTO`) first. This is about 5 lines and fixes the empty-backup problem (F4). Tell the owner the existing `.bak-*` files are empty and safe to delete.
6. **Config: one-time rewrite with a `.bak`**, not an in-memory map. At load, if the file has `claude` or `zerotierIp` at top level, copy it to `config.v1.json.bak`, map it per F7, and write v2 atomically (tmp file then rename). Then parse with `.strict()`. Reasons:
   - The PWA's first `PUT` would rewrite the file in the v2 shape anyway, without a backup, at an unpredictable moment.
   - After the rewrite, only one shape exists for the code, the docs and `$schema` hover.
   - R8 already requires renaming the keys before `strict()` parsing, so the mapping code is written either way. The rewrite adds one copy and one write.
7. **PWA queue: keep two thin aliases for one release.** v2's server keeps `POST /api/press` and `POST /api/seen`, each about 3 lines that call the same core as `POST /events`. That covers the cached v1 client's first launch (F5). Delete them in the release after. In the v2 client, a boot shim (about 10 lines) reads `localStorage.queue`, maps `{path:'/api/press', body}` to `{kind: body.button, clipId, clientEventId, reason, note}` and `/api/seen` to `{kind:'seen', clipId, clientEventId, completed}`, posts them to `/events`, then removes `queue` and `handled`. `clientEventId` makes a double send a no-op (`schema.ts` `client_event_id UNIQUE`). Also keep the origin (`https://<zerotier ip>:8443`) and the SW path `/sw.js`, so the v2 SW replaces the v1 one and the localStorage is visible. For a single user, "open the PWA online once before upgrading" is the minimum, but it depends on the owner remembering. The aliases make it automatic.
8. **Lexicon to DOOMLEARN_HOME, seeded from the versioned default.**
   - The repo keeps `packages/core/lexicon.default.json` (today's 27 terms, from git).
   - `openData` copies it to `$DOOMLEARN_HOME/lexicon.json` if that file is missing. On later runs it merges in default terms the home file lacks, so new versioned terms arrive and the owner's tuned respellings win.
   - Replace the module-level `LEXICON` with a `lexicon` object loaded by `openData` and passed to `narrate` and the pipeline. This fixes the test leak in F6.
   - The owner's existing terms are all committed already (F6), so the first seed carries them over.
   - To share a tuned term with everyone, the owner copies it back into the default by hand. A `doomlearn lexicon diff` command can come later if it is wanted.
9. **The rest of the data needs no migration.** `clips/`, `sources/`, `tls/` and `jobs/` (empty) stay where they are. R8's `paths.*` defaults match the v1 layout. The 1 queued `new_angle` job runs under v2 from its first stage.
10. **Review rule (CONTRIBUTING/ADR):** a migration that contains `DROP TABLE clips` or `__new_clips` needs a custom follow-up that recreates the `clips_fts_*` triggers and rebuilds the index (F3). Migrations that recreate any FK-target table also fail under `node:sqlite`'s default FK enforcement, so write them by hand.

## Open questions
1. Should the lexicon stay "versioned in the repo" as the source of truth (a standing decision) with the home copy as a local overlay, or should the home copy become the truth and the repo hold only a starter set? This recommendation keeps the repo as the default and lets home override. The owner has to choose.
2. Does the v2 PWA keep the exact origin `https://<zerotier-ip>:8443`? If R8's `server.hosts` or a new port changes it, step 7's shim cannot see the v1 queue. The owner should then flush before upgrading.
3. When `node:sqlite` `backup()` runs on a DB with another open connection (CLI and server at the same time), is the copy consistent? It is documented as an online backup, but I tested only a single connection.
4. rc.5 preview packaging has 2 export keys. Recheck the node-sqlite subpath when `rc` moves to rc.5, before bumping.
5. Should `agent_calls.model` record the resolved model from `modelUsage` (R4 §1) rather than the configured alias? That decides whether `model` can become NOT NULL for new rows. It can only be enforced in code, not in the schema (F2).
