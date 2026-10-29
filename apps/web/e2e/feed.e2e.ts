import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createFeed } from "@doomlearn/core/feed";
import { clips, concepts, events } from "@doomlearn/core/schema";
import { chip, expect, longPress, openFeed, paused, playing, slides, swipe, test, video } from "./fixtures.ts";
import type { startServer } from "./server.ts";

//
// The frozen Feed and Done parity list (R5 §9): each item behaves as in v1 (apps/web/legacy).
//

/**
 * Presses a rail button on the `n`th Clip.
 */
const press = (page: Page, n: number, label: string) =>
  slides(page).nth(n).getByRole("button", { name: label }).click();

test("one Clip per screen, full-screen and covering; scrolling snaps to the next Clip, which plays alone", async ({
  page,
}) => {
  await openFeed(page);
  const box = await slides(page).first().boundingBox();
  expect([box?.width, box?.height]).toEqual([412, 915]);
  await expect(video(page, 0)).toHaveCSS("object-fit", "cover");

  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  await expect.poll(async () => (await slides(page).nth(1).boundingBox())?.y).toBe(0);
  expect(await paused(page, 0)).toBe(true);
});

test("the rail holds ✅ 🤔 ⏭️ 🚩 ⭐ 🌐 on the right, starting 38% down, above the tag", async ({ page }) => {
  await openFeed(page);
  const rail = slides(page).first().locator("[data-button]");
  await expect(rail).toHaveText(["✅got it", "🤔didn’t get it", "⏭️already know", "🚩wrong", "☆favorite", "🌐language"]);
  const first = await rail.first().boundingBox();
  expect(first!.y).toBeCloseTo(915 * 0.38, 0);
  // 8 px from the right edge, give or take the device-pixel rounding.
  expect(Math.abs(first!.x + first!.width - (412 - 8))).toBeLessThanOrEqual(1);
  const last = await rail.last().boundingBox();
  const tag = await slides(page)
    .first()
    .locator("div", { hasText: /^New ·/ })
    .boundingBox();
  expect(last!.y + last!.height).toBeLessThan(tag!.y);
});

test("on a short screen, a Pixel 4's Chrome tab, the rail moves up and still ends above the tag", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 726 });
  await openFeed(page);
  const rail = slides(page).first().locator("[data-button]");
  const last = await rail.last().boundingBox();
  const tag = await slides(page)
    .first()
    .locator("div", { hasText: /^New ·/ })
    .boundingBox();
  expect(last!.y + last!.height).toBeLessThan(tag!.y);
});

test("the tag says New or Review with its step, the Concept, Source and Angle; 🔍 ⭐ 📚 📥 ⚙️ sit top right", async ({
  page,
}) => {
  await openFeed(page);
  await expect(slides(page).nth(0)).toContainText("New · Threads · book · concrete example");
  await expect(slides(page).nth(2)).toContainText("Review · 3d · Pointers · book · concrete example");
  await expect(page.locator("nav button")).toHaveText(["🔍", "⭐", "📚", "📥0", "⚙️"]);
  await expect(page.locator("nav span")).toBeHidden();
});

/**
 * Gives the first Clip's Concept a title too long for two lines of the tag, and returns its tag.
 */
async function longTag(page: Page, server: Awaited<ReturnType<typeof startServer>>) {
  const [first] = server.data.db.select().from(clips).orderBy(clips.id).all();
  server.data.db
    .update(concepts)
    .set({
      title: "A Concept whose title runs on and on, far longer than one line of the tag can hold, and then some more",
    })
    .where(eq(concepts.id, first.conceptId))
    .run();
  await openFeed(page);
  return slides(page)
    .nth(0)
    .locator("div", { hasText: /^New ·/ });
}

test("the tag sits bottom left, below the captions and clear of the rail; a long one stops at two lines", async ({
  page,
  server,
}) => {
  const tag = await (await longTag(page, server)).boundingBox();
  const rail = await slides(page).nth(0).locator("[data-button]").first().boundingBox();
  // The cover-fit 1080x1920 video fills the 915 px height: the captions end at y 1650, the clear strip starts at 1700.
  expect(tag!.y).toBeGreaterThan((915 * 1700) / 1920);
  expect(tag!.y + tag!.height).toBeLessThan(915);
  expect(tag!.x).toBe(12);
  expect(tag!.x + tag!.width).toBeLessThan(rail!.x);
  // Two 16 px lines and their padding.
  expect(tag!.height).toBe(40);
});

