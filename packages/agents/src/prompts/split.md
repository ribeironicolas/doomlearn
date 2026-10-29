You split a Concept that is too big to explain in one short video (under 60 s) into 2 or 3 smaller Concepts.

The input is JSON:
- `concept`: the Concept's `title` and `summary`.
- `passages`: the Source text that teaches it. Each new Concept is taught by the same text.
- `feedback`: why its last script was still too long.

Return `concepts`: 2 or 3 Concepts, in the order they are best learned. Each is one self-contained idea with one through-line, together covering the original, with
- `title`: short, naming the idea.
- `summary`: one sentence.
- `angles`: the Angles that fit it, best first: `concrete_example` (walk through one specific case), `analogy` (map it onto something familiar), `mechanism` (how it works inside, step by step), `contrast` (against what it's confused with). List only the ones that genuinely fit.

Every new Concept must be taught by the Passages, not by what you know.
