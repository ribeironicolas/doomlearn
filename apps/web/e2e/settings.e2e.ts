import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { agentCalls, usageSnapshots } from "@doomlearn/core/schema";
import { publishPreflight } from "@doomlearn/core/status";
import { expect, openFeed, test } from "./fixtures.ts";

//
// Settings: the Worker, Usage and Agents tabs behind ⚙️, and the dot on it.
//

/**
 * Opens Settings from ⚙️, over the Feed.
 */
async function openSettings(page: Page) {
  await openFeed(page);
  await page.locator("nav button", { hasText: "⚙️" }).click();
}

/**
 * The data folder's `config.json`, as saved.
 */
const saved = async (server: { data: { home: string } }) =>
  JSON.parse(await readFile(join(server.data.home, "config.json"), "utf8"));

/** A local time as the PWA shows it. */
const hhmm = (at: Date) => at.toTimeString().slice(0, "HH:MM".length);

test("⚙️ opens Settings on its Worker tab; a pause chip saves at once and Resume lifts it", async ({ page, server }) => {
  await openSettings(page);
  await expect(page).toHaveURL(/\/settings\/worker$/);
  for (const tab of ["Worker", "Usage", "Agents"]) await expect(page.getByRole("tab", { name: tab })).toBeVisible();

  const before = Date.now();
  await page.getByRole("button", { name: "1 h" }).click();
  await expect(page.getByText(/^Paused until \d\d:\d\d$/)).toBeVisible();
  const { pausedUntil } = (await saved(server)).worker;
  expect(new Date(pausedUntil).getTime() - before).toBeGreaterThanOrEqual(3_600_000);
  await expect(page.getByText(`Paused until ${hhmm(new Date(pausedUntil))}`)).toBeVisible();
  await expect(page.getByTestId("worker-status")).toContainText(`Worker pause until ${hhmm(new Date(pausedUntil))}`);

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "8 h" })).toBeVisible();
  expect((await saved(server)).worker).toBeUndefined();

  await page.getByRole("button", { name: "until I resume" }).click();
  await expect(page.getByText("Paused until you resume")).toBeVisible();
  expect((await saved(server)).worker).toEqual({ paused: true });
});

test("Worker tab: Run windows use native day and time controls and one Save; host and port apply on restart", async ({
  page,
  server,
}) => {
  await openSettings(page);
  await expect(page.getByText("127.0.0.1 · port 8443 · applies on restart")).toBeVisible();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();

  await page.getByRole("button", { name: "+ Run window" }).click();
  // A pause chip saves at once, which would drop the unsaved Run window.
  await expect(page.getByRole("button", { name: "1 h" })).toBeDisabled();
  const window = page.getByTestId("run-window");
  await window.getByLabel("Start").fill("22:00");
  await window.getByLabel("End").fill("07:00");
  for (const day of ["Sat", "Sun"]) await window.getByLabel(day).uncheck();
  await save.click();

  await expect(save).toBeDisabled();
  await expect(page.getByRole("button", { name: "1 h" })).toBeEnabled();
  expect((await saved(server)).worker).toEqual({
    schedule: { windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "22:00", end: "07:00" }] },
  });
  await expect(window.getByLabel("Start")).toHaveValue("22:00");
  await expect(window.getByLabel("Sun")).not.toBeChecked();

  await window.getByRole("button", { name: "Remove" }).click();
  await save.click();
  await expect(page.getByText("No Run windows: the worker may run any time.")).toBeVisible();
  expect((await saved(server)).worker).toBeUndefined();
});

test("Worker tab: the Clips kept ready and the daily cap save with Save; a default is not written", async ({
  page,
  server,
}) => {
  await openSettings(page);
  const save = page.getByRole("button", { name: "Save" });
  await expect(page.getByLabel("Clips kept ready")).toHaveValue("10");
  await page.getByLabel("Clips kept ready").fill("4");
  await page.getByLabel("New Clips per day").fill("15");
  await save.click();

  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toEqual({ bufferTarget: 4 });
  await expect(page.getByLabel("Clips kept ready")).toHaveValue("4");

  await page.getByLabel("New Clips per day").fill("20");
  await save.click();
  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toEqual({ bufferTarget: 4, dailyClipCap: 20 });
});

