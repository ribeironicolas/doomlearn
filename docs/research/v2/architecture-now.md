# doomlearn: current architecture (v1, 2026-10-08)

Read from code on 2026-10-08. Glossary terms (Learner, Source, Concept, Passage, Clip, Angle, Feed, Review, Retired, Paused) are as in CONTEXT.md. "Chapter" is a code-only term (no glossary entry): a slice of a converted Source, the unit of extraction.

## 0. Shape in one paragraph

One Node 24 process (`src/main.ts`) runs both the HTTPS server and an infinite worker loop (`pipeline.tick()` every 5 s when idle). A second entrypoint, `src/cli.ts`, is a separate short-lived process writing the same SQLite file (WAL, 5 s busy timeout). TypeScript runs directly through Node's type stripping: no build step, no bundler, no framework (raw `node:https`, raw DOM in the PWA). Persistence is SQLite via `node:sqlite` + drizzle-orm (1.0 RC). Heavy media work happens in child processes: `claude -p` per agent stage, three Python venvs (TTS on PyTorch MPS, alignment on MLX, PDF on pymupdf4llm), Calibre CLIs for ebooks, Remotion (bundles webpack + headless Chrome) for render, ffmpeg for the final mix.

## 1. Modules

### src/ (TypeScript, ~2,000 LOC non-test)

| File | LOC | Responsibility | Main exports | Called by |
|---|---|---|---|---|
| `main.ts` | 16 | Server + worker entrypoint; wires real ports; `while(true)` tick loop | (script) | `npm start` |
| `cli.ts` | 67 | `add/status/retry/pause/resume/reconvert/stats` via `node:util parseArgs`; exit 2 on `Refused` | (script) | `npm run doomlearn -- …` |
| `data.ts` | 65 | Opens DOOMLEARN_HOME: makes dirs, writes default `config.json`, merges config, opens SQLite WAL, runs drizzle migrations every open | `openData`, `Config`, `Data` | everything (main, cli, tests) |
| `schema.ts` | 165 | Drizzle tables `sources, chapters, concepts, passages, clips, events, jobs, claude_calls`; `ANGLES`, `Anchor`, `JOB_PRIORITY` | tables, types | all domain modules |
| `agent.ts` | 73 | **Agent port** type: `run(stage, input, {jobId}) -> AgentResult`; typed I/O per stage (`extract, script, verify, split, scene`); `Beat` | `Agent`, `AgentStages`, `AgentResult`, `Beat` | pipeline, claude, fakes |
| `claude.ts` | 119 | **Real Agent**: `execFile('claude', ['-p', …])`, parses JSON output, detects 429, logs one `claude_calls` row per call | `createClaudeAgent`, `parseClaudeOutput` | main, smoke/claude tests |
| `media.ts` | 82 | **Media port** type (`convert, speak, align, render`) + `localMedia` real impl; `pythonRuntime()` lazy long-lived Python child speaking JSON lines over stdio | `Media`, `Narration`, `Word`, `localMedia` | main, cli, server.serve, pipeline |
| `convert.ts` | 106 | Source -> chapters. `.md/.txt` by `# ` headings in TS; PDF via `python/convert/pdf.py` (`<!-- page N -->` markers); epub/azw3 via `calibre-debug -e ebook.py` + `ebook-convert`; MOBI DRM header check; `Refused` error | `convert`, `Refused`, `Chapter`, `Converted` | media (`localMedia.convert`), sources, cli, server |
| `sources.ts` | 178 | Source lifecycle: `add` (sha256 dedupe, copy original, write chapter txt, queue `extract_chapter` jobs), `reconvert`, `status`, `retry`, `pause`, `resume` | `createSources` | cli, server |
| `pipeline.ts` | 412 | **The worker.** `tick()`: honors rate-limit pause, fills buffer gap (queues `new` jobs round-robin across Sources), picks highest-priority job, runs its next missing stage, checkpoints to disk, `finish(tx)` on completion; retry/stuck policy; split; lexicon auto-append | `createPipeline` | main, tests |
| `anchor.ts` | 31 | Slices a Passage from chapter text at an `Anchor` (page range or chapter/section heading) | `sliceAnchor` | pipeline |
| `script.ts` | 71 | Deterministic script gates: word budget 85–175, no 8-word copy from Passages, no code read aloud; Angle `RECIPES`; `newTerms` for lexicon | `checkScript`, `newTerms`, `RECIPES`, `WORD_BUDGET` | pipeline |
| `narration.ts` | 88 | Applies lexicon + `{shown|spoken}` respellings, TTS, alignment, maps aligned words back to shown words; one TTS redo on mismatch | `narrate`, `LEXICON`, `LEXICON_FILE`, `alignerWords` | pipeline, script, render tests |
| `lexicon.json` | data | pt-BR respellings of English tech terms (**mutated at runtime by the worker, inside the repo**) | | narration, pipeline |
| `render.ts` | 80 | Copies `remotion/*` + agent `Scene.tsx` into `<job>/render/`, Remotion `bundle` + `renderMedia` (h264 1080x1920), collects `pop()` cues from browser log, synthesizes music/SFX with vendored explainroo, ffmpeg amix + loudnorm -14 LUFS | `render` | media (`localMedia.render`) |
| `feed.ts` | 212 | Feed rules: `next()` (new Clips round-robin by Source, a Review every 3rd slot), `today()`, `press()` (button -> event + ladder 1/3/7/21/60 d), `seen()`, `search()` (FTS5) | `createFeed`, `Button` | server, tests |
| `inbox.ts` | 93 | Derived inbox: open flags, not-landing Concepts, stuck jobs; `resolve(eventId)` | `createInbox` | server |
| `stats.ts` | 36 | Aggregates `claude_calls` per stage/day/source/clip | `usage` | cli `stats` only (no HTTP route) |
| `server.ts` | 147 | `feedApp()` request listener (if-chain router, JSON helpers, range-serving static files) + `serve()` (HTTPS on 127.0.0.1 and zerotierIp, mkcert cert) | `feedApp`, `serve` | main, server tests |
| `prompts/*.md`, `*.schema.json` | 249 (with remotion/api.md) | System prompt + JSON Schema per stage; scene's prompt is `remotion/api.md` | | claude.ts `STAGES` |
| `test/fakes.ts` | 83 | `fakeAgent()` (scripted outputs, records calls/inputs), `fakeMedia()` (stub files, synthetic word timing) | | all fast tests |
| `test/claude/*.json` | | recorded `claude -p` outputs (success, error, 429 with/without rejected event) | | claude.test |
| `test/fixtures/*` | | epub/azw3/pdf fixtures incl. DRM, scanned, flat TOC | | convert.test |

