# R9: Python runtimes and media toolchain for doomlearn v2

## Question

How should the Python side (Chatterbox TTS on MPS, Qwen3 aligner on MLX, pymupdf4llm) be packaged in v2 so contributors can set it up easily, while the project stays Mac-only? The sub-questions:
- uv: should there be one workspace or one project per tool?
- Can a single venv hold all three runtimes?
- How should model weights be pinned and cached?
- How do the ports become fake-able on Linux CI?
- What stable CLI contract per tool would let someone add a Linux or NVIDIA backend later?
- What do Remotion 4.0.534 headless rendering and ffmpeg need?
- What layout should `packages/media` have?

Sandbox: uv 0.12.24, installed into `scratchpad/phase2/uvtool/venv`, with its cache in `scratchpad/phase2/uvtool/cache`. Lock experiments ran in `scratchpad/phase2/sandbox-media` and `scratchpad/phase2/sandbox-ws`. Nothing was installed globally.

## Findings (with evidence)

### F1. The current setup
- `python/setup.sh` loops over `tts align convert`. For each one it runs `python3.12 -m venv`, then `pip install -r requirements.txt`, then writes a `.installed` marker. There is no lockfile and no hash pinning (`python/setup.sh`; architecture-now.md §8).
- The direct pins are `chatterbox-tts @ git+...@5de7a54`, `soundfile==0.14.0`, `mlx-audio==0.5.8` and `pymupdf4llm==1.28.2`. They live in `python/*/requirements.txt`. Transitive dependencies are not pinned.
- The venv sizes on disk are tts 1.3G, align 546M and convert 261M (`du -sh python/*/.venv`).
- The protocol is already a JSON-lines stdio server for `tts` and `align`. The docstrings in `python/{tts,align}/server.py` define it as `{"text","out"} -> {"durationMs"}|{"error"}` and `{"audio","text"} -> {"words":[{word,startMs,endMs}]}|{"error"}`. stdout is redirected to stderr so that library prints cannot corrupt the protocol.
  - `convert/pdf.py` is a one-shot that takes argv and prints JSON.
  - `convert/ebook.py` runs under Calibre's own Python, not a venv.
- Node spawns `python/<name>/.venv/bin/python server.py`, and the path is hard-coded (`src/media.ts:44-49`). Nothing is negotiated: there is no version or ready handshake.
- The TTS device is hard-coded: `ChatterboxTTS.from_pretrained("mps")` (`python/tts/server.py:29`).

### F2. A single venv is impossible because of a hard dependency conflict
I resolved the union of the three requirement files with `uv pip compile` for py3.12 on macOS arm64:
```
error: No solution found ... mlx-audio>=0.5.8 depends on transformers>=5.14.0 and
chatterbox-tts==0.1.7 depends on transformers==5.2.0 ... unsatisfiable.
```
There is also a numpy split. tts locks `numpy==1.26.4`, while align and convert lock `numpy==2.5.3`. These come from per-tool `uv pip compile`, and they match the existing venvs' `pip freeze`: tts has numpy 1.26.4, torch 2.6.0 and transformers 5.2.0; align has numpy 2.5.3, mlx 0.32.3 and transformers 5.19.0. **tts and align cannot share an environment.** convert could live with align, but merging them gains nothing.

