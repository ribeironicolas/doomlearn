# R12. Remotion render under pnpm and on Linux

All work is in `scratchpad/phase2/r12/` (`ws/` = Mac pnpm workspace, `linux/` = container inputs and logs `nolibs.log`, `libs.log`, `x64-*.log`). The doomlearn repo was not modified.

## Question
1. Does `src/render.ts` still bundle the agent's Scene from a job dir outside the repo when it lives in a pnpm monorepo package (isolated `node_modules`)?
2. Can the final mix (`render.ts:73-78`) use Remotion's bundled ffmpeg instead of system ffmpeg, with the same loudness? Which AAC encoder runs, and is libfdk_aac a license problem?
3. On `ubuntu:24.04`, are the apt libs needed, what fails without them, and how long does a render take?

## Findings

### F1. pnpm layout: the current resolve override works unchanged, if it points at the package's own node_modules
- Setup: root `package.json` with `packageManager: pnpm@11.28.2`, `pnpm-workspace.yaml` (`packages: ["packages/*"]`, `allowBuilds: {esbuild: true}`), and `packages/media` with `remotion`, `@remotion/{bundler,renderer,captions,google-fonts,media}` 4.0.534 exact, `react`/`react-dom` 19.3.0. `remotion/`, `vendor/explainroo/` and `src/render.ts` copied in as is. Install: `npx -y pnpm@11.28.2 install`, 224 packages, ~5.6 s.
- Without `allowBuilds.esbuild`, pnpm 11 exits with `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.1`. So the workspace yaml must allow `esbuild`.
- Layout: the root `node_modules/` holds only `.pnpm/`. `packages/media/node_modules/` holds symlinks to the direct deps (`remotion -> ../../../node_modules/.pnpm/remotion@4.0.534_.../node_modules/remotion`, same for `@remotion/*`, `react`, `react-dom`) (`ls -la packages/media/node_modules`).
- `render.ts:44` resolves `new URL('../node_modules', import.meta.url)`. From `packages/media/src/render.ts` that is `packages/media/node_modules`, which is exactly the right dir. **Unmodified render.ts rendered the fixture from a job dir outside the workspace** (`r12/jobs/job-*`): 1080x1920 h264 + aac, 10.000 s, -14.1 LUFS (ffprobe + `ebur128`), pops logged at 0.33/1.13/5.27/8.8 s (= frames 10, 34, 158, 264). Wall time 20.8 s on the first run (includes a 171 MB Chrome Headless Shell download into `packages/media/node_modules/.remotion`, 574 MB on disk), 10.7 s on a warm run.
- Transitive imports (`remotion` -> `react`, `@remotion/media` -> `remotion`) resolve because webpack follows the symlinks to their real `.pnpm/<pkg>/node_modules/` path (webpack `resolve.symlinks` defaults to true), where pnpm puts each package's own deps. No `public-hoist-pattern` and no `resolve.symlinks` change was needed.
- Control 1, no override: fails with `Module not found: Error: Can't resolve '@remotion/media' in '.../r12/jobs/job-yq0OuW/render'` after walking every parent `node_modules` up to `/`.
- Control 2, override pointed at the **workspace root** `node_modules` (`../../../node_modules`): same `Can't resolve '@remotion/media'` error. The root has no hoisted packages under pnpm. So the one trap is moving render.ts or pointing the path at the root.
- The bundle step also succeeded inside both Linux containers (the failure there was later, at browser launch, F3), so resolution works on Linux too.

