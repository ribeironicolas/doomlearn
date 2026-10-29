import { events } from "@doomlearn/core/schema";
import { expect, playing, test } from "./fixtures.ts";

//
// Cut-over: the server serves the built app at the v1 app's origin and service-worker path.
//

test("the server serves the built app: its page with an installable manifest, /sw.js and the icons", async ({
  page,
}) => {
  const html = await (await page.request.get("/")).text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  const sw = await page.request.get("/sw.js");
  expect(sw.headers()["content-type"]).toMatch(/^text\/javascript\b/);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status()).toBe(200);
});

test.describe("with the Mac unreachable for a while", () => {
  test.use({ expectedErrors: /Failed to load resource|ERR_CONNECTION_REFUSED/ });

  test("an installed v1 app picks up v2 through the update toast; a press it queued offline reaches the server", async ({
    page,
    server,
  }) => {
    // The v1 app, installed: its service worker controls the page and keeps the `shell` cache.
    server.serveLegacy(true);
    await page.goto("/");
    await expect(page.locator(".slide").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await server.stop();
    await page.locator(".slide").first().locator("[data-button=got_it]").click();
    const [queued] = await page.evaluate(() => JSON.parse(localStorage.getItem("queue") ?? "[]"));
    expect(queued.body.button).toBe("got_it");

    // Deployed: the Mac is back with v2. The first launch still runs v1 from its shell and installs v2's worker, which
    // waits; the next launch runs the v2 page, which offers the waiting version.
    server.serveLegacy(false);
    await server.resume();
    await page.reload();
    await expect
      .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting))
      .toBe(true);
    await page.reload();
    const toast = page.getByRole("button", { name: "New version · Reload" });
    await expect(toast).toBeVisible();
    await Promise.all([page.waitForEvent("framenavigated"), toast.tap()]);

    await expect(page.locator("section[data-clip]").first()).toBeVisible();
    await playing(page, 0);
    await expect.poll(() => page.evaluate(() => caches.has("shell"))).toBe(false);
    await expect
      .poll(() =>
        server.data.db
          .select()
          .from(events)
          .all()
          .map((event) => event.clientEventId),
      )
      .toEqual([queued.body.clientEventId]);
    expect(await page.evaluate(() => localStorage.getItem("queue"))).toBe("[]");
  });
});
