// Smoke for Today's Feed, Ideas and Goals and for HTML apps. Seeds a workspace, then checks the board
// actions, the sandboxed app window, its data bridge and its answer reaching the message box.
// BOTKINS_LIVE=1 also asks a real bot to post to the board and show an app.
// Set BOARD_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { probeListeners, probePage } from "./webrtc-probe.mjs";
import { openBoard } from "./spaces-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-board-"));
const shots = process.env.BOARD_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });

// First launch writes a fresh workspace; then seed board items, a chat and an app into it.
let app = await launch();
await (await skipWelcome(await app.firstWindow())).getByRole("heading", { name: "Home", exact: true }).waitFor();
await app.close();
const file = join(dir, "data", "workspace.json");
const ws = JSON.parse(readFileSync(file, "utf8"));
const [pip, scout] = ws.bots;
const now = Date.now();
const item = (botId, kind, title, extra = {}) => ({
  id: randomUUID(), botId, kind, title, body: "", links: [], status: "open", read: false, createdAt: now, updatedAt: now, ...extra,
});
ws.board = [
  item(pip.id, "feed", "Rates fell this morning", { body: "Mortgage rates dropped **0.2%**.", links: [{ url: "https://example.com/rates", title: "Rates" }] }),
  item(scout.id, "idea", "Take a walk after lunch", { body: "Ten minutes helps." }),
  item(pip.id, "goal", "Read 12 books", { category: "interests" }),
];
const appId = randomUUID(), chatId = randomUUID(), runId = randomUUID();
ws.chats.unshift({ id: chatId, botId: pip.id, title: "App check", time: now, established: false,
  messages: [{ role: "user", text: "Show an app", runId }, { role: "assistant", text: "Here it is.", runId }] });
ws.runs.unshift({ id: runId, chatId, title: "Show an app", time: now, status: "Completed", detail: "",
  apps: [{ id: appId, title: "Number pad", description: "Pick a number and send it.", sendsAnswers: true }] });
ws.apps = [{ id: appId, botId: pip.id, chatId, runId, title: "Number pad", description: "Pick a number and send it.", sendsAnswers: true, createdAt: now, updatedAt: now }];
mkdirSync(join(dir, "data", "apps", appId), { recursive: true });
// The app's page is also a probe: it tries to reach the network through WebRTC (test/webrtc-probe.mjs).
const probe = await probeListeners();
writeFileSync(join(dir, "data", "apps", appId, "index.html"),
  probePage(probe).replace('<p id="probe-title">Probe</p>', "<h1 id=n>…</h1><script>window.botkins.getData().then(d=>{document.getElementById('n').textContent=d.n})</script>"));
writeFileSync(join(dir, "data", "apps", appId, "data.json"), JSON.stringify({ n: 7 }));
writeFileSync(file, JSON.stringify(ws));

