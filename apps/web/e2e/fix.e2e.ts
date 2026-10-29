import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { Data } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { LANGUAGE_TAGS } from "@doomlearn/core/languages";
import { createPronunciation } from "@doomlearn/core/pronunciation";
import { clips, jobs } from "@doomlearn/core/schema";
import { publishLiveness, publishStage } from "@doomlearn/core/status";
import { fakeMedia } from "@doomlearn/core/test/fakes";
import { expect, test } from "./fixtures.ts";

//
// Fixing a pronunciation from the Inbox: the fix sheet, its preview states, and Save.
//

/**
 * Flags the first Clip 🚩 Pronunciation with a note and the second 🚩 Wrong caption, then opens the Inbox.
 */
async function openInbox(page: Page, data: Data) {
  const feed = createFeed(data);
  feed.press(1, "flag", "e2e-pronunciation", { reason: "Pronunciation", note: "cozinheiro sounds wrong" });
  feed.press(2, "flag", "e2e-caption", { reason: "Wrong caption" });
  await page.goto("/inbox");
}

/** The fix sheet. */
const sheet = (page: Page) => page.getByTestId("fix-sheet");
/**
 * The first word `text` of the script on the sheet.
 */
const word = (page: Page, text: string) => sheet(page).getByRole("button", { name: text, exact: true }).first();
/** A fix row's sound field. */
const sound = (page: Page, term: string) => sheet(page).getByLabel(`Sound of “${term}”`);

/**
 * Opens the fix sheet of the 🚩 Pronunciation item.
 */
async function openSheet(page: Page, data: Data) {
  await openInbox(page, data);
  await page.getByRole("button", { name: "🗣️ Fix pronunciation" }).click();
  await expect(sheet(page)).toBeVisible();
}

test("Fix pronunciation shows only on 🚩 Pronunciation items; a word and its neighbour are picked together, with what the voice says now", async ({
  page,
  server,
}) => {
  await openInbox(page, server.data);
  await expect(page.getByRole("button", { name: "🗣️ Fix pronunciation" })).toHaveCount(1);
  const caption = page.getByTestId("flag").filter({ hasText: "Wrong caption" });
  await expect(caption.getByRole("button", { name: "↻ Regenerate" })).toBeVisible();
  await expect(caption.getByRole("button", { name: "🗣️ Fix pronunciation" })).toHaveCount(0);

  await page.getByRole("button", { name: "🗣️ Fix pronunciation" }).click();
  await expect(sheet(page)).toContainText("cozinheiro sounds wrong");

  // The Lexicon says "thread" as tréd.
  await word(page, "thread").click();
  await expect(sound(page, "thread")).toHaveValue("tréd");
  await word(page, "é").click();
  await expect(sound(page, "thread é")).toHaveValue("tréd é");
  await expect(word(page, "thread")).toHaveAttribute("aria-pressed", "true");
  await expect(word(page, "é")).toHaveAttribute("aria-pressed", "true");

  // A word further on starts a second fix.
  await word(page, "cozinheiro").click();
  await expect(sound(page, "cozinheiro")).toHaveValue("cozinheiro");
  await expect(sound(page, "thread é")).toHaveValue("tréd é");
  await page.screenshot({ path: test.info().outputPath("fix-sheet.png") });
});

test("a word of a multi-word Lexicon term picks the whole term; a script's own Respelling never joins a longer fix", async ({
  page,
  server,
}) => {
  const { data } = server;
  const lexicon = data.lexiconFile("pt-BR");
  await writeFile(
    lexicon,
    JSON.stringify({ ...JSON.parse(await readFile(lexicon, "utf8")), "passo a passo": "pásso a pásso" }),
  );
  const { script } = data.db.select({ script: clips.script }).from(clips).where(eq(clips.id, 1)).get()!;
  data.db
    .update(clips)
    .set({ script: script.replace("um cozinheiro", "um {cozinheiro|kuzinhêro}") })
    .where(eq(clips.id, 1))
    .run();
  await openSheet(page, data);

  await word(page, "a").click();
  await expect(sound(page, "passo a passo")).toHaveValue("pásso a pásso");
  await expect(word(page, "passo,")).toHaveAttribute("aria-pressed", "true");

  // The script's own Respelling, then the word after it: two fixes.
  await word(page, "cozinheiro").click();
  await word(page, "numa").click();
  await expect(sound(page, "cozinheiro")).toHaveValue("kuzinhêro");
  await expect(sound(page, "numa")).toHaveValue("numa");
});

