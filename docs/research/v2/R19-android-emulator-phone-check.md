# R19: How does an agent run and check the doomlearn PWA in the Android emulator on this Mac?

Everything below was run on an Apple-silicon Mac on 2026-10-15, against a test server from a worktree. The server ran on a temp `DOOMLEARN_HOME` holding a copy of the data, with `"worker": {"paused": true}`. The base recipe lives in the header of `apps/web/scripts/phone-check.ts`. This doc extends it.

Owner decision: no ZeroTier and no mkcert on the emulator. The emulator reaches the server through `adb reverse`.

## 1. What is installed, which image, and headless boot

- SDK at `~/Library/Android/sdk`: `emulator`, `platform-tools`, `build-tools`, `cmdline-tools`, `platforms`, `system-images`, `ndk`, `cmake`, `skins`, `sources` (`ls ~/Library/Android/sdk`).
- Emulator `35.1.20.0` (`emulator -version`). `adb` on the PATH is `/opt/homebrew/bin/adb`, version `35.0.2-12147458` (`adb version`).
- There is one system image: `system-images/android-35/google_apis_playstore/arm64-v8a`. It is a Google Play image, native arm64 for Apple Silicon. There are two AVDs, `Medium_Tablet_API_35` and `Pixel_4_API_35` (`emulator -list-avds`). Use `Pixel_4_API_35`. Its facts are in the base recipe: Android 15, 1080x2280, a `user` build, Chrome 124.0.6367.219.
- A Play image is not needed for the check, because no ZeroTier app is installed. Its side effect: Chrome tries to mint a WebAPK through the Play Store and fails without a Google account (see 3).
- Headless boot with `emulator -avd Pixel_4_API_35 -no-boot-anim -no-audio -no-window &`:
  ```
  device=7s boot_completed=16s        # first boot (adb wait-for-device, then sys.boot_completed=1)
  boot_completed=16s                  # second boot, same command
  ```
  Both of these boots were cold boots. The emulator log says `Device 'encrypt' does not have the requested snapshot 'default_boot'`, and no `snapshots/` folder exists in the AVD after `adb emu kill`. Boots are not always cold. In the fact-check run (same command, same day), the AVD held a `default_boot` snapshot written at 21:50 by some other run. The log said `Successfully loaded snapshot 'default_boot'`, and `sys.boot_completed` was 1 after 3 s. On `adb emu kill` the emulator logged `Not saving state: current state does not support snapshotting` and `Deleting snapshot default_boot`, so the next boot is cold again. Plan on 16 s, but expect 3 s when a snapshot happens to exist. A snapshot boot restores Chrome's state from when the snapshot was saved. The data partition persists: and the data partition persists: the home-screen shortcut from 3 was still there after a reboot (`dumpsys shortcut` shows `webapp_url=http://localhost:8443/`).
- Clean shutdown: `adb emu kill` prints `OK: killing emulator, bye bye`, and the `qemu-system` process is gone 2 s later. After that, `adb devices` lists nothing. At exit the emulator's crash handler logs one `crash_report_exception_handler.cc:235] UniversalExceptionRaise` warning. It did not stop the next boot (see Unverified).

## 2. Reaching the server

`adb reverse tcp:8443 tcp:8443`, then `http://localhost:8443/` in the emulator, as the base recipe proves (secure context, service worker active).

- (a) mkcert CA: not needed, because adb reverse plus `http://localhost` is a secure context.
- (b) ZeroTier in the emulator: not needed, for the same reason.
- (c) `10.0.2.2`: not needed. Also, it is not `localhost`, so it would not be a secure context.

## 3. Installing the PWA to the home screen and opening it standalone from adb

**Installability.** CDP `Page.getInstallabilityErrors` on the Feed returns `{"installabilityErrors":[]}`. The manifest has `display: "standalone"`, `start_url: "/"`, `scope: "/"` and 192/512 icons (`apps/web/vite.config.ts`).

