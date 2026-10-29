import type { Locator, Page } from "@playwright/test";
import { createFeed } from "@doomlearn/core/feed";
import { chip, expect, longPress, openFeed, paused, playing, slides, swipe, test, video } from "./fixtures.ts";

//
// Playback controls in every player: the scrub line, the speed chip, and the Skipped pass in the Feed.
//

const time = (page: Page, n: number) => video(page, n).evaluate((v: HTMLVideoElement) => v.currentTime);
/** The `n`th Clip's scrub line. */
const line = (page: Page, n: number) => slides(page).nth(n).locator("[data-scrub]");
/**
 * The elapsed / total label of a 2 s Clip.
 */
const clock = (page: Page) => page.getByText(/^0:0\d \/ 0:02$/);
/** The `n`th Clip's rail. */
const rail = (page: Page, n: number) => slides(page).nth(n).locator("div:has(> [data-button])");

/**
 * A finger drag along a scrub `line`, from `from` to `to` (fractions of its width), through real touch events. `during`
 * runs with the finger still down at `to`. The finger rests there before lifting: let go mid-move, Linux Chromium flings,
 * and the next tap only stops the fling, with no click.
 */
async function scrub(page: Page, line: Locator, from: number, to: number, during?: () => Promise<void>) {
  const box = (await line.boundingBox())!;
  const at = (fraction: number) => ({ x: box.x + box.width * fraction, y: box.y + box.height / 2 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(from)] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [at(from + ((to - from) * step) / 8)],
    });
  }
  await during?.();
  await page.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("dragging the line scrubs with the Clip paused and the time shown, without opening the Passage or hiding the overlays", async ({
  page,
}) => {
  await openFeed(page);
  await expect(line(page, 0)).toBeVisible();
  await expect(clock(page)).toBeHidden();

  await scrub(page, line(page, 0), 0.1, 0.8, async () => {
    expect(await paused(page, 0)).toBe(true);
    expect(await time(page, 0)).toBeCloseTo(1.6, 0);
    await expect(clock(page)).toHaveText("0:01 / 0:02");
    // Held still past the long-press time: the overlays stay.
    await page.waitForTimeout(700);
  });
  await expect(clock(page)).toBeHidden();
  // It was playing, so it plays on.
  await playing(page, 0);
  await expect(slides(page).nth(0).locator("aside")).not.toBeInViewport();
  await expect(rail(page, 0)).toHaveCSS("opacity", "1");
  await page.screenshot({ path: test.info().outputPath("scrubbed.png") });

  await swipe(page, -200);
  await expect(slides(page).nth(0).locator("aside")).toBeInViewport();
});

test("a long-press hides the line with the rail", async ({ page }) => {
  await openFeed(page);
  await longPress(page);
  await expect(rail(page, 0)).toHaveCSS("opacity", "0");
  await expect(line(page, 0)).toHaveCSS("opacity", "0");
});

/**
 * Counts the `n`th Clip's ends in `data-ends`, and returns a reader of it.
 */
async function countEnds(page: Page, n: number) {
  await video(page, n).evaluate((v: HTMLVideoElement) => {
    v.dataset.ends = "0";
    v.addEventListener("ended", () => (v.dataset.ends = String(Number(v.dataset.ends) + 1)));
  });
  return () => video(page, n).evaluate((v: HTMLVideoElement) => Number(v.dataset.ends));
}

/**
 * Collects the /api/seen requests the page sends.
 */
function seenRequests(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => request.url().endsWith("/api/seen") && sent.push(request.postData() ?? ""));
  return sent;
}

test("a forward drag to the end skips the Pass: no seen and no loop; the next full Pass sends the one implicit ✅", async ({
  page,
}) => {
  const seen = seenRequests(page);
  await openFeed(page);
  const ends = await countEnds(page, 0);
  await scrub(page, line(page, 0), 0.05, 1);

  await expect.poll(ends).toBe(1);
  // The one seen comes at the end of the first full Pass, the 2nd end, not at the skipped one 2 s before it.
  await expect.poll(async () => [seen.length, await ends()]).toEqual([1, 2]);
  // 2 s Clips: three counted ends after the skipped one take about 6 s; the nudge comes at the 4th end, not the 3rd.
  const nudge = page.getByText("↑ That’s the end, swipe up for the next one");
  await expect.poll(async () => [await nudge.isVisible(), await ends()], { timeout: 15_000 }).toEqual([true, 4]);
  expect(seen).toHaveLength(1);
});

