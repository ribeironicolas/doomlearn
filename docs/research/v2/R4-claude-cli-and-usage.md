# R4: Claude CLI headless contract and subscription usage visibility

## Question

1. Does doomlearn's `claude -p` contract (`src/claude.ts`) still match Claude Code 2.1.295, and is there anything newer it should use?
2. How can the PWA show the owner's subscription usage (5-hour and weekly windows) without breaking the standing decision (subscription via `claude -p`, no `--bare`) or the rule that doomlearn never collects, stores or relays the Learner's credentials? What does Codex offer for the same?

Evidence sources: `claude --help` (2.1.295, `~/.local/bin/claude`), one live headless call captured at `scratchpad/phase2/r4/out.json`, context7 `/websites/code_claude` (fetches saved in `scratchpad/phase2/r4/ctx-*.txt`), and shallow clones (read-only) at `scratchpad/phase2/repos/{CodexBar,ccusage,codex}`.

## Findings

### 1. Headless contract, verified

Every flag doomlearn passes (`src/claude.ts:73-76`) is still in `claude --help` on 2.1.295:

| Flag | Status in 2.1.295 help |
|---|---|
| `--model <model>` | present; aliases `fable`, `opus`, `sonnet` or full name |
| `--effort <level>` | present; `low, medium, high, xhigh, max` |
| `--json-schema <schema>` | present ("JSON Schema for structured output validation") |
| `--output-format json` | present; `text`, `json` (single result), `stream-json` |
| `--tools ""` | present ("Use "" to disable all tools") |
| `--safe-mode` | present; disables CLAUDE.md, skills, plugins, hooks, MCP, etc. "Auth, model selection ... work normally" |
| `--strict-mcp-config` | present |
| `--no-session-persistence` | present ("only works with --print") |
| `--system-prompt-file` | not listed on its own line, but `--bare` help text names `--system-prompt[-file]`; the live run used it without error |

A live call (haiku, low effort, the exact doomlearn flag set plus `--max-budget-usd 0.05`, run from `scratchpad/phase2/r4`) exited 0 and printed a JSON array: `system/init`, `assistant`, `user`, `rate_limit_event`, `result`. Its `result` carried all fields doomlearn reads: `is_error:false`, `api_error_status:null`, `subtype:"success"`, `structured_output:{"a":"ok"}`, `total_cost_usd:0.0006956`, and `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` (`scratchpad/phase2/r4/out.json`).

Fields doomlearn ignores today but could log:
- `modelUsage.<model>.costBasis: "list"`. `total_cost_usd` is a list-price estimate, not a bill. On Max it is notional, so the PWA should label it "API-equivalent cost".
- `modelUsage.<model>` keys give the resolved model id (`claude-haiku-5-5`), which helps when the config holds an alias.
- `terminal_reason`, `num_turns`, `duration_api_ms`, `ttft_ms`, `usage.output_tokens_details.thinking_tokens`.

The result shape is documented in the Agent SDK `ResultMessage` (subtype, is_error, total_cost_usd, usage, structured_output, api_error_status, terminal_reason ...) at https://code.claude.com/docs/en/agent-sdk/python.

