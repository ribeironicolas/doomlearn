# R17: What a Clip keeps after its job, which stages re-run alone, and what a chapter or Concept cascades into

## Question

What does a Clip keep after its job finishes? Which stages can re-run alone? What does a chapter or a Concept own? The answers price translating and remaking a Clip, and list everything that pausing or deleting a chapter or Concept must honour.

Code is read from a research branch of the v2 code. Real data comes from a copy, never from the live folder:

```
sqlite3 ~/doomlearn/doomlearn.db "VACUUM INTO '<tmp>/doomlearn.db'"
```

The copy was taken on 2026-10-15. Its counts: sources 2, chapters 26, concepts 266, passages 284, clips 80, events 171, jobs 112, agent_calls 396. Every agent call in it is Claude. The `~/doomlearn/jobs` and `~/doomlearn/clips` folders were only listed and sized, never written.

## Answers (with evidence)

### 1. What a Clip keeps, and the chapter mapping on the real data

**What survives a Clip job.**
- A Clip job runs five stages: script, verify, narration, scene, render. Each one checkpoints to a file in `~/doomlearn/jobs/<id>/`: `script.json`, `verify.json`, `narration.json` + `narration.wav`, `scene.json` and `clip.mp4`. The render's work folder `render/` (bundle, `Scene.tsx`, `sound.wav`, `cues.json`) sits there too (`packages/core/src/pipeline.ts:361-470`, `packages/media/src/render.ts:27-35`).
- Once `finish` commits, the tick deletes the whole job folder: `rmSync(dir, { recursive: true })` (`pipeline.ts:552-558`).
- The only things that survive are the `clips` row and the mp4:
  - `concept_id` and `angle`
  - `script`: the beats JSON. `speech` is PT-BR. `visual` is an English note.
  - `caption`: every beat's `speech` joined
  - `file`, `last_seen_at`, `hidden`, `created_at`

  Source: `pipeline.ts:486-493` and `packages/core/src/schema.ts:102-117`.
- The narration wav, the word timings, the beat spans, the scene TSX and the pop cues are all gone.
- The agents keep no copy either. Claude runs with `--no-session-persistence` (`packages/agents/src/claude.ts:156`). Codex runs with `--ephemeral` (`codex.ts:247`). `agent_calls` stores only metadata (cost, tokens, duration and error), never the output (`schema.ts:165-190`).
- The captions, scene, narration, music and pops are all burned into a single mp4. `Root.tsx` composes `<Scene/>`, `<Audio>` and `<Captions/>`, and `render.ts:105-131` mixes the soundtrack in with ffmpeg. Nothing in the mp4 can be swapped out by itself.
- `caption` keeps the raw `{shown|spoken}` markup. On the copy, `select count(*) from clips where caption like '%{%|%}%'` returns **28** of the 80 Clips. The FTS5 index (`clips_fts`, `tokenize='unicode61 remove_diacritics 2'`, kept by the insert, delete and update-of-caption triggers in `packages/core/drizzle/20261008095218_clip_search/migration.sql`) therefore also indexes the PT respellings.

**What survives on disk (live folder, read only).**
- `ls ~/doomlearn/clips | wc -l` returns 80, the same as the `clips` row count. A `comm` of the file names against `clips.file` shows no orphans.
- Clip sizes: min 1.72 MB, median 2.58 MB, max 3.35 MB, 202 MB in all. Measured with `stat -f %z *.mp4`; `du -sh` reports 193M.
- Six job folders survive. They are exactly the 6 `stuck` jobs (76, 82, 93, 95, 100, 120). All six are `new` jobs that failed the script gates. Each holds `feedback.json` + `script.json`. Four of them also hold an orphaned `narration.wav` of about 3 MB, 12 MB in total. The wav is left behind because a duration-gate rewrite removes only `script.json` and `verify.json` (`pipeline.ts:319`), while `narrate` has already written `narration.wav` (`narration.ts`).
- No folder contains a `scene.json`. The copy has no `regenerate` jobs yet (`select kind,status,count(*) from jobs group by 1,2` returns: extract_chapter/done 26, new/done 70, new/stuck 6, new_angle/done 10).