### Other folders

- **remotion/** (~150 LOC + api.md + fixture): `index.ts` registerRoot, `Root.tsx` (composition `Clip`, 1080x1920, 30 fps, duration from props), `harness.tsx` (helpers the agent's scene uses: `w()`, `pop()`, colors, font), `Captions.tsx` + `pages.ts` (caption paging, active word), `api.md` (scene system prompt), `fixture/` (render test). Not compiled by `tsc` (tsconfig includes only `src` + drizzle.config.ts); bundled at render time by `@remotion/bundler` (webpack).
- **web/** (PWA, ~830 LOC): `index.html` (all CSS inline, 99 lines), `app.js` (664 lines vanilla JS, no modules, no types, no build), `sw.js` (49), `manifest.webmanifest`, two icons.
- **python/** (~160 LOC own + vendored chatterbox): `setup.sh` (one venv per runtime, `python3.12 -m venv`, `pip install -r`, `.installed` marker), `tts/server.py` (Chatterbox Multilingual pt-BR on `mps`, voice clone of `faber.wav`), `align/server.py` (Qwen3-ForcedAligner 8-bit via `mlx-audio`), `convert/pdf.py` (pymupdf4llm), `convert/ebook.py` (runs inside Calibre's Python, marks TOC entries with `⟦n⟧`, fallback chapter-title-style split for useless TOCs). `tts/vendor/chatterbox/` is vendored MIT code from Resemble's pt-BR Space (~35 files).
- **drizzle/**: 4 generated migrations (`init`, `clip_search` = FTS5 virtual table + 3 triggers hand-written, `split_and_rate_limit`, `flag_resolved`) with snapshots. `drizzle.config.ts` -> `npm run db:generate`.
- **vendor/explainroo/audio/** (~2,270 LOC JS, MIT, Vincent Schmalbach): procedural music, SFX, DSP, WAV encode; `soundtrack.d.ts` typings. Imported by `render.ts`.

## 2. Ports and seams

| Seam | Interface | Real | Fake | Where swapped |
|---|---|---|---|---|
| Agent | `Agent` in `agent.ts` | `createClaudeAgent(data, {command, timeoutMs})` | `fakeAgent()` | `createPipeline(data, agent, media, lexicon)` arg |
| Media (convert, speak/TTS, align, render) | `Media` in `media.ts` | `localMedia` (module singleton, Python children lazily spawned) | `fakeMedia({chapters})`; tests spread-override single methods e.g. `{...fakeMedia(), render}` | `createPipeline` and `createSources(data, media)` args |
| `claude` binary | `command` option | `'claude'` | shell-script stand-ins written to tmp that cat `src/test/claude/*.json`; `timeoutMs: 100` | `createClaudeAgent` options |
| Lexicon file | `lexicon` arg | `src/lexicon.json` | temp copy (smoke) | `createPipeline` 4th arg |
| Clock | `clock` arg | `() => new Date()` | fixed dates | `createFeed`, `createInbox` (pipeline and sources use `new Date()` directly) |
| HTTP modules | `Modules` in server.ts | built inside `serve()` with `localMedia` hard-wired | tests call `feedApp(data, {feed, sources, inbox})` on plain `node:http` | `feedApp` only; `serve()` is not injectable |
| Data folder | `openData(home)` | `$DOOMLEARN_HOME` or `~/doomlearn` | `mkdtemp` per test | arg |

Tests: `node --test "src/**/*.test.ts"` -> 106 tests, 97 pass, 9 skipped, ~12 s, all on fakes + temp SQLite. Real-tool tests are opt-in by env: `DOOMLEARN_REAL_MEDIA=1` (convert.test real converters), `DOOMLEARN_SMOKE=1` (`npm run smoke`: one `.md` Source through every real port, spends Claude usage, checks a 30–60 s mp4 with audio and `claude_calls` rows). `render.test.ts` has an unconditional real render test (600 s timeout) of `remotion/fixture`. Most tests are integration-shaped: open a temp data folder, `sources.add`, loop `pipeline.tick()`, assert DB rows (good, behavior-level). `typecheck` = `tsc` (TypeScript 7 native, 0.5 s, clean).

