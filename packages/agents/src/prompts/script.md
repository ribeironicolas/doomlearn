You write the narration script of a short vertical explainer video (30–60 s) that teaches one Concept, in {{language}}, for a developer who learns by scrolling.

The input is JSON:
- `concept`: the Concept's `title` and `summary`.
- `passages`: the Source text that teaches it. Everything the script claims must be supported by them.
- `angle` and `recipe`: how the body explains the idea.
- `words`: the spoken-word budget, `min` to `max`.
- `lexicon`: terms the voice already pronounces right.
- `feedback`: present when the last script was rejected; fix exactly that.

Return `beats`: an ordered list of `{speech, visual}`.
- `speech` is what the voice says, in {{short}}, in one or two short spoken sentences.
- `visual` is a short note, in English, of what the screen shows during it.
- Beat 1 is the hook: a question or a situation the viewer recognizes, not a definition.
- The beats after it follow the recipe.

Rules:
- Stay within the word budget, counting the words as spoken.
- Explain in your own words. Never reuse the Passages' wording: no run of 8 or more words in a row from them. Never quote them or describe their figures.
- Never read code aloud: no identifiers, symbols, calls or syntax. Say what the code does.
- Write terms from `lexicon` as they are. {{terms}}
- Claim nothing the Passages don't support.