**Concepts and chapters.**
- No table stores a chapter id for a Concept or a Passage. A Passage's `anchor` is either `{pages:[a,b]}` or `{chapter:<title>, section}` (`schema.ts:13`).
- On extraction, a chapter anchor is rewritten to the extracted chapter's own title (`pipeline.ts:210-215`). A page anchor is sliced only from that chapter's text, so its first page has to be inside the chapter (`anchor.ts:16-27`).
- The PDF converter writes `<!-- page n -->` before each page of each chapter file (`packages/media/src/convert.ts:46-56`). Its reply carries `toc: [level, title, page]` (`packages/media/contracts/convert.reply.json`). The `chapters` row stores no page range. The ranges are stored only in `~/doomlearn/sources/<id>/chapters/<seq>.txt`. They could be re-derived by re-running the converter on the kept `original.pdf` (each top-level outline entry starts a chapter, `convert.ts:46-56`), assuming the converter output does not change.
- Page ranges per chapter file (Source 2, a PDF) come from grepping the `<!-- page n -->` markers. They are contiguous and disjoint: 0: 1-12, 1: 13-16, 2: 17-25, 3: 26-33, 4: 34-72, … 15: 476-497.
- The query that maps Passages to chapters is in `<tmp>/ranges.sql`. It matches a title anchor to `chapters.title`, and a page anchor's first page to a file range:

| Measure | Result |
|---|---|
| Passages by kind | azw3 title anchors 59, pdf page anchors 225 |
| Passages that map to no chapter | 0 |
| PDF Passages whose first page hits ≠ 1 chapter | 0 |
| PDF Passages whose last page runs past their chapter | 0 |
| Title anchors whose title isn't a `chapters.title` | 0 |
| Duplicate chapter titles within a Source | 0 |
| Concepts with Passages in > 1 chapter | **17** of 266 |
| … of which span > 1 Source | **7** |
| … of which span > 1 chapter of the same Source | 10 |
| Concepts with > 1 Passage | 17 (every attach landed in a different chapter) |
| Clips of those 17 Concepts / events on those Clips | 14 / 29 |
| Concepts with no Passage | 0 |

- **Verdict.** On today's data the mapping is exact, but it rests on two things the schema does not enforce:
  1. Chapter titles are unique within a Source. No constraint enforces this (`schema.ts:39-52`).
  2. The PDF chapter files on disk stay in place. `reconvert` rewrites them, but it is refused once the Source has Concepts (`sources.ts:78-84`).
- A `chapter_id` on `passages`, backfilled with the query above, would remove both assumptions.
- `concepts.source_id` and `concepts.seq` record the first Source and a per-Source counter, not a chapter (`schema.ts:73-79`).

### 2. Everything that references a chapter, a Concept or a Clip

**Foreign keys are enforced.**
- Node's `DatabaseSync` option `enableForeignKeyConstraints` defaults to `true` (https://nodejs.org/docs/latest-v24.x/api/sqlite.json, via ctx7 `/websites/nodejs_latest-v24_x_api`). `packages/core/src/data.ts` does not override it.
- Every FK is declared without `ON DELETE` (`drizzle/20261008094711_init/migration.sql`).
- On a scratch copy, `node -e` with `node:sqlite` (Node v24.18.1) printed:

```
foreign_keys { foreign_keys: 1 }
refused: delete from concepts where id=2 -> FOREIGN KEY constraint failed
refused: delete from clips where concept_id=2 -> FOREIGN KEY constraint failed
refused chapter delete -> FOREIGN KEY constraint failed
```

- A hard delete therefore has to remove or detach the children by hand, in this order: events → clips → passages → jobs (and `agent_calls.job_id`, `worker_status.job_id`) → concepts. A chapter needs its `extract_chapter` job removed first.
- `reconvert` already does this for chapters. It nulls `agent_calls.job_id`, then deletes the jobs, then the chapters (`sources.ts:85-90`).

**Each place that needs changing, and what it does today.**

