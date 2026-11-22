// Smoke for the Tasks board: add a task in the UI, move it between lanes, and (with BOTKINS_LIVE=1)
// let the dispatcher run it with a real bot until it waits for review, then approve it.
// Set TASKS_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-tasks-"));
const shots = process.env.TASKS_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
try {
  const page = await home(app);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  const snapshot = () => page.evaluate(() => window.botkins.snapshot());
  const task = async (title) => (await snapshot()).tasks.find((t) => t.title === title);
  const lane = (name) => page.getByRole("region", { name, exact: true });
  async function shoot(name) {
    if (!shots) return;
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), theme);
      await page.locator(`html[data-mode="${theme}"]`).waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
    }
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
  }
  await page.getByRole("navigation").getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute("aria-selected", "true");

  // Add a task to Later through the lane's Add button; it waits there.
  await lane("Later").getByRole("button", { name: "Add" }).click();
  const dialog = page.locator("dialog.task-dialog");
  await dialog.getByLabel("Title").fill("Write a haiku about lists");
  await dialog.getByLabel("Details").fill("Three lines. Reply with only the haiku.");
  await dialog.getByLabel("Priority").selectOption("high");
  await dialog.getByRole("button", { name: "Add task" }).click();
  await lane("Later").getByRole("button", { name: /Write a haiku about lists/ }).waitFor();
  const made = await task("Write a haiku about lists");
  assert.deepEqual([made.status, made.priority, made.botId], ["later", "high", (await snapshot()).bots[0].id]);
  await shoot("tasks-board");

  // Edit it, then move it to Done and back to Later.
  await lane("Later").getByRole("button", { name: /Write a haiku about lists/ }).click();
  await dialog.getByLabel("Title").fill("Write a haiku about task lists");
  await shoot("tasks-dialog");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => !!(await task("Write a haiku about task lists"))).toBe(true);
  const id = (await task("Write a haiku about task lists")).id;
  await page.evaluate((id) => window.botkins.moveTask(id, "done"), id);
  await lane("Done").getByRole("button", { name: /Write a haiku about task lists/ }).waitFor();
  await page.evaluate((id) => window.botkins.moveTask(id, "later"), id);
  await assert.rejects(page.evaluate((id) => window.botkins.moveTask(id, "working"), id), /start working on their own/);

  if (process.env.BOTKINS_LIVE === "1") {
    // Ready with a bot: the dispatcher starts it, and the result waits for review.
    await page.evaluate((id) => window.botkins.moveTask(id, "ready"), id);
    await expect.poll(async () => (await task("Write a haiku about task lists")).status, { timeout: 20000 }).not.toBe("ready");
    await expect
      .poll(async () => (await task("Write a haiku about task lists")).status, { timeout: 240000, intervals: [1000, 2000] })
      .toMatch(/review|blocked/);
    const ran = await task("Write a haiku about task lists");
    assert.equal(ran.status, "review", ran.problem);
    assert.ok(ran.result.trim().length > 10, "the bot's reply is kept as the result");
    await lane("Needs you").getByRole("button", { name: /Write a haiku about task lists/ }).click();
    await dialog.getByText("Result").waitFor();
    await shoot("tasks-review");
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await task("Write a haiku about task lists")).status).toBe("done");
    console.log("Live: the dispatcher ran the task, it waited for review, and Approve finished it.");
  }
  assert.deepEqual(errors, []);
  console.log("Tasks board: add, edit, move between lanes and the Working rule passed.");
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
