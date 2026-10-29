import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { logger } from "hono/logger";
import type { BlankEnv } from "hono/types";
import { z } from "zod";
import * as api from "@doomlearn/core/api";
import { Refused } from "@doomlearn/core/media";
import { ConfigSchema, parseConfig, saveConfig } from "@doomlearn/core/config";
import { type Config, type Data, InvalidLexicon } from "@doomlearn/core/data";
import { createFeed } from "@doomlearn/core/feed";
import { createInbox } from "@doomlearn/core/inbox";
import { createPronunciation, NotFound } from "@doomlearn/core/pronunciation";
import { localMedia } from "@doomlearn/media/local-media";
import { createSources } from "@doomlearn/core/sources";
import { AlreadyMade, createTranslations } from "@doomlearn/core/translations";
import { workerStatus } from "@doomlearn/core/status";
import { recordUsage, type UsageReading, usageReport } from "@doomlearn/core/usage";
import { type Preflight, preflightAgents } from "@doomlearn/agents/agent";
import { claudeAuthMethod } from "@doomlearn/agents/claude";
import { codexUsage } from "@doomlearn/agents/codex";
import { tlsSetup } from "./tls.ts";

/**
 * What the usage route asks the Providers' CLIs: Codex's Usage windows (`undefined` when the probe fails), and how
 * Claude is logged in (`undefined` when unknown).
 */
export type UsageProbes = {
  codex(): Promise<UsageReading[] | undefined>;
  claudeAuthMethod(): Promise<string | undefined>;
};

type Modules = {
  feed: ReturnType<typeof createFeed>;
  sources: ReturnType<typeof createSources>;
  inbox: ReturnType<typeof createInbox>;
  pronunciation: ReturnType<typeof createPronunciation>;
  translations: ReturnType<typeof createTranslations>;
  probes: UsageProbes;
  /** The agent preflight a config save runs, for its warnings. */
  preflight(config: Config): Promise<Preflight>;
};

/**
 * A config save from the PWA: the version (mtime) it read, and the sections it may edit. Each section sent replaces
 * the saved one, and a section left out stays as saved; `server.*` is edited only in the file.
 */
const configSave = z.strictObject({
  version: z.number(),
  // Unwrapped from their `{}` prefault, which would turn a section left out into its defaults.
  worker: ConfigSchema.shape.worker.unwrap().optional(),
  agents: ConfigSchema.shape.agents.unwrap().optional(),
});

/**
 * How long the usage route waits for a probe, under the PWA's 5 s: the Codex probe was measured at about 0.5 s.
 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * What `within` resolves to when a probe takes over 3 s.
 */
const TIMED_OUT = Symbol("timed out");

/**
 * `probe`'s answer, or `TIMED_OUT` after 3 s.
 */
function within<T>(probe: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    probe,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), PROBE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The built PWA (`vite build`), served at the same origin and service-worker path as the v1 app it replaces.
 */
const WEB = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * The HTTP status codes the routes answer with.
 */
const STATUS = {
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  tooLarge: 413,
  unprocessable: 422,
} as const;

/**
 * Request body caps in bytes: 64 KB for a JSON body, 200 MB for an uploaded Source file.
 */
const MAX_BYTES = { json: 65_536, upload: 209_715_200 };

/**
 * A Clip's file as the URL the app fetches it from.
 */
const withUrl = <T extends { file: string }>({ file, ...row }: T) => ({ ...row, url: `/clips/${basename(file)}` });

/**
 * Answers invalid input with 400 and the zod error tree.
 */
const invalid = (result: { success: true } | { success: false; error: z.core.$ZodError }, c: Context) => {
  if (!result.success) return c.json(z.treeifyError(result.error), STATUS.badRequest);
};

const jsonLimit = bodyLimit({ maxSize: MAX_BYTES.json });

/**
 * Validates a v1 route's JSON body. The legacy app posts with no Content-Type, so the browser sends text/plain,
 * which zod-validator's json target skips: the raw text is parsed here instead.
 */
const body = <T extends z.ZodType>(schema: T) =>
  createMiddleware<BlankEnv, string, { in: { json: z.input<T> }; out: { json: z.output<T> } }>(async (c, next) => {
    let value: unknown;
    try {
      value = JSON.parse(await c.req.text());
    } catch {
      return c.json({ errors: ["Malformed JSON"] }, STATUS.badRequest);
    }
    const result = schema.safeParse(value);
    if (!result.success) return c.json(z.treeifyError(result.error), STATUS.badRequest);
    c.req.addValidatedData("json", result.data as object);
    await next();
  });

