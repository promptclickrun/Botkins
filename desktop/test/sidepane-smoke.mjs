// Non-live smoke for the side pane a bot opens beside a chat (docs/SIDE_PANE.md, src/SidePane.tsx).
// No model runs: the chats' panes are set in the main process's own state and the window is sent
// the snapshot, as it would be after a bot's tool call. The person's clicks go through the real
// sidePane() call, which is watched. Phone status is a made-up one, so phone access stays off.
// Set SIDEPANE_SHOTS to a folder to save screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-sidepane-"));
const shots = process.env.SIDEPANE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
seedApp(dir);
process.on("exit", () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => _electron.launch({ args: ["."], env, timeout: 300000 });
const long = { timeout: 120000 };

let app = await launch();
await (await home(app)).getByRole("heading", { name: "Home", exact: true }).waitFor(long);
await app.close();

// ---- The chats, in made-up words, and one stored page for a rich UI panel.
const file = join(dir, "data", "workspace.json");
const ws = JSON.parse(readFileSync(file, "utf8"));
ws.settings.onboarded = true;
const now = Date.now();
const chatOf = (botId, title, extra = {}) => {
  const id = randomUUID();
  const messages = [];
  for (let i = 1; i <= 6; i++) {
    const runId = randomUUID();
    messages.push({ role: "user", text: `Which seeds should the community garden order for bed ${i}?`, runId });
    messages.push({ role: "assistant", runId, text: `For bed ${i}: beans, chard and marigolds. They share water well and the marigolds keep pests away.` });
    ws.runs.unshift({ id: runId, chatId: id, title: `Bed ${i}`, time: now - (7 - i) * 60000, status: "Completed", detail: "" });
  }
  ws.chats.unshift({ id, botId, title, time: now, established: false, messages, ...extra });
  return id;
};
const main = chatOf("pip", "Garden order");
const old = chatOf("scout", "Seed research");
const running = chatOf("patch", "Garden app");
const group = chatOf("pip", "Pip, Scout", { botIds: ["pip", "scout"], members: { pip: { seen: 0, established: false }, scout: { seen: 0, established: false } } });
const frame = randomUUID();
mkdirSync(join(dir, "data", "frames"), { recursive: true });
writeFileSync(
  join(dir, "data", "frames", frame + ".html"),
  `<!doctype html><html><body style="margin:0;padding:16px;font:14px system-ui;color:var(--ink);background:var(--surface);min-height:100vh;box-sizing:border-box">
<h3 style="margin:0 0 8px">Seed budget</h3><p id="note">Beans 12, chard 8, marigolds 5.</p>
<div style="display:flex;gap:6px;align-items:flex-end;height:120px">${[60, 40, 25].map((h) => `<i style="display:block;width:40px;height:${h * 1.6}px;background:var(--accent);border-radius:4px"></i>`).join("")}</div>
</body></html>`,
);
writeFileSync(join(dir, "data", "frames", frame + ".json"), "null");
ws.frames = [{ id: frame, owner: "chat:" + main, botId: "pip", createdAt: now }];
// An old ask, from a turn that ended long ago: seeing the chat must not open the pane.
const oldTable = { id: randomUUID(), kind: "table", title: "Old notes", botId: "scout", createdAt: now - 9e5, updatedAt: now - 9e5, columns: ["Seed", "Days"], rows: [["Kale", "55"]] };
ws.chats.find((c) => c.id === old).pane = { panels: [oldTable], active: oldTable.id, ask: { seq: 4, panelId: oldTable.id, runId: ws.runs.find((r) => r.chatId === old).id, botId: "scout", at: now - 9e5 } };
writeFileSync(file, JSON.stringify(ws));

const table = {
  id: randomUUID(),
  kind: "table",
  title: "Plant list",
  botId: "pip",
  createdAt: now,
  updatedAt: now,
  columns: ["Plant", "Bed", "Spacing", "Sow by", "Water", "Notes about this plant"],
  rows: Array.from({ length: 40 }, (_, i) => [["Beans", "Chard", "Marigold", "Squash"][i % 4], "Bed " + ((i % 6) + 1), 20 + (i % 3) * 10 + " cm", "May " + (i + 1), i % 2 ? "Morning" : "Evening", "Keep the soil moist until the first leaves show, then water twice a week."]),
};
const web = { id: randomUUID(), kind: "web", title: "Example site", botId: "pip", createdAt: now, updatedAt: now, url: "https://example.com/" };
const rich = { id: randomUUID(), kind: "rich_ui", title: "Seed budget", botId: "pip", createdAt: now, updatedAt: now, frame };
const screen = { id: randomUUID(), kind: "screen", title: "Screen", botId: "pip", createdAt: now, updatedAt: now };

const errors = [];
let page;
const turn = randomUUID();
const ask = (seq, panelId, more = {}) => ({ seq, panelId, runId: turn, botId: "pip", at: Date.now(), ...more });
// The chat's pane in the main process's state, sent to the window as after a bot's tool call.
const setPane = (chatId, pane) =>
  app.evaluate((_, { chatId, pane }) => {
    const chat = globalThis.__live().chats.find((c) => c.id === chatId);
    chat.pane = pane;
    globalThis.__push();
  }, { chatId, pane });
const push = () => app.evaluate(() => globalThis.__push());
const calls = () => app.evaluate(() => globalThis.__calls.map((c) => c.filter((x) => x !== undefined && x !== null)));
const clearCalls = () => app.evaluate(() => void (globalThis.__calls = []));
const realPane = (chatId) => app.evaluate((_, id) => JSON.parse(JSON.stringify(globalThis.__live().chats.find((c) => c.id === id).pane ?? null)), chatId);
// Workspace.snapshot() clones the runs array, but (for ordinary runs) keeps each run object. Seed
// through that shared object so sidePane.act() sees the same active turn as the rendered snapshot.
const seedLiveRun = (run) =>
  app.evaluate((_, value) => {
    const live = globalThis.__live();
    const target = live.runs.find((candidate) => candidate.chatId === value.chatId);
    if (!target) throw new Error("The smoke fixture could not find the chat's workspace run.");
    Object.assign(target, value);
  }, run);
const openChat = async (id) => {
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), id);
  await expect(page.locator("article.assistant")).toHaveCount(6, long);
};
const theme = async (mode) => {
  await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), mode);
  await page.locator(`html[data-mode="${mode}"]`).waitFor(long);
};
async function shot(name) {
  if (!shots) return;
  await page.waitForTimeout(700);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, name + ".png"), Buffer.from(png, "base64"));
}
async function bothThemes(name) {
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await shot(name + "-" + mode);
  }
  await theme("light");
}
const pane = () => page.locator("aside.side-pane");
const tab = (name) => page.getByRole("tab", { name: new RegExp("^" + name) });
const toggle = () => page.locator(".chathead-details");
const paneWidth = () => pane().evaluate((el) => Math.round(el.getBoundingClientRect().width));

