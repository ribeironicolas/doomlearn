import type { Page } from "@playwright/test";
import type { Data } from "@doomlearn/core/data";
import { events } from "@doomlearn/core/schema";
import { expect, openFeed, playing, test } from "./fixtures.ts";

//
// Offline: the cached buffer, Range from cache, and v1's press queue and handled set, with their v1 keys and shapes.
//

/**
 * The browser's own errors for requests to a Mac that refuses connections.
 */
const UNREACHABLE = /Failed to load resource|ERR_CONNECTION_REFUSED/;

/**
 * Waits until the service worker controls the page, so it can answer with the Mac gone, and every upcoming Clip is in
 * the `clips` cache.
 */
async function buffered(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open("clips")).keys()).map((r) => r.url).length))
    .toBe(count);
}

const storage = (page: Page, key: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
const eventIds = (server: { data: Data }) =>
  server.data.db
    .select()
    .from(events)
    .all()
    .map((event) => event.clientEventId);

test("a Clip gets its source once it's buffered, so it never reads from the network and then the cache", async ({
  page,
  context,
}) => {
  // Holds the buffer's full download of the first Clip; a Range request (the video's own) passes.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await context.route("**/clips/1-*", async (route) => {
    if (!route.request().headers().range) await held;
    await route.continue();
  });
  const buffering = context.waitForEvent("request", (r) => r.url().includes("/clips/1-") && !r.headers().range);
  await page.goto("/");
  await buffering;

  const video = page.locator("section[data-clip] video").first();
  await expect(video).not.toHaveAttribute("src");
  release();
  await expect(video).toHaveAttribute("src", /\/clips\/1-/);
  await playing(page, 0);
});

test.describe("with the Mac unreachable", () => {
  test.use({ expectedErrors: UNREACHABLE });

  test("the app opens and the cached buffer plays", async ({ page, server }) => {
    await openFeed(page);
    await buffered(page, 3);
    await server.stop();

    // Launching the app again: the shell comes from the service worker, the Feed from the last good /api/next.
    await page.goto("/");
    await playing(page, 0);
    await expect(page.locator("section[data-clip]")).toHaveCount(3);
    await page.locator("section[data-clip]").nth(2).scrollIntoViewIfNeeded();
    await playing(page, 2);
  });

  test("the service worker answers a Range request for a buffered Clip from the cache", async ({ page, server }) => {
    await openFeed(page);
    await buffered(page, 3);
    await server.stop();

    const res = await page.evaluate(async () => {
      const r = await fetch("/clips/1-concrete_example-2.webm", { headers: { range: "bytes=0-99" } });
      return {
        status: r.status,
        range: r.headers.get("content-range"),
        type: r.headers.get("content-type"),
        bytes: (await r.arrayBuffer()).byteLength,
      };
    });
    expect(res).toEqual({ status: 206, range: "bytes 0-99/16993", type: "video/webm", bytes: 100 });
  });

  test("a press waits in the v1 queue and flushes once the Mac is back", async ({ page, server }) => {
    await openFeed(page);
    await server.stop();
    await page.locator("section[data-clip]").first().getByRole("button", { name: "✅" }).click();
    await playing(page, 1);

    const [queued] = await storage(page, "queue");
    expect(queued).toEqual({
      path: "/api/press",
      body: { clipId: 1, button: "got_it", clientEventId: expect.any(String) },
    });
    expect(await storage(page, "handled")).toEqual([1]);

    await server.resume();
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect.poll(() => eventIds(server)).toEqual([queued.body.clientEventId]);
    expect(await storage(page, "queue")).toEqual([]);
  });

  test("a queued press is retried every 30 s", async ({ page, server }) => {
    await page.clock.install();
    await openFeed(page);
    await server.stop();
    await page.locator("section[data-clip]").first().getByRole("button", { name: "✅" }).click();
    await playing(page, 1);
    const [queued] = await storage(page, "queue");

    await server.resume();
    expect(eventIds(server)).toEqual([]);
    await page.clock.runFor(30_000);
    await expect.poll(() => eventIds(server)).toEqual([queued.body.clientEventId]);
  });

  test("a queued press flushes, in order, with the next press", async ({ page, server }) => {
    await openFeed(page);
    await server.stop();
    await page.locator("section[data-clip]").nth(0).getByRole("button", { name: "✅" }).click();
    await playing(page, 1);
    const [first] = await storage(page, "queue");

    await server.resume();
    await page.locator("section[data-clip]").nth(1).getByRole("button", { name: "🤔" }).click();
    await expect.poll(() => eventIds(server)).toEqual([first.body.clientEventId, expect.any(String)]);
    expect(
      server.data.db
        .select()
        .from(events)
        .all()
        .map((event) => event.kind),
    ).toEqual(["got_it", "didnt_get"]);
  });

  test("the Done screen keeps the last synced numbers and counts the presses waiting", async ({ page, server }) => {
    await openFeed(page);
    await page.locator("section[data-clip]").nth(0).getByRole("button", { name: "✅" }).click();
    await playing(page, 1);
    const done = page.locator("main > section:last-child");
    await done.scrollIntoViewIfNeeded();
    await expect(done).toContainText("Today: ✅ 1 · 🤔 0 · ⏭️ 0 · 🚩 0");

    await server.stop();
    await page.locator("section[data-clip]").nth(2).scrollIntoViewIfNeeded();
    await playing(page, 2);
    await page.locator("section[data-clip]").nth(2).getByRole("button", { name: "⏭️" }).click();
    await expect(done).toContainText("Mac unreachable: these numbers are from the last sync.");
    await expect(done).toContainText("Today: ✅ 1 · 🤔 0 · ⏭️ 0 · 🚩 0");
    await expect(done).toContainText("1 press waiting to sync.");
  });
});

