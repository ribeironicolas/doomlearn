import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { ConfigSchema, insideRunWindow, saveConfig } from "./config.ts";
import { openData } from "./data.ts";
import { editConfig } from "./test/fakes.ts";

/**
 * An empty temp DOOMLEARN_HOME, optionally with a `config.json` holding `config`.
 */
async function home(config?: unknown) {
  const dir = join(await mkdtemp(join(tmpdir(), "doomlearn-")), "home");
  if (config !== undefined) {
    await mkdir(dir);
    await writeFile(join(dir, "config.json"), JSON.stringify(config));
  }
  return dir;
}

test("first run writes only the $schema key, and the config reads back the defaults", async () => {
  const dir = await home();
  const data = openData(dir);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")), {
    $schema: "./config.schema.json",
  });
  const config = data.config();
  assert.deepEqual(config.agents, {
    stages: {
      extract: { provider: "claude", model: "opus", effort: "medium" },
      script: { provider: "claude", model: "opus", effort: "low" },
      verify: { provider: "claude", model: "opus", effort: "low" },
      split: { provider: "claude", model: "opus", effort: "low" },
      scene: { provider: "claude", model: "opus", effort: "low" },
    },
    timeoutMinutes: 10,
  });
  assert.deepEqual(config.worker, {
    bufferTarget: 10,
    dailyClipCap: 15,
    language: "pt-BR",
    paused: false,
    pausedUntil: null,
    schedule: { windows: [] },
    stopAtUsagePercent: null,
  });
  assert.deepEqual(config.server, { hosts: ["127.0.0.1"], port: 8443 });
});

test("a typo like dailyClipcap stops startup with the prettified error", async () => {
  const dir = await home({ worker: { dailyClipcap: 3 } });
  assert.throws(() => openData(dir), {
    message: /config\.json is invalid:\n✖ Unrecognized key: "dailyClipcap"\n {2}→ at worker/,
  });
});

test("at runtime an invalid edit is logged and the last good config is kept", async () => {
  const dir = await home({ worker: { bufferTarget: 4 } });
  const data = openData(dir);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await editConfig(dir, { worker: { dailyClipcap: 3 } });

  assert.equal(data.config().worker.bufferTarget, 4);
  assert.equal(data.config().worker.dailyClipCap, 15);
  // Logged once per bad edit, not on every read.
  assert.equal(logged.mock.calls.length, 1);
  assert.match(String(logged.mock.calls[0][0]), /Unrecognized key: "dailyClipcap"/);
  logged.mockRestore();
});

test("a valid hand edit applies at the next read, without reopening", async () => {
  const dir = await home();
  const data = openData(dir);
  assert.equal(data.config().worker.paused, false);
  await editConfig(dir, { worker: { paused: true } });
  assert.equal(data.config().worker.paused, true);
});

test("the owner's v1 file is backed up and rewritten to server.hosts", async () => {
  const v1 = { zerotierIp: "10.147.17.5" };
  const dir = await home(v1);
  const data = openData(dir);

  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.v1.json.bak"), "utf8")), v1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")), {
    $schema: "./config.schema.json",
    server: { hosts: ["127.0.0.1", "10.147.17.5"] },
  });
  assert.deepEqual(data.config().server.hosts, ["127.0.0.1", "10.147.17.5"]);
});

test("a full v1 file maps every key, and keeps only what differs from the defaults", async () => {
  const dir = await home({
    bufferTarget: 10,
    dailyClipCap: 20,
    port: 9443,
    zerotierIp: "10.0.0.2",
    claude: {
      extract: { model: "opus", effort: "medium" },
      script: { model: "sonnet", effort: "low" },
      verify: { model: "opus", effort: "low" },
      split: { model: "opus", effort: "low" },
      scene: { model: "opus", effort: "high" },
    },
  });
  openData(dir);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")), {
    $schema: "./config.schema.json",
    agents: {
      stages: {
        script: { provider: "claude", model: "sonnet", effort: "low" },
        scene: { provider: "claude", model: "opus", effort: "high" },
      },
    },
    worker: { dailyClipCap: 20 },
    server: { hosts: ["127.0.0.1", "10.0.0.2"], port: 9443 },
  });
});

test("a v1 file with an unknown key is backed up, left as it is, and refused", async () => {
  const v1 = { zerotierIp: "10.0.0.2", bufferTarget: 3, typo: 1 };
  const dir = await home(v1);
  assert.throws(() => openData(dir), /Unrecognized key: "typo"/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.v1.json.bak"), "utf8")), v1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")), v1);
});