## 3. Data flow Source -> Concept -> Clip -> Feed

1. **Add** (`sources.add`, CLI or `POST /api/sources`): reject unsupported ext / duplicate sha256 / scanned PDF / DRM ebook (`Refused`). Store `sources/<id>/original.<ext>` + `sources/<id>/chapters/<seq>.txt`; insert `chapters` rows; queue one `extract_chapter` job per chapter (priority 0).
2. **Queue** = `jobs` table: `kind ∈ {extract_chapter, new, new_angle}`, `priority` (new_angle 2 > new 1 > extract 0), `status ∈ {queued, running, paused, stuck, done}`, `attempts`, `lastError`, `stage` (informational). Single worker, no concurrency, one stage per tick. Ordering: crashed `running` first, then priority, then attempts (Clip jobs), then id.
3. **Pacing** (`fillBufferGap`): queue a `new` job for the next Concept without one while `unseen + pending < bufferTarget` and `clipsToday + pending < dailyClipCap`; round-robin across Sources by Concept `seq`. At the cap only extraction runs. Concepts taught only by Paused Sources are skipped.
4. **Extraction plan**: stage `extract.json` (agent `extract` with all known Concepts for dedupe/attach) -> `finish`: slice Passages with `sliceAnchor` (agent never copies text), insert `concepts` + `passages`, mark chapter `extracted`. All anchors dropped -> `AnchorsNotFound`, `extract.rejected.json`, job stuck.
5. **Clip plan** (job dir `jobs/<id>/`): `script.json` (agent `script` + `checkScript` gates + lexicon append) -> `verify.json` (agent `verify` against Passages) -> `narration.json` (+ `narration.wav`; TTS + align; >60 s sends back) -> `scene.json` (agent `scene` writes TSX) -> `clip.mp4` (render; on failure re-send scene with error up to 2x). Gate failures write `feedback.json` and delete later stage files (max 2 rewrites per gate: check/verify/duration). Still too long and no Clip yet -> agent `split` into 2–3 Concepts (never re-split). `finish`: insert `clips` row, move mp4 to `clips/<conceptId>-<angle>.mp4`, delete job dir.
6. **Checkpoints**: presence of each stage file is the resume point (written `.tmp` then renamed). A crash mid-stage reruns only that stage.
7. **Retry policy**: rate-limited -> requeue, not counted, queue pauses until `max(claude_calls.retry_at)`; `SceneFailed` up to 5 attempts; `AgentFailed` / any extraction error up to 2; everything else -> `stuck`. Stuck jobs only come back via `retry` (CLI/PWA).
8. **Feed**: `feed.next()` = unseen new-Concept Clips round-robin by Source, a due Review interleaved every third slot, then remaining Reviews. Presses -> `events` row (append-only, `clientEventId` unique for idempotent offline sync) + state change in same transaction: seen-to-end/✅ advance ladder (1/3/7/21/60 d, then Retired `graduated`); ⏭️ Retired `known`; 🤔 resets to step 0 and queues a `new_angle` job with the next unused fit Angle, or marks `notLandingAt` when out of Angles; 🚩 hides the Clip and lands in the inbox.
9. **Inbox**: derived (flags unresolved, not-landing Concepts, stuck jobs). Only `events.resolvedAt` is stored for it.

