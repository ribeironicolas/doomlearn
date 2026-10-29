# R11: workspace scaffold spike

Spike dir: `$P2/r11/` (`$P2` = (session scratchpad)).
Workspace: `$P2/r11/ws`. Version data: `$P2/r11/versions.json`, script `$P2/r11-pick.mjs`, peer check `$P2/r11/peercheck.cjs`.
pnpm ran as `npx -y pnpm@11.28.3` with an npm cache inside the spike dir (`$P2/r11/bin/pnpm`). Nothing was installed globally. pnpm did use the user's default content store (`~/Library/pnpm/store/v11`, from the install log).
Run date: 2026-10-08 ~20:50 UTC, so the 7-day cutoff is 2026-10-01 ~20:50 UTC.

## Question

Does the proposed no-build pnpm monorepo work end to end? It exports TS source from workspace packages and pairs a Hono server with `hc<AppType>` in a Vite 8 PWA, plus TS 7, Vitest 5 projects and Biome nested configs. Which exact versions pass `minimumReleaseAge: 10080` and agree on peers? Which of the conflicting pins in R5 and R7 is right?

## Findings

### F1. Version set (7-day-old rule, peers checked together)

Method: `npm view <pkg> time --json` plus `dist-tags`. For each package I took the newest stable semver published before the cutoff, read `npm view <pkg>@<v> peerDependencies`, and checked every peer that is in this set with `semver.satisfies` (`peercheck.cjs`). A real `pnpm install --lockfile-only` of the whole set under `minimumReleaseAge: 10080` passed with no peer warnings (`$P2/r11/age2`, one unrelated deprecation warning for `glob@11.1.0`).

