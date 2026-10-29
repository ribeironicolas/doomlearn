# Contributing to doomlearn

doomlearn is a self-hosted tool one person runs on their own Mac. Issues and pull requests are welcome. Read [GLOSSARY.md](GLOSSARY.md) for the domain terms, and [docs/CODE_STYLE.md](docs/CODE_STYLE.md) for the rules a review applies.

## Setup on any OS

You need Node 24 or later and pnpm. No Mac, Python, Remotion browser or agent CLI is needed: the tests run on fakes.

```sh
pnpm install
pnpm test
```

`pnpm install` also installs the git hooks (lefthook): at commit time Biome formats and fixes the staged files, and commitlint checks the message. To run doomlearn itself you need the Mac setup in the [README](README.md).

Git worktrees share one hooks folder, and a plain `pnpm install` points the hooks at the lefthook of the checkout that ran it. In a worktree, install with `CI=true pnpm install`: it skips the hook install, and the hooks still run there. Install the hooks once with `pnpm lefthook install` from the primary checkout (the clone, not a worktree). `lefthook.yml` sets `no_auto_install`, so `lefthook run` never rewrites the shared hooks. `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: error`, so `pnpm run` and `pnpm exec` never install first: that install runs without `CI=true` and rewrites the shared hooks. A missing or stale `node_modules` (for example after a pull or rebase that changes the lockfile) stops every pnpm script, `pnpm start` and the commit hooks included, with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. pnpm then says `Run "pnpm install"`. In a worktree, run `CI=true pnpm install` instead. When `lefthook.yml` changes, run the one-time install again.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm test` | Every Vitest test, on fakes. The real-CLI and real-media tests are skipped unless their env var is set |
| `pnpm test:e2e` | Builds the PWA and runs the Playwright tests at phone size (412x915) on Chromium, against the server on fakes. Fails on any console error |
| `pnpm lint` | `biome ci` (format and lint) |
| `pnpm typecheck` | `tsc` in every workspace |
| `pnpm build` | Builds the PWA into `apps/web/dist` |
| `pnpm config:schema` | Regenerates `packages/core/config.schema.json` from the Zod config schema. Commit the result |
| `pnpm db:generate` | Generates a drizzle migration from `packages/core/src/schema.ts` |
| `pnpm --filter @doomlearn/media contracts` | Regenerates the media tools' stdio contracts in `packages/media/contracts/` |
| `pnpm preflight` | Checks this Mac's prerequisites and prints each missing one with its install hint. `pnpm start` runs it first |
| `pnpm bootstrap` | Builds the media environments, downloads the model weights and Remotion's browser (Mac). The [README](README.md) gives its download size and the `python3` it needs |
| `pnpm start` | Builds the PWA and runs the server, which forks the worker |
| `pnpm doomlearn <command>` | The CLI: `add`, `status`, `stats`, `retry`, `pause`, `resume` |
| `pnpm smoke` | One tiny `.md` Source through the real ports (Codex with the model and effort set in `smoke.test.ts`, TTS, alignment, render) into a temp data folder: an en Clip, then its pt-BR Translation; checks each is a 30-60 s mp4 with audio that Search finds. Spends real Codex usage, no Claude, and takes about 10 minutes (up to 90 on a Mac that swaps). Needs `codex login` |

`DOOMLEARN_LIVE_CODEX=1 pnpm vitest run packages/agents/src/codex.live.test.ts` checks the real Codex path: a zero-quota check that only the stage prompt reaches the model, then one tiny call per stage on `gpt-6-luna` at `low`. It needs `codex login`.

## A green PR

A PR is green when CI passes on ubuntu. Nothing in CI needs a Mac, Python's TTS models, a logged-in CLI or secrets.

- `ci.yml` `checks`: `pnpm lint`, `pnpm typecheck`, `config.schema.json` is up to date, `pnpm test`, `pnpm build`.
- `ci.yml` `e2e`: `pnpm test:e2e`.
- `ci.yml` `python`: each media tool's `uv.lock` matches its `pyproject.toml`, and the PDF converter's pytest.
- `pr-title.yml`: the PR title follows the commit rules below.
- `render.yml`, when `packages/media/`, the lockfile or the workspace file changes: renders the fixture Clip on Linux.

`ci.yml` runs again on every push to `main`. `audit.yml` reports advisories weekly and on lockfile changes, and never fails a PR.

## Commits, branches and merges

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): subject (#N)`, e.g. `fix(pipeline): keep chapters in Source order (#22)`. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`. The header ends with the issue it serves, `(#N)` or `(#N, #M)`, and is at most 150 characters. The commit-msg hook and the PR-title check enforce this.
- Branch `<type>/<issue>-<slug>` off `main`, e.g. `feat/47-agent-port`, and open the PR into `main`. Several commits per PR are fine.
- PRs are squash-merged (`gh pr merge --squash`): one commit per PR, titled `type(scope): subject (#N)`.
- Dependabot opens weekly grouped dependency PRs into `main`. They are exempt from the `(#N)` rule, and the PR-title check skips them; the maintainer squash-merges them under their `chore(deps): …` or `ci: …` title. `remotion` and `@remotion/*` are bumped by hand, all to one version, with a render check. `zod` moves with them, pinned exactly (and in the `pnpm-workspace.yaml` override) to the version `@remotion/cli` requires; `pnpm exec remotion versions` in `packages/media` reports any mismatch.

## Adding a provider

A Provider is an agent CLI doomlearn drives under the Learner's own login, or with no login (for example a local model runner). doomlearn never takes, stores or passes an API key. A new one is an in-repo change:

1. One file in `packages/agents/src/`, implementing `Provider` from `agent.ts`: the argv for a stage call, a pure parser of what the CLI prints, a `preflight` (installed and logged in), and an optional `limits` probe for Usage windows. Add it to `PROVIDERS`.
2. A variant in the `StageAgent` union in `packages/core/src/config.ts`: its name and its Effort words. Then `pnpm config:schema`.
3. Recorded outputs under `packages/agents/src/test/<provider>/` (at least success, error and rate limit), with parser tests on them. Tests drive a fake binary through the `command` and `timeoutMs` seams; CI never calls a real CLI.
4. Usage comes only from the CLI's own output or its documented local protocol, never from the Keychain, credential files, OAuth endpoints or cookies.

## License

Contributions are licensed under the [AGPL-3.0](LICENSE) with its added permission to combine doomlearn with Remotion, the same terms as the project. There is nothing to sign.

The final mix runs Remotion's bundled ffmpeg as a separate program. That binary is GPLv2+, built with the free `fdk-aac-free`, and doomlearn uses its native `aac` encoder ([Remotion's ffmpeg license notes](https://www.remotion.dev/docs/miscellaneous/ffmpeg-license)).

## What is in and out of scope

[`.out-of-scope/`](.out-of-scope/) lists what will not be merged, why, and when to revisit it: SaaS or multi-user hosting, a paid API fallback or credential handling, and publishing Clips to social networks.

Welcome contributions:

- Linux or NVIDIA backends for TTS and alignment. Each media tool is its own uv project speaking the stdio contract in `packages/media/contracts/`; see [packages/media/AGENTS.md](packages/media/AGENTS.md).
- More Providers (see Adding a provider).