test("a backward scrub then a full Pass to the end sends exactly one implicit ✅", async ({ page }) => {
  const seen = seenRequests(page);
  await openFeed(page);
  const ends = await countEnds(page, 0);
  await expect.poll(() => time(page, 0)).toBeGreaterThan(1);
  await scrub(page, line(page, 0), 0.6, 0.05);

  await expect.poll(ends).toBe(1);
  await expect.poll(() => seen.length).toBe(1);
  await expect.poll(ends).toBe(2);
  expect(seen).toHaveLength(1);
});

/**
 * Unmutes with a first tap, then pauses the first Clip with a second.
 */
async function pauseFirst(page: Page) {
  await page.touchscreen.tap(150, 600);
  await page.touchscreen.tap(150, 600);
  expect(await paused(page, 0)).toBe(true);
}

test("a drag released in the first 1 s clears a Skipped pass: the restarted Pass sends its implicit ✅ at its first end", async ({
  page,
}) => {
  const seen = seenRequests(page);
  await openFeed(page);
  const ends = await countEnds(page, 0);
  await pauseFirst(page);
  await scrub(page, line(page, 0), 0.05, 1);
  await scrub(page, line(page, 0), 1, 0.1);
  await page.touchscreen.tap(150, 600);

  // Still skipped, the seen would come at the 2nd end instead.
  await expect.poll(async () => [seen.length, await ends()]).toEqual([1, 1]);
});

test("a paused Clip dragged to the end stays paused and sends no seen", async ({ page }) => {
  const seen = seenRequests(page);
  await openFeed(page);
  await pauseFirst(page);

  await scrub(page, line(page, 0), 0.1, 1);
  await page.waitForTimeout(1000);
  expect(await paused(page, 0)).toBe(true);
  // Clamped short of the end, so no end fires.
  const [t, d] = await video(page, 0).evaluate((v: HTMLVideoElement) => [v.currentTime, v.duration]);
  expect(t).toBeCloseTo(d - 0.1, 1);
  expect(seen).toEqual([]);
});

const rate = (page: Page, n: number) =>
  video(page, n).evaluate((v: HTMLVideoElement) => [v.playbackRate, v.defaultPlaybackRate]);

test("the speed chip shows only while paused, cycles 1x to 2x without resuming, and holds on the next Clip and after reload", async ({
  page,
}) => {
  await openFeed(page);
  await expect(chip(slides(page).nth(0))).toBeHidden();
  await pauseFirst(page);
  await expect(chip(slides(page).nth(0))).toHaveText("1x");
  await page.screenshot({ path: test.info().outputPath("paused-chip.png") });

  for (const speed of ["1.25x", "1.5x", "2x", "1x", "1.25x", "1.5x"]) {
    await chip(slides(page).nth(0)).tap();
    await expect(chip(slides(page).nth(0))).toHaveText(speed);
    expect(await paused(page, 0)).toBe(true);
  }
  expect(await rate(page, 0)).toEqual([1.5, 1.5]);
  await page.touchscreen.tap(150, 600);
  await playing(page, 0);
  await expect(chip(slides(page).nth(0))).toBeHidden();

  await page.mouse.wheel(0, 600);
  await playing(page, 1);
  expect(await rate(page, 1)).toEqual([1.5, 1.5]);

  await page.reload();
  await playing(page, 0);
  expect(await rate(page, 0)).toEqual([1.5, 1.5]);
});

test.describe("with localStorage throwing", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException("denied", "SecurityError");
      };
      Storage.prototype.setItem = () => {
        throw new DOMException("denied", "SecurityError");
      };
    });
  });

  test("Clips play at 1x, the chip and the implicit ✅ still work, and no console error appears", async ({ page }) => {
    const seen = seenRequests(page);
    await openFeed(page);
    expect(await rate(page, 0)).toEqual([1, 1]);
    await pauseFirst(page);
    await chip(slides(page).nth(0)).tap();
    await expect(chip(slides(page).nth(0))).toHaveText("1.25x");
    expect(await rate(page, 0)).toEqual([1.25, 1.25]);

    await page.touchscreen.tap(150, 600);
    await expect.poll(() => seen.length).toBe(1);

    await page.reload();
    await playing(page, 0);
    expect(await rate(page, 0)).toEqual([1, 1]);
  });
});