test("with the Mac hanging, the Feed gives up after 5 s and opens on the last good list", async ({ page, server }) => {
  await openFeed(page);
  server.hang();

  const launched = Date.now();
  await page.goto("/");
  await expect(page.locator("section[data-clip]")).toHaveCount(3, { timeout: 10_000 });
  expect(Date.now() - launched).toBeGreaterThanOrEqual(5000);
  await playing(page, 0);
});

test("with Cache Storage refused, the Feed still plays from the Mac and reaches the Done screen", async ({ page }) => {
  // A private window or a full quota: the page can't open its caches.
  await page.addInitScript(() => {
    CacheStorage.prototype.open = () => Promise.reject(new DOMException("refused", "SecurityError"));
  });
  await openFeed(page);
  const done = page.locator("main > section:last-child");
  await done.scrollIntoViewIfNeeded();
  await expect(done).toContainText("Today: ✅ 0 · 🤔 0 · ⏭️ 0 · 🚩 0");
});

test("the service worker deletes v1's shell cache when it takes over", async ({ page }) => {
  // A page of the origin with no service worker yet, holding the cache v1's worker left.
  await page.goto("/api/today");
  await page.evaluate(async () => (await caches.open("shell")).put("/", new Response("v1")));

  await openFeed(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => caches.has("shell"))).toBe(false);
});

test("presses the v1 app queued offline flush on the first launch, and the handled Clips stay out", async ({
  page,
  server,
}) => {
  // As the v1 app left them: a press and a watch not synced yet.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "queue",
      JSON.stringify([
        { path: "/api/press", body: { clipId: 1, button: "got_it", clientEventId: "v1-press" } },
        { path: "/api/seen", body: { clipId: 2, completed: true, clientEventId: "v1-seen" } },
      ]),
    );
    localStorage.setItem("handled", JSON.stringify([1, 2]));
  });
  await openFeed(page);

  expect(eventIds(server)).toEqual(["v1-press", "v1-seen"]);
  await expect(page.locator("section[data-clip]")).toHaveCount(1);
  await expect(page.locator("section[data-clip]")).toContainText("Review · 3d · Pointers");
  expect([await storage(page, "queue"), await storage(page, "handled")]).toEqual([[], []]);
});

test("with localStorage full, a queued press is sent once and a new press still reaches the Mac", async ({
  page,
  server,
}) => {
  // A press left in the queue, then a full origin: reads work, every write throws.
  await page.addInitScript(() => {
    localStorage.setItem(
      "queue",
      JSON.stringify([{ path: "/api/press", body: { clipId: 1, button: "got_it", clientEventId: "kept" } }]),
    );
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  const presses: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/press") && presses.push(r.postData() ?? ""));
  await openFeed(page);
  await expect.poll(() => eventIds(server)).toEqual(["kept"]);

  await page.locator("section[data-clip]").nth(0).getByRole("button", { name: "🤔" }).click();
  await expect.poll(() => eventIds(server)).toEqual(["kept", expect.any(String)]);
  await page.waitForTimeout(500);
  expect(presses).toHaveLength(2);
});

test.describe("a press the Mac rejects", () => {
  test.use({ expectedErrors: /press rejected|Failed to load resource.*400/ });

  test("is dropped, and the queue goes on", async ({ page, server }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        "queue",
        JSON.stringify([
          { path: "/api/press", body: { clipId: 1, button: "shrug", clientEventId: "bad" } },
          { path: "/api/press", body: { clipId: 1, button: "know", clientEventId: "good" } },
        ]),
      );
    });
    await openFeed(page);

    expect(eventIds(server)).toEqual(["good"]);
    expect(await storage(page, "queue")).toEqual([]);
  });
});

test('a waiting version shows "New version · Reload" at the top without pausing the Clip; a tap applies it', async ({
  page,
  server,
}) => {
  await openFeed(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  server.bumpSw();
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());

  const toast = page.getByRole("button", { name: "New version · Reload" });
  await expect(toast).toBeVisible();
  expect((await toast.boundingBox())!.y).toBeLessThan(100);
  await page.waitForTimeout(500);
  expect(
    await page
      .locator("section[data-clip] video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(false);

  await Promise.all([page.waitForEvent("framenavigated"), toast.tap()]);
  await playing(page, 0);
  await expect(toast).toBeHidden();
});