| Place | References | What pause or delete must do there |
|---|---|---|
| `passages` | `concept_id`, `source_id`, anchor (chapter by title or page) | A chapter owns its Passages only through the mapping in §1. Deleting a chapter whose Concept also has Passages elsewhere should drop only those Passages. 17 Concepts are in this case. |
| `clips` + `clips_fts` triggers | `concept_id`; FTS rowid = clip id | A hard delete fires `clips_fts_delete`, so search stays consistent. A soft hide needs a filter wherever `hidden` is read today. |
| `events` | `clip_id` (FK) | Append-only except `resolved_at` (`schema.ts:120-138`). A hard Clip delete must delete its events, which breaks append-only. It also rewrites history read by `feed.today()` counts (`feed.ts:168-177`). A soft delete keeps them. |
| `jobs` queued, running or stuck | `chapter_id` (extract), `concept_id` + `angle` (Clip jobs) | `runnable()` checks only `new` jobs against Paused Sources (`pipeline.ts:118-132`). `new_angle` and `regenerate` jobs run regardless, and so would jobs for a paused Concept. A running job finishes its current stage, and the tick only updates `status` `where status='running'` (`pipeline.ts:561-562`). That is the existing seam for pausing mid-job. A Concept with a job row can't be hard-deleted while the job exists (FK, see above), so its jobs must go first. If a job ever outlived its Concept, `.get()!` in `clip()` (`pipeline.ts:282`) would yield `undefined` and the plan would throw a TypeError on `concept.id`. |
| `jobs` `extract_chapter` | `chapter_id` | Source pause sets them to `paused`, and resume requeues them (`sources.ts:202-226`). A per-chapter pause needs the same, scoped to one chapter. The FK refuses a chapter delete while its `extract_chapter` job exists (checked above); if the job outlived the chapter, `extraction()` (`pipeline.ts:181`) would throw on `chapter.sourceId`. |
| Extraction input | all Concepts | The extract stage receives **every** Concept as `known` (`pipeline.ts:191-195`) and can `attach` a new Passage to any of them (`pipeline.ts:243-250`). `known` is read live from `concepts`, and `attach` skips an id with no `concepts` row (`pipeline.ts:245-246`), so a hard-deleted Concept gets no new Passages. A soft-deleted or paused Concept (row kept) stays in `known` and can get Passages again. A hard-deleted one may come back as a near-duplicate `new` Concept. |
| `fillBufferGap` | `concepts.status='new'` and actively taught | It picks the next Concept with no job of any status (`pipeline.ts:153-168`). A paused Concept needs a filter here. |
| `feed.next()` | fresh = `status='new'` unseen non-hidden Clips; reviews = `scheduled` and due | Neither looks at chapters or Sources (`feed.ts:104-128`). A paused Concept needs a filter in both. Its `due_at` keeps passing while it is paused, so on resume it comes back overdue and first in line (ordered by `due_at`). |
| Ladder | `concepts.status, ladder_step, due_at` | `didnt_get` counts `queued/running/paused` jobs as used Angles (`feed.ts:78-87`). A deleted job frees its Angle. |
| `concepts.seq` | per-Source counter | It is assigned as `count(*)` of that Source's Concepts (`pipeline.ts:222-226`). After a hard delete the count shrinks, so the next new Concept repeats an existing `seq`, which the round-robin order uses. |
| `feed.search()` | FTS, `hidden=false` only | It returns Retired Concepts on purpose (`feed.ts:208-243`). Paused or deleted Concepts need a filter. |
| Inbox | flags join clips→concepts; `notLanding` concepts; stuck jobs left-join chapters, concepts, sources | `inbox.ts:31-113`. A paused Concept's open 🚩 and stuck jobs still show. `regenerate(eventId)` would queue work for it (`inbox.ts:134-150`). |
| `agent_calls` | `job_id`, `source_id` | Usage and stats left-join jobs→concepts (`stats.ts:41-44`). Deleting jobs means nulling `job_id`, as `reconvert` does. 26 calls hang off `extract_chapter` jobs. |
| `worker_status` | `job_id` (FK) | `status.ts:142-145` left-joins chapters and concepts to name the running job. |
| Phone `clips` cache | URLs of the latest `/api/next` slots | `keepBuffer` deletes every cached Clip that is not upcoming (`apps/web/src/sync.ts:348-379`). A Clip dropped from `next()` disappears at the next fresh fetch. Until then, an offline phone plays it from cache. |
| Phone `api` cache and `queue` | last good `/api/next`; queued presses by `clipId` | Offline, the kept `/api/next` still lists the Clip (`sync.ts:232-252`). A queued press for a deleted Clip fails on the server. Run on a temp `DOOMLEARN_HOME` copy, `feed.press(999999, …)` throws `Failed query: insert into "events" …` (FK). `flush` treats any non-ok answer as settled and drops the press (`sync.ts:320-322`). |
| Disk | `~/doomlearn/clips/<concept>-<angle>[-<job>].mp4`, `jobs/<id>/`, `sources/<id>/chapters/<seq>.txt` | A hard delete must remove the mp4 and the job folder. The PDF chapter file is also the only page-range record (§1). |

