# R3 — Codex CLI as a second agent provider

Abbreviations: `$S` = (session scratchpad), `$C` = `$S/repos/codex` (shallow clone of openai/codex, commit `3b6ab347`, 2026-10-08).

## Question

How can doomlearn call the local `codex` CLI (0.151.0, `~/.local/bin/codex`) without interaction, as a drop-in alternative to `src/claude.ts`? The same contract has to hold: one call per stage, a stage system prompt, JSON input on stdin, output that matches a JSON Schema, model and effort set per stage, a `claude_calls` row for every call, and a rate limit that pauses the queue until the reset. This report also proposes an Agent port that fits both providers.

## Findings (with evidence)

### 1. Flags for headless use
`codex exec --help` (run 2026-10-08) lists every flag below.
- `--json` prints the events to stdout as JSONL. `-o, --output-last-message <FILE>` writes the final message to a file.
- `--output-schema <FILE>` takes the path to a JSON Schema file that describes the final response.
- `-s, --sandbox read-only|workspace-write|danger-full-access`. The docs say read-only is the default for exec (https://learn.chatgpt.com/docs/non-interactive-mode).
- `--ephemeral` stops session rollout files from being written. It is the equivalent of `--no-session-persistence`.
- `--ignore-user-config` skips `$CODEX_HOME/config.toml`, and "auth still uses `CODEX_HOME`". `--ignore-rules` skips the execpolicy `.rules` files.
- `--skip-git-repo-check` is required outside a git repo. `-C <DIR>` sets the working root.
- `-m <MODEL>` selects the model. `-c key=value` takes TOML overrides, for example `-c model_reasoning_effort="low"`. `-p <profile>` layers `$CODEX_HOME/<name>.config.toml` on top.
- `--enable/--disable <FEATURE>` is a shorthand for `-c features.<name>=…`.
- Prompt: "If not provided as an argument (or if `-` is used), instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block". The live test confirmed this; see §8.

### 2. Why `--ignore-user-config` is required on the owner's machine
`~/.codex/config.toml` sets values that would otherwise leak into every doomlearn call:
- `model = "gpt-6-astra"`, `model_reasoning_effort = "low"`, `service_tier = "fast"`, `web_search = "live"`
- a `notify` hook
- about 20 `[plugins.*]` entries
- `[mcp_servers.node_repl]` and `[mcp_servers.computer-use]`

Evidence: `grep` of that file. `$C/codex-rs/config/src/loader/mod.rs:516` shows that `ignore_user_config` swaps in an empty TOML table for the user layer, which drops all of the above.

Caveat: the global `~/.codex/AGENTS.md` (2714 bytes on this machine) is loaded by `CodexHomeUserInstructionsProvider`, and that loader is not gated by `ignore_user_config` (`$C/codex-rs/codex-home/src/instructions/mod.rs:60-110`). The test used 10,749 input tokens for a trivial prompt. That number covers the built-in base instructions and probably this file. I did not isolate the cause because only one run was allowed. Project AGENTS.md files are discovered from the cwd (`core/src/agents_md.rs`). Running with `-C` pointed at an empty job dir avoids them. `-c project_doc_max_bytes=0` also skips them (`agents_md.rs:70,133` return early at 0).

### 3. Tools off
- `-c features.shell_tool=false` turns off the shell tool. It is on by default (config reference, https://learn.chatgpt.com/docs/config-file/config-reference).
- `-c web_search="disabled"` turns off web search. The values are `disabled|cached|indexed|live`, with `cached` as the default (same page).
- MCP servers and plugins come from user config, so `--ignore-user-config` removes them (§2).
- In the test, no `command_execution`, `mcp_tool_call` or `web_search` item appeared (§8).
- `-s read-only` stays on as a second layer of protection.
- `codex features list` also shows `apps`, `browser_use`, `computer_use`, `image_generation`, `multi_agent` and `plugins` as `stable true` by default. I did not check whether any of them adds a tool once the user config is ignored. Turning them off with `--disable` is cheap.

### 4. Structured output
- `--output-schema` sends the schema as a `json_schema` named `codex_output_schema` with `output_schema_strict: true` (`$C/codex-rs/codex-api/src/common.rs:407`, `core/src/client_common.rs:52`).
- The final `agent_message.text` is a JSON string that matches the schema. It is also written to `-o` (§8). Unlike Claude's `structured_output`, nothing in the output is pre-parsed, so doomlearn must `JSON.parse` the text.
- Strict mode follows OpenAI Structured Outputs (https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas):
  - "all fields … must be specified as `required`"; an optional field becomes a `["T","null"]` union
  - `additionalProperties: false` is required
  - `$ref`/definitions, `anyOf` (but not at the root), `minItems` and `maxItems` are supported
- I checked doomlearn's schemas with `$S/strictcheck.py`. Every object already has `additionalProperties:false`. There is one incompatibility: `extract.schema.json` `/definitions/anchor/anyOf[1]` leaves `section` optional. That field must become required and nullable, and the extract parser must treat `null` the same as a missing field.

### 5. Choosing model and effort per call
- `-m <slug>` plus `-c model_reasoning_effort="<level>"`. The protocol enum is `none|minimal|low|medium|high|xhigh|max|ultra|persistent|Custom(String)` (`$C/codex-rs/protocol/src/openai_models.rs:60`).
- Which levels are valid depends on the model. From `~/.codex/models_cache.json`:

  | Model | Visibility | Supported levels |
  |---|---|---|
  | `gpt-5.6-sol` | list | low through ultra |
  | `gpt-5.6-terra` | list | low through ultra |
  | `gpt-5.6-luna` | list | low through max |
  | `gpt-5.5` | hidden | low through xhigh |

- Profiles (`-p name` → `$CODEX_HOME/name.config.toml`) also work, but they put files in the user's CODEX_HOME. Per-call `-m`/`-c` flags keep doomlearn's config in doomlearn's own config, which is how the Claude provider is configured today.

### 6. System prompt
- `model_instructions_file` (a path) "replaces built-in instructions" (config reference; key at `$C/codex-rs/config/src/config_toml.rs:275`). `developer_instructions` (a string, `config_toml.rs:254`) adds to them instead.
- `-c model_instructions_file="<abs path>"` is the closest equivalent to `--system-prompt-file`. It would also cut most of the ~10.7k base tokens.
- **Not tested.** Whether the global AGENTS.md is still injected next to it is unknown; see Open questions.

### 7. Exit codes, errors, usage
- **Exit codes:** exec exits 1 when the server reports an `Error` notification with `will_retry=false` or a turn ends `Failed`/`Interrupted` (`$C/codex-rs/exec/src/lib.rs:1300-1403`). It exits 0 otherwise. The docs do not document exit codes.
- **JSONL events** (`$C/codex-rs/exec/src/exec_events.rs`): `thread.started{thread_id}`, `turn.started`, `item.started|updated|completed{item}`, `turn.completed{usage}`, `turn.failed{error:{message}}`, `error{message}`.
- **Error detail is lost:** structured `codexErrorInfo` is flattened into the `message` string, with `additional_details` appended in parentheses (`event_processor_with_jsonl_output.rs:447-456, 540-556`).
- **Usage:** `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` (`exec_events.rs:61-72`).
- **No cost:** there is no `total_cost_usd`, so `claude_calls.costUsd` stays null for Codex. `reasoning_output_tokens` has no column today.
- **Rate limits:**
  - Exhaustion surfaces as `UsageLimitReachedError` (`$C/codex-rs/protocol/src/error.rs:690-806`), which carries `resets_at: DateTime<Utc>` and a full `rate_limits` snapshot.
  - exec JSONL keeps only the Display text: "You’ve hit your usage limit. … Try again at 3:45 PM." That time is local, `%-I:%M %p`, and gets a date only when the reset is not today (`format_retry_timestamp`, `error.rs:826`).
  - Workspace credit messages carry no time at all.
  - So exec `--json` gives **no machine-readable reset time**.
  - exec `--json` emits no `rate_limits`/token_count events (they are not in `ThreadEvent`).
- **Where the reset time can be read:**
  - (a) The session rollout `token_count` events, which `--ephemeral` disables. Real shape from `~/.codex/sessions/2026/08/30/rollout-…jsonl`:
    ```json
    {"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1788102771},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1788689571},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus","rate_limit_reached_type":null}, "info":{total_token_usage,last_token_usage,model_context_window}}
    ```
  - (b) `codex app-server` (marked "[experimental]" in `codex --help`), a JSON-RPC method `account/rateLimits/read` → `GetAccountRateLimitsResponse{ordinaryUsageAllowed, rateLimits: RateLimitSnapshot, rateLimitsByLimitId, rateLimitResetCredits}`. `RateLimitWindow` = `{usedPercent, windowDurationMins, resetsAt (epoch s)}`. There is also an `account/rateLimits/updated` notification (`$C/codex-rs/app-server-protocol/src/protocol/common.rs:1328,2005`; `v2/account.rs:331-339,664-758`).
  - Source (b) also covers the owner's "see my credit limits in the PWA" wish for Codex: 5 h and weekly `used_percent` plus the reset times.

### 8. Live test (run once; trivial quota)
Directory: `$S/codex-test/`. It holds `cmd.txt`, `schema.json`, `stdout.jsonl`, `stderr.txt`, `last.json`, `exit_code.txt`, and an empty `work/`.
```
echo '{"a":2,"b":3}' | codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check \
  -s read-only -C work -m gpt-5.6-luna -c model_reasoning_effort="low" -c web_search="disabled" \
  -c features.shell_tool=false --output-schema schema.json -o last.json \
  "Return sum of a and b from the stdin JSON, and the word 'ok'."
```
Result: exit 0, about 4 s. stderr: `Reading additional input from stdin...`. stdout:
```
{"type":"thread.started","thread_id":"01a11d3f-38a7-7212-ac15-ac322a57c813"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"sum\":5,\"word\":\"ok\"}"}}
{"type":"turn.completed","usage":{"input_tokens":10749,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":37,"reasoning_output_tokens":16}}
```
`last.json` = `{"sum":5,"word":"ok"}`. No reasoning items, no tool items. `work/` stayed empty.

### 9. Billing: ChatGPT login vs API key
- `codex login status` → "Logged in using ChatGPT".
- With a ChatGPT login, calls count against the plan's Codex 5 h and weekly windows plus any credits. A 2026-08-30 rollout shows `plan_type:"plus"`.
- With `CODEX_API_KEY=… codex exec`, or `codex login --with-api-key`, calls bill as API usage instead (https://learn.chatgpt.com/docs/non-interactive-mode, https://learn.chatgpt.com/docs/auth).
- This matches the standing decision for Claude (subscription only, API key only documented): doomlearn should never set `CODEX_API_KEY` itself.

## Recommendation for doomlearn v2

1. **Provider command:**
   ```
   codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
     -s read-only -C <job dir> -m <model> -c model_reasoning_effort="<effort>"
     -c web_search="disabled" -c features.shell_tool=false -c project_doc_max_bytes=0
     -c model_instructions_file="<abs stage prompt>" --output-schema <abs schema file>
     -o <job dir>/<stage>.codex.json  "<one-line task>"
   ```
   Pass the stage input as JSON on stdin; it arrives as the `<stdin>` block. Keep the 10-min kill and the 64 MB `maxBuffer`. Never pass `--dangerously-*`.
2. **Parser** `parseCodexOutput(stdout, exitError)`, a pure function tested like `parseClaudeOutput`:
   - Split the JSONL.
   - `ok` when there is a `turn.completed` and the last `agent_message.text` passes `JSON.parse`.
   - Otherwise the error is `turn.failed.error.message` ?? the last `error.message` ?? stderr.
   - Usage comes from `turn.completed.usage`: tokensIn = input_tokens, which already includes cached tokens (to confirm). tokensOut = output_tokens + reasoning_output_tokens, or a new column.
3. **Rate limit:**
   - If the error message matches `/usage limit|out of credits|spend cap/i`, return `{ok:false, retryAt}`.
   - Get `retryAt` from a separate `codex app-server` `account/rateLimits/read` (the max `resetsAt` among windows with `usedPercent>=100`). Fall back to 15 min, as Claude does.
   - Do not parse the localized "Try again at 3:45 PM" text.
   - The app-server call also gives the PWA a "Codex limits" card.
4. **Schemas:** make `extract.schema.json`'s optional `section` required and nullable, so one schema set works on both providers. Claude's `--json-schema` accepts it unchanged.
5. **Agent port** (keep `Agent.run` as it is; move provider specifics behind it):
   ```ts
   /** Which CLI runs a stage, and how. Per stage in config. */
   type StageModel = { provider: 'claude' | 'codex'; model: string; effort: string };
   /** One provider call's facts, logged to agent_calls (renamed from claude_calls). */
   type CallLog = { provider: 'claude'|'codex'; model: string; effort: string; tokensIn?: number; tokensOut?: number;
     reasoningTokens?: number; costUsd?: number; durationMs: number; isError: boolean; errorStatus?: number; retryAt?: Date };
   /** A provider adapter: build argv, parse stdout, read limits. */
   type Provider = {
     run(stage, input, opts: StageModel & { promptFile: string; schemaFile: string; cwd: string; timeoutMs: number })
       : Promise<{ outcome: AgentResult<unknown>; log: Omit<CallLog,'durationMs'> }>;
     limits?(): Promise<{ windows: { name: string; usedPercent: number; resetsAt: Date }[] } | undefined>;
   };
   ```
   `createAgent({db, config}, providers)` would pick `providers[config.stages[stage].provider]`, time the call, and insert the `agent_calls` row. Each provider keeps its own pure parser and test seams (`command`, `timeoutMs`). A rate-limit `retryAt` should pause only that provider's jobs, but the single queue can stay as it is for v2.
6. **Validation:** validate `effort` against the model at config-load time. For Codex, read `codex debug models` or `models_cache.json`; see Open questions.

## Open questions
- Does `model_instructions_file` together with `--ignore-user-config` still inject `~/.codex/AGENTS.md`? Measure with two runs (with and without) and compare `input_tokens`. If it does, the options are a doomlearn-owned `CODEX_HOME` (but auth.json token refresh would then live in two places) or accepting the leak.
- Is `input_tokens` inclusive of `cached_input_tokens`? This is the OpenAI Responses convention, but I did not verify it here.
- What is the exact `codex app-server` stdio handshake (`initialize` params) needed before `account/rateLimits/read`, and is it stable enough (it is marked experimental) to call from Node per query?
- Do the features `apps`, `browser_use`, `computer_use`, `image_generation` and `multi_agent` add tools under `--ignore-user-config`? Inspect a non-ephemeral run's rollout tool list, or just `--disable` them all.
- What does a real usage-limit failure look like, and does exec emit `error` + `turn.failed`, or only one of them? I could not reproduce one without exhausting the quota. Write the regression test from the `error.rs` strings.
- Is `codex debug models` (or a similar command) a supported way to list the models and efforts available to the login, instead of reading `models_cache.json`?

## Verified on codex-cli 0.162.0 (2026-10-08)

Method: the 0.151.0 binary is still on disk (`~/.codex/packages/standalone/releases/0.151.0-aarch64-apple-darwin/bin/codex`), so the help text was diffed between the two binaries, not compared from memory. Saved outputs are in `$S/codex-help/` (`<ver>-{top,exec,appserver,debug,features}.txt`). `codex login status` → "Logged in using ChatGPT" (unchanged).

### Flag diff (`codex exec --help`, 0.151.0 → 0.162.0)

| Flag R3 relies on | 0.162.0 | Note |
|---|---|---|
| `--json` | unchanged | same JSONL event set (see run below) |
| `--ephemeral` | unchanged | |
| `--ignore-user-config` | unchanged | text still says "auth still uses `CODEX_HOME`" |
| `--ignore-rules` | unchanged | |
| `--skip-git-repo-check` | unchanged | |
| `-s read-only` | unchanged | values still `read-only|workspace-write|danger-full-access` |
| `-C, --cd` | unchanged | |
| `-m, --model` | unchanged | |
| `-c model_reasoning_effort=…` | works | accepted in the live run |
| `-c web_search="disabled"` | works | accepted; no web_search item |
| `-c features.shell_tool=false` | works | `shell_tool` still `stable true` by default |
| `--output-schema` | unchanged | |
| `-o, --output-last-message` | unchanged | |
| stdin prompt / `<stdin>` block | unchanged | help text identical; stderr still prints `Reading additional input from stdin...` |

Added in 0.162.0 (exec): `--worktree` (run in a new managed git worktree) and `--cyber-access-program <standard|daybreak_blue|daybreak_red>`. Neither matters for doomlearn; do not pass them.
Added at top level only (TUI): `--worktree`, `--no-daemon`. Removed at top level: the `mcp-server` subcommand.
`app-server --help`: one wording change only (WebSocket auth description). `debug --help`: identical (`models`, `app-server`, `prompt-input`).
**Not added:** no new output format, no budget/max-tokens/cost flag, no rate-limit or usage reporting flag on exec. Nothing R3 uses was renamed or removed.

`codex features list` changes that touch a headless call: `sleep_tool` is new and `stable true`, `daemon_auto_start` is new and `stable true`, `worktrees` is `stable true`, `personality` is now `removed`. The `exec` crate source has no daemon reference (`grep -i daemon $C/codex-rs/exec/src` is empty). The app-server daemon running on this machine was started by the owner's interactive TUI, not by the exec run.

### Models and efforts (`~/.codex/models_cache.json`, `client_version` 0.162.0, fetched 2026-10-08T20:50Z)

The cache holds no credentials (keys are model metadata plus `etag`, `fetched_at`, `client_version`, and an opaque 64-char `identity` string that was not printed). `codex debug models` returns the same 10 models with the same efforts, so it is a supported replacement for reading the cache file (answers R3's last open question).

| Model | Visibility | Priority | Default effort | Supported efforts | Notes |
|---|---|---|---|---|---|
| `gpt-6.1-sol` | list | 1 | low | low…ultra | "Latest workhorse"; has an availability notice |
| `gpt-6-astra` | list | 2 | low | low…ultra | "Frontier intelligence"; owner's TUI default |
| `gpt-6-sol` | list | 3 | medium | low…ultra | "Previous generation workhorse". **Owner's choice for tests and smoke runs, at `low`** |
| `gpt-6-luna` | list | 4 | medium | low…max | "Fast and affordable" |
| `gpt-reserve` | hide | 4 | medium | low…max | hidden |
| `gpt-5.6-sol` | list | 5 | low | low…ultra | "Older generation" |
| `gpt-5.6-terra` | list | 8 | medium | low…ultra | older |
| `gpt-5.6-luna` | list | 9 | medium | low…max | older; the model R3's first run used |
| `gpt-5.5` | hide | 13 | medium | low…xhigh | **retires 2026-10-14T19:00Z**, upgrade → `gpt-6.1-sol` |
| `codex-auto-review` | hide | 43 | medium | low…max | approval-review model, not for doomlearn |

"low…ultra" = `low,medium,high,xhigh,max,ultra`; "low…max" stops at `max`. No model lists `none` or `minimal`. All have a 272,000-token context window, `supported_in_api: true`, service tier `priority` and speed tier `fast`. `codex debug models --bundled` additionally lists `gpt-daybreak-blue-latest` and `gpt-daybreak-red-latest` (tied to `--cyber-access-program`), which the server catalog does not offer to this login.

### Live run on 0.162.0

Directory: `$S/codex-test-0162/` (`cmd.txt`, `schema.json` copied unchanged, `stdout.jsonl`, `stderr.txt`, `last.json`, `exit_code.txt`, `duration.txt`, empty `work/`). Same command as §8 except `-m gpt-6-sol`.

Result: exit 0, **3.76 s** wall time. stderr: `Reading additional input from stdin...`. `last.json` = `{"sum":5,"word":"ok"}`. `work/` stayed empty. stdout, complete:
```
{"type":"thread.started","thread_id":"01a11d49-a456-7682-a76e-cecf7082e657"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"sum\":5,\"word\":\"ok\"}"}}
{"type":"turn.completed","usage":{"input_tokens":12487,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}}
```
Event types: `thread.started`, `turn.started`, `item.completed` (`agent_message`), `turn.completed`. There is still **no `token_count` and no `rate_limits` event** on exec `--json`. The `usage` shape is the same five fields as 0.151.0. `input_tokens` grew from 10,749 (gpt-5.6-luna) to 12,487 (gpt-6-sol) for the same prompt. That is a different model, so the cause is not isolated (per-model instruction templates exist in the catalog under `model_messages.instructions_template`).

### Impact on the Agent port design
- Nothing in R3's provider command, parser or `Provider` type is invalidated. The argv, the JSONL event types and the `usage` fields are the same in both versions; `parseCodexOutput` can be written against either run.
- Rate-limit reset time still cannot come from exec. Recommendation 3 (`codex app-server` `account/rateLimits/read`, 15-min fallback) stands; app-server is still `[experimental]`.
- Use `codex debug models` (JSON on stdout) for effort validation at config-load time instead of reading `models_cache.json` directly. Validate against `supported_reasoning_levels[].effort`; `gpt-6-luna`/`gpt-6-sol` differ (`ultra` only on sol), so per-model checks are needed.
- Test and smoke config: `{ provider: 'codex', model: 'gpt-6-sol', effort: 'low' }`. Do not pin `gpt-5.5` anywhere; it retires 2026-10-14.
- Add `--disable sleep_tool` next to `features.shell_tool=false` (feature new and on by default in 0.162.0; not checked whether it reaches the model under `--ignore-user-config`); the other stable-on features listed in R3 §3 are still unverified under `--ignore-user-config`, so the cheap path of `--disable`-ing them stays the advice.
- Base prompt overhead rose to ~12.5k input tokens on gpt-6-sol. The `model_instructions_file` measurement in Open questions is more worth doing now, since it is a per-call fixed cost.