**Install by taps** (with `scratchpad/tap.sh` from the base recipe; one time per AVD, and it survives reboots):
```sh
adb shell am start -a android.intent.action.VIEW -d http://localhost:8443/ com.android.chrome
sh tap.sh "More options"          # Chrome's ⋮ menu; the item it shows is "Add to Home screen"
sh tap.sh "Add to Home screen"    # Chrome dialog "Install app: doomlearn http://localhost:8443"
sh tap.sh "Install" exact
sh tap.sh "Add to home screen" exact   # the launcher's pin-shortcut confirmation
```
- The result is a pinned shortcut, not a WebAPK. `pm list packages` gains no package.
- logcat shows that Chrome asked the Play Store for a WebAPK first and was refused:
  ```
  I Finsky  : installPackage: com.android.chrome (org.chromium.webapk.a367efe262fc81aa2_v2)
  W Finsky  : installapi: org.chromium.webapk.a367efe262fc81aa2_v2 not allowed for ENX.
  W Finsky  : WebAPK service unknown_account.
  ```
- In Chromium 124, an installable page with WebAPK-compatible manifest URLs takes the WebAPK path. Only otherwise does it go to `PrepareToAddShortcut` ([add_to_homescreen_data_fetcher.cc L256-265](https://github.com/chromium/chromium/blob/124.0.6367.219/components/webapps/browser/android/add_to_homescreen_data_fetcher.cc#L256-L265)). The WebAPK compatibility check only rejects URLs that carry a user name or password, not `http` ([webapps_utils.cc L21-59](https://github.com/chromium/chromium/blob/124.0.6367.219/components/webapps/browser/android/webapps_utils.cc#L21-L59)). When the WebAPK install fails for a reason other than `PROBABLE_FAILURE`, Chrome 124 adds a shortcut instead ([webapk_install_service.cc L93-111](https://github.com/chromium/chromium/blob/124.0.6367.219/chrome/browser/android/webapk/webapk_install_service.cc#L93-L111)). That fallback is skipped when the `WebApkInstallFailureNotification` feature is on. So the shortcut is the fallback after the Play Store refusal.

**The shortcut opens standalone.** `adb shell dumpsys shortcut` shows the shortcut (icon bytes omitted):
```
ShortcutInfo {id=ae84ac68-…, packageName=com.android.chrome, shortLabel=doomlearn,
  intents=[Intent { act=com.google.android.apps.chrome.webapps.WebappManager.ACTION_START_WEBAPP pkg=com.android.chrome }/
  PersistableBundle[{… webapp_scope=http://localhost:8443/, webapp_display_mode=3, webapp_id=ae84ac68-…,
  webapp_mac=sQ2i…X5Y=, webapp_url=http://localhost:8443/, …}]]
```
**Opening it from adb.** Replay the shortcut's intent, including its MAC:
```sh
adb shell am start -a com.google.android.apps.chrome.webapps.WebappManager.ACTION_START_WEBAPP -p com.android.chrome \
  --es org.chromium.chrome.browser.webapp_id <id> --es org.chromium.chrome.browser.webapp_url http://localhost:8443/ \
  --es org.chromium.chrome.browser.webapp_mac <mac>
# topResumedActivity=… com.android.chrome/org.chromium.chrome.browser.webapps.WebappActivity
# page: matchMedia("(display-mode: standalone)").matches === true, innerHeight 782 (726 in a tab: no URL bar)
```
- The MAC is required. Without the `webapp_mac` extra, the same intent opens a normal tab: `ChromeTabbedActivity`, and `display-mode: standalone` is false.
- Chromium 124's `WebappLauncherActivity` accepts the intent only if `isValidMacForUrl(url, mac)` passes or the intent came from Chrome itself ([WebappLauncherActivity.java L237-238, L305-316](https://github.com/chromium/chromium/blob/124.0.6367.219/chrome/android/java/src/org/chromium/chrome/browser/webapps/WebappLauncherActivity.java#L237-L238)). Its comment says the MAC is there "to prevent malicious apps from launching Chrome into a full screen" activity.
- `phone-check.mjs --standalone` reads the id and MAC from `dumpsys shortcut`, so nothing is hard-coded.

## 4. Automating checks

**Playwright `connectOverCDP` attaches.** It uses the repo's `@playwright/test` 1.63.0 from `apps/web`, through `adb forward tcp:9222 localabstract:chrome_devtools_remote`:
```
connected in 60 ms; version 124.0.6367.219
contexts 1 pages [ [ 'http://localhost:8443/' ] ]
title doomlearn viewport [393,726,2.75]
screenshot ok
newPage ok about:blank
closed                                # Chrome still running afterwards (adb shell pidof com.android.chrome -> 3365)
```
- `page.reload`, `page.evaluate`, `page.waitForFunction`, `page.mouse.click`, `page.screenshot` and the `console` and `pageerror` events all worked in the run below.
- Over CDP, `browser.close()` only disconnects. That matches the docs. `connectOverCDP` "attaches Playwright to an existing browser instance" ([class-browsertype.md, v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsertype.md), via ctx7 `/microsoft/playwright/v1.63.0`). For a browser that "is connected to", `close()` "clears all created contexts belonging to this browser and disconnects" ([class-browser.md L101, v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browser.md#L101)).
- The same docs warn that the connection is "significantly lower fidelity" than `browserType.connect`, and that a browser launched without Playwright's arguments may break some features. Nothing the check needs broke.

**Playwright's `_android` API does not work on this AVD as it is.** `device.launchBrowser()` returned nothing within 30 s:
```
device sdk_gphone64_arm64 emulator-5554
launchBrowser: no answer after 30s
```
- The installed playwright-core writes its flags to `/data/local/tmp/chrome-command-line` and waits for a socket named by those flags (`playwright-core/lib/coreBundle.js`, `launchBrowser`).
- The installed `types.d.ts` lists "Enable command line on non-rooted devices enabled in chrome://flags" as a requirement (line 24139). Chromium's page agrees: "For production build on a non-rooted device, you need to enable 'Enable command line on non-rooted devices' in chrome://flags" ([Run Chromium with flags](https://www.chromium.org/developers/how-tos/run-chromium-with-flags/)).
- `connectOverCDP` needs none of this, so use it.

**Plain CDP pitfall.** With three tabs open on the same URL, `cdp-eval.mjs` picked the first `/json` entry and `Runtime.evaluate` never answered (killed after 120 s). Every new `am start VIEW` adds a tab. `phone-check.mjs` therefore runs `am force-stop com.android.chrome` before it launches, which leaves exactly one page: verified for both the tab and the standalone launch.

**chrome-devtools MCP.** Its docs attach to a running Chrome with `--browser-url=http://127.0.0.1:9222` ([advanced-usage.md](https://github.com/chromedevtools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md), via ctx7 `/chromedevtools/chrome-devtools-mcp`). This was not tried here (see Unverified). Playwright covers the need.

**Console errors.** The script listens to `page.on("console")` for type `error` and to `page.on("pageerror")`, then reloads the page so that startup errors count. A real failure run is below: the server was stopped, the service worker still served the shell and the cached Clip, and the three API calls failed. The run caught them and exited 1.

**adb tools** (`input tap/swipe/keyevent`, `exec-out screencap`, `uiautomator dump`) work as in the base recipe. `screencap` was used for every screenshot here. It captures the real screen, including whether a URL bar is shown.

### The script

Saved at `scratchpad/phone-check.mjs` (the session scratchpad). Run it from a worktree root: `node <path>/phone-check.mjs [--standalone] [shot.png]`.

```js
// node phone-check.mjs [--standalone] [shot.png]
// Opens the Feed in the emulator's Chrome (or, with --standalone, the installed app), plays the Clip on screen with
// sound, saves a device screenshot, and exits 1 on any console error or uncaught exception, or if the Clip does not play.
// Run it from a worktree root (it loads @playwright/test from apps/web). Needs a booted emulator and a server on 127.0.0.1:8443.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(`${process.cwd()}/apps/web/package.json`)("@playwright/test");
const standalone = process.argv.includes("--standalone");
const shot = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "phone-check.png";
const ORIGIN = "http://localhost:8443/";
const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

adb("reverse", "tcp:8443", "tcp:8443"); // the emulator's localhost:8443 is the Mac's 127.0.0.1:8443
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
adb("shell", "am", "force-stop", "com.android.chrome"); // one page only: no restored tab next to the app
if (standalone) {
  // Chrome only opens the app window for an intent carrying the shortcut's own MAC, so replay the pinned shortcut's extras.
  const entry = adb("shell", "dumpsys", "shortcut").split("ShortcutInfo {").find((s) => s.includes(`webapp_url=${ORIGIN}`));
  if (!entry) throw new Error(`no home-screen shortcut for ${ORIGIN}: install the app first (doc R19, step 3)`);
  const extra = (key) => entry.match(new RegExp(`org\\.chromium\\.chrome\\.browser\\.${key}=([^,}\\s]+)`))[1];
  adb("shell", "am", "start", "-a", "com.google.android.apps.chrome.webapps.WebappManager.ACTION_START_WEBAPP",
    "-p", "com.android.chrome", "--es", "org.chromium.chrome.browser.webapp_id", extra("webapp_id"),
    "--es", "org.chromium.chrome.browser.webapp_url", ORIGIN, "--es", "org.chromium.chrome.browser.webapp_mac", extra("webapp_mac"));
} else {
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", ORIGIN, "com.android.chrome");
}

// Chrome's DevTools socket comes back a moment after the restart.
let browser;
for (let i = 0; !browser; i++) {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222").catch((e) => (i < 30 ? null : Promise.reject(e)));
  if (!browser) await sleep(500);
}
let page;
for (let i = 0; !page && i < 30; i++) {
  page = browser.contexts()[0]?.pages().find((p) => p.url().startsWith(ORIGIN));
  if (!page) await sleep(500);
}
if (!page) throw new Error(`no page on ${ORIGIN}`);
log(`attached to Chrome ${browser.version()}`);

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()} (${m.location().url})`));
page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
await page.reload(); // load again with the listeners on, so errors during startup count
const mode = await page.evaluate(() => (matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser tab"));
log(`Feed loaded (${mode})`);

// The Clip on screen is the video under the middle-left of the viewport (clear of the rail and the tag).
const point = await page.evaluate(() => ({ x: Math.round(innerWidth * 0.4), y: Math.round(innerHeight * 0.5) }));
const clipAtPoint = ({ x, y }) => {
  const v = document.elementFromPoint(x, y);
  return v instanceof HTMLVideoElement ? { src: v.currentSrc.split("/").pop(), t: v.currentTime, paused: v.paused, muted: v.muted } : null;
};
await page.waitForFunction((p) => {
  const v = document.elementFromPoint(p.x, p.y);
  return v instanceof HTMLVideoElement && v.currentTime > 0;
}, point, { timeout: 20_000 });
log(`Clip autoplays muted: ${JSON.stringify(await page.evaluate(clipAtPoint, point))}`);

await page.mouse.click(point.x, point.y); // the first tap unmutes for the session
const before = await page.evaluate(clipAtPoint, point);
await sleep(2000);
const after = await page.evaluate(clipAtPoint, point);
const playing = !after.paused && !after.muted && after.t > before.t;
log(`after tap: ${JSON.stringify(after)} -> ${playing ? "playing with sound" : "NOT playing"}`);

writeFileSync(shot, execFileSync("adb", ["exec-out", "screencap", "-p"]));
log(`screenshot: ${shot}`);
await browser.close(); // over CDP this only disconnects; Chrome keeps running

for (const e of errors) console.log(e);
const ok = playing && errors.length === 0;
log(ok ? "PASS" : `FAIL (${errors.length} console error(s)${playing ? "" : ", Clip not playing"})`);
process.exit(ok ? 0 : 1);
```

The first tap unmutes, and a tap on the video does not also pause it. This is the Feed's capture-phase `click` listener (`apps/web/src/Feed.tsx`, `unmute`). So one click must leave the Clip playing and unmuted.

### Real runs (worktree server on a temp home, worker paused)

In a tab, then standalone:
```
[1.8s] attached to Chrome 124.0.6367.219
[1.9s] Feed loaded (browser tab)
[2.5s] Clip autoplays muted: {"src":"49-concrete_example.mp4","t":0.077881,"paused":false,"muted":true}
[4.6s] after tap: {"src":"49-concrete_example.mp4","t":2.124665,"paused":false,"muted":false} -> playing with sound
[5.2s] screenshot: …/scratchpad/phone-check-tab.png
[5.2s] PASS
exit=0
[1.8s] attached to Chrome 124.0.6367.219
[2.0s] Feed loaded (standalone)
[2.3s] Clip autoplays muted: {"src":"49-concrete_example.mp4","t":0.048175,"paused":false,"muted":true}
[4.5s] after tap: {"src":"49-concrete_example.mp4","t":2.134689,"paused":false,"muted":false} -> playing with sound
[4.8s] screenshot: …/scratchpad/phone-check-standalone.png
[4.8s] PASS
exit=0
```
The standalone screenshot shows the Feed full screen under the status bar, with no URL bar.

With the server stopped (`kill -INT`), the failure path:
```
[2.5s] Clip autoplays muted: {"src":"49-concrete_example.mp4","t":0.041621,"paused":false,"muted":true}
[4.5s] after tap: {"src":"49-concrete_example.mp4","t":2.035923,"paused":false,"muted":false} -> playing with sound
console.error: Failed to load resource: net::ERR_EMPTY_RESPONSE (http://localhost:8443/api/inbox)
console.error: Failed to load resource: net::ERR_SOCKET_NOT_CONNECTED (http://localhost:8443/api/status)
console.error: Failed to load resource: net::ERR_EMPTY_RESPONSE (http://localhost:8443/api/next)
[4.9s] FAIL (3 console error(s))
exit=1
```

## 5. The repeatable phone check (for every feature ticket)

```sh
# 1. Boot headless (about 16 s cold; about 3 s if a default_boot snapshot exists, see section 1)
H=$(mktemp -d)
~/Library/Android/sdk/emulator/emulator -avd Pixel_4_API_35 -no-boot-anim -no-audio -no-window > "$H/emu.log" 2>&1 &
adb wait-for-device; until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done

# 2. Test server from the worktree on a temp home (base recipe step 2): copy of the DB, clips, lexicon; worker paused
DOOMLEARN_HOME=$H pnpm start > "$H/server.log" 2>&1 &      # wait for "media ready" in server.log

# 3. One time per AVD (already done on Pixel_4_API_35): install the app, see section 3

# 4. Check, from the worktree root: exit 0 = pass
node phone-check.mjs            "$H/tab.png"
node phone-check.mjs --standalone "$H/app.png"
# feature-specific steps: extend the script after "plays a Clip", or use tap.sh / uiautomator / screencap

# 5. Leave nothing running
lsof -ti tcp:8443 -sTCP:LISTEN | xargs kill -INT
adb forward --remove-all; adb reverse --remove-all
adb emu kill                     # qemu gone about 2 s later; `adb devices` lists nothing
```
At the end of this research the emulator was shut down (`adb devices` empty), and nothing listens on 8443.

## Unverified

- **Why Chrome made a shortcut and not a WebAPK.** logcat shows the Play Store refusing (`WebAPK service unknown_account`), so a Google sign-in probably changes this. That was not tried, because signing in needs the owner. The shortcut opens in `WebappActivity` with `display-mode: standalone`, which is what the check needs. A WebAPK may differ in details (app switcher entry, share target) that this AVD cannot show.
- **chrome-devtools MCP against the emulator.** It was not run. This session's MCP is configured to launch its own Chrome, and agents may not change MCP config. The docs say `--browser-url` attaches to a running Chrome.
- **Audio.** The emulator runs with `-no-audio`, so "playing with sound" means the element state (`muted:false`, `paused:false`, `currentTime` advancing). Nobody heard any sound.
- **Service worker console.** The script listens only to the page. Errors logged inside `sw.js` are not caught. CDP lists the worker as its own `service_worker` target; attaching to it was not tried.
- **Chrome version.** The check ran on Chrome 124 (2024). The owner's phone runs a current Chrome, so anything version-sensitive needs a flag (as the base recipe notes).
- **The exit warning.** The emulator's crash handler logs `UniversalExceptionRaise: (os/kern) failure (5)` when `adb emu kill` runs. The next boot was normal (16 s, shortcut intact), but the cause was not looked into.
- **Where the `default_boot` snapshot came from.** The fact-check boot found one written at 21:50, after the author's runs. Which run or setting saved it was not found. `config.ini` has `fastboot.forceFastBoot = yes`, and the headless `adb emu kill` deleted it again.
- **The 2 s shutdown.** The fact-check did not re-measure it. A second emulator (`Medium_Tablet_API_35`, started by another agent) was running, and the `pgrep qemu-system` wait matched it. The killed AVD did leave `adb devices`.