### 3. Cost per stage, and translate against remake

Measured on the copy, per stage, successful calls only. Cost is the API-equivalent USD that Claude reports, not quota. Every call with a recorded model ran on Opus: script, verify and scene at `low`, extract at `medium`. 76 v1 rows (extract 16, scene 15, script 23, verify 22) carry no model or Effort (`select provider,model,effort,stage,count(*) from agent_calls group by 1,2,3,4`).

| Stage | Calls | Median $ | p90 $ | Median s | p90 s | Calls per done Clip job | $ per done Clip job |
|---|---|---|---|---|---|---|---|
| extract | 32 | 0.145 | 0.387 | 12.4 | 36.5 | – | – |
| script | 143 | 0.042 | 0.068 | 10.9 | 14.1 | 1.44 | 0.067 |
| verify | 141 | 0.035 | 0.064 | 7.2 | 9.7 | 1.38 | 0.055 |
| scene | 80 | 0.120 | 0.150 | 34.0 | 41.5 | 1.00 | 0.122 |
| split | 0 | – | – | – | – | – | – |

- No call errored. Totals are script $6.61, verify $5.49, scene $9.77 and extract $6.10, so all Clip calls together cost about $0.27 per Clip in the DB.
- Narration and render are not logged as calls. They were derived from timestamps over the 80 done Clip jobs, using `agent_calls.at`, which is the call's start (`packages/agents/src/agent.ts:123`), and `clips.created_at`:
  - **Narration** (TTS + alignment, plus one TTS redo on a mismatch) is the gap from the end of the last verify call to the start of the scene call: median **193 s**, p90 357 s, min 86 s.
  - **Render** (bundle, Remotion render, soundtrack, ffmpeg) is the gap from the end of the scene call to the Clip insert: median **28 s**, p90 31 s.
  - The worker loop sleeps only when a tick returns false (`apps/server/src/worker.ts:59-60`), so these gaps are close to the stage times.
- Today's price of each path, in agent spend and wall time:

| Path | Stages | Agent $ (medians) | Wall time |
|---|---|---|---|
| Remake in another language | script (×1.44) + verify (×1.38) + narration + scene + render | ≈ 0.067 + 0.055 + 0.122 = **$0.24** | ≈ 16 + 10 + 193 + 34 + 28 ≈ **280 s** |
| Translate the stored script | a translate call (no such stage today; priced like a script call) + verify (recommended) + narration + scene + render | ≈ 0.04 + 0.035 + 0.12 = **$0.20** (about $0.16 without verify) | ≈ 11 + 7 + 193 + 34 + 28 ≈ **273 s** |
| Regenerate in place (from the Inbox, same language) | narration + scene + render | ≈ $0.12 | ≈ 255 s |

- Translation saves about one script-and-verify round: roughly $0.04 and 7 s with verify, $0.08 and 14 s without it. The scene call is half the agent cost, and both paths need it (§4). The local narration dominates wall time for both.
- What a translation must re-run, from the code:
  - **Script translation.** It needs a new agent call: no stage translates, and the script prompt is fixed to PT-BR (`packages/agents/src/prompts/script.md:1,12`).
  - **Deterministic checks.** `checkScript` is language-bound. `WORD_BUDGET` 85-175 is tuned so a PT-BR read fits 60 s (`script.ts:8`). The 8-word copy check matters most when the target is the Source's own language, English here (`script.ts:46-55`).
  - **Verify.** Optional, but its prompt says speech is PT-BR (`verify.md:5`), and a translation can drift from the Passages.
  - **Narration.** Always re-run. TTS is pinned to `language_id="pt"` on the pt-br pack (`packages/media/python/tts/server.py:49`), and the aligner to `language="Portuguese"` (`python/align/server.py:29`). The `{shown|spoken}` respellings are PT-specific, so the lexicon is per language.
  - **Scene.** A new call (§4).
  - **Render.** Always re-run.