### F2. Bundled ffmpeg replaces system ffmpeg for the mix
- Docs: "In order to use `ffmpeg` without having to directly install it, Remotion provides it via `npx remotion ffmpeg` ... A binary from the 7.1 release line of FFmpeg is used." (https://www.remotion.dev/docs/cli/ffmpeg, via ctx7 `/websites/remotion_dev`). `ensureFfmpeg()` was removed in v4 (https://www.remotion.dev/docs/renderer/ensure-ffmpeg).
- There is no documented Node API that returns the path. `@remotion/renderer` has `RenderInternals.getExecutablePath({type:'ffmpeg'})` and `RenderInternals.callFf` (`@remotion/renderer/dist/index.js:205-206`), but they are internal. The CLI command is a thin wrapper over them: `@remotion/cli/dist/ffmpeg.js` calls `getExecutablePath`, then `spawnSync(binary, args, {stdio:'inherit', env: DYLD_LIBRARY_PATH or LD_LIBRARY_PATH = binary dir})`, and `index.js:127` passes `process.argv.slice(3)` through raw.
- The binary needs that env. Run directly without `DYLD_LIBRARY_PATH`: `dyld: Library not loaded: libavdevice.dylib`. So do not exec the compositor binary by hand.
- Under pnpm the binary is in `node_modules/.pnpm/@remotion+compositor-darwin-arm64@4.0.534/.../compositor-darwin-arm64/ffmpeg` (also `ffprobe`), not a direct dep of the package, so resolving it yourself is fragile.
- Chosen locator: add `@remotion/cli@4.0.534` (exact) to the media package and exec its bin, `fileURLToPath(new URL('../node_modules/.bin/remotion', import.meta.url))` with `['ffmpeg', ...same args]`. Overhead: `remotion ffmpeg -version` takes 0.37 s.
- Verified: with Homebrew removed from `PATH` (`command -v ffmpeg` -> none), the full render through the CLI ffmpeg produced 10.000 s, -14.1 LUFS (`r12/ws/packages/media/src/render-bundled.ts`, `drive-b.ts`). It worked the same in the Linux containers, which have no ffmpeg at all.
- Same mix, same inputs, bundled n7.1 vs Homebrew 7.1: both -14.1 LUFS, LRA 1.7 LU, aac 48 kHz 129.6 kb/s, 10.000 s, and the two files are **byte identical** (`cmp` -> identical). Time 0.42 s vs 0.41 s.
- Encoder: `-c:a aac` picks FFmpeg's **native** AAC encoder. The output stream tag is `encoder: Lavc61.19.100 aac` and the log line is `[aac @ ...] Qavg`. libfdk_aac is only used when asked by name (`-encoders` lists `aac` and `libfdk_aac (codec aac)` as separate encoders).
- Build flags (`ffmpeg -buildconf`): `--enable-gpl --enable-libfdk-aac --enable-encoder=libfdk_aac`, no `--enable-nonfree`, `--disable-filters` plus an allowlist (it includes amix, loudnorm and volume, but **not ebur128**), and `-mmacosx-version-min=15.0`.
- License: "Remotion distributes a compiled FFmpeg binary under the GPLv2+ license" with source at github.com/remotion-dev/rust-ffmpeg-splitter, and "Remotion's FFmpeg binary uses the free `fdk-aac-free` variant, which has no licensing concerns" (https://www.remotion.dev/docs/miscellaneous/ffmpeg-license). doomlearn is AGPL-3.0-only and only invokes the binary as a separate program from npm, without redistributing it. That is mere aggregation, and GPLv2+ is compatible anyway. And the native encoder is what runs. So there is no license issue (this is my reading, not legal advice).
- Side effect for tests: `render.test.ts:59` uses system `ffprobe` (the bundled build has `ffprobe`, and `remotion ffprobe` works), and `render.test.ts:69` uses the `ebur128` filter, which the bundled build lacks: `Error opening output files: Filter not found`. `loudnorm=print_format=json` works with the bundled build (`-vn -c:a pcm_s16le -f null -`; the default null output fails with `Encoder not found` because encoders are allowlisted) and measured `input_i -14.41`, within the test's +-1 LU tolerance.

### F3. Linux (ubuntu:24.04, node 24.18.1 from the nodejs.org tarball, pnpm 11.28.2 via npx, `pnpm install --frozen-lockfile`)
Docker 29.6.2, an 11-CPU VM. The arm64 runs are native. The amd64 runs are emulated, so their times overstate a real x64 runner.

| run | apt step | `browser ensure` | render 1 / 2 (wall) | result |
|---|---|---|---|---|
| arm64, no libs | - | 4 s, 219 MB (`linux-arm64`) | 4.0 s / 4.1 s | **fail** |
| arm64, Remotion list | 14 s | 4 s, 219 MB | 10.4 s / 10.0 s | ok, -14.1 LUFS |
| amd64, no libs | - | 6 s, 236 MB (`linux64`) | 8.5 s / 9.6 s | **fail** |
| amd64, Remotion list | 49 s (emulated) | 7 s, 236 MB | 21.8 s / 21.2 s | ok |
| amd64, only `google-chrome-stable` .deb | (deb deps) | 7 s | 22.2 s / 25.0 s | ok |

- Exact error without libs (both arches): `Error: Failed to launch the browser process! Error: Closed with 127 signal: null ... chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory`. Note that `libnspr4` is not in Remotion's list by name. It comes in as a dependency of `libnss3`.
- The apt list used is the one from https://www.remotion.dev/docs/miscellaneous/linux-dependencies (Ubuntu 24.04): `libnss3 libdbus-1-3 libatk1.0-0 libasound2t64 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libgbm-dev libcups2 libcairo2 libpango-1.0-0 libatk-bridge2.0-0`.
- The GitHub `ubuntu-24.04` runner installs Google Chrome through `apt-get install google-chrome-stable_current_amd64.deb -f` (actions/runner-images `images/ubuntu/scripts/build/install-google-chrome.sh:38-40`; the readme lists `Google Chrome 154.0.8037.57`). The last row reproduces that: the Chrome .deb's dependencies alone were enough for Remotion's headless shell. This is consistent with Remotion's own GH Actions example, which has no apt step (https://www.remotion.dev/docs/ssr). It is strong evidence that the runner needs no apt step, but it was not run on a real runner.
- `pnpm install` in the container took 4-8 s. The harness loads Inter via `@remotion/google-fonts` (`remotion/harness.tsx:4`), which presumably fetches from Google at render time. The containers had network. An offline render was not tested.
- All 5 containers were removed (`docker rm`). The `ubuntu:24.04` image remains cached.

## Recommendation for doomlearn v2

1. **Resolve config (media package):** keep render.ts at `packages/media/src/render.ts` and keep `remotion/` at `packages/media/remotion/`. The override stays as is, and only the comment changes:
   ```ts
   // The job folder is outside the workspace, so packages resolve from this package's own node_modules
   // (pnpm links direct deps there; webpack follows the symlinks for transitive ones).
   webpackOverride: (config) => ({
     ...config,
     resolve: { ...config.resolve, modules: ['node_modules', fileURLToPath(new URL('../node_modules', import.meta.url))] },
   }),
   ```
   Every package the harness or a Scene imports must be a **direct** dep of `@doomlearn/media`. The harness skill (`remotion/api.md`) must list only those. No `public-hoist-pattern` and no `shamefully-hoist`. Add `esbuild: true` to `allowBuilds`.
2. **ffmpeg locator:** add `"@remotion/cli": "4.0.534"` (exact, same as the others) and change only the mix call:
   ```ts
   // Remotion's bundled ffmpeg (n7.1, `npx remotion ffmpeg`), so no system ffmpeg is needed.
   execFileSync(fileURLToPath(new URL('../node_modules/.bin/remotion', import.meta.url)), [
     'ffmpeg', '-y', '-v', 'error', /* ...unchanged args, keep -c:a aac (native encoder) */
   ]);
   ```
   Drop ffmpeg and ffprobe from the README prerequisites. In `render.test.ts`, use `remotion ffprobe` and measure loudness with `loudnorm=print_format=json` (keep the +-1 LU tolerance), so the test needs no system ffmpeg either. Keep `-c:a aac` explicit and add one line to the license notes saying that the bundled ffmpeg is GPLv2+ with fdk-aac-free, unused.
3. **CI render job** (SHAs from R7 §F7). There is no apt step, per F3. If a run fails with `libnspr4.so`, add the commented step back.
   ```yaml
   render:
     runs-on: ubuntu-24.04
     timeout-minutes: 15
     steps:
       - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
       - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
       - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
         with: { node-version: 24, cache: pnpm }
       - run: pnpm install --frozen-lockfile
       - uses: actions/cache@<sha> # cache the 236 MB headless shell; key on the remotion version
         with:
           path: packages/media/node_modules/.remotion
           key: remotion-chrome-${{ runner.os }}-4.0.534
       - run: pnpm --filter @doomlearn/media exec remotion browser ensure
       # Only if the runner image ever drops Chrome's deps (error: libnspr4.so not found):
       # - run: sudo apt-get update && sudo apt-get install -y libnss3 libdbus-1-3 libatk1.0-0 libasound2t64 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libgbm-dev libcups2 libcairo2 libpango-1.0-0 libatk-bridge2.0-0
       - run: pnpm --filter @doomlearn/media test -- render
   ```
   Expected cost: install about 10 s, ensure about 5 s (or 0 s from cache), fixture render 10-25 s. The emulated x64 run took about 21 s and native arm64 about 10 s, so the whole job should take 1-2 min. The render can stay in the default CI run. It does not need to move behind `DOOMLEARN_REAL_MEDIA`.

## Open questions
- I did not run this on a real GH `ubuntu-24.04` runner. The no-apt claim rests on the Chrome-.deb proxy plus Remotion's own example. The first v2 CI run settles it.
- `@remotion/cli` adds a dependency only to get a stable, documented ffmpeg entry point. The alternative is `RenderInternals.callFf` from `@remotion/renderer`: no new dep, but an internal API. I picked the CLI. The owner may prefer the smaller dep set.
- The bundled macOS binary is built with `-mmacosx-version-min=15.0`. Does that make macOS 15 the stated Mac minimum (vs the mlx question in R9)?
- Google Fonts are fetched at render time. Offline renders (or flaky CI network) would fail. Should Inter be vendored as a local font file?