test("the preview waits for the worker's step, loads the voice, speaks and plays; a stopped worker shows its Blocker", async ({
  page,
  server,
}) => {
  await openSheet(page, server.data);
  await word(page, "cozinheiro").click();
  await sound(page, "cozinheiro").fill("kuzinhêro");

  publishStage(server.data, { jobId: 1, stage: "narration", startedAt: new Date() });
  await sheet(page).getByRole("button", { name: "▶ Preview" }).click();
  await expect(sheet(page)).toContainText("Waiting for the worker to finish a step");
  publishStage(server.data, null);
  await expect(sheet(page)).toContainText("Speaking…");

  // The worker takes it, first loading the voice, and the TTS answers once released.
  const media = fakeMedia();
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const served = createPronunciation(server.data).serve(
    {
      ...media,
      speak: async (text, out, language) => {
        await released;
        return media.speak(text, out, language);
      },
    },
    { languages: LANGUAGE_TAGS, held: () => undefined, loading: () => true },
  );
  await expect(sheet(page)).toContainText("Loading the Portuguese voice");
  release();
  await served;

  const audio = sheet(page).locator("audio");
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime > 0)).toBe(true);
  expect(media.spoken).toEqual([
    {
      text: "Uma tréd é como um kuzinhêro numa cozinha que segue uma receita, passo a passo, do começo ao fim.",
      language: "pt-BR",
    },
  ]);
  await page.screenshot({ path: test.info().outputPath("fix-preview.png") });

  publishLiveness(server.data, { liveness: "stopped", exitReason: "worker exited with code 1" });
  await sheet(page).getByRole("button", { name: "▶ Preview" }).click();
  await expect(sheet(page)).toContainText("worker exited with code 1");
  await expect(sheet(page).getByRole("button", { name: "▶ Preview" })).toBeEnabled();
});

test("Save writes a fix the Learner left unchanged, so a script's own Respelling becomes a Lexicon entry", async ({
  page,
  server,
}) => {
  const { data } = server;
  const { script } = data.db.select({ script: clips.script }).from(clips).where(eq(clips.id, 1)).get()!;
  data.db
    .update(clips)
    .set({ script: script.replace("um cozinheiro", "um {cozinheiro|kuzinhêro}") })
    .where(eq(clips.id, 1))
    .run();
  await openSheet(page, data);
  const save = sheet(page).getByRole("button", { name: "Save and regenerate" });
  await expect(save).toBeDisabled();
  await word(page, "cozinheiro").click();
  await expect(sound(page, "cozinheiro")).toHaveValue("kuzinhêro");
  await save.click();
  await expect(sheet(page)).toBeHidden();
  expect(JSON.parse(await readFile(data.lexiconFile("pt-BR"), "utf8")).cozinheiro).toBe("kuzinhêro");
});

test("a fix of only punctuation can be neither previewed nor saved", async ({ page, server }) => {
  const { data } = server;
  // A dash that starts the script is a chunk of its own: there is no word before it to be shown with.
  const { script } = data.db.select({ script: clips.script }).from(clips).where(eq(clips.id, 1)).get()!;
  data.db
    .update(clips)
    .set({ script: script.replace("Já pensou", "— Já pensou") })
    .where(eq(clips.id, 1))
    .run();
  await openSheet(page, data);
  await word(page, "—").click();
  await sound(page, "").fill("traço");
  await expect(sheet(page).getByRole("button", { name: "▶ Preview" })).toBeDisabled();
  await expect(sheet(page).getByRole("button", { name: "Save and regenerate" })).toBeDisabled();
});

test.describe("when the Mac refuses without a message", () => {
  // A refusal with no `error` field (a validator 400, a bodyless 5xx): Chromium logs the refused request.
  test.use({ expectedErrors: /Failed to load resource.*400/ });

  test("the preview shows the refused path and status, not Mac unreachable", async ({ page, server }) => {
    await page.route("**/api/preview", (route) => route.fulfill({ status: 400, body: "{}" }));
    await openSheet(page, server.data);
    await word(page, "thread").click();
    await sheet(page).getByRole("button", { name: "▶ Preview" }).click();
    await expect(sheet(page)).toContainText("/api/preview: 400");
    await expect(sheet(page)).not.toContainText("Mac unreachable");
  });
});

test.describe("with a broken Lexicon file", () => {
  // The Mac refuses with 409 while the file is broken: Chromium logs the refused request.
  test.use({ expectedErrors: /Failed to load resource.*409/ });

  test("the sheet shows the invalid-Lexicon message instead of the script", async ({ page, server }) => {
    await writeFile(server.data.lexiconFile("pt-BR"), '{"thread": "tréd",}');
    await openSheet(page, server.data);
    await expect(sheet(page)).toContainText("lexicon.json is not valid JSON");
    await expect(sheet(page).getByRole("button", { name: "▶ Preview" })).toHaveCount(0);
  });

  test("Save refuses a broken Lexicon with its message; then it writes the fix, queues the regenerate and closes the 🚩 item", async ({
    page,
    server,
  }) => {
    const lexicon = server.data.lexiconFile("pt-BR");
    const good = await readFile(lexicon, "utf8");
    await openSheet(page, server.data);
    const save = sheet(page).getByRole("button", { name: "Save and regenerate" });
    await expect(save).toBeDisabled();
    await word(page, "cozinheiro").click();
    await sound(page, "cozinheiro").fill("—");
    await expect(sheet(page)).toContainText("needs a letter or a digit");
    await expect(save).toBeDisabled();
    await sound(page, "cozinheiro").fill("kuzinhêro");

    await writeFile(lexicon, '{"thread": "tréd",}');
    await save.click();
    await expect(sheet(page)).toContainText("lexicon.json is not valid JSON");

    await writeFile(lexicon, good);
    await save.click();
    await expect(page.getByText("Fix saved: regenerating, back in the Feed once remade.")).toBeVisible();
    await expect(sheet(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "🗣️ Fix pronunciation" })).toHaveCount(0);
    expect(JSON.parse(await readFile(lexicon, "utf8")).cozinheiro).toBe("kuzinhêro");
    expect(server.data.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.kind, "regenerate")).all()).toEqual([
      { status: "queued" },
    ]);
  });
});
