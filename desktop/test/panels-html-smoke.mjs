// Html blocks smoke: a page a bot wrote, drawn in a sandboxed frame inside a Today panel and a chat
// card (src/HtmlFrame.tsx, desktop/frames.mjs). Isolated data folder, no Copilot turns. The frames are
// seeded as files before launch. Checks that the page renders with its data, gets the app's colors and
// follows a theme change, grows to its content, puts an answer into the right chat's message box (not
// sent), asks before opening a link, loads nothing from the network and can't leave or reach the app.
// Set PANELS_HTML_SHOTS to a folder to save light and dark screenshots at 1190×830 and 760×560.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { starterBots } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-html-"));
const dataDir = join(dir, "app");
const data = join(dataDir, "data");
mkdirSync(join(data, "frames"), { recursive: true });
const shots = process.env.PANELS_HTML_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const errors = [];

// A server the pages try to reach. It must never hear from them.
const hits = [];
const server = createServer((request, response) => {
  hits.push(request.url);
  response.end("reached");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const outside = "http://127.0.0.1:" + server.address().port;

// The page: its data, the app's colors, a tall body, the bridge's answer and link calls, and tries
// to reach the network, leave the frame and reach the app.
const page = (label) => `<!doctype html><html><head><title>${label}</title>
<style>
  body { font: 14px/1.5 system-ui; color: var(--ink); }
  .card { background: var(--rail); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .bar { height: 10px; border-radius: 5px; background: var(--accent); margin: 8px 0; }
  .tall { height: 180px; display: grid; place-items: center; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
  button { font: inherit; padding: 4px 10px; }
</style></head><body>
<div class="card">
  <h2 id="title">…</h2>
  <p id="mode">mode</p>
  <div class="bar" style="width:70%"></div><div class="bar" style="width:45%"></div>
  <button id="answer">Send answer</button> <button id="link">Open docs</button> <button id="leave">Leave</button>
  <img id="pic" alt="remote picture" src="${outside}/picture.png">
  <div class="tall">Tall content</div>
</div>
<script>
  botkins.getData().then((d) => (document.getElementById("title").textContent = d.title));
  botkins.onTheme((mode) => (document.getElementById("mode").textContent = "Theme: " + mode));
  window.tries = {};
  fetch("https://example.com").then(() => (tries.web = "reached"), (e) => (tries.web = "blocked"));
  fetch("${outside}/fetch").then(() => (tries.local = "reached"), (e) => (tries.local = "blocked"));
  document.getElementById("pic").addEventListener("error", () => (tries.img = "blocked"));
  document.getElementById("pic").addEventListener("load", () => (tries.img = "reached"));
  try { tries.parentBridge = typeof window.parent.commander; } catch (e) { tries.parentBridge = "blocked"; }
  try { tries.parentDom = window.parent.document.title; } catch (e) { tries.parentDom = "blocked"; }
  try { tries.top = window.top.location.href; } catch (e) { tries.top = "blocked"; }
  tries.ownBridge = Object.keys(window.botkins).sort().join(",");
  tries.appBridge = [typeof require, typeof window.ipcRenderer, typeof process, typeof window.botkins.snapshot, typeof window.commander.snapshot].join(",");
  window.forge = () => {
    document.getElementById("title").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
  };
  document.getElementById("answer").onclick = () =>
    commander.sendAnswer("Plan the launch for ${label}").then(() => (tries.answer = "ok"), (e) => (tries.answer = e.message));
  document.getElementById("link").onclick = () =>
    commander.openLink("https://example.com/docs").then((v) => (tries.link = String(v)), (e) => (tries.link = e.message));
  document.getElementById("leave").onclick = () => { location.href = "${outside}/leave"; };
</script></body></html>`;

const now = Date.now();
const panelFrame = randomUUID();
const cardFrame = randomUUID();
const smallFrame = randomUUID();
for (const [id, html, json] of [
  [panelFrame, page("Acme"), { title: "Quarter at a glance" }],
  [cardFrame, page("Contoso"), { title: "Card chart" }],
  [smallFrame, "<p style='margin:0;padding:6px 0;color:var(--muted)'>A short note in a small panel.</p>", null],
]) {
  writeFileSync(join(data, "frames", id + ".html"), html);
  writeFileSync(join(data, "frames", id + ".json"), JSON.stringify(json));
}
const chats = [
  {
    id: "chat-card",
    botId: "scout",
    title: "Card chat",
    time: now - 60000,
    established: false,
    messages: [
      { role: "user", text: "Show me the chart", runId: "run-card" },
      { role: "assistant", text: "Here it is.", runId: "run-card" },
    ],
  },
  { id: "chat-panel", botId: "pip", title: "Panel chat", time: now - 120000, established: false, messages: [] },
];
const runs = [
  {
    id: "run-card",
    chatId: "chat-card",
    title: "Show me the chart",
    time: now - 60000,
    finished: now - 50000,
    status: "Completed",
    detail: "",
    cards: [{ id: "card-1", title: "Contoso chart", blocks: [{ type: "html", frame: cardFrame, height: 140 }], replies: [] }],
  },
];
const panel = (id, chatId, title, size, blocks) => ({ id, key: id, botId: "pip", chatId, title, blocks, hidden: false, size, revision: 1, updatedAt: now - 3600000, routine: null });
const panels = [
  panel("panel-wide", "chat-panel", "Acme dashboard", "wide", [{ type: "html", frame: panelFrame, height: 120 }]),
  panel("panel-small", "chat-panel", "Note", "small", [{ type: "html", frame: smallFrame, height: 60 }]),
  panel("panel-plain", "chat-panel", "Numbers", "small", [{ type: "metric", label: "Seats", value: "52" }]),
];
const frames = [
  { id: panelFrame, owner: "panel:panel-wide", botId: "pip", createdAt: now },
  { id: smallFrame, owner: "panel:panel-small", botId: "pip", createdAt: now },
  { id: cardFrame, owner: "chat:chat-card", botId: "scout", createdAt: now },
];
writeFileSync(join(data, "workspace.json"), JSON.stringify({ bots: starterBots, chats, runs, panels, frames }));

const env = { ...process.env, BOTKINS_DATA_DIR: dataDir, COMMANDER_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
let app, win;
const snap = () => win.evaluate(() => window.botkins.snapshot());
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const theme = (mode) => win.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
const appVar = (name) => win.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
async function shot(name) {
  if (!shots) return;
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await win.locator(`html[data-mode="${mode}"]`).waitFor();
    await win.waitForTimeout(400);
    await win.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
}
/** The frame inside an iframe element. */
async function frameOf(iframe) {
  await expect(iframe).toBeVisible();
  const handle = await iframe.elementHandle();
  const frame = await handle.contentFrame();
  assert.ok(frame, "the iframe has a frame");
  return frame;
}
const tries = (frame) => frame.evaluate(() => ({ ...window.tries }));

try {
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  // Signed in as a made-up account; links and questions answered by stand-ins that record what they were asked.
  await app.evaluate(({ ipcMain, dialog, shell }) => {
    ipcMain.removeHandler("auth");
    ipcMain.handle("auth", () => ({ connected: true, login: "octocat", type: "user" }));
    globalThis.asked = [];
    globalThis.opened = [];
    globalThis.answer = 1;
    dialog.showMessageBox = async (_win, options) => {
      globalThis.asked.push({ message: options.message, detail: options.detail });
      return { response: globalThis.answer };
    };
    shell.openExternal = async (url) => void globalThis.opened.push(url);
  });
  await win.reload();
  win = await skipWelcome(win);
  await win.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await size(1190, 830);
  await win.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Today", exact: true }).click();

  // ---- The panel's page: a sandboxed frame from its own address, with its data.
  const panelEl = win.locator(".live-panel", { has: win.getByRole("heading", { name: "Acme dashboard" }) });
  const iframe = panelEl.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("src", "commander-app://frame-" + panelFrame + "/");
  await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(iframe).toHaveAttribute("title", "Acme dashboard");
  let frame = await frameOf(iframe);
  await expect.poll(() => frame.evaluate(() => document.getElementById("title").textContent)).toBe("Quarter at a glance");
  await expect(panelEl.locator(".html-frame")).not.toHaveClass(/loading/);
  console.log("The panel draws its page in a sandboxed frame (allow-scripts only) with its data.");

  // ---- The app's colors reach the page and follow a theme change.
  const frameVar = (name) => frame.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
  for (const mode of ["light", "dark", "light"]) {
    await theme(mode);
    await win.locator(`html[data-mode="${mode}"]`).waitFor();
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe(mode);
    for (const name of ["--ink", "--paper", "--rail", "--line", "--accent"]) await expect.poll(() => frameVar(name)).toBe(await appVar(name));
    await expect.poll(() => frame.evaluate(() => document.getElementById("mode").textContent)).toBe("Theme: " + mode);
  }
  console.log("The page gets the app's colors and follows light and dark.");

  // ---- The frame grows from the block's height to its content, with no inner scrollbar.
  await expect.poll(() => iframe.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(280);
  const fit = await frame.evaluate(() => ({ scroll: document.documentElement.scrollHeight, view: innerHeight }));
  assert.ok(fit.scroll <= fit.view + 1, "the page fits its frame: " + JSON.stringify(fit));
  const smallIframe = win.locator(".live-panel", { has: win.getByRole("heading", { name: "Note" }) }).locator("iframe");
  await expect.poll(() => smallIframe.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(120);
  console.log("The frame grows to its content (" + Math.round(await iframe.evaluate((el) => el.getBoundingClientRect().height)) + "px).");

  // ---- Nothing loads from anywhere, the page stays where it is, and it can't reach the app.
  await expect.poll(async () => (await tries(frame)).web).toBe("blocked");
  await expect.poll(async () => (await tries(frame)).local).toBe("blocked");
  await expect.poll(async () => (await tries(frame)).img).toBe("blocked");
  const reach = await tries(frame);
  assert.equal(reach.parentBridge, "blocked", "the page can't reach the app's window.botkins");
  assert.equal(reach.parentDom, "blocked", "the page can't reach the app's page");
  assert.equal(reach.top, "blocked", "the page can't read the app's address");
  assert.equal(reach.ownBridge, ["bighelp", "close", "getData", "onData", "onTheme", "openLink", "sendAnswer", "sendMessage", "state", "theme"].filter((k) => k !== "bighelp").join(","));
  assert.equal(reach.appBridge, "undefined,undefined,undefined,undefined,undefined", "the app's own script runs beside the page to hear real input; the page gets nothing of it");
  await frame.click("#leave");
  // The app blocks the load; the frame shows its own page again, never another address or an error page.
  await win.waitForTimeout(1200);
  frame = await frameOf(iframe);
  assert.equal(frame.url(), "commander-app://frame-" + panelFrame + "/", "the frame stayed on its page");
  await expect.poll(() => frame.evaluate(() => document.getElementById("title").textContent)).toBe("Quarter at a glance");
  assert.deepEqual(hits, [], "the outside server was reached: " + hits.join(", "));
  // The app's own page is untouched by the frame.
  assert.equal(await win.evaluate(() => typeof window.botkins.snapshot), "function");
  console.log("fetch, a remote image and leaving the frame load nothing; the page can't reach the app.");

  // ---- The app hears of real input inside a view, by the view's id, and of nothing the page makes up.
  await win.evaluate(() => {
    window.gestures = [];
    window.botkins.onFrameGesture((gesture) => window.gestures.push(gesture));
  });
  const gestures = () => win.evaluate(() => window.gestures.splice(0));
  await win.waitForTimeout(400);
  await gestures();
  await frame.evaluate(() => window.forge());
  await win.getByRole("heading", { name: "Acme dashboard" }).click();
  await win.waitForTimeout(400);
  assert.deepEqual(await gestures(), [], "an event the page made, and a click beside the view, say nothing");
  await frame.click("#title");
  await expect.poll(() => win.evaluate(() => window.gestures.length)).toBe(1);
  assert.deepEqual(await gestures(), [{ frame: panelFrame }], "a click in the view");
  await win.waitForTimeout(300);
  await win.keyboard.press("a");
  await expect.poll(() => win.evaluate(() => window.gestures.length)).toBe(1);
  assert.deepEqual(await gestures(), [{ frame: panelFrame }], "a key press in the view");
  // The frame's word alone is not taken: only the window's own page may call the app.
  assert.equal(await frame.evaluate(() => typeof window.botkins.onFrameGesture), "undefined");
  console.log("Real input inside a view reaches the app with the view's id; made-up input and input elsewhere do not.");

  // ---- A view the person isn't working in can't act by itself: no text for the message box, no question.
  await win.getByRole("heading", { name: "Today", exact: true }).click();
  const alone = await frame.evaluate(() =>
    Promise.all([commander.sendAnswer("By itself").then(() => "sent", (e) => e.message), commander.openLink("https://example.com/by-itself").then(String, (e) => e.message)]),
  );
  assert.deepEqual(alone, ["Click inside this view first.", "Click inside this view first."]);
  assert.equal((await app.evaluate(() => globalThis.asked ?? [])).length, 0);
  await expect(win.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  console.log("A view that isn't in use can't send an answer or ask to open a page.");

  // ---- The frame follows its page down as well as up.
  const tall = await iframe.evaluate((el) => el.getBoundingClientRect().height);
  await frame.evaluate(() => (document.querySelector(".tall").style.display = "none"));
  await expect.poll(() => iframe.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(tall - 150);
  await frame.evaluate(() => (document.querySelector(".tall").style.display = ""));
  await expect.poll(() => iframe.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(tall - 5);
  console.log("The frame shrinks when its page does, and grows back.");

  // ---- openLink asks first: Open in browser opens the address; Cancel opens nothing, and the view then stays quiet.
  await app.evaluate(() => (globalThis.answer = 0));
  await frame.click("#link");
  await expect.poll(() => tries(frame).then((t) => t.link)).toBe("true");
  let asked = await app.evaluate(() => globalThis.asked);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].detail, "https://example.com/docs");
  assert.match(asked[0].message, /Pip wants to open a web page/);
  assert.deepEqual(await app.evaluate(() => globalThis.opened), ["https://example.com/docs"]);
  await app.evaluate(() => (globalThis.answer = 1));
  await frame.evaluate(() => (window.tries.link = undefined));
  await frame.click("#link");
  await expect.poll(() => tries(frame).then((t) => t.link)).toBe("false");
  assert.equal((await app.evaluate(() => globalThis.asked)).length, 2);
  await frame.evaluate(() => (window.tries.link = undefined));
  await frame.click("#link");
  await expect.poll(() => tries(frame).then((t) => t.link)).toBe("false");
  assert.equal((await app.evaluate(() => globalThis.asked)).length, 2, "after Cancel the view doesn't ask again for a while");
  assert.deepEqual(await app.evaluate(() => globalThis.opened), ["https://example.com/docs"]);
  console.log("openLink asks first; Open in browser opens the page, Cancel opens nothing and the view stays quiet.");

  await shot("panels-html");
  if (shots) {
    await size(760, 560);
    await win.waitForTimeout(300);
    await shot("panels-html-min");
    await size(1190, 830);
  }

  // ---- sendAnswer puts the text in the panel's chat's message box, not sent.
  await frame.click("#answer");
  await expect(win.locator(".chathead").getByRole("heading", { name: "Pip" })).toBeVisible();
  await expect(win.getByRole("combobox", { name: "Message", exact: true })).toHaveValue("Plan the launch for Acme");
  assert.equal((await snap()).chats.find((c) => c.id === "chat-panel").messages.length, 0, "the answer was not sent");
  console.log("sendAnswer from the panel fills Panel chat's message box without sending.");

  // ---- The chat card's page: same frame, inside the card.
  await win.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
  await win.getByRole("button", { name: /Card chat/ }).first().click();
  const card = win.getByRole("region", { name: "Contoso chart" });
  const cardIframe = card.locator("iframe");
  await expect(cardIframe).toHaveAttribute("sandbox", "allow-scripts");
  const cardFrameHandle = await frameOf(cardIframe);
  await expect.poll(() => cardFrameHandle.evaluate(() => document.getElementById("title").textContent)).toBe("Card chart");
  await expect.poll(() => cardIframe.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(280);
  await shot("chat-card-html");
  await win.waitForTimeout(2100);
  await cardFrameHandle.click("#answer");
  await expect(win.getByRole("combobox", { name: "Message", exact: true })).toHaveValue("Plan the launch for Contoso");
  assert.equal((await snap()).chats.find((c) => c.id === "chat-card").messages.length, 2, "the card's answer was not sent");
  if (shots) {
    await size(760, 560);
    await win.waitForTimeout(300);
    await shot("chat-card-html-min");
    await size(1190, 830);
  }
  console.log("A chat card draws its page and its answer goes to that chat's message box.");

  // ---- A page that's gone shows a quiet note, not a broken frame.
  rmSync(join(data, "frames", smallFrame + ".html"));
  await win.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Today", exact: true }).click();
  const note = win.locator(".live-panel", { has: win.getByRole("heading", { name: "Note" }) });
  await expect(note.getByText("This view didn't load.")).toBeVisible({ timeout: 15000 });
  await expect(note.getByRole("button", { name: "Try again" })).toBeVisible();
  console.log("A page that can't load says so, with Try again.");

  assert.deepEqual(hits, [], "the outside server was reached");
  assert.deepEqual(errors, [], "no page errors");
  console.log("panels html smoke: ok" + (shots ? ". Screenshots in " + shots : ""));
} finally {
  await app?.close().catch(() => {});
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