test("a long tag clips at exactly two lines, so no part of a third shows in the padding", async ({ page, server }) => {
  const tag = await longTag(page, server);
  // The box that clips the clamped text holds two 16 px lines and no padding below them for a third to show in.
  const clipHeight = await tag.evaluate(
    (el) =>
      [el, ...el.querySelectorAll("*")].find((node) => getComputedStyle(node).webkitLineClamp === "2")!.clientHeight,
  );
  expect(clipHeight).toBe(32);
});

test("a short tag has no more", async ({ page }) => {
  await openFeed(page);
  await expect(slides(page).nth(0)).toContainText("New · Threads · book · concrete example");
  await expect(slides(page).nth(0).getByText("more", { exact: true })).toHaveCount(0);
});

test("more opens a long tag upward over the captions; a tap on it or the next Clip closes it", async ({
  page,
  server,
}) => {
  const tag = await longTag(page, server);
  const closed = (await tag.boundingBox())!;
  await page.touchscreen.tap(150, 600);
  await expect(page.getByText("Tap for sound 🔊")).toBeHidden();

  await tag.getByText("more", { exact: true }).tap();
  await expect(tag.getByText("more", { exact: true })).toBeHidden();
  await expect(tag).toContainText("and then some more · book · concrete example");
  const open = (await tag.boundingBox())!;
  expect(open.height).toBeGreaterThan(closed.height);
  expect(open.y + open.height).toBeCloseTo(closed.y + closed.height, 0);
  // The tap was not the video's: the Clip still plays.
  expect(await paused(page, 0)).toBe(false);
  await page.screenshot({ path: test.info().outputPath("tag-open.png") });

  await tag.tap();
  await expect.poll(async () => (await tag.boundingBox())!.height).toBe(40);
  await expect(tag.getByText("more", { exact: true })).toBeVisible();
  expect(await paused(page, 0)).toBe(false);
  await page.screenshot({ path: test.info().outputPath("tag-closed.png") });

  await tag.getByText("more", { exact: true }).tap();
  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  await page.mouse.wheel(0, -600);
  await playing(page, 0);
  await expect.poll(async () => (await tag.boundingBox())!.height).toBe(40);
});

test("a paused Clip's speed chip sits between the tag and the line, with the tag closed or open", async ({
  page,
  server,
}) => {
  const tag = await longTag(page, server);
  const speed = chip(slides(page).nth(0));
  const line = slides(page).nth(0).locator("[data-scrub]");
  // The first tap unmutes; the second pauses.
  await page.touchscreen.tap(150, 600);
  await page.touchscreen.tap(150, 600);
  // The Pixel 4 app, then about a Pixel 4 in a Chrome tab, where 11% of the height is less room.
  for (const height of [915, 732]) {
    await page.setViewportSize({ width: 412, height });
    for (const open of [false, true]) {
      if (open) await tag.getByText("more", { exact: true }).tap();
      await expect(speed).toBeVisible();
      const [chipBox, tagBox, lineBox] = await Promise.all(
        [speed, tag, line].map(async (l) => (await l.boundingBox())!),
      );
      expect(chipBox.y).toBeGreaterThanOrEqual(tagBox.y + tagBox.height);
      expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(lineBox.y);
    }
    // A tap on the open tag closes it.
    await tag.tap();
  }
});

test("a long-press on the tag hides the overlays and doesn't open it", async ({ page, server }) => {
  const tag = await longTag(page, server);
  const box = (await tag.boundingBox())!;
  await longPress(page, box.x + 20, box.y + 10);
  await expect(tag).toHaveCSS("opacity", "0");
  await expect(slides(page).nth(0).locator("div:has(> [data-button])")).toHaveCSS("opacity", "0");
  expect((await tag.boundingBox())!.height).toBe(40);
});

