// Electron smoke for an MCP App's view in a chat (desktop/mcp-apps.mjs, src/McpAppCard.tsx). The view
// is a real MCP App: the official App client of @modelcontextprotocol/ext-apps, inlined into the page,
// against the window's AppBridge. Its server is test/fixtures/mcp-app-server.mjs over stdio, which
// logs every call, so the smoke counts them: showing the card runs nothing, and one press runs one call.
// Run after `npm run build`:
//   node test/mcp-apps-smoke.mjs        (BOTKINS_QA_DIR=<folder> keeps screenshots)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { starterBots } from "./starter.mjs";
import { viewCsp } from "../desktop/mcp-apps.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-mcp-apps-smoke-"));
const data = join(root, "data");
const log = join(root, "calls.log");
const qa = process.env.BOTKINS_QA_DIR;
if (qa) mkdirSync(qa, { recursive: true });
const shot = async (page, name) => qa && (await page.screenshot({ path: join(qa, name + ".png") }));
const calls = (tool) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter((entry) => entry.method === "tools/call" && entry.tool === tool).length;

// The official App, made into a classic script that leaves its exports on `window.McpApp`.
const bundle = readFileSync(createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
const exported = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(bundle);
assert.ok(exported, "the App bundle ends with its exports");
const names = exported[1].split(",").map((pair) => pair.trim().split(/\s+as\s+/)).map(([local, name]) => (name ?? local) + ":" + local);
const appScript = bundle.slice(0, exported.index) + "\nwindow.McpApp={" + names.join(",") + "};";
const view = `<!doctype html><meta charset="utf-8"><title>Clock</title>
<style>body{font:15px system-ui;margin:12px;color:CanvasText} button{font:inherit}</style>
<p id="time">Waiting…</p><button id="again">Refresh</button>
<script type="module">${appScript}
const { App } = window.McpApp;
const app = new App({ name: "clock", version: "1.0.0" });
const show = (result) => { document.getElementById("time").textContent = "Time: " + (result?.structuredContent?.time ?? "?"); };
app.ontoolresult = show;
await app.connect();
document.getElementById("again").addEventListener("click", async () => show(await app.callServerTool({ name: "refresh_time", arguments: {} })));
</script>`;

// A chat whose turn ran get_time: the card, and what the computer kept of it.
const now = Date.now();
const cardId = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const runId = "run-clock";
const servers = [{ id: "clock-id", name: "clock", type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-app-server.mjs", import.meta.url))], env: { BOTKINS_TEST_LOG: log }, enabled: true }];
const chats = [{ id: "clock-chat", botId: "pip", title: "Clock", time: now, established: false, messages: [{ role: "user", text: "What time is it?", runId }, { role: "assistant", runId, text: "Here is the time." }] }];
const runs = [{ id: runId, chatId: "clock-chat", title: "What time is it?", time: now, status: "Completed", detail: "", mcpApps: [{ id: cardId, server: "clock", tool: "get_time", title: "Get the time", summary: "It is 12:00.", at: now }] }];
mkdirSync(join(data, "mcp-views", cardId), { recursive: true });
writeFileSync(join(data, "workspace.json"), JSON.stringify({ bots: starterBots, chats, runs, mcpServers: servers }));
writeFileSync(join(data, "mcp-views", cardId, "view.html"), view);
writeFileSync(
  join(data, "mcp-views", cardId, "payload.json"),
  JSON.stringify({ server: "clock-id", uri: "ui://clock/view.html", tool: { name: "get_time", title: "Get the time", inputSchema: { type: "object" } }, input: { zone: "UTC" }, result: { content: [{ type: "text", text: "It is 12:00." }], structuredContent: { time: "12:00" } }, csp: viewCsp({}) }),
);

const env = { ...process.env, BOTKINS_DATA_DIR: root, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
const errors = [];
try {
  const page = await home(app);
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 900));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("navigation").getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("button", { name: /Clock/ }).first().click();

  const card = page.locator("section.mcp-app-card");
  await card.waitFor({ timeout: 20000 });
  const frame = page.frameLocator("section.mcp-app-card iframe");
  // The handshake, then the tool's result as it was: no call is made to show it.
  await expect(frame.locator("#time")).toHaveText("Time: 12:00", { timeout: 20000 });
  assert.equal(calls("get_time"), 0, "showing the card ran nothing");
  assert.equal(calls("refresh_time"), 0);
  await shot(page, "mcp-app-shown");

  // The view's button asks the same server for fresh data: exactly one call.
  await frame.getByRole("button", { name: "Refresh" }).click();
  await expect(frame.locator("#time")).toHaveText(/Time: 12:0[1-9]/, { timeout: 20000 });
  assert.equal(calls("refresh_time"), 1, "one press, one call");
  await shot(page, "mcp-app-refreshed");

  // The view has no bridge of the window's, and its page reaches nothing it didn't declare.
  const inside = await card.locator("iframe").evaluate((element) => {
    try {
      return typeof element.contentWindow.botkins;
    } catch {
      return "cross-origin";
    }
  });
  assert.equal(inside, "cross-origin", "the view is a frame of another origin");
  assert.deepEqual(errors, []);
  console.log("MCP Apps smoke passed: the view showed the kept result, and one press made one call.");
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
