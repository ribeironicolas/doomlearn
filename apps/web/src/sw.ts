/// <reference lib="webworker" />
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { RangeRequestsPlugin } from "workbox-range-requests";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

//
// Serves the app shell, the buffered Clips and the Favorites from cache, so the Feed and Favorites open and play with
// the Mac unreachable. The page decides which Clips are in the buffer (sync.ts keepBuffer) and in `favorites`
// (sync.ts syncFavorites); /api is always left to the network.
//

declare let self: ServiceWorkerGlobalScope;

/**
 * A full answer: only these are cached.
 */
const STATUS = { ok: 200 };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//, /^\/clips\//] }));
// A buffered Clip, else a Favorite's, cut to the byte range the video element asks for; otherwise the network.
// Playback's 206 answers are never cached here: only the page's full GETs fill `clips`.
registerRoute(
  ({ url }) => url.pathname.startsWith("/clips/"),
  new CacheFirst({
    cacheName: "clips",
    plugins: [
      new CacheableResponsePlugin({ statuses: [STATUS.ok] }),
      {
        cachedResponseWillBeUsed: async ({ request, cachedResponse }) =>
          cachedResponse ?? caches.match(request, { cacheName: "favorites" }),
      },
      new RangeRequestsPlugin(),
    ],
  }),
);

// A waiting version takes over only when the Learner taps "Reload".
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// v1's shell cache has no use once this worker runs the origin.
self.addEventListener("activate", (event) =>
  event.waitUntil(Promise.all([caches.delete("shell"), self.clients.claim()])),
);
