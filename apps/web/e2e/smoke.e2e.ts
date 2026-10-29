import { expect, openFeed, test } from "./fixtures.ts";

test("smoke: the Feed opens at phone size and plays its first Clip, with no console error", async ({ page }) => {
  await openFeed(page);
  await expect(page.getByText("New · Threads")).toBeVisible();

  await page.screenshot({ path: test.info().outputPath("smoke.png") });
});
