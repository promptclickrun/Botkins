// A real paired desktop window, an isolated Xvfb host, and a bot's Screen tab and chat card.
// Linux: npm run build && xvfb-run -a node test/remote-computer-screen-smoke.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { x11Screen } from "../desktop/host/x11screen.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { liveContextFor } from "../desktop/live-context.mjs";
import { Workspace, seedApp } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { home } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-computer-pane-"));
const xvfb = spawn("Xvfb", ["-displayfd", "1", "-noreset", "-nolisten", "tcp", "-screen", "0", "800x480x24"], { stdio: ["ignore", "pipe", "ignore"] });
const exited = once(xvfb, "exit");
let app, link;
try {
  const [number] = await once(xvfb.stdout, "data", { signal: AbortSignal.timeout(10_000) });
  const display = ":" + String(number).trim();
  execFileSync("xsetroot", ["-solid", "#df2012"], { env: { ...process.env, DISPLAY: display } });
  const watchers = new Set();
  const ws = new Workspace(join(dir, "host"), fakeClient().client, () => watchers.forEach(fn => fn()));
  const chatId = ws.createChat("pip");
  const chat = ws.chat(chatId);
  chat.title = "Shared desktop test";
  const run = { id: crypto.randomUUID(), chatId, status: "Working" };
  const panel = ws.sidepane.add(chat, ws.bot("pip"), run, { kind: "screen", title: "Computer screen" });
  const input = [];
  const screen = x11Screen({ display });
  link = new LinkHost({ dir: join(dir, "link"), port: 0, screenInput: async batch => input.push(...batch.events),
    backend: { info: () => ({ app: "botkins", version: "1.0.0", platform: "linux" }), capabilities: ["side-pane-v1"], liveContext: args => liveContextFor(ws, args),
      snapshot: () => ws.snapshot(), subscribe: fn => (watchers.add(fn), () => watchers.delete(fn)), screen,
      call: (method, args) => method === "sidePane" ? ws.sidepane.act(...args) : null } });
  await link.start();
  await link.setEnabled(true);
  link.setScreenMode("control");
  seedApp(join(dir, "client"));
  const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "client"), BOTKINS_PROVIDERS: "copilot" };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: ["--no-sandbox", "--ozone-platform=x11", "."], env });
  const page = await home(app);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const hostId = await page.evaluate(async ({ address, code }) => {
    const host = await window.botkins.pairRemoteHost({ address, code });
    await window.botkins.useRemoteHost(host.id);
    return host.id;
  }, { address: "127.0.0.1:" + link.status().port, code: link.startPairing().code });
  await expect.poll(() => page.evaluate(() => window.botkins.snapshot().then(s => s.remote?.using?.state))).toBe("online");
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  const card = page.getByRole("button", { name: "Computer screen", exact: true });
  await expect(card).toBeVisible({ timeout: 20_000 });
  ws.sidepane.front(chat, ws.bot("pip"), run, panel);
  ws.save();
  const gate = page.getByRole("button", { name: "Open computer", exact: true });
  await expect(gate).toBeVisible();
  assert.equal(link.screen.viewing.size, 0, "an agent can surface the panel without starting a viewer");
  await gate.click();
  const dialog = page.locator("dialog.computer-view");
  const video = dialog.locator("video");
  await expect.poll(() => video.evaluate(el => el.videoWidth === 800 && el.currentTime > 0.1), { timeout: 20_000 }).toBe(true);
  const [red,, blue] = await video.evaluate(el => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.drawImage(el, 0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  });
  assert.ok(red > 150 && blue < 80, "the viewer shows the red remote desktop");
  await dialog.getByRole("button", { name: "Control", exact: true }).click();
  const stage = dialog.locator(".computer-stage");
  await stage.click();
  await page.keyboard.type("z");
  await stage.click({ button: "right" });
  await page.mouse.wheel(0, 100);
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 3 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Send Escape to remote computer" }).click();
  await expect.poll(() => ["click", "rightClick", "scroll", "down", "move", "up"].every(type => input.some(event => event.type === type)) &&
    input.some(event => event.type === "text" && event.text === "z") && input.some(event => event.type === "key" && event.key === "escape")).toBe(true);
  if (process.env.COMPUTER_SCREEN_SHOT) await page.screenshot({ path: process.env.COMPUTER_SCREEN_SHOT });
  await dialog.getByRole("button", { name: "Close computer" }).click();
  await expect.poll(() => link.screen.viewing.size).toBe(0);
  link.setScreenMode("view");
  // A host with a JPEG adapter and no continuous encoder remains usable from the same card.
  link.backend.screen = { displays: screen.displays, capture: screen.capture, permissions: screen.permissions };
  await card.click();
  await expect.poll(() => dialog.locator("img").evaluate(el => el.naturalWidth), { timeout: 20_000 }).toBe(800);
  await expect(dialog.getByRole("button", { name: "Control", exact: true })).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).remote.using.id, hostId);
  await page.evaluate(() => window.botkins.useRemoteHost(null));
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => link.screen.viewing.size).toBe(0);
  assert.deepEqual(errors, []);
  console.log("Paired Screen tab and chat card passed live video, input, JPEG, view-only and switch-away checks.");
} finally {
  await app?.close();
  await link?.stop();
  xvfb.kill(); await exited;
  rmSync(dir, { recursive: true, force: true });
}
