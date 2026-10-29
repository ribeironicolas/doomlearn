import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { startServer } from "./server.ts";

/**
 * Every test gets its own server on fakes and fails on any console error, except those matching its `expectedErrors`.
 */
export const test = base.extend<{
  server: Awaited<ReturnType<typeof startServer>>;
  expectedErrors: RegExp | null;
}>({
  expectedErrors: [null, { option: true }],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern.
  server: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.stop();
    await server.cleanup();
  },
  baseURL: async ({ server }, use) => use(server.url),
  page: async ({ page, expectedErrors }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors.filter((error) => !expectedErrors?.test(error))).toEqual([]);
  },
});

export { expect };

/**
 * The Feed's Clips, one section each.
 */
export const slides = (page: Page) => page.locator("section[data-clip]");
/** The full-screen Clip player. */
export const player = (page: Page) => page.getByTestId("player");
/** A speed chip inside `scope`. */
export const chip = (scope: Locator) => scope.getByRole("button", { name: /^[\d.]+x$/ });
/** The `n`th Clip's video. */
export const video = (page: Page, n: number) => slides(page).nth(n).locator("video");
/** Whether Clip `n` is paused. */
export const paused = (page: Page, n: number) => video(page, n).evaluate((v: HTMLVideoElement) => v.paused);

/**
 * Opens the Feed and waits for its first Clip to play.
 */
export async function openFeed(page: Page) {
  await page.goto("/");
  await expect(page.locator("section[data-clip]").first()).toBeVisible();
  await playing(page, 0);
}

/**
 * Waits until the `n`th Clip is playing: unpaused and past its first frame.
 */
export async function playing(page: Page, n: number) {
  await expect
    .poll(() =>
      page
        .locator("section[data-clip] video")
        .nth(n)
        .evaluate((video: HTMLVideoElement) => !video.paused && video.currentTime > 0),
    )
    .toBe(true);
}

/**
 * A finger swipe across the screen by `dx` pixels, through real touch events.
 */
export async function swipe(page: Page, dx: number) {
  const cdp = await page.context().newCDPSession(page);
  const [x, y] = [dx < 0 ? 350 : 50, 500];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx / 2, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * A finger held still on the Clip, at `x`, `y`, for 0.7 s. `during` runs with the finger still down.
 */
export async function longPress(page: Page, x = 150, y = 600, during?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await during?.();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
