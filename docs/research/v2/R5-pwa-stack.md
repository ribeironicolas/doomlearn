# R5 — PWA stack for doomlearn v2

Researched 2026-10-08. Versions come from `npm view <pkg> version` run that day, and weekly downloads from `api.npmjs.org/downloads/point/last-week/<pkg>`.

## Question

What exact frontend stack and versions should the v2 PWA use? It replaces today's vanilla `web/` (app.js 664 LOC, sw.js 49, manifest), keeps the offline mp4 buffer with HTTP Range, works with the Hono HTTPS server in dev and prod, and adds screens for usage/limits, the config editor and the worker schedule. Already decided: Vite, React 19 and TypeScript.

## Findings (with evidence)

### 1. Current versions (npm registry, 2026-10-08)

| Package | Latest | Notes |
|---|---|---|
| vite | 8.3.4 | 8.0.0 shipped 2026-03-12. Engines `^20.19 \|\| >=22.12`. Rolldown/oxc based: `build.rolldownOptions`, `minify: 'oxc'` (ctx7 `/vitejs/vite/v8.0.10`) |
| @vitejs/plugin-react | 6.1.2 | peer `vite ^8`. React Compiler goes through the optional `babel-plugin-react-compiler` / `@rolldown/plugin-babel` peer |
| react / react-dom | 19.3.0 | **published today (2026-10-08)**. The owner's reference monorepo pins 19.2.8 (its web app's `package.json`) |
| typescript | 7.0.2 | doomlearn already runs TS 7 native `tsc` (architecture-now §9). The reference monorepo's catalog uses `^5.9.3` |
| vite-plugin-pwa | 2.0.0 | **2.0.0 is 5 days old** (2026-10-03). Its only ⚠️ change is allowing `@vite-pwa/assets-generator ^2` (gh release v2.0.0). 1.3.0 (2026-05-05) added Vite 8 peer support. Peers: `workbox-build ^7.4.1`, `workbox-window ^7.4.1` |
| workbox-* (range-requests, routing, strategies, cacheable-response, precaching) | 7.4.1 | 2026-05-04 |
| tailwindcss / @tailwindcss/vite | 4.3.3 | same version as the reference monorepo |
| @tanstack/react-query | 5.104.1 | the reference monorepo has ^5.101.4 |
| react-router | 8.4.0 | v8.0.0 2026-06-17: Node ≥22.22, React ≥19.2.7, `react-router-dom` removed, ESM-only (CHANGELOG `## v8.0.0`) |
| @tanstack/react-router (+ router-plugin) | 1.170.41 | |
| zod | 4.6.5 | the reference monorepo's catalog `^4.4.3` |
| react-hook-form / @hookform/resolvers | 7.89.0 / 5.9.1 | the reference monorepo uses both |
| @tanstack/react-form | 1.33.5 | |
| vitest | 5.0.3 | 5.0.0 2026-09-03. Peer `vite ^6.4 \|\| ^7 \|\| ^8`, `@types/node ^22 \|\| >=24` |
| @testing-library/react / user-event / jest-dom | 16.3.3 / 14.6.7 / 7.0.1 | |
| jsdom / happy-dom | 30.1.2 / 20.14.5 | |
| @playwright/test | 1.64.0 | published today. The reference monorepo pins 1.62.1 |
| hono / @hono/node-server | 4.13.13 / 2.1.4 | both published today |

Weekly downloads: react-router 68.7M vs @tanstack/react-router 25.1M; react-hook-form 70.3M vs @tanstack/react-form 4.2M; vite-plugin-pwa 6.0M vs @serwist/vite 21K.

### 2. Service worker and cached mp4 with Range

- Chrome's Workbox guide (https://developer.chrome.com/docs/workbox/serving-cached-audio-and-video) sets these rules:
  1. Use `RangeRequestsPlugin` on the strategy. Without it Workbox ignores `Range`.
  2. "Caching the media asset as it's streamed at runtime won't work". Playback gets `206`, so `CacheableResponsePlugin({statuses:[200]})` caches nothing at runtime. The cache has to be filled ahead of time (`cache.add()`, precache or warmStrategyCache).
  3. Put `crossorigin="anonymous"` on `<video>`, even same-origin.
  4. Media can exceed the storage quota.
