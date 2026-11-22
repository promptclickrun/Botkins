import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";
import { home } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-instant-send-"));
seedApp(dir);
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const page = await home(app);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Pip/ }).click();
  const snapshot = await page.evaluate(() => window.botkins.snapshot());
  // Hold the IPC reply and publish host snapshots independently, in either order.
  await app.evaluate(({ ipcMain }, snapshot) => {
    globalThis.fixture = snapshot;
    ipcMain.removeHandler("snapshot");
    ipcMain.handle("snapshot", () => globalThis.fixture);
    ipcMain.removeHandler("send");
    ipcMain.handle("send", (_event, chatId, text, options) => new Promise((resolve, reject) => {
      globalThis.heldSend = { chatId, text, options, resolve, reject };
    }));
  }, snapshot);
  const input = page.getByRole("combobox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const rows = (text) => page.locator("article.user").filter({ hasText: text });
  const echo = () => app.evaluate(({ BrowserWindow }) => {
    const { chatId, text, options } = globalThis.heldSend;
    globalThis.fixture.chats.find(c => c.id === chatId).messages.push({
      role: "user", text, clientMessageId: options.clientMessageId, time: Date.now(),
    });
    BrowserWindow.getAllWindows()[0].webContents.send("changed", globalThis.fixture);
  });
  await input.fill("Same message");
  await send.click();
  await expect(rows("Same message")).toBeVisible({ timeout: 2000 });
  await expect(input).toHaveValue("");
  await input.fill("My next draft");
  await echo();
  await expect(rows("Same message")).toHaveCount(1);
  await app.evaluate(() => globalThis.heldSend.resolve());
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue("My next draft");

  await input.fill("Same message");
  await input.press("Enter");
  await expect(rows("Same message")).toHaveCount(2);
  await app.evaluate(() => globalThis.heldSend.resolve());
  await input.fill("Next");
  await expect(send).toBeEnabled();
  await expect(rows("Same message")).toHaveCount(2);
  await echo();
  await expect(rows("Same message")).toHaveCount(2);

  await send.click();
  await expect(rows("Next")).toBeVisible();
  await app.evaluate(() => globalThis.heldSend.reject(new Error("Offline")));
  await expect(rows("Next")).toHaveCount(0);
  await expect(input).toHaveValue("Next");
  await expect(page.getByRole("alert")).toContainText("Offline");
  assert.equal(await rows("Same message").count(), 2);
  console.log("Send and Enter show the message before acceptance, reconcile each echo once and restore a refused draft.");
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
