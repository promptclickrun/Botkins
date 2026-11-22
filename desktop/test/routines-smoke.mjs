// Routines, Work, Usage and notification settings through the UI, with isolated app data.
// BOTKINS_LIVE=1 also checks a real routine run and a bot creating a routine with its tool.
// BOTKINS_QA_DIR=<dir> saves light and dark screenshots there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-routines-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
const live = process.env.BOTKINS_LIVE === "1";
const qa = process.env.BOTKINS_QA_DIR;

// Synthetic history so Work counts and Usage have something to show.
const DAY = 86400000,
  now = Date.now();
const bots = [
  ["pip", "Pip", "Everyday helper", "pip"],
  ["scout", "Scout", "Research partner", "sprig"],
  ["patch", "Patch", "Coding companion", "muse"],
].map(([id, name, role, head]) => ({
  id,
  name,
  role,
  instructions: "Help the user.",
  face: "idle",
  sources: [],
  look: { head, palette: "original" },
}));
const chats = [
  { id: "seed-pip", botId: "pip", title: "Weekly plan", time: now - DAY, messages: [], established: false },
  { id: "seed-scout", botId: "scout", title: "Market notes", time: now - 2 * DAY, messages: [], established: false },
  {
    id: "seed-every",
    botId: "patch",
    title: "Build watch",
    time: now - DAY,
    messages: [{ role: "user", text: "Check the build" }],
    established: false,
    lastScheduleId: 1,
    schedules: [{ id: 1, prompt: "Check the nightly build", nextAt: now + 3 * 3600000, intervalMs: 6 * 3600000, recurring: true }],
  },
];
const models = ["gpt-5.4", "claude-sonnet-5", "gpt-5.4-mini"];
const runs = [];
for (let i = 0; i < 40; i++) {
  const chat = chats[i % 2];
  runs.push({
    id: "seed-run-" + i,
    chatId: chat.id,
    title: i % 2 ? "Summarize the market notes" : "Plan the week",
    time: now - Math.floor(i * 0.7) * DAY - (i % 5) * 3600000 - 60000,
    status: "Completed",
    detail: "",
    usage: { input: 3000 + ((i * 7919) % 9000), output: 400 + ((i * 104729) % 1600), model: models[i % 3], cost: i % 4 ? undefined : 0.02 * (i % 7) },
  });
}
runs.push({ id: "seed-failed", chatId: "seed-scout", title: "Scheduled · Morning scan", time: now - 3600000, status: "Interrupted", trigger: "scheduled", scheduleId: 9, detail: "Botkins closed before this reply finished." });
runs.sort((a, b) => b.time - a.time);
mkdirSync(join(dir, "data"), { recursive: true });
const panels = [
  {
    id: "seed-panel",
    key: "reading",
    botId: "pip",
    chatId: "seed-pip",
    title: "Reading list",
    blocks: [{ type: "list", items: ["Designing Data-Intensive Applications"] }],
    hidden: false,
    size: "wide",
    revision: 1,
    updatedAt: now - DAY,
    routine: { cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Refresh the list.", enabled: true, nextAt: now + 5 * 3600000 },
  },
];
writeFileSync(join(dir, "data", "workspace.json"), JSON.stringify({ bots, chats, runs, panels }));

let app, page;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const main = () => page.locator("main");
const snap = () => page.evaluate(() => window.botkins.snapshot());
const routines = async () => (await snap()).chats.flatMap((c) => (c.schedules ?? []).filter((s) => s.routine).map((s) => ({ ...s, chatId: c.id, botId: c.botId })));
const wait = (fn, timeout = 30000) => expect.poll(fn, { timeout, intervals: [100, 250, 500] });
async function shot(name) {
  if (!qa) return;
  mkdirSync(qa, { recursive: true });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), mode);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(qa, name + "-" + mode + ".png") });
  }
  await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "system" } }));
}
const navTo = (name) => page.locator("aside nav").getByRole("button", { name, exact: true }).click();

