// Run after npm run build. Real renderer, preload, IPC, request handlers and sandboxed
// Electron guest. The tool caller and sign-in website are local synthetic fixtures.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";
import { skipWelcome } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-secure-ui-"));
const data = join(dir, "profile");
seedApp(data);
const fixture = join(dir, "main.mjs");
writeFileSync(fixture, `
  import { Workspace } from ${JSON.stringify(new URL("../desktop/workspace.mjs", import.meta.url).href)};
  const snapshot = Workspace.prototype.snapshot;
  Workspace.prototype.snapshot = function () { globalThis.smokeWorkspace = this; return snapshot.call(this); };
  await import(${JSON.stringify(new URL("../desktop/main.mjs", import.meta.url).href)});
`);
const env = { ...process.env, BOTKINS_DATA_DIR: data, BOTKINS_TOOL_PATH: dir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BOTKINS_KEYCHAIN;
const url = "https://secure-input.invalid/sign-in";
let app;
try {
  app = await _electron.launch({ args: [fixture], env, timeout: 30000 });
  const page = await skipWelcome(await app.firstWindow());
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const chatId = await page.evaluate(() => window.botkins.createChat("pip"));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await page.getByRole("combobox", { name: "Message", exact: true }).waitFor();
  await app.evaluate(async ({ session }, { chatId, url }) => {
    const ws = globalThis.smokeWorkspace;
    const chat = ws.chat(chatId), bot = ws.bot(chat.botId), run = { id: "smoke-secure" }, task = { run, stream: "" };
    ws.active.set(chatId, task);
    const viewer = session.fromPartition("side-pane-web");
    viewer.protocol.handle("https", () => new Response('<input name="username"><input name="password" type="password">', { headers: { "Content-Type": "text/html" } }));
    const pane = ws.sidepane.add(chat, bot, run, { kind: "web", title: "Sign in", url });
    ws.sidepane.front(chat, bot, run, pane);
    ws.save();
    const [ask, use] = ws.secureInputs.tools(bot, chat, run, task);
    globalThis.smokeResult = ask.handler({ title: "Website login", operation: "page_fill", url, fields: [
      { key: "username", label: "Username", kind: "text" }, { key: "password", label: "Password", kind: "password" },
    ] }).then(result => use.handler({ handles: Object.values(JSON.parse(result).handles) }))
      .catch(error => ({ error: error.message })).finally(() => ws.active.delete(chatId));
  }, { chatId, url });
  const panel = page.getByRole("region", { name: "Secure input request" });
  await expect(panel).toContainText(url);
  await expect(page.locator("webview")).toBeVisible();
  await expect.poll(() => app.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find(w => w.getType() === "webview" && w.getURL() === url);
    return guest && guest.executeJavaScript('document.querySelectorAll("input").length');
  }, url)).toBe(2);
  const password = panel.getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await panel.getByLabel("Username", { exact: true }).fill("smoke-only-user");
  await password.fill("smoke-only-password");
  await panel.getByRole("button", { name: "Allow this use" }).click();
  const result = await app.evaluate(() => globalThis.smokeResult);
  assert.equal(result, '{"applied":true}', JSON.stringify(result));
  assert.equal(await app.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find(w => w.getType() === "webview" && w.getURL() === url);
    return guest.executeJavaScript('document.querySelector("[name=username]").value === "smoke-only-user" && document.querySelector("[name=password]").value === "smoke-only-password"');
  }, url), true);
  await expect(panel).toHaveCount(0);
  await expect(page.locator("article.user").getByText("Website login · Provided Username, Password")).toBeVisible();
  assert.doesNotMatch(readFileSync(join(data, "data/workspace.json"), "utf8"), /smoke-only-(user|password)/);
  console.log("Secure desktop prompt, submission, actual guest inputs and label-only receipt passed.");
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
