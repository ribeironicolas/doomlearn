## Agent skills

### Issue tracker

Issues and the wayfinder map live in GitHub Issues (`ribeironicolas/doomlearn`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Before asking or recommending

Most answers already exist. Before you ask the owner a question or recommend an option:

1. Read `GLOSSARY.md`, `docs/research/v2/`, the repo's issues including closed ones, and the git history.
2. A spec beats a subagent's choice.
3. Settle how an external tool behaves with a cheap check (a mock, a sandbox, `--help`) before you record it.
4. Never drop an option because of a preference you inferred.
5. Implementation details are your call. Log each one as "recommended" in the PR or ticket.

## Skill flow

`wayfinder → grilling → /to-spec → /to-tickets → /implement → code-review`, from [mattpocock/skills](https://github.com/mattpocock/skills). Paths are relative to the plugin root (Claude Code installs it at `~/.claude/plugins/marketplaces/mattpocock/`):

- wayfinder: `skills/engineering/wayfinder/SKILL.md`
- grilling: `skills/productivity/grilling/SKILL.md`
- to-spec: `skills/engineering/to-spec/SKILL.md`
- to-tickets: `skills/engineering/to-tickets/SKILL.md`
- implement: `skills/engineering/implement/SKILL.md`
- code-review: `skills/engineering/code-review/SKILL.md`

Subagents read the SKILL.md file directly.

## Project rules

- Issues, code, commits and docs are in English.
- Run commands yourself. A step only the owner can do states what, why and how long it takes, and offers a skip.
- When an acceptance criterion touches the Learner's data, back it up first, then do it, then report.
- Tests use recorded fixtures for claude and codex. Call the real CLI only when the ticket requires it, and then on the cheap test model (Codex `gpt-6-luna` at effort `low`).
- Stop background tasks once the goal is met, and say so.
- UI: before handing over any UI link or calling a UI ticket done, run `pnpm test:e2e`. It opens the PWA at 412x915, takes a screenshot and fails on any console error. Attach the screenshot to the PR.
- UI on a phone: run `apps/web/scripts/phone-check.ts` on the Android emulator (usage, the emulator recipe and the temp DOOMLEARN_HOME rule are in its header). Extend it; do not copy it.

## Contributor docs

[CONTRIBUTING.md](CONTRIBUTING.md) holds the scripts, the definition of a green PR, and the commit, branch and merge rules (the commit-msg hook rejects any other header). [docs/CODE_STYLE.md](docs/CODE_STYLE.md) holds the code, test and docs rules that code-review's Standards axis reads.

## Git workflow

- Squash-merge: one commit per PR, titled `type(scope): subject (#N)`.
- You may merge your own PR into `main` when CI is green and code-review found nothing blocking: `gh pr checks <PR> --watch --fail-fast`, then `gh pr merge --squash` only on exit 0. This covers only PRs you opened; `dependabot[bot]` PRs are the owner's.
- End every report with the git state: committed? pushed? PR link? merged?
- Once the owner approves a push, push without asking again.

## Parallel work

- Worktrees go under `.claude/worktrees/` (git ignores it).
- Install dependencies in each worktree first with `CI=true pnpm install`: it skips the hook install, and the hooks still run there. Install the hooks once with `pnpm lefthook install` from the primary checkout (the clone, not a worktree). `lefthook.yml` sets `no_auto_install`, so `lefthook run` never rewrites the shared hooks. `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: error`, so `pnpm run` and `pnpm exec` never install first: that install runs without `CI=true` and rewrites the shared hooks. A missing or stale `node_modules` (for example after a pull or rebase that changes the lockfile) stops every pnpm script, `pnpm start` and the commit hooks included, with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. pnpm then says `Run "pnpm install"`. In a worktree, run `CI=true pnpm install` instead. When `lefthook.yml` changes, run the one-time install again. [CONTRIBUTING](CONTRIBUTING.md#setup-on-any-os) says why.
- Only one branch at a time generates a drizzle migration. The others rebase and regenerate.
- Run typecheck and tests after each merge into `main`.
- Tickets that touch the same package run one after another.

## Operations

Running the app, logs, the data folder and phone access: [docs/OPS.md](docs/OPS.md).