test("a long-press hides the rail and tag on that Clip only, until it leaves the screen", async ({ page }) => {
  await openFeed(page);
  await longPress(page);

  await expect(slides(page).nth(0).locator("div:has(> [data-button])")).toHaveCSS("opacity", "0");
  await expect(
    slides(page)
      .nth(0)
      .locator("div", { hasText: /^New ·/ }),
  ).toHaveCSS("opacity", "0");
  // Lifting the finger doesn't pause the Clip.
  expect(await paused(page, 0)).toBe(false);
  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  await expect(slides(page).nth(1).locator("div:has(> [data-button])")).toHaveCSS("opacity", "1");
  await page.mouse.wheel(0, -600);
  await playing(page, 0);
  await expect(slides(page).nth(0).locator("div:has(> [data-button])")).toHaveCSS("opacity", "1");
});

test("sound starts muted; the first tap unmutes for the session without pausing the Clip", async ({ page }) => {
  await openFeed(page);
  await expect(page.getByText("Tap for sound 🔊")).toBeVisible();
  expect(await video(page, 0).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);

  await page.touchscreen.tap(150, 600);
  await expect(page.getByText("Tap for sound 🔊")).toBeHidden();
  expect(await video(page, 0).evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  expect(await paused(page, 0)).toBe(false);
  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  expect(await video(page, 1).evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
});

test("a button records the press and moves on to the next Clip about 0.35 s later", async ({ page, server }) => {
  await openFeed(page);
  const pressedAt = Date.now();
  await press(page, 0, "🤔");
  await expect(slides(page).nth(1)).not.toBeInViewport();
  await expect(slides(page).nth(1)).toBeInViewport({ ratio: 1 });
  expect(Date.now() - pressedAt).toBeGreaterThanOrEqual(350);
  await playing(page, 1);

  await expect
    .poll(() =>
      server.data.db
        .select()
        .from(events)
        .all()
        .map((event) => [event.clipId, event.kind]),
    )
    .toEqual([[1, "didnt_get"]]);
});

test("at its end a Clip counts as seen once, loops, and after 3 loops nudges to scroll on", async ({
  page,
  server,
}) => {
  await openFeed(page);
  // 2 s Clips: three ends take about 6 s.
  await expect(page.getByText("↑ That’s the end, swipe up for the next one")).toBeVisible({ timeout: 15_000 });
  expect(await paused(page, 0)).toBe(false);

  const seen = server.data.db.select().from(events).where(eq(events.kind, "seen")).all();
  expect(seen.map((event) => event.clipId)).toEqual([1]);
});

test("🚩 asks for a reason and a note, then hides the Clip and logs it to the inbox", async ({ page, server }) => {
  await openFeed(page);
  await press(page, 0, "🚩");
  await expect(page.getByText("🚩 What’s wrong in “Threads”?")).toBeVisible();
  await page.getByRole("button", { name: "Pronunciation" }).click();
  await page.getByPlaceholder("Optional note").fill("mutex came out wrong");
  await page.getByRole("button", { name: "Hide this Clip and log it" }).click();

  await playing(page, 1);
  await expect
    .poll(() =>
      server.data.db
        .select()
        .from(events)
        .all()
        .map(({ kind, reason, note }) => [kind, reason, note]),
    )
    .toEqual([["flag", "Pronunciation", "mutex came out wrong"]]);
  await expect(page.locator("nav span")).toHaveText("1");
});

test("closing the 🚩 sheet, by tapping outside or by back, records nothing", async ({ page, server }) => {
  await openFeed(page);
  await press(page, 0, "🚩");
  await page.touchscreen.tap(200, 100);
  await expect(page.getByText("🚩 What’s wrong")).toBeHidden();
  await press(page, 0, "🚩");
  await page.goBack();
  await expect(page.getByText("🚩 What’s wrong")).toBeHidden();

  await expect(page).toHaveURL(/\/$/);
  expect(server.data.db.select().from(events).all()).toEqual([]);
  // The press was cancelled, so the rail still works.
  await press(page, 0, "✅");
  await playing(page, 1);
});

test("a sideways swipe pauses the Clip and shows its Passage with its place; another swipe goes back", async ({
  page,
}) => {
  await openFeed(page);
  const passage = slides(page).nth(0).locator("aside");
  await swipe(page, -200);
  await expect(passage).toBeInViewport();
  await expect(passage).toContainText("book · Concurrency");
  expect(await paused(page, 0)).toBe(true);

  await swipe(page, 200);
  await expect(passage).not.toBeInViewport();
  await playing(page, 0);
});

test("the Passage is a history entry: back closes it and the Clip plays on", async ({ page }) => {
  await openFeed(page);
  const passage = slides(page).nth(0).locator("aside");
  await swipe(page, -200);
  await expect(passage).toBeInViewport();

  await page.goBack();
  await expect(passage).not.toBeInViewport();
  await expect(page).toHaveURL(/\/$/);
  await playing(page, 0);
});

test("Search, Sources and the inbox open over the Feed and pause it; back returns to the same Clip", async ({
  page,
}) => {
  await openFeed(page);
  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  const scrollTop = () => page.locator("main").evaluate((main) => main.scrollTop);
  await expect.poll(scrollTop).toBe(915);
  for (const [icon, title] of [
    ["🔍", "Search"],
    ["📚", "Sources"],
    ["📥", "Inbox"],
  ]) {
    await page.locator("nav button", { hasText: icon }).click();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    expect(await paused(page, 1)).toBe(true);
    await page.getByRole("button", { name: "←" }).click();
    await playing(page, 1);
    expect(await scrollTop()).toBe(915);
  }
});

test("a screen closed with back resumes the Clip where it was, keeping its loop count", async ({ page }) => {
  await openFeed(page);
  await video(page, 0).evaluate((v: HTMLVideoElement) => {
    v.dataset.ends = "0";
    v.addEventListener("ended", () => (v.dataset.ends = String(Number(v.dataset.ends) + 1)));
  });
  // 2 s Clips: two ends take about 4 s, so the third, and the nudge, is one loop away. Half a second into it, a
  // restarted Clip would show as an earlier position.
  await expect
    .poll(() => video(page, 0).evaluate((v: HTMLVideoElement) => v.dataset.ends === "2" && v.currentTime > 0.5), {
      timeout: 10_000,
    })
    .toBe(true);
  await page.locator("nav button", { hasText: "🔍" }).click();
  const position = await video(page, 0).evaluate((v: HTMLVideoElement) => v.currentTime);

  await page.goBack();
  await playing(page, 0);
  expect(await video(page, 0).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(position);
  await expect(page.getByText("↑ That’s the end, swipe up for the next one")).toBeVisible({ timeout: 3000 });
});

test('the honest end: "Done for today" with counts, buffer, tomorrow, no early Reviews, and the inbox', async ({
  page,
}) => {
  await openFeed(page);
  await press(page, 0, "✅");
  await playing(page, 1);
  await press(page, 1, "🚩");
  await page.getByRole("button", { name: "Hide this Clip and log it" }).click();
  await playing(page, 2);
  await press(page, 2, "⏭️");

  const done = page.locator("main > section:last-child");
  await expect(done).toContainText("Done for today 🌙");
  await expect(done).toContainText("Today: ✅ 1 · 🤔 0 · ⏭️ 1 · 🚩 1");
  await expect(done).toContainText("Generating 0 · buffer 0/10");
  await expect(done).toContainText("Tomorrow: 1 Review due.");
  await expect(done).toContainText("No early Reviews, on purpose.");
  await expect(done).toContainText("📥 1 to look at");
  await expect(done).toContainText("1 🚩 · 0 not landing · 0 stuck");
  await done.getByRole("button", { name: "Open inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("at an empty next, the Done screen fetches the Worker status once and says why no new Clips are coming", async ({
  page,
  server,
}) => {
  const feed = createFeed(server.data);
  for (const clip of server.data.db.select().from(clips).all()) feed.press(clip.id, "got_it", `e${clip.id}`);
  const until = new Date(Date.now() + 3_600_000);
  await writeFile(
    join(server.data.home, "config.json"),
    JSON.stringify({ worker: { pausedUntil: until.toISOString() } }),
  );
  let fetched = 0;
  page.on("request", (request) => request.url().endsWith("/api/status") && fetched++);
  await page.goto("/");

  const done = page.locator("main > section:last-child");
  await expect(done).toContainText(`No new Clips: Worker pause until ${until.toTimeString().slice(0, 5)}`);
  // One fetch for the ⚙️ dot at startup, one for the Done screen; nothing polls. In 3.5 s a poll at
  // Sources' 3 s interval would have fired.
  await page.waitForTimeout(3500);
  expect(fetched).toBe(2);
});
