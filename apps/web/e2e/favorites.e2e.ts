import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { Data } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { createSources } from "@doomlearn/core/sources";
import { fakeMedia } from "@doomlearn/core/test/fakes";
import { chapters, clips, concepts, events, favorites, sources } from "@doomlearn/core/schema";
import { expect, openFeed, player, playing, slides, test } from "./fixtures.ts";

//
// Favorites: ⭐ on the Feed rail and in the Search player, online and offline, the Favorites screen and its player,
// Download and Share.
//

// The Clip ids the Mac holds as Favorites.
const kept = (server: { data: Data }) =>
  server.data.db
    .select()
    .from(favorites)
    .all()
    .map((row) => row.clipId);
/** The `n`th Clip's ⭐. */
const star = (page: Page, n: number) => slides(page).nth(n).locator("[data-button=favorite]");
// The scroll position of the Feed.
const feedTop = (page: Page) => page.locator("main").evaluate((main) => main.scrollTop);

test("⭐ on the rail fills at once and the Feed stays; a second tap removes it, and Undo brings it back", async ({
  page,
  server,
}) => {
  await openFeed(page);
  await expect(star(page, 0)).toHaveAttribute("aria-pressed", "false");

  await star(page, 0).click();
  await expect(star(page, 0)).toHaveAttribute("aria-pressed", "true");
  await expect(star(page, 0)).toContainText("⭐");
  await expect.poll(() => kept(server)).toEqual([1]);
  // Longer than a press's 0.35 s auto-advance.
  await page.waitForTimeout(800);
  expect(await feedTop(page)).toBe(0);
  await playing(page, 0);
  expect(server.data.db.select().from(events).all()).toEqual([]);

  await star(page, 0).click();
  await expect(star(page, 0)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Removed from Favorites · Undo")).toBeVisible();
  await expect.poll(() => kept(server)).toEqual([]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(star(page, 0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Removed from Favorites")).toBeHidden();
  await expect.poll(() => kept(server)).toEqual([1]);

  // A Favorite shows filled on the next launch.
  await page.reload();
  await expect(star(page, 0)).toHaveAttribute("aria-pressed", "true");
  await expect(star(page, 1)).toHaveAttribute("aria-pressed", "false");
});

test("⭐ in the Search player fills at once; a second tap removes it, and Undo brings it back", async ({
  page,
  server,
}) => {
  await openFeed(page);
  await page.locator("nav button", { hasText: "🔍" }).click();
  await page.getByPlaceholder("Search the captions").fill("cozinheiro");
  await page.locator("[data-hit]").first().click();
  const starred = player(page).locator("[data-button=favorite]");
  await expect(player(page).locator("small")).toHaveText(["didn’t get it", "wrong", "favorite", "language"]);

  await starred.click();
  await expect(starred).toHaveAttribute("aria-pressed", "true");
  await expect(player(page)).toBeVisible();
  await expect.poll(() => kept(server)).toEqual([1]);

  await starred.click();
  await expect(page.getByText("Removed from Favorites · Undo")).toBeVisible();
  await expect.poll(() => kept(server)).toEqual([]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(starred).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => kept(server)).toEqual([1]);
  expect(server.data.db.select().from(events).all()).toEqual([]);

  // Back in the Feed, with no reload, the same Clip's ⭐ is lit too.
  await page.goBack();
  await page.goBack();
  await expect(star(page, 0)).toHaveAttribute("aria-pressed", "true");
});

test.describe("with the Mac unreachable", () => {
  test.use({ expectedErrors: /Failed to load resource|ERR_CONNECTION_REFUSED/ });

  test("⭐ lights at once, the Clip stays in the Feed, and the Favorite reaches the Mac once it's back", async ({
    page,
    server,
  }) => {
    await openFeed(page);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await server.stop();

    await star(page, 0).click();
    await expect(star(page, 0)).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(800);
    expect(await feedTop(page)).toBe(0);
    // Favorites lists it before the Mac has it.
    await page.locator("nav button", { hasText: "⭐" }).click();
    await expect(page.locator("[data-favorite]")).toHaveText(["Threadsbook · concrete example · pt-BR"]);
    await page.goBack();

    // Launching again offline: the Clip is still upcoming, and its ⭐ still lit.
    await page.goto("/");
    await expect(slides(page)).toHaveCount(3);
    await expect(star(page, 0)).toHaveAttribute("aria-pressed", "true");
    expect(kept(server)).toEqual([]);

    await server.resume();
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect.poll(() => kept(server)).toEqual([1]);
    expect(server.data.db.select().from(events).all()).toEqual([]);
  });

  test("a Favorite plays and downloads from the phone's copy with the Mac off", async ({ page, server }) => {
    createFeed(server.data).favorite(2, true);
    await openFeed(page);
    await expect
      .poll(() => page.evaluate(async () => (await (await caches.open("favorites")).keys()).map((r) => r.url)))
      .toEqual([`${server.url}/clips/2-concrete_example-3.webm`]);
    // The Feed moves on: its buffer no longer holds the Favorite.
    await page.evaluate(async () => (await caches.open("clips")).delete("/clips/2-concrete_example-3.webm"));
    await page.locator("nav button", { hasText: "⭐" }).click();
    await expect(page.locator("[data-favorite]")).toHaveCount(1);
    await server.stop();

    await page.reload();
    await page.locator("[data-favorite]").click();
    await expect
      .poll(() =>
        player(page)
          .locator("video")
          .evaluate((v: HTMLVideoElement) => v.currentTime > 0),
      )
      .toBe(true);
    const [download] = await Promise.all([page.waitForEvent("download"), player(page).getByText("⬇️").click()]);
    expect(download.suggestedFilename()).toBe("mutexes-concrete_example-pt-BR.mp4");
    const [clip] = server.data.db.select().from(clips).where(eq(clips.id, 2)).all();
    expect(await readFile((await download.path())!)).toEqual(await readFile(clip.file));
  });
});

test("a Favorite whose Concept is Paused, by hand or through its chapter, says Paused; one whose Concept is Deleted stays and says Deleted", async ({
  page,
  server,
}) => {
  const { db } = server.data;
  /** The Concept titled `title`. */
  const concept = (title: string) => db.select().from(concepts).where(eq(concepts.title, title)).get()!;
  const feed = createFeed(server.data);
  for (const title of ["Threads", "Mutexes", "Pointers"])
    feed.favorite(
      db
        .select()
        .from(clips)
        .where(eq(clips.conceptId, concept(title).id))
        .get()!.id,
      true,
    );
  const sourcesModule = createSources(server.data, fakeMedia());
  sourcesModule.concept(concept("Threads").id, "pause");
  sourcesModule.concept(concept("Mutexes").id, "delete");
  await page.goto("/favorites");
  const rows = page.locator("[data-favorite]");
  await expect(rows).toHaveText([
    "Pointersbook · concrete example · pt-BR",
    "MutexesDeletedbook · concrete example · pt-BR",
    "ThreadsPausedbook · concrete example · pt-BR",
  ]);

  sourcesModule.chapter(db.select().from(chapters).get()!.id, "pause");
  await page.reload();
  await expect(rows).toHaveText([
    "PointersPausedbook · concrete example · pt-BR",
    "MutexesDeletedbook · concrete example · pt-BR",
    "ThreadsPausedbook · concrete example · pt-BR",
  ]);
});

test("the top-bar ⭐ opens Favorites newest first with chips; a 🚩 Favorite plays with ⭐, Download and Share only", async ({
  page,
  server,
}) => {
  await page.addInitScript(() => {
    navigator.canShare = () => true;
  });
  const feed = createFeed(server.data);
  feed.favorite(1, true);
  feed.favorite(3, true);
  // Clip 1 starred first, so the order is by time.
  server.data.db
    .update(favorites)
    .set({ createdAt: new Date(0) })
    .where(eq(favorites.clipId, 1))
    .run();
  feed.press(3, "flag", "flag-3", { reason: "Pronunciation" });
  server.data.db.update(concepts).set({ status: "retired", retiredReason: "known" }).where(eq(concepts.id, 1)).run();
  server.data.db.update(sources).set({ status: "paused" }).run();
  await openFeed(page);
  await expect(page.locator("nav button")).toHaveText(["🔍", "⭐", "📚", "📥1", "⚙️"]);

  await page.locator("nav button", { hasText: "⭐" }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  const rows = page.locator("[data-favorite]");
  await expect(rows).toHaveText([
    "PointersPaused🚩book · concrete example · pt-BR",
    "ThreadsRetiredPausedbook · concrete example · pt-BR",
  ]);
  await expect(rows.nth(0).locator("video")).toHaveAttribute("preload", "metadata");

  await rows.nth(0).click();
  await expect(player(page)).toContainText("Paused · 🚩 · Pointers · concrete example");
  await expect
    .poll(() =>
      player(page)
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.currentTime > 0),
    )
    .toBe(true);
  for (const button of ["✅", "🤔", "⏭️", "🚩"])
    await expect(player(page).getByRole("button", { name: button })).toHaveCount(0);
  await expect(player(page).locator("[data-button=favorite]")).toHaveAttribute("aria-pressed", "true");
  await expect(player(page).getByText("⬇️")).toBeVisible();
  await expect(player(page).getByRole("button", { name: "📤" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("favorites-player.png") });

  // Un-starred here, it leaves the list once the player closes.
  await player(page).locator("[data-button=favorite]").click();
  await expect(page.getByText("Removed from Favorites · Undo")).toBeVisible();
  await page.goBack();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => kept(server)).toEqual([1]);
  await page.screenshot({ path: test.info().outputPath("favorites.png") });
});

test("Download saves the stored Clip as <slug>-<angle>-<language>.mp4", async ({ page, server }) => {
  server.data.db.update(concepts).set({ title: "O que é uma Thread?" }).where(eq(concepts.id, 1)).run();
  server.data.db.update(clips).set({ language: "en" }).where(eq(clips.id, 1)).run();
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();

  const [download] = await Promise.all([page.waitForEvent("download"), player(page).getByText("⬇️").click()]);

  expect(download.suggestedFilename()).toBe("o-que-e-uma-thread-concrete_example-en.mp4");
  const [clip] = server.data.db.select().from(clips).where(eq(clips.id, 1)).all();
  expect(await readFile((await download.path())!)).toEqual(await readFile(clip.file));
});

test("Share is hidden where the browser can't share a file", async ({ page, server }) => {
  await page.addInitScript(() => {
    navigator.canShare = () => false;
  });
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();

  await expect(player(page).getByText("⬇️")).toBeVisible();
  await expect(player(page).getByRole("button", { name: "📤" })).toHaveCount(0);
});

test("Share sends the named mp4 alone, and a cancelled share says nothing", async ({ page, server }) => {
  await page.addInitScript(() => {
    navigator.canShare = () => true;
    navigator.share = async (data) => {
      const shared = (window as unknown as { shared: unknown[] }).shared;
      shared.push({ keys: Object.keys(data!), files: data!.files!.map((f) => [f.name, f.type, f.size]) });
      throw new DOMException("Share canceled", "AbortError");
    };
    (window as unknown as { shared: unknown[] }).shared = [];
  });
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();
  const [clip] = server.data.db.select().from(clips).where(eq(clips.id, 1)).all();
  const size = (await readFile(clip.file)).length;

  // The file is read as the player opens: Download then points at it.
  await expect(player(page).locator("a[download]")).toHaveAttribute("href", /^blob:/);
  await player(page).getByRole("button", { name: "📤" }).click();

  expect(await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared[0])).toEqual({
    keys: ["files"],
    files: [["threads-concrete_example-pt-BR.mp4", "video/mp4", size]],
  });
  await expect(page.getByText(/Share failed/)).toHaveCount(0);
});

test("a refused share says why", async ({ page, server }) => {
  await page.addInitScript(() => {
    navigator.canShare = () => true;
    navigator.share = async () => {
      throw new DOMException("x", "NotAllowedError");
    };
  });
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();
  await expect(player(page).locator("a[download]")).toHaveAttribute("href", /^blob:/);
  await player(page).getByRole("button", { name: "📤" }).click();

  await expect(page.getByText("Share failed: x")).toBeVisible();
});

test("a Clip over 50 MiB is not shared", async ({ page, server }) => {
  await page.addInitScript(() => {
    navigator.canShare = () => true;
    navigator.share = async () => {
      (window as unknown as { shared: boolean }).shared = true;
    };
    Object.defineProperty(File.prototype, "size", { get: () => 52_428_801 });
  });
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();
  await expect(player(page).locator("a[download]")).toHaveAttribute("href", /^blob:/);
  await player(page).getByRole("button", { name: "📤" }).click();

  await expect(page.getByText("Over 50 MiB: too large to share.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { shared?: boolean }).shared)).toBeUndefined();
});

test("📤 tapped before the file is read does nothing, then shares once it is", async ({ page, server }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { shared?: number; release: () => void };
    navigator.canShare = () => true;
    navigator.share = async () => {
      w.shared = (w.shared ?? 0) + 1;
    };
    // Reading the Clip from the cache waits until the test releases it.
    const held = new Promise<void>((resolve) => {
      w.release = resolve;
    });
    const match = CacheStorage.prototype.match;
    CacheStorage.prototype.match = async function (request, options) {
      if (String(request instanceof Request ? request.url : request).includes("/clips/")) await held;
      return match.call(this, request, options);
    };
  });
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();

  await expect(player(page).locator("a[download]")).toHaveAttribute("href", /^\/clips\//);
  await player(page).getByRole("button", { name: "📤" }).click();
  await page.waitForTimeout(500);
  // Counted once: a toast would be gone by itself before a retrying check gave up.
  expect(await page.getByText(/Mac unreachable/).count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { shared?: number }).shared)).toBeUndefined();

  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect(player(page).locator("a[download]")).toHaveAttribute("href", /^blob:/);
  await player(page).getByRole("button", { name: "📤" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared?: number }).shared)).toBe(1);
});