test("Worker tab: the Language of new Clips defaults to pt-BR, offers pt-BR, English and Spanish, and saves with Save", async ({
  page,
  server,
}) => {
  await openSettings(page);
  const select = page.getByLabel("Language of new Clips");
  const save = page.getByRole("button", { name: "Save" });
  await expect(select).toHaveValue("pt-BR");
  await expect(select.locator("option")).toHaveText(["Portuguese (pt-BR)", "English (en)", "Spanish (es)"]);
  await expect(save).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("settings-language.png") });

  await select.selectOption("en");
  await save.click();
  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toEqual({ language: "en" });
  await expect(page.getByLabel("Language of new Clips")).toHaveValue("en");

  // Another Save keeps it; back to pt-BR, the default, the key is left out again.
  await page.getByLabel("Clips kept ready").fill("4");
  await save.click();
  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toEqual({ bufferTarget: 4, language: "en" });
  await page.getByLabel("Language of new Clips").selectOption("pt-BR");
  await save.click();
  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toEqual({ bufferTarget: 4 });
});

test("Usage tab: the usage threshold is set with Save, and cleared back to off", async ({ page, server }) => {
  await openSettings(page);
  await page.getByRole("tab", { name: "Usage" }).click();
  const save = page.getByRole("button", { name: "Save" });
  await expect(page.getByLabel("5-hour %")).toHaveValue("");
  await page.getByLabel("5-hour %").fill("80");
  await save.click();

  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toEqual({ stopAtUsagePercent: { fiveHour: 80 } });

  await page.getByLabel("5-hour %").fill("");
  await save.click();
  await expect(save).toBeDisabled();
  expect((await saved(server)).worker).toBeUndefined();
});

test("Agents tab: a stage moves to Codex with one Save; the unknown-model warning shows inline and does not block", async ({
  page,
  server,
}) => {
  await openSettings(page);
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
  const scene = page.getByTestId("stage-scene");
  await expect(scene.getByLabel("Model")).toHaveValue("opus");
  const save = page.getByRole("button", { name: "Save" });

  await scene.getByLabel("Provider").selectOption("codex");
  // Switching Provider means picking the model and Effort again.
  await expect(scene.getByLabel("Model")).toHaveValue("");
  await expect(save).toBeDisabled();
  expect(
    await page.locator(`datalist#${await scene.getByLabel("Model").getAttribute("list")} option`).count(),
  ).toBeGreaterThan(0);
  await scene.getByLabel("Model").fill("gpt-retired");
  await scene.getByLabel("Effort").selectOption("ultra");
  await save.click();

  await expect(page.getByText('codex model "gpt-retired" (scene) is not in codex\'s model list')).toBeVisible();
  expect((await saved(server)).agents).toEqual({
    stages: { scene: { provider: "codex", model: "gpt-retired", effort: "ultra" } },
  });

  await page.getByLabel("Agent timeout (min)").fill("20");
  await save.click();
  await expect(save).toBeDisabled();
  expect((await saved(server)).agents.timeoutMinutes).toBe(20);
});

test("Usage tab: opening it probes; each Usage window shows its age and reset time, why it is unavailable or that it reset, and own spend by group", async ({
  page,
  server,
}) => {
  const { db, home } = server.data;
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ agents: { stages: { scene: { provider: "codex", model: "gpt-6-sol", effort: "low" } } } }),
  );
  const now = Date.now();
  const call = { durationMs: 1000, isError: false, at: new Date(now - 7_200_000) };
  const [claude] = db
    .insert(agentCalls)
    .values([
      { ...call, stage: "script", provider: "claude", model: "opus", costUsd: 0.12, tokensIn: 900, tokensOut: 100 },
      { ...call, stage: "scene", provider: "codex", model: "gpt-6-sol", costUsd: null, tokensIn: 50, tokensOut: 5 },
      {
        ...call,
        stage: "scene",
        provider: "codex",
        model: "gpt-6-sol",
        isError: true,
        retryAt: new Date(now - 6_300_000),
      },
    ])
    .returning()
    .all();
  const capturedAt = new Date(now - 600_000);
  db.insert(usageSnapshots)
    .values(
      [
        { provider: "claude" as const, window: "five_hour", utilization: 0.09, resetsAt: new Date(now + 3_600_000) },
        { provider: "claude" as const, window: "seven_day", utilization: 0.5, resetsAt: new Date(now - 60_000) },
      ].map((reading) => ({
        ...reading,
        status: "allowed",
        source: "unified" as const,
        callId: claude.id,
        capturedAt,
      })),
    )
    .run();

  await openSettings(page);
  const probed = page.waitForResponse((res) => res.url().endsWith("/api/usage?by=provider"));
  await page.getByRole("tab", { name: "Usage" }).click();
  await probed;

  await expect(page.getByText("unavailable: codex probe failed")).toBeVisible();
  const fiveHour = page.getByTestId("window-claude-five_hour");
  await expect(fiveHour).toContainText(`9% · as of ${hhmm(capturedAt)}`);
  // An hour from now names its day only when that is tomorrow.
  await expect(fiveHour).toContainText(new RegExp(`resets (\\w+ )?${hhmm(new Date(now + 3_600_000))}`));
  expect(await fiveHour.locator("[data-testid=bar]").evaluate((bar) => bar.style.width)).toBe("9%");
  await expect(page.getByTestId("window-claude-seven_day")).toContainText(
    `reset since ${hhmm(new Date(now - 60_000))}`,
  );
  await expect(page.getByRole("columnheader", { name: "API-equivalent $" })).toBeVisible();
  await expect(page.getByRole("row", { name: /^claude 1 900 \/ 100 \$0\.12$/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^codex 2 50 \/ 5 —$/ })).toBeVisible();
  await expect(page.getByTestId("pause")).toContainText(
    `${hhmm(call.at)} · codex · scene · until ${hhmm(new Date(now - 6_300_000))} (estimated) · 15 min`,
  );

  await page.getByRole("button", { name: "stage" }).click();
  await expect(page.getByRole("row", { name: /^script 1 / })).toBeVisible();
  await expect(page.getByRole("row", { name: /^scene 2 / })).toBeVisible();
});

