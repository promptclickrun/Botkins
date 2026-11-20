// Smoke for the chat header's context details popup and the bot avatar beside its name on each reply.
// Seeds a chat with context and usage data. Set CONTEXT_SHOTS to a folder to save screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-context-"));
const shots = process.env.CONTEXT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });

let app = await launch();
await (await skipWelcome(await app.firstWindow())).getByRole("heading", { name: "Home", exact: true }).waitFor();
await app.close();
const file = join(dir, "data", "workspace.json");
const ws = JSON.parse(readFileSync(file, "utf8"));
ws.settings.onboarded = true;
const bot = ws.bots[0];
const chatId = randomUUID(), r1 = randomUUID(), r2 = randomUUID(), now = Date.now();
ws.chats.unshift({
  id: chatId, botId: bot.id, title: "Context check", time: now, established: false,
  context: { current: 48200, limit: 128000, system: 9100, tools: 21400, conversation: 16800, messages: 6, updatedAt: now },
  messages: [
    { role: "user", text: "First question", runId: r1 },
    { role: "assistant", text: "First answer", runId: r1 },
    { role: "user", text: "Second question", runId: r2 },
    { role: "assistant", text: "Second answer", runId: r2 },
  ],
});
ws.runs.unshift(
  { id: r2, chatId, title: "Second question", time: now, status: "Completed", detail: "", usage: { input: 30000, output: 400, cacheRead: 22000, cost: 1, model: "gpt-test" } },
  { id: r1, chatId, title: "First question", time: now - 60000, status: "Completed", detail: "", usage: { input: 20000, output: 300, cacheRead: 0, cost: 1, model: "gpt-test" } },
);
writeFileSync(file, JSON.stringify(ws));

app = await launch();
try {
  const page = await skipWelcome(await app.firstWindow());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  // Each reply shows the bot's avatar beside its name.
  const replies = page.locator("article.assistant");
  await expect(replies).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(replies.nth(i).locator("b.speaker .bot-avatar").first()).toBeVisible();
    await expect(replies.nth(i).locator("b.speaker")).toContainText(bot.name);
  }
  // The meter opens the details popup with the window's makeup and token use.
  await page.getByRole("button", { name: /Context window: 38% used/ }).click();
  const popup = page.getByRole("dialog", { name: "Context window details" });
  await popup.waitFor();
  await expect(popup).toContainText("48,200 of 128,000 tokens");
  for (const text of ["Instructions and system", "9,100", "Tool definitions", "21,400", "Conversation", "16,800", "Free", "79,800", "Latest reply · GPT Test", "This chat · 2 replies", "50,000", "Premium requests"])
    await expect(popup).toContainText(text);
  if (shots)
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), theme);
      await page.locator(`html[data-mode="${theme}"]`).waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, `context-${theme}.png`) });
    }
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("Reply avatars and the context details popup passed.");
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