## 4. HTTP server

- No framework: `node:https.createServer` with one async listener `feedApp`, routing by `"${method} ${pathname}"` string compare. Bodies parsed by hand (`JSON.parse` of the whole stream, no size limit, no validation). Errors -> bare 500 + `console.error`.
- Listens on `127.0.0.1` and `config.zerotierIp` only, port `config.port` (8443). TLS from `DOOMLEARN_HOME/tls/{cert,key}.pem` made by mkcert; refuses to start without `zerotierIp` or cert. **No auth**: network reachability (ZeroTier) is the only access control.
- Routes: `GET /api/next`, `GET /api/today`, `GET /api/search?q=`, `GET /api/inbox`, `POST /api/resolve {eventId}`, `GET /api/sources` (= `sources.status()`), `POST /api/sources?name=` (raw file body -> tmp -> `sources.add`, 422 on `Refused`), `POST /api/pause|resume {sourceId}`, `POST /api/retry {jobId}`, `POST /api/press {clipId, button, clientEventId, reason?, note?}`, `POST /api/seen {clipId, clientEventId, completed}`. Anything else: `/clips/<basename>` from `home/clips`, otherwise static from `web/` (basename only, so no subfolders), with HTTP Range support for video.
- Missing: no stats/config/usage endpoint, no worker status/live events (no SSE/WebSocket), no `reconvert` route, no health check.

## 5. PWA

- Files: `web/index.html` (shell + all CSS), `web/app.js` (single classic script), `web/sw.js`, manifest, icons. No framework, no bundler, no TypeScript, no tests, no lint. HTML built via template strings + `innerHTML` with a hand-rolled `esc()`.
- State: module-level `let`s (`upcoming`, `rendered`, `sound`, `current`, `layers`), `localStorage` keys `queue` (pending POSTs with `clientEventId`) and `handled` (clip ids handled locally); Cache Storage: `shell` (app shell, stale-while-revalidate), `clips` (buffered upcoming mp4s, page-managed by `keepBuffer`), `api` (last good GET responses for offline). `history` layers for back navigation.
- Offline: `sw.js` serves shell and buffered Clips (slicing byte ranges from cached blobs); `/api` always goes to network; app falls back to cached GETs; press queue flushed in order, every 30 s, on reconnect and on next press; 5 s request timeout because a Mac off ZeroTier hangs.
- Screens: Feed (vertical scroll-snap, one `<video>` per slide, right rail ✅ 🤔 ⏭️ 🚩, sideways swipe shows Passage, nudge after 3 loops, "tap for sound"), Done-for-today (`/api/today`), Search 🔍, Inbox 📥 (badge; resolve flags, retry stuck, see Passages of not-landing), Sources 📚 (drop/upload, progress bars, pause/resume, retry stuck chapters, refusal card), full-screen player from search/inbox, 🚩 reason sheet. UI copy in English; Clips in pt-BR.

## 6. Config

