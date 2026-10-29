// The phone check on the Android emulator.
//
//   node apps/web/scripts/phone-check.ts --home <temp-dir> [--serial emulator-5554] [--port 8443] [--standalone]
//     [--fake-media] [out-dir]
//
// Opens the Feed in the emulator's Chrome (with --standalone, the installed app), checks that a Clip plays, then runs
// each feature's checks with trusted touch input. It saves device screenshots in out-dir (default: a new temp folder,
// logged at start) and exits 1 on any console error, uncaught exception or failed check. While a check has the Mac's
// server stopped, "Failed to load resource: net::ERR_*" errors for the Mac's origin are expected: they are counted
// apart, logged as a total at the end, and do not fail the run.
//
// Needs a booted emulator (--serial picks it) and a built web app (`pnpm --filter @doomlearn/web build`). The script
// runs the doomlearn server itself, from this checkout on the DOOMLEARN_HOME given as --home, and stops it to cut the
// phone off. Feature checks change the Learner's data (seen events), so --home must be a temp copy, whose config.json
// listens on 127.0.0.1:<port> with the worker paused; the server's output goes to out-dir/server.log. The emulator
// always reaches it as http://localhost:8443 (adb reverse), so the origin, its storage and the installed app stay the
// same whatever the Mac port. With --fake-media, the worker speaks previews with the fake TTS (a silent wav) instead of
// the real one, so the check needs no TTS in memory next to the emulator. That worker still runs the real Agent port
// on the `claude` on PATH (apps/server/src/test/worker.ts): only the paused worker in config.json keeps it from
// spending real Claude usage.
// A new feature adds its checks as a section at the end, before "Done".
//
// The AVDs: Pixel_4_API_35 (Chrome 124) and R18_API_36 (Chrome 133). Boot one headless, on its own port so parallel
// runs never share one, and wait for sys.boot_completed:
//   ~/Library/Android/sdk/emulator/emulator -avd Pixel_4_API_35 -read-only -no-window -no-audio -port 5554 &
//   adb -s emulator-5554 wait-for-device   # then poll `adb -s emulator-5554 shell getprop sys.boot_completed` for 1
// --standalone needs the app on the home screen once per AVD (it survives reboots): open http://localhost:8443/ in
// Chrome, then Chrome's menu > Add to Home screen > Install > Add to home screen. Chrome makes a shortcut, not a WebAPK,
// and opens it standalone only with the shortcut's own webapp_mac extra, which the script reads from dumpsys shortcut.
// Afterwards: `adb -s <serial> emu kill`.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";

/**
 * The port the emulator reaches the server on, and the page origin it gives, the same whatever the Mac port.
 */
const DEVICE = { port: 8443, origin: "http://localhost:8443/" };
const { values: opts, positionals } = parseArgs({
  options: {
    serial: { type: "string", default: process.env.ANDROID_SERIAL },
    port: { type: "string", default: String(DEVICE.port) },
    standalone: { type: "boolean", default: false },
    "fake-media": { type: "boolean", default: false },
    home: { type: "string" },
  },
  allowPositionals: true,
});
if (!opts.home) {
  console.error("The checks record seen events. Pass --home <a temp DOOMLEARN_HOME> for the server to run on.");
  process.exit(1);
}
const home = opts.home;
// The fake-media worker runs the real Agent port on the `claude` on PATH: only a paused worker keeps it from calling.
if (opts["fake-media"] && JSON.parse(readFileSync(join(home, "config.json"), "utf8")).worker?.paused !== true) {
  console.error('--fake-media runs the real Agent port. Set "worker": {"paused": true} in --home\'s config.json.');
  process.exit(1);
}
const out = positionals[0] ?? mkdtempSync(join(tmpdir(), "phone-check-"));
mkdirSync(out, { recursive: true });
console.log(`screenshots in ${out}`);
const serial = opts.serial ? ["-s", opts.serial] : [];
/**
 * Runs adb on the chosen emulator.
 */
const adb = (...args: string[]) => execFileSync("adb", [...serial, ...args], { encoding: "utf8" });
/**
 * Waits `ms` milliseconds.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
/**
 * Logs a line stamped with the seconds since start.
 */
const log = (message: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`);
const errors: string[] = [];
const failures: string[] = [];
const ignored: string[] = [];
// While a check has the Mac's server stopped, the browser's own errors for the requests it refuses are expected.
const mac = { off: false };
/**
 * The Mac's server, which the script reaches directly.
 */
const server = `http://127.0.0.1:${opts.port}`;
const serverLog = openSync(join(out, "server.log"), "a");
let serverProcess: ChildProcess | undefined;
/**
 * Starts the server from this checkout on --home and waits until it answers.
 */
const startServer = async () => {
  /**
   * Path `path` from this script's folder.
   */
  const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  // The fork tests' entry: main.ts forking the worker on fake media, restarting a crashed one after 30 s, and quitting
  // once its stdin pipe closes.
  const [args, stdin] = opts["fake-media"]
    ? [[at("../../server/src/test/main.ts"), at("../../server/src/test/worker.ts"), "30000"], "pipe" as const]
    : [[at("../../server/src/main.ts")], "ignore" as const];
  serverProcess = spawn(process.execPath, args, {
    env: { ...process.env, DOOMLEARN_HOME: home },
    stdio: [stdin, serverLog, serverLog],
  });
  for (let i = 0; ; i++) {
    if (
      await fetch(`${server}/api/today`).then(
        (res) => res.ok,
        () => false,
      )
    )
      return;
    if (i === 60) throw new Error(`the server on ${server} did not start: see ${join(out, "server.log")}`);
    await sleep(500);
  }
};
/**
 * Stops the server (its worker quits with it) and waits until it has exited.
 */
const stopServer = async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = once(serverProcess, "exit");
  serverProcess.kill("SIGTERM");
  await exited;
};
process.on("exit", () => serverProcess?.kill("SIGKILL"));
/**
 * Logs a check and records it when it fails.
 */
