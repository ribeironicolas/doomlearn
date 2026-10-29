import assert from "node:assert/strict";
import { test } from "vitest";
import type { Beat } from "./agent.ts";
import { LANGUAGES } from "./languages.ts";
import { checkScript, newTerms } from "./script.ts";

/**
 * The pt-BR word budget, 85-175, which these tests are written for.
 */
const BUDGET = LANGUAGES["pt-BR"].words;

/**
 * A script of `count` spoken words, one beat per 10 words.
 */
function words(count: number): Beat[] {
  const all = Array.from({ length: count }, (_, i) => `palavra${i}`);
  return Array.from({ length: Math.ceil(count / 10) }, (_, i) => ({
    speech: all.slice(i * 10, i * 10 + 10).join(" "),
    visual: "v",
  }));
}

const PASSAGE = "A thread is one sequence of execution inside a process, and every process starts with one.";

test("a script within 85–175 spoken words that neither copies nor reads code passes", () => {
  assert.deepEqual(checkScript(words(85), [PASSAGE], BUDGET), { problems: [], tooLong: false });
  assert.deepEqual(checkScript(words(175), [PASSAGE], BUDGET), { problems: [], tooLong: false });
});

test("a script over 175 spoken words is too long, and one under 85 too short", () => {
  assert.deepEqual(checkScript(words(176), [PASSAGE], BUDGET), {
    problems: ["176 spoken words, cut to at most 175"],
    tooLong: true,
  });
  assert.deepEqual(checkScript(words(84), [PASSAGE], BUDGET), {
    problems: ["84 spoken words, write at least 85"],
    tooLong: false,
  });
});

test("words are counted as spoken, so a {shown|spoken} term counts its spoken words", () => {
  const beats = words(84);
  beats[0].speech += " {GC|gê cê}";
  assert.deepEqual(checkScript(beats, [PASSAGE], BUDGET).problems, []);
});

test("a run of 8 consecutive words from a Passage is rejected, ignoring case and punctuation", () => {
  const beats = words(80);
  beats.push({ speech: "Then: ONE sequence of execution inside a process, and done.", visual: "v" });
  assert.deepEqual(checkScript(beats, ["Unrelated.", PASSAGE], BUDGET).problems, [
    'copies "one sequence of execution inside a process and" from a Passage, say it in your own words',
  ]);

  const seven = words(80);
  seven.push({ speech: "Then one sequence of execution inside a car.", visual: "v" });
  assert.deepEqual(checkScript(seven, [PASSAGE], BUDGET).problems, []);
});

test("code read aloud is rejected, but not inside the shown half of a {shown|spoken} term", () => {
  const beats = words(85);
  beats.push({ speech: "Chame getUser(id) e depois x = 2; ou use `map`, user_id, list[0], obj.field.", visual: "v" });
  assert.deepEqual(checkScript(beats, [PASSAGE], BUDGET).problems, [
    "reads code aloud: getUser(id), =, 2;, `map`,, user_id,, list[0],, obj.field., describe what it does instead",
  ]);

  const shown = words(85);
  shown[0].speech += " {malloc()|maloque}";
  assert.deepEqual(checkScript(shown, [PASSAGE], BUDGET).problems, []);
});

test("a new term written in two capitalizations is one new term, under its first spelling", () => {
  const beats = [
    { speech: "Um {docstring|dóc istrím} explica.", visual: "v" },
    { speech: "O {Docstring|dóc istrím} fica no topo.", visual: "v" },
  ];
  assert.deepEqual(newTerms(beats, {}), { docstring: "dóc istrím" });
});