/**
 * The Feed, search, inbox and Sources over HTTP, the Clips and the PWA from `web`. Each API route only calls one module.
 */
export function feedApp(
  data: Data,
  { feed, sources, inbox, pronunciation, translations, probes, preflight }: Modules,
  web = WEB,
) {
  const { home } = data;
  /** `config.json`'s version: its mtime, which a hand edit changes too. */
  const version = () => statSync(join(home, "config.json")).mtimeMs;
  /**
   * Preview `id` as the fix sheet polls it, with the URL of its wav once spoken.
   */
  const previewState = (id: number) => {
    const state = pronunciation.poll(id);
    return { ...state, wavUrl: state.status === "done" ? `/api/preview/wav?id=${id}` : null };
  };
  /**
   * Runs a fix sheet, 🌐 sheet or ⋯ menu route's `answer`. Answers 409 with the error message on `InvalidLexicon`
   * (so the Lexicon file is never overwritten), `AlreadyMade` or `Refused` (its JSDoc lists the cases). Answers 404
   * when the 🚩 is not open, or the sentence, preview, Clip, chapter or Concept does not exist.
   */
  const refusing = (c: Context, answer: () => Response) => {
    try {
      return answer();
    } catch (error) {
      if (error instanceof InvalidLexicon || error instanceof AlreadyMade || error instanceof Refused)
        return c.json({ error: error.message }, STATUS.conflict);
      if (error instanceof NotFound) return c.json({ error: error.message }, STATUS.notFound);
      throw error;
    }
  };
  const routes = new Hono()
    .use(csrf())
    .get("/next", (c) => c.json(feed.next().map(withUrl)))
    .get("/today", (c) => c.json(feed.today()))
    .get("/favorites", (c) => c.json(feed.favorites().map(withUrl)))
    .post("/favorite", jsonLimit, body(api.favorite), (c) => {
      const { clipId, on } = c.req.valid("json");
      feed.favorite(clipId, on);
      return c.body(null, STATUS.noContent);
    })
    .get("/search", zValidator("query", api.search, invalid), (c) =>
      c.json(feed.search(c.req.valid("query").q).map(withUrl)),
    )
    .get("/inbox", (c) => {
      const { flags, ...rest } = inbox.list();
      return c.json({ flags: flags.map(withUrl), ...rest });
    })
    .post("/resolve", jsonLimit, body(api.eventId), (c) => {
      inbox.resolve(c.req.valid("json").eventId);
      return c.body(null, STATUS.noContent);
    })
    .post("/regenerate", jsonLimit, body(api.eventId), (c) => {
      inbox.regenerate(c.req.valid("json").eventId);
      return c.body(null, STATUS.noContent);
    })
    .get("/fix", zValidator("query", api.eventIdQuery, invalid), (c) =>
      refusing(c, () => c.json(pronunciation.sheet(c.req.valid("query").eventId))),
    )
    // Save on the fix sheet: the fixes go into the Clip's Language Lexicon, and the 🚩 Clip is regenerated.
    .post("/fix", jsonLimit, body(api.fixes), (c) => {
      const { eventId, fixes } = c.req.valid("json");
      return refusing(c, () => {
        pronunciation.save(eventId, fixes);
        return c.body(null, STATUS.noContent);
      });
    })
    .post("/preview", jsonLimit, body(api.preview), (c) => {
      const { eventId, fixes, ...at } = c.req.valid("json");
      return refusing(c, () => {
        const id = pronunciation.preview(eventId, at, fixes);
        return c.json({ id, ...previewState(id) }, STATUS.created);
      });
    })
    .get("/preview", zValidator("query", api.previewId, invalid), (c) =>
      refusing(c, () => c.json(previewState(c.req.valid("query").id))),
    )
    // Served once: the sheet fetches it whole, then the file is gone.
    .get("/preview/wav", zValidator("query", api.previewId, invalid), (c) => {
      const { id } = c.req.valid("query");
      const wav = pronunciation.takeWav(id);
      return wav
        ? c.body(new Uint8Array(wav), STATUS.ok, { "content-type": "audio/wav" })
        : c.json({ error: `No wav for preview #${id}` }, STATUS.notFound);
    })
    // The 🌐 sheet: each other Language made, in progress, held by the daily Clip cap or a Blocker.
    .get("/translations", zValidator("query", api.clipIdQuery, invalid), (c) =>
      refusing(c, () => {
        const { languages, ...sheet } = translations.sheet(c.req.valid("query").clipId);
        return c.json({
          ...sheet,
          languages: languages.map((row) => ({ ...row, made: row.made && withUrl(row.made) })),
        });
      }),
    )
    // "Make in <Language>": the translate job, queued once for its Concept, Angle and Language.
    .post("/translate", jsonLimit, body(api.translate), (c) => {
      const { clipId, language } = c.req.valid("json");
      return refusing(c, () => c.json(translations.queue(clipId, language)));
    })
    .get("/sources", (c) => c.json(sources.status()))
    // The Source screen: chapters in book order, each with the Concepts it teaches and their Clips.
    .get("/sources/:id", zValidator("param", api.sourceIdParam, invalid), (c) => {
      const { id } = c.req.valid("param");
      const source = sources.source(id);
      if (!source) return c.json({ error: `No Source #${id}` }, STATUS.notFound);
      return c.json({
        ...source,
        chapters: source.chapters.map((chapter) => ({
          ...chapter,
          concepts: chapter.concepts.map((concept) => ({ ...concept, clips: concept.clips.map(withUrl) })),
        })),
      });
    })
    // The file is the raw body, streamed to disk; it keeps its name, which the Source's title and any refusal come from.
    .post(
      "/sources",
      bodyLimit({ maxSize: MAX_BYTES.upload, onError: (c) => c.json({ error: "file over 200 MB" }, STATUS.tooLarge) }),
      zValidator("query", api.upload, invalid),
      async (c) => {
        const dir = await mkdtemp(join(tmpdir(), "doomlearn-upload-"));
        try {
          const file = join(dir, basename(c.req.valid("query").name));
          await pipeline(
            Readable.fromWeb((c.req.raw.body ?? new Blob().stream()) as ReadableStream),
            createWriteStream(file),
          );
          return c.json(await sources.add(file), STATUS.created);
        } catch (error) {
          if (error instanceof Refused) return c.json({ error: error.message }, STATUS.unprocessable);
          throw error;
        } finally {
          await rm(dir, { recursive: true });
        }
      },
    )
    .post("/pause", jsonLimit, body(api.sourceId), (c) => {
      sources.pause(c.req.valid("json").sourceId);
      return c.body(null, STATUS.noContent);
    })
    .post("/resume", jsonLimit, body(api.sourceId), (c) => {
      sources.resume(c.req.valid("json").sourceId);
      return c.body(null, STATUS.noContent);
    })
    // A chapter's or Concept's ⋯ menu on the Source screen, which picks the result up on its poll.
    .post("/chapters/:id/:action", zValidator("param", api.itemAction, invalid), (c) => {
      const { id, action } = c.req.valid("param");
      return refusing(c, () => {
        sources.chapter(id, action);
        return c.body(null, STATUS.noContent);
      });
    })
    .post("/concepts/:id/:action", zValidator("param", api.itemAction, invalid), (c) => {
      const { id, action } = c.req.valid("param");
      return refusing(c, () => {
        sources.concept(id, action);
        return c.body(null, STATUS.noContent);
      });
    })
    .post("/retry", jsonLimit, body(api.jobId), (c) => {
      sources.retry(c.req.valid("json").jobId);
      return c.body(null, STATUS.noContent);
    })
    .post("/press", jsonLimit, body(api.press), (c) => {
      const { clipId, button, clientEventId, reason, note } = c.req.valid("json");
      feed.press(clipId, button, clientEventId, { reason, note });
      return c.body(null, STATUS.noContent);
    })
    .post("/seen", jsonLimit, body(api.seen), (c) => {
      const { clipId, clientEventId, completed } = c.req.valid("json");
      feed.seen(clipId, clientEventId, { completed });
      return c.body(null, STATUS.noContent);
    })
    .get("/status", (c) => c.json(workerStatus(data)))
    .get("/config", (c) => c.json({ config: data.config(), version: version() }))
    // Refused when the file changed since the PWA read it, or is broken on disk, so a hand edit is never overwritten. The
    // worker applies it at its next tick (worker.*) or next stage (agents.*); the preflight's warnings, e.g. an unknown
    // Codex model, never block. A refused value answers 400 with the problems as text, which Settings shows.
    .put(
      "/config",
      jsonLimit,
      zValidator("json", configSave, (result, c) => {
        if (!result.success) return c.json({ error: z.prettifyError(result.error) }, STATUS.badRequest);
      }),
      async (c) => {
        const { version: read, ...sections } = c.req.valid("json");
        if (read !== version()) return c.json({ error: "config changed on disk, reload" }, STATUS.conflict);
        const current = data.config();
        const configError = data.configError();
        if (configError) return c.json({ error: configError }, STATUS.conflict);
        const config = parseConfig({ ...current, ...sections });
        saveConfig(home, config);
        const { warnings } = await preflight(config);
        return c.json({ version: version(), warnings });
      },
    )
    // Probes only the Providers a stage uses, each for at most 3 s; Codex's fresh windows are saved like any reading.
    .get("/usage", zValidator("query", api.usage, invalid), async (c) => {
      const used = Object.values(data.config().agents.stages).map((stage) => stage.provider);
      const [codex, authMethod] = await Promise.all([
        used.includes("codex") ? within(probes.codex()) : undefined,
        used.includes("claude") ? within(probes.claudeAuthMethod()) : undefined,
      ]);
      const unavailable: { claude?: string; codex?: string } = {};
      if (Array.isArray(codex)) recordUsage(data, "codex", codex);
      else if (used.includes("codex"))
        unavailable.codex = codex === TIMED_OUT ? "codex probe timed out" : "codex probe failed";
      if (typeof authMethod === "string" && authMethod !== "claude.ai") {
        unavailable.claude = `${authMethod} login has no plan windows`;
      }
      return c.json(usageReport(data, { ...c.req.valid("query"), unavailable }));
    });
  return (
    new Hono()
      .use(logger())
      .route("/api", routes)
      // Both answer Range requests, so video can seek; neither serves a path outside its folder.
      .use("/clips/*", serveStatic({ root: home }))
      .use("*", serveStatic({ root: web }))
      // Any other page is the app, as React Router owns the paths; a missing API route or Clip stays a 404.
      .get("*", (c, next) =>
        /^\/(api|clips)\//.test(c.req.path) ? next() : serveStatic({ root: web, path: "index.html" })(c, next),
      )
  );
}

