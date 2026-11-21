// The side menu smoke, in an isolated data folder with the three test bots. No Copilot turns.
// A new workspace shows the menu as icons only: the five places' icons from the Botkins navigation
// pack, each 24px in a 48px button, with its name beside it on hover and on keyboard focus.
// Settings › Side menu: reorder the places by keyboard (Move up / Move down) and by dragging, and the
// navigation follows; Reset to the usual order. Open and collapse the menu with its button and with
// ⌘B / Ctrl+B; both the order and the menu the person opened survive a relaunch. Set SIDEBAR_SHOTS to
// a folder to save light and dark screenshots at 1190×830 and at the smallest window, 760×560.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-sidebar-"));
const dataDir = join(dir, "app");
seedApp(dataDir);
// Only GitHub Copilot, so the menu does not depend on which other providers this computer has.
const env = { ...process.env, BOTKINS_DATA_DIR: dataDir, COMMANDER_DATA_DIR: dataDir, BOTKINS_PROVIDERS: "copilot", COMMANDER_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const shots = process.env.SIDEBAR_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const USUAL = ["Home", "Today", "Chats", "Work", "Wiki"];
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const errors = [];
let app, page;

const snap = () => page.evaluate(() => window.botkins.snapshot());
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
const nav = () => page.getByRole("navigation", { name: "Workspace" });
const navOrder = () => nav().getByRole("button").evaluateAll((els) => els.map((el) => el.querySelector(".nav-label")?.textContent?.trim()));
const collapsed = () => page.locator(".shell").evaluate((el) => el.classList.contains("collapsed"));
const railWidth = () => page.locator(".shell > aside").evaluate((el) => Math.round(el.getBoundingClientRect().width));
async function shot(name) {
  if (!shots) return;
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await page.locator(`html[data-mode="${mode}"]`).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
}
async function launch() {
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  // Signed in as a made-up account, so the app opens on Home whatever this computer's sign-in is.
  await signedInAs(app);
  await page.reload();
  page = await skipWelcome(page);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await size(1190, 830);
}
/** Nothing in the side menu is cut off or scrolls sideways. */
async function fits(label) {
  // The menu animates its width for a moment.
  await page.waitForTimeout(300);
  const over = await page.locator(".shell > aside").evaluate((aside) => {
    const box = aside.getBoundingClientRect();
    const out = [...aside.querySelectorAll("button")]
      .filter((b) => b.offsetParent && getComputedStyle(b).opacity !== "0")
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
      })
      .map((b) => b.getAttribute("aria-label") || b.textContent);
    // Below the bots list (which scrolls), nothing may fall off the bottom of the window.
    const low = [...aside.querySelectorAll(":scope > nav button, :scope > .sidebarlabel button, .sidebar-foot button, :scope > .account")]
      .filter((b) => b.getBoundingClientRect().bottom > box.bottom + 0.5)
      .map((b) => b.getAttribute("aria-label") || b.textContent);
    const bots = aside.querySelector(".botnav")?.getBoundingClientRect().height ?? 0;
    return { out: [...out, ...low], sideways: aside.scrollWidth > aside.clientWidth + 1, bots };
  });
  assert.deepEqual(over.out, [], label + ": side menu buttons are cut off");
  assert.ok(over.bots >= 40, label + ": the bots list has no room (" + over.bots + "px)");
  assert.equal(over.sideways, false, label + ": the side menu scrolls sideways");
}
/** The menu as icons only: every place is its pack icon in a 48px-wide button, named for screen readers, with no second tooltip. */
async function rail(places, height) {
  for (const name of places) {
    const button = nav().getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute("title", /./);
    const drawn = await button.evaluate((el) => {
      const svg = el.querySelector("svg");
      const [b, i] = [el.getBoundingClientRect(), svg.getBoundingClientRect()];
      return { button: [b.width, b.height], icon: [i.width, i.height], centered: Math.abs(b.left + b.width / 2 - (i.left + i.width / 2)) < 0.6, art: svg.innerHTML, hidden: svg.getAttribute("aria-hidden") };
    });
    assert.deepEqual(drawn.button, [48, height], name + ": the button's size");
    assert.deepEqual(drawn.icon, [24, 24], name + ": the icon's size");
    assert.ok(drawn.centered, name + ": the icon sits in the middle");
    assert.equal(drawn.hidden, "true", name + ": the icon is decoration");
    // The shapes are the pack's own, without its <title>.
    const file = readFileSync(new URL("../assets/brand/nav-icons/" + name.toLowerCase() + ".svg", import.meta.url), "utf8");
    const paths = [...file.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(paths.length > 0, name + ": the pack's file has shapes");
    for (const d of paths) assert.ok(drawn.art.includes('d="' + d + '"'), name + ": the icon is not the pack's");
    assert.ok(!drawn.art.includes("<title"), name + ": the icon carries a second tooltip");
  }
  // The place you are in keeps a background.
  const current = nav().locator("button[aria-current=page]");
  await expect(current).toHaveCount(1);
  assert.notEqual(await current.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "the current place has no background");
  // A name shows beside its icon on hover, clear of the menu's edge, and goes when the pointer leaves.
  const first = nav().getByRole("button").first();
  const label = first.locator(".nav-label");
  await page.mouse.move(600, 420);
  await expect(label).toHaveCSS("opacity", "0");
  await first.hover();
  await expect(label).toHaveCSS("opacity", "1");
  const [b, l, edge] = [await first.boundingBox(), await label.boundingBox(), await railWidth()];
  assert.ok(l.x >= edge && l.x - (b.x + b.width) < 24, "the name is not beside its icon: " + JSON.stringify({ b, l, edge }));
  assert.ok(Math.abs(l.y + l.height / 2 - (b.y + b.height / 2)) < 1.5, "the name is not level with its icon");
  await page.mouse.move(600, 420);
  await expect(label).toHaveCSS("opacity", "0");
  // And on keyboard focus, with the focus ring.
  await page.getByRole("button", { name: "New chat", exact: true }).focus();
  for (let i = 0; i < 4 && !(await first.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await expect(label).toHaveCSS("opacity", "1");
  assert.notEqual(await first.evaluate((el) => getComputedStyle(el).outlineStyle), "none", "the focused place has no focus ring");
  await first.evaluate((el) => el.blur());
}

try {
  await launch();
  assert.deepEqual(await navOrder(), USUAL);
  // ---- A new workspace shows the menu as icons only, and nobody has chosen that yet.
  assert.equal(await collapsed(), true);
  assert.equal(await railWidth(), 72);
  assert.deepEqual((await snap()).settings.sidebar, { order: USUAL, collapsed: true });
  await rail(USUAL, 48);
  await fits("icons only 1190×830");
  await shot("sidebar-collapsed");
  await nav().getByRole("button").first().hover();
  await expect(nav().getByRole("button").first().locator(".nav-label")).toHaveCSS("opacity", "1");
  await shot("sidebar-collapsed-label");
  await page.mouse.move(600, 420);
  console.log("A new workspace shows the side menu as icons only: the pack's five icons, 24px in 48px buttons, each with its name on hover and on keyboard focus.");

  // ---- Settings › Side menu: Move up / Move down by keyboard; the navigation follows at once.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Side menu", exact: true }).click();
  await settings.getByRole("heading", { name: "Side menu", level: 2 }).waitFor();
  await expect(settings.getByRole("switch", { name: "Show icons only" })).toBeChecked();
  const places = settings.getByRole("list", { name: "Places in the side menu" });
  await expect(places.getByRole("listitem")).toHaveCount(5);
  await expect(settings.getByRole("button", { name: "Reset to the usual order" })).toBeDisabled();
  await expect(settings.getByRole("button", { name: "Move Home up" })).toBeDisabled();
  await settings.getByRole("button", { name: "Move Wiki up" }).focus();
  await page.keyboard.press("Enter");
  await expect(settings.getByRole("button", { name: "Move Wiki up" })).toBeFocused();
  // Five places (Projects are a tab of Work): two moves (Enter, then Space) take Wiki from 5 to 3.
  await page.keyboard.press("Space");
  const moved = ["Home", "Today", "Wiki", "Chats", "Work"];
  await expect.poll(navOrder).toEqual(moved);
  await expect.poll(async () => (await snap()).settings.sidebar.order).toEqual(moved);
  await expect(settings.getByRole("status").filter({ hasText: "Wiki moved to position 3 of 5." })).toBeVisible();
  // Tab reaches Move down on the same place; it moves back one.
  await page.keyboard.press("Tab");
  await expect(settings.getByRole("button", { name: "Move Wiki down" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(navOrder).toEqual(["Home", "Today", "Chats", "Wiki", "Work"]);
  console.log("Move up and Move down by keyboard reorder the side menu at once; focus stays on the place that moved.");

  // ---- Dragging a place moves it too.
  const row = (name) => places.locator('[data-place="' + name + '"]');
  await row("Work").dragTo(row("Home"), { targetPosition: { x: 40, y: 4 } });
  await expect.poll(navOrder).toEqual(["Work", "Home", "Today", "Chats", "Wiki"]);
  console.log("Dragging Work above Home moves it to the top.");
  await shot("sidebar-settings");

  // ---- Reset.
  await settings.getByRole("button", { name: "Reset to the usual order" }).click();
  await expect.poll(navOrder).toEqual(USUAL);
  await expect.poll(async () => (await snap()).settings.sidebar.order).toEqual(USUAL);
  await expect(settings.getByRole("button", { name: "Reset to the usual order" })).toBeDisabled();
  console.log("Reset to the usual order puts the places back.");

  // An order to keep across the relaunch: Home down two places.
  await settings.getByRole("button", { name: "Move Home down" }).click();
  await settings.getByRole("button", { name: "Move Home down" }).click();
  const kept = ["Today", "Chats", "Home", "Work", "Wiki"];
  await expect.poll(navOrder).toEqual(kept);
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await expect(settings).toHaveCount(0);

  // ---- Open and collapse with the button. Opening it is the person's choice, and is saved as one.
  await page.getByRole("button", { name: "Expand side menu" }).click();
  await expect.poll(collapsed).toBe(false);
  await expect.poll(railWidth).toBe(264);
  await expect.poll(async () => (await snap()).settings.sidebar).toEqual({ order: kept, collapsed: false, picked: true });
  for (const name of kept) {
    await expect(nav().getByRole("button", { name, exact: true })).not.toHaveAttribute("title", /./);
    await expect(nav().getByRole("button", { name, exact: true }).locator(".nav-label")).toHaveCSS("opacity", "1");
    await expect(nav().getByRole("button", { name, exact: true }).locator(".nav-label")).toHaveCSS("position", "static");
  }
  await page.mouse.move(600, 420);
  await fits("open 1190×830");
  await shot("sidebar-expanded");
  const wide = await railWidth();
  await page.getByRole("button", { name: "Collapse side menu" }).click();
  await expect.poll(collapsed).toBe(true);
  await expect.poll(railWidth).toBe(72);
  await expect.poll(async () => (await snap()).settings.sidebar.collapsed).toBe(true);
  // Icons keep their names; the current place is still marked; bots are their avatars.
  await rail(kept, 48);
  await expect(nav().getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav().getByRole("button", { name: "Home", exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("title", /Settings/);
  await expect(page.getByRole("button", { name: /^Models/ })).toHaveAttribute("title", "Models · GitHub Copilot");
  await expect(page.locator(".models-status .provider-icon[data-provider=copilot]")).toBeVisible();
  const pip = page.locator(".botnav").getByRole("button", { name: "Pip", exact: true });
  await expect(pip).toHaveAttribute("title", "Pip");
  await expect(page.locator(".botnav .botnav-name").first()).toHaveCSS("clip-path", "inset(50%)");
  await fits("collapsed 1190×830");
  // Places and bots still open from the rail.
  await nav().getByRole("button", { name: "Wiki", exact: true }).click();
  await expect(nav().getByRole("button", { name: "Wiki", exact: true })).toHaveAttribute("aria-current", "page");
  // The rail's sizes stay in the rail: the Wiki's own menu keeps its full-width rows.
  const wikiRow = await page.locator(".wiki-nav .wiki-nav-item").first().boundingBox();
  assert.ok(wikiRow.width > 150, "the Wiki's menu rows took the rail's width: " + wikiRow.width);
  await pip.click();
  await expect(page.locator(".chathead").getByRole("heading", { name: "Pip" })).toBeVisible();
  await page.getByRole("button", { name: "Expand side menu" }).click();
  await expect.poll(collapsed).toBe(false);
  await expect.poll(railWidth).toBe(wide);
  console.log("The button opens the side menu and collapses it to a rail of icons again; places and bots open from the rail.");

  // ---- ⌘B / Ctrl+B, from anywhere outside a text editor.
  await nav().getByRole("button", { name: "Home", exact: true }).click();
  // Somewhere that is not a control: Home's question.
  await page.getByRole("heading", { name: /on your mind/ }).click();
  await page.keyboard.press(MOD + "+b");
  await expect.poll(collapsed).toBe(true);
  await page.keyboard.press(MOD + "+b");
  await expect.poll(collapsed).toBe(false);
  // The message box keeps working while the shortcut is used.
  await page.getByRole("combobox", { name: "Message", exact: true }).fill("hello");
  await page.getByRole("combobox", { name: "Message", exact: true }).press(MOD + "+b");
  await expect.poll(collapsed).toBe(true);
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveValue("hello");
  await expect.poll(async () => (await snap()).settings.sidebar.collapsed).toBe(true);
  console.log("⌘B collapses and expands the side menu.");

  // ---- The smallest window, collapsed and expanded.
  await size(760, 560);
  await page.waitForTimeout(250);
  await fits("collapsed 760×560");
  // A short window keeps the 48px width and trims the height, so the bots keep their room.
  await rail(kept, 40);
  await shot("sidebar-collapsed-min");
  await page.getByRole("button", { name: "Expand side menu" }).click();
  await expect.poll(collapsed).toBe(false);
  await fits("expanded 760×560");
  await shot("sidebar-expanded-min");
  await page.getByRole("button", { name: "Collapse side menu" }).click();
  await expect.poll(collapsed).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Side menu", exact: true }).click();
  // Every Settings section is reachable without scrolling the Settings side menu at the smallest size.
  const menuScrolls = await page.locator(".set-sidebar").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  assert.equal(menuScrolls, false, "the Settings side menu scrolls at 760×560");
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("switch", { name: "Show icons only" })).toBeChecked();
  await shot("sidebar-settings-min");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Close dialog" }).click();
  await size(1190, 830);

  // ---- The order and the menu the person opened survive a relaunch.
  await page.getByRole("button", { name: "Expand side menu" }).click();
  await expect.poll(async () => (await snap()).settings.sidebar).toEqual({ order: kept, collapsed: false, picked: true });
  await app.close();
  await launch();
  assert.deepEqual(await navOrder(), kept);
  assert.equal(await collapsed(), false);
  await page.getByRole("button", { name: "Collapse side menu" }).click();
  await expect.poll(collapsed).toBe(true);
  console.log("The order and the open menu survive a relaunch.");

  assert.deepEqual(errors, [], "no page errors");
  console.log("sidebar smoke: ok" + (shots ? ". Screenshots in " + shots : ""));
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
