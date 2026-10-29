import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { Data } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { clips, concepts, events, jobs } from "@doomlearn/core/schema";
import { publishPreflight, publishStage } from "@doomlearn/core/status";
import { expect, openFeed, player, playing, slides, test } from "./fixtures.ts";

//
// The frozen Search, Inbox and Sources parity list (R5 §9): each item behaves as in v1 (apps/web/legacy).
//

/**
 * Opens a screen from its top-right icon, over the Feed.
 */
async function open(page: Page, icon: "🔍" | "📚" | "📥") {
  await openFeed(page);
  await page.locator("nav button", { hasText: icon }).click();
}

/**
 * The innermost card holding `text` and a `button`.
 */
const cardWith = (page: Page, button: string, text: string) =>
  page
    .locator("div", { has: page.getByRole("button", { name: button }) })
    .filter({ hasText: text })
    .last();
/** The kinds of every recorded event, in order. */
const kinds = (server: { data: Data }) =>
  server.data.db
    .select()
    .from(events)
    .all()
    .map((event) => event.kind);

test("Search: each result card shows the Concept, its ladder status, Source, Angle and the caption match", async ({
  page,
  server,
}) => {
  server.data.db.update(clips).set({ caption: "A mutex guards shared memory" }).where(eq(clips.id, 2)).run();
  server.data.db.update(clips).set({ caption: "A pointer holds a memory address" }).where(eq(clips.id, 3)).run();
  await open(page, "🔍");
  await page.getByPlaceholder("Search the captions").fill("memory");

  const cards = page.locator("[data-hit]");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("MutexesNew");
  await expect(cards.nth(1)).toContainText("Pointers3d");
  await expect(cards.nth(0)).toContainText("book · concrete example");
  await expect(cards.nth(0).locator("mark")).toHaveText("memory");
  await expect(cards.nth(0)).toContainText("“A mutex guards shared memory”");

  await page.getByPlaceholder("Search the captions").fill("nothingmatches");
  await expect(page.getByText("Nothing in the captions.")).toBeVisible();
  await expect(cards).toHaveCount(0);
});

test("Search: each result shows its Clip's Language tag, which the Feed's tag doesn't", async ({ page, server }) => {
  server.data.db.update(clips).set({ caption: "A mutex guards shared memory" }).where(eq(clips.id, 2)).run();
  server.data.db
    .update(clips)
    .set({ caption: "A pointer holds a memory address", language: "en" })
    .where(eq(clips.id, 3))
    .run();
  await openFeed(page);
  await expect(slides(page).locator("div", { hasText: /^(New|Review) ·/ })).toHaveText([
    "New · Threads · book · concrete example",
    "New · Mutexes · book · concrete example",
    "Review · 3d · Pointers · book · concrete example",
  ]);

  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("memory");

  const cards = page.locator("[data-hit]");
  await expect(cards.nth(0)).toContainText("book · concrete example · pt-BR");
  await expect(cards.nth(1)).toContainText("book · concrete example · en");
  await page.screenshot({ path: test.info().outputPath("search-language.png") });
});

