# R6: server stack for doomlearn v2 (Hono on Node 24)

Paths below use `$P2` for (session scratchpad). The context7 outputs are saved under `$P2/docs/*.txt`. Reference repos were shallow-cloned read-only to `$P2/repos/{hono,node-server}`.

## Question

The owner already chose Hono. This note settles the exact design on Node 24 for a self-hosted, single-user Mac app:
- HTTPS with the mkcert cert, bound only to 127.0.0.1 and the ZeroTier IP
- request validation
- end-to-end types shared with the React PWA
- static Vite build plus mp4 byte ranges
- live worker status
- graceful shutdown
- logging
- the v2 route set
- whether the worker shares a process with the server

## Findings (with evidence)

### F1. Current server (what we replace)
- One raw `node:https` listener routes with an if-chain over `"${method} ${pathname}"` (`src/server.ts:71-127`).
- Body parsing is a hand-written `JSON.parse` over the whole stream, with no size limit and no validation (`src/server.ts:35-39`).
- Range serving is hand-written (`src/server.ts:53-65`).
- `serve()` creates one `https.createServer` per host for `['127.0.0.1', zerotierIp]` and hard-wires `localMedia` (`src/server.ts:136-147`).
- 12 routes: GET `next`, `today`, `search`, `inbox`, `sources`; POST `resolve`, `sources?name=` (raw body, 422 on `Refused`), `pause`, `resume`, `retry`, `press`, `seen`.
- `/clips/<basename>` and `web/<basename>` fallbacks.
- No route exists for stats, config, worker status, reconvert or health (`architecture-now.md` §4).
- Tests drive `feedApp(data, modules)` on plain `node:http` (`architecture-now.md` §2).

### F2. Versions (npm registry, 2026-10-08, `npm view`)
| Package | Latest | Note |
|---|---|---|
| hono | 4.13.13 | |
| @hono/node-server | 2.1.4 | engines `node >=20` (`$P2/repos/node-server/package.json`) |
| @hono/zod-validator | 0.9.1 | peers `zod ^3.25 \|\| ^4`, `hono >=4.11.2` |
| @hono/zod-openapi | 1.6.3 | |
| zod | 4.6.5 | the owner's reference monorepo's catalog pins `zod: ^4.4.3` (its `pnpm-workspace.yaml`) |
| fastify | 5.12.5 | |
| pino | 10.4.0 | |
| hono-pino | 0.10.3 | last published 2025-10-05, a year stale |

Local Node is `v24.18.1` (`node -v`).

