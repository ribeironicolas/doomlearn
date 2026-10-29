# R7: Tooling for the doomlearn v2 pnpm monorepo

## Question
Which toolchain should the v2 monorepo use? The candidates are pnpm workspaces and catalogs, a linter and formatter, a TypeScript layout, a test runner, git hooks with commitlint, CI, dependency updates, .editorconfig and a Mac preflight. Where it makes sense the setup should match the owner's reference monorepo, and every choice should be checked against current docs.

## Findings (with evidence)

### F1. What the owner's reference monorepo actually uses (the baseline to mirror)
- `packageManager: pnpm@11.1.2`, `pnpm-workspace.yaml` with `packages: [apps/*, packages/*]`, a `catalog:` (it pins `@biomejs/biome: 2.5.6`, `typescript: ^5.9.3`), `allowBuilds`, and `injectWorkspacePackages: true` (files: its root `package.json` and `pnpm-workspace.yaml`).
- Biome is the only linter and formatter. The root `biome.json` extends a preset kept in `packages/config/base/biome.preset.json`: recommended rules, `noNonNullAssertion` off, `useBlockStatements` error, double quotes, organizeImports off. A `packages/config` package built with tsup ships the biome, tsconfig and jest presets.
- Tests use Jest, and Playwright for e2e. It has no git hooks, no commitlint, no Dependabot or Renovate, and no `.editorconfig` (`ls -a` at the repo root). Conventional Commits are kept by discipline only (`git log`).
- CI (`.github/workflows/ci.yml`) runs on `ubuntu-latest`, with actions pinned by SHA and a version comment, `permissions: contents: read`, `persist-credentials: false`, `cache: pnpm`, `pnpm install --frozen-lockfile`, and then lint, typecheck and test. A separate `audit.yml` runs `pnpm audit --prod --audit-level high` weekly and when the lockfile changes.
- `.nvmrc` is `24`.