- **Schema.** `unique(concept_id, angle)` on `clips` (`schema.ts:117`) and the file name `<concept>-<angle>.mp4` (`pipeline.ts:487`) both forbid a second Clip of the same (Concept, Angle) in another language. A language column, or a variant table, has to join that key.
- The `regenerate` plan, which filters out script and verify and reads beats from the row (`pipeline.ts:284-300, 471`), is the nearest existing shape for a translation that hands in its own beats.

### 4. Can a scene be reused across languages?

No. Under the current contract every language needs its own scene call.

- The scene prompt states: "On-screen text is Brazilian Portuguese, with technical terms kept in English" (`packages/media/remotion/api.md:5`). Labels are literal strings in the TSX. In the api.md example, the label `processo` is a literal string.
- The timing is keyed to spoken words. `w(word, n)` finds the nth spoken occurrence of `word` in `CLIP.words` and **throws** if it is missing (`remotion/harness.tsx:37-44`). The style rule says "Every element enters with a spring on the word that names it (`pop(frame, w('…'))`)" (`api.md`, Style). A PT scene rendered over English timings throws on its first `w('memória')`. The render reports this as a `SceneError`, which triggers a scene re-send (`render.ts` catch → `pipeline.ts:453-467`).
- `BEAT[n]` comes from the beat spans of the new narration, so beat-keyed timing would survive a translation. But the contract asks for word-keyed entrances and in-language labels, so a real scene uses both.
- Nothing of the scene survives the job anyway (§1). Even a same-language regenerate makes a **new** scene call (`pipeline.ts:438-441` is not filtered for regenerate).
- Reusing a scene would need a different contract: labels passed in as data per language, and cues keyed to beats or word indices rather than word text, plus keeping `scene.json` after the job. That is a design option for the grilling tickets, not something the code supports today.

## Unverified

- Narration and render times are derived from timestamp gaps (§3), not timed in a fresh run. They include worker overhead between ticks, and a TTS redo when the aligner mismatched. The largest narration gap, 409108 s, is one job that most likely sat through a pause or a stop. It stays in the data, but the median and p90 are not affected by it. I did not run local TTS or render, because 80 real jobs give better numbers than one run.
- The cost of a "translate" call is an estimate that assumes it costs about one script call. No such stage exists to measure.
- Word budgets and the 60 s gate for languages other than PT-BR are not measured. The fact that 85-175 words fits 60 s is known only for the PT-BR voice.
- The 17 multi-chapter Concepts and the exact mapping are true of today's two Sources only. An ebook with repeated chapter titles, or a reconverted PDF, would break the title or page mapping (§1). Neither exists in the data.
- Codex calls were not costed: the copy has no Codex `agent_calls` rows.

## Gap round 1

### 1. How the daily cap and the buffer target count today, and where a translate or remake would land

**The daily cap counts `clips` rows.** It does not count jobs.

- Each tick counts `clips.created_at >= today's local midnight` (`packages/core/src/pipeline.ts:511-515`, `new Date().setHours(0, 0, 0, 0)`). The same count is shown in the Sources view as `today: { clips, cap }` (`packages/core/src/sources.ts:158-172`).
- At the cap, the tick only picks `extract_chapter` and `regenerate` jobs: `capped ? inArray(jobs.kind, ["extract_chapter", "regenerate"])` (`pipeline.ts:517-522`). The comment says why: they "add no Clip".
- A regenerate is let through because it updates its row in place. Its `finish` sets only `file`, `hidden` and `lastSeenAt` (`pipeline.ts:477`). `created_at` stays the same, so a regenerate never adds to today's count. A test covers this: "a regenerate runs at the daily Clip cap, as it adds no Clip" (`pipeline.test.ts:601`). Command: `node_modules/.bin/vitest run packages/core/src/pipeline.test.ts -t "daily Clip cap"` → `Tests 1 passed | 22 skipped`.
- `new` and `new_angle` jobs both insert a row (`pipeline.ts:486-490`), so both are held at the cap.

