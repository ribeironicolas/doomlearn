import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { Beat } from "./agent.ts";
import { defaultLexicon } from "./languages.ts";
import { narrate } from "./narration.ts";
import { fakeMedia } from "./test/fakes.ts";

/**
 * The repo's default lexicon, which a new data folder starts from.
 */
const LEXICON = JSON.parse(readFileSync(defaultLexicon("pt-BR"), "utf8"));

/**
 * The "what is a thread" script from the voice prototype, as beats.
 */
const THREAD: Beat[] = [
  {
    speech: "Sabe quando o seu app congela enquanto baixa um arquivo? É porque ele está fazendo tudo numa thread só.",
    visual: "frozen app",
  },
  { speech: "Uma thread é uma linha de execução dentro de um processo.", visual: "process box" },
  { speech: "Um processo pode ter várias threads, e todas compartilham a mesma memória.", visual: "shared memory" },
  {
    speech: "Enquanto uma thread espera a resposta de uma API, outra continua desenhando a tela.",
    visual: "two lanes",
  },
  { speech: "A CPU alterna entre elas tão rápido que parece que tudo roda ao mesmo tempo.", visual: "cpu switching" },
  {
    speech:
      "Mas memória compartilhada cobra um preço: se duas threads mexem no mesmo dado juntas, nasce uma race condition.",
    visual: "collision",
  },
  { speech: "Por isso existe o mutex, uma trava que deixa só uma thread entrar por vez.", visual: "lock" },
];

function shownWords(beats: Beat[]) {
  return beats.map((beat) => beat.speech).join(" ");
}

test("the voice says lexicon respellings while timings carry the shown spellings", async () => {
  const media = fakeMedia();
  const spoken: string[] = [];
  const narration = await narrate(
    {
      ...media,
      speak: (text, out, language) => {
        spoken.push(text);
        return media.speak(text, out, language);
      },
    },
    THREAD,
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    LEXICON,
    "pt-BR",
  );

  assert.match(spoken[0], /numa tréd só\. Uma tréd é/);
  assert.match(spoken[0], /várias tréds,/);
  assert.match(spoken[0], /de uma a pê í, outra/);
  assert.match(spoken[0], /A cê pê ú alterna/);
  assert.match(spoken[0], /nasce uma rei si condíchon\./);
  assert.match(spoken[0], /o mútecs,/);
  assert.match(spoken[0], /seu ép congela/);
  assert.doesNotMatch(spoken[0], /thread|API|CPU|mutex|race/);

  assert.equal(narration.words.map((word) => word.word).join(" "), shownWords(THREAD));
  const race = narration.words.find((word) => word.word === "race condition.");
  assert.ok(race);
  // "rei si condíchon" is three aligner words; the shown term spans all of them.
  const aligned = await media.align("", spoken[0], "pt-BR");
  const at = aligned.findIndex((word) => word.word === "rei");
  assert.deepEqual([race.startMs, race.endMs], [aligned[at].startMs, aligned[at + 2].endMs]);
});

test("a script's own {shown|spoken} term is spoken as written and shown without its markup", async () => {
  const media = fakeMedia();
  const spoken: string[] = [];
  const narration = await narrate(
    {
      ...media,
      speak: (text, out, language) => {
        spoken.push(text);
        return media.speak(text, out, language);
      },
    },
    [{ speech: "O {garbage collector|gár bitch colétor}, numa thread, libera memória.", visual: "gc" }],
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    LEXICON,
    "pt-BR",
  );

  assert.equal(spoken[0], "O gár bitch colétor, numa tréd, libera memória.");
  assert.deepEqual(
    narration.words.map((word) => word.word),
    ["O", "garbage collector,", "numa", "thread,", "libera", "memória."],
  );
});

test("an aligner word list that differs from the spoken words redoes the TTS exactly once", async () => {
  const media = fakeMedia();
  let speaks = 0;
  let aligns = 0;
  const narration = await narrate(
    {
      ...media,
      speak: (text, out, language) => {
        speaks++;
        return media.speak(text, out, language);
      },
      // The first alignment drops a word.
      align: async (audio, text, language) =>
        aligns++ ? media.align(audio, text, language) : (await media.align(audio, text, language)).slice(1),
    },
    THREAD,
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    LEXICON,
    "pt-BR",
  );

  assert.equal(speaks, 2);
  assert.equal(narration.words.map((word) => word.word).join(" "), shownWords(THREAD));
});

