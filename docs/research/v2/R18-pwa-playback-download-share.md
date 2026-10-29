# R18: What can the installed PWA do with a Clip's video: playback controls, download and sharing later?

The emulator checks ran on 2026-10-15 on the owner's Mac, in Chrome **124.0.6367.219** on an Android 15 (API 35) Play image. The page was the installed app, opened standalone (`display-mode: standalone` true), following R19. The server was a worktree `pnpm start` on a temp `DOOMLEARN_HOME` holding a copy of the DB, clips and lexicon, with the worker paused.

Setup note. A sibling research agent was using `Pixel_4_API_35` at the same time. It ran `am force-stop com.android.chrome` and re-pointed `adb reverse` while I was working. Two instances of one AVD need `-read-only` on both. So after one disturbed run on the Pixel, I ran everything on `Medium_Tablet_API_35` (same system image, same Chrome 124) instead. I set it to the Pixel 4's metrics with `wm size 1080x2280` and `wm density 440`, then installed the app there with R19's step 3. Results on the two AVDs matched wherever both ran.

The probe script is `scratchpad/r18/r18-check.mjs`. It extends R19's `phone-check.mjs`: it attaches over CDP on host port 9333, adds test buttons and presses them with `page.mouse.click`, a trusted input that carries user activation. "Offline" means the Mac server was stopped (`kill -INT`, nothing listening on 8443), so every network request failed.

Clips in `~/doomlearn/clips` are H.264/AAC, 1080x1920, about 40–60 s and 1.7–3.3 MB each (`ls -lS`, `ffprobe`). 80 files take 193 MB (`du -sh`).

## 1. Playback

