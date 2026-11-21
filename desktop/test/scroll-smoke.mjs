// Non-live smoke for Scroll to latest message and the usual font. A long chat is seeded, and a
// reply "streams" by sending the window snapshots with more of it each time, so no model runs.
// The button shows only when the end is out of view, glides back on a click, sits above the
// composer however tall it grows, and doesn't pull a person who scrolled up back down while a
// reply streams. With no font picked the app reads in the system's face, code in its mono face,
// and a font saved by an earlier version is kept. Set SCROLL_SHOTS to a folder to save screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-scroll-"));
const shots = process.env.SCROLL_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
seedApp(dir);
// The folder goes when the smoke ends, passed or not.
process.on("exit", () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env, timeout: 300000 });
const long = { timeout: 120000 };

let app = await launch();
await (await skipWelcome(await app.firstWindow())).getByRole("heading", { name: "Home", exact: true }).waitFor(long);
await app.close();

// A chat long enough to scroll, in made-up words.
const file = join(dir, "data", "workspace.json");
const ws = JSON.parse(readFileSync(file, "utf8"));
ws.settings.onboarded = true;
const bot = ws.bots[0];
const chatId = randomUUID(), now = Date.now();
const messages = [], runs = [];
for (let i = 1; i <= 14; i++) {
  const runId = randomUUID();
  messages.push({ role: "user", text: `Question ${i}: what should the garden club plant along the north fence this spring?`, runId });
  messages.push({
    role: "assistant",
    runId,
    text:
      `Answer ${i}. Shade-tolerant plants do well there: ferns, hostas and wild ginger. Water them in the morning, and add a layer of mulch to keep the soil cool.\n\n` +
      (i % 3 === 0 ? "A planting note:\n\n```text\nrow 1: ferns, 40 cm apart\nrow 2: hostas, 60 cm apart\n```\n\nKeep `row 2` clear of the path." : "Mark each row with a stake so the club can find it after the first frost."),
  });
  runs.unshift({ id: runId, chatId, title: `Question ${i}`, time: now - (15 - i) * 60000, status: "Completed", detail: "" });
}
ws.chats.unshift({ id: chatId, botId: bot.id, title: "Garden plan", time: now, established: false, messages });
ws.runs.unshift(...runs);
writeFileSync(file, JSON.stringify(ws));

const errors = [];
let page;
const button = () => page.getByRole("button", { name: "Scroll to latest message", exact: true });
const geometry = () =>
  page.evaluate(() => {
    const el = document.querySelector(".messages");
    return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
  });
const atEnd = async () => (await geometry()).gap < 4;
const theme = (mode) => page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), mode);
async function shot(name) {
  if (!shots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, name + ".png") });
}
async function scrollUp(by = 900) {
  await page.locator(".messages").evaluate((el, by) => el.scrollBy({ top: -by, behavior: "instant" }), by);
  await expect(button()).toBeVisible(long);
}
async function back() {
  await button().click();
  await expect.poll(atEnd, long).toBe(true);
  await expect(button()).toBeHidden(long);
}
// What the main process would send while a reply streams: the snapshot with the reply so far.
async function streaming(text) {
  const snapshot = await page.evaluate(() => window.botkins.snapshot());
  snapshot.streams = { ...snapshot.streams, [chatId]: text };
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send("changed", s), snapshot);
}