const check = (ok: boolean, what: string, detail: unknown = "") => {
  log(`${ok ? "ok  " : "FAIL"} ${what} ${detail === "" ? "" : JSON.stringify(detail)}`);
  if (!ok) failures.push(what);
};
/**
 * Saves a device screenshot as out/<name>.png.
 */
const shot = (name: string) => {
  writeFileSync(join(out, `${name}.png`), execFileSync("adb", [...serial, "exec-out", "screencap", "-p"]));
  log(`screenshot ${join(out, `${name}.png`)}`);
};

await startServer();
adb("reverse", `tcp:${DEVICE.port}`, `tcp:${opts.port}`);
// A free Mac port for Chrome's DevTools socket, so parallel emulators never share one.
const cdpPort = adb("forward", "tcp:0", "localabstract:chrome_devtools_remote").trim();

/**
 * Starts Chrome afresh on the Feed (one page only: no restored tab next to the app) and attaches Playwright, with the
 * error listeners on before a reload so startup errors count.
 */
async function launch(): Promise<{ browser: Browser; page: Page }> {
  adb("shell", "am", "force-stop", "com.android.chrome");
  if (opts.standalone) {
    // Chrome opens the app window only for an intent carrying the shortcut's own MAC: replay the shortcut's extras.
    const entry = adb("shell", "dumpsys", "shortcut")
      .split("ShortcutInfo {")
      .find((s) => s.includes(`webapp_url=${DEVICE.origin}`));
    if (!entry)
      throw new Error(
        `no home-screen shortcut for ${DEVICE.origin}: install the app first (Chrome's menu > Add to Home screen)`,
      );
    /**
     * Reads one of the shortcut's Chrome extras by `key`.
     */
    const extra = (key: string) =>
      entry.match(new RegExp(`org\\.chromium\\.chrome\\.browser\\.${key}=([^,}\\s]+)`))![1];
    adb(
      ...["shell", "am", "start", "-a", "com.google.android.apps.chrome.webapps.WebappManager.ACTION_START_WEBAPP"],
      ...["-p", "com.android.chrome", "--es", "org.chromium.chrome.browser.webapp_id", extra("webapp_id")],
      ...["--es", "org.chromium.chrome.browser.webapp_url", DEVICE.origin],
      ...["--es", "org.chromium.chrome.browser.webapp_mac", extra("webapp_mac")],
    );
  } else adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", DEVICE.origin, "com.android.chrome");

  // DevTools comes back a moment after the restart. noDefaults: without it, Playwright's context setup over CDP denies
  // downloads in Chrome.
  let browser: Browser | undefined;
  for (let i = 0; !browser; i++) {
    browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${cdpPort}`, { noDefaults: true })
      .catch((error) => (i < 30 ? undefined : Promise.reject(error)));
    if (!browser) await sleep(500);
  }
  let page: Page | undefined;
  for (let i = 0; !page && i < 30; i++) {
    page = browser
      .contexts()[0]
      ?.pages()
      .find((p) => p.url().startsWith(DEVICE.origin));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error(`no page on ${DEVICE.origin}`);
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const line = `console.error: ${m.text()} (${m.location().url})`;
    // Only refused requests: a status error, such as a 500 from the restarted server, is counted.
    const refused =
      mac.off && /^Failed to load resource: net::ERR_/.test(m.text()) && m.location().url.startsWith(DEVICE.origin);
    (refused ? ignored : errors).push(line);
  });
  page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));
  await page.reload();
  // An older version cached on this phone leaves this build waiting: activate it, so the check runs on this build.
  const updated = await page.evaluate(async () => {
    const registration = (await navigator.serviceWorker.getRegistration())!;
    // It throws while an install is already under way; that one is picked up below.
    await registration.update().catch(() => {});
    const waiting = registration.waiting ?? registration.installing;
    if (!waiting) return false;
    if (waiting.state === "installing") {
      await new Promise((resolve) => waiting.addEventListener("statechange", resolve, { once: true }));
    }
    const taken = new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve));
    waiting.postMessage({ type: "SKIP_WAITING" });
    await taken;
    return true;
  });
  if (updated) {
    // The app may reload by itself on the new controller: let that settle, then load once more with the listeners on.
    await sleep(2000);
    await page.reload();
    log("activated the waiting version");
  }
  log(`attached to Chrome ${browser.version()}`);
  return { browser, page };
}

let { browser, page } = await launch();
const mode = await page.evaluate(() =>
  matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser tab",
);
log(`Feed loaded (${mode})`);

//
// Plays a Clip
//

/**
 * The Feed's state, read from the Clip on screen: its video, overlays, Passage and controls.
 */
const state = () =>
  page.evaluate(() => {
    const slide = [...document.querySelectorAll<HTMLElement>("section[data-clip]")].find(
      (s) => Math.abs(s.getBoundingClientRect().top) < 5,
    )!;
    const v = slide.querySelector("video")!;
    /**
     * A selector's computed opacity on this slide.
     */
    const opacity = (selector: string) => Number(getComputedStyle(slide.querySelector(selector)!).opacity);
    const chip = [...slide.querySelectorAll("button")].find((b) => /^[\d.]+x$/.test(b.textContent ?? ""));
    const chipBox = chip?.getBoundingClientRect();
    const clock = [...slide.querySelectorAll("div")].find((d) => /^\d+:\d\d \/ \d+:\d\d$/.test(d.textContent ?? ""));
    return {
      clip: slide.dataset.clip,
      t: Math.round(v.currentTime * 100) / 100,
      duration: Math.round(v.duration * 100) / 100,
      paused: v.paused,
      muted: v.muted,
      rate: v.playbackRate,
      defaultRate: v.defaultPlaybackRate,
      passage: slide.querySelector("aside")!.getBoundingClientRect().left < innerWidth / 2,
      rail: opacity("div:has(> [data-button])"),
      line: opacity("[data-scrub]"),
      chip: chip?.textContent ?? null,
      chipAt: chipBox ? { x: chipBox.x + chipBox.width / 2, y: chipBox.y + chipBox.height / 2 } : null,
      clock: clock?.textContent ?? null,
      visible: document.visibilityState,
    };
  });
await page.waitForFunction(
  () => [...document.querySelectorAll("section[data-clip] video")].some((v) => (v as HTMLVideoElement).currentTime > 0),
  undefined,
  { timeout: 20_000 },
);
const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));

// The first tap unmutes for the session and does not pause. It goes through adb, so it also maps CSS pixels to the
// device's: the page starts below the status bar.
await page.evaluate(() => {
  addEventListener("pointerdown", (e) => (document.body.dataset.tapY = String(e.clientY)), { once: true });
});
const tapPx = { x: Math.round(viewport.w * 0.4 * viewport.dpr), y: Math.round(viewport.h * 0.6 * viewport.dpr) };
adb("shell", "input", "tap", String(tapPx.x), String(tapPx.y));
const firstTap = await page.waitForFunction(() => document.body.dataset.tapY, undefined, { timeout: 5000 });
const top = tapPx.y - Number(await firstTap.jsonValue()) * viewport.dpr;
/**
 * A CSS point on the page as device pixels, for adb input.
 */
const px = (x: number, y: number) => [Math.round(x * viewport.dpr), Math.round(y * viewport.dpr + top)].map(String);
log(`viewport ${JSON.stringify(viewport)}, page top at device y ${Math.round(top)}`);
const before = await state();
await sleep(2000);
const after = await state();
check(!after.paused && !after.muted && after.t > before.t, "plays a Clip with sound after the first tap", after);
shot("1-feed");

/**
 * A trusted finger on the page through CDP: down at the first point, through the others, then up after `holdMs`.
 * `during` runs with the finger still down.
 */
async function touch(points: { x: number; y: number }[], holdMs = 0, during?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]] });
  for (const point of points.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    await sleep(16);
  }
  await sleep(holdMs);
  await during?.();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  // A finger's pace: two taps closer than this would read as a double-tap.
  await sleep(400);
}
/**
 * The points of a drag along the line of the Clip on screen, from `from` to `to` (fractions of its width).
 */
async function along(from: number, to: number) {
  const line = await page.evaluate(() => {
    const scrubs = [...document.querySelectorAll("[data-scrub]")].map((l) => l.getBoundingClientRect());
    const box = scrubs.find((r) => r.top > 0 && r.bottom <= innerHeight + 1)!;
    return { x: box.x, y: box.y + box.height / 2, w: box.width };
  });
  return Array.from({ length: 13 }, (_, i) => ({
    x: Math.min(line.x + line.w * (from + ((to - from) * i) / 12), line.x + line.w - 1),
    y: line.y,
  }));
}
/**
 * A trusted tap in the middle of `locator`.
 */
const tapOn = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  await touch([{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]);
};
/**
 * A tap on the Clip, clear of the rail, the tag and the line.
 */
const tapClip = () => touch([{ x: viewport.w * 0.4, y: viewport.h * 0.6 }]);
// Every /api/seen the page sends from here on.
const seen: string[] = [];
page.on("request", (request) => request.url().endsWith("/api/seen") && seen.push(request.postData() ?? ""));

//
// Playback
//

{
  let during: Awaited<ReturnType<typeof state>> | undefined;
  await touch(await along(0.1, 0.6), 700, async () => {
    during = await state();
    shot("2-scrubbing");
  });
  await sleep(500);
  const lifted = await state();
  check(
    !!during?.paused && !!during.clock && Math.abs(during.t - 0.6 * during.duration) < 1,
    "a CDP drag on the line moves currentTime, paused, with elapsed / total shown",
    during,
  );
  check(
    !lifted.passage && lifted.rail === 1 && !lifted.paused && !lifted.clock,
    "lifted: no Passage, overlays shown, playing again, no time label",
    lifted,
  );

  // Through Android's own input, as a finger, along the line just above the gesture bar.
  const points = await along(0.2, 0.7);
  const start = px(points[0].x, points[0].y);
  const end = px(points.at(-1)!.x, points.at(-1)!.y);
  adb("shell", "input", "swipe", ...start, ...end, "600");
  await sleep(700);
  const swiped = await state();
  check(
    swiped.visible === "visible" &&
      !swiped.passage &&
      swiped.rail === 1 &&
      Math.abs(swiped.t - 0.7 * swiped.duration) < 2,
    "an adb swipe on the line scrubs and is not taken by the gesture bar",
    swiped,
  );

  // A forward drag to the end while playing: the Pass ends skipped, with no seen.
  const ended = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const v = [...document.querySelectorAll("section[data-clip] video")].find(
          (video) => !(video as HTMLVideoElement).paused,
        )!;
        v.addEventListener("ended", () => resolve(), { once: true });
      }),
  );
  // A backward drag first clears the Skipped flag the earlier forward drags set, so only the to-end drag can set it.
  await touch(await along(0.3, 0));
  await touch(await along(0.05, 1));
  await Promise.race([ended, sleep(5000)]);
  await sleep(1000);
  const skipped = await state();
  check(seen.length === 0 && skipped.t < 2 && !skipped.paused, "a forward drag to the end loops with no seen", {
    seen: seen.length,
    ...skipped,
  });

  // Paused, then dragged to the end: it stays paused there.
  await tapClip();
  await touch(await along(0.1, 1));
  await sleep(1500);
  const parked = await state();
  check(
    parked.paused && parked.t > parked.duration - 0.5 && seen.length === 0,
    "a paused Clip dragged to the end stays paused, no seen",
    { seen: seen.length, ...parked },
  );

  // The chip, while paused, cycles 1x -> 1.25x -> 1.5x -> 2x -> 1x and leaves the Clip paused.
  const chip = parked.chipAt!;
  // Tap on to 1.5x from the speed an earlier run left on this phone (a full cycle of four if it is 1.5x already), so the
  // checks below never pass on the 1x default.
  const speed = 1.5;
  let taps = 0;
  let sped = await state();
  do {
    await touch([chip]);
    await sleep(300);
    sped = await state();
    taps++;
  } while (taps < 4 && (sped.chip !== `${speed}x` || parked.chip === `${speed}x`));
  shot("3-paused-chip");
  check(
    sped.chip === `${speed}x` && sped.paused && sped.rate === speed,
    `the chip cycles from ${parked.chip} to ${speed}x in ${taps} tap(s) and leaves the Clip paused`,
    sped,
  );
  await tapClip();
  await sleep(300);
  check((await state()).chip === null, "the chip hides once the Clip plays");

  // The next Clip, by a finger swipe up.
  const clip = sped.clip;
  adb(
    "shell",
    "input",
    "swipe",
    ...px(viewport.w * 0.4, viewport.h * 0.7),
    ...px(viewport.w * 0.4, viewport.h * 0.2),
    "200",
  );
  await sleep(2500);
  const next = await state();
  check(
    next.clip !== clip && next.rate === speed && next.defaultRate === speed && !next.paused,
    `${speed}x holds on the next Clip`,
    next,
  );

  // Long-press hides the overlays and the line; a sideways swipe opens the Passage.
  await touch([{ x: viewport.w * 0.4, y: viewport.h * 0.6 }], 800);
  const clean = await state();
  check(clean.rail === 0 && clean.line === 0, "a long-press hides the rail and the line", clean);
  await touch([0.85, 0.65, 0.45, 0.25].map((x) => ({ x: viewport.w * x, y: viewport.h * 0.5 })));
  await sleep(500);
  check((await state()).passage, "a sideways swipe on the Clip opens the Passage");
  await page.goBack();
  await sleep(500);

  // After a relaunch the speed holds. Chrome writes localStorage to disk in batches, seconds after the write, and a
  // force-stop before that loses it: wait as long as a Learner would before reopening the app.
  await sleep(15_000);
  await browser.close();
  ({ browser, page } = await launch());
  await page.waitForFunction(
    () => [...document.querySelectorAll("section[data-clip] video")].some((v) => !(v as HTMLVideoElement).paused),
    undefined,
    { timeout: 20_000 },
  );
  const relaunched = await state();
  check(relaunched.rate === speed && relaunched.defaultRate === speed, `${speed}x holds after a relaunch`, relaunched);

  // The Search player has the same controls. "que" and "the" are in nearly every pt-BR or English caption.
  await tapOn(page.locator("nav button", { hasText: "🔍" }));
  for (const query of ["que", "the", "a"]) {
    await page.getByPlaceholder("Search the captions").fill(query);
    if (
      await page
        .locator("[data-hit]")
        .first()
        .waitFor({ timeout: 3000 })
        .then(
          () => true,
          () => false,
        )
    )
      break;
  }
  await tapOn(page.locator("[data-hit]").first());
  const player = page.getByTestId("player");
  await player.locator("video").waitFor();
  await sleep(1000);
  await tapOn(player.locator("video"));
  await sleep(300);
  const playerState = await player.evaluate((el) => ({
    controls: el.querySelector("video")!.hasAttribute("controls"),
    paused: el.querySelector("video")!.paused,
    line: !!el.querySelector("[data-scrub]"),
    chip: [...el.querySelectorAll("button")].find((b) => /^[\d.]+x$/.test(b.textContent ?? ""))?.textContent ?? null,
  }));
  shot("4-search-player");
  check(
    !playerState.controls && playerState.paused && playerState.line && playerState.chip === `${speed}x`,
    "the Search player pauses on tap and has the line and the chip",
    playerState,
  );
  await page.goBack();
  await page.goBack();
}

//
// Favorites
//

{
  /**
   * The Clip ids the Mac holds as Favorites.
   */
  const macFavorites = async () =>
    ((await (await fetch(`${server}/api/favorites`)).json()) as { clipId: number }[]).map((item) => item.clipId);
  /** The Clip on screen's ⭐. */
  const starOf = (clip: string | undefined) => page.locator(`section[data-clip="${clip}"] [data-button=favorite]`);
  /**
   * Taps the Clip's ⭐ to keep it, after a first tap to let it go if an earlier run on this data kept it already.
   */
  const keep = async (clip: string | undefined) => {
    if ((await starOf(clip).getAttribute("aria-pressed")) === "true") await tapOn(starOf(clip));
    await tapOn(starOf(clip));
  };
  /**
   * The phone with the Mac's server stopped (`true`) or started again.
   */
  const offline = async (on: boolean) => {
    if (on) {
      mac.off = true;
      await stopServer();
      return;
    }
    await startServer();
    // Cleared only once the server answers again, after the refused requests still in flight log their errors.
    await sleep(1000);
    mac.off = false;
  };
  /**
   * The Mac's Favorites, read while it is up, for the angle and language each Download's name carries.
   */
  let listed: { clipId: number; angle: string; language: string }[] = [];
  /**
   * Downloads the playing Favorite `clip`, then checks the file in /sdcard/Download: its name and the Mac's bytes.
   */
  const download = async (when: string, clip: string | null | undefined) => {
    const link = page.getByTestId("player").locator("a[download]");
    // The player reads the file first; Download then points at it.
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=player] a[download]")?.getAttribute("href")?.startsWith("blob:"),
    );
    const name = (await link.getAttribute("download"))!;
    const entry = listed.find((item) => item.clipId === Number(clip));
    check(!!entry, `${when}: the playing Clip is in the Mac's Favorites`, { clip });
    if (!entry) return "";
    const suffix = `-${entry.angle}-${entry.language}.mp4`;
    check(
      name.endsWith(suffix) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.slice(0, -suffix.length)),
      `${when}: Download is named <slug>-<angle>-<language>.mp4`,
      { name },
    );
    adb("shell", "rm", "-f", `/sdcard/Download/${name}`);
    // The Clip's file on the Mac, under --home, which the server serves /clips/* from.
    const url = (await page.getByTestId("player").locator("video").getAttribute("src"))!;
    const want = createHash("md5")
      .update(readFileSync(join(home, decodeURIComponent(new URL(url, server).pathname))))
      .digest("hex");
    await tapOn(link);
    let got = "";
    for (let i = 0; i < 20 && !got.startsWith(want); i++) {
      await sleep(500);
      got = adb("shell", `md5sum /sdcard/Download/${name} 2>/dev/null || true`).trim();
    }
    check(got.startsWith(want), `${when}: Download lands as /sdcard/Download/${name} with the Mac's bytes`, {
      want,
      got,
    });
    return name;
  };

  // The six-button rail ends above the tag pill.
  const rail = await page.evaluate(() => {
    const slide = [...document.querySelectorAll<HTMLElement>("section[data-clip]")].find(
      (s) => Math.abs(s.getBoundingClientRect().top) < 5,
    )!;
    const buttons = slide.querySelectorAll("[data-button]");
    const pill = slide.querySelector(".line-clamp-2")!.parentElement!.getBoundingClientRect();
    return {
      buttons: buttons.length,
      railBottom: buttons[buttons.length - 1].getBoundingClientRect().bottom,
      pillTop: pill.top,
    };
  });
  check(
    rail.buttons === 6 && rail.railBottom < rail.pillTop,
    "the six-button rail (✅ 🤔 ⏭️ 🚩 ⭐ 🌐) clears the tag pill",
    rail,
  );

  // ⭐ online: lit at once, the Feed stays on the Clip, and the phone caches the Favorite.
  const first = (await state()).clip;
  await keep(first);
  await sleep(1000);
  const lit = { clip: (await state()).clip, pressed: await starOf(first).getAttribute("aria-pressed") };
  check(lit.pressed === "true" && lit.clip === first, "⭐ lights at once and the Feed stays on the Clip", {
    first,
    ...lit,
  });
  const firstUrl = await page.locator(`section[data-clip="${first}"] video`).evaluate((v: HTMLVideoElement) => v.src);
  let cached: string[] = [];
  for (let i = 0; i < 20 && !cached.includes(firstUrl); i++) {
    await sleep(500);
    cached = await page.evaluate(async () => (await (await caches.open("favorites")).keys()).map((r) => r.url));
  }
  check(
    (await macFavorites()).includes(Number(first)) && cached.includes(firstUrl),
    "the Favorite reaches the Mac and the phone's favorites cache",
    { firstUrl, cached },
  );
  shot("5-starred");

  // Favorites, online: the list, a Favorite playing, and Download.
  listed = await (await fetch(`${server}/api/favorites`)).json();
  await tapOn(page.locator("nav button", { hasText: "⭐" }));
  const opened = await page.locator("[data-favorite]").first().getAttribute("data-favorite");
  await tapOn(page.locator("[data-favorite]").first());
  await download("online", opened);
  await page.goBack();
  await page.goBack();
  await sleep(500);

  // The Mac off: ⭐ on the next Clip lights at once and is queued. The Favorite played offline below is that first
  // Clip: out of the `clips` buffer, only the `favorites` cache can serve it.
  await page.evaluate(async (url) => (await caches.open("clips")).delete(url), firstUrl);
  await offline(true);
  adb(
    "shell",
    "input",
    "swipe",
    ...px(viewport.w * 0.4, viewport.h * 0.7),
    ...px(viewport.w * 0.4, viewport.h * 0.2),
    "200",
  );
  await sleep(2500);
  const second = (await state()).clip;
  await keep(second);
  await sleep(1000);
  const queue = await page.evaluate(() => localStorage.getItem("queue"));
  check(
    second !== first &&
      (await starOf(second).getAttribute("aria-pressed")) === "true" &&
      (await state()).clip === second &&
      !!queue?.includes(`"clipId":${second},"on":true`),
    "offline, ⭐ lights at once, the Feed stays, and the ⭐ waits in the queue",
    { second, queue },
  );
  shot("6-starred-offline");

  // Favorites with the Mac off: the last good list plus the ⭐ just queued, a Favorite plays, Download lands, the
  // share sheet opens.
  await tapOn(page.locator("nav button", { hasText: "⭐" }));
  check(
    (await page.locator(`[data-favorite="${second}"]`).count()) === 1,
    "offline, Favorites lists the Clip starred offline",
  );
  await tapOn(page.locator(`[data-favorite="${first}"]`));
  const player = page.getByTestId("player");
  await sleep(2000);
  const [t, src] = await player.locator("video").evaluate((v: HTMLVideoElement) => [v.currentTime, v.src] as const);
  check(t > 0 && src === firstUrl, "offline, a Favorite plays from the favorites cache", { t, src, firstUrl });
  shot("7-favorite-offline");
  const name = await download("offline", first);
  await tapOn(player.getByRole("button", { name: "📤" }));
  await sleep(2500);
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const sheet = adb("shell", "cat", "/sdcard/ui.xml");
  shot("8-share-sheet-offline");
  check(sheet.includes(name), `offline, the share sheet opens with ${name}`);
  // Back cancels the sheet: an AbortError, which says nothing.
  adb("shell", "input", "keyevent", "4");
  await sleep(1000);
  check((await page.getByText(/Share failed/).count()) === 0, "a cancelled share says nothing");
  await page.goBack();
  await page.goBack();

  // The Mac back: the queued ⭐ reaches it.
  await offline(false);
  await page.evaluate(() => dispatchEvent(new Event("online")));
  let synced: number[] = [];
  for (let i = 0; i < 20 && !synced.includes(Number(second)); i++) {
    await sleep(500);
    synced = await macFavorites();
  }
  check(synced.includes(Number(second)), "the offline ⭐ reaches the Mac once it is back", synced);
}

