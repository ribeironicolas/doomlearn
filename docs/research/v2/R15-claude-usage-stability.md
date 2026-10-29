# R15: Is `claude -p` a stable source for Claude subscription usage?

## Question

Can doomlearn v2 read the owner's Claude 5-hour and 7-day usage from its own `claude -p --output-format json` calls, and can it trust that enough to back a `worker.stopAtUsagePercent` key? This settles the clash between R8 F6 ("no evidence `claude -p` returns 5h/7d usage") and R4 §2 ("`unifiedWindows` on every call", from one haiku call).

Setup: Claude Code `2.1.295` (`~/.local/bin/claude --version`). Work dir `scratchpad/phase2/r15/`. Flag set copied from `src/claude.ts:73-76`, plus `--model haiku --effort low --max-budget-usd 0.05`, a one-line system prompt (`r15/prompt.md`) and schema `{"a": string}` (`r15/schema.json`). 5 live calls in total. No OAuth token, no Keychain, no `/api/oauth/usage`.

## Findings

### 1. The event fires on every call, not only on status change

Three `--output-format json` calls, about 12 s apart (epoch 1791492560, ...572, ...584). Each exited 0, and each printed `system/init, assistant, user, rate_limit_event, result/success` (`r15/call1.json` .. `call3.json`, parsed with `scratchpad/r15ev.py`).

The event body, with `uuid`/`session_id` removed, was **identical in all three** calls:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791501000,
 "rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
 "isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.09,"resetsAt":1791501000},
 "seven_day":{"utilization":0.31,"resetsAt":1791504000}}}}