app = await launch();
try {
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 830));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor(long);

  // ---- No font picked: the system's face for text, the mono face for code.
  const appearance = (await page.evaluate(() => window.botkins.snapshot())).settings.appearance;
  assert.deepEqual([appearance.font, appearance.fontPicked], ["system", false]);
  await page.locator('html[data-font="system"]').waitFor(long);

  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await expect(page.locator("article.assistant")).toHaveCount(14, long);
  const families = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    text: getComputedStyle(document.querySelector("article.assistant p")).fontFamily,
    code: getComputedStyle(document.querySelector("article.assistant code")).fontFamily,
    block: getComputedStyle(document.querySelector("article.assistant pre code, article.assistant pre")).fontFamily,
  }));
  console.log("Fonts: " + JSON.stringify(families));
  for (const family of [families.body, families.text]) assert.match(family, process.platform === "win32" ? /^"Segoe UI"/ : /^-apple-system/);
  for (const family of [families.code, families.block]) assert.match(family, /^ui-monospace/);

  // ---- At the bottom: no button, and it is out of the tab order.
  await expect.poll(atEnd, long).toBe(true);
  await expect(button()).toBeHidden();
  await expect(page.locator(".to-latest")).toHaveAttribute("tabindex", "-1");
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await page.locator(`html[data-mode="${mode}"]`).waitFor(long);
    await expect.poll(atEnd, long).toBe(true);
    await shot(`1-bottom-${mode}`);
    // Scrolled up: the button, centered above the composer, reachable by Tab.
    await scrollUp();
    await expect(page.locator(".to-latest")).toHaveAttribute("tabindex", "0");
    const place = await page.evaluate(() => {
      const b = document.querySelector(".to-latest").getBoundingClientRect();
      const frame = document.querySelector(".messages-wrap").getBoundingClientRect();
      const composer = document.querySelector(".composewrap").getBoundingClientRect();
      return { center: b.left + b.width / 2, frameCenter: frame.left + frame.width / 2, bottom: b.bottom, composerTop: composer.top };
    });
    assert.ok(Math.abs(place.center - place.frameCenter) < 1.5, "centered: " + JSON.stringify(place));
    assert.ok(place.bottom <= place.composerTop - 6, "above the composer: " + JSON.stringify(place));
    await shot(`2-scrolled-up-${mode}`);
    // A click glides back to the latest message, and the button goes.
    await back();
    await shot(`3-after-click-${mode}`);
  }
  await theme("light");
  await page.locator('html[data-mode="light"]').waitFor(long);

  // ---- From the keyboard: Enter on the button goes to the latest message, and focus moves on to the composer.
  await scrollUp();
  await button().focus();
  await page.keyboard.press("Enter");
  await expect.poll(atEnd, long).toBe(true);
  await expect(button()).toBeHidden(long);
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeFocused();

  // ---- A reply streams. At the bottom the view follows it, and the button stays away.
  let reply = "";
  const words = "Here is the full plan for the north fence, row by row, with when to plant each one. ";
  for (let i = 0; i < 4; i++) {
    reply += words.repeat(6) + "\n\n";
    await streaming(reply);
    await page.waitForTimeout(150);
  }
  await expect(page.locator("article.live")).toContainText("full plan", long);
  await expect.poll(atEnd, long).toBe(true);
  await expect(button()).toBeHidden();
  // Scrolled up while it streams: the view stays where it is, and the button stays.
  await scrollUp(700);
  const before = (await geometry()).top;
  for (let i = 0; i < 6; i++) {
    reply += words.repeat(6) + "\n\n";
    await streaming(reply);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(400);
  assert.equal((await geometry()).top, before, "the view did not move while the reply grew");
  await expect(button()).toBeVisible();
  await shot("4-streaming-scrolled-up-light");
  // The button brings the person back, and from there the view follows again.
  await back();
  reply += words.repeat(6);
  await streaming(reply);
  await page.waitForTimeout(400);
  await expect.poll(atEnd, long).toBe(true);
  await expect(button()).toBeHidden();
  // The reply ends: the snapshot without the stream.
  {
    const snapshot = await page.evaluate(() => window.botkins.snapshot());
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send("changed", s), snapshot);
  }
  await expect(page.locator("article.live")).toHaveCount(0, long);
  console.log("Scroll to latest message: hidden at the bottom, shown scrolled up, back on a click, and no jump while a reply streams.");

  // ---- The composer grows to several lines: the button rises with it and stays clear of it.
  const entry = page.getByRole("combobox", { name: "Message", exact: true });
  const composerTop = () => page.evaluate(() => document.querySelector(".composewrap").getBoundingClientRect().top);
  const shortTop = await composerTop();
  await entry.fill(["Before we plant, three things:", "1. Ask about the soil test.", "2. Check the fence posts.", "3. Order the mulch.", "4. Pick a work day.", "5. Bring gloves."].join("\n"));
  await expect.poll(composerTop, long).toBeLessThan(shortTop - 40);
  await scrollUp();
  const grown = await page.evaluate(() => ({ button: document.querySelector(".to-latest").getBoundingClientRect().bottom, composer: document.querySelector(".composewrap").getBoundingClientRect().top }));
  assert.ok(grown.button <= grown.composer - 6, "above the grown composer: " + JSON.stringify(grown));
  await shot("5-composer-grown-light");
  await back();
  await entry.fill("");

  // ---- Settings › Appearance: San Francisco is the font chosen on a fresh folder.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Appearance", exact: true }).click();
  const fontChoice = settings.getByLabel("Font", { exact: true });
  assert.equal(await fontChoice.inputValue(), "system");
  assert.equal(await fontChoice.locator("option:checked").textContent(), process.platform === "win32" ? "Segoe UI" : "San Francisco");
  await fontChoice.scrollIntoViewIfNeeded();
  await shot("6-settings-font-system-light");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden(long);
  // The glass takes each theme's own tint.
  if (shots)
    for (const [colorTheme, mode] of [["botkins", "dark"], ["tidepool", "light"]]) {
      await page.evaluate((appearance) => window.botkins.setPreferences({ appearance }), { colorTheme, theme: mode });
      await page.locator(`html[data-theme="${colorTheme}"][data-mode="${mode}"]`).waitFor(long);
      await scrollUp();
      await shot(`8-scrolled-up-${colorTheme}-${mode}`);
      await back();
    }
  assert.deepEqual(errors, [], "no errors on the page");
} finally {
  await app.close().catch(() => {});
}

// ---- A font saved by an earlier version (no fontPicked) is the person's choice and is kept.
{
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.settings.appearance = { ...saved.settings.appearance, font: "georgia" };
  delete saved.settings.appearance.fontPicked;
  writeFileSync(file, JSON.stringify(saved));
}
app = await launch();
try {
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 830));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor(long);
  const appearance = (await page.evaluate(() => window.botkins.snapshot())).settings.appearance;
  assert.deepEqual([appearance.font, appearance.fontPicked], ["georgia", true]);
  await page.locator('html[data-font="georgia"]').waitFor(long);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await expect(page.locator("article.assistant")).toHaveCount(14, long);
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector("article.assistant p")).fontFamily), /Georgia/);
  await shot("7-saved-georgia-kept-light");
  assert.deepEqual(errors, [], "no errors on the page");
  console.log("A font saved before is kept; with none, the app reads in the system's face.");
  console.log("scroll smoke: ok." + (shots ? " Screenshots in " + shots : ""));
} finally {
  await app.close().catch(() => {});
}