test("Search: a result plays full-screen with only 🤔, 🚩, ⭐ and 🌐, records nothing, and back returns to the results", async ({
  page,
  server,
}) => {
  await open(page, "🔍");
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();

  await expect(player(page)).toBeVisible();
  // A history entry with no URL.
  await expect(page).toHaveURL(/\/search$/);
  await expect(player(page)).toContainText("New · Threads · concrete example");
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
  expect(kinds(server)).toEqual([]);

  await page.goBack();
  await expect(player(page)).toBeHidden();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.locator("[data-hit]")).toHaveCount(3);
  expect(
    await page
      .locator("section[data-clip] video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(true);
});

test("Search: a result tapped while a newer query is pending keeps playing when that answer lands", async ({
  page,
  server,
}) => {
  server.data.db.update(clips).set({ caption: "A mutex guards shared memory" }).where(eq(clips.id, 2)).run();
  server.data.db.update(clips).set({ caption: "A pointer holds a memory address" }).where(eq(clips.id, 3)).run();
  let answer = () => {};
  const held = new Promise<void>((resolve) => (answer = resolve));
  await page.route("**/api/search?q=memory%20address", async (route) => {
    await held;
    await route.continue();
  });
  await open(page, "🔍");
  await page.getByPlaceholder("Search the captions").fill("memory");
  await expect(page.locator("[data-hit]")).toHaveCount(2);

  await page.getByPlaceholder("Search the captions").fill("memory address");
  await page.locator("[data-hit]").first().click();
  await expect(player(page)).toContainText("Mutexes");
  answer();
  await expect(page.locator("[data-hit]")).toHaveCount(1);
  await expect(player(page)).toContainText("Mutexes");
});

test("Search: 🤔 from the player un-retires a Retired Concept, due tomorrow", async ({ page, server }) => {
  server.data.db.update(concepts).set({ status: "retired", retiredReason: "known" }).where(eq(concepts.id, 1)).run();
  await open(page, "🔍");
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await expect(page.locator("[data-hit]").first()).toContainText("ThreadsRetired");
  await page.locator("[data-hit]").first().click();
  await player(page).getByRole("button", { name: "🤔" }).click();

  await expect(page.getByText("🤔 Back to step 0, due tomorrow.")).toBeVisible();
  await expect(player(page).getByRole("button", { name: "🤔" })).toBeHidden();
  expect(server.data.db.select().from(concepts).where(eq(concepts.id, 1)).get()!.status).toBe("scheduled");
  expect(kinds(server)).toEqual(["didnt_get"]);
});

test("Search: 🚩 from the player asks a reason in a sheet that back closes, then hides the Clip", async ({
  page,
  server,
}) => {
  await open(page, "🔍");
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();
  await player(page).getByRole("button", { name: "🚩" }).click();
  await expect(page.getByText("🚩 What’s wrong in “Threads”?")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("🚩 What’s wrong")).toBeHidden();
  await expect(player(page)).toBeVisible();

  await player(page).getByRole("button", { name: "🚩" }).click();
  await page.getByRole("button", { name: "Wrong caption" }).click();
  await page.getByRole("button", { name: "Hide this Clip and log it" }).click();
  await expect(page.getByText("🚩 Logged; this Clip is hidden.")).toBeVisible();
  expect(kinds(server)).toEqual(["flag"]);
  expect(server.data.db.select().from(clips).where(eq(clips.id, 1)).get()!.hidden).toBe(true);
});

test("Inbox: an open 🚩 shows its reason and note; its Clip plays, and Resolved takes it out", async ({
  page,
  server,
}) => {
  createFeed(server.data).press(1, "flag", "f1", { reason: "Pronunciation", note: "mutex came out wrong" });
  await open(page, "📥");

  await expect(page.getByRole("heading", { name: "🚩 Flagged Clips (1)" })).toBeVisible();
  const card = cardWith(page, "Resolved", "Threads");
  await expect(card).toContainText("ThreadsPronunciation");
  await expect(card).toContainText("concrete example · ");
  await expect(card).toContainText("“mutex came out wrong”");
  await card.getByRole("button", { name: "▶ View Clip" }).click();
  await expect(player(page)).toContainText("🚩 · Threads · concrete example");
  await expect(player(page).locator("small")).toHaveCount(0);
  await page.goBack();
  await expect(player(page)).toBeHidden();

  await card.getByRole("button", { name: "Resolved" }).click();
  await expect(page.getByText("🚩 Resolved.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "🚩 Flagged Clips (0)" })).toBeVisible();
  await expect(page.locator("nav span")).toHaveText("0");
});

test("Inbox: ↻ Regenerate on a 🚩 queues its Clip for a remake and takes it out, with a toast", async ({
  page,
  server,
}) => {
  createFeed(server.data).press(1, "flag", "f1", { reason: "Pronunciation", note: "mutex came out wrong" });
  await open(page, "📥");

  const card = cardWith(page, "↻ Regenerate", "Threads");
  await expect(card.getByRole("button", { name: "Resolved" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("inbox-regenerate.png") });
  await card.getByRole("button", { name: "↻ Regenerate" }).click();

  await expect(page.getByText("↻ Regenerating: back in the Feed once remade.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "🚩 Flagged Clips (0)" })).toBeVisible();
  expect(
    server.data.db
      .select({ status: jobs.status, conceptId: jobs.conceptId })
      .from(jobs)
      .where(eq(jobs.kind, "regenerate"))
      .all(),
  ).toEqual([{ status: "queued", conceptId: 1 }]);
});

test("Inbox: a Concept not landing shows the Angles tried; its Passage opens in a sheet, and ⏭️ retires it", async ({
  page,
  server,
}) => {
  server.data.db.update(concepts).set({ notLandingAt: new Date() }).where(eq(concepts.id, 3)).run();
  await open(page, "📥");

  await expect(page.getByRole("heading", { name: "Not landing (1)" })).toBeVisible();
  const card = cardWith(page, "⏭️ Retire", "Pointers");
  await expect(card).toContainText("Pointers1/1 Angles");
  await expect(card).toContainText("Tried concrete example · since");
  await card.getByRole("button", { name: "Read the Passage" }).click();
  const sheet = page.locator("div", { has: page.getByRole("heading", { name: "Pointers", level: 3 }) }).last();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("book · Concurrency");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Pointers", level: 3 })).toBeHidden();
  await expect(page).toHaveURL(/\/inbox$/);

  await card.getByRole("button", { name: "⏭️ Retire" }).click();
  await expect(page.getByText("⏭️ Retired.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not landing (0)" })).toBeVisible();
  expect(kinds(server)).toEqual(["know"]);
});

test("Inbox: a stuck job shows where it stopped and why; ↻ Retry puts it back in the queue", async ({
  page,
  server,
}) => {
  server.data.db
    .update(jobs)
    .set({ status: "stuck", stage: null, lastError: "Error: no anchors" })
    .where(eq(jobs.kind, "extract_chapter"))
    .run();
  const [clipJob] = server.data.db.select().from(jobs).where(eq(jobs.kind, "new")).all();
  server.data.db
    .update(jobs)
    .set({ status: "stuck", stage: "script", lastError: "Error: too long" })
    .where(eq(jobs.id, clipJob.id))
    .run();
  await open(page, "📥");

  await expect(page.getByRole("heading", { name: "Stuck jobs (2)" })).toBeVisible();
  const extraction = cardWith(page, "↻ Retry", "book · Concurrency");
  await expect(extraction).toContainText("stuckExtraction · at the first stage");
  await expect(extraction).toContainText("Error: no anchors");
  await expect(cardWith(page, "↻ Retry", "Threads · concrete example")).toContainText("stuckClip · after script");

  await extraction.getByRole("button", { name: "↻ Retry" }).click();
  await expect(page.getByText("↻ Back in the queue.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stuck jobs (1)" })).toBeVisible();
});

test.describe("a refused upload", () => {
  // The browser logs the 422 the refusal comes with.
  test.use({ expectedErrors: /Failed to load resource.*422/ });

  test("Sources: the drop zone takes PDF, txt, md, epub and azw3; an upload adds a Source, a refusal names the file and why", async ({
    page,
  }) => {
    await open(page, "📚");
    const input = page.locator("input[type=file]");
    await expect(page.getByText("📄 Add a PDF, .txt, .md, .epub or .azw3")).toBeVisible();
    await expect(input).toHaveAttribute("accept", ".pdf,.txt,.md,.epub,.azw3");

    await input.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("Locks") });
    await expect(cardWith(page, "⏸ Pause", "notes")).toContainText("chapter 0/1 · 0 Concepts");

    await input.setInputFiles({ name: "scanned.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
    await expect(page.getByText("scanned.pdf refused. Scanned PDF: 2 of 3 pages have no text layer")).toBeVisible();
  });
});

test("Sources: each Source shows its progress per chapter and Concepts, the queue line, and pauses or resumes; none is deleted", async ({
  page,
}) => {
  await open(page, "📚");
  await expect(page.getByText(/^Queue: buffer 3\/10 · today 3\/\d+ Clips$/)).toBeVisible();
  const card = cardWith(page, "⏸ Pause", "book");
  await expect(card).toContainText("bookcomplete");
  await expect(card).toContainText("chapter 1/1 · 3 Concepts");
  await expect(card.locator(".bg-ok")).toHaveCSS("width", /^\d+(\.\d+)?px$/);
  expect(await card.locator(".bg-ok").evaluate((bar) => bar.style.width)).toBe("100%");
  await expect(
    page.getByText(
      "Pausing stops new Concepts and Clips from that Source; Reviews and 🤔 go on. Sources are never deleted.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /delete|remove/i })).toHaveCount(0);

  await card.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(cardWith(page, "▶ Resume", "book")).toContainText("bookpaused");
  await cardWith(page, "▶ Resume", "book").getByRole("button", { name: "▶ Resume" }).click();
  await expect(cardWith(page, "⏸ Pause", "book")).toContainText("bookcomplete");
});

test("Sources: a stuck chapter shows its error and ↻ Retry puts it back in the queue", async ({ page, server }) => {
  server.data.db
    .update(jobs)
    .set({ status: "stuck", lastError: "Error: no anchors" })
    .where(eq(jobs.kind, "extract_chapter"))
    .run();
  await open(page, "📚");
  const card = cardWith(page, "⏸ Pause", "book");
  await expect(card).toContainText("book1 stuck");
  await expect(card).toContainText("✗ ch. 1 “Concurrency”: Error: no anchors");

  await card.getByRole("button", { name: "↻ Retry" }).click();
  await expect(card).toContainText("bookcomplete");
  await expect(card.getByRole("button", { name: "↻ Retry" })).toHaveCount(0);
});

test("Sources: the live Worker-status card, polled every 3 s while open, shows the stage and every Blocker", async ({
  page,
  server,
}) => {
  await open(page, "📚");
  const card = page.getByTestId("worker-status");
  await expect(card).toContainText("Worker idle");

  const startedAt = new Date();
  const [job] = server.data.db.select().from(jobs).all();
  publishStage(server.data, { jobId: job.id, stage: "script", startedAt });
  publishPreflight(server.data, ["codex not logged in: run `codex login`"]);
  const hhmm = startedAt.toTimeString().slice(0, "HH:MM".length);
  await expect(card).toContainText(`Worker running: script · book since ${hhmm}`, { timeout: 4000 });
  await expect(card).toContainText("codex not logged in: run `codex login`");
});

test("Sources: two columns in the Mac browser", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, "📚");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("Locks") });
  const [book, notes] = [cardWith(page, "⏸ Pause", "book"), cardWith(page, "⏸ Pause", "notes")];
  await expect(notes).toBeVisible();
  expect((await book.boundingBox())!.y).toBe((await notes.boundingBox())!.y);
  expect((await book.boundingBox())!.x).toBeLessThan((await notes.boundingBox())!.x);
});

test.describe("with the Mac unreachable", () => {
  test.use({ expectedErrors: /Failed to load resource|ERR_CONNECTION_REFUSED/ });

  test('Search, Inbox and Sources say "Mac unreachable" and disable their forms', async ({ page, server }) => {
    await openFeed(page);
    await server.stop();
    const unreachable = page.getByText("Mac unreachable. Try again once it’s back.");

    await page.locator("nav button", { hasText: "🔍" }).click();
    await page.getByPlaceholder("Search the captions").fill("cozinheiro");
    await expect(unreachable).toBeVisible();
    await expect(page.getByPlaceholder("Search the captions")).toBeDisabled();
    await page.goBack();

    await page.locator("nav button", { hasText: "📥" }).click();
    await expect(unreachable).toBeVisible();
    await expect(page.getByRole("heading", { name: /Flagged Clips/ })).toHaveCount(0);
    await page.goBack();

    await page.locator("nav button", { hasText: "📚" }).click();
    await expect(unreachable).toBeVisible();
    await expect(page.locator("input[type=file]")).toBeDisabled();
    await expect(page.getByText("Your Sources")).toHaveCount(0);
  });
});

test("a Clip and a sheet opened in a screen close with back, then back returns to the same Clip and scroll position", async ({
  page,
}) => {
  await openFeed(page);
  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  const feed = page.locator("section[data-clip] video").nth(1);
  const position = await feed.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();
  await player(page).getByRole("button", { name: "🚩" }).click();

  await page.goBack();
  await page.goBack();
  await expect(player(page)).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await playing(page, 1);
  expect(await page.locator("main").evaluate((main) => main.scrollTop)).toBe(915);
  expect(await feed.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(position);
});