app = await launch();
try {
  const page = await skipWelcome(await app.firstWindow());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  const snapshot = () => page.evaluate(() => window.botkins.snapshot());
  // The board: one region with three tabs on the Today page, or the cards of a Feed, Ideas or Goals space.
  const board = page.locator(".board-panel");
  const nav = (name) => page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
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

  // Feed: open marks read, thumbs down with a reason clears it.
  await openBoard(page, "Feed");
  await board.getByRole("button", { name: /Rates fell this morning/ }).click();
  await board.getByText("0.2%").waitFor();
  await expect.poll(async () => (await snapshot()).board.find((i) => i.kind === "feed").read).toBe(true);
  await shoot("board-feed");
  await board.getByRole("button", { name: "Less like this" }).click();
  await board.getByRole("button", { name: "Too frequent" }).click();
  await expect.poll(async () => (await snapshot()).board.find((i) => i.kind === "feed").status).toBe("cleared");
  await board.getByText("Nothing yet. Ask a bot for posts.").waitFor();

  // Ideas: turning one into a goal answers it and adds the goal.
  await openBoard(page, "Ideas");
  await board.getByRole("button", { name: /Take a walk after lunch/ }).click();
  await board.getByRole("combobox", { name: "Turn into a goal" }).selectOption("health");
  await expect.poll(async () => (await snapshot()).board.filter((i) => i.kind === "goal").length).toBe(2);
  const goal = (await snapshot()).board.find((i) => i.kind === "goal" && i.title === "Take a walk after lunch");
  assert.equal(goal.category, "health");

  // Goals: Not today hides a goal until tomorrow; Mark done finishes another.
  await openBoard(page, "Goals");
  await board.getByRole("button", { name: /Read 12 books/ }).click();
  await board.getByRole("button", { name: "Not today" }).click();
  await expect(board.getByRole("button", { name: /Read 12 books/ })).toHaveCount(0);
  await board.getByRole("button", { name: /Take a walk after lunch/ }).click();
  await board.getByRole("button", { name: "Mark done" }).click();
  await expect.poll(async () => (await snapshot()).board.find((i) => i.id === goal.id).status).toBe("done");
  await board.getByRole("button", { name: "Show finished" }).click();
  await board.getByRole("button", { name: /Take a walk after lunch/ }).waitFor();

  // HTML app: the card opens a sandboxed window with data, no network and no Node.
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await page.getByRole("region", { name: "Number pad" }).waitFor();
  await shoot("app-card");
  const [appWindow] = await Promise.all([app.waitForEvent("window"), page.getByRole("button", { name: "Open app" }).click()]);
  await appWindow.locator("#n").filter({ hasText: "7" }).waitFor();
  // The app cannot reach the network through WebRTC, from its page or from a frame it makes.
  await appWindow.waitForTimeout(4000);
  const found = await appWindow.evaluate(() => ({ has: window.probe.has, tried: window.probe.tried, nested: window.probe.nested, borrowed: window.probe.borrowed ?? null, frames: document.querySelectorAll("iframe,frame,object,embed").length }));
  // The app's page has an address of its own, so it can reach into an empty frame it makes and find
  // WebRTC there for a moment (`borrowed`). That frame is taken out at once, and the window's session
  // has no way out for a connection, so nothing may arrive either way.
  const { borrowed, ...rest } = found;
  assert.deepEqual(rest, { has: "undefined", tried: "refused", nested: [], frames: 0 });
  assert.ok(borrowed === null || borrowed === "function");
  assert.deepEqual(probe.heard, { tcp: 0, udp: 0 }, "an HTML app reached the network through WebRTC");
  const sandbox = await appWindow.evaluate(async () => {
    let network = "allowed";
    try {
      await fetch("https://example.com/");
    } catch {
      network = "blocked";
    }
    return { network, node: typeof require, process: typeof process, data: await window.botkins.getData(), bighelp: typeof window.bighelp?.sendAnswer };
  });
  assert.deepEqual(sandbox, { network: "blocked", node: "undefined", process: "undefined", data: { n: 7 }, bighelp: "function" });
  await appWindow.evaluate(() => window.botkins.sendAnswer("I picked 7"));
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveValue("I picked 7");
  assert.equal((await snapshot()).chats.find((c) => c.id === chatId).messages.length, 2, "an app's answer is never sent by itself");
  // close() shuts the app window itself, so the evaluate that calls it never returns.
  await Promise.all([appWindow.waitForEvent("close"), appWindow.evaluate(() => window.botkins.close()).catch(() => {})]);

  if ((process.env.BOTKINS_LIVE ?? process.env.COMMANDER_LIVE) === "1") {
    const before = (await snapshot()).runs.length;
    const id = await page.evaluate((botId) => window.botkins.createChat(botId), pip.id);
    await page.evaluate(
      (id) => window.botkins.send(id, "Do two things with your tools, then reply with one short sentence. 1) Use board_post with kind feed and title 'Smoke feed check'. 2) Use show_app with title 'Smoke app', a one-line description, and a tiny HTML page that shows the number 7."),
      id,
    );
    await expect
      .poll(async () => {
        const s = await snapshot();
        return s.runs.length > before && s.runs.find((r) => r.chatId === id)?.status !== "Working";
      }, { timeout: 240000, intervals: [1000, 2000] })
      .toBe(true);
    const s = await snapshot();
    const live = s.runs.find((r) => r.chatId === id);
    assert.equal(live.status, "Completed", live.detail);
    assert.ok(s.board.some((i) => i.title === "Smoke feed check" && i.botId === pip.id), "the bot posted to the Feed");
    assert.ok(live.apps?.some((a) => a.title === "Smoke app"), "the bot showed an app");
    console.log("Live: the bot posted to the Feed and showed an app.");
  }
  assert.deepEqual(errors, []);
  console.log("Feed, Ideas and Goals actions, the sandboxed HTML app window, its data bridge and its answer passed.");
} finally {
  await app.close();
  probe.close();
  rmSync(dir, { recursive: true, force: true });
}
