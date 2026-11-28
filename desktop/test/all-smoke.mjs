// The All page and the menu a person arranges, in an isolated data folder with the three test
// bots. No Copilot turns. A new workspace's side menu is short: Home, Chats and Work (and Today
// where the computer has no spaces), then All. All shows every place as a tile with one line; a
// tile's pin puts it on the menu and takes it off; a tile dragged onto the menu lands where the
// line shows; a row of the menu dropped on All comes off it; a right-click on a row moves it or
// takes it off; the menu's section of spaces is a place like the others. The menu survives a
// relaunch, and a workspace that is set up opens on the primary bot's chat. Set ALL_SHOTS to a
// folder to save light and dark screenshots at 1190×830.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";
import { showsSpaces } from "./spaces-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-all-"));
const dataDir = join(dir, "app");
seedApp(dataDir);
const env = { ...process.env, BOTKINS_DATA_DIR: dataDir, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const shots = process.env.ALL_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const errors = [];
let app, page;

const snap = () => page.evaluate(() => window.botkins.snapshot());
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
const nav = () => page.getByRole("navigation", { name: "Workspace" });
const menu = () => nav().getByRole("button").evaluateAll((els) => els.map((el) => el.dataset.place));
const row = (place) => nav().locator('button[data-place="' + place + '"]');
const tile = (place) => page.locator('.all-tile[data-place="' + place + '"]');
const tiles = () => page.locator(".all-tile").evaluateAll((els) => els.map((el) => el.dataset.place));
const onMenu = () => page.locator(".all-tile:has(.all-pin.on)").evaluateAll((els) => els.map((el) => el.dataset.place));
const hidden = async () => (await snap()).settings.sidebar.hidden;
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
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await signedInAs(app);
  await page.reload();
}