### F2. pnpm
- Catalogs: a `catalog:` block in `pnpm-workspace.yaml`, referenced from packages as `"dep": "catalog:"` (https://pnpm.io/catalogs). Workspace packages are referenced as `workspace:*`.
- pnpm 11 made several defaults safer: `minimumReleaseAge: 1440`, `blockExoticSubdeps: true`, `strictDepBuilds: true`, `verifyDepsBeforeRun: install` (https://pnpm.io/blog/releases/11.0). Setting `minimumReleaseAge` explicitly makes it strict (https://pnpm.io/settings/dependency-resolution). Builds are allowed through `allowBuilds: {pkg: true}`.
- pnpm 12 (12.0.0 on 2026-08-26) is the Rust port (https://pnpm.io/blog/releases/11.10). `latest-11` is 11.28.x (`npm view pnpm dist-tags`).
- `pnpm doctor` is a built-in command (`pnpm help doctor` prints "Checks for known common issues"; https://pnpm.io/cli/doctor), so a script named `doctor` gets shadowed. The preflight needs a different name.
- Tested with pnpm 10.33 and 12.10.1 in scratch: pnpm runs `pre<script>` hooks, so the current `prestart`/`presmoke` keep working.
- **Type stripping vs workspace links (tested).** Node 24.18 runs a workspace package's `.ts` source through a pnpm-style symlink (`packages/core` linked into `apps/server/node_modules/@doomlearn/core`) because it resolves the realpath: the output was `ok 3`. With `--preserve-symlinks` it fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, because the path sits under node_modules (scratch `phase2/r7-strip`). **So the owner's reference monorepo's `injectWorkspacePackages: true`, which copies packages into node_modules, would break the no-build setup and must not be copied.**

### F3. Biome 2.x vs ESLint+Prettier
- Biome 2.5.15 is the latest and 2.5.14 came out 2026-09-16 (`npm view`). It is one binary for lint and format, and it supports monorepos with nested `biome.json` files that use `"extends": "//"` (https://biomejs.dev/guides/big-projects).
- **Magic numbers:** `style/noMagicNumbers` exists (since 2.1, not recommended, default severity info). It already ignores 0, 1, 2, 10, 24, 60, array indices, initial values in declarations, default parameter values, object property values and JSX values (https://biomejs.dev/linter/rules/no-magic-numbers). Those exemptions match the owner's CLAUDE.md exceptions ("values inside options objects", "default args").
- **JSDoc:** Biome has no rule that requires JSDoc. The only JSDoc rule is `useSingleJsDocAsterisk` (`gh api biomejs/website …/rules.mdx | grep -i jsdoc`), and nursery has nothing either (`gh api …/lint/nursery`). A GritQL predicate for this was requested in biome#10474 (closed 2026-05), and nothing confirms a shipped rule. Enforcing JSDoc would need ESLint with `eslint-plugin-jsdoc` (`jsdoc/require-jsdoc`), a second linter.
- **Trial on a copy of the current code** (Biome 2.5.14, recommended rules plus noMagicNumbers=warn, magic numbers off in tests): 11 errors and 120 warnings across 42 files. The largest groups are `noNonNullAssertion` (56), `noMagicNumbers` (51 in non-test code) and `noCommaOperator` (7). The errors come from `useIterableCallbackReturn` (3), `noAssignInExpressions` (3), `useButtonType` (3, web) and `noControlCharactersInRegex` (2) (scratch `phase2/r7-tools/biome-try`).
- **Formatter churn on `src/`, measured by changed diff lines:**

| lineWidth | single quotes | double quotes |
|---|---|---|
| 100 | 2062 | 4082 |
| 120 | 1266 | 3470 |
| 140 | 694 | 3014 |

  The current code uses single quotes and its longest line is 178 characters, so double quotes (the reference monorepo's style) roughly triples the churn.

### F4. TypeScript
- The repo is on `typescript ^7.0.2`, the native compiler. 7.0.2 was published 2026-07-08 (`npm view typescript time`). The reference monorepo is on 5.9.
- TS 7 supports `tsc -b` build mode with parallel builders (typescript-go `internal/execute/build/orchestrator.go`, via ctx7).
- Project references need `composite` and declaration emit. The repo today uses `noEmit` plus `allowImportingTsExtensions` plus `erasableSyntaxOnly` with Node type stripping (`~/projects/doomlearn/tsconfig.json`), and typecheck takes about 0.5 s (architecture-now.md). The "internal package" pattern needs neither references nor emit: `exports` points at `./src/index.ts`, and each package runs `tsc --noEmit` from a shared base. F2 verified that Node runs this at runtime.

### F5. Vitest vs node:test
- Vitest 5.0.3 is the latest and 5.0.2 came out 2026-09-25. It needs Node `^22.12 || ^24 || >=26` and has peer `vite ^6.4 || ^7 || ^8` (`npm view vitest@5.0.3`). The `test.projects` option gives each project its own environment, for example `jsdom` for the PWA and `node` for core (https://github.com/vitest-dev/vitest/blob/main/docs/guide/projects.md).
- **Port trial (scratch `phase2/r7-vitest/port`).** I applied a mechanical sed to a copy of `src/`: `import { test } from 'node:test'` became `from 'vitest'`, and `t.after(` became `t.onTestFinished(`. `node:assert/strict` stayed. Result: 93 passed, 8 skipped, 1 failed out of 102. The failure is the one test that uses `t.mock.timers` (`pipeline.test.ts:177`), which would need `vi.useFakeTimers({ toFake: ['Date'] })`. `node:sqlite` and `.ts`-extension imports work under Vitest. The baseline `node --test` ran 105 tests (96 pass, 9 skip) in about 1.8 s wall, so **speed is not an argument** either way.
- The Vite+React PWA needs a DOM environment (jsdom 30.1.x) and React Testing Library 16.3.3. Vitest is the native runner for Vite, and node:test has no Vite transform or JSX.

### F6. Hooks and commitlint
- Lefthook is a single binary that does staged-file globbing and `stage_fixed` itself, so lint-staged is not needed (https://github.com/evilmartians/lefthook/blob/master/docs/examples/stage_fixed.md), and it supports a `commit-msg` hook that calls `commitlint --edit {1}` (…/docs/examples/commitlint.md). husky 9.1.7 was last released 2024-11 and needs lint-staged plus a `prepare` script. Lefthook 2.2.1 is from 2026-10-08, but 2.1.16 (2026-10-01) or older is better for a minimum release age. Under pnpm 11 `strictDepBuilds`, lefthook's postinstall has to be allowed in `allowBuilds`.
- **commitlint 21.2.3, tested.** I used config-conventional with a `type-enum` matching AGENTS.md and a custom inline plugin rule that requires ` (#N)` or ` (#N, #M)` at the end of the header. Run over this repo's history, every `feat|fix|refactor|test|docs|chore` commit passes except the bootstrap commit `docs: adopt Conventional Commits`. The default `header-max-length` of 100 rejected real subjects (the longest are 116, 121 and 123 characters), so it needs 150. Older non-conventional "Merge #27…" and "Add …" commits fail, as expected, and they are never linted again.

### F7. CI on ubuntu: what can and cannot run
- **Can run** with the fake ports: typecheck, Biome (`biome ci`) and the unit tests, which are the 96 fast tests on `fakeAgent` and `fakeMedia` with temporary SQLite (architecture-now.md, "Tests").
- **Remotion render can run headless on ubuntu.** Remotion documents a GitHub Actions render workflow (https://www.remotion.dev/docs/ssr) and lists the Ubuntu 24.04 apt packages for Chrome Headless Shell (https://www.remotion.dev/docs/miscellaneous/linux-dependencies). But `render.ts:73` also calls the system `ffmpeg` for amix and loudnorm, and the ubuntu-24.04 runner image has Chrome and Python 3.12.3 but no ffmpeg (`actions/runner-images …/Ubuntu2404-Readme.md`). It needs `apt-get install ffmpeg` plus those libraries. The fixture render test has a 600 s timeout (`render.test.ts:52`).
- **Cannot run on Linux:** TTS (Chatterbox hard-coded to `"mps"`) and alignment (`mlx-audio`, Apple Silicon only), per architecture-now.md, plus the real `claude -p` and `codex` calls (subscription login). The real-converter tests (`DOOMLEARN_REAL_MEDIA=1`) could run on Linux with calibre and pymupdf4llm, but that is optional.
- Current action tags: `actions/checkout v7.0.1` = `3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/setup-node v7.0.0` = `820762786026740c76f36085b0efc47a31fe5020`, `pnpm/action-setup v6.1.0` = `ea17c68df8912ef543352723c149a84f56e3d413` (`gh api repos/<r>/commits/<tag>`).

### F8. Dependabot vs Renovate
- Dependabot reads `pnpm-workspace.yaml` and `pnpm-lock.yaml` (dependabot-core `file_fetcher.rb`, via ctx7). Catalog support has open bugs: #14824 groups catalog deps as production, and #13347 bumps a catalog backwards. Renovate handles pnpm and catalogs but needs a GitHub App install and config. The owner's reference monorepo uses neither.

## Recommendation for doomlearn v2

1. **pnpm 11.28.x, not 12.** Set `packageManager: "pnpm@11.28.2"`. That is the same major as the owner's reference monorepo and the mature JS implementation, while 12 is a six-week-old Rust rewrite. Use `workspace:*` for internal packages and a single default catalog for every shared external dependency. Set `minimumReleaseAge: 10080` (7 days) explicitly, which also makes it strict. **Do not set `injectWorkspacePackages`** (F2). Internal packages export `.ts` source, so there is no build step.
```yaml
# pnpm-workspace.yaml
packages: ["apps/*", "packages/*"]
minimumReleaseAge: 10080
allowBuilds: { lefthook: true, esbuild: true }   # add more as installs request them
catalog:
  "@biomejs/biome": 2.5.14
  typescript: ^7.0.2
  "@types/node": ^24.19.1
  vitest: ^5.0.2
  jsdom: ^30.1.1
  vite: ^8.3.1
  "@vitejs/plugin-react": ^6.1.1
  "@testing-library/react": ^16.3.3
  hono: ^4.13.9
  "@hono/node-server": ^2.1.1
  react: 19.3.0
  react-dom: 19.3.0
  "@types/react": 19.3.0
  remotion: 4.0.534        # every @remotion/* pinned exactly to the same version
  drizzle-orm: ^1.0.0-rc.4
  drizzle-kit: ^1.0.0-rc.4
```
2. **Biome 2.5.14 for both lint and format; no ESLint.** Put one root `biome.json` at the repo root and add a package-level one with `"extends": "//"` only where a package needs different rules. A `packages/config` package with a tsup build, as in the owner's reference monorepo, is overkill here. Format with single quotes and lineWidth 120, the lowest churn that is not overlong (F3), and land the reformat as one commit listed in `.git-blame-ignore-revs`.
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/fixture/**", "!**/test/fixtures/**", "!python/**", "!vendor/**"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": { "formatter": { "quoteStyle": "single" } },
  "linter": { "rules": { "recommended": true, "style": {
    "noNonNullAssertion": "off",
    "noMagicNumbers": "error",
    "useSingleJsDocAsterisk": "error"
  } } },
  "overrides": [{ "includes": ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
    "linter": { "rules": { "style": { "noMagicNumbers": "off" } } } }]
}
```
   Lint enforces magic numbers. Biome cannot enforce JSDoc presence (F3), so for now that stays a written rule in AGENTS.md and CONTRIBUTING.md and a review item. Adding ESLint for one rule goes against "Simplicity First".
3. **TypeScript 7.** Use a root `tsconfig.base.json` that each package extends, with no project references for now (F4). Each package runs `"typecheck": "tsc --noEmit"`, and the root runs `pnpm -r typecheck`. Revisit `tsc -b` if typecheck goes past about 10 s.
```json
{ "compilerOptions": { "target": "esnext", "module": "nodenext", "moduleResolution": "nodenext",
  "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "erasableSyntaxOnly": true,
  "verbatimModuleSyntax": true, "skipLibCheck": true, "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true, "resolveJsonModule": true } }
```
   `apps/web` overrides `module: "esnext"`, `moduleResolution: "bundler"`, `lib: ["esnext","dom"]`, `jsx: "react-jsx"`, `types: ["vite/client"]`. The Remotion package uses `jsx: "react-jsx"`, which brings `remotion/` under tsc for the first time.
4. **Vitest 5 everywhere, via root `test.projects`.** With one runner, the PWA, the Remotion helpers and core all test the same way, which contributors expect. The port is mechanical (F5): about 15 lines of sed plus one fake-timer rewrite, and `node:assert` can stay. The real render, smoke and real-media tests stay opt-in through env vars, with the render test moved behind `DOOMLEARN_RENDER=1` so the default `pnpm test` stays fast and runs on Linux without ffmpeg.
```ts
// vitest.config.ts (root)
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['apps/*', 'packages/*'] } });
// apps/web/vitest.config.ts
import { defineProject } from 'vitest/config';
export default defineProject({ test: { environment: 'jsdom' } });
```
5. **Lefthook (pin 2.1.16) and commitlint 21.2.3.**
```yaml
# lefthook.yml
pre-commit:
  jobs:
    - run: pnpm exec biome check --write --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
      glob: "*.{ts,tsx,js,json,css,html}"
      stage_fixed: true
commit-msg:
  jobs:
    - run: pnpm exec commitlint --edit {1}
```
```js
// commitlint.config.js — tested against this repo's history (F6)
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'refactor', 'test', 'docs', 'chore']],
    'subject-case': [0],
    'header-max-length': [2, 'always', 150],
    'subject-issue-ref': [2, 'always'],
  },
  plugins: [{ rules: { 'subject-issue-ref': ({ header }) =>
    [/ \(#\d+(, #\d+)*\)$/.test(header ?? ''), 'end the subject with the issue it serves, e.g. (#23)'] } }],
};
```
   CI also runs commitlint on PR commits (`commitlint --from origin/main --to HEAD`), because hooks can be skipped with `--no-verify`.
6. **CI on GitHub Actions, ubuntu-latest, SHA-pinned like the owner's reference monorepo.** `ci.yml` has two jobs:
   - `checks`, on every PR: `pnpm install --frozen-lockfile`, `pnpm exec biome ci .`, `pnpm -r typecheck`, `pnpm test` (fakes only), commitlint on the PR range.
   - `render`, only when `packages/remotion/**` or the render adapter changes, with a 15 min timeout: `sudo apt-get install -y ffmpeg libnss3 libdbus-1-3 libatk1.0-0 libasound2t64 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libgbm-dev libcups2 libcairo2 libpango-1.0-0 libatk-bridge2.0-0`, then `DOOMLEARN_RENDER=1 pnpm --filter <remotion pkg> test`.

   Both jobs use `permissions: contents: read`, `persist-credentials: false`, `node-version-file: .nvmrc`, `cache: pnpm`, `concurrency` with cancel-in-progress, and `on: pull_request` for branches `[main]`. TTS, alignment, `claude` and `codex` stay out of CI and are covered on the Mac by `pnpm smoke`. Copy the owner's reference monorepo's `audit.yml` as is.
```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with: { persist-credentials: false }
- uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
  with: { node-version-file: .nvmrc, cache: pnpm }
```
7. **Dependabot, not Renovate.** It is native to GitHub with no app install, which is simpler for self-hosters who fork the repo. Use a weekly grouped `npm` update with `cooldown: { default-days: 7 }`, matching pnpm's minimumReleaseAge, and a `github-actions` ecosystem so the SHA pins get bumped. Exclude `remotion` and `@remotion/*` from automatic bumps (`ignore`), because they must move together and need a manual render check. If Dependabot's catalog bugs (F8) show up, switch to Renovate.
8. **`.editorconfig`** (UTF-8, LF, 2 spaces, final newline, trim trailing whitespace; `[*.py] indent_size = 4`; `[*.md] trim_trailing_whitespace = false`). Also add `.nvmrc` = `24` and `engines.node: ">=24"`.
9. **Preflight is `pnpm preflight`, not `pnpm doctor`** (that name is a pnpm built-in, F2). It is a single `scripts/preflight.ts` run by Node, with no dependencies, called from `prestart`, and also reachable as the CLI subcommand `doomlearn doctor`. It prints ✓ or ✗ with an install hint for each item and exits non-zero only when a required item is missing.

| check | how | required |
|---|---|---|
| macOS arm64 | `process.platform==='darwin' && process.arch==='arm64'` (MPS/MLX) | yes |
| Node >= 24 | `process.versions.node` | yes |
| ffmpeg | `ffmpeg -version` | yes |
| Calibre | `ebook-convert --version` | yes |
| Python 3.12 | `python3.12 --version` | yes |
| mkcert + CA installed | `mkcert -CAROOT` and the rootCA.pem exists | yes |
| ZeroTier | `zerotier-cli info` (may need sudo, so only warn) | no, phone access only |
| claude / codex | `claude --version`, `codex --version`; required only for the providers set in config | at least one |

   All of these are present on the owner's Mac (`which` resolves each one: /opt/homebrew/bin/{ffmpeg,ebook-convert,python3.12,mkcert}, /usr/local/bin/zerotier-cli, ~/.local/bin/{claude,codex}).

## Open questions
1. Should the six commit types grow to include `ci` and `build`, as the reference monorepo already uses `ci:`, and should `docs`/`chore` commits be allowed without `(#N)`, given the bootstrap commit fails today?
2. Is JSDoc enforcement worth a second linter (ESLint plus `eslint-plugin-jsdoc` on `require-jsdoc` only), or is AGENTS.md plus review enough? I recommend AGENTS.md plus review.
3. Should the render CI job run on every PR or only on path changes? On ubuntu it costs several minutes per run, and the timing was not measured in this research.
4. Should Python get tooling (ruff via `uvx`, pytest) in the same CI? It is out of scope here, but contributors will touch `python/`.
5. Should the repo pin `"@types/node"` to `^24` to match the runtime or to the latest 26.x? I recommend ^24.
6. Is moving to pnpm 12 worth it once it has had about a quarter to settle?