/**
 * The server's routes, for the PWA's typed `hc` client.
 */
export type AppType = ReturnType<typeof feedApp>;

/**
 * Serves the Feed on the `server.hosts` addresses only (keep them to loopback and ZeroTier so the home Wi-Fi cannot reach it).
 * TLS is decided from disk: with the mkcert cert (whose root CA the phone trusts), HTTPS on every host;
 * with none and only loopback hosts, plain HTTP on 127.0.0.1; a non-loopback host without a cert refuses to start.
 */
export function serve(data: Data, port = data.config().server.port) {
  const { hosts } = data.config().server;
  const { cert, key, mkcert, remote } = tlsSetup(data.home, hosts);
  const app = feedApp(data, {
    feed: createFeed(data),
    sources: createSources(data, localMedia),
    inbox: createInbox(data),
    pronunciation: createPronunciation(data),
    translations: createTranslations(data),
    probes: {
      codex: () => codexUsage(data.home, { timeoutMs: PROBE_TIMEOUT_MS }),
      claudeAuthMethod: () => claudeAuthMethod(),
    },
    preflight: (config) => preflightAgents(data.home, config),
  });
  const listener = getRequestListener(app.fetch);
  if (existsSync(cert) && existsSync(key)) {
    const tls = { cert: readFileSync(cert), key: readFileSync(key) };
    console.log(`doomlearn: Feed at ${hosts.map((host) => `https://${host}:${port}`).join(", ")}`);
    return hosts.map((host) => createHttpsServer(tls, listener).listen(port, host));
  }
  if (remote.length) throw new Error(`No TLS cert for ${remote.join(", ")}. Run: ${mkcert}`);
  console.log(
    `doomlearn: Feed at http://127.0.0.1:${port} (no TLS cert, so this Mac only).\n` +
      `To reach it from the phone, add your ZeroTier IP to server.hosts in ${join(data.home, "config.json")}, ` +
      `then run: ${mkcert} <your ZeroTier IP>`,
  );
  return [createHttpServer(listener).listen(port, "127.0.0.1")];
}
