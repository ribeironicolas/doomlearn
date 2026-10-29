import { defineConfig, devices } from "@playwright/test";

/**
 * Bundled Chromium as an Android phone at 412x915, the provisional viewport.
 * Each test starts its own server on fakes (e2e/fixtures.ts), so the specs run in parallel.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
});