### F3. HTTPS on specific hosts with @hono/node-server
- `serve(options)` accepts `createServer` and `serverOptions`, typed for `node:https` (`HttpsServerOptions`), and also for http2 and secure http2 (`$P2/repos/node-server/src/types.ts:46-62`).
- It calls `createServer(options.serverOptions || {}, requestListener)` (`$P2/repos/node-server/src/server.ts:16-17`). It then calls `server.listen(port, options.hostname)` (`:31`), so each call binds one hostname.
- The package also exports `getRequestListener` and `createAdaptorServer` (`$P2/repos/node-server/src/index.ts:1-3`).
- So today's model of one server per host carries over unchanged: call `serve({ fetch: app.fetch, createServer: https.createServer, serverOptions: { key, cert }, hostname, port })` twice, for 127.0.0.1 and for zerotierIp.
- Hono docs: "On Node.js, `serve()` wraps the `node:http` module and returns the underlying server instance, so closing it is up to you." The docs show the SIGINT/SIGTERM handlers calling `server.close()` (https://hono.dev/docs/getting-started/nodejs, `$P2/docs/node.txt`).

### F4. Static files: Vite build plus mp4 ranges, built in
- `serveStatic` from `@hono/node-server/serve-static` parses `Range` itself, answers `206` with `Content-Range`, sets `Accept-Ranges: bytes`, and answers unsatisfiable ranges with `bytes */size` (`$P2/repos/node-server/src/serve-static.ts:40-70, 195-227`). The hand-written `file()` in `src/server.ts:53-65` can be deleted.
- Path traversal is rejected: `..`, `//` and `\` all fail (`serve-static.ts:131-135`). The function has the options `root`, `path`, `rewriteRequestPath`, `onNotFound` and `precompressed` (`:13-20`).
- Hono's docs warn that `root` resolves against `process.cwd()` and recommend resolving from `import.meta.url` (https://hono.dev/docs/getting-started/nodejs, `$P2/docs/static.txt`). We should pass absolute roots: `home/clips` and `<web package>/dist`.
- For the SPA fallback, register `app.get('*', serveStatic({ path: <dist>/index.html }))` after the API routes. "Place fallback wildcard handlers below other route definitions" (https://hono.dev/docs/api/routing).

### F5. Validation: @hono/zod-validator, not zod-openapi
- `zValidator('json' | 'query' | 'param' | 'form', schema)` plus `c.req.valid(...)` feeds the RPC input types (https://hono.dev/docs/guides/validation, https://hono.dev/docs/concepts/stacks, `$P2/docs/rpc.txt`).
- `@hono/zod-openapi` adds `createRoute` and OpenAPI generation. doomlearn has exactly one client, its own PWA, which already gets types through `hc`, so an OpenAPI document has no consumer yet. Its Context7 entry lists Hono OpenAPI as a separate library (`/rhinobase/hono-openapi`), so it can be added later without rewriting the validators.
- Gotcha: when the Content-Type is not JSON, the json validator skips parsing and leaves `{}` (`$P2/repos/hono/src/validator/validator.ts:94-97`). A required-field zod schema then rejects with 400. Body-less POSTs (e.g. `/sources/:id/pause`) need the `csrf()` middleware (F9).

### F6. End-to-end types: Hono RPC (`hc`)
- Export `type AppType = typeof routes`, where routes are built with chained `.get().post()` calls and mounted with `.route()`. The client is `hc<AppType>('/api')` (https://hono.dev/docs/guides/rpc, https://hono.dev/docs/guides/best-practices).
- The docs say that for RPC types in a monorepo, both tsconfigs need `"strict": true`. doomlearn's tsconfig is already strict (`architecture-now.md` §9).
- Known cost: IDE slowdown as routes grow. The documented fix is `hcWithType`, which pre-computes the client type with `tsc`, "If your project is a monorepo, this solution does fit well" (https://hono.dev/docs/guides/rpc, `$P2/docs/rpcmono.txt`). About 20 routes is small, so we start without it.
- Pitfall: returning a `.then()` chain loses response types (same page).
- `parseResponse()` from `hono/client` throws on a non-OK response, typed by Content-Type. `testClient(app)` from `hono/testing` gives typed calls in tests with no socket (https://hono.dev/docs/helpers/testing, `$P2/docs/sse.txt`). That replaces today's `node:http` test harness.
- The PWA imports `import type { AppType } from '@doomlearn/server'`. That is type-only, so nothing server-side gets bundled.

### F7. Live status: SSE vs polling
- `streamSSE(c, cb)` from `hono/streaming` provides `writeSSE({data, event, id})`, `sleep`, `aborted` and `onAbort` (https://hono.dev/docs/helpers/streaming). The timeout middleware cannot wrap streams (https://hono.dev/docs/middleware/builtin/timeout).
- `hc` has no typed SSE consumer. The PWA would use a raw `EventSource` plus a shared payload type.
- Under either transport, the source of truth is SQLite. `jobs` holds status, stage and lastError. `claude_calls.retry_at` is the rate-limit pause, read on every tick (`src/pipeline.ts:343-346`). The server can only learn worker state by reading the DB, so an SSE endpoint would poll the DB internally anyway.
- Single user, one phone, a status screen open now and then: a typed `GET /api/status` polled every 2-5 s while that screen is visible gives the same freshness with no stream, reconnect or proxy-buffering concerns.

### F8. Logging
- Hono's built-in `logger(printFn?)` writes one text line per request with method, path, status and elapsed time. It accepts a custom print function (https://hono.dev/docs/middleware/builtin/logger, `$P2/docs/mw.txt`).
- The rest of the code base uses `console.*`. `server.log` comes from a shell redirect (`architecture-now.md` §12.12).
- `hono-pino` has not been published since 2025-10-05 (F2). If structured JSON logs are wanted, plain `pino` (one dependency) used directly in server and worker, with Hono's `logger(msg => log.info(msg))`, avoids that stale adapter.

### F9. Hardening that is nearly free in Hono
- `bodyLimit({ maxSize, onError })` checks Content-Length or counts streamed bytes (https://hono.dev/docs/middleware/builtin/body-limit). This fixes the unbounded JSON body. Use a large limit only on the upload route.
- `csrf()` returns 403 on a non-safe method when the content type looks like a form, text/plain or missing, unless `Sec-Fetch-Site` or `Origin` is same-origin (`$P2/repos/hono/src/middleware/csrf/index.ts:138-147`). This matters because v2 adds config writes. Any web page open in a browser on the Mac can fire a "simple" POST at `https://127.0.0.1:8443`, and ZeroTier membership is the only auth (a standing decision).
- Upload: keep the raw-body streaming design (`src/server.ts:86-98`) by piping `Readable.fromWeb(c.req.raw.body)` to a temp file. Do not use `c.req.parseBody()`, which buffers the multipart file in memory.

### F10. Fastify (only to confirm the choice)
- Fastify types the server through type providers (`@fastify/type-provider-zod`, `withTypeProvider<ZodTypeProvider>()`). It has an `https` server option (https://github.com/fastify/fastify/blob/main/docs/Reference/Type-Providers.md and TypeScript.md, `$P2/docs/fastify.txt`).
- It has no built-in typed client equivalent to `hc`. Client types would need OpenAPI plus codegen. It would also bring its plugin/encapsulation model.
- For about 20 routes and one client, Hono's `hc` with chained routes gives shared types and no codegen step. Hono stays.

### F11. Worker: same process or separate
Evidence:
- Today `src/main.ts` runs `serve()` and `while(true) await pipeline.tick()` in one process.
- The worker does synchronous work that blocks the event loop the HTTP server shares:
  - `execFileSync('ffmpeg', …)` for the final mix (`src/render.ts:73`)
  - in-process procedural audio synthesis (`renderSoundtrack`, `src/render.ts:72`)
  - an in-process webpack bundle via `@remotion/bundler` `bundle()` (`src/render.ts:5`)
- While those run, `/api/*` and clip range requests stall. The PWA already has a 5 s request timeout (`architecture-now.md` §5), so a long mix or bundle shows up as "offline".
- The CLI is already a separate process writing the same SQLite file under WAL (`architecture-now.md` §0). The DB is already the bus, and it carries the pause across restarts (`src/pipeline.ts:344`).
- The owner's reference repo runs the API and the worker as two entrypoints of the same package and two processes:
  - The reference monorepo's API app scripts include `"dev:worker": "… nest start --watch --entryFile worker/main"` and `"start:worker:prod": "node dist/src/worker/main"` (its API app's `package.json:18-19`)
  - the root `dev` script runs them side by side with `concurrently` (the reference monorepo's root `package.json`)
  - its API is NestJS, so only the process shape carries over, not the framework.
- pm2: by default it waits 1600 ms before SIGKILL, configurable via `kill_timeout`, and it forwards SIGINT for graceful stop (https://pm2.keymetrics.io/docs/usage/signals-clean-restart, `$P2/docs/pm2.txt`). An ecosystem file lists several `apps`, so two processes is natural there. A standing decision says pm2 may wrap the app and launchd is not wanted.
- Shutdown safety already exists. Each stage checkpoints to a file with `.tmp`+rename, and a crashed `running` job resumes first (`architecture-now.md` §3.6-3.7). A killed worker loses at most the in-flight stage. That can mean a `claude -p` call of up to 10 min, which spends usage.

| | Same process (today) | Two processes, same package (recommended) |
|---|---|---|
| Start | one `node` | `pnpm start` runs both via `concurrently` (one command, the standing decision still holds) |
| HTTP latency during render | stalls (F11) | unaffected |
| Server → worker (pause, schedule, config) | function call | DB row / config file re-read each tick |
| Worker → server (status) | memory | DB (already true for queue and rate limit) |
| Crash isolation | a render crash takes down the Feed | Feed keeps serving cached Clips |
| pm2 | 1 app | 2 apps, separate restarts and logs |
| Extra code | 0 | about 20 lines: worker entrypoint, a `paused`/schedule read per tick, a heartbeat column |

A separate package for the worker is not justified. It shares every domain module with the server and CLI. Only the entrypoint differs, as in the owner's reference monorepo.

## Recommendation for doomlearn v2

**Stack.**
- Runtime dependencies: `hono@4.13`, `@hono/node-server@2.1`, `@hono/zod-validator@0.9`, `zod@4` (catalog, matching the owner's reference monorepo).
- No zod-openapi, no Fastify, no hono-pino.
- Logging: the built-in `logger()` printing through one tiny shared log function (JSON lines to stdout). pm2 or the terminal captures stdout. Add `pino` only if a concrete need appears.

**Shape (server package, illustrative):**
```ts
// app.ts: pure, injectable; tests use testClient(app) / app.request()
export function createApp(data: Data, m: Modules) {
  const api = new Hono()
    .use(csrf(), bodyLimit({ maxSize: 64 * 1024 }))
    .route('/feed', feedRoutes(m)).route('/sources', sourceRoutes(m)) /* … */;
  const app = new Hono().use(logger(log)).route('/api', api)
    .use('/clips/*', serveStatic({ root: data.home }))   // /clips/x -> home/clips/x, ranges built in
    .use('*', serveStatic({ root: WEB_DIST }))
    .get('*', serveStatic({ path: join(WEB_DIST, 'index.html') }));
  return { app, api };
}
export type AppType = ReturnType<typeof createApp>['api'];
// server.ts: TLS + hosts + shutdown only
const servers = hosts.map((hostname) => serve({ fetch: app.fetch, port, hostname,
  createServer: https.createServer, serverOptions: { key, cert } }));
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => servers.forEach((s) => s.close()));
```
`createApp` takes `Modules`, which fixes "`serve()` not injectable" (`architecture-now.md` §2). TLS refusal messages carry over unchanged from `src/server.ts:136-144`.

**v2 route set** (all under `/api`, JSON, zod-validated; `→` marks today's route):

| Route | Purpose | Module |
|---|---|---|
| `GET /feed` | next Clips with `url` (→ `GET /next`) | feed.next |
| `GET /feed/today` | done-for-today summary (→ `GET /today`) | feed.today |
| `POST /events` | one endpoint for the offline queue: discriminated union `{kind:'seen', clipId, clientEventId, completed}` or `{kind: Button, clipId, clientEventId, reason?, note?}` (→ `press` + `seen`; matches the append-only `events` table, where `Button` is the event kind minus `seen`, `src/feed.ts:12`) | feed.press / feed.seen |
| `GET /search?q=` | FTS5 search | feed.search |
| `GET /inbox` | flags, not-landing, stuck | inbox.list |
| `POST /inbox/:eventId/resolve` | (→ `POST /resolve`) | inbox.resolve |
| `GET /sources` | status and progress | sources.status |
| `POST /sources?name=` | raw-body upload, `bodyLimit` about 500 MB, 201 / 409 duplicate / 422 `Refused` | sources.add |
| `POST /sources/:id/pause`, `/resume` | (→ body `{sourceId}`) | sources.pause/resume |
| `POST /sources/:id/reconvert` | new; parity with the CLI | sources.reconvert |
| `POST /jobs/:id/retry` | (→ `POST /retry`) | sources.retry |
| `GET /status` | worker: `running \| paused \| outside-schedule \| rate-limited(until)`, current job and stage, last heartbeat, queue counts by status, buffer and daily-cap progress | new read model over `jobs` and `claude_calls` |
| `PUT /worker` | `{ paused: boolean }` (runtime state, stored in DB) | new |
| `GET /stats/usage?by=stage\|day\|source\|clip&since=` | `claude_calls` aggregates; the provider-limits payload comes from the limits research | stats.usage |
| `GET /config` / `PATCH /config` | validated config (buffer, cap, per-stage provider/model/effort, worker schedule). Written atomically (tmp+rename) to `config.json`. The worker re-reads it when its mtime changes | new |
| `GET /health` | `{ ok, version }` for pm2, doctor and CI smoke | new |
| `GET /clips/*`, `GET *` | serveStatic with ranges and SPA fallback (outside `/api`) | |

That is about 20 handlers, and each still calls one module, as `src/server.ts:68` requires today. The config schema must not expose binary paths or command strings (`command`, `PATH`): over ZeroTier, a config write must not become remote code execution.

**Live status.** Poll `GET /api/status` (typed via `hc`) every 3 s while the Status/Sources screen is visible. Add `GET /api/status/stream` with `streamSSE` only if polling proves insufficient. Its body would be the same DB read on a timer (F7).

**Worker.** Run it as a separate process from the same package, with entrypoints `server.ts` and `worker.ts`, mirroring the owner's reference monorepo.
- `pnpm start` runs both via `concurrently`. An optional `ecosystem.config.cjs` declares two pm2 apps.
- Worker loop:
  - At each tick, read `paused`, the schedule and the config.
  - Write a heartbeat and the current job/stage to the DB.
- Signal handling:
  - On SIGINT/SIGTERM, stop taking new stages and exit when the current stage ends.
  - A second signal aborts in-flight children via `AbortSignal` passed to `execFile`; checkpoints make this safe.
  - Set pm2 `kill_timeout` high enough (e.g. 15 min) for a graceful stop to be useful, or accept losing the in-flight stage.
- The server closes both listeners and exits; it holds no job state.
- The synchronous `execFileSync` in `render.ts:73` no longer affects HTTP once the worker is separated. Note it, but leave it alone.

## Open questions

1. Should `PATCH /config` changes apply live (worker re-reads per tick; the server re-reads per request), or only after a restart? Bind host, port and TLS need a restart in any case.
2. Where does runtime `paused` live: a one-row `worker` table (proposed, next to the heartbeat) or `config.json`? It is state, not config, so the proposal is the DB.
3. Should we merge `press`+`seen` into `POST /events`? It changes the PWA offline queue format, and pending queued items from v1 would need a one-time migration in the client.
4. Is 3 s polling acceptable to the owner for "watch agents running", or is a streamed log (stage-by-stage agent output) wanted? A streamed log would justify SSE.
5. Is the upload limit 500 MB? Calibre/PDF sizes on the owner's library are not measured.
6. Do we keep `127.0.0.1` + ZeroTier binding as the only mode, or add a configurable `hosts: string[]` with ZeroTier as the documented default? (Overlaps with the networking/config research.)
7. Is `hc` request typing for a raw `Blob` body (`init: { body }`, `$P2/repos/hono/src/client/types.ts:39-41`) good enough for the upload, or should the PWA call `fetch` directly for that one route? This was not verified by compiling.