test("a second aligner mismatch fails the narration instead of redoing again", async () => {
  const media = fakeMedia();
  let speaks = 0;
  await assert.rejects(
    narrate(
      {
        ...media,
        speak: (text, out, language) => {
          speaks++;
          return media.speak(text, out, language);
        },
        align: async (audio, text, language) => (await media.align(audio, text, language)).slice(1),
      },
      THREAD,
      await mkdtemp(join(tmpdir(), "doomlearn-")),
      LEXICON,
      "pt-BR",
    ),
  );
  assert.equal(speaks, 2);
});

test("each beat spans its own words, even when a beat says a multi-word lexicon term in plain text", async () => {
  // "race condition" is one shown Word over three spoken words, so counting the speech's words gives one too many.
  const narration = await narrate(
    fakeMedia(),
    [
      { speech: "Duas threads mexem no mesmo dado.", visual: "two threads" },
      { speech: "Isso é uma race condition.", visual: "collision" },
    ],
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    LEXICON,
    "pt-BR",
  );

  // The fake aligner times spoken word i at 400i–400i+300 ms: beat 1 is words 0–5, beat 2 is "Isso é uma rei si condíchon." (6–11).
  assert.deepEqual(narration.beats, [
    { startMs: 0, endMs: 2300 },
    { startMs: 2400, endMs: 4700 },
  ]);
  assert.equal(narration.beats.at(-1)!.endMs, narration.words.at(-1)!.endMs);
  // The speech has 11 words but the narration 10 Words, the mismatch that made the old per-beat recount overrun.
  assert.equal(narration.words.length, 10);
});

test("a beat with no spoken word of its own fails the narration before any TTS", async () => {
  let speaks = 0;
  const media = fakeMedia();
  await assert.rejects(
    narrate(
      {
        ...media,
        speak: (text, out, language) => {
          speaks++;
          return media.speak(text, out, language);
        },
      },
      [
        { speech: "Duas threads mexem no mesmo dado.", visual: "two threads" },
        { speech: "—", visual: "a pause" },
      ],
      await mkdtemp(join(tmpdir(), "doomlearn-")),
      LEXICON,
      "pt-BR",
    ),
    new Error("Beat 2 has no spoken word of its own to time"),
  );
  assert.equal(speaks, 0);
});

test.each([
  ["an exact match", { makefile: "mêiqui fáiou" }],
  ["a match in another capitalization", { Makefile: "mêiqui fáiou" }],
])(
  "a Lexicon entry beats the script's own Respelling of a term on %s, and the caption keeps the shown text",
  async (_, lexicon) => {
    const media = fakeMedia();
    const narration = await narrate(
      media,
      [{ speech: "Rode o {makefile|mêik fáiu}, e o makefile compila.", visual: "make" }],
      await mkdtemp(join(tmpdir(), "doomlearn-")),
      lexicon,
      "pt-BR",
    );

    assert.deepEqual(media.spoken, [{ text: "Rode o mêiqui fáiou, e o mêiqui fáiou compila.", language: "pt-BR" }]);
    assert.deepEqual(
      narration.words.map((word) => word.word),
      ["Rode", "o", "makefile,", "e", "o", "makefile", "compila."],
    );
  },
);

test("a Lexicon key that matches only part of a script's multi-word term leaves its Respelling", async () => {
  const media = fakeMedia();
  await narrate(
    media,
    [{ speech: "Abra um {pull request|pul riquést} hoje.", visual: "pr" }],
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    { request: "riquéchte" },
    "pt-BR",
  );

  assert.deepEqual(media.spoken, [{ text: "Abra um pul riquést hoje.", language: "pt-BR" }]);
});

test("a multi-word Lexicon term matches across the punctuation inside it, keeping the punctuation around it", async () => {
  const media = fakeMedia();
  await narrate(
    media,
    [{ speech: "Ele segue uma receita, passo a passo, do começo.", visual: "cook" }],
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    { "receita passo": "rêceita pásso", "passo do": "pásso dô" },
    "pt-BR",
  );

  assert.deepEqual(media.spoken, [{ text: "Ele segue uma rêceita pásso a pásso dô começo.", language: "pt-BR" }]);
});

test("a multi-word Lexicon term over a script's own {shown|spoken} term does not match: the script's Respelling stays", async () => {
  const media = fakeMedia();
  await narrate(
    media,
    [{ speech: "Ele segue uma {receita|rêssêita}, passo a passo.", visual: "cook" }],
    await mkdtemp(join(tmpdir(), "doomlearn-")),
    { "uma receita": "ûma rêceita" },
    "pt-BR",
  );

  assert.deepEqual(media.spoken, [{ text: "Ele segue uma rêssêita, passo a passo.", language: "pt-BR" }]);
});