- `DOOMLEARN_HOME` (default `~/doomlearn`) is the only env var read by app code (`data.ts:36`). Test-only: `DOOMLEARN_SMOKE`, `DOOMLEARN_REAL_MEDIA`. Implicit: `ANTHROPIC_API_KEY` changes `claude -p` billing (README); `PATH` must have `claude`, `ffmpeg`, `ffprobe`, `calibre-debug`, `ebook-convert`, `python3.12`.
- `config.json` (shallow merge over defaults, per-stage merge for `claude`, no validation, read once at startup): `bufferTarget` 10, `dailyClipCap` 15, `port` 8443, `zerotierIp` (required), `claude.{extract,script,verify,split,scene}.{model,effort}` (opus; effort medium for extract, low others).
- Hard-coded tunables (not configurable): 60 s Clip cap, word budget 85–175, 2 rewrites per gate, 5 render retries, 10 min claude timeout, 15 min default rate-limit wait, ladder days, 3 shortest Passages, voice/language (pt-BR, faber.wav), music style, -14 LUFS, 1080x1920@30, scanned-PDF threshold 50%.
- Layout: `config.json`, `doomlearn.db` (+ `-wal`, `-shm`), `sources/<id>/{original.<ext>, chapters/<seq>.txt}`, `jobs/<id>/{extract.json | script.json, verify.json, feedback.json, narration.{json,wav}, scene.json, render/, clip.mp4}`, `clips/<conceptId>-<angle>.mp4`, `tls/{cert,key}.pem`. Observed on the Learner's Mac also: `server.log`, manual `doomlearn.db.bak-*` files (no backup tooling exists).

## 7. Claude usage