test("a save writes only changed keys, a changed stage as a whole", async () => {
  const dir = await home();
  openData(dir);
  const config = ConfigSchema.parse({});
  config.agents.stages.verify = { ...config.agents.stages.verify, effort: "high" };
  config.worker.schedule.windows = [{ days: ["mon"], start: "22:00", end: "06:00" }];
  saveConfig(dir, config);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")), {
    $schema: "./config.schema.json",
    agents: { stages: { verify: { provider: "claude", model: "opus", effort: "high" } } },
    worker: { schedule: { windows: [{ days: ["mon"], start: "22:00", end: "06:00" }] } },
  });
});

test("a Run window without days is saved without days, its default of every day", async () => {
  const dir = await home();
  openData(dir);
  saveConfig(dir, ConfigSchema.parse({ worker: { schedule: { windows: [{ start: "22:00", end: "06:00" }] } } }));
  assert.deepEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")), {
    $schema: "./config.schema.json",
    worker: { schedule: { windows: [{ start: "22:00", end: "06:00" }] } },
  });
});

test("the JSON Schema is copied next to config.json, so $schema resolves offline", async () => {
  const dir = await home();
  openData(dir);
  const schema = JSON.parse(await readFile(join(dir, "config.schema.json"), "utf8"));
  assert.ok(schema.properties.worker.properties.schedule);
});

test("a config.json that is not JSON stops startup with a readable error", async () => {
  const dir = await home({});
  await writeFile(join(dir, "config.json"), '{ "worker": ');
  assert.throws(() => openData(dir), /config\.json is not valid JSON/);
});

/**
 * The worker settings with `worker` over the defaults.
 */
function worker(settings: object) {
  return ConfigSchema.parse({ worker: settings }).worker;
}

/**
 * A local time on Monday 2026-10-12 (`day` 0) or the days after it.
 */
function at(time: string, day = 0) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(2026, 9, 12 + day, hours, minutes);
}

test("no Run windows means the worker may always run", () => {
  assert.equal(insideRunWindow(worker({}).schedule, at("03:00")), true);
});

test("a Run window includes its start and excludes its end", () => {
  const evenings = worker({ schedule: { windows: [{ start: "18:00", end: "23:00" }] } });
  assert.equal(insideRunWindow(evenings.schedule, at("17:59")), false);
  assert.equal(insideRunWindow(evenings.schedule, at("18:00")), true);
  assert.equal(insideRunWindow(evenings.schedule, at("22:59")), true);
  assert.equal(insideRunWindow(evenings.schedule, at("23:00")), false);
});

test("a Run window whose end is before its start crosses midnight into the next day", () => {
  // Friday night: Friday 22:00 to Saturday 06:00 (day 4 is Friday 2026-10-16).
  const nights = worker({ schedule: { windows: [{ days: ["fri"], start: "22:00", end: "06:00" }] } });
  assert.equal(insideRunWindow(nights.schedule, at("21:59", 4)), false);
  assert.equal(insideRunWindow(nights.schedule, at("22:00", 4)), true);
  assert.equal(insideRunWindow(nights.schedule, at("05:59", 5)), true);
  assert.equal(insideRunWindow(nights.schedule, at("06:00", 5)), false);
  // The morning of the listed day belongs to the night before, which isn't listed.
  assert.equal(insideRunWindow(nights.schedule, at("05:00", 4)), false);
});

test("a Run window whose start equals its end is the whole day, on its days only", () => {
  const mondays = worker({ schedule: { windows: [{ days: ["mon"], start: "00:00", end: "00:00" }] } });
  assert.equal(insideRunWindow(mondays.schedule, at("00:00")), true);
  assert.equal(insideRunWindow(mondays.schedule, at("23:59")), true);
  assert.equal(insideRunWindow(mondays.schedule, at("00:00", 1)), false);
});

test("a config.json deleted at runtime is logged once, and the last good config is kept", async () => {
  const dir = await home({ worker: { bufferTarget: 4 } });
  const data = openData(dir);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await rm(join(dir, "config.json"));
  assert.equal(data.config().worker.bufferTarget, 4);
  assert.equal(data.config().worker.bufferTarget, 4);
  assert.equal(logged.mock.calls.length, 1);
  assert.match(String(logged.mock.calls[0][0]), /config\.json is missing\nKeeping the last good config\./);
  logged.mockRestore();
});
