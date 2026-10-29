import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readJson, writeJson } from "./json.ts";
import { LANGUAGE_TAGS } from "./languages.ts";

/**
 * Which CLI runs an agent stage, with that CLI's own model and effort words.
 */
const StageAgent = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("claude"),
    model: z.string().meta({ description: "Passed to `claude -p --model`.", examples: ["opus", "sonnet", "haiku"] }),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  }),
  z.strictObject({
    provider: z.literal("codex"),
    model: z.string().meta({ description: "Passed to `codex exec --model`.", examples: ["gpt-6-astra"] }),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  }),
]);

/**
 * A stage on Claude Opus at `effort`, as v1 ran every stage.
 */
const opus = (effort: "low" | "medium") => ({ provider: "claude" as const, model: "opus", effort });

/**
 * 24 h `HH:MM`, 00:00 to 23:59.
 */
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24 h");

/**
 * The days a Run window applies to, in the order `Date.getDay()` numbers them from Sunday.
 */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Defaults the schema fills in. The worker's provisional sizes until the benchmark, the agent call timeout,
 * and the HTTPS port (not 443, which needs root on macOS).
 */
const DEFAULT = { bufferTarget: 10, dailyClipCap: 15, timeoutMinutes: 10, port: 8443 };

/**
 * Bounds the schema enforces: the highest usage percentage, and the ports a non-root process may bind on macOS.
 */
const LIMIT = { maxPercent: 100, minPort: 1024, maxPort: 65535 };

/**
 * A usage threshold, in percent of a Usage window.
 */
const Percent = z.number().min(1).max(LIMIT.maxPercent);

/**
 * The Learner's settings in `config.json`. The only source of truth for its shape and defaults:
 * `pnpm config:schema` turns it into `config.schema.json`. Unknown keys are errors at every level.
 */
export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  agents: z
    .strictObject({
      stages: z
        .strictObject({
          extract: StageAgent.default(opus("medium")),
          script: StageAgent.default(opus("low")),
          verify: StageAgent.default(opus("low")),
          split: StageAgent.default(opus("low")),
          scene: StageAgent.default(opus("low")),
        })
        .prefault({})
        .meta({ description: "The Provider, model and effort each agent stage runs with. Applies to the next stage." }),
      timeoutMinutes: z
        .number()
        .int()
        .min(1)
        .default(DEFAULT.timeoutMinutes)
        .meta({ description: "How long one agent call may run before it is killed and counted as failed." }),
    })
    .prefault({}),
  worker: z
    .strictObject({
      bufferTarget: z
        .number()
        .int()
        .min(0)
        .default(DEFAULT.bufferTarget)
        .meta({ description: "Unseen Clips to keep ready. Provisional until the benchmark." }),
      dailyClipCap: z
        .number()
        .int()
        .min(0)
        .default(DEFAULT.dailyClipCap)
        .meta({ description: "New Clips per day at most. Provisional until the benchmark." }),
      // A default, not optional: a saved config leaves pt-BR out like any default, and the code reads one value.
      language: z
        .enum(LANGUAGE_TAGS)
        .default("pt-BR")
        .meta({ description: "Language new Clips are narrated and captioned in. The UI stays English." }),
      paused: z
        .boolean()
        .default(false)
        .meta({ description: "Worker pause until resumed: the running stage finishes, no new one starts." }),
      pausedUntil: z.iso
        .datetime({ offset: true })
        .nullable()
        .default(null)
        .meta({ description: "Worker pause until this ISO time. A past time is ignored." }),
      schedule: z
        .strictObject({
          windows: z
            .array(
              z.strictObject({
                days: z
                  .array(z.enum(DAYS))
                  .min(1)
                  .default([...DAYS])
                  .meta({
                    description:
                      "Days the window starts on; after midnight, a crossing window still counts as its start day. Defaults to every day.",
                  }),
                start: Time.meta({ description: "Inclusive, Mac local time." }),
                end: Time.meta({
                  description: "Exclusive. Before `start` crosses midnight; equal to `start` means the whole day.",
                }),
              }),
            )
            .default([])
            .meta({ description: "Run windows: the worker starts stages only inside one. Empty means always." }),
        })
        .prefault({}),
      stopAtUsagePercent: z
        .strictObject({ fiveHour: Percent.optional(), sevenDay: Percent.optional() })
        .nullable()
        .default(null)
        .meta({
          description:
            "Start no stage once the latest Claude Usage window is at or above this percentage, until it resets. null is off; unknown or stale usage never stops it.",
        }),
    })
    .prefault({}),
  server: z
    .strictObject({
      hosts: z
        .array(z.string().min(1))
        .min(1)
        .default(["127.0.0.1"])
        .meta({ description: "Addresses to listen on. Add your ZeroTier IP to reach the Feed from the phone." }),
      port: z.number().int().min(LIMIT.minPort).max(LIMIT.maxPort).default(DEFAULT.port),
    })
    .prefault({})
    .meta({ description: "Read when the server starts: a change needs a restart." }),
});