- Workbox demo (ctx7 `/googlechrome/workbox`, `demos/src/workbox-range-requests/sw.js`): `registerRoute(re, new CacheOnly({cacheName, plugins:[new RangeRequestsPlugin()]}))`. The plugin works with any strategy.
- Today's `web/sw.js` does all of this by hand already. The page fills the `clips` cache with full GETs (`keepBuffer`), and `clip()` slices the blob into a 206. This is the pattern Chrome recommends. v2 only needs the library version of it (`CacheFirst` + `RangeRequestsPlugin` on `/clips/`). The buffer logic stays page-managed.
- vite-plugin-pwa (ctx7 `/vite-pwa/docs`, `workbox/inject-manifest.md`): for a custom SW, use `strategies: 'injectManifest'` with `srcDir`/`filename`, written in TS against `self.__WB_MANIFEST`, plus `registerRoute`/`setDefaultHandler(new NetworkOnly())`. `generateSW` runtimeCaching alone cannot express "page fills the cache, SW serves ranges". To run the SW in dev, set `devOptions: { enabled: true, type: 'module' }`, which works only in Chromium (`guide/development.md`). That covers Android Chrome and desktop Chrome.
- The `/api/*` routes stay network-only, as today (`sw.js` comment, a v1 PWA decision). The last good GETs then come from TanStack Query's cache (see 4).

### 3. Vite dev server + Hono HTTPS, and prod serving