//
// Language of new Clips
//

{
  /**
   * The Language of new Clips in the Mac's config, once it is `language`, or what it is after 10 s.
   */
  const macLanguage = async (language: string) => {
    let saved = "";
    for (let i = 0; i < 20 && saved !== language; i++) {
      saved = ((await (await fetch(`${server}/api/config`)).json()) as { config: { worker: { language: string } } })
        .config.worker.language;
      if (saved !== language) await sleep(500);
    }
    return saved;
  };
  await page.goto(`${DEVICE.origin}settings/worker`);
  const select = page.getByLabel("Language of new Clips");
  const save = page.getByRole("button", { name: "Save" });
  await select.scrollIntoViewIfNeeded();
  const box = (await select.boundingBox())!;
  check(box.x >= 0 && box.x + box.width <= viewport.w, "the Language select fits the phone's width", box);
  check((await select.inputValue()) === "pt-BR", "the Language select starts at pt-BR");
  shot("9-language-select");

  // Android's own picker opens on a tap; English is tapped in it.
  await tapOn(select);
  await sleep(1500);
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const picker = adb("shell", "cat", "/sdcard/ui.xml");
  shot("10-language-picker");
  check(
    ["Portuguese (pt-BR)", "English (en)", "Spanish (es)"].every((option) => picker.includes(`text="${option}"`)),
    "the picker lists pt-BR, English and Spanish",
  );
  const [, x1, y1, x2, y2] = picker.match(/text="English \(en\)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ?? [];
  if (x1) adb("shell", "input", "tap", String((+x1 + +x2) / 2), String((+y1 + +y2) / 2));
  await sleep(1000);
  check((await select.inputValue()) === "en", "English is picked");
  await tapOn(save);
  check((await macLanguage("en")) === "en", "Save writes the Language of new Clips to the Mac's config");
  await sleep(1000);
  shot("11-language-saved");
  check(await save.isDisabled(), "Save is spent once saved");

  // Back to pt-BR, so a rerun on this data starts the same.
  await select.selectOption("pt-BR");
  await tapOn(save);
  check((await macLanguage("pt-BR")) === "pt-BR", "pt-BR saved back");
}

//
// Fix a pronunciation
//

{
  /**
   * The Mac's open 🚩 items.
   */
  const macFlags = async () =>
    ((await (await fetch(`${server}/api/inbox`)).json()) as { flags: { eventId: number; reason: string }[] }).flags;
  const before = (await macFlags()).filter((flag) => flag.reason === "Pronunciation");
  check(before.length > 0, "the data holds an open 🚩 Pronunciation", before.length);
  await page.goto(`${DEVICE.origin}inbox`);
  const fix = page.getByRole("button", { name: "🗣️ Fix pronunciation" });
  await fix.first().waitFor();
  check((await fix.count()) === before.length, "Fix pronunciation shows on each 🚩 Pronunciation item only", {
    buttons: await fix.count(),
    pronunciation: before.length,
  });
  await fix.first().scrollIntoViewIfNeeded();
  await tapOn(fix.first());
  const sheet = page.getByTestId("fix-sheet");
  const words = sheet.locator("button[aria-pressed]");
  await words.first().waitFor();
  const box = (await sheet.boundingBox())!;
  // 1 px for the rounding of CSS pixels on a 2.75 dpr screen.
  check(box.x >= 0 && box.x + box.width <= viewport.w + 1, "the fix sheet fits the phone's width", { box, viewport });

  // The second and third words of the script: a word and its neighbour.
  await tapOn(words.nth(1));
  await tapOn(words.nth(2));
  const picked = await sheet.locator("button[aria-pressed=true]").allTextContents();
  const field = sheet.locator("input");
  const label = (await field.getAttribute("aria-label")) ?? "";
  check(picked.length === 2 && (await field.count()) === 1, "a word and its neighbour are picked as one fix", {
    picked,
    label,
  });
  const prefill = await field.inputValue();
  check(prefill.length > 0, "the sound field starts with what the voice says now", prefill);
  shot("12-fix-picked");

  await tapOn(field);
  await field.fill(`${prefill}x`);
  await sheet.getByRole("button", { name: "▶ Preview" }).scrollIntoViewIfNeeded();
  await tapOn(sheet.getByRole("button", { name: "▶ Preview" }));
  const audio = sheet.locator("audio");
  await audio.waitFor({ timeout: 60_000 }).catch(() => {});
  let played = false;
  for (let i = 0; i < 20 && !played; i++) {
    await sleep(500);
    played = (await audio.count()) > 0 && (await audio.evaluate((a: HTMLAudioElement) => a.currentTime > 0 || a.ended));
  }
  check(played, "▶ Preview plays the worker's wav with the worker paused");
  shot("13-fix-preview");

  const save = sheet.getByRole("button", { name: "Save and regenerate" });
  const saveBox = (await save.boundingBox())!;
  check(saveBox.y + saveBox.height <= viewport.h, "Save stays on screen while the sheet scrolls", saveBox);
  await tapOn(save);
  await page
    .getByText("Fix saved: regenerating")
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  const after = (await macFlags()).filter((flag) => flag.reason === "Pronunciation");
  const term = label.replace(/^Sound of “|”$/g, "");
  const lexicon = JSON.parse(readFileSync(join(home, "lexicon.json"), "utf8")) as Record<string, string>;
  check(
    after.length === before.length - 1 && lexicon[term] === `${prefill}x`,
    "Save writes the fix to the Lexicon and the 🚩 leaves the Inbox for its regenerate",
    { term, saved: lexicon[term], left: after.length },
  );
  shot("14-fix-saved");
}

//
// Make in another Language
//

{
  /**
   * The Languages with a translate job not done yet for the Clip `clipId`'s Concept and Angle, as the Mac lists them.
   */
  const macTranslations = async (clipId: string) =>
    (
      (await (await fetch(`${server}/api/translations?clipId=${clipId}`)).json()) as {
        languages: { language: string; job: { status: string } | null }[];
      }
    ).languages.flatMap((row) => (row.job ? [{ language: row.language, status: row.job.status }] : []));
  await page.goto(DEVICE.origin);
  await page.locator("section[data-clip]").first().waitFor();
  const clip = (await state()).clip!;
  const globe = page.locator(`section[data-clip="${clip}"] [data-button=translate]`);
  await tapOn(globe);
  const sheet = page.getByTestId("translate-sheet");
  const rows = sheet.locator("[data-language]");
  await rows.first().waitFor();
  const box = (await sheet.boundingBox())!;
  check(box.x >= 0 && box.x + box.width <= viewport.w + 1 && box.y >= 0, "the 🌐 sheet fits the phone's screen", {
    box,
    viewport,
  });
  check((await rows.count()) === 2, "the 🌐 sheet lists every Language but the Clip's own", await rows.count());
  shot("15-translate-sheet");

  const row = rows.filter({ has: page.getByRole("button", { name: /^Make in / }) }).first();
  const make = row.getByRole("button");
  const language = (await row.getAttribute("data-language")) ?? "";
  const before = await macTranslations(clip);
  await tapOn(make);
  const toast = await page
    .getByText(/^Queued: \w+ translation of /)
    .waitFor({ timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  const queued = await macTranslations(clip);
  check(
    toast &&
      queued.length === before.length + 1 &&
      queued.some((job) => job.language === language && job.status === "queued"),
    "Make in <Language> queues one translate job and shows its toast",
    { language, queued },
  );
  // The worker is paused for this check, so the row names that Blocker.
  const waiting = sheet.locator(`[data-language="${language}"]`);
  await waiting
    .getByText("Worker pause until resumed")
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check(
    !!(await waiting.textContent())?.endsWith(" · Worker pause until resumed"),
    "the queued row shows the Blocker holding it",
    await waiting.textContent(),
  );
  shot("16-translate-queued");
  await page.goBack();
}

//
// Source screen
//

{
  await page.goto(`${DEVICE.origin}sources`);
  const card = page.locator("button", { has: page.locator("b") }).filter({ hasText: /chapter \d+\/\d+/ });
  await card.first().waitFor();
  await tapOn(card.first());
  await page.waitForURL(/\/sources\/\d+$/);
  const chapters = page.locator("[data-chapter]");
  await chapters
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(width <= viewport.w + 1, "the Source screen fits the phone's width", { width, viewport });
  check(
    (await chapters.count()) > 0,
    "the Source card opens the Source screen with its chapters",
    await chapters.count(),
  );
  shot("17-source-screen");

  // The first chapter that teaches a Concept with a Clip that plays.
  const chapter = chapters.filter({ hasText: /[1-9]\d* Concepts?/ }).first();
  await chapter.locator("button[aria-expanded]").first().scrollIntoViewIfNeeded();
  await tapOn(chapter.locator("button[aria-expanded]").first());
  const rows = chapter.locator("[data-concept]");
  await rows
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check((await rows.count()) > 0, "a chapter opens in place to its Concepts", await rows.count());
  shot("18-source-chapter");

  const before = seen.length;
  const clip = chapter.locator("button[data-clip]:not([disabled])").first();
  await clip.scrollIntoViewIfNeeded();
  await tapOn(clip);
  const video = page.getByTestId("player").locator("video");
  await video.waitFor();
  let played = false;
  for (let i = 0; i < 20 && !played; i++) {
    await sleep(500);
    played = await video.evaluate((v: HTMLVideoElement) => v.currentTime > 0);
  }
  // A Clip of the real data is longer than this wait, so a seen would only come from the player recording one.
  await sleep(3000);
  check(played && seen.length === before, "a Clip plays in the Search player at phone size and sends no seen", {
    played,
    seen: seen.slice(before),
  });
  shot("19-source-player");
  await page.goBack();
}

//
// Pause and delete chapters and Concepts
//

{
  // The Source screen is still open on the chapter the last section opened.
  const chapter = page
    .locator("[data-chapter]")
    .filter({ has: page.locator("[data-concept]") })
    .first();
  // A Concept with a ⋯ menu, not Retired if the chapter has one, so its Pause is checked too.
  const menus = chapter.locator("[data-concept]").filter({ has: page.getByRole("button", { name: /^More for / }) });
  const live = menus.filter({ hasNotText: "Retired:" });
  const row = (await live.count()) ? live.first() : menus.first();
  const title = (await row.locator("b").first().textContent()) ?? "";
  const more = row.getByRole("button", { name: `More for ${title}`, exact: true });
  /**
   * Opens `button`'s ⋯ menu and taps its item `name`.
   */
  const pick = async (button: Locator, scope: Locator, name: string) => {
    await button.scrollIntoViewIfNeeded();
    await tapOn(button);
    const item = scope.getByRole("menuitem", { name });
    await item.waitFor({ timeout: 3000 }).catch(() => {});
    const box = await item.boundingBox();
    check(
      !!box && box.x >= 0 && box.x + box.width <= viewport.w + 1 && box.y >= 0 && box.y + box.height <= viewport.h + 1,
      `the ${name} item shows on the phone's screen`,
      box,
    );
    if (box) await tapOn(item);
  };
  // A Retired Concept offers Delete only.
  const retired = !!(await row.textContent())?.includes("Retired:");
  await pick(more, row, retired ? "🗑 Delete" : "⏸ Pause");
  if (!retired) {
    const chip = row.getByText("Paused", { exact: true });
    await chip.waitFor({ timeout: 5000 }).catch(() => {});
    check(await chip.isVisible(), "⏸ Pause marks the Concept Paused", title);
    shot("20-concept-paused");
    await pick(more, row, "▶ Resume");
    await chip.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    check(!(await chip.isVisible()), "▶ Resume lifts it", title);
    await pick(more, row, "🗑 Delete");
  }
  const toast = page.getByText("Deleted · Restore", { exact: true });
  await toast.waitFor({ timeout: 5000 }).catch(() => {});
  const deleted = row.getByText("Deleted", { exact: true });
  await deleted.waitFor({ timeout: 5000 }).catch(() => {});
  check(
    (await toast.isVisible()) && (await deleted.isVisible()),
    "🗑 Delete greys the Concept with no dialog and shows Deleted · Restore",
    title,
  );
  shot("21-concept-deleted");
  await tapOn(toast.getByRole("button", { name: "Restore", exact: true }));
  await deleted.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  check(!(await deleted.isVisible()), "the toast's Restore brings the Concept back", title);

  const head = chapter.getByRole("button", { name: /^More for ch\. \d+$/ });
  await pick(head, chapter, "⏸ Pause");
  const state = chapter.locator("button[aria-expanded]").first();
  await page
    .waitForFunction((el) => el?.textContent?.includes("paused"), await state.elementHandle(), {
      timeout: 5000,
    })
    .catch(() => {});
  check(!!(await state.textContent())?.includes("paused"), "the chapter's ⋯ pauses it", await state.textContent());
  shot("22-chapter-paused");
  await pick(head, chapter, "▶ Resume");
  await page
    .waitForFunction((el) => !el?.textContent?.includes("paused"), await state.elementHandle(), {
      timeout: 5000,
    })
    .catch(() => {});
  check(!(await state.textContent())?.includes("paused"), "the chapter's ⋯ resumes it", await state.textContent());

  // A Concept that went with its chapter has no ⋯ menu, and names the chapter whose Restore brings it back.
  await pick(head, chapter, "🗑 Delete");
  const went = chapter.locator("[data-concept]").filter({ hasText: "deleted with ch. " });
  await went
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const gone = await went.count();
  check(
    gone > 0 && (await went.getByRole("button", { name: /^More for / }).count()) === 0,
    "a chapter's 🗑 Delete marks its Concepts deleted with ch. N, with no ⋯ menu",
    gone,
  );
  shot("23-chapter-deleted");
  await tapOn(toast.getByRole("button", { name: "Restore", exact: true }));
  await went
    .first()
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
  check((await went.count()) === 0, "the toast's Restore brings the chapter's Concepts back", await went.count());
}

//
// Done
//

await browser.close(); // over CDP this only disconnects; Chrome keeps running
adb("forward", "--remove", `tcp:${cdpPort}`);
adb("reverse", "--remove", `tcp:${DEVICE.port}`);
await stopServer();
log(`ignored ${ignored.length} refused-request error(s) while the Mac's server was stopped`);
for (const error of errors) console.log(error);
const ok = failures.length === 0 && errors.length === 0;
log(ok ? "PASS" : `FAIL (${failures.length} failed check(s), ${errors.length} console error(s))`);
process.exit(ok ? 0 : 1);