/**
 * The Learner's settings, with every default filled in.
 */
export type Config = z.output<typeof ConfigSchema>;

/**
 * What `$schema` points at; the schema file is copied next to `config.json` so it resolves offline.
 */
const SCHEMA_REF = "./config.schema.json";

/**
 * The generated JSON Schema in the repo, which `pnpm config:schema` writes.
 */
export const SCHEMA_FILE = new URL("../config.schema.json", import.meta.url);

/**
 * A `config.json` that is not JSON or does not match the schema; its message lists the problems.
 */
export class InvalidConfig extends Error {}

/**
 * Checks `config.json`'s parsed value strictly, throwing `InvalidConfig` with the prettified problems.
 */
export function parseConfig(raw: unknown, file = "config.json"): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new InvalidConfig(`${file} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * The parts of `value` that differ from `base`. A stage is kept whole, since a partial one fails the Provider union.
 */
function sparse(value: unknown, base: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && !("provider" in value)) {
    const kept = Object.entries(value).flatMap(([key, child]) => {
      const diff = sparse(child, (base as Record<string, unknown> | null)?.[key]);
      return diff === undefined ? [] : [[key, diff]];
    });
    return kept.length ? Object.fromEntries(kept) : undefined;
  }
  return isDeepStrictEqual(value, base) ? undefined : value;
}

/**
 * Writes `config` to `home`'s `config.json` atomically, with only the keys that differ from the defaults.
 */
export function saveConfig(home: string, config: Config) {
  const { $schema: _, ...values } = config;
  const file = join(home, "config.json");
  // A Run window's `days` is left out when it is every day, its default, since `sparse` compares windows whole.
  const windows = values.worker.schedule.windows.map(({ days, ...window }) =>
    isDeepStrictEqual(days, DAYS) ? window : { days, ...window },
  );
  const changed = (sparse({ ...values, worker: { ...values.worker, schedule: { windows } } }, ConfigSchema.parse({})) ??
    {}) as object;
  writeJson(file, { $schema: SCHEMA_REF, ...changed });
}

/**
 * Reads `home`'s `config.json` at startup, throwing on an invalid one.
 * Writes `{"$schema": …}` on first run, and rewrites a v1 file once to the v2 shape after backing it up.
 */
export function loadConfig(home: string): Config {
  const file = join(home, "config.json");
  copyFileSync(SCHEMA_FILE, join(home, "config.schema.json"));
  if (!existsSync(file)) saveConfig(home, ConfigSchema.parse({}));
  const raw = readJson(file, InvalidConfig);
  if (!(raw && typeof raw === "object" && ("claude" in raw || "zerotierIp" in raw))) return parseConfig(raw, file);

  copyFileSync(file, join(home, "config.v1.json.bak"));
  const { claude, zerotierIp, bufferTarget, dailyClipCap, port, ...rest } = raw as Record<string, unknown>;
  const stages =
    claude &&
    Object.fromEntries(
      Object.entries(claude as object).map(([stage, agent]) => [stage, { provider: "claude", ...(agent as object) }]),
    );
  // Parsed before it is written, so a v1 file with a typo stays as it was and startup refuses.
  const config = parseConfig(
    {
      ...rest,
      agents: { stages },
      worker: { bufferTarget, dailyClipCap },
      server: { hosts: zerotierIp ? ["127.0.0.1", zerotierIp] : undefined, port },
    },
    file,
  );
  saveConfig(home, config);
  return config;
}

/**
 * Minutes since local midnight of an `HH:MM` time or of a `Date`'s local time.
 */
function minutes(time: string | Date) {
  const [hours, mins] = typeof time === "string" ? time.split(":").map(Number) : [time.getHours(), time.getMinutes()];
  return hours * 60 + mins;
}

/**
 * Whether `now` (Mac local time) is inside a Run window, or no Run window is set.
 * A window's start is inclusive and its end exclusive; an end before the start crosses midnight, and the hours after
 * midnight belong to the day the window started on. A start equal to the end is the whole day.
 */
export function insideRunWindow({ windows }: Config["worker"]["schedule"], now: Date) {
  if (!windows.length) return true;
  const today = DAYS[now.getDay()];
  const yesterday = DAYS[(now.getDay() + DAYS.length - 1) % DAYS.length];
  const time = minutes(now);
  return windows.some(({ days, start, end }) => {
    const [from, to] = [minutes(start), minutes(end)];
    if (from === to) return days.includes(today);
    if (from < to) return days.includes(today) && from <= time && time < to;
    return (days.includes(today) && time >= from) || (days.includes(yesterday) && time < to);
  });
}