- Hono on Node (https://hono.dev/docs/getting-started/nodejs, ctx7 `/websites/hono_dev`): `serve({ fetch: app.fetch, createServer, serverOptions: { key, cert } })` accepts `node:https`/`node:http2` `createSecureServer`, so the mkcert cert from `~/doomlearn/tls` can be passed in directly. Two pitfalls:
  - `serveStatic({ root })` resolves `root` against `process.cwd()`. The docs say to anchor it with `import.meta.url`.
  - Node needs manual graceful shutdown (`server.close()` on SIGINT/SIGTERM).
- `@hono/node-server/serve-static` **supports Range natively**. `src/serve-static.ts` parses `Range`, sets `Accept-Ranges: bytes`, returns `206` with `Content-Range`, and answers an unsatisfiable range with `bytes */size` (`gh api repos/honojs/node-server/contents/src/serve-static.ts`, lines 40–227). It also has `precompressed`. This replaces the hand-written range code in `server.ts` for both `/clips/*` and the built PWA.
- Vite proxy (ctx7 `/vitejs/vite/v8.0.10`, `docs/config/server-options.md`): `server.proxy` takes per-prefix `{ target, changeOrigin, rewrite, configure }` and is built on `http-proxy`. Proxying to a self-signed or mkcert HTTPS target needs `secure: false`, an http-proxy option. The alternative is `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`, because Node does not trust the macOS keychain by default. Not verified locally.
- The SW needs a secure context, and the phone reaches the Mac over ZeroTier. Dev on the phone therefore needs Vite to serve HTTPS with the same mkcert cert (`server.https: { key, cert }`) on `host: <zerotierIp>`. Desktop-only dev works on `localhost`, which counts as a secure context.

### 4. Data layer: TanStack Query

- Offline (ctx7 `/tanstack/query`): `networkMode: 'offlineFirst'` stops queries from pausing. `persistQueryClient` + `setMutationDefaults` + `resumePausedMutations()` persist and replay paused mutations. `scope: { id }` runs mutations in the same scope one at a time, in order (`guides/mutations.md`).
- **Pitfall specific to doomlearn:** Query's online detection follows the browser's online state. When the phone is online but the Mac is unreachable on ZeroTier, the browser still reports online, and the fetch hangs. That is why today's app has a 5 s request timeout (architecture-now §5). v2 has to keep an explicit `AbortSignal.timeout(5000)` in the fetcher. Query's built-in offline handling does not cover this case.
- Two ways to handle the press outbox, both valid:
  - (a) Port today's localStorage queue (`clientEventId`, drop on 4xx/5xx, retry on network error; a v1 PWA decision) as one small TS module.
  - (b) Use Query mutations with `scope:{id:'press'}` + persister + `setMutationDefaults`.
  
  (a) keeps the behaviour approved for the v1 PWA, byte for byte. (b) adds `@tanstack/query-persist-client-core` and a persister.
- Typed API without a codegen step: Hono RPC (`hc<AppType>`, https://hono.dev/docs/guides/rpc) gives the PWA the server's route types through a shared workspace package. This fits the pnpm monorepo.

### 5. Routing

- React Router v8 declarative mode (`<BrowserRouter>`/`<Routes>`) has no codegen or Vite plugin. v8 is ESM-only, needs React ≥19.2.7, and drops `react-router-dom` (CHANGELOG v8.0.0). It has 2.7x the downloads, so more contributors already know it.
- TanStack Router: code-based routing (`createRootRoute`/`createRoute`, ctx7 `/tanstack/router`) or file-based routing through `@tanstack/router-plugin`, which generates `routeTree.gen.ts`. Its strength is typed `validateSearch`, and it pairs with Query loaders.
- doomlearn needs: `/` Feed, `/search?q=`, `/inbox`, `/sources`, `/usage`, `/settings` (config + schedule), plus overlays that are history layers today (Passage, 🚩 sheet, the full-screen player from search/inbox). Only one route has a search param. Typed search params save little here.

### 6. Forms for the config editor

- RHF + `@hookform/resolvers/zod` + zod 4 is the stack in the owner's reference monorepo (its web app's `package.json`), so the owner already knows it. It has 16x the downloads of TanStack Form.
- The config editor works best with **one zod schema in a shared package**. The Hono route validates with it, and the PWA form resolves with it. The CLI's `config.json` merge (`data.ts`) can parse with it too.

### 7. Styling: Tailwind v4

- Install with `@tailwindcss/vite`, `@import "tailwindcss"`, and tokens in CSS `@theme`. No PostCSS/autoprefixer/browserslist. `corePlugins`, `safelist` and `separator` are gone (ctx7 `/tailwindlabs/tailwindcss.com`, `upgrade-guide.mdx`).
- Browser targets are Safari 16.4+, Chrome 111+ and Firefox 128+. That is fine for Android Chrome and the Mac browser. Older WebViews are not a doomlearn concern.
- The Feed needs `100dvh`, scroll-snap, `object-fit: cover`, and safe-area insets. All of these are utilities or arbitrary values in v4.

### 8. Testing

- Component tests: Vitest 5 + `@testing-library/react` 16 + `user-event` 14 + `jest-dom` 7 + jsdom. The backend stays on `node:test`, which owns its own tests.
- Mobile e2e: Playwright device projects (`devices['Pixel 5']` and similar), `isMobile`/`hasTouch`, and `offline: true` or `context.setOffline()` (ctx7 `/microsoft/playwright`, `emulation.md`, `test-projects-js.md`). The owner's reference monorepo already runs Playwright with a `webServer` that boots the real API (its web app's `playwright.config.ts`).
- **Pitfall:** Playwright's bundled Chromium has no proprietary codecs. Remotion's docs say "Chromium Browser does not include proprietary codecs … cannot play MP4/H.264" (https://v3.remotion.dev/docs/media-playback-error). Clips are H.264 mp4, so:
  - Feed playback e2e needs `channel: 'chrome'` with real Chrome installed. On CI that means `npx playwright install chrome`.
  - Or the fixture clips can be WebM.
  
  Device emulation does not test the Android install flow, the mkcert CA on the phone, or ZeroTier. Those stay as a manual checklist, and the v1 PWA work notes they were never verified.

### 9. Learner-facing UX that the migration must keep (from the v1 Feed, PWA and screen decisions)

- Full-screen vertical scroll-snap, one Clip per screen, `object-fit: cover`.
- Right rail ✅ 🤔 ⏭️ 🚩, starting about 38% down so it stays above the caption band at about 75%. It overlapping the visual is accepted.
- Long-press hides the rail for that Clip only.
- Top-left tag `New | Review · <step>` · Concept · Source · Angle. Top-right 🔍 📚 📥, with a badge on 📥.
- Sound starts muted, and the first tap unmutes for the session.
- After any button, auto-advance in about 0.35 s.
- At Clip end: implicit ✅ once, then loop. After 3 loops, a nudge animation.
- 🚩 opens a sheet (Wrong content / Pronunciation / Wrong caption / Other + note). Every reason hides the Clip and sends it to the inbox.
- Sideways swipe pauses the Clip and shows the Passage with its location.
- Search shows result cards (Concept, ladder status, Source, Angle, caption highlight). Tapping one opens a full-screen player with only 🤔 🚩. It records nothing, and 🤔 un-retires.
- "Done for today" screen: counts, buffer state, tomorrow's Reviews, "no early Reviews, on purpose", inbox card.
- Inbox has three sections: flags (view / resolved), not landing (read Passage / retire), stuck jobs (retry).
- Sources: drop zone (PDF/txt/md/epub/azw3), refusal message naming the file and the reason, per-Source progress, per-chapter status, retry of a stuck chapter, pause/resume, no delete. Two columns in the Mac browser.
- Offline: the buffer of every upcoming Clip from `/api/next` (no hard-coded 10). Presses queue with `clientEventId`, are dropped on a 4xx/5xx, and retried on a network error. Flushing is ordered: every 30 s, on reconnect and on the next press.
- UI copy in English; i18n later.

## Recommendation for doomlearn v2

Workspace `apps/web` (mirroring the reference monorepo's `apps/*` + `packages/*`). Pin exact versions in a pnpm `catalog:`:

| Concern | Pick | Version to pin | Why |
|---|---|---|---|
| Build | vite + @vitejs/plugin-react | 8.3.x, 6.1.x | decided; current major |
| UI | react, react-dom, @types/react | **19.2.x** (not 19.3.0 yet) | 19.3.0 is hours old; the reference monorepo runs 19.2.8; bump after it settles |
| Lang | typescript | 7.0.x | the repo already uses TS 7 `tsc` |
| PWA | vite-plugin-pwa, `injectManifest`, `registerType: 'prompt'` + `useRegisterSW` | **1.3.0** (or 2.0.0 if the assets generator v2 is used) | 2.0.0 is 5 days old and only bumps a peer. 1.3.0 already supports Vite 8 |
| SW | workbox-routing / strategies / range-requests / cacheable-response / precaching | 7.4.1 | `/clips/*` → `CacheFirst({cacheName:'clips', plugins:[CacheableResponsePlugin({statuses:[200]}), RangeRequestsPlugin()]})`; page keeps filling `clips` via `cache.add`; `/api/*` → NetworkOnly; precache the shell via `__WB_MANIFEST` |
| Styling | tailwindcss + @tailwindcss/vite | 4.3.x | same as the reference monorepo; CSS-first tokens |
| Server state | @tanstack/react-query | 5.104.x | `networkMode:'offlineFirst'`, fetcher with `AbortSignal.timeout(5000)`, persist last-good GETs |
| Press outbox | keep today's localStorage queue, ported to TS (option a) | — | behaviour approved for the v1 PWA; smallest change. Revisit Query `scope`d mutations only if the queue grows |
| API types | Hono RPC `hc<AppType>` from the server package | hono 4.13.x | typed client, no codegen |
| Routing | **react-router 8, declarative mode** | 8.4.x | 6 flat routes, 1 search param; no plugin/codegen; most familiar to contributors |
| Forms | react-hook-form + @hookform/resolvers + zod 4 (schema shared with the server) | 7.89.x / 5.9.x / 4.6.x | owner's existing stack; one schema validates config in CLI, server and form |
| Unit/component | vitest + @testing-library/react + user-event + jest-dom + jsdom | 5.0.x / 16.3.x / 14.6.x / 7.0.x / 30.x | |
| e2e | @playwright/test, projects `Pixel 7`-style emulation with `channel:'chrome'` for playback specs | 1.6x (pin one that is ≥2 weeks old) | H.264 needs Chrome, not bundled Chromium |

Wiring:
- **Prod:** `vite build` → `apps/web/dist`. Hono serves it with `serveStatic({ root: <abs path from import.meta.url> })` plus an SPA fallback to `index.html`. Clips come from `serveStatic` on `~/doomlearn/clips`, which has native Range. One Node process, one port, one mkcert cert, as today.
- **Dev:** `pnpm dev` runs the server (`:8443` HTTPS) and Vite with `server.https` using the same mkcert files, `host` set to localhost and the ZeroTier IP, and `proxy: { '/api': {target:'https://127.0.0.1:8443', secure:false}, '/clips': {...same} }`. Set PWA `devOptions:{enabled:true,type:'module'}` only when testing the SW.
- Add `crossorigin="anonymous"` to `<video>` per the Chrome guide, or confirm on the phone that same-origin playback from cache works without it, as it apparently does today.

## Open questions

1. React Compiler (`babel-plugin-react-compiler`, used in the reference monorepo): adopt it now, or later? It adds a Babel pass through the `@rolldown/plugin-babel` peer and costs build speed. The Feed's render volume is low.
2. Component library: the owner's reference monorepo uses shadcn + `@base-ui/react`. Should doomlearn adopt shadcn for the settings, usage and inbox forms, or stay on plain Tailwind? The Feed is custom either way.
3. Should the config editor be generated from the zod schema (`z.toJSONSchema` → auto form), or hand-written per section? Hand-written is simpler for about 10 fields.
4. Live worker status (usage, schedule, current job) needs SSE or polling. That decision belongs to the server research. Query's `refetchInterval` covers polling with no new deps.
5. Was `crossorigin` ever needed on the current same-origin cache path? Verify on the Android phone before treating it as required.
6. Not verified: the Vite proxy accepting the mkcert target with `secure:false` vs `NODE_EXTRA_CA_CERTS`. Check in the scaffold ticket.
