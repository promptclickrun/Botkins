// Isolated Electron smoke for Artifacts and verified chat paths. It creates no user-profile data.
import assert from "node:assert/strict";
import { _electron, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDetails } from "../desktop/artifact-files.mjs";
import { seedApp } from "./starter.mjs";
import { skipWelcome } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-artifacts-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
seedApp(dir);
const executablePath = process.env.BOTKINS_BINARY;
const launch = () => _electron.launch({ args: executablePath ? [] : ["."], executablePath, env, timeout: 120000 });
let app;
try {
  app = await launch();
  const first = await skipWelcome(await app.firstWindow());
  await first.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.close();
  const workspacePath = join(dir, "data", "workspace.json");
  const workspace = JSON.parse(readFileSync(workspacePath, "utf8"));
  const bot = workspace.bots[0];
  const chat = { id: "artifact-smoke-chat", botId: bot.id, title: "Artifact smoke", time: Date.now(), established: false, messages: [] };
  workspace.chats.push(chat);
  const fixture = join(dir, "artifact-preview.txt");
  writeFileSync(fixture, "Artifacts preview fixture\n");
  chat.messages.push({ role: "assistant", text: `Saved ${fixture}.`, time: Date.now(), botId: bot.id });
  const unindexed = join(dir, "unindexed-preview.txt");
  writeFileSync(unindexed, "Unindexed local preview fixture\n");
  chat.messages.push({ role: "assistant", text: `Also saved ${unindexed}.`, time: Date.now(), botId: bot.id });
  for (let i = 0; i < 36; i++) chat.messages.push({ role: "user", text: "Field note " + (i + 1) });
  const sentIndex = chat.messages.length;
  chat.messages.push({ role: "assistant", text: "MEDIA:" + fixture, botId: bot.id });
  writeFileSync(workspacePath, JSON.stringify(workspace));
  const info = fileDetails(fixture);
  assert.ok(info);
  const record = { botId: bot.id, chatId: chat.id, path: info.path, identity: info.identity, time: Date.now() };
  writeFileSync(join(dir, "data", "artifacts.json"), JSON.stringify([
    { ...record, id: "smoke-artifact", messageIndex: 0, source: "tool" },
    { ...record, id: "smoke-sent", messageIndex: sentIndex, source: "media" },
  ]));

  app = await launch();
  const page = await skipWelcome(await app.firstWindow());
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chat.id);
  await expect(page.locator("aside.side-pane")).toBeVisible();
  await page.getByRole("tab", { name: /^Artifacts/ }).click();
  await expect(page.locator(".artifact-list")).toContainText("artifact-preview.txt");
  const written = page.getByRole("button", { name: /artifact-preview\.txt.*Written/ });
  const sent = page.getByRole("button", { name: /artifact-preview\.txt.*Sent/ });
  await expect(written).toContainText("Written", { timeout: 3000 });
  await expect(sent).toContainText("Sent");
  await written.click();
  await expect(page.locator(".artifact-text")).toContainText("Artifacts preview fixture");
  if (process.env.BOTKINS_QA_DIR) {
    mkdirSync(process.env.BOTKINS_QA_DIR, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => window.botkins.setPreferences({ appearance: { theme } }), theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", theme);
      await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "artifact-preview-" + theme + ".png") });
    }
  }
  await page.getByRole("button", { name: "Go to message" }).click();
  const firstMessage = page.locator(`#message-${chat.id}-0`);
  const sentMessage = page.locator(`#message-${chat.id}-${sentIndex}`);
  await expect(firstMessage).toBeInViewport();
  await expect(sentMessage).not.toBeInViewport();
  await page.getByRole("tab", { name: /^Artifacts/ }).click();
  await sent.click();
  await page.getByRole("button", { name: "Go to message" }).click();
  await expect(sentMessage).toBeInViewport();
  await expect(firstMessage).not.toBeInViewport();
  const unindexedLink = page.getByRole("link", { name: unindexed });
  await unindexedLink.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview in Artifacts" }).click();
  await expect(page.locator(".artifact-text")).toContainText("Unindexed local preview fixture");
  const resolved = await page.evaluate((input) => window.botkins["artifacts.resolve"](input), { chatId: chat.id, paths: [fixture] });
  assert.ok(resolved.items[0], JSON.stringify(resolved));
  const listed = await page.evaluate((id) => window.botkins["artifacts.list"]({ botId: id, kind: "files" }).catch((error) => ({ error: String(error) })), bot.id);
  assert.ok(!("error" in listed), JSON.stringify(listed));
  await app.evaluate(({ shell }) => {
    globalThis.__openedPath = null;
    shell.openPath = async (path) => { globalThis.__openedPath = path; return ""; };
  });
  const link = page.getByRole("link", { name: fixture, exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect.poll(() => app.evaluate(() => globalThis.__openedPath)).toBe(info.path);
  console.log("Artifacts Electron smoke passed: list, preview pane, verified path link and open IPC.");
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