test.describe("a save the Mac refuses", () => {
  // The browser logs the 409 the refusal comes with.
  test.use({ expectedErrors: /Failed to load resource.*409/ });

  test('a save over a newer edit on the Mac says "config changed on the Mac" and reloads the form', async ({
    page,
    server,
  }) => {
    await openSettings(page);
    await page.getByRole("tab", { name: "Agents" }).click();
    await page.getByTestId("stage-script").getByLabel("Model").fill("sonnet");
    // The hand edit lands a moment later, so its mtime is a new version.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      join(server.data.home, "config.json"),
      JSON.stringify({ agents: { stages: { script: { provider: "claude", model: "haiku", effort: "high" } } } }),
    );
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("config changed on the Mac")).toBeVisible();
    await expect(page.getByTestId("stage-script").getByLabel("Model")).toHaveValue("haiku");
    await expect(page.getByTestId("stage-script").getByLabel("Effort")).toHaveValue("high");
    expect((await saved(server)).agents.stages.script.model).toBe("haiku");
  });
});

test.describe("a value the Mac refuses", () => {
  // The browser logs the 400 the refusal comes with.
  test.use({ expectedErrors: /Failed to load resource.*400/ });

  test("shows the Mac's reason and saves nothing", async ({ page, server }) => {
    await openSettings(page);
    const before = await readFile(join(server.data.home, "config.json"), "utf8");
    await page.getByLabel("New Clips per day").fill("-1");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Too small: expected number to be >=0")).toBeVisible();
    expect(await readFile(join(server.data.home, "config.json"), "utf8")).toBe(before);
  });
});

test("the ⚙️ dot shows for a Needs-you Blocker, fetched at startup and when a screen closes, and not for a Worker pause", async ({
  page,
  server,
}) => {
  const dot = page.getByTestId("needs-you");
  /**
   * The next Worker status the page fetches.
   */
  const status = () => page.waitForResponse((res) => res.url().endsWith("/api/status"));
  await writeFile(join(server.data.home, "config.json"), JSON.stringify({ worker: { paused: true } }));
  let fetched = status();
  await openFeed(page);
  expect((await (await fetched).json()).blockers).toEqual([
    { kind: "worker_pause", reason: "Worker pause until resumed", until: null },
  ]);
  await expect(dot).toHaveCount(0);

  publishPreflight(server.data, ["codex not logged in: run `codex login`"]);
  await page.locator("nav button", { hasText: "🔍" }).click();
  await expect(page.getByPlaceholder("Search the captions")).toBeVisible();
  await page.goBack();
  await expect(dot).toBeVisible();

  // Nothing polls: a Blocker gone shows at the next fetch. In 3.5 s a poll at Sources' 3 s interval would
  // have fired.
  publishPreflight(server.data, []);
  await page.waitForTimeout(3500);
  await expect(dot).toBeVisible();
  fetched = status();
  await page.reload();
  await fetched;
  await expect(dot).toHaveCount(0);
});

test.describe("with the Mac unreachable", () => {
  test.use({ expectedErrors: /Failed to load resource|ERR_CONNECTION_REFUSED/ });

  test('Settings says "Mac unreachable" and shows no form on any tab', async ({ page, server }) => {
    await openFeed(page);
    await server.stop();
    const unreachable = page.getByText("Mac unreachable. Try again once it’s back.");
    await page.locator("nav button", { hasText: "⚙️" }).click();
    await expect(unreachable).toBeVisible();
    await expect(page.getByRole("button", { name: "1 h" })).toHaveCount(0);
    for (const tab of ["Usage", "Agents"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(unreachable).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    }
  });
});