### F3. A uv workspace is the wrong shape, so use independent projects
- The uv docs say: "Workspaces are *not* suited for cases in which members have conflicting requirements, or desire a separate virtual environment for each member. In this case, path dependencies are often preferable" (https://docs.astral.sh/uv/concepts/projects/workspaces, via ctx7 `/websites/astral_sh_uv`).
- I tested this in the sandbox. A workspace with members tts, align and convert fails with the same transformers conflict. Adding `[tool.uv] conflicts = [[{package="doomlearn-tts"},{package="doomlearn-align"}]]` makes it lock, but uv warns: "Declaring conflicts for packages (`package = ...`) is experimental and may change without warning". A workspace also has one root `.venv`, and tts and align run as concurrent long-lived processes, so they cannot share it.
- I also locked three independent projects (`pyproject.toml` with `requires-python = "==3.12.*"`, `[tool.uv] package = false`, and the git pin moved to `[tool.uv.sources] chatterbox-tts = { git = ..., rev = "5de7a54..." }`). All three locked cleanly: tts resolved 128 packages (uv.lock 1742 lines), align 37 and convert 13.
- `uv lock --check` exits 0 when the lock is in sync, which makes it a cheap CI gate.

### F4. `uv run` costs almost nothing per spawn
With convert synced in the sandbox, `uv run --locked --project <dir> python -c "import pymupdf4llm"` took about 0.34 s on warm runs. Calling `.venv/bin/python` directly took 0.33 s, and the first run, which included the sync, took 3.67 s. Spawning through `uv run --locked --project packages/media/python/<tool>` therefore costs effectively nothing, and it keeps the venv in sync with the lock automatically. Per the docs (https://docs.astral.sh/uv/concepts/projects/sync):
- `--locked` errors if the lock is stale.
- `--frozen` skips that check.

### F5. uv can provision Python 3.12 itself
"By default, uv will automatically download Python versions when needed", and the `python-downloads` setting controls this (https://docs.astral.sh/uv/concepts/python-versions). A `.python-version` containing `3.12`, plus `requires-python = "==3.12.*"`, removes Homebrew `python3.12` as a prerequisite; that prerequisite currently sits on the PATH list (architecture-now.md §6). The sandbox used the Homebrew 3.12.6 that was already present ("Using CPython 3.12.6 interpreter at /opt/homebrew/...").

### F6. Universal locks already resolve for Linux
- `uv lock` produces a universal lock. The tts lock has resolution-markers for win32, emscripten and others, and it contains 32 `nvidia-*` packages, because torch 2.6.0 on Linux pulls CUDA wheels.
- align also resolves for `x86_64-manylinux_2_35`, because mlx 0.32.3 publishes manylinux wheels. uv's hint said: "Wheels are available for `mlx` (v0.32.3) on ... manylinux_2_35_aarch64, manylinux_2_35_x86_64, macosx_14_0_arm64...". Whether the Qwen3 aligner actually runs usefully on Linux MLX (CPU or CUDA) is untested.
- convert resolves for `x86_64-manylinux_2_28`.
- mlx needs macOS 14 or later. A resolve that targets the default macOS 13 fails: "mlx>=0.31.1 has no wheels with a matching platform tag (e.g., macosx_13_0_arm64)". This minimum belongs in the README.

### F7. Model weights: about 4.2 GB, unpinned, in the default HF cache
Measured with `ls -lLh ~/.cache/huggingface/hub/models--*/snapshots/*/`:

| Repo | Files used | Size |
|---|---|---|
| ResembleAI/Chatterbox-Multilingual-pt-br | t3_pt_br.safetensors 2.0G, s3gen_v3.pt 1.0G (plus s3gen_v3.safetensors 1.0G, which is cached but not used: `S3GEN_FILENAME = "s3gen_v3.pt"` in `vendor/chatterbox/tts.py:23`) | 3.0G used |
| ResembleAI/chatterbox | ve.pt 5.4M, conds.pt 105K, tokenizer 68K | ~6M |
| mlx-community/Qwen3-ForcedAligner-0.6B-8bit | model.safetensors 1.2G | 1.2G |

Two problems:
- **Neither download is pinned.**
  - `vendor/chatterbox/tts.py:191-206` calls `snapshot_download(..., revision="main")` and `hf_hub_download(...)` with no revision.
  - `align/server.py` calls `load("mlx-community/Qwen3-ForcedAligner-0.6B-8bit")` with no revision, although `mlx_audio.stt.utils.load` accepts `revision` (`site-packages/mlx_audio/stt/utils.py:155-221`).
- The vendored loader **writes symlinks into the HF cache**. They point from the `ResembleAI/chatterbox` snapshot to the pt-br files (`ls -la` shows `t3_pt_br.safetensors -> .../Chatterbox-Multilingual-pt-br/...`; code at tts.py:208-215). That mutates the shared cache in a surprising way.

The fix: `revision` accepts a full commit sha, and with a pinned sha cached, "no HTTP call is needed at all". The cache location comes from `HF_HOME`/`HF_HUB_CACHE`, which defaults to `~/.cache/huggingface/hub` (huggingface_hub docs: guides/download.md, package_reference/environment_variables.md, guides/manage-cache.md). The shas now cached locally are:
- pt-br `b3952f18bc2eaa72b9bd7c17d2c4653bcad4770d`
- base `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18`
- aligner `0e1a68e91d815300c7c9754b2a7639378b23db15`

I did not measure first-run time. It is dominated by the roughly 4.2 GB download plus about 2.1 GB of venvs (F1).

### F8. Remotion 4.0.534 headless rendering
- **Browser:** Chrome Headless Shell is downloaded on demand to `node_modules/.remotion/chrome-headless-shell/<platform>/` (https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell). It can be fetched ahead of time with `npx remotion browser ensure` (https://www.remotion.dev/docs/docker). Locally it is `mac-arm64`, VERSION `157.0.8080.0-remotion-v3`, and 584M (`du -sh node_modules/.remotion`).
- **Ubuntu:** Ubuntu 24.04 needs these apt libs: `libnss3 libdbus-1-3 libatk1.0-0 libasound2t64 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libgbm-dev libcups2 libcairo2 libpango-1.0-0 libatk-bridge2.0-0` (https://www.remotion.dev/docs/miscellaneous/linux-dependencies). Remotion's own GitHub Actions example runs `npx remotion render` on `ubuntu-latest` with no apt step (https://www.remotion.dev/docs/ssr).
- **ffmpeg:** "Since Remotion v4.0, Remotion comes bundled with a lightweight version of FFmpeg", and `npx remotion ffmpeg` exposes it (https://www.remotion.dev/docs/ffmpeg, /docs/cli/ffmpeg). The binary lives in the platform compositor package (`node_modules/@remotion/compositor-darwin-arm64/ffmpeg`, 17M).
  - doomlearn calls **system** `ffmpeg` only for the final mix: `amix` + `loudnorm` + `aac` (`src/render.ts:73-78`).
  - I checked the bundled binary. It is "ffmpeg version n7.1", and `-filters` lists `amix`, `atempo` and `loudnorm`. `-encoders` lists `aac`, `libfdk_aac` and `libx264`.
  - So **the bundled ffmpeg can do the mix**, and system ffmpeg can be dropped as a prerequisite. The PATH list in architecture-now.md §6 also mentions `ffprobe`, but no `src/*.ts` file calls it (grep shows only `render.ts` uses ffmpeg).
- **Tests:** `src/render.test.ts:52` is an *unconditional* real render (600 s timeout), so Linux CI needs Chrome libs and ffmpeg today.

### F9. Fakes and CI gating today
- The Media port has `fakeMedia()` (architecture-now.md §4).
- Real Python runs are opt-in. `DOOMLEARN_REAL_MEDIA` gates `src/convert.test.ts:17` and `src/narration.test.ts:111`, and `DOOMLEARN_SMOKE` gates `src/smoke.test.ts:21`.
- There are no Python tests and no Python lint (architecture-now.md §8).

### F10. The owner's reference monorepo
- The `pnpm-workspace.yaml` globs are `apps/*` and `packages/*`, with a `catalog:` and `allowBuilds`. It has three apps (an API, a website and a mobile app) and two packages (`config`, `lib`).
- It has no Python (`find -name pyproject.toml` is empty).
- pnpm treats only directories that have a `package.json` as workspace packages, so Python dirs nested under a TS package are invisible to pnpm.

## Recommendation for doomlearn v2

1. **Use one independent uv project per runtime, not a workspace and not one venv** (F2, F3). Each runtime gets `pyproject.toml`, `uv.lock`, `.python-version` (`3.12`) and `requires-python = "==3.12.*"`. Commit the locks. The chatterbox git pin moves to `[tool.uv.sources]`. requirements.txt and setup.sh are deleted.
2. **Proposed layout:**
   ```
   packages/media/                 # pnpm pkg "@doomlearn/media": the real Media port (TS)
     package.json                  # scripts: setup = uv sync --locked in each python/*; test
     src/                          # localMedia, runtime spawner, convert.ts, render.ts, mix
     contracts/                    # JSON Schema per runtime: tts.*.json, align.*.json, convert.*.json
     python/
       tts/    pyproject.toml uv.lock .python-version server.py faber.wav vendor/chatterbox/
       align/  pyproject.toml uv.lock .python-version server.py
       convert/pyproject.toml uv.lock .python-version pdf.py  ebook.py  # ebook.py stays on Calibre's Python
   packages/remotion-harness/      # (or inside media) Root.tsx, harness.tsx, api.md, fixture
   ```
   The Media port *type* and `fakeMedia` stay in core (the domain package). `@doomlearn/media` is the adapter that owns its runtimes, so the TS spawner and the Python it spawns live and version together.
3. **Spawn through uv:** `uv run --locked --project <python/tool> python server.py` (F4). This replaces the hard-coded `.venv/bin/python` and the `.installed` marker. `pnpm setup` (or `doomlearn doctor`) runs `uv sync --locked` for all three and `npx remotion browser ensure`. The prerequisites become uv (`brew install uv`), Calibre and Claude/Codex. Python 3.12 comes from uv (F5), and ffmpeg comes from Remotion (F8).
4. **Add a stable runtime contract** so that a backend is just a command:
   - Keep the JSON-lines stdio protocol as it is (F1), and write it down as JSON Schemas in `contracts/` that both the TS adapter (zod/ajv) and the Python tests validate against.
   - Add one handshake line on startup, such as `{"ready":true,"protocol":1,"backend":"chatterbox-mps"}`. Node can then fail fast with a clear message instead of "runtime exited".
   - Let config override the command per runtime, for example `media.tts.command = ["uv","run",...,"server.py"]`. A Linux/NVIDIA contributor could then point it at `server_cuda.py`, or at any executable that speaks the protocol, without touching core.
   - Do not build a plugin system now.
5. **Pin the model weights** (F7). Pass the commit shas listed in F7 as `revision=` in both loaders, defined as constants next to each server. Set `HF_HOME` only if the owner wants weights under `~/doomlearn`; otherwise keep the default cache and document the roughly 4.2 GB.
   - Drop the unused `s3gen_v3.safetensors` from any prefetch.
   - Replace the cache-mutating symlink trick with a loader that reads from the two snapshot dirs directly. This is a small change to the vendored code, so record the upstream sha in `vendor/chatterbox/README` or a comment.
   - Add a `prefetch` command (`hf download <repo> --revision <sha>` or a tiny Python entry) so that the first run's long download happens in setup and not in the middle of a job.
6. **Linux CI** (GitHub `ubuntu-latest`):
   - Node tests run on `fakeMedia` as they do now.
   - The Python job runs `uv lock --check` in each runtime plus `ruff`.
   - convert gets real pytest tests on fixture PDFs, since pymupdf4llm resolves on manylinux (F6).
   - tts and align get protocol tests only, through a `DOOMLEARN_FAKE_MODEL=1` path that skips the model load and echoes canned output. This exercises the handshake, the JSON framing and the stdout redirect without the weights.
   - Keep `DOOMLEARN_REAL_MEDIA` and `DOOMLEARN_SMOKE` for manual or Mac runs.
   - Put the unconditional real render test behind the same gate, or keep it in CI with `npx remotion browser ensure` and the apt list from F8.
7. **Mix with Remotion's bundled ffmpeg** (F8, verified: n7.1 has `amix`, `loudnorm` and `aac`). Locate it through the compositor package or `npx remotion ffmpeg`, so system ffmpeg leaves the prerequisites.
8. **Make the device configurable cheaply:** read `DOOMLEARN_TTS_DEVICE` (default `mps`) in `tts/server.py`. The universal lock already pulls CUDA torch on Linux (F6), so this is the smallest change toward a Linux backend. Document Linux as unsupported.

## Open questions
- Is the Mac minimum macOS 14 or later, which mlx needs (F6)? It should be stated in the README.
- Should weights live under `~/doomlearn/models` (via `HF_HOME`) so that a single data folder holds everything, or stay in the shared HF cache, which avoids re-downloading for owners who already have it?
- Does the Qwen3 aligner on Linux MLX (CPU or `mlx-cuda`) work at acceptable speed, or does a Linux backend need a different aligner (for example WhisperX or ctc-forced-aligner)? This is untested.
- Licensing of Remotion's bundled ffmpeg: the encoder list includes `libfdk_aac`. If we ship the mix through it, should we force `-c:a aac` (native) and record that in the license notes?
- Should the Remotion harness be its own package or part of `@doomlearn/media`? That depends on R-topic decisions about package boundaries.
- Does `ubuntu-latest` need the apt step from F8 in practice? Remotion's own GH Actions example has none, but I have not verified it.