- `claude -p --model M --effort E --system-prompt-file <prompt> --tools '' --safe-mode --strict-mcp-config --no-session-persistence --output-format json --json-schema <schema>`; input JSON on stdin; `execFile` with 10 min timeout and 64 MB buffer. Uses the Learner's Claude Code login (subscription); never `--bare`.
- Output parsing (`parseClaudeOutput`): array of messages; last `result`; `api_error_status === 429` -> `retryAt` from a rejected `rate_limit_event.resetsAt`, else now + 15 min; error if `is_error`, non-zero exit, or no `structured_output`.
- `claude_calls` row per call: stage, jobId, sourceId (via job's chapter or Concept), costUsd, tokensIn (incl. cache), tokensOut, durationMs, isError, apiErrorStatus, retryAt, at. The rate-limit pause is `max(retry_at)` read each tick, so it survives restarts.
- Stats: `npm run doomlearn -- stats` prints `console.table` per stage/day/source/clip. **Not exposed over HTTP / in the PWA.** No notion of plan limits, remaining quota, or 5-hour/weekly windows beyond the 429 reset time. `rate_limit_event`s with status other than `rejected` (e.g. warnings, utilization) are ignored.
- Provider lock-in: only one Agent implementation, tied to the `claude` CLI flags and output shape.

## 8. Python

- Three venvs under `python/{tts,align,convert}/.venv`, created by `npm run setup:python` (also `prestart`/`presmoke` hooks), `python3.12` required, pinned requirements, no lockfile/hash pinning, no uv/poetry.
- `tts` and `align` are long-lived stdio JSON-line servers spawned lazily by `media.ts`; `convert/pdf.py` is a one-shot; `convert/ebook.py` runs under Calibre's bundled Python (not the venv).
- Mac-only: TTS `ChatterboxTTS.from_pretrained("mps")` (hard-coded device), alignment via `mlx-audio` (MLX = Apple Silicon only). Models download from Hugging Face on first run (no cache config, no progress UX). No Python tests, no lint.

## 9. Tooling

- `package.json` scripts: `start` (with `prestart` python setup), `doomlearn` (CLI), `test`, `smoke` (+`presmoke`), `typecheck` (`tsc`), `setup:python`, `db:generate`. Node >= 24 (type stripping, `node:sqlite`). `"private": true`, version 0.0.0.
- tsconfig: strict, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`; includes only `src` + `drizzle.config.ts` (remotion/, web/, vendor/ not typechecked).
- Test runner: `node:test` + `node:assert/strict`. No coverage.
- **None of**: linter/formatter (no eslint/biome/prettier config; style consistent by hand), CI (`.github/` absent), git hooks (only `.sample`), Dockerfile/devcontainer, `.nvmrc`, `.env.example`, CONTRIBUTING, CHANGELOG, issue/PR templates, release process, ADR folder (`docs/adr/` referenced by AGENTS.md/docs but does not exist).
- Docs: README (setup, use, config table, license), CONTEXT.md (glossary, 45 lines), `docs/agents/*` (agent workflow config). Design decisions live only in closed GitHub issues.

## 10. Dependencies and licenses

| Dep | Version | License | Note |
|---|---|---|---|
| remotion, @remotion/{bundler,renderer,media,captions,google-fonts} | 4.0.534 (exact) | Remotion License (source-available; free for individuals / companies <= 3, else paid) | Why LICENSE has an AGPL section 7 additional permission |
| drizzle-orm / drizzle-kit | ^1.0.0-rc.4 | Apache-2.0 | pre-release |
| react, react-dom | 19.3.0 | MIT | only used by Remotion scenes |
| typescript | ^7.0.2 | Apache-2.0 | dev |
| @types/node, @types/react | | MIT | dev |
| vendor/explainroo/audio | copied | MIT (Vincent Schmalbach) | not an npm dep, no version/upstream ref recorded |
| python/tts/vendor/chatterbox | copied | MIT (Resemble AI) | shadows pip `chatterbox-tts` |
| chatterbox-tts (git pin), torch 2.6 | | MIT / BSD | Python |
| mlx-audio 0.5.8 | | MIT | Apple Silicon only |
| pymupdf4llm 1.28.2 (pymupdf) | | **AGPL-3.0** (Artifex, or commercial) | drove doomlearn's AGPL choice |
| Calibre (external CLI) | | GPL-3.0 | invoked as a process |
| ffmpeg (external CLI) | | LGPL/GPL | |
| Claude Code CLI (external) | | proprietary | requires an Anthropic account |
| TTS voice `faber.wav` | | CC0 (Nabu Casa) | |
| Models: Chatterbox pt-BR, Qwen3-ForcedAligner-0.6B-8bit | | per HF model cards (not checked here) | downloaded at runtime |

Project license: AGPL-3.0-only + Remotion additional permission.

## 11. LOC (wc -l)

| Area | LOC |
|---|---|
| src non-test TS | ~2,000 (pipeline 412, feed 212, sources 178, server 147, schema 165, claude 119, convert 106, inbox 93, narration 88, media 82, render 80, agent 73, script 71, cli 67, data 65, stats 36, anchor 31, main 16) |
| src tests | ~2,330 (stages 418, feed 411, sources 358, server 279, pipeline 208, claude 127, narration 118, inbox 91, fakes 83, render 75, convert 71, stats 58, smoke 54, script 54) |
| prompts + remotion/api.md | ~250 |
| remotion/ TSX/TS | ~150 |
| web/ | ~830 (app.js 664, index.html 99, sw.js 49) |
| python own | ~165 (+ vendored chatterbox ~35 files) |
| drizzle SQL | ~115 + snapshots |
| vendor/explainroo | ~2,270 |

Tests-to-code ratio > 1:1 in src. Total own code is small (~3,500 LOC incl. PWA).

## 12. Contributor friction (ranked, with evidence)

1. **Hardware lock-in: macOS + Apple Silicon only.** TTS hard-codes `"mps"` (`python/tts/server.py`), alignment is MLX (`python/align`), README "Supported host: macOS on Apple Silicon only". No CPU/CUDA fallback, no remote/API TTS option in the `Media` port's real impl. A Linux/Windows contributor cannot run `npm start` or the smoke.
2. **Heavy, manual system prerequisites.** Node 24, python3.12, ffmpeg, Calibre, mkcert + CA install on phone, ZeroTier on both devices, Claude Code logged in; multi-GB model downloads on first use. No Docker/devcontainer, no `doctor`/preflight command, `npm start` fails first run by design (asks for `zerotierIp`).
3. **Single-provider agent, single-user network model.** Only `claude -p` (`claude.ts`); spending a contributor's subscription; no API-key/OpenAI/local-model adapter. Server requires ZeroTier IP + mkcert TLS (`server.ts serve()`); no localhost-only/dev mode, no auth, so it cannot be exposed any other way safely.
4. **No CI, lint, formatter, hooks.** Nothing enforces `npm test`/`tsc` on PRs; style is consistent only by discipline. `remotion/`, `web/`, `vendor/` are outside `tsc`.
5. **Untyped, untested PWA in one 664-line file.** Vanilla JS + `innerHTML` templates + global mutable state (`web/app.js`), no component model, no tests, CSS inlined in `index.html`. Hardest area to change safely; most likely area for outside UI contributions.
6. **Hand-rolled HTTP layer.** If-chain router, no request validation, unbounded `JSON.parse` bodies, generic 500s, `serve()` not injectable (hard-wires `localMedia`). Adding routes (stats, config, live status) means growing the chain.
7. **Flat `src/` mixing layers.** Domain rules (feed, pipeline, sources), adapters (claude, convert, render, media), transport (server, cli), and data (schema, data) side by side; package boundary between server, worker, PWA, Remotion harness and Python is implicit. Not a monorepo, no workspaces, despite 4 runtimes (Node server/worker, browser, Remotion bundle, Python).
8. **Runtime mutation of a versioned repo file.** `pipeline.ts` writes new terms into `src/lexicon.json` (`LEXICON_FILE`); the owner commits them by hand. A contributor's local runs dirty the tree; installed-package use would write into node_modules.
9. **Configuration is thin and opaque.** Shallow-merged unvalidated JSON read once at startup; most tunables hard-coded (section 6); language/voice fixed to pt-BR; no config UI, no hot reload; Claude usage only via CLI `console.table`.
10. **Decisions undocumented in-repo.** Rationale lives in 33 closed issues; `docs/adr/` referenced but missing; no architecture doc, no CONTRIBUTING, no API docs for the HTTP routes.
11. **Pre-release / exotic toolchain choices.** drizzle 1.0 RC, TypeScript 7 native, Node 24 type stripping (no build), Remotion license constraints for company contributors; vendored code without upstream version refs.
12. **Observability.** `console.log/warn/error` only; no structured logs, no worker status endpoint; `server.log` is an external redirect. Stuck reasons only in `jobs.lastError`.

## 13. Keep / change candidates

**Keep (solid domain logic, well tested, transport-agnostic):**
- `agent.ts` port + typed `AgentStages`, and the `Media` port shape: clean seams that already make 97 fast tests possible. Natural place for more adapters (other LLM providers, remote/CPU TTS).
- `pipeline.ts` job model: disk checkpoints per stage, atomic `.tmp`+rename, idempotent resume, per-gate rewrite budgets, split-once rule, rate-limit pause persisted in `claude_calls`. Could be split into files but the logic is the product.
- `feed.ts` ladder / composition / press semantics with `clientEventId` idempotency; `inbox.ts` derived-state approach.
- `anchor.ts` + "code slices Passages, agent never copies text"; `script.ts` deterministic gates; `narration.ts` shown/spoken mapping.
- `convert.ts` + python converters (TOC/outline split, DRM/scanned refusals) and their fixtures.
- `schema.ts` + drizzle migrations (SQLite, FTS5 search), single-file data folder.
- Remotion harness contract (`remotion/harness.tsx` + `api.md`) and sound mix.
- `claude.ts` output parsing + `claude_calls` usage log (basis for a stats/limits screen).
- PWA offline model (SW range-slicing cached clips, idempotent press queue) as behavior, even if reimplemented.
- Test style: integration-level through public module APIs with fakes.

**Change (MVP shortcuts):**
- Mac-only media runtimes -> device selection (mps/cuda/cpu) and/or pluggable TTS/aligner adapters.
- `serve()` ZeroTier+mkcert assumption -> configurable bind/TLS modes (localhost dev, LAN, tunnel), plus some auth.
- If-chain router + hand body parsing -> a small router/framework with schema validation; add stats/usage, config, worker status, live updates routes.
- `web/app.js` monolith -> typed, componentized PWA with a build step and tests.
- Flat `src/` -> explicit packages/layers (domain core, adapters, server, worker, cli, web, remotion harness, python runtimes).
- `config.json` -> validated schema, more tunables exposed, editable from the PWA.
- Lexicon mutated in repo -> lexicon in DOOMLEARN_HOME (seeded from the versioned default).
- main.ts single process with `while(true)` -> keep simple but add graceful shutdown/status; worker controllable (pause/run window) from PWA.
- Add CI (test + typecheck), lint/format, hooks, Docker/devcontainer for non-Mac parts, CONTRIBUTING, ADRs extracted from the decision issues.