```

- Status stayed `allowed` in all three, yet the event came every time. So in headless `-p` mode it is emitted **per call**, not only "when rate limit status changes" (the wording in the Python SDK docs, ctx7 `/websites/code_claude`, `r15/ctx-changelog.txt:5,11`). The TS SDK docs say "Emitted when the session encounters a rate limit" (https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent). The SDK `.d.ts` says "emitted when rate limit info changes" (`r15/sdk/x/package/sdk.d.ts:5665`). No doc promises per-call emission. Observed: 6 of 6 calls (R4 + 5 here).
- `unifiedWindows.five_hour` and `.seven_day` were present each time. The documented top-level `utilization` was **absent** each time.
- Utilization has 2 decimals (`0.09`, `0.31`), i.e. 1% steps. Tiny calls do not move it. R4's capture about 10 minutes earlier showed `0.07 / 0.3` (`r4/out.json`). Other Claude sessions on the same account move it too.
- The top-level `resetsAt` equals `unifiedWindows.five_hour.resetsAt`. It follows `rateLimitType` (the window closest to binding), and does not give the 7-day reset.

### 2. stream-json: the event comes just before `result`, after the model turn

One call with `--output-format stream-json --verbose` (`r15/call4-stream.jsonl`, lines time-stamped by `scratchpad/r15ts.py`):

```
0.92s system init
1.65s assistant
1.66s user
1.66s rate_limit_event
1.68s result success
```

The event is the line before `result`. It comes **after** the API response, because it is built from that response. So a "refresh usage" probe still has to make one real model turn. It cannot read usage first and skip the call. Cost of one probe: `total_cost_usd 3.782e-05` (list price, haiku, cached prompt), about 1.7 s. The body was the same as in §1.

### 3. Opus does not add model windows here

One call with `--model opus --effort low` (`r15/call5-opus.json`). It resolved to `claude-opus-5-5` (`modelUsage` key), cost `0.010328` list.

The event was **byte-identical** to the haiku ones: only `five_hour` and `seven_day` in `unifiedWindows`, with no `seven_day_opus`/`seven_day_sonnet` key at the top level or inside. The typed enum lists `seven_day_opus | seven_day_sonnet | seven_day_overage_included` as possible `rateLimitType` values (`sdk.d.ts:5682`). The changelog mentions a "weekly Fable limit" (2.1.283) and "model-specific weekly limit row" (2.1.261), so model windows exist for some plans or models. They did not show for Opus on this Max account. Model windows cannot be assumed present.

### 4. Typed contract: `unifiedWindows` is in neither the types nor the docs

- `npm view @anthropic-ai/claude-agent-sdk version` returns `0.3.295` (modified 2026-10-08). `npm pack` put it in `r15/sdk/`.
- `grep -rni unified r15/sdk/x/package` matches **nothing** in any `.d.ts` or `.mjs`.
- The typed `SDKRateLimitInfo` (`sdk.d.ts:5680-5700`) has `status, resetsAt?, rateLimitType?, utilization?, overageStatus?, overageResetsAt?, overageDisabledReason?, isUsingOverage?, overageInUse?, overageEnabled?, surpassedThreshold?, limitScope?, errorCode?, canUserPurchaseCredits?, hasChargeableSavedPaymentMethod?`. The camelCase names match the CLI output, so the CLI wire format is the TS type. Only `unifiedWindows` is extra.
- The Python SDK `RateLimitInfo` doc keeps unmodeled fields in `raw` (R4 §2).
- Changelog (`r15/CHANGELOG.md` from `anthropics/claude-code` main, and https://code.claude.com/docs/en/changelog saved as `r15/changelog.html`): zero hits for `unifiedWindows` or `unified_windows`. Relevant entries:
  - 2.1.45 "Added `SDKRateLimitInfo` and `SDKRateLimitEvent` types ... including utilization, reset times, and overage information"
  - 2.1.295 "Improved headless `rate_limit_event` usage-limit warnings to say whether the account has extra usage turned on"
  - 2.1.80 status line `rate_limits` (5h/7d `used_percentage`, `resets_at`)
- **Classification:**
  - `unifiedWindows`: **neither typed nor documented**, observed only. It can disappear in any release.
  - `status`, `resetsAt`, `rateLimitType`, `utilization`, `surpassedThreshold`: **typed**. `status`, `resetsAt` and `utilization` are also **documented** (TS docs page).
  - Typed `utilization` was absent in every `allowed` capture, so "typed" does not mean "present".

### 5. A typed, on-demand usage query exists, but it is EXPERIMENTAL

The same `.d.ts` has `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})` (`sdk.d.ts:3041-3059`). It sends control request `{subtype:'get_usage', skip_behaviors}` (`sdk.d.ts:4258-4266`) and returns `SDKControlGetUsageResponse` (`sdk.d.ts:4269+`), which includes:

- `subscription_type`
- `rate_limits_available`
- `rate_limits.{five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_oauth_apps}.{utilization 0-100, resets_at ISO}`
- `model_scoped[]`
- `extra_usage`

It is "the structured data behind `/usage`", served "from the claude.ai usage endpoint", and claude makes that request itself. So doomlearn would hold no credential. It needs no model turn.

It is marked "EXPERIMENTAL ... do not rely on it yet. The method name will change". It is absent from the TS docs page (0 hits for `usage_EXPERIMENTAL`/`get_usage` in `r15/sdk-ts.html`) and from the changelog. **Not tested live**: the 5-call budget was used up, and it needs the stream-json control protocol (`--input-format stream-json`), which doomlearn does not speak today.

### 6. `claude auth status` is machine-readable by default

- `claude auth status --help` lists `--json  Output as JSON (default)` and `--text`.
- CLI reference (https://code.claude.com/docs/en/cli-reference, saved as `r15/cli-ref.html`): "Exits with code 0 if logged in, 1 if not ... `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`". `configDirectory` needs v2.1.268+ (changelog 2.1.268).
- Live output, exit 0, identifiers redacted:

```json
{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
 "analyticsDisabled": false, "projectsDirectory": "<redacted>", "configDirectory": "<redacted>",
 "email": "<redacted>", "orgId": "<redacted>", "orgName": "<redacted>", "subscriptionType": "max"}
