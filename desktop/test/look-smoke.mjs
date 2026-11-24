// The look smoke: a tour of the app in an isolated data folder with a seeded team and chats. No model runs.
// Checks the brand (the name, the bundled fonts, the Botkin avatars, the theme's colors on the page)
// and walks the main places. Set LOOK_SHOTS to a folder to save a screenshot of each place in light
// and dark, at 1190×830 and at the smallest window, 760×560. LOOK_THEME picks a theme for the tour,
// LOOK_TEXT a text size, and LOOK_ONLY=chat,settings-phone keeps only those stops' screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";
import { openToday } from "./spaces-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-look-"));
const shots = process.env.LOOK_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const binary = process.env.BOTKINS_BINARY;

const now = Date.now();
const MIN = 60_000;
const team = [
  ["chief", "Chief of Staff", "Runs the week", "sprig"],
  ["ea", "EA", "Calendar and travel", "luna"],
  ["inbox", "Inbox Manager", "Keeps the inbox at zero", "pearl"],
  ["sales", "Sales Outbound", "Drafts outreach", "pounce"],
  ["talent", "Talent Scout", "Finds candidates", "fathom"],
  ["growth", "Growth Marketer", "Tests copy and channels", "posy"],
  ["support", "Support", "Answers tickets", "pip"],
  ["expense", "Expense Manager", "Codes receipts", "spool"],
];
const bots = team.map(([id, name, role, head]) => ({ id, name, role, instructions: "You are the team's " + name + ". " + role + ".", face: "idle", look: { head, palette: "original" } }));
const said = [
  "Got it! Product updates shared and linked in the shared channel.",
  "Responded in 3 threads, with two holds on Thursday.",
  "Inbox at zero. 2 replies ready.",
  "Outreach drafts queued for approval.",
  "Shortlist of 6 candidates ready.",
  "A/B copy variants ready to review.",
  "12 tickets resolved, 2 escalated.",
  "Receipts coded. One needs a look.",
];
const chats = bots.map((bot, i) => ({
  id: "chat-" + bot.id,
  botId: bot.id,
  title: ["Brightside Health", "This week", "Morning sweep", "Q4 outreach", "Design lead search", "Landing page test", "Ticket queue", "October receipts"][i],
  time: now - i * 47 * MIN,
  established: false,
  ...(i === 4 && { unread: true }),
  messages:
    i === 0
      ? [
          { role: "user", text: "Hey, what's the latest update we have on Brightside Health?" },
          { role: "assistant", text: "From last meeting's call notes, they need to see support for Slack integration and SSO before they proceed with a pilot.\n\nPG plan and Brightside Health's account notes in CRM are up to date with the latest." },
          { role: "user", text: "Perfect, those shipped last week, post an update to let them know" },
          { role: "assistant", text: said[0] + "\n\n| Item | Status |\n|---|---|\n| Slack integration | Shipped |\n| SSO | Shipped |\n\n- [x] Update posted\n- [ ] Pilot kickoff scheduled" },
        ]
      : [
          { role: "user", text: "Where are we on this?" },
          { role: "assistant", text: said[i] },
        ],
}));
mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(join(dir, "data", "workspace.json"), JSON.stringify({ bots, chats, runs: [] }));

const errors = [];
// LOOK_ONLY=chat,settings-phone keeps only those stops of the tour.
const only = (process.env.LOOK_ONLY ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const wanted = (name) => !only.length || only.includes(name);
let app, page;
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const prefs = (patch) => page.evaluate((patch) => window.botkins.setPreferences(patch), patch);
async function shot(name) {
  if (!shots) return;
  for (const [w, h, suffix] of [[1190, 830, ""], [760, 560, "-min"]]) {
    await size(w, h);
    for (const mode of ["light", "dark"]) {
      await prefs({ appearance: { theme: mode } });
      await page.locator(`html[data-mode="${mode}"]`).waitFor();
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(shots, name + suffix + "-" + mode + ".png") });
    }
  }
  await prefs({ appearance: { theme: "light" } });
  await size(1190, 830);
}