| pkg | pin | published | peers satisfied |
|---|---|---|---|
| pnpm (packageManager) | 11.28.3 | 2026-09-30 | n/a |
| @biomejs/biome | 2.5.15 | 2026-09-30 | n/a |
| typescript | 7.0.2 | 2026-07-08 | n/a |
| @types/node | ^24.19.0 (resolves 24.19.0) | 2026-09-25 | n/a |
| vite | 8.3.2 | 2026-10-01 10:17Z | y (@types/node) |
| @vitejs/plugin-react | 6.1.1 | 2026-08-28 | y (vite ^8) |
| vitest | 5.0.3 | 2026-09-30 | y (vite, jsdom, @types/node) |
| jsdom | 30.1.1 | 2026-09-22 | n/a |
| @testing-library/react | 16.3.3 | 2026-08-27 | y (react 19, types) |
| @testing-library/user-event | 14.6.7 | 2026-09-02 | y |
| @testing-library/jest-dom | 7.0.1 | 2026-08-09 | y (vitest >=0.32) |
| react / react-dom / @types/react / @types/react-dom | 19.3.0 | 2026-09-09 | y |
| hono | 4.13.12 | 2026-09-30 | n/a |
| @hono/node-server | 2.1.3 | 2026-09-29 | y (hono ^4) |
| @hono/zod-validator | 0.9.1 | 2026-08-31 | y (zod ^4, hono >=4.11.2) |
| zod | 4.6.5 | 2026-09-13 | n/a |
| vite-plugin-pwa | 1.3.0 | 2026-05-05 | y (vite ^8, workbox-* ^7.4.1) |
| workbox-build/-window/-routing/-strategies/-range-requests/-cacheable-response/-precaching | 7.4.1 | 2026-05-04 | n/a |
| @tanstack/react-query | 5.104.0 | 2026-09-26 | y (react ^19) |
| react-router | 8.4.0 | 2026-09-15 | y (react >=19.2.7) |
| react-hook-form | 7.89.0 | 2026-09-26 | y |
| @hookform/resolvers | 5.9.1 | 2026-08-17 | y (zod ^4, rhf ^7.55) |
| tailwindcss / @tailwindcss/vite | 4.3.3 | 2026-07-16 | y (vite ^8) |
| lefthook | 2.1.16 | 2026-10-01 17:34Z | n/a |
| @commitlint/cli / config-conventional | 21.2.3 | 2026-09-19 | n/a |
| drizzle-orm / drizzle-kit | 1.0.0-rc.4 (exact) | 2026-06-27 | n/a for sqlite |
| remotion + @remotion/* | 4.0.532 (or keep 4.0.534 with an exclude, see F1.5) | 2026-10-01 07:13Z | y (react >=16.8) |

Too young today, so not pinned: vite 8.3.4 (10-08), @vitejs/plugin-react 6.1.2 (10-05), hono 4.13.13 (10-04), @hono/node-server 2.1.4 (10-08), jsdom 30.1.2 (10-04), @tanstack/react-query 5.104.1 (10-02), vite-plugin-pwa 2.0.0 (10-03), lefthook 2.2.1 (10-08), @types/node 24.19.1 (10-01 22:38Z), remotion 4.0.533/534 (10-05/10-07), pnpm 11.28.4/11.28.5.

Conflicts resolved:
1. **react 19.2.x vs 19.3.0: 19.3.0.** R5 said 19.3.0 was "published today". The registry says `"19.3.0": "2026-09-09T17:21:30.071Z"` (`npm view react time --json`), so it is a month old and passes the 7-day rule. react-router 8.4 needs `>=19.2.7`, which it meets. The current repo already pins 19.3.0 (`doomlearn/package.json`).
2. **biome 2.5.6 vs 2.5.14: neither, use 2.5.15.** 2.5.6 is the owner's reference monorepo's pin (2026-07-28). 2.5.15 came out 2026-09-30 and is already more than 7 days old.
3. **vite-plugin-pwa 1.3.0 vs 2.0.0: 1.3.0.** 2.0.0 was published `2026-10-03T14:13Z` and fails the rule until 10-10. Its only peer change is `@vite-pwa/assets-generator ^1 || ^2` (`npm view vite-plugin-pwa@2.0.0 peerDependencies`), so there is nothing to gain yet. Let Dependabot bump it later.
4. **drizzle: stay on 1.0.0-rc.4, pinned exactly.** `latest` is 0.45.4 and `rc` is 1.0.0-rc.4 (`npm view drizzle-orm dist-tags`). The current code imports `drizzle-orm/node-sqlite` and `drizzle-orm/node-sqlite/migrator` (`grep` over `src/`). 0.45.3 does not export `node-sqlite` (`npm view drizzle-orm@0.45.3 exports` has no match), so stable 0.45 cannot run today's code. **Bug in the current range:** `^1.0.0-rc.4` matches branch builds. `npx semver -r '^1.0.0-rc.4' 1.0.0-rc.4 1.0.0-rc.5-5935859` prints both. A real `pnpm install` with `"drizzle-orm": "^1.0.0-rc.4"` resolved **`drizzle-orm@1.0.0-rc.5-ab785fc`**, an untagged branch build (`$P2/r11/age/pnpm-lock.yaml`). The existing package-lock happens to hold rc.4. Pin `1.0.0-rc.4` exactly.
5. **remotion 4.0.534 fails the rule** (published 2026-10-07). With 4.0.534, `pnpm install` fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` listing every `@remotion/*` package (`$P2/r11/age2`). There are two fixes and both were tested. (a) Pin 4.0.532, which resolves cleanly. (b) Keep 4.0.534 and add `minimumReleaseAgeExclude: [remotion, "@remotion/*"]`, which resolved 56 entries at 4.0.534. A versioned pattern such as `"@remotion/*@4.0.534"` is rejected with `ERR_PNPM_INVALID_MINIMUM_RELEASE_AGE_EXCLUDE: Name patterns are not allowed with version unions` (pnpm docs: https://github.com/pnpm/pnpm.io/blob/main/blog/releases/10.19.md, 10.17.md via ctx7).
6. **Exact pins vs ranges under the age rule.** An exact pin or a range floor that is too young fails the install (`@types/node ^24.19.1` gave `NO_MATURE_MATCHING_VERSION`). A range whose floor is mature resolves to the newest mature version (`^24.19.0` → 24.19.0). Transitive deps are checked too: an exact `vite 8.3.4` also pulled in a too-young `postcss@8.5.29`. So R7's catalog as written (`@types/node ^24.19.1`, `remotion 4.0.534`) would not install today.

### F2. Skeleton: install, TS 7 typecheck, vite build, server start

Layout: `packages/core` (`exports: {".": "./src/index.ts"}`, a zod `configSchema`, an internal `./math.ts` import). `apps/server` (`exports: {".": "./src/app.ts"}`) has a chained Hono `api` with `GET /health`, `PATCH /config` using `zValidator('json', configSchema)` from core, and `POST /sources` using `zValidator('query', {name})` with a raw `arrayBuffer()` body, plus `export type AppType = typeof api`. `apps/web` is Vite 8 + React with `import type { AppType } from '@doomlearn/server'` and `hc<AppType>('/api')`.

- `pnpm install`: OK, 104 packages in 4.2 s. There was no `injectWorkspacePackages`, so the workspace packages are symlinks.
- `pnpm -r exec tsc --version` → `Version 7.0.2` ×3. `pnpm -r typecheck` (`tsc --noEmit` per package) took about 1.0 s wall in total. First run, two errors:
  1. `vite.config.ts: 'test' does not exist in type 'UserConfigExport'`. Fix: put `/// <reference types="vitest/config" />` at the top, as the Vitest 5 docs show (ctx7 `/vitest-dev/vitest/v5.0.3`, `$P2/r11/ctx7-vitest.txt`).
  2. `api.ts: Property 'bytes' does not exist on type 'ZodSafeParseError<{name:string}> | {name;bytes}'`. **zValidator's default 400 hook is part of the RPC response type.** You must narrow before reading the body (`if (res.status !== 201) return null`, or `res.ok`). This is not a config problem: it is how every client call has to be written.
- After the fixes: 0 errors. Cross-package `.ts` source typechecks with no extra flags. The web build uses `moduleResolution: bundler`, and it follows core's `./math.ts` import and the server's `.ts` source through `exports`. No `customConditions`, `types` condition or project references were needed.
- **The typing is real, not `any`.** `src/typeerrors.ts` has three `// @ts-expect-error` lines (provider `'gpt'`, query missing `name`, `client.nope`). tsc did not report them as unused, so each one is a real error.
- **Raw Blob upload through hc works, both typed and at runtime** (closes R6 OQ7). `client.sources.$post({ query: { name } }, { init: { body: blob } })` typechecks. A Vitest test drives it through `hc(..., { fetch: (i, init) => app.fetch(new Request(i, init)) })` and gets `201 {name:'a.pdf', bytes:1234}` (`apps/server/src/app.test.ts`). `init` is spread over hc's own options, so the body gets through.
- Caveat: node types leak into web. `apps/web` typechecks server source under web's tsconfig (`types: ["vite/client"]`, no `@types/node`). Server code using `node:path` or `@hono/node-server/serve-static` still passed, because `vite`'s `index.d.ts` line 1 is `/// <reference types="node" />` and `vite.config.ts` is in web's `include`. It works, but browser code can use `process` without a type error.
- `pnpm --filter @doomlearn/web build` → `✓ 119 modules transformed … dist/assets/index-*.js 291 kB … built in 75ms`. Vite 8 bundled core's `.ts` source with no plugin. `grep -c` on the bundle finds 0 hits for `zValidator`, `node-server` and `serveStatic`, so `import type` keeps the server out.
- `TLS_DIR=… PORT=18443 node apps/server/src/main.ts` → `listening https://127.0.0.1:18443 core.add=3`. Node 24.18.1 type stripping ran server .ts and core .ts through the pnpm symlink, with no flags and no warnings (`$P2/r11/server.log`). This matches R7 F2.

### F3. HTTPS dev: Vite proxy to Hono over mkcert

`CAROOT=$P2/r11/ca mkcert -cert-file tls/cert.pem -key-file tls/key.pem 127.0.0.1 localhost` (mkcert v1.4.4, never `-install`). `curl --cacert ca/rootCA.pem https://127.0.0.1:18443/api/health` → `{"ok":true,…}`. Without `--cacert`, curl exits 60. Vite 8.3.2 proxies through `http-proxy-3` (its package.json dependencies). `curl http://localhost:15173/api/health` through `server.proxy['/api']`:

| case | result |
|---|---|
| A `secure: false` | 200 `{"ok":true}` |
| B `secure: true`, no extra CA | **502**, Vite log: `http proxy error … unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca` |
| C `secure: true` + `NODE_EXTRA_CA_CERTS=ca/rootCA.pem` | 200 |

Both A and C work (closes R5 OQ6). C keeps verification on and needs only the env var `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` on the dev script. Node 24 also has `--use-system-ca` (`node --help`), which would read the keychain CA that `mkcert -install` puts there. I did not test that, because it needs the CA in the real keychain.

### F4. Vitest 5 root `test.projects`

A root `vitest.config.ts` with `projects: ['apps/*', 'packages/*']`, `pnpm test` = `vitest run`: `Test Files 3 passed (3), Tests 4 passed (4)`. The verbose output tags each project: `|@doomlearn/core| … core runs in node` (asserts `typeof window === 'undefined'`), `|@doomlearn/server| …` (2 hc tests), `|@doomlearn/web| … web runs in jsdom` (RTL render). Web takes `environment: 'jsdom'` from its own `vite.config.ts` `test` block, so no separate `vitest.config.ts` is needed there. Packages with no config default to node. **Yes, one `pnpm test` runs all of them.**

### F5. Biome 2.5.15 root plus nested `extends: "//"`

Root `biome.json` (`"root": true`) plus `apps/web/biome.json` (`"root": false, "extends": "//"`, `a11y.useButtonType: off`). `pnpm exec biome ci .` checked 24 files across all packages. It reported format and organizeImports diffs, and after `biome check --write` only lint was left. Scope test: the same `<button>x</button>` file was flagged in `packages/core` (`lint/a11y/useButtonType`) and not in `apps/web`. **Nested extends works, and `biome ci .` covers the whole workspace.** Two things R7 did not mention:
- `noMagicNumbers` flags HTTP status codes in `c.json(x, 201)` and `?? 8443` (`apps/server/src/app.ts:8,12`, `main.ts:8`). Status codes need a `STATUS` constant object, or the rule needs an override for route files.
- Biome 2.5 also lints `index.html` (`lint/a11y/useHtmlLang`).

## Recommendation for doomlearn v2

The skeleton works as designed. Adopt it with these paste-ready files.

```yaml
# pnpm-workspace.yaml
packages: ["apps/*", "packages/*"]
minimumReleaseAge: 10080
# remotion ships every few days and all @remotion/* must match; it is checked by a manual render instead
minimumReleaseAgeExclude: [remotion, "@remotion/*"]
allowBuilds: { esbuild: true, lefthook: true }
catalog:
  "@biomejs/biome": 2.5.15
  typescript: 7.0.2
  "@types/node": ^24.19.0
  vite: 8.3.2
  "@vitejs/plugin-react": 6.1.1
  vitest: 5.0.3
  jsdom: 30.1.1
  "@testing-library/react": 16.3.3
  "@testing-library/user-event": 14.6.7
  "@testing-library/jest-dom": 7.0.1
  react: 19.3.0
  react-dom: 19.3.0
  "@types/react": 19.3.0
  "@types/react-dom": 19.3.0
  hono: 4.13.12
  "@hono/node-server": 2.1.3
  "@hono/zod-validator": 0.9.1
  zod: 4.6.5
  vite-plugin-pwa: 1.3.0
  workbox-window: 7.4.1          # same 7.4.1 for workbox-build/-routing/-strategies/-range-requests/-cacheable-response/-precaching
  "@tanstack/react-query": 5.104.0
  react-router: 8.4.0
  react-hook-form: 7.89.0
  "@hookform/resolvers": 5.9.1
  tailwindcss: 4.3.3
  "@tailwindcss/vite": 4.3.3
  lefthook: 2.1.16
  "@commitlint/cli": 21.2.3
  "@commitlint/config-conventional": 21.2.3
  drizzle-orm: 1.0.0-rc.4        # exact: ^1.0.0-rc.4 resolves to branch builds (F1.4)
  drizzle-kit: 1.0.0-rc.4
  remotion: 4.0.534              # all @remotion/* exact, same version
```
Root `package.json`: `"packageManager": "pnpm@11.28.3"`, `"engines": {"node": ">=24"}`, scripts `typecheck: pnpm -r typecheck`, `test: vitest run`, `lint: biome ci .`. Use exact pins in the catalog so Dependabot (cooldown 7 days) does the bumping.

```json
// tsconfig.base.json (unchanged from R7; verified)
{ "compilerOptions": { "target": "esnext", "module": "nodenext", "moduleResolution": "nodenext",
  "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "erasableSyntaxOnly": true,
  "verbatimModuleSyntax": true, "skipLibCheck": true, "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true, "resolveJsonModule": true } }
// packages/*/tsconfig.json and apps/server/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src"] }
// apps/web/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "module": "esnext", "moduleResolution": "bundler",
  "lib": ["esnext", "dom", "dom.iterable"], "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src", "vite.config.ts"] }