try {
  await launch();
  page = await skipWelcome(page);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await size(1190, 830);
  const spaces = await showsSpaces(page).catch(() => false);
  // The menu open, so its rows show their names.
  await page.evaluate(() => window.botkins.setPreferences({ sidebar: { collapsed: false } }));
  await expect(page.locator(".shell")).not.toHaveClass(/collapsed/);

  // ---- A new workspace: a short menu that ends with All.
  const usual = spaces ? ["Home", "Chats", "Work", "All"] : ["Home", "Today", "Chats", "Work", "All"];
  assert.deepEqual(await menu(), usual);
  assert.equal(await page.getByRole("navigation", { name: "Spaces" }).count(), spaces ? 1 : 0, "the menu's section of spaces is on a new menu");
  console.log("A new workspace's side menu is short and ends with All.");

  // ---- All: every place as a tile, the ones on the menu marked.
  await row("All").click();
  await page.getByRole("heading", { name: "All", exact: true, level: 1 }).waitFor();
  await expect(row("All")).toHaveAttribute("aria-current", "page");
  const every = (spaces ? ["Home", "Chats", "Work", "Projects", "Tasks", "Routines", "Spaces"] : ["Home", "Today", "Chats", "Work", "Projects", "Tasks", "Routines"]).concat(["Wiki", "Market", "Activity", "Usage"]);
  assert.deepEqual(await tiles(), every);
  assert.deepEqual(await onMenu(), spaces ? ["Home", "Chats", "Work", "Spaces"] : ["Home", "Today", "Chats", "Work"]);
  await expect(tile("Home").locator(".all-line")).toHaveText("3 bots");
  await expect(tile("Chats").locator(".all-line")).toHaveText("All read");
  // Nothing is cut off, and every tile has its name and a line.
  for (const place of every) {
    await expect(tile(place).locator(".all-name")).toHaveText(place);
    assert.ok((await tile(place).locator(".all-line").textContent()).trim().length > 2, place + " says nothing");
  }
  assert.equal(await page.locator(".content").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "the page scrolls sideways");
  await shot("all");
  console.log("All shows every place as a tile with its line; the ones on the menu say so.");

  // ---- A tile's pin puts it on the menu, at its end, and takes it off.
  await tile("Wiki").hover();
  await tile("Wiki").getByRole("button", { name: "Pin Wiki to the side menu" }).click();
  await expect.poll(menu).toEqual([...usual.slice(0, -1), "Wiki", "All"]);
  assert.ok(!(await hidden()).includes("Wiki"));
  await expect(tile("Wiki").getByRole("button", { name: "Take Wiki off the side menu" })).toHaveAttribute("aria-pressed", "true");
  console.log("A tile's pin puts it on the menu, before All.");

  // ---- A tile dragged onto the menu lands where it is dropped.
  await tile("Market").dragTo(row("Chats"), { targetPosition: { x: 40, y: 4 } });
  const withMarket = [...usual.slice(0, -1), "Wiki", "All"];
  withMarket.splice(withMarket.indexOf("Chats"), 0, "Market");
  await expect.poll(menu).toEqual(withMarket);
  // On All's own row, it lands at the menu's end.
  await tile("Routines").dragTo(row("All"));
  await expect.poll(menu).toEqual([...withMarket.slice(0, -1), "Routines", "All"]);
  console.log("A tile dragged onto the menu is pinned where it lands.");
  await shot("all-pinned");

  // ---- A row dragged on the menu moves; dropped on All, it comes off.
  await row("Routines").dragTo(row("Home"), { targetPosition: { x: 40, y: 4 } });
  await expect.poll(async () => (await menu())[0]).toBe("Routines");
  await row("Routines").dragTo(page.locator(".all-grid"));
  await expect.poll(async () => (await menu()).includes("Routines")).toBe(false);
  assert.ok((await hidden()).includes("Routines"));
  console.log("A row of the menu is dragged to another position, and off the menu onto All.");

  // ---- A right-click on a row: move it, or take it off.
  await row("Wiki").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(async () => { const now = await menu(); return now.indexOf("Wiki") < now.indexOf("Work"); }, { message: "Wiki did not move up" }).toBe(true);
  await row("Market").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Take off menu" }).click();
  await expect.poll(async () => (await menu()).includes("Market")).toBe(false);
  console.log("A right-click on a row moves it or takes it off the menu.");

  // ---- A tile opens its place; a page under Work that is on the menu is its own current place.
  await tile("Tasks").hover();
  await tile("Tasks").getByRole("button", { name: "Pin Tasks to the side menu" }).click();
  await tile("Tasks").locator(".all-open").click();
  await page.getByRole("tab", { name: /^Tasks/, selected: true }).waitFor();
  await expect(row("Tasks")).toHaveAttribute("aria-current", "page");
  await expect(row("Work")).not.toHaveAttribute("aria-current", "page");
  await row("All").click();
  await tile("Projects").locator(".all-open").click();
  await page.getByRole("tab", { name: /^Projects/, selected: true }).waitFor();
  await expect(row("Work")).toHaveAttribute("aria-current", "page");
  console.log("A tile opens its place, and a pinned page under Work is the current place itself.");

  // ---- The menu's section of spaces is a place too.
  if (spaces) {
    await row("All").click();
    await tile("Spaces").getByRole("button", { name: "Take Spaces off the side menu" }).click();
    await expect(page.getByRole("navigation", { name: "Spaces" })).toHaveCount(0);
    await tile("Spaces").locator(".all-open").click();
    await page.getByRole("heading", { name: "All spaces", exact: true }).first().waitFor();
    await row("All").click();
    await tile("Spaces").hover();
    await tile("Spaces").getByRole("button", { name: "Pin Spaces to the side menu" }).click();
    await expect(page.getByRole("navigation", { name: "Spaces" })).toHaveCount(1);
    console.log("The section of spaces comes off the menu and goes back on it.");
  }

  // ---- Collapsed to icons, the menu is the same places.
  const kept = await menu();
  await page.getByRole("button", { name: "Collapse side menu" }).click();
  await expect(page.locator(".shell")).toHaveClass(/collapsed/);
  assert.deepEqual(await menu(), kept);
  for (const place of kept) assert.deepEqual(await row(place).evaluate((el) => [Math.round(el.getBoundingClientRect().width), !!el.querySelector("svg")]), [48, true], place + " as an icon");
  await row("All").click();
  await shot("all-collapsed");
  await page.getByRole("button", { name: "Expand side menu" }).click();
  console.log("Collapsed to icons, the menu holds the same places.");

  // ---- A relaunch keeps the menu, and a workspace that is set up opens on the primary bot's chat.
  await app.close();
  await launch();
  await size(1190, 830);
  await expect.poll(menu).toEqual(kept);
  await page.getByRole("combobox", { name: "Message", exact: true }).waitFor();
  await expect(page.locator(".botnav-item.selected")).toContainText("Pip");
  assert.equal(await page.getByText(/^Good (morning|afternoon|evening)$/).count(), 0, "the window opened on Home");
  await shot("opens-on-bot");
  await row("Home").click();
  await page.getByText(/^Good (morning|afternoon|evening)$/).waitFor();
  console.log("The menu survives a relaunch, and the window opens on the primary bot's chat.");

  assert.deepEqual(errors, [], "the page threw: " + errors.join("; "));
  console.log("all smoke: ok." + (shots ? " Screenshots in " + shots : ""));
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
