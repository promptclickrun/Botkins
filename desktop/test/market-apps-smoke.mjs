// Electron renderer smoke for Marketplace › Apps (Composio). Signed out it reads the real public app
// list (network); signed in, the computer's Composio answers are stood in for, so no account is used.
// Run after `npm run build`:
//   node test/market-apps-smoke.mjs        (BOTKINS_QA_DIR=<folder> keeps screenshots)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome, home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-market-apps-"));
seedApp(root);
const qa = process.env.BOTKINS_QA_DIR;
if (qa) mkdirSync(qa, { recursive: true });
const shot = async (page, name) => qa && (await page.screenshot({ path: join(qa, name + ".png") }));

const binary = process.env.BOTKINS_BINARY;
const env = { ...process.env, BOTKINS_DATA_DIR: root, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
const errors = [];
let page;
async function openApps() {
  await page.locator("aside .brand").getByRole("button", { name: "Marketplace", exact: true }).click();
  const dialog = page.locator("dialog.settings-window");
  await dialog.getByRole("heading", { name: "Marketplace", exact: true }).waitFor();
  await dialog.getByRole("tab", { name: "Apps", exact: true }).click();
  return dialog;
}
try {
  page = await home(app);
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });

  // Signed out: the way in, and the real app list with its logos.
  let dialog = await openApps();
  await dialog.getByText("Connect your apps", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Sign in with Composio" }).waitFor();
  const gmail = dialog.locator(".app-tile", { hasText: "Gmail" }).first();
  await gmail.waitFor({ timeout: 60000 });
  await expect.poll(() => gmail.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0), { timeout: 20000 }).toBe(true);
  await shot(page, "apps-signed-out");
  await gmail.click();
  await dialog.getByRole("heading", { name: "Gmail", exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await shot(page, "app-page-signed-out");
  await dialog.getByRole("button", { name: /Back to apps/ }).click();

  // Signed in: the computer's Composio tool is on and signed in; its answers are stood in for.
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const swap = (name, fn) => {
      const real = ipcMain._invokeHandlers.get(name);
      ipcMain.removeHandler(name);
      ipcMain.handle(name, (event, ...args) => fn(real, event, ...args));
    };
    const server = { id: "composio-test", name: "composio", type: "http", url: "https://connect.composio.dev/mcp", enabled: true, auth: { type: "oauth", signedIn: true, canRenew: true, signingIn: false } };
    const withServer = (state) => ({ ...state, mcpServers: [...(state.mcpServers ?? []).filter((item) => item.id !== server.id), server] });
    swap("snapshot", async (real, event, ...args) => withServer(await real(event, ...args)));
    // What the app pushes to the window after a change carries it too.
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => send(channel, ...(channel === "changed" && args[0] ? [withServer(args[0]), ...args.slice(1)] : args));
    const accounts = { gmail: [{ id: "ca_gmail", status: "active", label: "me@example.com" }], github: [{ id: "ca_github", status: "active" }] };
    swap("composio.connected", () => ["gmail", "github"]);
    swap("composio.accounts", (real, event, slugs) => Object.fromEntries(slugs.map((slug) => [slug, accounts[slug] ?? []])));
  });
  await page.reload();
  await skipWelcome(page);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });
  dialog = await openApps();
  await dialog.getByText("Your bots can use these apps").waitFor({ timeout: 30000 });
  await dialog.getByRole("heading", { name: "Your apps", exact: true }).waitFor();
  await shot(page, "apps-signed-in");
  await dialog.locator(".app-tile", { hasText: "Gmail" }).first().click();
  await dialog.getByRole("heading", { name: "Gmail", exact: true }).waitFor();
  await dialog.getByText("me@example.com").waitFor();
  await shot(page, "app-page-signed-in");

  // The same in dark.
  const appearance = (await page.evaluate(() => window.botkins.snapshot())).settings.appearance;
  await page.evaluate((appearance) => window.botkins.setPreferences({ appearance: { ...appearance, theme: "dark" } }), appearance);
  await page.waitForTimeout(500);
  await shot(page, "app-page-signed-in-dark");
  await dialog.getByRole("button", { name: /Back to apps/ }).click();
  await page.waitForTimeout(300);
  await shot(page, "apps-signed-in-dark");
  assert.deepEqual(errors, []);
  console.log("market apps smoke: ok");
} finally {
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