```
```json
// packages/core/package.json            // apps/server/package.json
{ "name": "@doomlearn/core", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },   // server: { ".": "./src/app.ts" } (type-only import target)
  "scripts": { "typecheck": "tsc --noEmit" } }
// apps/web: "@doomlearn/server": "workspace:*" in devDependencies (type-only)
```
- `apps/web/vite.config.ts` starts with `/// <reference types="vitest/config" />` and has `test: { environment: 'jsdom' }`. The dev proxy is `proxy: { '/api': { target: 'https://127.0.0.1:8443', changeOrigin: true }, '/clips': {…} }`, with the dev script setting `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`. This keeps `secure: true` (F3 C). Use `secure: false` only if the CA path is not set up.
- Client rule for AGENTS.md: always narrow on `res.ok` or `res.status` before `res.json()`. The zValidator 400 body is in the type (F2). The upload uses `hc` with `{ init: { body: file } }`, so no separate raw `fetch` is needed.
- Biome: allow HTTP status codes and ports through a small `STATUS`/`DEFAULTS` constant object (this matches the owner's CLAUDE.md "group related constants"), not a rule override.

## Open questions

1. Remotion: pin 4.0.532 and keep the age rule strict, or keep 4.0.534 with `minimumReleaseAgeExclude` (recommended above, since the current code is on 4.0.534)?
2. Does `--use-system-ca` with the owner's real keychain mkcert CA work as a zero-config alternative to `NODE_EXTRA_CA_CERTS`? I did not test it, to keep the throwaway CA out of the keychain.
3. Should `apps/web` exclude `vite.config.ts` from the app tsconfig (a separate `tsconfig.node.json`) so node globals stop leaking into browser code? That costs one more tsconfig.
4. The spike did not cover the Vite dev server itself on HTTPS on the ZeroTier IP (`server.https`), vite-plugin-pwa `injectManifest` under TS 7, Tailwind, or `hcWithType`.
5. drizzle 1.0 stable is not out. Track `rc` and bump on purpose; never use a caret range on a prerelease.