test("the phone asks for persistent storage once, not again when its Favorites come back", async ({ page, server }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { persisted?: number };
    navigator.storage.persist = async () => {
      w.persisted = (w.persisted ?? 0) + 1;
      return true;
    };
  });
  createFeed(server.data).favorite(1, true);
  await openFeed(page);
  /** The URLs in the phone's `favorites` cache. */
  const cachedFavorites = () =>
    page.evaluate(async () => (await (await caches.open("favorites")).keys()).map((r) => r.url));
  await expect.poll(cachedFavorites).toHaveLength(1);

  // Let go, the cache empties; kept again, it fills without a second ask.
  await star(page, 0).click();
  await expect.poll(cachedFavorites).toHaveLength(0);
  await star(page, 0).click();
  await expect.poll(cachedFavorites).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { persisted?: number }).persisted)).toBe(1);
});

test("a player closed while its file is still being read leaves no object URL behind", async ({ page, server }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { urls: { made: string[]; freed: string[] }; release: () => void };
    w.urls = { made: [], freed: [] };
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = (blob) => {
      const url = createObjectURL(blob);
      w.urls.made.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      w.urls.freed.push(url);
      revokeObjectURL(url);
    };
    // Reading the Clip from the cache waits until the test releases it.
    const held = new Promise<void>((resolve) => {
      w.release = resolve;
    });
    const match = CacheStorage.prototype.match;
    CacheStorage.prototype.match = async function (request, options) {
      if (String(request instanceof Request ? request.url : request).includes("/clips/")) await held;
      return match.call(this, request, options);
    };
  });
  createFeed(server.data).favorite(1, true);
  await page.goto("/favorites");
  await page.locator("[data-favorite]").click();
  await expect(player(page)).toBeVisible();

  await page.goBack();
  await expect(player(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.waitForTimeout(500);

  const { made, freed } = await page.evaluate(
    () => (window as unknown as { urls: { made: string[]; freed: string[] } }).urls,
  );
  expect(made.filter((url) => !freed.includes(url))).toEqual([]);
});
