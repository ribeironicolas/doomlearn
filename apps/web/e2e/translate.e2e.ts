import { copyFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { Data } from "@doomlearn/core/data";
import { clips, jobs } from "@doomlearn/core/schema";
import { publishPreflight } from "@doomlearn/core/status";
import { editConfig } from "@doomlearn/core/test/fakes";
import { expect, openFeed, paused, player, playing, slides, test } from "./fixtures.ts";

//
// Make in another Language: the 🌐 sheet on the Feed and Search players, and its states.
//

/** The 🌐 sheet. */
const sheet = (page: Page) => page.getByTestId("translate-sheet");
/** The sheet's row for `language`. */
const row = (page: Page, language: string) => sheet(page).locator(`[data-language="${language}"]`);

/**
 * Gives the first Clip's Concept and Angle an English Clip too, already seen so the Feed leaves it out.
 */
async function madeInEnglish(data: Data) {
  const first = data.db.select().from(clips).where(eq(clips.id, 1)).get()!;
  const file = first.file.replace(/\.webm$/, "-en.webm");
  await copyFile(first.file, file);
  return data.db
    .insert(clips)
    .values({ ...first, id: undefined, language: "en", file, lastSeenAt: new Date() })
    .returning()
    .get();
}

test("🌐 on a Feed Clip lists every other Language: one made is greyed with ▶ Play, Make queues once and shows its wait", async ({
  page,
  server,
}) => {
  const { data } = server;
  const english = await madeInEnglish(data);
  await openFeed(page);
  await slides(page).first().locator("[data-button=translate]").click();

  await expect(sheet(page)).toContainText("Make “Threads” in another Language");
  await expect(sheet(page).locator("[data-language]")).toHaveCount(2);
  await expect(row(page, "en")).toContainText("Already in English");
  await expect(row(page, "es").getByRole("button")).toHaveText("Make in Spanishabout 5 minutes");
  await page.screenshot({ path: test.info().outputPath("translate-sheet.png") });

  // ▶ Play opens the English Clip over the Feed, which pauses; back returns to the sheet.
  await row(page, "en").getByRole("button", { name: "▶ Play" }).click();
  await expect(player(page)).toContainText("English · Threads · concrete example");
  await expect(player(page).locator("video")).toHaveAttribute("src", `/clips/${basename(english.file)}`);
  expect(await paused(page, 0)).toBe(true);
  await page.goBack();
  await expect(player(page)).toBeHidden();
  await expect(row(page, "en")).toContainText("Already in English");

  await row(page, "es").getByRole("button").click();
  await expect(page.getByText("Queued: Spanish translation of Threads")).toBeVisible();
  await expect(row(page, "es")).toHaveText("Spanish · Making in Spanish…");
  const translations = () =>
    data.db
      .select({ language: jobs.language, fromClipId: jobs.fromClipId })
      .from(jobs)
      .where(eq(jobs.kind, "translate"))
      .all();
  expect(translations()).toEqual([{ language: "es", fromClipId: 1 }]);

  // The 4 Clips made today are over a cap of 3; then the Spanish voice is missing.
  await editConfig(data.home, { worker: { dailyClipCap: 3 } });
  await expect(row(page, "es")).toHaveText("Spanish · Waiting for tomorrow: daily Clip cap", { timeout: 10_000 });
  await editConfig(data.home, {});
  publishPreflight(data, [{ reason: "tts weights for Spanish missing: run `pnpm bootstrap`", languages: ["es"] }]);
  await expect(row(page, "es")).toHaveText("Spanish · tts weights for Spanish missing: run `pnpm bootstrap`", {
    timeout: 10_000,
  });
  await page.screenshot({ path: test.info().outputPath("translate-waiting.png") });

  // Closed and opened again, it still queues nothing more.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toBeHidden();
  await playing(page, 0);
  await slides(page).first().locator("[data-button=translate]").click();
  await expect(row(page, "es")).toHaveText("Spanish · tts weights for Spanish missing: run `pnpm bootstrap`");
  expect(translations()).toHaveLength(1);

  // Stuck, it is retried from the Inbox, which names the Translation.
  data.db.update(jobs).set({ status: "stuck", stage: "script" }).where(eq(jobs.kind, "translate")).run();
  await expect(row(page, "es")).toHaveText("Spanish · Stuck: ↻ Retry it from the Inbox", { timeout: 10_000 });
  await page.goto("/inbox");
  await expect(page.getByText("Translation into Spanish · after script")).toBeVisible();
});

test("🌐 in the Search player opens the sheet, and leaves once 🚩 hides the Clip; the Inbox player has none", async ({
  page,
}) => {
  await openFeed(page);
  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();

  await player(page).locator("[data-button=translate]").click();
  await expect(sheet(page)).toContainText("Make “Threads” in another Language");
  await expect(row(page, "en").getByRole("button")).toHaveText("Make in Englishabout 5 minutes");
  await page.goBack();
  await expect(sheet(page)).toBeHidden();
  await expect(player(page)).toBeVisible();

  await player(page).getByRole("button", { name: "🚩 wrong" }).click();
  await page.getByRole("button", { name: "Hide this Clip and log it" }).click();
  await expect(page.getByText("🚩 Logged; this Clip is hidden.")).toBeVisible();
  await expect(player(page).locator("[data-button=translate]")).toHaveCount(0);

  await page.goto("/inbox");
  await page.getByRole("button", { name: "▶ View Clip" }).click();
  await expect(player(page)).toBeVisible();
  await expect(player(page).locator("[data-button=translate]")).toHaveCount(0);
});

test("the Search player pauses while a Clip from its 🌐 sheet plays, and plays again after", async ({
  page,
  server,
}) => {
  await madeInEnglish(server.data);
  await openFeed(page);
  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();
  const search = player(page).first().locator("video");
  await expect.poll(() => search.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);

  await player(page).locator("[data-button=translate]").click();
  await row(page, "en").getByRole("button", { name: "▶ Play" }).click();
  await expect(player(page).last()).toContainText("English · Threads");
  expect(await search.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.goBack();
  await page.goBack();
  await expect(sheet(page)).toBeHidden();
  await expect.poll(() => search.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
});
