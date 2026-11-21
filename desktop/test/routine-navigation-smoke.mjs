// A real routine delivery between desktop launches must not change the selected bot chat.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron, expect } from "@playwright/test";
import { Workspace } from "./starter.mjs";
import { skipWelcome } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-last-chat-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
const workspace = () => new Workspace(join(dir, "data"), async () => { throw Error("The fixture uses no provider"); }, () => {}, () => ({ kind: "reject" }));
let app;
async function launch() {
  const executablePath = process.env.BOTKINS_BINARY;
  app = await _electron.launch({ args: executablePath ? [] : ["."], executablePath, env });
  const page = await skipWelcome(await app.firstWindow());
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  return page;
}
try {
  let ws = workspace();
  const working = ws.createChat("pip", "My working chat");
  const inbox = ws.createChat("pip", "Routine inbox");
  ws.chat(working).messages.push({ role: "user", text: "Continue my draft here." });
  ws.chat(inbox).messages.push({ role: "user", text: "Send future reports here.", runId: "earlier-request" });
  ws.state.runs.unshift({ id: "earlier-request", chatId: inbox, title: "Report destination", time: Date.now(), status: "Completed", detail: "" });
  const routine = ws.panels.routines.create({ botId: "pip", name: "Daily status", prompt: "Check status", cadence: { kind: "daily", time: "09:00" }, deliver: { to: "chat", chatId: inbox } });
  ws.panels.routines.setEnabled(routine, null, false);
  ws.save();
  let page = await launch();
  await page.locator("aside nav").getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("button", { name: /My working chat/ }).first().click();
  await expect(page.getByText("Continue my draft here.", { exact: true }).first()).toBeVisible();
  await app.close();
  ws = workspace();
  const chat = ws.chat(routine);
  const run = { id: "fixture-run", chatId: routine, scheduleId: chat.schedules[0].id, trigger: "scheduled", time: Date.now(), title: "Daily status", status: "Completed", detail: "" };
  ws.state.runs.unshift(run);
  chat.messages.push({ role: "assistant", text: "Latest routine result.", runId: run.id });
  chat.time = run.time;
  ws.panels.routines.deliver(chat, run);
  assert.equal(ws.chat(inbox).messages.at(-1).text, "Latest routine result.");
  page = await launch();
  const pip = () => page.locator("aside").getByRole("button", { name: "Pip", exact: true });
  await pip().click();
  await expect(page.locator("#message-" + working + "-0")).toBeVisible({ timeout: 4000 });
  // Explicitly opening the inbox changes the choice. The user can always navigate to a result.
  await page.locator("aside nav").getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("button", { name: /Routine inbox/ }).first().click();
  // The person sees the inbox open before they go on, and so does the test.
  await expect(page.locator("#message-" + inbox + "-0")).toBeVisible();
  await page.locator("aside nav").getByRole("button", { name: "Home", exact: true }).click();
  await pip().click();
  await expect(page.locator("#message-" + inbox + "-0")).toBeVisible();
  await page.evaluate((id) => window.botkins.setChatFlags(id, { archived: true }), inbox);
  // The call above answers before the window has heard that the chat is archived (the app tells
  // the window a moment later). A click in that moment still opens the inbox, so the click is made
  // again until the window knows; a person could not click that soon.
  await expect(async () => {
    await pip().click();
    await expect(page.locator("#message-" + working + "-0")).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20000 });
  await page.locator("aside nav").getByRole("button", { name: "Work", exact: true }).click();
  const main = page.locator("main");
  await main.getByRole("tab", { name: "Routines", exact: true }).click();
  await main.getByRole("button", { name: "New routine", exact: true }).click();
  await expect(main.getByRole("radio", { name: "No output" })).toHaveAttribute("aria-checked", "true");
  const notify = main.getByRole("switch", { name: /Notify me/ });
  await expect(notify).toBeDisabled();
  await expect(notify).not.toBeChecked();
  await main.getByLabel("Name", { exact: true }).fill("Quiet background check");
  await main.getByLabel("Instructions", { exact: true }).fill("Check for changes.");
  await main.getByRole("button", { name: "Create routine", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Quiet background check" })).toBeVisible();
  const saved = await page.evaluate(async () => (await window.botkins.snapshot()).chats.flatMap(c => c.schedules ?? []).find(s => s.name === "Quiet background check"));
  assert.deepEqual(saved.deliver, { to: "none" });
  assert.equal(saved.notify, false);
  console.log("Passed: routine delivery preserved the last visited chat across restart, and a routine saved with no output.");
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