**Seeking and `playbackRate` work on a Clip served from the `clips` cache, including offline.** Measured on `/clips/49-concrete_example.mp4` with the server stopped:
```
clip {"inCache":true,"cached":43,"controller":true,"fastSeek":"undefined","seekable":[[0,58.6]]}
range-fetch {"status":206,"contentRange":"bytes 100-199/2580168","len":100}
seeks [{"to":43.95,"at":43.99,"ms":592,"readyState":4},{"to":3,"at":3.02,"ms":850,"readyState":4},{"to":23.44,"at":23.45,"ms":600,"readyState":4}]
rates {"res":[{"rate":2,"advancedIn3s":5.8},{"rate":0.5,"advancedIn3s":1.79},{"rate":1,"advancedIn3s":2.91}],
       "negative":"NotSupportedError: ... The provided playback rate (-1) is not in the supported playback range.","preservesPitch":true}
```
- Seeking backwards and forwards lands within 0.05 s in 0.4–1.5 s (online runs: 382–1527 ms). `seekable` covers the whole Clip.
- The service worker answers a `Range` request with a 206 cut from the cached full response. Workbox 7.4.1 `createPartialResponse` returns "a `206 Partial Content` response ... or a `416 Range Not Satisfiable`" (`node_modules/.pnpm/workbox-range-requests@7.4.1/.../createPartialResponse.js` L19-28). This is why seeking works offline. It depends on `sw.ts` caching only full 200s (`CacheableResponsePlugin({statuses:[200]})`) and on the rule that the `<video>` gets its source only once the full GET is cached.
- `playbackRate` 2 and 0.5 work, and pitch is preserved (`preservesPitch: true`). Negative rates throw in Chrome, which matches MDN BCD 8.1.6 (`api.HTMLMediaElement.playbackRate.negative_values`, chrome_android `version_added: false`, note: "Setting negative `playbackRate` throws an error.").
- `fastSeek` does not exist in Chrome (`typeof v.fastSeek === "undefined"`). BCD 8.1.6 says chrome_android `version_added: false` ([crbug 41276303](https://crbug.com/41276303)) and safari_ios `8`. MDN says to "set `currentTime`" when you need precision ([fastSeek](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/fastSeek)). So use `currentTime` on both platforms.

**Native `controls` in the standalone app (Android Chrome 124).** Setting `v.controls = true` shows a large centre play button, a `0:27 / 0:41` time, mute, fullscreen, a `⋮` overflow button and a full-width scrub bar along the bottom (screenshot `scratchpad/r18/online-controls.png`). The `⋮` menu offers **Download, Playback speed, Picture in picture** (`scratchpad/r18/ctl-menu.png`).
- These controls conflict with the Feed's layout. The control bar sits across the bottom 10% of the screen, on top of the tag pill (`top-[89%]`) and the burned-in captions' clear strip. The centre play button covers the captions.
- Chrome's native controls take taps for themselves (show/hide, play). Slide.tsx also uses a tap on the video to pause. I did not measure whether the two fire together (see Unverified).
- MDN's `controlsList` takes `nodownload`, `nofullscreen` and `noremoteplayback` ([controlsList](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/controlsList)). So native controls could hide Download, but they cannot be reshaped to fit the Feed.
- Conclusion: custom controls (a scrub bar and a speed toggle, drawn by the app) fit better than `controls`. The APIs they need (`currentTime`, `playbackRate`) work on cached Clips offline.

**iOS Safari.** I did not run it (see Unverified). From BCD 8.1.6, `fastSeek` and `playbackRate` are supported on iOS.

**Comparable apps.** YouTube's Android help ([Speed up or slow down YouTube videos](https://support.google.com/youtube/answer/7509567?hl=en&co=GENIE.Platform%3DAndroid)) describes three controls:
- "Tap and hold anywhere on the video" plays at 2x, and "To stop fast forwarding, lift your finger."
- "Double-tap the left side" rewinds 10 s and the right side fast-forwards 10 s.
- Settings → Playback speed lists the speeds.

The page does not mention Shorts. Note that "tap and hold" is already taken in doomlearn: long-press hides the overlays (`UI.longPressMs`). I found no first-party TikTok or Instagram page for their controls (see Unverified).

## 2. Download

**Support (MDN BCD 8.1.6, data timestamp 2026-10-15):**

| | Chrome Android | Safari iOS |
|---|---|---|
| `<a download>` | 18 (cross-origin ignored since 65) | 13 |
| `showSaveFilePicker` | **132** | no |
| `navigator.share` with files | 76 | 14 |

`showSaveFilePicker` is `undefined` in Chrome 124 (measured). It is version-sensitive: current Chrome on the owner's phone has it, and iOS does not.

**`<a href="/clips/x.mp4" download>` does not go through the service worker.** It goes to the network:
- Online, pressing it on a cached Clip made the server log a fresh `GET /clips/48-mechanism.mp4 200` followed by `GET ... 206`, the download manager's own requests (temp `server.log`). A CacheFirst hit in the SW would have made no request.
- Offline, the same button (and `?dl=1`) left two entries in Chrome's Downloads screen: `Downloading… • paused`, with no size. Chrome waits for the network. So **a URL download of a cached Clip does not work offline** on Chrome 124.

**Where the file lands: not proven on this emulator.** Every download failed to land: URL downloads, a Blob built from the cached Clip, a 5-byte text Blob and `/icon-192.png`.
- Chrome showed "1 download pending", then the Downloads screen listed `<uuid>… 0.00 KB / 2.88 MB • failed`.
- `adb shell ls -la /sdcard/Download` stayed empty (`total 0`) on both AVDs, and `content query --uri content://media/external/downloads` returned "No result found".
- Chrome's working folder `/sdcard/Android/data/com.android.chrome/files/Download/` was touched at the time of the download and then left empty. logcat shows `cr_DownloadCm: updateDownloadStatus status: 1` for the mp4s. In Chromium 124, `DownloadStatus.COMPLETE = 1` ([DownloadStatus.java](https://github.com/chromium/chromium/blob/124.0.6367.219/chrome/browser/download/android/java/src/org/chromium/chrome/browser/download/DownloadStatus.java)). The PNG got `status: 4` (`INTERRUPTED`).
- MediaProvider logged `Failed to update quota type for /storage/emulated/0/Android` at boot.
- logcat reports `COMPLETE` while the Downloads screen shows `0.00 KB / 2.88 MB • failed` (`scratchpad/r18/downloads-page.png`), so the two disagree. A plausible reading is that the transfer finishes and publishing into the shared Download collection fails, but that is not proven. A plain text Blob fails the same way, which suggests the old Chrome 124 on this Android 15 image rather than doomlearn. The Blob-from-cache path (`caches.match` → `blob()` → `URL.createObjectURL` → `<a download>`) never touches the network, so it is the candidate for an offline download. It still has to be proven on a current Chrome (see Unverified).

**Alternatives.**
- A `Content-Disposition: attachment` route on the server has the same problem as a plain URL: it needs the Mac, so it fails offline.
- `showSaveFilePicker` needs Chrome 132 or later and does not exist on iOS.
- On iOS, the documented way to put a video into Photos is the share sheet's "Save Video" target. That is not checked here (see Unverified).

## 3. Share later

**`navigator.share({files:[mp4]})` works from the installed app on Android Chrome 124, offline too.** The File was built from the `clips` cache (`caches.match(src)` → `blob()` → `new File([blob], name, {type:"video/mp4"})`). Results:
```
share-ui ["Sharing 1 file","49-concrete_example.mp4","No recommended people to share with","Quick Share","Drive","Maps","Add to Maps","Messages","Photos","Upload to Photos"]
share-res {"canShare":true}
share-after-back {"canShare":true,"share":"AbortError: Share canceled"}      # BACK closes the sheet
```
- It was the same with the server stopped (`off-share.png`). The Android sharesheet opens with the file name, and dismissing it rejects with `AbortError`.
- **The targets are the apps that take `ACTION_SEND` with `video/mp4`.** `adb shell cmd package query-activities --brief -a android.intent.action.SEND -t video/mp4` lists 9: Drive, Maps, Messages, Photos, Bluetooth, Gmail (2), Quick Share and **YouTube** (`Shell_UploadActivity`). The sheet showed the first row of these.
- Instagram and TikTok are not installed on the AVD. Meta's own Android sample for sharing a video to Instagram builds `new Intent(Intent.ACTION_SEND)` with type `"video/*"` and a chooser ([Instagram Sharing to Feed](https://developers.facebook.com/docs/instagram-platform/sharing-to-feed)). So Instagram takes `video/*` sends and should appear once installed. TikTok is unverified.

**Limits (Chromium source, tag 124.0.6367.219 and `main`, unchanged):**
- `navigator_share.cc`: `kMaxSharedFileCount = 10`, `kMaxSharedFileBytes = 50U * 1024 * 1024` ([L36-37](https://github.com/chromium/chromium/blob/124.0.6367.219/third_party/blink/renderer/modules/webshare/navigator_share.cc#L36-L37)). Going over logs "Share too large" and throws `NotAllowedError "Permission denied"` (L318-326).
  - Measured with a 51 MiB `big.mp4`: `canShare` returned **true**, then `share` → `NotAllowedError: ... Permission denied` and the console warning `Share too large`. So `canShare` does not check size, and the app must check `file.size` itself.
  - Clips are at most 3.3 MB, so one Clip is far under the limit.
- `share_service_impl.cc` lists the permitted extensions and MIME types, which include `.mp4` / `video/mp4`, `.webm` and `.mpeg` ([L72-160](https://github.com/chromium/chromium/blob/124.0.6367.219/chrome/browser/webshare/share_service_impl.cc#L72-L160)). The file name must end in a listed extension (`.mp4` for a Clip; `.m4v` is also listed for `video/mp4`).
- **User activation.** In 124, `share()` consumes transient activation and otherwise throws `NotAllowedError "Must be handling a user gesture to perform a share request."` ([L254-260](https://github.com/chromium/chromium/blob/124.0.6367.219/third_party/blink/renderer/modules/webshare/navigator_share.cc#L254-L260)).
  - Measured: a `share()` run 6 s after the tap threw exactly that. Read the File from the cache before the tap, or right after it, while the activation is still valid.
  - On `main`, the check is `HasTransientUserActivation` first, with the activation consumed later (`navigator_share.cc` L260-278). The rule is the same, and the timing is version-sensitive.
  - MDN lists the exceptions: `InvalidStateError` (document not fully active, or another share in progress), `NotAllowedError` (no transient activation, permissions policy, blocked files), `TypeError` (invalid data, or file sharing unsupported), `AbortError` (cancelled or no targets) and `DataError` ([navigator.share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)).
- **iOS:** files in `share` since Safari iOS 14 (BCD). Not run.

## 4. Keeping files on the phone

**Android Chrome 124, measured in the installed app:**
```
storage {"estimate":{"quota":3736869273,"usage":110213590,"usageDetails":{"caches":110194432,...}},
         "persisted":false,"persist":false,"persistedAfter":false}
```
- The quota is about 3.7 GB on a 6 GB data partition. The Feed buffer of about 43 Clips uses about 110 MB.
- MDN: Chromium lets an origin use "up to 60% of the total disk size in both persistent and best-effort modes". Under storage pressure, browsers evict best-effort origins whole, least recently used first, and skip origins granted `persist()` ([Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
- `navigator.storage.persist()` returned **false**, with no prompt. Chrome decides by heuristics: site engagement, "Has the site been installed or bookmarked?", and notification permission ([web.dev Persistent storage](https://web.dev/articles/persistent-storage)). On this AVD the "install" was a home-screen shortcut, not a WebAPK (R19 §3), on a fresh profile. The owner's phone may answer differently (see Unverified).
- Eviction is per origin, so the whole origin goes, not single Clips. A favorite kept in a separate Cache (for example `favorites`) beyond the Feed buffer is as safe as the rest of the origin. Without `persist()`, it can be evicted under storage pressure, together with the buffer. Clips are small, so the realistic risk is low. MDN cites Chrome research that "data is very rarely deleted by the browser". The durable copy stays on the Mac (`~/doomlearn/clips`).

**iOS Safari (WebKit, not run):**
- From Safari 17 / iOS 17, a browser app's origin gets "up to 60% of the total disk space", and a Home Screen Web App gets "the same origin quota" ([WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)).
- `persist()` is granted "based on heuristics like whether the website is opened as a Home Screen Web App".
- The 7-day cap on script-writable storage ("Service Worker registrations and cache" included) counts days of use separately for home-screen apps: "We do not expect the first-party in such a web application to have its website data deleted" ([WebKit: Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).

## Unverified

- **Where a download lands, and whether a Blob download works offline.** All downloads failed on Chrome 124 / Android 15 (evidence in §2). Proving this needs a current Chrome, which needs a Google sign-in in the Play Store, so it needs the owner. Check it on the owner's phone: the Blob-from-cache `<a download>` in airplane mode, then the Files app → Downloads.
- **Anything after Chrome 124.** Version-sensitive points: `showSaveFilePicker` (132+), the share activation timing (changed on `main`), and download behaviour.
- **iOS Safari.** None of this was run. The iOS Simulator (iOS 18.5) has no CLI tap, so user-activation APIs (share, download) cannot be driven cheaply. These remain open: where `<a download>` saves in a home-screen app (Files or Photos), whether the share sheet offers "Save Video", and whether `persist()` returns true in a home-screen app.
- **Instagram and TikTok as share targets.** They are not installed on the AVD. Instagram's docs show it takes `ACTION_SEND` `video/*`. I found no first-party TikTok doc for Android share intents. Whether either app accepts a file from a PWA share, and posts it, needs the owner's phone.
- **Why downloads fail on the emulator.** logcat `status: 1` (COMPLETE) contradicts the UI's "0.00 KB … failed"; whether bytes were written and only the MediaStore publish failed was not shown.
- **Delivery to a target.** The sheet opened with the file named. I did not complete a share into an app, because Photos and Drive need an account.
- **Native controls vs the Feed's tap.** I did not measure whether a tap on a video with `controls` both toggles the native UI and runs Slide.tsx's pause handler.
- **TikTok and Reels controls.** I found no first-party help page for their playback speed or scrub controls. Only YouTube's general help (not Shorts-specific) is cited.
- **`persist()` on the owner's phone.** A WebAPK install with real engagement may be granted. This AVD has a shortcut install on a fresh profile.
- **The tablet AVD now has the app installed and Chrome's first-run done.** Its display size and density were reset (`wm size reset`, `wm density reset`). Both emulators and both servers were stopped at the end (`adb devices` empty, no `qemu-system`, nothing on 8443).

## Gap round 1

### 1. How seeking, speed and taps meet the Feed's loop, implicit ✅ and tap-to-pause

**The code (`apps/web/src/Slide.tsx`).**
- `onEnded` (L223-228) sends `/api/seen` `completed: true` only on the first `ended` per Slide (`gesture.ended`). It then increments `gesture.loops`, calls `nudge()` when `loops` reaches `UI.nudgeLoops` (3), and calls `play()` to loop. `loops` resets only when the Slide leaves the screen (L111). `ended` is never reset.
- On the server, `seen` with `completed` records a `seen` event, and `seen` counts like a pressed ✅: it advances the Concept when the Concept is in today's Feed (`packages/core/src/feed.ts` L66-68, L249-251). So a fake `ended` moves the Concept up its ladder.
- `onClick` (L229-232) toggles pause at once. There is no delay window and no `dblclick` handler. The first tap of a session never reaches it: `Feed.tsx`'s capture-phase `unmute` listener stops it (L116-122).

**The spec.** The seek algorithm clamps: "If the new playback position is later than the end of the media resource", it uses the end. The seek itself fires only `seeking`, `timeupdate` and `seeked`. But when the playback position "reaches the end of the media resource" going forwards with no `loop`, the element fires `timeupdate`, sets `paused` and fires `pause` if it was playing, and then fires `ended` ([HTML, media elements](https://html.spec.whatwg.org/multipage/media.html#seeking), [playing the media resource](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource)). The load algorithm resets `playbackRate` to `defaultPlaybackRate` ("Set the playbackRate attribute to the value of the defaultPlaybackRate attribute"). Looping does not reset it (same page).

**Emulator probe.** Pixel_4_API_35, Chrome **124.0.6367.219**, installed app opened standalone, server on a temp home (worker paused). Script: `scratchpad/g1/g1-check.mjs` (seeks, rate and taps) and `scratchpad/g1/g1-ctl.mjs` (native controls). Taps are CDP `Input.synthesizeTapGesture` (trusted touch input) at CSS (80, 400), the left half of the video, clear of the rail. The first tap of each run was spent on the unmute. Event lists come from listeners on the `<video>`; `request` lines are Playwright's view of the network.
```
state {"label":"seek to duration while playing","ev":["seeked@2014ms t=58.61","pause@2014ms t=58.61","ended@2016ms t=0.00","play@2016ms t=0.00","seeked@2045ms t=0.00"],"paused":false,"nudge":false}
request {"url":"/api/seen","body":"{\"clipId\":72,\"completed\":true,...}"}
state {"label":"seek to duration+10 while playing","ev":["seeked@3945ms t=58.61","pause@...","ended@3945ms","play@3945ms","seeked@3988ms t=0.00"],"paused":false,"nudge":false}
state {"label":"pause, then seek to duration","ev":["pause@5116ms t=0.87","seeked@6214ms t=58.61","ended@6216ms t=0.00","play@6216ms t=0.00","seeked@6261ms t=0.00"],"paused":false,"nudge":true}
rate2-to-end {"msFor4sOfClip":2278,"rateAfterLoop":2,"paused":false}
state {"label":"single tap","ev":["click@12908ms t=1.52","pause@12908ms t=1.52"],"paused":true}
state {"label":"single tap again","ev":["click@13807ms t=1.52","play@13808ms t=2.00"],"paused":false}
state {"label":"two single taps 120 ms apart","ev":["click@14753ms t=3.39","pause@14753ms","click@15074ms t=3.39","dblclick@15074ms","play@15075ms"],"paused":false}
state {"label":"synthesized double-tap (tapCount 2)","ev":["click@16181ms t=5.71","pause@16181ms","click@16374ms t=5.71","dblclick@16375ms t=5.71","play@16375ms t=5.71"],"paused":false}
next {"other":true,"src":"81-contrast.mp4","rate":1,"paused":false,"oldRate":2}
```
(Full output: `scratchpad/g1/run1.txt`. A `/api/seen` request was sent only once in the whole run.)

What this shows:
- **A seek to the end, or past it, fires `ended` in Chrome 124.** The seek clamps to 58.61 s, Chrome pauses, fires `ended`, and the Feed's `onEnded` plays from 0. To the user it looks like a jump back to the start.
- **The first such seek sends the implicit ✅** (`/api/seen completed`), which advances the Concept. The learner never watched the Clip. A scrub bar that can reach the end must stop short of it (for example, clamp to `duration - 0.1`), or the ✅ rule must ignore ends reached by a seek.
- **Each seek to the end counts as a loop.** After three of them, the nudge showed (`nudge: true`), about 4 s after the Clip arrived.
- **A seek to the end while paused also fires `ended`.** `onEnded`'s `play()` then resumes the Clip. So scrubbing to the end while paused starts playback.
- **Speed shortens every loop, and with it the time to the nudge.** At rate 2, 4 s of Clip played in 2278 ms. The rate survived the loop (`rateAfterLoop: 2`). Three loops of a 58.6 s Clip then take about 88 s instead of about 176 s. The count of loops before the nudge does not change.
- **Speed does not carry to the next Clip.** Each Slide has its own `<video>`, and the next one played at rate 1. A Feed-wide speed setting must be applied to each `<video>`, for example in the play effect (L127-133).
- **A double-tap pauses and resumes.** Both the 120 ms pair and the synthesized double-tap gave `click`→`pause`, `click`→`play`, then `dblclick`. The Clip stopped for 194–321 ms, with `currentTime` frozen (5.71→5.71). A double-tap-to-skip on top of today's `onClick` would stutter. It would need `onClick` to wait out the double-tap window, which delays every single-tap pause by that window. Or it could act on `dblclick` and undo the pause.
- **Chrome fires `dblclick` on a touch double-tap here.** The page has `width=device-width` (`apps/web/index.html`) and the section has `touch-pan-y`, so no double-tap zoom gets in the way.
- An attempt with two parallel `adb shell input tap` produced only one `click` (the two taps landed 196 ms apart, or one was dropped). This says nothing about real fingers. It is not counted as evidence.

**Native `controls` and the Feed's tap** (this settles R18's "Native controls vs the Feed's tap" item). Output of `scratchpad/g1/run-ctl.txt`:
```
state {"label":"controls on, tap 1","ev":[],"paused":false,"t":2.74}
state {"label":"controls on, tap 2","ev":[],"paused":false,"t":4.25}
state {"label":"controls on, double-tap left","ev":["seeked@7864ms t=0.00"],"paused":false,"t":1.07}
state {"label":"controls on, double-tap right","ev":["seeked@10647ms t=11.62"],"paused":false,"t":11.93}
state {"label":"controls on, tap centre","ev":["pause@11281ms t=12.01"],"paused":true}
state {"label":"controls off again, tap","ev":["click@13153ms t=12.01","play@13155ms t=12.26"],"paused":false}
```
- With `controls` on, a tap on the video reaches no `click` listener. It only shows Chrome's control overlay (`scratchpad/g1/ctl-tap1.png`: centre pause button, `0:02 / 1:00`, scrub bar). Slide.tsx's tap-to-pause stops working. Only the centre button pauses.
- Chrome 124's native controls already have double-tap to seek: a double-tap on the left half went back 10 s (7.5 s → 0, clamped), and on the right half forward 10 s (1.6 s → 11.6 s).
- With `controls` off again, the Feed's tap works as before.

**Version-sensitive.** All of this is Chrome 124 on Android 15. The `ended`-on-seek and `dblclick` results follow the spec and should hold. The native controls' gestures (overlay on tap, ±10 s double-tap) are Chrome UI and can change between versions.

**Not checked.** iOS Safari (not run, see Unverified above). How a seek to the end behaves when it happens during a drag on a custom scrub bar (many `currentTime` writes in a row) was not measured; only single writes were.

## Gap round 2

Run on 2026-10-15. I added one system image, a global install that the scope rule allows only for the emulator check: `sdkmanager "system-images;android-36;google_apis;arm64-v8a"` (revision 7, a non-Play image). The same command also updated the SDK emulator to `37.2.12.0` (`emulator -version`). I created the AVD `R18_API_36` from it (`avdmanager create avd -n R18_API_36 -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_4`). Its Chrome is **133.0.6943.137** (`dumpsys package com.android.chrome`). Cold boot took about 12 s. I installed the app with R19 §3: Chrome's first run ("Use without an account"), then ⋮ → "Add to Home screen" → "Install" → "Add to home screen". Chrome 133 made a pinned shortcut too (`webapp_display_mode=3`). The server was a worktree `pnpm start` on a temp `DOOMLEARN_HOME` with a `VACUUM INTO` copy of the DB, the clips and the lexicon, worker paused. Scripts are in `scratchpad/g2/`.

### 1. Downloads work on Android. R18 §2's failures came from Playwright, not the emulator

**The cause.** R18's probe attached with `chromium.connectOverCDP(url)` and no options. On attach, Playwright sends `Browser.setDownloadBehavior` for the default context with `behavior: "deny"` unless downloads were accepted, and `downloadPath` set to a temp folder on the Mac:
- `playwright-core@1.63.0/lib/coreBundle.js` L38581-38587: `if (this._browser.options.name !== "clank" && this._options.acceptDownloads !== "internal-browser-default") { ... send("Browser.setDownloadBehavior", { behavior: this._options.acceptDownloads === "accept" ? "allowAndName" : "deny", ... downloadPath: this._browser.options.downloadsPath ...`
- L43126-43129: the default context of `connectOverCDP` gets `{ noDefaultViewport: true, ...options.noDefaults ? { acceptDownloads: "internal-browser-default" } : {} }`. Without `noDefaults`, `acceptDownloads` is unset, so the behavior is `deny`.
- The installed `types.d.ts` L25535-25547 documents the fix: with `noDefaults: true`, "Playwright will not apply its default overrides to the existing default browser context. Specifically, `acceptDownloads` is left at the browser's setting" (same text in ctx7 `/microsoft/playwright`, `ConnectOverCDPOptions`).

**How I found it.** On Chrome 133 with R18's probe unchanged, everything still failed: `1 download failed` for the 5-byte text Blob, and `0.00 KB / 2.88 MB • failed` in the Downloads screen. A page-initiated Blob download on `https://httpbin.org/html` failed the same way. A download that no script attached to worked: an `am start` VIEW of `https://httpbin.org/response-headers?Content-Disposition=attachment...` (and the same over plain `http`) left `g2.txt.json` and `g2http.txt.json` in `/sdcard/Download`. Then the same Blob test on httpbin with `connectOverCDP(url, { noDefaults: true })`:
```
page https://httpbin.org/html secure true
ui httpbin.org/html | File downloaded | (0.00 KB)  | Open
Download dir g2-httpbin-nodef.txt g2.txt.json g2http.txt.json
```
(`g2/g2-origin.mjs`, `NODEF=1`.) Also, the logcat `cr_DownloadCm ... status:` lines that R18 §2 read are not a download result. They come from `DownloadContinuityManager.updateDownloadStatus`, the notification and foreground-service bookkeeping ([DownloadContinuityManager.java L57-79 @133.0.6943.137](https://github.com/chromium/chromium/blob/133.0.6943.137/chrome/android/java/src/org/chromium/chrome/browser/download/DownloadContinuityManager.java#L57-L79)). The httpbin download that did land logged `status: 2` (`FAILED` in [DownloadStatus.java](https://github.com/chromium/chromium/blob/133.0.6943.137/chrome/browser/download/android/java/src/org/chromium/chrome/browser/download/DownloadStatus.java)).

**The doomlearn probe with `noDefaults: true`** (`g2/g2-dl.mjs`, R18's probe plus a 5-byte text Blob and a `showSaveFilePicker` button), installed app, standalone, on a cached Clip:

| | Chrome 133 / API 36, online | Chrome 133, server stopped | Chrome 124 / API 35, online | Chrome 124, server stopped |
|---|---|---|---|---|
| 5-byte text Blob `<a download>` | lands | not run | lands | not run |
| Blob from the `clips` cache, `<a download>` | lands | **lands** | lands | **lands** |
| `<a href="/clips/x.mp4" download>` | lands | `Download paused` | lands | `Download paused` |
| `showSaveFilePicker` | not run | **lands** (picker) | `undefined` (R18) | `undefined` (R18) |

Evidence:
```
# Chrome 133, online: adb shell ls -la /sdcard/Download
-rwxrwx--- 1 u0_a210 media_rw 3016650 ... blob-48-mechanism.mp4
-rwxrwx--- 1 u0_a210 media_rw       5 ... g2-hello.txt
-rwxrwx--- 1 u0_a210 media_rw 3016650 ... url-48-mechanism.mp4
# md5 of both mp4s and of ~/doomlearn/clips/48-mechanism.mp4: 0675ddc619158125d12e92efb56c1094
# Chrome 133, server stopped (nothing listening on 8443):
dl-blob-ui ["Web View","File downloaded","(2.88 MB) ","Open"]
dl-url-download-dir unchanged
dumpsys notification: url-48-mechanism.mp4 "Download paused" | blob-48-mechanism.mp4 "Download complete • 2.88 MB"
save-picker-ui ["Downloads","Files in Downloads",...,"picker-48-mechanism.mp4","SAVE"]
res {"picker":"function","save":"written picker-48-mechanism.mp4"}   # after tapping SAVE; same md5
# Chrome 124, server stopped:
dl-blob-ui ["Web View","File downloaded","(2.49 MB) ","Open"]   # md5 1832d7c6... matches the source Clip
dl-url-download-dir unchanged; notification "Download paused"
```

**Where the file lands.** In the shared `Download/` folder, indexed by MediaStore as a video. So the Files app, Photos and any app that reads the gallery can see it:
```
adb shell content query --uri content://media/external/video/media --projection _display_name:relative_path:mime_type:_size
Row: 0 _display_name=blob-48-mechanism.mp4, relative_path=Download/, mime_type=video/mp4, _size=3016650
Row: 1 _display_name=url-48-mechanism.mp4, relative_path=Download/, mime_type=video/mp4, _size=3016650
```
Google Photos on the API 36 image, opened without an account (sign-in sheet dismissed), lists a **Download** folder holding the video (`g2/photos.png`). The `showSaveFilePicker` file is also in `Download/`, because the system picker (DocumentsUI) opened there. The user can pick another folder. Its MediaStore row showed `_size=131072` 10 s after the write, while the file on disk had the full size and the right md5, so the index lagged.

**What this means for downloads.**
- On Android Chrome (124 and 133), the **Blob-from-cache `<a download>` is the offline download**. It needs no network and lands in Downloads, visible to Photos. The URL `<a download>` needs the Mac and stalls at "Download paused" offline (Chrome resumes it when the network returns; I did not wait to see).
- `showSaveFilePicker` (Chrome 132+) works offline too, but it asks for a folder every time. It does not exist on iOS.
- **R19's recipe can prove a download** if the script attaches with `connectOverCDP(url, { noDefaults: true })`. R19's `phone-check.mjs` attaches without it. The existing API 35 AVD is enough. The new API 36 AVD gives a Chrome closer to the owner's.

**Version-sensitive.** The owner's phone runs a newer Chrome than 133, and its real download path also has a Google account. The table above held on both 124 and 133.

### 2. A horizontal scrub drag and the Passage swipe and long-press

**The code (`apps/web/src/Slide.tsx`).** Both gestures live on the Slide's `<section>` (L180-214), which has `touch-pan-y` (L186). So they see every touch inside it, the rail and the Passage included:
- **Passage swipe** (L206-213): React `onTouchStart` stores the first touch; `onTouchEnd` compares it with the lifting touch. If `|dx| > 60` (`UI.swipePx`) and `|dx| > 1.5·|dy|` (`UI.swipeRatio`), it calls `read(!reading)`. Nothing checks the target, so it starts from any point inside the section, and only the start and end points count. A drag on a scrub bar that ends more than 60 px sideways from where it began opens the Passage on lift. A swipe inside the open Passage (the `<aside>` is a child) closes it. A swipe that starts on a rail button also counts, from the code (not measured).
- **Long-press** (L188-203): `onPointerDown` starts a 500 ms (`UI.longPressMs`) timer that toggles `clean` (overlays hidden), unless the target is inside a `button` or `aside`. `onPointerMove` cancels it after 10 px (`UI.movePx`). A scrub bar that is not a `<button>` gets the timer: holding still on it hides the overlays.
- **Can a child stop them?** Yes, by stopping propagation. React attaches its handlers at the root, and `e.stopPropagation()` "stops the event propagation through the React tree" ([react.dev, common components](https://react.dev/reference/react-dom/components/common), via ctx7 `/reactjs/react.dev`). So a scrub bar component that calls `stopPropagation()` in its own `onTouchStart`/`onTouchEnd` and `onPointerDown` keeps both gestures out. `touch-action` does not help. It controls browser panning and zooming, not whether touch events fire. The section already has `pan-y`, so a sideways drag is never taken over by the browser, and `touchend` always arrives (measured below).

**Emulator probe** (`g2/g2-swipe.mjs` and `g2-swipe-end.mjs`; Chrome 133 / API 36, installed app, standalone). An `<input type=range>` (0-1000, setting `currentTime = value/1000 · duration`) is placed in the Slide's section at 70% height, in three variants: plain, `touch-action:none`, and with native `stopPropagation()` on `touchstart`, `touchend` and `pointerdown`. **Both drivers work:** CDP `Input.dispatchTouchEvent` (touchStart, 12 touchMoves, touchEnd) and `adb shell input swipe` (calibrated: the page starts 67 device px down, dpr 2.75). Both produce real `touchstart`/`touchend` on the section and drag the native range thumb. Results (state read 700 ms after lift; full output in `g2/swipe-run1.txt`, `swipe-run2.txt`):
```
video, CDP drag left 200 px               passageOpen:true  touches:[touchstart:300,300, touchend:100,310]
video, adb swipe left 200 px              passageOpen:true
video, CDP hold 700 ms                    overlaysHidden:true
range, CDP drag 10%->60%                  bar:606 t:32.5  passageOpen:true   (13 seeks, then pause: the Passage paused it)
range, adb swipe 10%->60%                 bar:597 t:32.0  passageOpen:true
range, CDP drag 20 px                     bar:393         passageOpen:false  (under 60 px)
range, CDP hold 700 ms                    bar:323         overlaysHidden:true (the tap also jumped the thumb)
range touch-action:none, CDP drag         bar:606         passageOpen:true   (no change)
range stopPropagation, CDP drag           bar:606 t:32.9  passageOpen:false  overlaysHidden:false  touches:[]
range stopPropagation, adb swipe          bar:606         passageOpen:false
range stopPropagation, CDP hold 700 ms                    overlaysHidden:false
```
- **A plain scrub bar collides with both gestures.** A real-length scrub opens the Passage on lift and pauses the Clip. A still press on the bar hides the overlays after 500 ms. `touch-action:none` changes nothing. With `stopPropagation()` on the bar, the drag only scrubs, and neither gesture fires.
- **A sideways swipe on the video still opens the Passage**, so a bar that stops propagation leaves the Passage swipe intact everywhere else.

**Drag to the end** (the case R18's gap round 1 left open; CDP drag from 50% to 40 px past the bar's right end):
```
stopPropagation, playing:        bar:1000 ... seeking@53.63, seeked@53.63, pause@53.64, ended@0.00, play@0.00  seenRequests:1  t:0.09
clamp to duration-0.1, playing:  ... seeked@59.90, pause@60.00, ended@0.00, play@0.00 (within 3 s)          seenRequests:1
stopPropagation, paused first:   ... seeked@50.07, no ended after 3 s, paused:true                            seenRequests:0
clamp to duration-0.1, paused:   ... seeked@49.97, no ended, paused:true                                      seenRequests:0
```
- **While playing, dragging to the end ends the Clip, loops it and sends the implicit ✅** (`/api/seen`, one request). Clamping to `duration - 0.1` does not prevent this: the Clip plays the last 0.1 s and ends on its own. To keep a scrub from counting as a watch, either pause during the drag, or have `onEnded` ignore an end reached soon after a seek.
- **While paused, a drag to the end did not fire `ended`** on Chrome 133. Gap round 1 measured a single `currentTime = duration` write on a paused Clip firing `ended` on Chrome 124. The two runs differ in Chrome version and in how the seek was made (many writes in a row vs one). I did not separate the two (see below). Treat the paused case as version-sensitive.

**Not run here:** CDP `Input.synthesizeScrollGesture`, because `dispatchTouchEvent` and `adb input swipe` both worked. A scrub bar on a rail button or inside the Passage. The paused-end case on Chrome 124.

### Unverified in this round

- **The owner's phone.** Downloads were proven on the emulator's Chrome 124 and 133 without a Google account. A current Chrome with an account may add a prompt (for example "Download again?" or a download location setting). Not checked.
- **Instagram and TikTok reading the downloaded file.** Photos sees it through MediaStore, which is how gallery pickers find videos. Neither app is installed here.
- **Why paused-end differs.** Single write vs scrub on Chrome 133, and scrub on Chrome 124, were not run.
- **State left behind.** The new AVD `R18_API_36` (Chrome 133, app installed, Chrome first run done, Photos sign-in sheet dismissed) stays for later checks. Its `/sdcard/Download` still holds the test files. The API 35 AVD's `/sdcard/Download` was emptied. Both emulators and the server were stopped (`adb devices` empty, no `qemu-system`, nothing on 8443).