try {
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  page = await home(app);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();

  // Work opens on its first tab; Activity, at its top, has counts on the chips and the failed scheduled run under Needs you.
  await navTo("Work");
  await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
  await expect(main().getByRole("tablist", { name: "Work" }).getByRole("tab")).toHaveText(["Routines", "Projects", "Tasks"]);
  await main().getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("heading", { name: "Activity", exact: true }).waitFor();
  await expect(main().getByRole("button", { name: /^All\s*41$/ })).toBeVisible();
  await expect(main().getByRole("button", { name: /^Needs you\s*1$/ })).toBeVisible();
  await expect(main().getByRole("button", { name: /^Completed\s*40$/ })).toBeVisible();
  await expect(main().getByRole("region", { name: "Upcoming" }).getByText("Check the nightly build")).toBeVisible();
  await main().getByRole("button", { name: /^Needs you/ }).click();
  await expect(main().getByRole("button", { name: /Scheduled · Morning scan/ })).toBeVisible();
  await main().getByRole("button", { name: /^All/ }).click();

  // Routines: create through the editor. "Work" above Activity leads back to the tab.
  await shot("activity");
  await main().getByRole("button", { name: "Work", exact: true }).click();
  await expect(main().getByRole("tab", { name: "Routines", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(main().getByText("No routines yet")).toBeVisible();
  await expect(main().getByRole("region", { name: "Chat schedules" }).getByText("Check the nightly build")).toBeVisible();
  await main().getByRole("button", { name: "New routine", exact: true }).click();
  await page.getByRole("heading", { name: "New routine" }).waitFor();
  await main().getByRole("combobox", { name: /^Bot/ }).selectOption("scout");
  await main().getByLabel("Name", { exact: true }).fill("Smoke check");
  await main().getByLabel("Instructions", { exact: true }).fill("Reply with the single word ready.");
  await main().getByRole("radio", { name: "Weekly" }).click();
  for (const d of ["Mon", "Wed"]) {
    const day = main().getByRole("button", { name: d, exact: true });
    if ((await day.getAttribute("aria-pressed")) !== "true") await day.click();
  }
  await main().getByLabel("Time", { exact: true }).fill("08:45");
  await expect(main().getByRole("status").filter({ hasText: "Next run" })).toBeVisible();
  // New desktop routines default to no output; choose a goal explicitly for this smoke run.
  await expect(main().getByRole("radio", { name: "No output" })).toHaveAttribute("aria-checked", "true");
  const routineNotify = main().getByRole("switch", { name: "Notify me when a run finishes" });
  await expect(routineNotify).not.toBeChecked();
  await expect(routineNotify).toBeDisabled();
  await shot("routine-editor");
  await button("Create routine").click();
  await page.getByRole("heading", { name: "Smoke check" }).waitFor();
  let [r] = await routines();
  assert.deepEqual(r.deliver, { to: "none" });
  assert.equal(r.notify, false);

  // A saved no-output routine can still be changed to a destination later.
  await button("Edit").click();
  await main().getByRole("radio", { name: "Goals" }).click();
  await main().getByRole("combobox", { name: /^Category/ }).selectOption("health");
  await button("Save routine").click();
  await page.getByRole("heading", { name: "Smoke check" }).waitFor();
  [r] = await routines();
  assert.equal(r.botId, "scout");
  assert.equal(r.cadence.kind, "weekly");
  assert.ok(r.cadence.days.includes(1) && r.cadence.days.includes(3));
  assert.match(r.cron, /^45 8 \* \* /);
  assert.deepEqual(r.deliver, { to: "goal", category: "health" });
  await expect(main().getByText(/Result to Goals/)).toBeVisible();
  const id = r.chatId;

  // Pause and resume from the detail view.
  await button("Pause").click();
  await wait(async () => (await routines())[0].enabled).toBe(false);
  await button("Resume").click();
  await wait(async () => (await routines())[0].enabled).toBe(true);

  // Edit the cadence.
  await button("Edit").click();
  await main().getByRole("radio", { name: "Daily" }).click();
  await main().getByLabel("Time", { exact: true }).fill("07:30");
  // Back to the routine's own chat: nothing is saved for the default.
  await expect(main().getByRole("radio", { name: "Goals" })).toHaveAttribute("aria-checked", "true");
  await main().getByRole("radio", { name: "Routine chat" }).click();
  await button("Save routine").click();
  await page.getByRole("heading", { name: "Smoke check" }).waitFor();
  await wait(async () => (await routines())[0].cron).toBe("30 7 * * *");
  assert.equal("deliver" in (await routines())[0], false);
  await expect(main().getByText(/Daily at 7:30/)).toBeVisible();

  // More routines for the list: a paused one and a one-time one.
  const other = await page.evaluate(() =>
    window.botkins.createRoutine({ botId: "pip", name: "Inbox review", prompt: "Remind me to review my inbox.", cadence: { kind: "weekdays", time: "09:00" } }),
  );
  const d = new Date(Date.now() + 3 * DAY);
  const date = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  await page.evaluate((date) => window.botkins.createRoutine({ botId: "patch", name: "Renew certificate", prompt: "Remind me to renew the TLS certificate.", cadence: { kind: "once", date, time: "16:00" } }), date);
  await page.evaluate((id) => window.botkins.createRoutine({ botId: "scout", name: "Weekly digest", prompt: "Summarize this week's research.", cadence: { kind: "weekly", time: "17:00", days: [5] } }).then((x) => window.botkins.setRoutineEnabled(x, false)), id);

  await button("All routines").click();
  const upNext = main().getByRole("region", { name: "Up next" });
  await expect(upNext.getByText("Smoke check")).toBeVisible();
  await expect(main().getByRole("region", { name: "Paused" }).getByText("Weekly digest")).toBeVisible();
  // The row toggle pauses and resumes.
  await main().getByRole("switch", { name: "Enable Inbox review" }).click();
  await wait(async () => (await routines()).find((x) => x.chatId === other).enabled).toBe(false);
  // The row moves to Paused once the page has the change; click it there, not in its old place.
  await expect(main().getByRole("region", { name: "Paused" }).getByRole("switch", { name: "Enable Inbox review" })).not.toBeChecked();
  await main().getByRole("switch", { name: "Enable Inbox review" }).click();
  await wait(async () => (await routines()).find((x) => x.chatId === other).enabled).toBe(true);
  await expect(main().getByRole("region", { name: "Today panels" }).getByText("Reading list")).toBeVisible();
  await shot("routines-list");
  // The narrowest window Botkins allows.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
  await page.waitForTimeout(300);
  await shot("routines-list-narrow");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 830));

  // Run now: the run lands in the routine chat with its scheduleId.
  await upNext.getByRole("button", { name: /Smoke check/ }).click();
  await button("Run now").click();
  await wait(async () => (await snap()).runs.find((x) => x.chatId === id)?.scheduleId).toBe(1);
  if (live) {
    await wait(async () => (await snap()).runs.find((x) => x.chatId === id).status, 180000).not.toBe("Working");
    const s = await snap();
    const run = s.runs.find((x) => x.chatId === id);
    assert.equal(run.status, "Completed", run.detail);
    assert.ok(s.chats.find((c) => c.id === id).messages.some((m) => m.role === "assistant" && m.runId === run.id));
    assert.equal(s.chats.find((c) => c.id === id).title, "Routine · Smoke check");
  } else {
    await page.evaluate((id) => window.botkins.stop(id), id);
    await wait(async () => (await snap()).runs.find((x) => x.chatId === id).status, 60000).not.toBe("Working");
  }
  await expect(main().getByRole("region", { name: "Runs" }).getByRole("button")).toHaveCount(1);
  await shot("routine-detail");

  // Delete with confirmation.
  await button("Delete…").click();
  await page.getByRole("dialog", { name: "Delete Smoke check?" }).getByRole("button", { name: "Delete routine" }).click();
  await wait(async () => (await routines()).some((x) => x.chatId === id)).toBe(false);
  await expect(main().getByRole("tab", { name: "Routines", exact: true })).toHaveAttribute("aria-selected", "true");

  // The bot page lists the bot's routines and opens one.
  await page.locator("aside .botnav-item", { hasText: "Pip" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bot page" }).click();
  await main().getByRole("heading", { name: "Pip", level: 1 }).waitFor();
  const card = main().locator(".bot-routines");
  await card.getByRole("button", { name: /Inbox review/ }).click();
  await page.getByRole("heading", { name: "Inbox review", level: 1 }).waitFor();
  await expect(main().getByText(/Weekdays at 9:00/)).toBeVisible();

  await navTo("Work");
  await shot("work");
  await main().getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
  await expect(main().getByRole("region", { name: "By model" }).getByText("GPT-5.4", { exact: true })).toBeVisible();
  // A model is shown by a name people read, never by its id.
  await expect(main().getByRole("region", { name: "By model" }).getByText("claude-sonnet-5")).toHaveCount(0);
  await expect(main().getByRole("region", { name: "By model" }).getByText("Claude Sonnet 5", { exact: true })).toBeVisible();
  await main().getByRole("button", { name: "7 days" }).click();
  await expect(main().getByRole("region", { name: "By bot" }).getByText("Pip", { exact: true })).toBeVisible();
  await main().getByRole("button", { name: "30 days" }).click();
  await shot("usage");

  // The panel routine form uses the same cadence picker and still writes cron.
  await navTo("Today");
  await main().getByRole("button", { name: "Manage Reading list" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit routine" }).click();
  await expect(page.getByRole("dialog").getByRole("radio", { name: "Weekdays" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("dialog").getByRole("radio", { name: "Once" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("radio", { name: "Daily" }).click();
  await page.getByRole("dialog").getByLabel("Time", { exact: true }).fill("10:15");
  await shot("panel-routine");
  await page.getByRole("dialog").getByRole("button", { name: "Save routine" }).click();
  await wait(async () => (await snap()).panels[0].routine.cron).toBe("15 10 * * *");
  await expect(page.getByRole("dialog")).toBeHidden();

  // Notifications settings persist and validate.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Notifications", exact: true }).click();
  await dialog.getByLabel(/^Replies/).uncheck();
  await wait(async () => (await snap()).settings.notifications.replies).toBe(false);
  await dialog.getByLabel(/^Silence notifications/).check();
  await dialog.getByLabel("From", { exact: true }).fill("21:30");
  await wait(async () => (await snap()).settings.notifications.quietHours).toEqual({ enabled: true, from: "21:30", to: "07:00" });
  await shot("settings-notifications");
  await dialog.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Tokens by day" })).toBeVisible();
  await shot("settings-usage");
  await page.getByRole("button", { name: "Close dialog" }).click();

  if (live) {
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Pip/ }).click();
    const entry = page.getByRole("combobox", { name: "Message", exact: true });
    await entry.fill("Remind me every weekday at 9 to review my inbox.");
    await button("Send message").click();
    await wait(async () => (await routines()).some((x) => x.botId === "pip" && x.cadence?.kind === "weekdays" && x.cadence.time === "09:00" && x.chatId !== other), 180000).toBe(true);
    const s = await snap();
    const turn = s.runs[0];
    await wait(async () => (await snap()).runs.find((x) => x.id === turn.id).status, 180000).not.toBe("Working");
  }

  assert.deepEqual(errors, []);
  console.log(
    live
      ? "Routines UI, a real routine run and a bot-created routine passed."
      : "Routines create, pause, resume, edit, run now and delete; Work counts and Upcoming; Usage; notification settings passed.",
  );
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
