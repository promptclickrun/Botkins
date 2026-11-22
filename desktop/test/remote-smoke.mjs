// Using another computer's Botkins from the window, with two copies of the app on data folders of
// their own: B pairs to A from Settings, the switcher and the line across the top, the host's own
// list of devices (type, rename), the host going away and coming back, and the host removing B.
// No model turn is run and nothing leaves this computer. Run it after `npm run build`:
//   node test/remote-smoke.mjs
// REMOTE_SHOTS=<folder> also saves pictures of each step. Set BOTKINS_BINARY to test a packaged app.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { fakeClient } from "./fake-copilot.mjs";
import { openToday } from "./spaces-helper.mjs";
import { Workspace, seedApp } from "./starter.mjs";
import { freePort } from "./free-port.mjs";
import { home } from "./welcome-helper.mjs";

const binary = process.env.BOTKINS_BINARY;
const out = process.env.REMOTE_SHOTS || null;
if (out) mkdirSync(out, { recursive: true });
const PORT = await freePort();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, check, ms = 60000) => { const limit = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > limit) throw new Error("Timed out waiting for " + what); await sleep(300); } };
/** Starts a copy of the app. With `kept`, on a data folder an earlier copy used: the app opened again. */
const launch = async (name, more = {}, kept = null) => {
  const dir = kept ?? mkdtempSync(join(tmpdir(), "botkins-two-" + name + "-"));
  if (!kept) seedApp(dir);
  if (name === "a" && !kept) {
    const ws = new Workspace(join(dir, "data"), fakeClient().client, () => {});
    ws.panels.write("pip", "fixture", { key: "summary", title: "Sales summary", blocks: [
      { type: "html", html: "<p id='summary'></p><script>botkins.getData().then(d => summary.textContent = d.total)</script>", data: { total: "42 sales" } },
    ] });
  }
  const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot", ...more };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
  const page = await home(app);
  await page.setViewportSize({ width: 1180, height: 800 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  const shot = async (file) => {
    if (!out) return;
    await sleep(350);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
    writeFileSync(join(out, file), Buffer.from(png, "base64"));
  };
  return { app, page, dir, errors, shot, pid: app.process().pid, snap: () => page.evaluate(() => window.botkins.snapshot()) };
};
const a = await launch("a", { BOTKINS_LINK_PORT: String(PORT) });
let b = await launch("b");
const settingsPhone = async (w) => {
  await w.page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await w.page.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Phone", exact: true }).click();
};
try {
  // The host is given a name a person would read, so no real computer name is in a picture.
  await a.page.evaluate(() => window.botkins.setPhoneLink(true));
  await a.page.evaluate(() => window.botkins.renamePhoneLinkComputer("Studio Mac"));
  await a.page.evaluate(() => window.botkins.createChat("pip"));
  await a.page.evaluate(() => window.botkins.saveSavedCredential({ name: "Fixture login", kind: "login", value: "fixture-vault-secret" }));
  const url = (await a.page.evaluate(() => window.botkins.startPhonePairing())).pairing.url;
  // B: Settings › Phone › Other computers, paste the link, Pair.
  await settingsPhone(b);
  const dialog = b.page.getByRole("dialog");
  const block = dialog.locator(".set-group", { hasText: "Other computers" });
  await block.waitFor({ timeout: 30000 });
  await block.scrollIntoViewIfNeeded();
  await b.shot("1-b-settings-other-computers-empty.png");
  await block.getByLabel("Pairing link").fill(url);
  await block.getByRole("button", { name: "Pair", exact: true }).click();
  await block.getByText("Paired with", { exact: false }).waitFor({ timeout: 30000 });
  await block.scrollIntoViewIfNeeded();
  await b.shot("2-b-settings-paired.png");
  // A wrong code says so.
  await block.getByLabel("Address of the other computer").fill("127.0.0.1:" + PORT);
  await block.getByLabel("Pairing code").fill("WRONGCODE234");
  await block.getByRole("button", { name: "Pair", exact: true }).click();
  const refusal = await block.getByRole("alert").textContent({ timeout: 30000 });
  assert.match(refusal, /code/i, "a code that isn't right is refused in words");
  await b.page.keyboard.press("Escape");
  // The switcher appears in the side menu once a computer is paired.
  let switcher = b.page.getByRole("button", { name: /^Computer: / });
  await switcher.waitFor({ timeout: 15000 });
  // The side menu's bottom rows stay together: Settings, the switcher, then Models, with all the
  // free space above them. (The switcher once claimed that space too, which left Settings alone in
  // the middle of the menu with a gap on each side.) Checked with the menu open and narrow.
  for (const collapsed of [false, true]) {
    await b.page.evaluate(async (narrow) => window.botkins.setPreferences({ sidebar: { ...(await window.botkins.snapshot()).settings.sidebar, collapsed: narrow } }), collapsed);
    await b.page.waitForFunction((narrow) => document.querySelector(".shell")?.classList.contains("collapsed") === narrow, collapsed);
    const rows = await b.page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const [foot, host, models, menu] = [box(".sidebar-foot"), box(".host-switch"), box(".models-status"), box(".sidebar-foot").top && document.querySelector(".sidebar-foot").parentElement.getBoundingClientRect()];
      return { settingsToSwitcher: Math.round(host.top - foot.bottom), switcherToModels: Math.round(models.top - host.bottom), modelsToEnd: Math.round(menu.bottom - models.bottom) };
    });
    for (const [name, gap] of Object.entries(rows)) assert.ok(gap >= 0 && gap <= 16, "the bottom rows of the side menu sit together (" + (collapsed ? "narrow" : "open") + "): " + JSON.stringify(rows) + ", " + name);
    await b.shot("3a-b-side-menu-" + (collapsed ? "narrow" : "open") + ".png");
  }
  assert.equal(await switcher.getAttribute("aria-label"), "Computer: This computer. Switch computer");
  await switcher.click();
  await b.page.getByRole("menu", { name: "Computers" }).waitFor();
  await b.shot("3-b-switcher-menu.png");
  await b.page.getByRole("menuitemradio", { name: /Studio Mac/ }).click();
  let banner = b.page.getByRole("status", { name: "Computer in use" });
  await banner.getByText("Connected", { exact: false }).waitFor({ timeout: 60000 });
  await until("A's chat to be listed on B", async () => (await b.snap()).chats.length === 1);
  assert.match((await banner.textContent()).replace(/\s+/g, " "), /Using Studio Mac · Connected/);
  assert.equal(await switcher.getAttribute("aria-label"), "Computer: Studio Mac. Connected. Switch computer");
  assert.deepEqual((await b.snap()).bots.map((bot) => bot.id), (await a.snap()).bots.map((bot) => bot.id), "the window shows the host's bots");
  const choices = await b.page.evaluate(() => window.botkins.savedCredentials());
  assert.deepEqual(choices.entries.map(entry => entry.name), ["Fixture login"]);
  assert.ok(!JSON.stringify(choices).includes("fixture-vault-secret"));
  await b.shot("4-b-using-studio-mac.png");
  for (const computer of [a, b]) {
    await openToday(computer.page);
    await computer.page.frameLocator(".space-page iframe").getByText("42 sales").waitFor({ timeout: 8000 }).catch(error => {
      throw new Error((computer === a ? "Local" : "Paired") + " Space panel did not render: " + error.message);
    });
    await computer.page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home", exact: true }).click();
  }
  // The app is closed and opened again on the same folder: it is back on Studio Mac by itself,
  // with nothing chosen anew and no pairing step.
  const folder = b.dir;
  await b.app.close();
  b = await launch("b", {}, folder);
  switcher = b.page.getByRole("button", { name: /^Computer: / });
  banner = b.page.getByRole("status", { name: "Computer in use" });
  await banner.getByText("Connected", { exact: false }).waitFor({ timeout: 60000 });
  assert.match((await banner.textContent()).replace(/\s+/g, " "), /Using Studio Mac · Connected/, "the app opened again is on the computer it was on");
  await until("Studio Mac's chat to be listed again", async () => (await b.snap()).chats.length === 1);
  assert.equal((await b.snap()).remote.hosts.length, 1, "and the pairing is still there");
  await b.shot("4b-b-opened-again-still-on-studio-mac.png");
  // Dark, with the menu open.
  await b.page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "dark" } }));
  await switcher.click();
  await b.shot("5-b-using-dark-menu.png");
  await b.page.keyboard.press("Escape");
  assert.equal((await b.snap()).settings.appearance.theme, "dark", "the window's look is its own");
  assert.notEqual((await a.snap()).settings.appearance.theme, "dark", "and the host's is untouched");
  await b.page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
  // The host's own list: this computer as a device, with its type, person name and remove control.
  await settingsPhone(a);
  const devices = a.page.getByRole("dialog").locator(".set-group", { hasText: "Devices" });
  await devices.waitFor({ timeout: 30000 });
  assert.match(await devices.textContent(), /Computer · /, "this computer is listed by its type");
  await devices.getByRole("button", { name: /^Add name for / }).click();
  await devices.getByRole("textbox").fill("River");
  await devices.getByRole("button", { name: "Save", exact: true }).click();
  await devices.getByText("River").waitFor({ timeout: 15000 });
  await devices.scrollIntoViewIfNeeded();
  await a.shot("6-a-devices-list.png");
  assert.ok(!/this phone/.test(await devices.textContent()), "a computer's row says nothing about a phone");
  // Settings › Phone on B while A is in use: A's devices are managed on A.
  await settingsPhone(b);
  await b.page.getByRole("dialog").getByText("managed on Studio Mac itself", { exact: false }).waitFor({ timeout: 15000 });
  await b.shot("7-b-settings-phone-while-using.png");
  await b.page.keyboard.press("Escape");
  // The host goes away: B says so and keeps what it had.
  await a.page.evaluate(() => window.botkins.setPhoneLink(false));
  await banner.getByText("can't be reached", { exact: false }).waitFor({ timeout: 120000 });
  await b.shot("8-b-offline.png");
  assert.equal((await b.snap()).bots.length > 0, true, "what was known is still shown");
  await a.page.evaluate(() => window.botkins.setPhoneLink(true));
  await banner.getByText("Connected", { exact: false }).waitFor({ timeout: 120000 });
  // The host removes this computer.
  const mine = (await a.page.evaluate(() => window.botkins.phoneLink())).devices.find((d) => d.kind === "desktop");
  await a.page.evaluate((id) => window.botkins.removePhone(id), mine.id);
  await banner.getByText("no longer knows this computer", { exact: false }).waitFor({ timeout: 120000 });
  await b.shot("9-b-revoked.png");
  await banner.getByRole("button", { name: "Use this computer", exact: true }).click();
  await banner.waitFor({ state: "detached", timeout: 15000 });
  assert.deepEqual([(await b.snap()).remote.using, (await b.snap()).chats.length], [null, 0], "back on its own workspace");
  assert.deepEqual([a.errors, b.errors], [[], []], "no page errors");
  console.log("Remote smoke: B paired to A from Settings, used it through the switcher, came back on it after being closed and opened, kept its own look, saw A go away and come back, and was removed by A.");
} catch (error) {
  await b.shot("failed-b.png").catch(() => {});
  await a.shot("failed-a.png").catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally { for (const each of [a, b]) { await each.app.close().catch(() => {}); try { process.kill(each.pid, 0); process.kill(each.pid); } catch {} rmSync(each.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } }
