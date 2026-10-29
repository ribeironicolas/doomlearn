import type { Locator, Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { Data } from "@doomlearn/core/data";
import { chapters, clips, concepts, jobs, passages, sources } from "@doomlearn/core/schema";
import { expect, player, test } from "./fixtures.ts";

//
// The Source screen: a Source's chapters in book order, each opening to its Concepts, their Passages and Clips.
//

/**
 * The e2e Source's only chapter, the Concept titled `title`, and its first Clip.
 */
const rows = ({ data }: { data: Data }, title: string) => {
  const concept = data.db.select().from(concepts).where(eq(concepts.title, title)).get()!;
  return {
    chapter: data.db.select().from(chapters).where(eq(chapters.sourceId, 1)).get()!,
    concept,
    clip: data.db.select().from(clips).where(eq(clips.conceptId, concept.id)).get(),
  };
};

/**
 * Adds a Concept taught by the e2e Source's chapter, with no Clip.
 */
const addConcept = ({ data }: { data: Data }, title: string) => {
  const { chapter } = rows({ data }, "Threads");
  const concept = data.db
    .insert(concepts)
    .values({ title, summary: `${title}, briefly.`, fitAngles: ["analogy"], sourceId: 1, seq: 9 })
    .returning()
    .get();
  data.db
    .insert(passages)
    .values({
      conceptId: concept.id,
      sourceId: 1,
      chapterId: chapter.id,
      anchor: { chapter: "Concurrency" },
      text: title,
    })
    .run();
  return concept;
};

/**
 * Opens Sources straight from its URL (the Feed under it never plays), then the book's Source screen from its card.
 */
async function openBook(page: Page) {
  await page.goto("/sources");
  await page.getByRole("button", { name: /^book/ }).click();
  await expect(page).toHaveURL(/\/sources\/1$/);
}

/**
 * The Concept row titled `title`.
 */
const conceptRow = (page: Page, title: string) =>
  page.locator("[data-concept]").filter({ has: page.locator("b", { hasText: new RegExp(`^${title}$`) }) });

test("a Source card opens its Source screen, and its Pause, Resume and Retry still act on the card", async ({
  page,
  server,
}) => {
  server.data.db
    .update(jobs)
    .set({ status: "stuck", lastError: "Error: no anchors" })
    .where(eq(jobs.kind, "extract_chapter"))
    .run();
  await page.goto("/sources");
  // The innermost box around the card's own button: the card.
  const card = page.locator("div", { has: page.getByRole("button", { name: /^book/ }) }).last();
  await expect(card).toContainText("book1 stuck");

  await card.getByRole("button", { name: "↻ Retry" }).click();
  await expect(card).toContainText("bookcomplete");
  await card.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(card).toContainText("bookpaused");
  await card.getByRole("button", { name: "▶ Resume" }).click();
  await expect(card).toContainText("bookcomplete");
  await expect(page).toHaveURL(/\/sources$/);

  await card.getByRole("button", { name: /^book/ }).click();
  await expect(page).toHaveURL(/\/sources\/1$/);
  await expect(page.getByRole("heading", { name: "book" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/sources$/);
});

test("a chapter opens in place to its Concepts with their state in words; a Passage opens to its full text; a shared Concept says where else it is", async ({
  page,
  server,
}) => {
  const { db } = server.data;
  const pointers = rows(server, "Pointers").concept;
  db.update(concepts)
    .set({ ladderStep: 1, dueAt: new Date("2026-11-01T12:00:00Z") })
    .where(eq(concepts.id, pointers.id))
    .run();
  const mutexes = rows(server, "Mutexes").concept;
  db.update(concepts)
    .set({ status: "retired", retiredReason: "known", notLandingAt: new Date() })
    .where(eq(concepts.id, mutexes.id))
    .run();
  const long = `Threads share the memory of their process. ${"Each one runs its own sequence of steps. ".repeat(6)}The end.`;
  db.update(passages)
    .set({ text: long })
    .where(eq(passages.conceptId, rows(server, "Threads").concept.id))
    .run();
  // A second Source, a PDF, whose chapter teaches Threads too.
  db.insert(sources).values({ id: 2, title: "paper", type: "pdf", sha256: "paper" }).run();
  const locks = db
    .insert(chapters)
    .values({ sourceId: 2, seq: 2, title: "Locks", status: "extracted" })
    .returning()
    .get();
  db.insert(passages)
    .values({
      conceptId: rows(server, "Threads").concept.id,
      sourceId: 2,
      chapterId: locks.id,
      anchor: { pages: [3, 3] },
      text: "<!-- page 3 -->\nLocks.",
    })
    .run();

  await openBook(page);
  const chapter = page.locator("[data-chapter='1']");
  await expect(chapter).toContainText("ch. 1 Concurrencyextracted3 Concepts");
  await expect(page.locator("[data-concept]")).toHaveCount(0);

  await chapter.getByRole("button", { name: /^ch\. 1/ }).click();
  await expect(chapter.locator("[data-concept] b")).toHaveText(["Threads", "Mutexes", "Pointers"]);
  await expect(conceptRow(page, "Threads")).toContainText("New, not shown yet");
  await expect(conceptRow(page, "Mutexes")).toContainText("MutexesNot landingRetired: known");
  await expect(conceptRow(page, "Pointers")).toContainText("Next Review 2026-11-01 (step 2 of 5)");
  await expect(conceptRow(page, "Threads")).toContainText("also in paper, ch. 3 Locks");
  await expect(conceptRow(page, "Mutexes")).not.toContainText("also in");

  const passage = conceptRow(page, "Threads").locator("[data-passage]");
  await expect(passage).not.toContainText("The end.");
  await expect(passage).toHaveText(/…$/);
  await passage.click();
  await expect(passage).toHaveText(long);
  await page.screenshot({ path: test.info().outputPath("source-screen.png") });

  await page.goto("/sources/2");
  await page.getByRole("button", { name: /^ch\. 3/ }).click();
  await expect(conceptRow(page, "Threads")).toContainText("also in book, ch. 1 Concurrency");
});

test('a Concept with a queued new job says "Clip being made", one with none "No Clip yet"', async ({
  page,
  server,
}) => {
  const locks = addConcept(server, "Locks");
  server.data.db.insert(jobs).values({ kind: "new", priority: 1, conceptId: locks.id, angle: "analogy" }).run();
  addConcept(server, "Waits");

  await openBook(page);
  await page.getByRole("button", { name: /^ch\. 1/ }).click();
  await expect(conceptRow(page, "Locks")).toContainText("Clip being made");
  await expect(conceptRow(page, "Waits")).toContainText("No Clip yet");
  await expect(conceptRow(page, "Threads")).not.toContainText("No Clip yet");
});

test("a Clip plays in the Search player and sends no seen; a 🚩 Clip is greyed flagged and does not play", async ({
  page,
  server,
}) => {
  const flagged = rows(server, "Mutexes").clip!;
  server.data.db.update(clips).set({ hidden: true }).where(eq(clips.id, flagged.id)).run();
  const seen: string[] = [];
  page.on("request", (request) => request.url().endsWith("/api/seen") && seen.push(request.url()));

  await openBook(page);
  await page.getByRole("button", { name: /^ch\. 1/ }).click();
  const greyed = conceptRow(page, "Mutexes").getByRole("button", { name: /flagged/ });
  await expect(greyed).toHaveText("🚩 concrete example · pt-BR · flagged");
  await expect(greyed).toBeDisabled();
  await greyed.click({ force: true });
  await expect(player(page)).toHaveCount(0);

  await conceptRow(page, "Threads").getByRole("button", { name: "▶ concrete example · pt-BR · unseen" }).click();
  await expect(player(page)).toBeVisible();
  await expect(player(page)).toContainText("New, not shown yet · Threads · concrete example");
  await expect(player(page).locator("small")).toHaveText(["didn’t get it", "wrong", "favorite", "language"]);
  await expect
    .poll(() =>
      player(page)
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.currentTime > 0),
    )
    .toBe(true);
  // 2 s Clips: one full loop, which the Feed would count as seen.
  await page.waitForTimeout(2500);
  expect(seen).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("source-player.png") });

  await page.goBack();
  await expect(player(page)).toBeHidden();
  await expect(page).toHaveURL(/\/sources\/1$/);
  await expect(conceptRow(page, "Threads")).toContainText("unseen");
});

test("the ⋯ menus pause, resume, delete and restore chapters and Concepts; a Retired Concept offers Delete only; a delete greys the row and shows a Restore toast, with no dialog", async ({
  page,
  server,
}) => {
  const { db } = server.data;
  const mutexes = rows(server, "Mutexes").concept;
  db.update(concepts).set({ status: "retired", retiredReason: "known" }).where(eq(concepts.id, mutexes.id)).run();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => dialogs.push(dialog.message()));
  /**
   * The menu items of the ⋯ menu `name` inside `scope`, once opened.
   */
  const menu = async (scope: Locator, name: string) => {
    await scope.getByRole("button", { name: `More for ${name}`, exact: true }).click();
    return scope.getByRole("menuitem");
  };
  const toast = page.getByText("Deleted · Restore", { exact: true });

  await page.clock.install();
  await openBook(page);
  const chapter = page.locator("[data-chapter='1']");
  await chapter.getByRole("button", { name: /^ch\. 1/ }).click();
  const threads = conceptRow(page, "Threads");
  await expect(await menu(threads, "Threads")).toHaveText(["⏸ Pause", "🗑 Delete"]);
  await threads.getByRole("menuitem", { name: "⏸ Pause" }).click();
  await expect(threads).toContainText("ThreadsPaused");
  await expect(await menu(threads, "Threads")).toHaveText(["▶ Resume", "🗑 Delete"]);
  await threads.getByRole("menuitem", { name: "▶ Resume" }).click();
  await expect(threads).not.toContainText("Paused");

  const retired = conceptRow(page, "Mutexes");
  await expect(await menu(retired, "Mutexes")).toHaveText(["🗑 Delete"]);
  await retired.getByRole("menuitem", { name: "🗑 Delete" }).click();
  await expect(toast).toBeVisible();
  await expect(retired).toContainText("MutexesDeletedRetired: known");
  await expect(retired.locator("div.flex-1")).toHaveClass(/opacity-50/);
  await expect(await menu(retired, "Mutexes")).toHaveText(["↩ Restore"]);
  expect(db.select().from(concepts).where(eq(concepts.id, mutexes.id)).get()!.deletedAt).not.toBeNull();
  await page.screenshot({ path: test.info().outputPath("source-menus.png") });
  // Past the 2.6 s of other toasts, it still offers Restore.
  await page.clock.runFor(3000);
  await toast.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(retired).not.toContainText("Deleted");
  await expect(retired.locator("div.flex-1")).not.toHaveClass(/opacity-50/);

  // Every menu is closed, so only the chapter's items show.
  await expect(await menu(chapter, "ch. 1")).toHaveText(["⏸ Pause", "🗑 Delete"]);
  await chapter.getByRole("menuitem", { name: "⏸ Pause" }).click();
  await expect(chapter).toContainText("ch. 1 Concurrencypaused");
  await expect(await menu(chapter, "ch. 1")).toHaveText(["▶ Resume", "🗑 Delete"]);
  await chapter.getByRole("menuitem", { name: "▶ Resume" }).click();
  await expect(chapter).toContainText("ch. 1 Concurrencyextracted");
  await (await menu(chapter, "ch. 1")).filter({ hasText: "Delete" }).click();
  await expect(chapter).toContainText("ch. 1 Concurrencydeleted");
  await expect(toast).toBeVisible();
  await expect(page.locator("[data-concept]", { hasText: "Deleted" })).toHaveCount(3);
  // The Concepts went with their chapter: its Restore brings them back.
  await expect(threads.getByRole("button", { name: "More for Threads", exact: true })).toHaveCount(0);
  await expect(threads).toContainText("deleted with ch. 1 Concurrency");
  // Its Clips still play, with no 🤔, 🚩, ⭐ or 🌐: a Deleted Concept has no entry point to them.
  await threads.getByRole("button", { name: "▶ concrete example · pt-BR · unseen" }).click();
  await expect(player(page)).toBeVisible();
  await expect(player(page).locator("small")).toHaveCount(0);
  await page.goBack();
  await expect(player(page)).toBeHidden();
  await expect(await menu(chapter, "ch. 1")).toHaveText(["↩ Restore"]);
  await chapter.getByRole("menuitem", { name: "↩ Restore" }).click();
  await expect(chapter).toContainText("ch. 1 Concurrencyextracted");
  await expect(page.locator("[data-concept]", { hasText: "Deleted" })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test.describe("when the Mac has no such Source", () => {
  // Chromium logs the refused request.
  test.use({ expectedErrors: /Failed to load resource.*404/ });

  test('the screen says "No such Source", not Mac unreachable, and stops asking', async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (request) => request.url().endsWith("/api/sources/99") && asked.push(request.url()));

    await page.goto("/sources/99");
    await expect(page.getByText("No such Source.")).toBeVisible();
    await expect(page.getByText(/Mac unreachable/)).toHaveCount(0);
    // Past one 3 s poll.
    await page.waitForTimeout(3500);
    expect(asked).toHaveLength(1);
  });
});