try {
  app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await signedInAs(app);
  await page.reload();
  page = await skipWelcome(page);
  await page.getByRole("navigation", { name: "Workspace" }).waitFor();
  await size(1190, 830);
  // ---- Until a person picks a theme the app wears Ink, and until they pick a font, the system's own face.
  const { themes, default: usualTheme, fonts: fontList } = JSON.parse(readFileSync(new URL("../desktop/themes.json", import.meta.url), "utf8"));
  assert.equal(usualTheme, "ink");
  const first = (await page.evaluate(() => window.botkins.snapshot())).settings.appearance;
  assert.deepEqual([first.colorTheme, first.themePicked, first.font, first.fontPicked], ["ink", false, "system", false]);
  await page.locator('html[data-theme="ink"][data-font="system"]').waitFor();
  await prefs({ appearance: { theme: "light" } });
  await page.locator('html[data-mode="light"]').waitFor();
  const inkLight = themes.find((t) => t.id === "ink").light;
  assert.deepEqual(
    await page.evaluate(() => ["--canvas", "--ink", "--accent", "--accent-text"].map((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toUpperCase())),
    [inkLight.canvas, inkLight.ink, inkLight.accent, inkLight.accentText],
  );
  const lookTheme = process.env.LOOK_THEME ?? usualTheme;
  if (process.env.LOOK_THEME) await prefs({ appearance: { colorTheme: process.env.LOOK_THEME } });
  // LOOK_TEXT=larger takes the tour at another text size.
  if (process.env.LOOK_TEXT) await prefs({ appearance: { textSize: process.env.LOOK_TEXT } });

  // ---- The brand: the name, the fonts that ship with the app, and the theme on the page.
  assert.equal(await page.title(), "Botkins");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), "Botkins");
  assert.equal(await app.evaluate(({ app }) => app.getName()), "Botkins");
  await page.evaluate(() => Promise.all(['700 20px "DejaVu Serif"', '400 15px "Open Sans"', '600 15px "Open Sans"', '700 15px "Open Sans"'].map((font) => document.fonts.load(font))));
  const fonts = await page.evaluate(() => ({
    serif: document.fonts.check('700 20px "DejaVu Serif"'),
    sans: document.fonts.check('400 15px "Open Sans"') && document.fonts.check('600 15px "Open Sans"'),
    body: getComputedStyle(document.body).fontFamily,
    loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")),
  }));
  assert.ok(fonts.serif && fonts.sans, "the bundled fonts are available");
  // Until a font is picked, text is in the system's face; the kit's own faces are there for the Botkins pairing.
  assert.match(fonts.body, process.platform === "win32" ? /^"Segoe UI"/ : /^-apple-system/);
  assert.ok(fonts.loaded.includes("Open Sans"), "Open Sans is loaded from the app's own files");
  await page.locator('html[data-mode="light"][data-theme="' + lookTheme + '"]').waitFor();
  const theme = themes.find((t) => t.id === lookTheme);
  const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim());
  assert.equal(canvas.toUpperCase(), theme.light.canvas, "the theme's canvas is on the page");

  // ---- Bots are Botkins: every avatar is the kit's picture, and nothing network-bound loads.
  const avatars = page.locator(".bot-avatar");
  await avatars.first().waitFor();
  const drawn = await avatars.locator("img").evaluateAll((imgs) => imgs.map((img) => ({ src: img.src.slice(0, 5), ok: img.complete && img.naturalWidth > 0 })));
  assert.ok(drawn.length >= bots.length, "each bot shows an avatar");
  assert.ok(drawn.every((a) => a.src === "blob:" && a.ok), "avatars are drawn from the kit, in the page");
  assert.equal(await page.locator(".avatar, svg.ba-body, .ba-pose").count(), 0, "no Lottie face or silhouette is left");
  // The kit draws every character in a 256-unit box.
  assert.deepEqual(await avatars.first().evaluate((avatar) => {
    const img = avatar.querySelector("img");
    return [img.naturalWidth, img.naturalHeight, avatar.dataset.state];
  }), [256, 256, "idle"]);
  if (wanted("home")) await shot("home");

  // ---- A tour of the places, for screenshots.
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const place = async (name) => {
    await nav.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(250);
  };
  const escape = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  };
  const event = (name, detail) => page.evaluate(([name, detail]) => window.dispatchEvent(new CustomEvent(name, { detail })), [name, detail]);
  // A few routines, tasks and a project, so those places have something to show. Nothing here runs a model.
  const later = new Date(Date.now() + 6 * 3600_000);
  const at = String(later.getHours()).padStart(2, "0") + ":00";
  await page.evaluate(async (at) => {
    const api = window.botkins;
    await api.createRoutine({ botId: "chief", name: "Morning briefing", prompt: "Summarize what changed overnight.", cadence: { kind: "daily", time: at } });
    await api.createRoutine({ botId: "chief", name: "Inbox cleanup", prompt: "File what is done.", cadence: { kind: "weekdays", time: at } });
    const paused = await api.createRoutine({ botId: "chief", name: "Weekly team update", prompt: "Draft the weekly update.", cadence: { kind: "weekly", time: at, days: [1] } });
    await api.setRoutineEnabled(paused, false);
    await api.saveTask({ title: "Draft the Q4 plan", body: "One page.", botId: "chief", status: "later" });
    await api.saveTask({ title: "Shortlist three vendors", botId: "talent", status: "later" });
    await api.createProject({ name: "Brightside Health", description: "Pilot rollout" });
  }, at);
  const stops = {
    chats: async () => {
      await place("Chats");
      await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
    },
    chat: async () => {
      await place("Chats");
      await page.getByText("Brightside Health", { exact: true }).first().click();
      await page.getByText("Slack integration and SSO").waitFor();
    },
    "bot-page": async () => {
      await event("botkins-open-bot", "chief");
      await page.locator(".bot-profile").waitFor();
    },
    "bot-studio": async () => {
      await event("botkins-open-bot", "chief");
      await page.locator(".bot-profile").getByRole("button", { name: "Bot Studio", exact: true }).click();
      await page.getByRole("dialog", { name: "Bot Studio" }).waitFor();
      // The current characters, the seven palettes and eight color templates, and six kinds of eyes.
      const studio = page.getByRole("dialog", { name: "Bot Studio" });
      assert.equal(await studio.getByRole("radiogroup", { name: "Character" }).getByRole("radio").count(), 23);
      assert.equal(await studio.getByRole("radiogroup", { name: "Palette" }).getByRole("radio").count(), 15);
      assert.equal(await studio.getByRole("radiogroup", { name: "Eyes" }).getByRole("radio").count(), 6);
    },
    "new-chat": async () => {
      await place("Home");
      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
      await page.getByRole("heading", { name: "New chat" }).waitFor();
    },
    "create-bot": async () => {
      await place("Home");
      await page.getByRole("button", { name: "Create bot", exact: true }).click();
      await page.getByRole("dialog", { name: "Create a bot" }).waitFor();
    },
    today: async () => {
      await openToday(page);
      await page.waitForTimeout(250);
    },
    // Work's three tabs, and Activity, which opens from its top.
    work: async () => {
      await place("Work");
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await page.waitForTimeout(300);
    },
    routines: async () => {
      await place("Work");
      await page.getByRole("tab", { name: "Routines", exact: true }).click();
      await page.waitForTimeout(300);
    },
    tasks: async () => {
      await place("Work");
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.waitForTimeout(300);
    },
    projects: async () => {
      await place("Work");
      await page.getByRole("tab", { name: "Projects", exact: true }).click();
      await page.waitForTimeout(300);
    },
    wiki: async () => {
      await place("Wiki");
      await page.waitForTimeout(500);
    },
    ...Object.fromEntries(
      ["General", "Appearance", "Side menu", "Chat", "Notifications", "Bots & capabilities", "Skills", "MCP servers", "Credentials", "Teamwork", "Access", "Phone", "Usage", "Storage", "Model providers", "About"].map((tab) => [
        "settings-" + tab.toLowerCase().replace(/[^a-z]+/g, "-"),
        async () => {
          await event("botkins-open-settings", tab === "Model providers" ? "Account" : tab === "Bots & capabilities" ? "Bot" : tab);
          const settings = page.getByRole("dialog", { name: "Settings" });
          await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: tab, exact: true }).click();
          await page.waitForTimeout(350);
        },
      ]),
    ),
  };
  for (const [name, go] of Object.entries(stops)) {
    if (!wanted(name)) continue;
    await go();
    await shot(name);
    // Dialogs close before the next stop.
    for (let i = 0; i < 2 && (await page.locator("dialog[open]").count()); i++) await escape();
  }
  // ---- Settings › Phone: away from home, and what a paired phone may do with this screen.
  // The link is not switched on here (that would open a port, and a socket to the relay): the page
  // is shown a made-up status, and what it asks for is recorded.
  await app.evaluate(({ ipcMain }) => {
    const t = (globalThis.__phone = { enabled: true, mode: "control", relay: { enabled: false, connected: false }, pairing: false, asked: [], allowed: { screenRecording: true, accessibility: false }, nearby: "blocked" });
    const status = () => ({
      enabled: t.enabled, listening: t.enabled, port: 47610, name: "Studio Mac",
      addresses: t.enabled ? [{ address: "192.168.1.20", kind: "lan", interface: "en0" }] : [],
      pairing: t.pairing ? { code: "ABCD2345EFGH", expiresAt: Date.now() + 280000, url: "botkins://pair", qr: { size: 21, d: "M1 1h7v1h-7z" } } : null,
      devices: [{ id: "d1", name: "Sam's iPhone", platform: "ios", createdAt: Date.now(), lastSeenAt: Date.now(), connected: true }],
      relay: { ...t.relay },
      nearby: t.enabled ? t.nearby : "off",
      screen: { mode: t.mode, viewers: t.mode !== "off" ? [{ deviceId: "d1", name: "Sam's iPhone", since: Date.now() }] : [], permissions: { system: true, ...t.allowed } },
    });
    for (const name of ["phoneLink", "setPhoneLink", "setPhoneScreen", "setPhoneRelay", "resetPhoneRelay", "startPhonePairing", "cancelPhonePairing", "requestScreenPermission", "allowLocalNetwork"]) ipcMain.removeHandler(name);
    // Grant for the local network: recorded, and the made-up system then announces the computer.
    ipcMain.handle("allowLocalNetwork", () => (t.asked.push(["grant", "localNetwork"]), (t.nearby = "on"), status()));
    // Grant: what was asked for is recorded, and the made-up system allows it at once.
    ipcMain.handle("requestScreenPermission", (_e, kind) => (t.asked.push(["grant", kind]), (t.allowed = { ...t.allowed, [kind]: true }), status()));
    ipcMain.handle("phoneLink", () => status());
    ipcMain.handle("setPhoneLink", (_e, on) => ((t.enabled = on), status()));
    ipcMain.handle("startPhonePairing", () => ((t.pairing = true), status()));
    ipcMain.handle("cancelPhonePairing", () => void (t.pairing = false));
    ipcMain.handle("setPhoneScreen", (_e, mode) => (t.asked.push(["screen", mode]), (t.mode = mode), status()));
    ipcMain.handle("setPhoneRelay", (_e, on) => (t.asked.push(["away", on]), (t.relay = { enabled: on, connected: false }), status()));
    ipcMain.handle("resetPhoneRelay", () => (t.asked.push(["reset"]), (t.relay = { enabled: true, connected: true }), status()));
  });
  const phone = page.getByRole("dialog", { name: "Settings" });
  /** Opens Settings › Phone afresh, so the page asks for the status as it now is. */
  const openPhone = async (change) => {
    if (change) await app.evaluate((_electron, change) => Object.assign(globalThis.__phone, change), change);
    for (let i = 0; i < 2 && (await page.locator("dialog[open]").count()); i++) await escape();
    await event("botkins-open-settings", "Phone");
    await phone.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Phone", exact: true }).click();
    await phone.getByRole("switch", { name: "Let a phone connect" }).waitFor();
  };
  const away = phone.getByRole("switch", { name: "Use away from home" });
  const awayLine = "Your phone reaches this computer through the Botkins relay when it is not on your network. Messages stay sealed between the two.";

  // Phone access off: the switch is there, off, and can't be used.
  await openPhone({ enabled: false });
  await expect(away).toBeDisabled();
  await expect(away).not.toBeChecked();
  await phone.getByText(awayLine, { exact: true }).waitFor();
  await expect(phone.getByRole("radiogroup", { name: "Screen" })).toHaveCount(0);
  if (wanted("settings-phone-away-access-off")) await shot("settings-phone-away-access-off");

  // Phone access on, away from home off: nothing more is said, and pairing says the phone has to be near.
  await openPhone({ enabled: true });
  // macOS has not let Botkins use the local network yet: the page says what that is for, and Grant opens the way.
  const network = phone.getByRole("button", { name: "Grant Local Network", exact: true });
  await network.waitFor();
  await phone.getByText("Lets your phone find this computer by its name.", { exact: false }).waitFor();
  if (wanted("settings-phone-away-off")) await shot("settings-phone-local-network");
  await network.click();
  await phone.getByRole("status", { name: "Local Network is allowed" }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.__phone.asked.splice(0)), [["grant", "localNetwork"]]);
  await expect(away).toBeEnabled();
  await expect(phone.getByText("Connecting…")).toHaveCount(0);
  await expect(phone.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  await phone.getByRole("button", { name: "Pair a phone", exact: true }).click();
  await phone.getByText("Your phone has to be on this network to pair.", { exact: false }).waitFor();
  // Three ways, easiest first: the camera, this computer found by its name, and its address with the port.
  const ways = phone.getByRole("list", { name: "Ways to pair" }).getByRole("listitem");
  assert.deepEqual(await ways.allTextContents(), [
    "Scan the code with your phone's camera.",
    "Or choose Studio Mac in Botkins on your phone and type the code.",
    "Or type the code with this address: 192.168.1.20:47610",
  ]);
  if (wanted("settings-phone-away-off")) await shot("settings-phone-away-off");
  await phone.getByRole("button", { name: "Cancel", exact: true }).click();

  // Turned on: connecting, then on. The word "relay" is in the detail line only, never in a title or a button.
  // The switch follows the app's answer, so the click is what is checked, then what the page says.
  await away.click();
  await phone.getByText("Connecting…", { exact: true }).waitFor();
  await expect(away).toBeChecked();
  assert.deepEqual(await app.evaluate(() => globalThis.__phone.asked), [["away", true]]);
  if (wanted("settings-phone-away-connecting")) await shot("settings-phone-away-connecting");
  await openPhone({ relay: { enabled: true, connected: true }, pairing: true });
  await phone.getByText("On", { exact: true }).waitFor();
  await expect(phone.getByText("Your phone has to be on this network to pair.", { exact: false })).toHaveCount(0);
  assert.deepEqual((await phone.getByRole("button").allTextContents()).filter((text) => /relay/i.test(text)), []);
  assert.deepEqual((await phone.getByRole("heading").allTextContents()).filter((text) => /relay/i.test(text)), []);
  await openPhone({ pairing: false });
  await phone.getByText("On", { exact: true }).waitFor();
  if (wanted("settings-phone-away-on")) await shot("settings-phone-away-on");

  // Reset is one quiet step away while it is on, and asks first.
  await phone.getByRole("button", { name: "Reset…", exact: true }).click();
  const question = page.getByRole("dialog", { name: "Reset away from home?" });
  await question.getByText("Phones that are away will need to come home once to find this computer again.", { exact: true }).waitFor();
  if (wanted("settings-phone-away-reset")) await shot("settings-phone-away-reset");
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toHaveCount(0);
  assert.equal((await app.evaluate(() => globalThis.__phone.asked)).filter(([what]) => what === "reset").length, 0, "Cancel resets nothing");

  // Another computer has this computer's place: the page says so, and Reset is in plain view.
  await openPhone({ relay: { enabled: true, connected: false, problem: "taken" } });
  const taken = phone.getByRole("alert").filter({ hasText: "Another computer is using this computer's place. Botkins keeps trying; Reset takes it back now." });
  await taken.waitFor();
  await expect(phone.getByText("Connecting…")).toHaveCount(0);
  if (wanted("settings-phone-away-taken")) await shot("settings-phone-away-taken");
  await taken.getByRole("button", { name: "Reset", exact: true }).click();
  await question.getByRole("button", { name: "Reset", exact: true }).click();
  await phone.getByText("On", { exact: true }).waitFor();
  await expect(taken).toHaveCount(0);
  assert.equal((await app.evaluate(() => globalThis.__phone.asked)).filter(([what]) => what === "reset").length, 1);
  // Off again says nothing.
  await away.click();
  await expect(away).not.toBeChecked();
  await expect(phone.getByText("On", { exact: true })).toHaveCount(0);
  await expect(phone.getByRole("button", { name: /^Reset/ })).toHaveCount(0);

  // The screen: the choice, what macOS still has to allow, and who is watching.
  const screenChoice = phone.getByRole("radiogroup", { name: "Screen" });
  assert.deepEqual(await screenChoice.getByRole("radio").allTextContents(), ["Off", "View only", "View and control"]);
  assert.equal(await screenChoice.getByRole("radio", { name: "View and control" }).getAttribute("aria-checked"), "true");
  await phone.getByText("A paired phone can watch this screen, and click and type.").waitFor();
  // What macOS has to allow: Screen Recording is allowed and says so; Accessibility has a Grant button.
  await phone.getByRole("status", { name: "Screen Recording is allowed" }).waitFor();
  const grant = phone.getByRole("button", { name: "Grant Accessibility", exact: true });
  await grant.waitFor();
  assert.equal(await phone.getByRole("button", { name: "Grant Screen Recording" }).count(), 0, "an allowed permission offers nothing to grant");
  await phone.getByText("Sam's iPhone is viewing this screen").waitFor();
  if (wanted("settings-phone-screen")) await shot("settings-phone-screen");
  // Grant asks the system for that one permission, and the page then says it is allowed.
  await grant.click();
  await phone.getByRole("status", { name: "Accessibility is allowed" }).waitFor();
  await expect(grant).toHaveCount(0);
  assert.deepEqual((await app.evaluate(() => globalThis.__phone.asked)).filter(([what]) => what === "grant"), [["grant", "accessibility"]]);
  if (wanted("settings-phone-screen")) await shot("settings-phone-screen-allowed");
  await phone.getByRole("button", { name: "Stop", exact: true }).click();
  await phone.getByText("A paired phone can't see this screen.").waitFor();
  assert.equal(await phone.getByText("is viewing this screen").count(), 0);
  await screenChoice.getByRole("radio", { name: "View only" }).click();
  await phone.getByText("A paired phone can watch this screen.", { exact: true }).waitFor();
  assert.deepEqual((await app.evaluate(() => globalThis.__phone.asked)).filter(([what]) => what === "screen"), [["screen", "off"], ["screen", "view"]]);
  await escape();

  // ---- Settings › Appearance: themes, light and dark, text size.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Appearance", exact: true }).click();
  await settings.getByRole("heading", { name: "Appearance", level: 2 }).waitFor();
  if (wanted("appearance")) await shot("appearance");
  const group = settings.getByRole("radiogroup", { name: "Theme" });
  assert.deepEqual(await group.getByRole("radio").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))), themes.map((t) => t.name));
  await group.getByRole("radio", { name: "Tidepool" }).click();
  await page.locator('html[data-theme="tidepool"]').waitFor();
  const tide = themes.find((t) => t.id === "tidepool");
  assert.equal((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toUpperCase(), tide.light.accent);
  await settings.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Larger" }).click();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim() === "1.2");
  const snapshot = await page.evaluate(() => window.botkins.snapshot());
  assert.equal(snapshot.settings.appearance.colorTheme, "tidepool");
  assert.equal(snapshot.settings.appearance.textSize, "larger");
  if (wanted("appearance-tidepool-larger")) await shot("appearance-tidepool-larger");
  await prefs({ appearance: { colorTheme: lookTheme, textSize: process.env.LOOK_TEXT ?? "default" } });
  await page.locator('html[data-theme="' + lookTheme + '"]').waitFor();

  // ---- Fonts: the kit's pairing, the faces this computer has, and Lora, which ships with the app. The system's face is the usual one.
  const fontChoice = settings.getByLabel("Font", { exact: true });
  const here = process.platform === "win32" ? fontList.filter((f) => f.id === "botkins" || f.windows).map((f) => f.windowsName ?? f.name) : fontList.filter((f) => f.id === "botkins" || f.mac).map((f) => f.name);
  assert.deepEqual(await fontChoice.locator("option").allTextContents(), here);
  assert.equal(await fontChoice.inputValue(), "system");
  const families = () => page.evaluate(() => [getComputedStyle(document.body).fontFamily, getComputedStyle(document.querySelector("dialog[open] h2")).fontFamily]);
  for (const family of await families()) assert.match(family, process.platform === "win32" ? /^"Segoe UI"/ : /^-apple-system/);
  await fontChoice.selectOption("lora");
  await page.locator('html[data-font="lora"]').waitFor();
  // One face for everything, headlines too, drawn from the app's own files.
  for (const family of await families()) assert.match(family, /^"?Lora/);
  await page.evaluate(() => Promise.all(['400 15px "Lora"', '600 15px "Lora"', '700 20px "Lora"'].map((font) => document.fonts.load(font))));
  assert.ok(await page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Lora" && f.status === "loaded")), "Lora is loaded from the app's own files");
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).settings.appearance.font, "lora");
  if (wanted("appearance-lora")) await shot("appearance-lora");
  await fontChoice.selectOption("georgia");
  await page.locator('html[data-font="georgia"]').waitFor();
  assert.match((await families())[0], /Georgia/);
  if (wanted("appearance-georgia")) await shot("appearance-georgia");
  // The kit's pairing can still be picked: serif headlines, sans for the rest.
  await fontChoice.selectOption("botkins");
  await page.locator('html[data-font="botkins"]').waitFor();
  assert.match((await families())[0], /Open Sans/);
  assert.match((await families())[1], /DejaVu Serif/);
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).settings.appearance.fontPicked, true);

  assert.deepEqual(errors, [], "no errors on the page");
  console.log("look smoke: ok." + (shots ? " Screenshots in " + shots : ""));
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
