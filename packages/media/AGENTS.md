# @doomlearn/media

The local Media port: conversion (`src/convert.ts`, `python/convert/`), TTS and alignment (`src/local-media.ts`, `python/tts/`, `python/align/`), and the render and final mix (`src/render.ts`, `remotion/`, `vendor/explainroo/`).

## Remotion rules

- `src/render.ts` copies `remotion/` and the agent's Scene into a job folder outside the workspace, then bundles it. The bundle resolves packages from this package's own `node_modules` (`webpackOverride` in `render.ts`). Keep `render.ts` and `remotion/` in this package, and never point that path at the root `node_modules`: under pnpm the root holds only `.pnpm/`, so the bundle fails with `Can't resolve '@remotion/media'`.
- Every package the harness or a Scene imports is a **direct** dependency of `@doomlearn/media`. No `public-hoist-pattern` and no `shamefully-hoist`.
- `remotion/api.md` is the scene stage's system prompt. `@doomlearn/agents` reads it through the `./scene-api.md` export. It is a template: `renderPrompt` in `@doomlearn/agents` replaces `{{language}}`, and a change to it changes the golden copy `packages/agents/src/test/prompts/scene.pt-BR.md`. It lists only packages that are direct dependencies here: check it against `package.json` when either changes.
- `remotion` and every `@remotion/*` package, `@remotion/cli` included, are pinned exactly to one version. Upgrade them together.
- No system ffmpeg. Mix and probe go through `REMOTION` from `src/render.ts` (`remotion ffmpeg …`, `remotion ffprobe …`). Do not exec the compositor's ffmpeg binary directly: it needs the library path the CLI sets.
- The bundled ffmpeg allowlists its filters and encoders. It has `amix`, `loudnorm` and `volume`, but not `ebur128`, so loudness is measured with `loudnorm=print_format=json`, and a null output needs an explicit codec (`-c:a pcm_s16le`). Keep `-c:a aac` explicit: it picks ffmpeg's native encoder.
- The render test runs in CI's `render` workflow on ubuntu-24.04. Chrome Headless Shell is cached under `node_modules/.remotion`. If the run fails with `libnspr4.so: cannot open shared object file`, uncomment the apt step in `.github/workflows/render.yml`.

## Python tool rules

- Each tool (`python/tts`, `python/align`, `python/convert`) is an independent uv project with its own `uv.lock` and `.venv`; they cannot share one (tts pins transformers 5.2, mlx-audio needs 5.14+). Change a dependency in its `pyproject.toml`, then `.uv/bin/uv lock --project python/<tool>` and commit the lock. CI runs `uv lock --check` on each.
- `pnpm bootstrap` (`bootstrap.sh`) is the only thing that installs: the repo-local uv in `.uv/` (pinned in `python/requirements-uv.txt`), a locked sync per tool, the pinned weights (`weights.py`) and Remotion's browser. Nothing installs on start: `mediaPreflight` in `src/tools.ts` only checks. A failure blocks the worker, except a missing voice (`voiceless`), which holds back only the jobs in its Language.
- Every tool runs on uv's own CPython 3.12 (`python-preference = "only-managed"` in its `pyproject.toml`), never a Homebrew or system Python, so each Mac gets the same interpreter and a `brew upgrade` cannot swap it. The system `python3` only installs uv. A venv built on another interpreter fails the media preflight as outdated, and `pnpm bootstrap` rebuilds it.
- Node spawns `python/<tool>/.venv/bin/python` directly, never `uv run`, through the runtime table in `src/tools.ts`. A new backend (say `python/tts-cuda/`) is its own uv project speaking the same contract plus a branch in that table; no config key, no env var.
- The stdio contracts are the Zod schemas in `src/contracts.ts`, and Node parses every line through them. After changing one, run `pnpm --filter @doomlearn/media contracts` to regenerate `contracts/*.json`; a test fails while they are stale.
- Weights are pinned to commit shas in each tool's `weights.py`, in the default HF cache. Bump a sha only after listening to the result.