```

- A preflight can use the exit code (documented) and check `authMethod === 'claude.ai'`, since only a subscription has 5h/7d windows. It should not store `email`/`orgId`/`orgName`. The logged-out exit 1 was not reproduced: it would have meant logging the owner out.

### 7. R8 F6 vs R4 §2, resolved

They are both right about different things:
- R4 is right that `claude -p --output-format json` **does** return 5h and 7d utilization today: 6 of 6 calls, both windows, haiku and opus, json and stream-json.
- R8 F6 is right that this is **not documented**: `unifiedWindows` is not in the types, the docs or the changelog.
- The documented route (`utilization` + `rateLimitType`) exists but stayed empty while `allowed`. It gives one number for one window, not two.

The answer to R8 F6's condition is: **yes, there is a usage source**, but it is undocumented and has to be parsed defensively, with fallbacks.

## Recommendation for doomlearn v2

### R1. Parser contract for `usage_snapshots`

Parse every `rate_limit_event` in every `claude -p` output. Never fail a Clip because of it. Read `rate_limit_info` field by field and ignore unknown keys:

1. If `unifiedWindows` is an object: for each key `w` whose value has a numeric `utilization` in [0,1], write one row `{provider:'claude', window:w, utilization, resetsAt: value.resetsAt ?? null, status, source:'unified', callId, capturedAt}`. Keep unknown window names such as `seven_day_opus` too: the PWA shows any window it gets.
2. Else, if `utilization` is a number and `rateLimitType` is a string: write one row `{window: rateLimitType, utilization, resetsAt, status, source:'typed'}`.
3. Else: write one row `{window: rateLimitType ?? 'unknown', utilization: null, status, resetsAt, source:'status_only'}`. `status` is always typed and always present.
4. Missing event, bad JSON, or `utilization` > 1 (a 0-100 scale change): write nothing. Log a warning to `claude_calls` (e.g. `usageParse: 'missing' | 'invalid'`) so the drift shows up in the PWA instead of silently ageing.

`status = 'rejected'` keeps today's 429 rule (`src/claude.ts:49-53`). Store `surpassedThreshold` when present, because it is typed.

### R2. `worker.stopAtUsagePercent`: OK, but fail open, with the documented signal as a backstop

The key can exist. It defaults to off (`null`). When set, it holds a 5h and a 7d value (e.g. `{fiveHour: 90, sevenDay: 85}`). Before taking an agent job, the worker reads the newest snapshot per window:

- **Pause:** the newest row for a window has `utilization*100 ≥ threshold` and `capturedAt` within the window (`now < resetsAt`). The pause lasts until that row's `resetsAt`.
- **Always pause, even with the key off:** `status` is `allowed_warning` or `rejected` on the newest event. These are typed and documented, so they work even if `unifiedWindows` disappears.
- **Missing data:** no snapshot, a stale one (`now ≥ resetsAt`), or `source !== 'unified'` with no utilization. Then **do not pause** (fail open): run one job and re-read. The PWA shows "usage unknown: Claude CLI did not report windows" with the age. A missing field must never stall the queue overnight.
- Granularity: utilization moves in 1% steps and lags one call. Thresholds are approximate, so document "pauses within about 1 job of X%".

### R3. "Refresh usage" button in the PWA: an explicit, cheap probe

On click, the server runs the flag set with `--model haiku --effort low --max-budget-usd 0.01`, a fixed "reply ok" prompt and `--no-session-persistence`. It costs about $0.00004 list and 1.7 s (§2). It is logged in `claude_calls` as `stage:'usage_probe'`. Do not run it on a timer by default, because each probe uses a little quota. When the worker runs jobs, snapshots come for free.

### R4. Preflight / `doctor`

Run `claude auth status --json`. Exit code ≠ 0 means "run `claude auth login`". `authMethod !== 'claude.ai'` means a warning: "usage windows unavailable (API key)". Read only `loggedIn`, `authMethod`, `subscriptionType`, and never persist identity fields.

### R5. Do not build on `get_usage` yet

It is the cleanest source (no turn, typed, model windows), but it is labelled experimental and not documented. Record it in the usage ADR as the planned upgrade path for when it loses `EXPERIMENTAL`. That can be checked with a CI-free `npm view` + grep of `sdk.d.ts` for `usage_EXPERIMENTAL`. Keep the R4 ban on `/api/oauth/usage` and Keychain.

### R6. Test fixtures

Commit the redacted event bodies above as fixtures (`unified`, `typed-only`, `status-only`, `missing`, `rejected`) and unit-test the parser against each. The parser stays in `claude.ts` (`parseClaudeOutput` already finds events).

## Open questions

1. Is per-call emission guaranteed? It was observed 6/6 on 2.1.295, but the docs say "when ... changes". A CLI update could make it sparse. R2's fail-open rule covers that, with a staler display.
2. Which plans or models produce `seven_day_opus`/`model_scoped` windows? Opus on this Max account produced none. The parser keeps any key, so this only affects what the PWA can show.
3. Does `allowed_warning` carry `utilization`/`surpassedThreshold` at top level? This is unverified. It needs a capture near a limit (the CLI warns around 70%, changelog 2.1.6).
4. The `get_usage` control request through `claude -p --input-format stream-json` was not tested (call budget). Is it reachable from the CLI without the SDK, and does it return the same numbers as `unifiedWindows`?
5. Logged-out `claude auth status` exit 1 is documented but not reproduced here.
