# R10 — Codex provider spike

Abbreviations: `$S` = (session scratchpad), `$R` = `$S/r10` (all spike files), `$C` = `$S/repos/codex/codex-rs` (clone `3b6ab34`, 2026-10-08).
Live quota used: 5 `codex exec` calls (gpt-5.6-luna, effort low) plus 4 `app-server` probes. The probes call `account/rateLimits/read`, which does not use model quota. `~/.codex` was not edited.

**Version note:** the installed CLI is now `codex-cli 0.162.0`, not 0.151.0. `~/.local/bin/codex` is a symlink to `~/.codex/packages/standalone/current/bin/codex` with mtime Oct 8 21:45, so it auto-updated today. The CLI changes daily, so any argv we pick must be covered by a test.

## Question
Can doomlearn's Agent port use Codex safely and cheaply? Specifically:
- the exact argv and what leaks into the prompt
- how to read the usage numbers
- which tools the model sees
- how a usage-limit failure looks
- how to read limits and models for the PWA
- whether to use raw `execFile` or the official TS SDK

## Findings (with evidence)

### 1. Prompt leaks: global AGENTS.md is injected even with `--ignore-user-config`, and so are skills
- **Zero-quota tool.** `codex debug prompt-input [PROMPT]` renders the exact model-visible input list (`codex debug --help`). Output files are in `$R/out/pi-*.json`; `$R/sum.js` summarizes them.
- **Default run.** In the default home with the owner's config, a "hi" prompt carries:
  - `<skills_instructions>` (21,950 chars)
  - `<permissions instructions>` (3,882)
  - `<collaboration_mode>` (920)
  - `<recommended_plugins>` (876)
  - `<multi_agent_role>` and `<multi_agent_mode>` (2,671)
  - **`# AGENTS.md instructions` (2,758 chars, the owner's `~/.codex/AGENTS.md`)**
  - `<environment_context>` (644)
- **Source.** `--ignore-user-config` only swaps the `config.toml` layer for an empty table (`$C/config/src/loader/mod.rs:508-524`). The global AGENTS.md comes from `CodexHomeUserInstructionsProvider`, which reads `$CODEX_HOME/AGENTS.override.md`, then `AGENTS.md` (`$C/codex-home/src/instructions/mod.rs:41-80`). `AgentsMdManager` always calls it (`$C/core/src/agents_md_manager.rs:103-106`). No config key gates it. **So yes: it is injected under `--ignore-user-config`.**
- **Skills leak from outside CODEX_HOME.** With `CODEX_HOME=<empty dir>`, skills still render (7,097 chars, roots include `~/.agents/skills`). So a separate CODEX_HOME alone is not enough.
- **Stopping each block.** These keys are verified with `debug prompt-input` (`$C/config/src/config_toml.rs:257-269`, `config/src/skills_config.rs:45-47`):
  `-c skills.include_instructions=false -c include_permissions_instructions=false -c include_collaboration_mode_instructions=false -c include_apps_instructions=false -c include_environment_context=false`.
  - The multi-agent blocks come from the *model* catalog (`multi_agent_version`). They appeared for the owner's default `gpt-6-astra` but not for `gpt-5.6-luna` (`$R/out/t2.json`). `--disable multi_agent` also removes them.
  - `<recommended_plugins>` disappears under an empty CODEX_HOME (`$R/out/pi-empty-flags.json`).
  - With an empty CODEX_HOME, the flags above, and `-m gpt-5.6-luna`, the input is **only the user prompt** (2 chars).
- **Live token counts.** Same prompt and schema each time; script `$R/run.sh`, outputs in `$R/live/`:

  | Run | Extra flags over R3 argv | input_tokens | cached | tools model reports |
  |---|---|---|---|---|
  | L1 | none (R3 argv minus `model_instructions_file`) | 10,563 | 0 | exec, wait, request_user_input |
  | L2 | `+model_instructions_file` | 7,041 | 2,816 | exec, wait, request_user_input |
  | L3 | L2 + 5 suppress flags + `tools.experimental_request_user_input.enabled=false` + `CODEX_HOME=$R/home-link` | 4,014 | 0 | exec, wait |
  | L4 | L3 repeated | 4,014 | 0 | exec, wait |
  | L5 | L3 + the six `--disable`s (final argv below) | 3,021 | 0 | exec, wait |

  The remaining ~3k tokens are the stage instructions, the output schema, and the code-mode `exec`/`wait` tool specs (see §3).
- **Cheapest way to stop AGENTS.md:** use a doomlearn-owned CODEX_HOME. No flag exists for it.
- **Copying auth.json is NOT safe:**
  - ChatGPT refresh tokens are single-use. A reused one fails with `refresh_token_reused` ("Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", `$C/login/src/auth/manager.rs:207,1688`).
  - A refresh fires when the access token is within 5 min of expiry, or when `last_refresh` is older than 8 days (`manager.rs:203-204, 3001-3022`). The current `last_refresh` is 2026-10-06.
  - So a refresh inside a copy would rotate the token and log out the owner's real `~/.codex`.
- **A symlink is safe for refresh.** `FileAuthStorage::save` does `OpenOptions::truncate+write` on the path (`$C/login/src/auth/storage.rs:214-231`), which follows a symlink and writes the real file. L3 and L4 ran with `$R/home-link/auth.json -> ~/.codex/auth.json` and authenticated fine.
- **Side effect:** codex filled the custom home with `state_5.sqlite`, `logs_2.sqlite`, `models_cache.json`, `skills/`, `plugins/`, `shell_snapshots/` and more (`ls $R/home-link`). Both `--ephemeral` and `--ignore-user-config` were on.

### 2. `input_tokens` includes cached tokens; `output_tokens` includes reasoning tokens
- **Source:**
  - `TokenUsage::non_cached_input() = input_tokens - cached_input` (`$C/protocol/src/protocol.rs:2488-2490`).
  - The SSE mapping copies `input_tokens` and takes `cached` from `input_tokens_details.cached_tokens` (`$C/codex-api/src/sse/responses.rs:128-138`).
  - exec JSONL passes `usage.total.*` through unchanged (`$C/exec/src/event_processor_with_jsonl_output.rs:118-128`).
- **Live:** L2 reports `input_tokens 7041` and `cached_input_tokens 2816`. Cached is a subset of input.
- **Cache behaviour:** an identical repeat (L4) did **not** hit the cache (cached 0). Each `--ephemeral` exec is a new thread, so expect few cache hits.
- **Reasoning tokens:** `blended_total = non_cached_input + output_tokens` uses no reasoning term (`protocol.rs:2492-2495`). L1 has `output 119`, `reasoning 88`, and a ~30-token answer, which matches an inclusive count. **R3's `tokensOut = output + reasoning` double-counts.**

### 3. Tools exposed to a doomlearn call
- **What the model reported:** it listed its own tools (L1–L4 `*.last.json`).
  - Under the R3 argv: `functions.exec`, `functions.wait`, `functions.request_user_input`.
  - `-c tools.experimental_request_user_input.enabled=false` removes `request_user_input` (`$C/core/src/config/mod.rs:2732-2738`, `tools/spec_plan.rs:1349`).
- **`exec`/`wait` are code-mode tools** (`$C/code-mode-protocol/src/lib.rs:54-55`) and cannot be disabled by a flag:
  - `requested_tool_mode` takes `model_info.tool_mode` first, before any feature (`$C/core/src/tools/mod.rs:63-72`).
  - `codex debug models` shows `tool_mode: code_mode_only` for every listed model. Only hidden `gpt-5.5` has none, which means direct mode.
- **No tools came from apps, browser_use, computer_use, image_generation, multi_agent or plugins** in any run. `--ignore-user-config` drops the MCP servers and plugin entries (R3 §2). Image generation needs ChatGPT-auth gating plus model support (`spec_plan.rs:800-812`). Multi-agent tools need a V1/V2 multi-agent version; luna is `v1`, and `--disable multi_agent` is cheap insurance (`spec_plan.rs:747-758`).
- **Exact disable list:** `--disable multi_agent --disable apps --disable plugins --disable image_generation --disable browser_use --disable computer_use`, plus `-c features.shell_tool=false -c web_search="disabled" -c tools.experimental_request_user_input.enabled=false`. Only `request_user_input` showed up as a separate tool, yet the six `--disable`s still cut input from 4,014 to 3,021 tokens (L3 → L5). Some feature text likely sits inside the code-mode `exec` description; this is not isolated per feature. Keep them all.

### 4. `codex app-server`: experimental, and the probe works
- **Verbatim help text.** `codex --help` (0.162.0) line 16: `  app-server        [experimental] Run the app server or related tooling`. `codex app-server --help` begins `[experimental] Run the app server or related tooling`.
- **The contradiction.** R3 §7 is correct. R4 line 95 ("not marked experimental in the README grep") is wrong for the CLI. The README marks only some methods "(experimental)", behind an `experimentalApi` opt-in (`$C/app-server/README.md:53,135,144`).
- **Pitfall:** ctx7's top hit for "initialize" is the separate **exec-server** protocol (`clientName` param), not app-server.
- **Handshake.** `InitializeParams = {clientInfo:{name,title,version}, capabilities: {experimentalApi, requestAttestation, …} | null}` (`$C/app-server-protocol/schema/typescript/InitializeParams.ts`, `ClientInfo.ts`, `InitializeCapabilities.ts`). It is followed by the notification `{"method":"initialized"}` with no params (`src/protocol/common.rs:2903-2911`).
- **Probe script:** `$R/probe/limits.mjs` (48 lines, spawns `codex app-server`, stdio). Observed sequence (`$R/out/probe1.err`):
  ```
  -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"doomlearn","title":null,"version":"0.0.0"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}
  <- notification remoteControl/status/changed
  <- result {userAgent:"doomlearn/0.162.0 (...)", codexHome:"~/.codex", platformFamily, platformOs}
  -> {"jsonrpc":"2.0","method":"initialized"}
  -> {"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":null}
  <- notification account/updated
  <- result {ordinaryUsageAllowed, rateLimits:{limitId:"codex",primary:{usedPercent,windowDurationMins:300,resetsAt},secondary:{…10080…},credits,planType:"plus",rateLimitReachedType}, rateLimitsByLimitId:{codex, base_model_inference}, rateLimitResetCredits:{availableCount:3,…}, accountId, rateLimitUpsell}
  ```
  Full result: `$R/out/probe1.json`.
- **Timing, spawn to response:** 545 / 467 / 459 ms (wall 634 / 528 / 524 ms) over 3 runs (`$R/out/probe-t{1,2,3}.err`). `initialize` returns in ~40 ms; the rest is the backend call.
- **New data for the PWA:** `rateLimitResetCredits` lists 3 free "Full reset (Weekly + 5 hr)" credits. `rateLimitsByLimitId.base_model_inference` is a separate weekly window for `gpt-reserve`.

### 5. Usage-limit failure shape (regression fixture)
- **Message text:** `CodexErr::UsageLimitReached` displays through `UsageLimitReachedError` (`$C/protocol/src/error.rs:149-150, 701-800`). It is not retryable (`error.rs:419`) and maps to `CodexErrorInfo::UsageLimitExceeded` (`error.rs:478-480`).
- **Event order:** core builds `ErrorEvent{message: self.to_string()}` (`error.rs:514-515`). App-server sends `Error` with `will_retry:false` and stores it as `last_error` (`$C/app-server/src/bespoke_event_handling.rs:1624-1640`). The turn then completes `Failed` carrying that error.
- **JSONL output:** exec writes `error`, then `turn.failed`; the message gets `(additional_details)` only when non-empty (`event_processor_with_jsonl_output.rs:447-456, 538-556`).
- **Exit code:** 1, because `error_seen` is set on an `Error` with `!will_retry` (`$C/exec/src/lib.rs:1300-1403`).
- **Usage:** no `turn.completed`, so there is no usage on failure.
- **Fixture** for a Plus plan with a reset today. The time is local `%-I:%M %p`; another day renders as `Oct 9th, 2026 3:45 PM` (`error.rs:826-838`):
  ```
  {"type":"thread.started","thread_id":"01a11d49-0000-7000-8000-000000000000"}
  {"type":"turn.started"}
  {"type":"error","message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM."}
  {"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM."}}
  ```
  exit code 1.
- **Variants worth testing:**
  - `You’ve hit your usage limit for {name}. Switch to another model now, or try again at …`
  - `Your workspace is out of credits. …`
  - `You hit your spend cap …`
  - `… Try again later.` (no reset time)
- The apostrophe is U+2019 (`’`), so a regex must not hard-code `'`.

### 6. Models and efforts per login
- **`codex debug models`** ("Render the raw model catalog as JSON", refreshes unless `--bundled`). It is a debug command, so it is not a stable contract. Output: `$R/out/debug-models.json`.
- **`model/list`** on app-server (`common.rs:1115`) is the documented path. It returns `Model{model, hidden, supportedReasoningEfforts:[{reasoningEffort,description}], defaultReasoningEffort, …}` (`schema/typescript/v2/Model.ts`). Live output (`$R/out/probe1.json`, last line):

  | model | hidden | default | efforts |
  |---|---|---|---|
  | gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra | no | low/medium | low…ultra |
  | gpt-6-luna, gpt-5.6-luna | no | medium | low…max |
  | gpt-reserve, codex-auto-review | yes | medium | low…max |
  | gpt-5.5 | yes | medium | low…xhigh |

- **The list moved during the day:** R3's cache, earlier today, had no `gpt-6*`.
- **Effort enum.** The protocol enum is `none|minimal|low|medium|high|xhigh|max|ultra|persistent|Custom` (`$C/protocol/src/openai_models.rs:60-73`), and the TS SDK has `minimal…persistent` (`sdk/typescript/src/threadOptions.ts`). No model this login offers supports `minimal` or `none`.
- **R8 is wrong.** `z.enum(['minimal','low','medium','high','xhigh'])` allows an unsupported `minimal` and rejects `max` and `ultra`, which most listed models offer. Its example `gpt-5.5` is a hidden model.
- **Use** `effort: z.enum(['low','medium','high','xhigh','max','ultra'])`, with an example model `gpt-5.6-luna`. Check model and effort against `model/list` at startup and in the PWA settings form, as a warning rather than a hard schema rule, because the catalog changes daily.

### 7. Official Codex TS SDK
- **Package.** `npm view @openai/codex-sdk`: latest is `0.162.0`, published 2026-10-08T19:03Z (today), so **not 7 days old**. The newest version at least 7 days old is `0.159.3` (2026-09-30). There are 133 stable versions, with almost daily releases. It depends on `@openai/codex@<same>`, which brings its own platform binary; `codexPathOverride` points it elsewhere (`sdk/typescript/src/exec.ts:50-58, 356`).
- **What it wraps:** `codex exec --experimental-json` through `spawn`, not app-server (`exec.ts:95, 203`).
- **Supported features:**

  | Feature | SDK support |
  |---|---|
  | outputSchema | yes, written to a temp file, then `--output-schema` (`turnOptions.ts`, `outputSchemaFile.ts`) |
  | model | yes |
  | effort | yes |
  | abort | yes, `TurnOptions.signal` (`exec.ts:205`) |
  | system instructions | only through raw `configOverrides` (`model_instructions_file=…`) |
  | `--ignore-user-config` | no (absent from `exec.ts` argv builder lines 95-200; it is a CLI flag, not a `-c` key) |
  | `--ephemeral` | no |
  | `--ignore-rules` | no |
  | `-o` | no |

- **Error handling:** it throws a plain `Error(turn.failed.message)` or `Codex Exec exited with code N: <stderr>` (`thread.ts:133-139`, `exec.ts:250-255`). The structured event stream is lost in the throw, so the parser would still be needed.
- **Verdict: raw `execFile`.** The SDK cannot pass `--ignore-user-config`, `--ephemeral` or `--ignore-rules`. It pins a second codex binary that is younger than 7 days. It would hide the JSONL we need for `agent_calls` and rate-limit parsing. doomlearn already has the `execFile` + pure-parser pattern in `src/claude.ts`.

## Recommendation for doomlearn v2

**Final argv** (run with `execFile`, stdin = stage input JSON, env `CODEX_HOME=<doomlearn data>/codex-home`):
```
codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
  -s read-only -C <empty job dir> -m <model> -c model_reasoning_effort="<effort>"
  -c model_instructions_file="<abs stage prompt>" --output-schema <abs schema> -o <job dir>/<stage>.codex.json
  -c web_search="disabled" -c features.shell_tool=false -c project_doc_max_bytes=0
  -c tools.experimental_request_user_input.enabled=false
  -c skills.include_instructions=false -c include_permissions_instructions=false
  -c include_collaboration_mode_instructions=false -c include_apps_instructions=false
  -c include_environment_context=false
  --disable multi_agent --disable apps --disable plugins --disable image_generation
  --disable browser_use --disable computer_use
  "<one-line task>"
```

**CODEX_HOME setup** (on server start, idempotent):
- `mkdir <data>/codex-home`
- symlink `auth.json` to `~/.codex/auth.json` (never copy it, §1)
- If the owner has no `~/.codex/auth.json`, report "run `codex login`".
- The `codex-home` dir must be git-ignored.

**Test seam:** a test asserts the argv and runs `codex debug prompt-input` with the same `-c` flags and `CODEX_HOME`. It fails if anything but the user prompt appears. This is a zero-quota drift check on CI-less Mac runs; skip it when `codex` is absent.

**Parser rules (`parseCodexOutput`):**
1. Split stdout on `\n` and `JSON.parse` each non-empty line, ignoring lines that fail.
2. `ok` if there is a `turn.completed` **and** the last `item.completed` with `item.type==="agent_message"` passes `JSON.parse`.
3. The error is `turn.failed.error.message` ?? the last `error.message` ?? stderr ?? `exit <code>`.
4. Usage comes from `turn.completed.usage`:
   - `tokensIn = input_tokens` (already includes cached)
   - `tokensOut = output_tokens` (already includes reasoning)
   - optional columns `cachedTokensIn`, `reasoningTokensOut`
   - `costUsd = null`
5. Rate-limit detection: the message matches `/hit your usage limit|out of credits|spend cap/i`. This is safe for the U+2019 apostrophe because the pattern avoids it.

**Limits probe design:**
- A `codexLimits()` helper spawns `codex app-server` per query and runs `initialize` → `initialized` → `account/rateLimits/read`, ~0.5 s per run. It kills the child after the response, with a 15 s timeout.
- Run it with the same `CODEX_HOME` and auth symlink so it reads the same account.
- **Callers:**
  - (a) On a rate-limit failure, `retryAt` = max `resetsAt` over windows with `usedPercent>=100`, falling back to +15 min. Never parse "Try again at 3:45 PM".
  - (b) The PWA "Codex limits" card, on demand, showing 5 h and weekly `usedPercent`/`resetsAt`, `credits`, and `rateLimitResetCredits.availableCount`.
  - (c) The `model/list` call for the settings form and the startup check.
- Treat app-server as experimental. Validate the response with a lenient zod schema (`.passthrough()`), and show "limits unavailable" on any failure instead of failing a job.

**Schema:** `effort: z.enum(['low','medium','high','xhigh','max','ultra'])` for codex, `model: z.string()` (example `gpt-5.6-luna`), plus a runtime warning from `model/list`. Drop R8's `minimal`.

## Open questions
- **Code mode.** Every listed model forces code-mode `exec`/`wait` tools. With shell off and a read-only sandbox, what can `exec` reach? It runs JS in a code-mode host (`code_mode_host` feature, on by default). Is that acceptable for doomlearn, or should a stage pin a Direct-mode model (only hidden `gpt-5.5`)? Not verified.
- **Shared refresh.** Is a shared auth.json via symlink safe under concurrency? doomlearn and the owner's interactive codex could refresh at the same moment and race to `refresh_token_reused`. Codex has a reload-and-match path (`manager.rs:1989, 2485`), but I did not test the race.
- **Hooks.** Does `~/.codex/hooks.json` (present on this machine) run under `--ignore-user-config` with the real home? The custom CODEX_HOME avoids it either way. Not checked in source.
- **Keychain.** Some users store auth in the keychain (`cli_auth_credentials_store`, `config_toml.rs:293`). With a custom CODEX_HOME the keyring key may differ, so the symlink trick only covers file storage. Needed only if v2 targets other users.
- **Live failure fixture.** The usage-limit fixture is built from source, not from a live failure. Capture a real one when it happens, and keep the stdout in `tests/fixtures`.
- **`--ignore-user-config` and the probe.** Should the limits probe pass `--ignore-user-config`? Does app-server accept it? `codex app-server --help` shows no such flag, and `app-server/src/config_manager.rs:357` sets it internally only in some paths.
