// Selecting a bot, and leaving a new chat nobody wrote in, in an isolated data folder. No turns.
// Settings › Chat › "When you select a bot" is kept on this device: "Open the latest chat" (the
// usual) or "Start a new chat". A new chat with no message is archived when the person leaves it;
// one with typed text is kept. Set BOTKINS_SELECT_SHOTS to a folder for a screenshot of the setting.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-select-"));
const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "app"), COMMANDER_DATA_DIR: join(dir, "app") };
delete env.ELECTRON_RUN_AS_NODE;
seedApp(join(dir, "app"));
// A conversation that already happened, so "the latest chat" is something.
{
  const file = join(dir, "app", "data", "workspace.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const time = Date.now() - 3_600_000;
  data.chats.push({ id: "earlier-talk", botId: "pip", title: "Earlier talk", time, established: false, messages: [
    { role: "user", text: "What should I plant in March?", time },
    { role: "assistant", text: "Peas and broad beans.", time, botId: "pip" },
  ] });
  writeFileSync(file, JSON.stringify(data));
}
const shots = process.env.BOTKINS_SELECT_SHOTS;
let app;
try {
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  const page = await skipWelcome(await app.firstWindow());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const snap = () => page.evaluate(() => window.botkins.snapshot());
  const chats = async (botId) => (await snap()).chats.filter((c) => c.botId === botId);
  const select = (name) => page.locator("aside .botnav-item", { hasText: name }).getByRole("button").first().click();
  const place = (name) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name, exact: true }).click();
  const title = page.locator(".chathead h2");
  const entry = page.getByRole("combobox", { name: "Message", exact: true });
  const choose = async (value) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Chat", exact: true }).click();
    const picker = settings.getByLabel("When you select a bot", { exact: true });
    await expect(picker.getByRole("option")).toHaveText(["Open the latest chat", "Start a new chat"]);
    await picker.selectOption(value);
    await expect(picker).toHaveValue(value);
    if (shots && value === "new") {
      mkdirSync(shots, { recursive: true });
      await settings.locator(".set-group").filter({ has: page.getByRole("heading", { name: "Chat", exact: true }) }).screenshot({ path: join(shots, "when-you-select-a-bot.png") });
    }
    await settings.getByRole("button", { name: "Close dialog" }).click();
    await expect(settings).toBeHidden();
  };

  // The usual: selecting a bot opens its latest chat.
  await select("Pip");
  await expect(title).toHaveText("Pip");
  await expect(page.locator("article.assistant")).toContainText("Peas and broad beans.");
  assert.equal((await chats("pip")).length, 1, "no chat is made");
  console.log("Selecting a bot opens its latest chat.");

  // "Start a new chat": a new chat each time, but never a second one beside a new chat nobody wrote in.
  await choose("new");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("botkins.chatDisplay")).botTap), "new", "kept on this device");
  assert.equal("botTap" in (await page.evaluate(() => window.botkins.snapshot())).settings, false, "and not in the workspace");
  await select("Pip");
  await expect(page.locator("article")).toHaveCount(0);
  await expect.poll(async () => (await chats("pip")).length).toBe(2);
  const blank = (await chats("pip")).find((c) => c.id !== "earlier-talk");
  assert.deepEqual([blank.messages.length, !!blank.archived], [0, false]);
  await select("Pip");
  await page.waitForTimeout(600);
  assert.equal((await chats("pip")).length, 2, "selecting the bot again stays in its new chat");
  console.log("With Start a new chat, selecting a bot starts one, once.");

  // Leaving that chat without a message archives it.
  await select("Scout");
  await expect(title).toHaveText("Scout");
  await expect.poll(async () => (await chats("pip")).find((c) => c.id === blank.id).archived).toBe(true);
  assert.equal((await chats("pip")).find((c) => c.id === "earlier-talk").archived, undefined, "a chat with messages is left alone");
  const scout = (await chats("scout"))[0];
  // Typed text is not thrown away: this one is kept.
  await entry.fill("Half a thought");
  await place("Home");
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.waitForTimeout(800);
  assert.equal(!!(await chats("scout")).find((c) => c.id === scout.id).archived, false, "a chat with typed text is kept");
  // Back in it, with the text taken out, leaving archives it.
  await place("Chats");
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), scout.id);
  await expect(title).toHaveText("Scout");
  await expect(entry).toHaveValue("Half a thought");
  await entry.fill("");
  await place("Home");
  await expect.poll(async () => (await chats("scout")).find((c) => c.id === scout.id).archived).toBe(true);
  console.log("A new chat nobody wrote in is archived when it is left; one with typed text is kept until the text is gone.");

  // Back to the usual: the latest chat, not an archived one.
  await choose("latest");
  await select("Pip");
  await expect(page.locator("article.assistant")).toContainText("Peas and broad beans.");
  assert.equal((await chats("pip")).length, 2);
  assert.deepEqual(errors, []);
  console.log("Bot select smoke passed. No renderer exceptions.");
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
}
