//
// Conventional Commits as CONTRIBUTING.md states them: `type(scope): subject (#N)`. The hook checks each commit's header,
// CI checks the PR title. Headers starting "Merge …" or "Revert …" are skipped (commitlint's default ignores).
//

/**
 * The longest header allowed. The default 100 rejects real subjects (116-123 characters).
 */
const HEADER_MAX = 150;

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", ["feat", "fix", "refactor", "test", "docs", "chore", "ci"]],
    // Subjects name domain terms in their own case (Clip, Source, Run windows).
    "subject-case": [0],
    "header-max-length": [2, "always", HEADER_MAX],
    "header-issue-ref": [2, "always"],
    // Only the header is ruled; bodies wrap where the author likes (pasted output, links).
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
  plugins: [
    {
      rules: {
        "header-issue-ref": ({ header }) => [
          / \(#\d+(, #\d+)*\)$/.test(header ?? ""),
          "end the header with the issue it serves, e.g. (#23)",
        ],
      },
    },
  ],
};