Result subtypes that matter (https://code.claude.com/docs/en/agent-sdk/agent-loop):
- `error_max_budget_usd`: hit `--max-budget-usd`.
- `error_max_structured_output_retries`: no valid structured output after the retries (https://code.claude.com/docs/en/agent-sdk/structured-outputs).

doomlearn's current rule ("failed = `is_error` or non-zero exit or no `structured_output`", `src/claude.ts:54`) already covers both. Logging `subtype` would make the reason visible.

### 2. Rate-limit event shape

The event is documented as SDK `RateLimitEvent{rate_limit_info, uuid, session_id}` (https://code.claude.com/docs/en/agent-sdk/python):
- `RateLimitInfo` fields: `status` (`allowed` | `allowed_warning` | `rejected`), `resets_at`, `rate_limit_type` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`), `utilization` (0.0 to 1.0), `overage_status`, `overage_resets_at`, `overage_disabled_reason`, plus `raw` for "fields not modeled above".
- The docs say it fires "when rate limit status changes". In practice it was emitted on a normal `allowed` call too.

In the CLI JSON the field names are camelCase. Captured live:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791501000,
 "rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
 "isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":1791501000},
 "seven_day":{"utilization":0.3,"resetsAt":1791504000}}}}
```

Notes:
- `resetsAt` (camelCase, epoch seconds) matches what `parseClaudeOutput` reads (`src/claude.ts:22,51`). The 429 handling is still valid.
- `unifiedWindows` gives the 5-hour and 7-day utilization on every call. Its key is not in the documented `RateLimitInfo` model and would surface only through `raw`, so treat it as **undocumented but observed** and parse it defensively.
- The documented top-level `utilization` field was absent in this `allowed` capture.
- Fable or Opus limits may appear as extra windows (`seven_day_opus`), per the `RateLimitType` enum.

### 3. New in 2.1.x that doomlearn could use

All from `claude --help` (2.1.295):
- `--max-budget-usd <amount>` ("only works with --print") is a per-call runaway cap. It works on list-price cost, so it also works on a subscription. A failed call returns subtype `error_max_budget_usd`.
- `--fallback-model <model(s)>` sets automatic fallback when the primary model is overloaded. It is optional, and it would hide which model produced a Clip unless `modelUsage` is logged.
- `--permission-prompts none` denies anything that would prompt. It is redundant with `--tools ""`.
- `--restricted` removes code-running tools and ignores user/project/local settings. It overlaps `--safe-mode` and is not needed while `--tools ""` holds.
- `--exclude-dynamic-system-prompt-sections` is "ignored with --system-prompt", so it is irrelevant here.
- `--bare` still "never reads OAuth and keychain", so the standing decision (no `--bare`) still holds.
- `claude auth status` exists (`claude auth --help`). It is a credential-free way to check that the user is logged in during setup or doctor checks. Its output format was not verified.
- There is **no** `claude usage` subcommand. The command list in `claude --help` has none.

### 4. Ways to get subscription usage

| # | Path | Documented? | Credential | Conflicts with the no-credentials rule? |
|---|---|---|---|---|
| A | `rate_limit_event` in doomlearn's own `claude -p` output (`unifiedWindows` 5h/7d utilization plus resetsAt, or the documented `rate_limit_type`/`utilization`) | Event documented; `unifiedWindows` undocumented | None. claude itself authenticates | **No.** doomlearn only reads its child's stdout |
| B | `/usage` slash command (aliases `/cost`, `/stats`) shows plan limits and a breakdown (https://code.claude.com/docs/en/commands, https://code.claude.com/docs/en/whats-new/2026-w16) | Documented, **interactive TUI only** | None | No, but it can only be scraped with a PTY, which is fragile. CodexBar does this as a fallback (`repos/CodexBar/docs/claude.md` §"CLI PTY") |
| C | **Status line** stdin JSON: `rate_limits.five_hour/seven_day.{used_percentage, resets_at}`, for Pro/Max, "only after the first API response" (https://code.claude.com/docs/en/statusline) | **Documented** | None. Claude Code pipes it to the user's own script | No. The user's own status-line script could write a snapshot file that doomlearn reads. It updates only while the user runs interactive Claude Code |
| D | `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`, token taken from Keychain `Claude Code-credentials` or `~/.claude/.credentials.json` (`repos/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift:61-92`, `docs/claude.md` §"OAuth API") | **Undocumented** private endpoint | The Learner's OAuth access token | **Yes.** It reads and uses the Learner's session token. Anthropic: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" (https://code.claude.com/docs/en/legal-and-compliance). CodexBar also documents Keychain ACL churn when Claude rotates the item |
| E | `claude.ai/api/organizations/{orgId}/usage` using browser cookies (`repos/CodexBar/docs/claude.md:272`) | Undocumented | Browser session cookies | **Yes**, worse than D |
| F | Local JSONL parsing like ccusage, which reads `~/.claude/projects` and `CLAUDE_CONFIG_DIR` (`repos/ccusage/docs/guide/environment-variables.md:11`, `cost-modes.md:7`) | Format undocumented | None | No, but it **misses doomlearn's own calls**: doomlearn passes `--no-session-persistence`, so no JSONL is written. It gives tokens and list cost only, never the plan's % or limits |
| G | Admin API `cost_report` / `usage_report` (`repos/CodexBar/docs/claude.md` §Admin API) | Documented | `sk-ant-admin` key | Not applicable. It covers API orgs, not Max subscriptions |

### 5. Codex

- `codex exec --json` events (`thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed`, `item.*`) carry **token usage only, no rate-limit info**. `grep -i rate repos/codex/codex-rs/exec/src/exec_events.rs` finds only an unrelated comment. `Usage` has `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` (`exec_events.rs:50-70`).
- `codex app-server` (JSON-RPC over stdio) has `account/rateLimits/read` and the notification `account/rateLimits/updated` (`repos/codex/codex-rs/app-server-protocol/src/protocol/common.rs:1328,2005`; ctx7 `/openai/codex`).
  - The response is `{ordinaryUsageAllowed, rateLimits: {primary, secondary: {usedPercent, windowDurationMins, resetsAt}, credits, planType, rateLimitReachedType}, rateLimitsByLimitId, ...}` (`app-server-protocol/src/protocol/v2/account.rs`).
  - Codex itself authenticates, so doomlearn handles no credential. This is the Codex equivalent of path A, and it is better because it can be polled without spending a turn.
  - CodexBar uses exactly this: `codex -s read-only -a never app-server`, then `account/rateLimits/read` (`repos/CodexBar/docs/codex.md:235-249`).
  - It is not marked experimental in the README grep, but it is a moving protocol: the repo HEAD on 2026-10-08 already has fields such as `rateLimitResetCredits`. Installed version: `codex-cli 0.151.0`.
- Local `~/.codex/sessions/**/*.jsonl` exist, but the most recent rollout checked had no `rate_limits` payload. Do not rely on them.

### 6. The PWA's usage view needs data on hand

- Path A only updates when doomlearn makes a call. If the queue is idle, the snapshot ages. The PWA should show `capturedAt` ("as of 14:02") instead of implying it is live.
- No credential-free documented path exists to poll Claude usage on demand: the TUI and the status line both need a user session. Codex can be polled through app-server.

## Recommendation for doomlearn v2

1. **Keep the flag set.** It is valid on 2.1.295. Add `--max-budget-usd` per stage as a configurable runaway guard (default around $2 notional per call, tuned by the post-build benchmark). Log `subtype`, `terminal_reason` and the resolved model from `modelUsage` into `claude_calls`, alongside `costBasis` so the UI labels cost as "API-equivalent".
2. **Usage = path A, provider-agnostic.** Add an append-only `usage_snapshots` table, for example `provider, window ('five_hour'|'seven_day'|...), utilization, resets_at, status, captured_at, call_id`.
   - Claude: write a row per window from each `rate_limit_event`. Read `unifiedWindows` when present, else fall back to the documented `rateLimitType` plus `utilization`. Unknown keys are ignored.
   - Codex: write rows from `account/rateLimits/read` (primary/secondary mapped to windows by `windowDurationMins`), called by the server once per job and on PWA demand, through a short-lived `codex app-server`.
   - The PWA shows the latest row per window with bars and "resets in", its age, and doomlearn's own spend from `claude_calls` (today, 5h, 7d).
3. **Optional, documented, off by default:** ship `scripts/statusline-usage.sh` (path C). The user adds it to their own Claude Code `statusLine`; it writes `rate_limits` to `$DOOMLEARN_HOME/usage/claude-statusline.json`, which doomlearn ingests as `source='statusline'`. This gives fresher numbers when the owner also codes with Claude, and doomlearn still never touches a credential.
4. **Do not implement paths D or E** (OAuth usage endpoint, cookies). They read the Learner's session token, contradict Anthropic's legal-and-compliance terms and doomlearn's standing rule, and rely on an undocumented beta header. Record this as an ADR so a contributor does not "helpfully" add it later. Path F (JSONL) does not see doomlearn's calls and should not be built.
5. Use the snapshots for scheduling as well as display (it ties into "control when agents run"):
   - pause the queue before `rejected` happens, when `status=allowed_warning` or utilization ≥ a configurable threshold (e.g. 0.9 on five_hour);
   - keep the existing `resetsAt` pause on 429.

## Open questions

- Is `unifiedWindows` stable enough to depend on, or should v2 rely only on the documented `rate_limit_type` and `utilization`? (Those were absent at the top level in the `allowed` capture.) A capture with Opus at medium/high effort and one near `allowed_warning` would settle what appears.
- Does the owner want doomlearn to pause at a utilization threshold (e.g. leave 10% of the weekly window for his own coding)? This is a product choice, not a technical one.
- `--max-budget-usd` default per stage: needs the benchmark cost distribution from `claude_calls`.
- Should Codex usage polling spawn `codex app-server` on demand (costs about 1 s of startup) or keep one long-lived? A long-lived process conflicts with the "one thing at a time, started manually" simplicity.
- Does `claude auth status` have a machine-readable output (e.g. `--json`) usable in a setup doctor? Not verified.
