import { z } from "zod";
import type { Button } from "./feed.ts";
import { LANGUAGE_TAGS } from "./languages.ts";
import { speakable } from "./respelling.ts";

/**
 * What the server's API accepts, shared with the PWA. Bodies keep the v1 shapes, so presses the v1 app queued
 * offline still validate; unknown keys are dropped, not refused.
 */
const id = z.number().int();

export const press = z.object({
  clipId: id,
  button: z.enum(["got_it", "didnt_get", "know", "flag"]) satisfies z.ZodType<Button>,
  clientEventId: z.string(),
  reason: z.string().optional(),
  note: z.string().optional(),
});

export const seen = z.object({ clipId: id, clientEventId: z.string(), completed: z.boolean() });

/**
 * A ⭐: keeps the Clip as a Favorite (`on`) or lets it go.
 */
export const favorite = z.object({ clipId: id, on: z.boolean() });

export const sourceId = z.object({ sourceId: id });

/**
 * A Source, by its id in the path.
 */
export const sourceIdParam = z.object({ id: z.coerce.number().int() });

/**
 * A chapter or Concept, by its id in the path, and what its ⋯ menu does to it.
 */
export const itemAction = z.object({
  id: z.coerce.number().int(),
  action: z.enum(["pause", "resume", "delete", "restore"]),
});

/**
 * What the Learner does to a chapter or a Concept from its ⋯ menu on the Source screen.
 */
export type ItemAction = z.infer<typeof itemAction>["action"];

export const jobId = z.object({ jobId: id });

export const eventId = z.object({ eventId: id });

export const search = z.object({ q: z.string().default("") });

/**
 * An upload's file name, which the Source's title and type come from.
 */
export const upload = z.object({ name: z.string().min(1) });

/**
 * What doomlearn's own agent usage can be grouped by.
 */
export const USAGE_GROUPS = ["provider", "stage", "day", "source", "clip"] as const;

/**
 * The usage screen's grouping, by Provider unless asked, and an optional Provider to show alone.
 */
export const usage = z.object({
  by: z.enum(USAGE_GROUPS).default("provider"),
  provider: z.enum(["claude", "codex"]).optional(),
});

/**
 * A word the Learner fixed: the shown words picked, and a Respelling with a letter or a digit, since narration needs at
 * least one word to time.
 */
const fix = z.object({
  term: z.string().trim().min(1),
  respelling: z.string().trim().refine(speakable, "A Respelling needs a letter or a digit"),
});

/**
 * The fix sheet of a 🚩, by its event id in the query.
 */
export const eventIdQuery = z.object({ eventId: z.coerce.number().int() });

/**
 * Save on the fix sheet: every fix for the 🚩's Clip.
 */
export const fixes = z.object({ eventId: id, fixes: z.array(fix).min(1) });

/**
 * ▶ Preview on a fix row: the sentence of the word it fixes (its beat, and the sentence within the beat) and every
 * unsaved fix on the sheet.
 */
export const preview = z.object({ eventId: id, beat: id, sentence: id, fixes: z.array(fix) });

/**
 * A preview, by its id in the query.
 */
export const previewId = z.object({ id: z.coerce.number().int() });

/**
 * A Clip, by its id in the query.
 */
export const clipIdQuery = z.object({ clipId: z.coerce.number().int() });

/**
 * "Make in <Language>" on a Clip's 🌐 sheet.
 */
export const translate = z.object({ clipId: id, language: z.enum(LANGUAGE_TAGS) });
