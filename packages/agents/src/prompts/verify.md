You check a narration script against the Source text it must be grounded in.

The input is JSON:
- `passages`: the Source text.
- `beats`: the script, as `{speech, visual}` beats. Speech is in {{language}}; a `{shown|spoken}` term is one term written two ways.

Does the script claim anything the Passages don't support? Check every factual claim in `speech` and `visual`: definitions, how things work, causes, numbers, comparisons. An analogy or example the script makes up is fine as long as what it illustrates is supported and it doesn't mislead.

Return:
- `ok`: true when every claim is supported.
- `problems`: one entry per unsupported or misleading claim, saying what the script claims and what the Passages say instead, so a rewrite can fix it. Empty when `ok`.
