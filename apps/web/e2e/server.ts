import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { openData } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { createInbox } from "@doomlearn/core/inbox";
import { Refused } from "@doomlearn/core/media";
import { createPipeline } from "@doomlearn/core/pipeline";
import { createPronunciation } from "@doomlearn/core/pronunciation";
import { clips, concepts } from "@doomlearn/core/schema";
import { createSources } from "@doomlearn/core/sources";
import { createTranslations } from "@doomlearn/core/translations";
import { publishLiveness } from "@doomlearn/core/status";
import { fakeAgent, fakeMedia } from "@doomlearn/core/test/fakes";
import { feedApp } from "@doomlearn/server/src/server.ts";

/**
 * The built app (`vite build`), which the server serves, and the v1 app it replaced.
 */
const [DIST, LEGACY] = ["../dist", "../legacy"].map((dir) => fileURLToPath(new URL(dir, import.meta.url)));
/**
 * Three 2 s VP9 WebM Clips, since Playwright's Chromium plays no H.264. Made with:
 * `ffmpeg -f lavfi -i "testsrc2=size=270x480:rate=15:duration=2,hue=h=<120|240|360>" -c:v libvpx-vp9 -b:v 60k -an clip-<n>.webm`
 */
const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

/**
 * The server app on fakes, in a fresh data folder: one Source whose 3 Concepts each have a Clip, the third a due
 * Review at its second step. Listens on a free port of 127.0.0.1, so each test gets its own origin: its own service
 * worker, caches and localStorage.
 */
export async function startServer() {
  const temp = await mkdtemp(join(tmpdir(), "doomlearn-e2e-"));
  const home = join(temp, "home");
  await mkdir(home);
  await writeFile(join(home, "config.json"), "{}");
  const data = openData(home);
  const book = join(home, "book.md");
  await writeFile(book, "Threads\nMutexes\nPointers");
  const media = fakeMedia({ chapters: [{ title: "Concurrency", text: "Threads\nMutexes\nPointers" }] });
  await createSources(data, media).add(book);
  const agent = fakeAgent({
    extract: (chapter) =>
      chapter.split("\n").map((line) => ({
        title: line,
        summary: line,
        angles: ["concrete_example"],
        anchor: { chapter: line },
      })),
  });
  const pipeline = createPipeline(data, agent, media);
  while (await pipeline.tick());

  // The fake render writes stub mp4s: each becomes a WebM fixture, under a name that serves as video/webm.
  const rows = data.db.select().from(clips).orderBy(clips.id).all();
  for (const [i, clip] of rows.entries()) {
    const file = clip.file.replace(/\.mp4$/, ".webm");
    await copyFile(join(FIXTURES, `clip-${i + 1}.webm`), file);
    data.db.update(clips).set({ file }).where(eq(clips.id, clip.id)).run();
  }
  data.db
    .update(concepts)
    .set({ status: "scheduled", ladderStep: 1, dueAt: new Date(0) })
    .where(eq(concepts.id, rows[2].conceptId))
    .run();
  // The worker is up, as the server's fork reports it; a test can publish a Blocker over it.
  publishLiveness(data, { liveness: "running" });

  /**
   * Bumped by `bumpSw`, so the browser sees a new service worker.
   */
  let swVersion = 0;
  /**
   * While set, every API request is accepted and never answered.
   */
  let hanging = false;
  /**
   * Uploads named scanned.pdf are refused, as a PDF with no text layer is.
   */
  const uploads = {
    ...media,
    convert: async (file: string) => {
      if (file.endsWith("/scanned.pdf")) throw new Refused("Scanned PDF: 2 of 3 pages have no text layer");
      return media.convert(file);
    },
  };
  /**
   * While set, the server serves the v1 app in place of the built one, as before cut-over.
   */
  let legacy = false;
  /**
   * The server's own app: the API, the Clips and the built PWA.
   */
  const api = feedApp(data, {
    feed: createFeed(data),
    sources: createSources(data, uploads),
    inbox: createInbox(data),
    pronunciation: createPronunciation(data),
    translations: createTranslations(data),
    // No real CLI in the e2e run: Codex's probe fails and Claude's login is unknown.
    probes: { codex: async () => undefined, claudeAuthMethod: async () => undefined },
    // Codex's model list, as far as these tests go, holds every model but gpt-retired.
    preflight: async (config) => ({
      problems: [],
      warnings: Object.entries(config.agents.stages)
        .filter(([, agent]) => agent.provider === "codex" && agent.model === "gpt-retired")
        .map(([stage, agent]) => `codex model "${agent.model}" (${stage}) is not in codex's model list`),
    }),
  });
  const app = new Hono()
    .get("/sw.js", async (c) =>
      c.body(
        legacy
          ? await readFile(join(LEGACY, "sw.js"), "utf8")
          : `${await readFile(join(DIST, "sw.js"), "utf8")}\n// ${swVersion}`,
        200,
        { "content-type": "text/javascript" },
      ),
    )
    .use("*", (c, next) => (legacy ? serveStatic({ root: LEGACY })(c, next) : next()))
    .use("/api/*", (_c, next) => (hanging ? new Promise<never>(() => {}) : next()))
    .route("/", api);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    data,
    bumpSw: () => swVersion++,
    /**
     * Serves the v1 app (`true`) or the built one (`false`), as before and after cut-over.
     */
    serveLegacy: (on: boolean) => (legacy = on),
    /**
     * The Mac off ZeroTier: connections open, but the API never answers.
     */
    hang: () => (hanging = true),
    /**
     * The Mac back, on the same origin.
     */
    resume: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(undefined))),
    /**
     * The Mac gone: connections are refused, as with the server stopped.
     */
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as Server).closeAllConnections();
      }),
    /**
     * Closes the database and deletes the data folder, once the test is over.
     */
    cleanup: async () => {
      data.db.$client.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