test("no native controls, double-tap, hold or mute button: they change neither the speed nor the position", async ({
  page,
}) => {
  await openFeed(page);
  await expect(page.locator("video[controls]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /mute|🔇|🔊/i })).toHaveCount(0);
  await pauseFirst(page);
  const at = await time(page, 0);

  // A double-tap is two taps: play, then pause, with no skip.
  await page.touchscreen.tap(150, 600);
  await page.touchscreen.tap(150, 600);
  expect(await paused(page, 0)).toBe(true);
  expect(await time(page, 0)).toBeCloseTo(at, 0);
  expect(await rate(page, 0)).toEqual([1, 1]);

  // A hold on a playing Clip: no hold-for-2x, and no skip.
  await page.touchscreen.tap(150, 600);
  await playing(page, 0);
  await longPress(page, 150, 600, async () => {
    expect(await rate(page, 0)).toEqual([1, 1]);
    expect(await time(page, 0)).toBeLessThan(at + 1.5);
  });
  expect(await rate(page, 0)).toEqual([1, 1]);
});

/**
 * In the Search or Inbox player: the line and chip, tap-to-pause and resume, a scrub, and no seen after a loop.
 */
async function checkPlayer(page: Page, seen: string[]) {
  const player = page.getByTestId("player");
  const clip = player.locator("video");
  await expect(clip).not.toHaveAttribute("controls");
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0)).toBe(true);
  await expect(player.locator("[data-scrub]")).toBeVisible();
  const speed = chip(player);
  await expect(speed).toBeHidden();

  await clip.tap();
  expect(await clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await speed.tap();
  await expect(speed).toHaveText("1.25x");
  expect(await clip.evaluate((v: HTMLVideoElement) => [v.paused, v.playbackRate])).toEqual([true, 1.25]);
  await scrub(page, player.locator("[data-scrub]"), 0.1, 0.8, async () => {
    await expect(clock(page)).toHaveText("0:01 / 0:02");
  });
  expect(await clip.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1.6, 0);
  await page.screenshot({ path: test.info().outputPath("player.png") });

  // Counts the loops: a looping video fires no ended, so a loop is currentTime going back.
  await clip.evaluate((v: HTMLVideoElement) => {
    let last = v.currentTime;
    v.dataset.loops = "0";
    v.addEventListener("timeupdate", () => {
      if (v.currentTime < last) v.dataset.loops = String(Number(v.dataset.loops) + 1);
      last = v.currentTime;
    });
  });
  await clip.tap();
  await expect(speed).toBeHidden();
  // Past one loop, which the Feed would count as seen.
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => Number(v.dataset.loops))).toBeGreaterThan(0);
  expect(await clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  expect(seen).toEqual([]);
}

test("the Search player plays at the speed chosen in the Feed", async ({ page }) => {
  await openFeed(page);
  await pauseFirst(page);
  await chip(slides(page).nth(0)).tap();
  await chip(slides(page).nth(0)).tap();
  await expect(chip(slides(page).nth(0))).toHaveText("1.5x");
  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();
  const clip = page.getByTestId("player").locator("video");
  await expect
    .poll(() => clip.evaluate((v: HTMLVideoElement) => [!v.paused, v.playbackRate, v.defaultPlaybackRate]))
    .toEqual([true, 1.5, 1.5]);
});

test("the Search player has the same line and chip, pauses and resumes on tap, and sends no seen", async ({ page }) => {
  const seen = seenRequests(page);
  await openFeed(page);
  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();
  await checkPlayer(page, seen);
});

test("the Inbox player has the same line and chip, pauses and resumes on tap, and sends no seen", async ({
  page,
  server,
}) => {
  createFeed(server.data).press(1, "flag", "f1", { reason: "Pronunciation" });
  const seen = seenRequests(page);
  await openFeed(page);
  await page.locator("nav button", { hasText: "📥" }).click();
  await page.getByRole("button", { name: "▶ View Clip" }).click();
  await checkPlayer(page, seen);
});
