//
// Serves the app shell and the buffered Clips from cache, so the Feed opens and plays with the Mac unreachable.
// The page decides which Clips are in the buffer (app.js keepBuffer); /api is always left to the network.
//

const SHELL = { cache: "shell", files: ["/", "/app.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"] };

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL.cache).then((cache) => cache.addAll(SHELL.files)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { pathname } = new URL(event.request.url);
  if (event.request.method !== "GET" || pathname.startsWith("/api/")) return;
  if (pathname.startsWith("/clips/")) return event.respondWith(clip(event.request));
  // The shell answers from cache at once and refreshes in the background, for the next launch.
  event.respondWith(
    caches.open(SHELL.cache).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request).then((res) => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      });
      if (!cached) return network;
      event.waitUntil(network.catch(() => {}));
      return cached;
    }),
  );
});

/**
 * A buffered Clip from cache, cut to the byte range the video element asks for; otherwise the network.
 */
async function clip(request) {
  const cached = await caches.match(request.url);
  if (!cached) return fetch(request);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range) return cached;
  const blob = await cached.blob();
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-range": `bytes ${start}-${end}/${blob.size}`,
      "content-length": String(end - start + 1),
    },
  });
}