app = await launch();
try {
  page = await home(app);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor(long);
  // The main process's live state, the person's sidePane() calls watched, and made-up phone status.
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const event = () => ({ senderFrame: { url: win.webContents.getURL() }, sender: win.webContents });
    const snapshot = ipcMain._invokeHandlers.get("snapshot");
    globalThis.__live = () => snapshot(event());
    globalThis.__push = () => win.webContents.send("changed", globalThis.__live());
    const act = ipcMain._invokeHandlers.get("sidePane");
    globalThis.__calls = [];
    ipcMain.removeHandler("sidePane");
    ipcMain.handle("sidePane", (e, ...args) => {
      globalThis.__calls.push(args);
      return act(e, ...args);
    });
    globalThis.__phoneChanges = [];
    globalThis.__opened = [];
    const status = {
      enabled: true,
      listening: true,
      port: 47100,
      name: "Test Computer",
      addresses: [],
      devices: [],
      pairing: null,
      relay: { enabled: false, connected: false },
      nearby: "off",
      screen: { mode: "view", viewers: [], permissions: { system: true, screenRecording: false, accessibility: false } },
    };
    for (const name of ["phoneLink"]) {
      ipcMain.removeHandler(name);
      ipcMain.handle(name, () => status);
    }
    for (const name of ["setPhoneScreen", "requestScreenPermission", "setPhoneLink", "setPhoneRelay"]) {
      ipcMain.removeHandler(name);
      ipcMain.handle(name, (_e, ...args) => (globalThis.__phoneChanges.push([name, ...args]), status));
    }
    ipcMain.removeHandler("showEmojiPanel");
    ipcMain.handle("showEmojiPanel", () => { globalThis.__pickerOpened = true; });
    ipcMain.removeHandler("openLink");
    ipcMain.handle("openLink", (_e, url) => void globalThis.__opened.push(url));
  });

  // ---- Details, as before: the pane is narrow, with the Artifacts tab alongside it.
  await openChat(main);
  await expect(pane()).toBeVisible(long);
  await expect(page.locator(".side-pane .chat-side")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Side pane tabs" })).toHaveCount(1);
  await expect(tab("Artifacts")).toBeVisible();
  assert.equal(await paneWidth(), 272);
  await bothThemes("01-details");

  // ---- The person closes it: the app hears "closed".
  await toggle().click();
  await expect(pane()).toHaveCount(0);
  assert.deepEqual(await calls(), [[main, "closed"]]);
  await clearCalls();

  const message = page.locator("article.assistant").last();
  await message.click({ button: "right" });
  await page.getByRole("menuitem", { name: "React", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "React to message" });
  await expect(picker.getByRole("textbox")).toBeFocused();
  assert.ok(await app.evaluate(() => globalThis.__pickerOpened));
  await picker.getByRole("textbox").fill("👩🏽‍💻");
  await picker.getByRole("button", { name: "React" }).click();
  await expect(message.locator(".message-reactions")).toHaveText("👩🏽‍💻");

  await setPane(main, { panels: [screen], active: null });
  await expect(pane()).toHaveCount(0);
  const screenCard = page.getByRole("button", { name: "Screen", exact: true });
  await screenCard.click();
  await expect(tab("Screen")).toHaveAttribute("aria-selected", "true");
  await screenCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close screen" }).click();
  await expect(pane()).toHaveCount(0);
  await expect(screenCard).toHaveCount(0);
  await clearCalls();

  // ---- A bot shows a table: the pane opens on it, wider, and says who opened it.
  await seedLiveRun({ id: turn, chatId: main, title: "Plan the beds", time: Date.now(), status: "Working", detail: "" });
  await setPane(main, { panels: [table], active: table.id, ask: ask(1, table.id) });
  await expect(pane()).toBeVisible(long);
  await expect(tab("Plant list")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pane-meta")).toContainText("Opened by Pip");
  await expect.poll(paneWidth, long).toBeGreaterThan(400);
  // The table: its cells, a header that stays, and scrolling both ways inside the pane.
  await expect(page.locator(".pane-table th").first()).toHaveText("Plant");
  await expect(page.locator(".pane-table tbody tr")).toHaveCount(40);
  await expect(page.locator(".pane-table tbody tr").nth(1).locator("td").first()).toHaveText("Chard");
  const scroll = await page.locator(".pane-table").evaluate((el) => ({ x: el.scrollWidth > el.clientWidth, y: el.scrollHeight > el.clientHeight, sticky: getComputedStyle(el.querySelector("th")).position }));
  assert.deepEqual(scroll, { x: true, y: true, sticky: "sticky" });
  // The conversation keeps its own column: the composer and Scroll to latest stay beside the pane.
  const layout = await page.evaluate(() => {
    const side = document.querySelector(".side-pane").getBoundingClientRect();
    const compose = document.querySelector(".composewrap").getBoundingClientRect();
    const wrap = document.querySelector(".messages-wrap").getBoundingClientRect();
    const latest = document.querySelector(".to-latest").getBoundingClientRect();
    return { composeRight: compose.right, sideLeft: side.left, wrapCenter: wrap.left + wrap.width / 2, latestCenter: latest.left + latest.width / 2 };
  });
  assert.ok(layout.composeRight <= layout.sideLeft + 1, "the composer stays left of the pane: " + JSON.stringify(layout));
  assert.ok(Math.abs(layout.wrapCenter - layout.latestCenter) < 1.5, "Scroll to latest stays centered over the conversation: " + JSON.stringify(layout));

  // ---- A second panel: a second tab, and the first is still there.
  await setPane(main, { panels: [table, web], active: web.id, ask: ask(2, web.id) });
  await expect(tab("Example site")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Plant list")).toBeVisible();
  await expect(tab("Details")).toBeVisible();
  await expect(tab("Artifacts")).toBeVisible();
  // The website viewer: the app's viewer partition, an https address, nothing that loosens it.
  const viewer = page.locator(".side-pane webview");
  await expect(viewer).toHaveCount(1, long);
  const attributes = await viewer.evaluate((el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])));
  assert.equal(attributes.partition, "side-pane-web");
  assert.equal(attributes.src, "https://example.com/");
  for (const name of ["allowpopups", "preload", "nodeintegration", "nodeintegrationinsubframes", "webpreferences", "disablewebsecurity", "plugins"]) assert.ok(!(name in attributes), "no " + name + " on the viewer");
  await expect(page.getByLabel("Address", { exact: true })).toHaveText("https://example.com/");
  for (const name of ["Back", "Forward", "Reload", "Open in browser"]) await expect(page.getByRole("toolbar", { name: "Website" }).getByRole("button", { name, exact: true })).toBeVisible();
  await page.getByRole("toolbar", { name: "Website" }).getByRole("button", { name: "Open in browser", exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.__opened.at(-1))).toMatch(/^https:\/\/example\.com\//);
  await page.waitForTimeout(3000);
  await bothThemes("03-website");

  // ---- Choosing a tab tells the app; the website stays loaded behind it.
  await tab("Plant list").click();
  await expect(tab("Plant list")).toHaveAttribute("aria-selected", "true");
  await expect.poll(calls).toEqual([[main, "select", table.id]]);
  await expect.poll(async () => (await realPane(main)).active).toBe(table.id);
  await expect(viewer).toHaveCount(1);
  await tab("Details").click();
  await expect.poll(calls).toEqual([[main, "select", table.id], [main, "select"]]);
  await expect.poll(paneWidth, long).toBe(272);
  await tab("Plant list").click();
  await expect.poll(paneWidth, long).toBeGreaterThan(400);
  // How wide the pane is beside a panel, in a smaller and a larger window.
  for (const width of [1280, 1600]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
    await expect.poll(paneWidth, long).toBe(Math.round(Math.min(640, Math.max(360, width * 0.38))));
    await shot("02-table-" + width + "-light");
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await clearCalls();

  // ---- Closing the pane: "closed", and the same seq again doesn't open it.
  await page.getByRole("button", { name: "Close side pane", exact: true }).click();
  await expect(pane()).toHaveCount(0);
  await expect.poll(calls).toEqual([[main, "closed"]]);
  assert.equal((await realPane(main)).closed.runId, turn, "the app knows the person closed it during this turn");
  await push();
  await page.waitForTimeout(800);
  await expect(pane()).toHaveCount(0);

  // ---- A new panel while closed waits as a tab: a dot on the header button, and on its tab.
  await app.evaluate((_, { main, screen }) => {
    const chat = globalThis.__live().chats.find((c) => c.id === main);
    chat.pane.panels.push({ ...screen, unseen: true });
    globalThis.__push();
  }, { main, screen });
  await expect(toggle().locator(".pane-dot")).toBeVisible(long);
  await clearCalls();
  await toggle().click();
  await expect(pane()).toBeVisible();
  await expect.poll(calls).toEqual([[main, "opened"]]);
  await expect(tab("Screen")).toHaveAccessibleName(/, new$/);
  await expect(page.locator(".pane-tab", { has: tab("Screen") }).locator(".pane-dot")).toBeVisible();
  await expect(toggle().locator(".pane-dot")).toHaveCount(0);
  // Pin: the app hears "pin", and the tab shows it.
  await clearCalls();
  await page.getByRole("button", { name: "Pin Plant list", exact: true }).click();
  await expect.poll(calls).toEqual([[main, "pin", table.id]]);
  await expect(page.locator(".pane-tab.pinned", { has: tab("Plant list") })).toBeVisible(long);
  await expect(page.getByRole("button", { name: "Pin Plant list", exact: true })).toHaveAttribute("aria-pressed", "true");
  await bothThemes("04-table-unseen-pinned");
  await page.getByRole("button", { name: "Pin Plant list", exact: true }).click();
  await expect.poll(calls).toEqual([[main, "pin", table.id], [main, "unpin", table.id]]);

  // ---- The Screen panel: the same choice and rows as Settings › Phone, and showing it changes nothing.
  await tab("Screen").click();
  const paneScreen = page.locator(".side-pane .pane-screen");
  await expect(paneScreen.getByRole("radiogroup", { name: "Screen" })).toBeVisible(long);
  await expect(paneScreen.getByRole("radio", { name: "View only" })).toHaveAttribute("aria-checked", "true");
  await expect(paneScreen.getByRole("button", { name: "Grant Screen Recording" })).toBeVisible();
  await expect(paneScreen).toContainText("A bot opened this panel");
  await bothThemes("05-screen");
  const paneRows = await paneScreen.locator(".set-row").evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Phone", exact: true }).click();
  await expect(settings.getByRole("radiogroup", { name: "Screen" })).toBeVisible(long);
  const settingsRows = await settings.locator(".set-row").evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  for (const row of paneRows) assert.ok(settingsRows.includes(row), "Settings › Phone shows the same row: " + row);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden(long);
  assert.deepEqual(await app.evaluate(() => globalThis.__phoneChanges), [], "showing the Screen panel changed no setting");

  // ---- Removing a tab tells the app.
  await clearCalls();
  await page.locator(".pane-tab", { has: tab("Example site") }).hover();
  await page.getByRole("button", { name: "Close tab Example site", exact: true }).click();
  await expect.poll(calls).toEqual([[main, "remove", web.id]]);
  await expect(tab("Example site")).toHaveCount(0, long);
  await expect(page.locator(".side-pane webview")).toHaveCount(0);

  // ---- A higher seq with close: the pane closes, its tabs stay.
  await setPane(main, { ...(await realPane(main)), ask: ask(3, null, { close: true }) });
  await expect(pane()).toHaveCount(0, long);
  assert.equal((await realPane(main)).panels.length, 2);

  // ---- A rich UI: the stored page in the sandboxed frame, filling the pane.
  await setPane(main, { panels: [table, screen, rich], active: rich.id, ask: ask(4, rich.id) });
  await expect(pane()).toBeVisible(long);
  const iframe = page.locator(".side-pane .pane-rich iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts", long);
  await expect(iframe).toHaveAttribute("src", "botkins-app://frame-" + frame + "/");
  await expect(page.locator(".side-pane .html-frame.loading")).toHaveCount(0, long);
  const fill = await page.evaluate(() => ({ frame: document.querySelector(".pane-rich iframe").getBoundingClientRect().height, body: document.querySelector(".pane-bodies").getBoundingClientRect().height }));
  assert.ok(Math.abs(fill.frame - fill.body) < 2, "the page fills the pane: " + JSON.stringify(fill));
  await bothThemes("06-rich-ui");

  // ---- Eight tabs in the pane: the strip scrolls, and the arrow keys move between tabs.
  const eight = Array.from({ length: 8 }, (_, i) => ({ ...table, id: randomUUID(), title: ["Plant list", "Watering", "Seed costs", "Tool shed", "Volunteers", "Harvest log", "Compost", "Bed map"][i], botId: ["pip", "scout", "patch"][i % 3] }));
  await setPane(main, { panels: eight, active: eight[7].id, ask: ask(5, eight[7].id) });
  await expect(tab("Bed map")).toHaveAttribute("aria-selected", "true", long);
  await expect(page.getByRole("tab")).toHaveCount(10);
  const strip = await page.getByRole("tablist", { name: "Side pane tabs" }).evaluate((el) => ({ scrolls: el.scrollWidth > el.clientWidth, inView: (() => { const t = el.querySelector('[aria-selected="true"]').getBoundingClientRect(), s = el.getBoundingClientRect(); return t.right <= s.right + 1 && t.left >= s.left - 1; })() }));
  assert.deepEqual(strip, { scrolls: true, inView: true });
  await clearCalls();
  await tab("Bed map").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tab("Compost")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Compost")).toBeFocused();
  await expect.poll(calls).toEqual([[main, "select", eight[6].id]]);
  await page.keyboard.press("End");
  await expect(tab("Bed map")).toBeFocused();
  await bothThemes("07-eight-tabs");
  if (shots) {
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { colorTheme: "tidepool", theme: "dark" } }));
    await page.locator('html[data-theme="tidepool"][data-mode="dark"]').waitFor(long);
    await shot("07-eight-tabs-tidepool-dark");
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { colorTheme: "ink", theme: "light" } }));
    await page.locator('html[data-mode="light"]').waitFor(long);
  }

  // ---- A first look at a chat with an old ask: the pane stays as the person left it (closed).
  await page.getByRole("button", { name: "Close side pane", exact: true }).click();
  await expect(pane()).toHaveCount(0);
  await openChat(old);
  await page.waitForTimeout(800);
  await expect(pane()).toHaveCount(0);
  // And the first look at a chat whose turn is still asking: it opens.
  const patchTurn = randomUUID();
  await seedLiveRun({ id: patchTurn, chatId: running, title: "Build", time: Date.now(), status: "Working", detail: "" });
  const site = { ...web, id: randomUUID(), botId: "patch", title: "Local preview", url: "http://localhost:5173/" };
  await setPane(running, { panels: [site], active: site.id, ask: { seq: 1, panelId: site.id, runId: patchTurn, botId: "patch", at: Date.now() } });
  await openChat(running);
  await expect(pane()).toBeVisible(long);
  await expect(page.locator(".pane-meta")).toContainText("Opened by Patch");
  await page.getByRole("button", { name: "Close side pane", exact: true }).click();

  // ---- A group chat: its side-pane button is present before bot panels, which follow Artifacts.
  await openChat(group);
  await expect(toggle()).toHaveCount(1);
  await expect(toggle()).toHaveAccessibleName("Side pane");
  await setPane(group, { panels: [{ ...table, botId: "scout" }], active: table.id, ask: { seq: 1, panelId: table.id, runId: turn, botId: "scout", at: Date.now() } });
  await expect(pane()).toBeVisible(long);
  await expect(tab("Details")).toHaveCount(0);
  assert.deepEqual(
    await page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.querySelector(".pane-tab-title")?.textContent)),
    ["Artifacts", "Plant list"],
    "the group pane tab precedes bot panels",
  );
  await expect(page.locator(".pane-meta")).toContainText("Opened by Scout");
  await expect(page.getByRole("button", { name: "Side pane", exact: true })).toBeVisible();
  await shot("08-group-light");

  // ---- A narrow window: a drawer over the conversation, with a scrim and a close button.
  await page.getByRole("button", { name: "Close side pane", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 800));
  await openChat(main);
  await expect(pane()).toHaveCount(0);
  await expect(toggle()).toBeVisible();
  await setPane(main, { panels: [table, screen, rich], active: table.id, ask: ask(6, table.id) });
  await expect(page.locator(".side-pane.drawer")).toBeVisible(long);
  await expect(page.locator(".pane-scrim")).toBeVisible();
  await bothThemes("09-narrow-drawer");
  await page.keyboard.press("Escape");
  await expect(pane()).toBeVisible();
  await tab("Plant list").focus();
  await page.keyboard.press("Escape");
  await expect(pane()).toHaveCount(0);
  await toggle().click();
  await expect(page.locator(".side-pane.drawer")).toBeVisible();
  await page.locator(".pane-scrim").click({ position: { x: 20, y: 300 } });
  await expect(pane()).toHaveCount(0);

  assert.deepEqual(errors, [], "no errors on the page");
  console.log("side pane smoke: ok." + (shots ? " Screenshots in " + shots : ""));
} finally {
  const pid = app.process().pid;
  await app.close().catch(() => {});
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
