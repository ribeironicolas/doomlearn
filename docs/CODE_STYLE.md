# Code style

The rules a review applies to every PR. Each rule is tagged **lint** (Biome fails the PR on it) or **review** (a reviewer checks it). Package rules that only apply in one place live in that package's `AGENTS.md`, e.g. [packages/media/AGENTS.md](../packages/media/AGENTS.md).

## Format

- **lint** Biome formats everything: 2 spaces, double quotes, lines up to 120 characters. Run `pnpm exec biome check --write .`; the pre-commit hook does it on staged files.

## Think before coding

- **review** State your assumptions. When a request has more than one reading, name them instead of picking one silently.
- **review** Before you say how the codebase works, read it. A belief you did not check is a guess.

## Simplicity first

The least code that solves the problem.

- **review** No feature, option or configurability beyond what the issue asks for. No error handling for cases that cannot happen.
- **review** Inline by default. Extract a function only for reuse in 3 or more places, for a complex block that reads better under one name, or for a boundary that will change or needs its own test. "Might reuse it later" is not a reason.
- **review** Prefer a little duplication to the wrong abstraction.
- **review** Use a boolean or string-enum parameter for variants, not one function per variant, and not a ternary that picks which function to call.
- **review** Prepare each piece of data once, not in each branch.
- **review** If an abstraction adds lines or nesting, remove it.

## Surgical changes

Every changed line traces to the issue.

- **review** Do not refactor, reformat, rename or "improve" code, comments or formatting the issue does not need. Match the style around you.
- **review** Mention unrelated dead code or problems in the PR; do not fix them in it.
- **review** Remove the imports, variables and functions your change made unused (Biome warns on unused imports). Leave older dead code alone unless the issue asks.

## Comments

- **review** Every named function, class, method and const-assigned arrow function has a JSDoc block. Tests, inline callbacks and property arrows are exempt.
- **review** A JSDoc of more than 5 words is multi-line (`/**`, text, ` */` on their own lines).
- **review** Use `//` for comments in code, and `//` section comments (`//`, the title, `//` on three lines) for sections, never `// ──` separators.
- **review** Comments explain complex logic or a decision. Do not remove a comment unless it is wrong or misleading.

## Constants

- **lint** No magic numbers (Biome `noMagicNumbers`). 0, 1, 2, 10, 24, 60, array indexes, values inside an options object and default parameter values are exempt, and so are tests and the device scripts under `apps/web/scripts/`.
- **review** A value used once gets a comment, not a constant, unless the lint rule asks for one.
- **review** Group related constants in one object: `STATUS.notFound`, not `NOT_FOUND`.
- **review** In a file built around one class, its constants and helpers are `private readonly` ALL_CAPS members and member functions.
- **review** A constant shared by such a class and other code goes into the package's `util.ts`, or a `.constant.ts` file.

## Tests

- **review** Write a test only where it can fail. A test that passes by construction (recomputing the expected value the way the code does) is not a test.
- **review** Test behaviour through the public interface, not internals. One fake per boundary: the Agent and Media ports have fakes in `packages/core/src/test/fakes.ts`.
- **review** Use a real SQLite database (a temp data folder) for numbers and orderings.
- **review** Every bug fix comes with a test that failed before the fix.
- **review** An e2e spec owns its rows: it creates the data it reads.
- **review** Tests use recorded outputs for `claude` and `codex`. A test that calls a real CLI, or real media, is opt-in through an env var and is skipped in CI; on Codex it uses `gpt-6-luna` at effort `low`.

## Docs

- **review** Write in Simplified Technical English: short sentences, one instruction per sentence, the active voice.
- **review** Every fact has one home. Link to it instead of repeating it.
- **review** Never point at a planning document from code or user docs; state the fact.
- **review** Use the domain terms in [GLOSSARY.md](../GLOSSARY.md), and none of their _Avoid_ words.