**The buffer target counts unseen Clips plus pending `new`/`new_angle` jobs.**

- `fillBufferGap` counts `clips` with `last_seen_at is null and hidden = 0` as `unseen`. It adds jobs of kind `new` or `new_angle` that are `runnable()` (queued or running, and a `new` job only for an actively taught Concept) as `pending` (`pipeline.ts:138-149`).
- It queues one `new` job only when `unseen + pending < bufferTarget` **and** `clipsToday + pending < dailyClipCap` (`pipeline.ts:149`). So pending jobs count against both limits before their Clips exist.
- The Feed's readout is a little different. `generating` counts `new`/`new_angle` jobs that are `queued` or `running`, without the actively-taught filter (`packages/core/src/feed.ts:183-187`). `ready` uses the same unseen query (`feed.ts:178-182`).
- `fillBufferGap` only ever creates `new` jobs. A `new_angle` job comes from a Review outcome (`feed.ts:88-93`), whatever the buffer holds. It is held only at run time, by the cap.
- A regenerate does not count as pending. But its `finish` sets `lastSeenAt: null, hidden: false` (`pipeline.ts:477`), so the regenerated Clip **re-enters** the unseen count, and so the buffer, once it is done.
- Defaults are `bufferTarget: 10` and `dailyClipCap: 15` (`packages/core/src/config.ts:42`). Both settings are described as "Provisional until the benchmark" (`config.ts:82-92`).

**On the real data** (a `VACUUM INTO` copy of `~/doomlearn/doomlearn.db`, taken 2026-10-15):

- The live `~/doomlearn/config.json` has only the `$schema` and `server` keys, so the defaults of 10 and 15 apply.
- Clips per local day: `2026-10-08 15, 10-09 15, 10-10 15, 10-11 9, 10-12 10, 10-13 9, 10-14 6, 10-15 1`. The cap was hit on three days.
- `select count(*) filter (where last_seen_at is null and hidden=0), count(*) filter (where hidden=1), count(*) from clips` → `11|16|80`. 11 unseen is at or above the target of 10, so the buffer is full right now.
- Jobs: `extract_chapter done 26, new done 70, new stuck 6, new_angle done 10`. There are no `regenerate` jobs, so the in-place path has not run on live data yet.

**Where a translate or remake job would land under this code**, if it is added as a new `jobs.kind` and the code above is left unchanged:

| If the job… | Daily cap | Buffer target |
|---|---|---|
| inserts a new `clips` row (a language variant as its own row) | Its row's `created_at` is today, so it **counts toward the cap**. It is also **held at the cap**, because only `extract_chapter` and `regenerate` are on the allowlist (`pipeline.ts:522`). | Once done, the new row is unseen, so it **counts as buffer** and stops `fillBufferGap` from queuing a new Concept. While it is pending it is **not counted**, because `pending` lists only `new`/`new_angle` (`pipeline.ts:147`). |
| updates an existing row in place (like `regenerate`) | Adds nothing to the count. It is held at the cap unless it is added to the allowlist next to `regenerate`. | Counts only if it resets `lastSeenAt` the way regenerate does. |

- So the default for a language variant that is its own row: it is capped, counted toward the cap, and counted as unseen buffer once rendered. It is not seen as pending while it is queued. That gap between pending and done can overfill the buffer by the number of queued variants. This is the same blind spot regenerate has today.
- A variant as its own row also runs into `unique(concept_id, angle)` and the `<concept>-<angle>.mp4` file name (§3, Schema). So "new row" already means a schema change.
- Every one of these counts is a plain `kind`/`created_at`/`last_seen_at` filter. Whichever policy the grilling picks, the change is one of three things: add the new kind to the `capped` allowlist (`pipeline.ts:522`), add it to the `pending` list (`pipeline.ts:147`, and `feed.ts:186` for the readout), or have it leave `lastSeenAt` alone.
