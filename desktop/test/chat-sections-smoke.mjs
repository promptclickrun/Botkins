// Sections on the Chats page ("chat-sections-v1"), in an isolated data folder, against the real main
// process and its link, which keeps the sections. No turns. A chat's menu moves it into a section
// or makes one; a section's menu renames, moves and deletes it; a chat is dragged in and out; a
// section folds; Pinned comes first; a search shows only groups with a match; and the sections are
// there after the app starts again. Set CHAT_SECTIONS_SHOTS to a folder for pictures in light and dark.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-chat-sections-"));
const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "app") };
delete env.ELECTRON_RUN_AS_NODE;
seedApp(join(dir, "app"));
// A few conversations that already happened: two today, one yesterday, one earlier, one pinned.
{
  const file = join(dir, "app", "data", "workspace.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = Math.max(start.getTime() + 60_000, Date.now() - 20 * 60_000);
  const talk = (id, botId, title, time, question, answer, more = {}) => ({
    id, botId, title, time, established: false, ...more,
    messages: [{ role: "user", text: question, time }, { role: "assistant", text: answer, time, botId }],
  });
  data.chats.push(
    talk("garden", "pip", "Garden plan", today, "What should I plant in March?", "Peas and broad beans."),
    talk("trip", "scout", "Spring trip", today - 60_000, "Where should we go in April?", "The coast, before the crowds."),
    talk("books", "pip", "Book list", start.getTime() - 3 * 3_600_000, "Five novels for the train?", "Here are five."),
    talk("taxes", "patch", "Tax notes", start.getTime() - 9 * 86_400_000, "What do I keep for taxes?", "Receipts and statements."),
    talk("recipe", "pip", "Soup recipe", start.getTime() - 4 * 86_400_000, "A quick soup?", "Leek and potato.", { pinned: true }),
  );
  writeFileSync(file, JSON.stringify(data));
}
const shots = process.env.CHAT_SECTIONS_SHOTS;
let app;
let page;
const errors = [];
const snap = () => page.evaluate(() => window.botkins.snapshot());
const launch = async () => {
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  page = await home(app);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 860));
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
};
/** The groups of the list, each with the titles of its chats, in the order they are drawn. */
const list = () =>
  page.locator(".chatgroup").evaluateAll((groups) =>
    groups.map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll(".chatrow strong")].map((title) => title.textContent.trim())]),
  );
const row = (title) => page.locator(".rowwrap").filter({ has: page.locator(".chatrow strong", { hasText: title }) });
const section = (name) => page.locator(".chatsection").filter({ has: page.locator(".chatsection-head span", { hasText: new RegExp("^" + name + "$") }) });
const menu = () => page.getByRole("menu");
const item = (name) => menu().getByRole("menuitem", { name, exact: true });
const chatMenu = async (title) => {
  await row(title).getByRole("button", { name: "Chat options" }).click();
  await expect(menu()).toBeVisible();
};
const sectionMenu = async (name) => {
  await page.getByRole("button", { name: "Options for section " + name, exact: true }).click();
  await expect(menu()).toBeVisible();
};
const ask = (title) => page.getByRole("dialog", { name: title });
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
async function shot(name, target) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
    await page.waitForTimeout(300);
    if (target) await target();
    else await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
    if (target) {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(menu()).toHaveCount(0);
    }
  }
  await theme("light");
}
/** A new section from a chat's menu, with the prompt's own words. */
async function newSection(title, name) {
  await chatMenu(title);
  await item("Move to section").click();
  await expect(menu().getByRole("menuitemradio", { name: "None" })).toHaveAttribute("aria-checked", "true");
  await item("New section…").click();
  const dialog = ask("New section");
  await expect(dialog.getByRole("heading", { name: "New section" })).toBeVisible();
  await expect(dialog).toContainText(title + " moves into it.");
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create section", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
/**
 * Drags a chat's row onto a place through the window's own drag and drop events, the way the
 * parity smoke drags a bot (Playwright's mouse does not start an HTML drag in Electron). The place
 * is outlined while the chat is over it.
 */
async function drag(title, target) {
  const source = await row(title).elementHandle();
  const place = await target.elementHandle();
  const data = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: data });
  await place.dispatchEvent("dragover", { dataTransfer: data });
  await expect(target).toHaveAttribute("data-drag-over", "true");
  await place.dispatchEvent("drop", { dataTransfer: data });
  await source.dispatchEvent("dragend", { dataTransfer: data }).catch(() => {});
  await expect(target).not.toHaveAttribute("data-drag-over", "true");
}
const sectionOf = async (chatId) => (await snap()).chats.find((chat) => chat.id === chatId)?.sectionId;

try {
  await launch();
  // Before any section: the list as it always was, and the computer says it has sections, none yet.
  assert.deepEqual((await snap()).chatSections, [], "this computer keeps chat sections");
  assert.deepEqual(await list(), [
    ["Pinned", ["Soup recipe"]],
    ["Today", ["Garden plan", "Spring trip"]],
    ["Yesterday", ["Book list"]],
    ["Earlier", ["Tax notes"]],
  ]);
  assert.equal(await page.locator(".chatsection").count(), 0);
  console.log("Before any section the list is Pinned, Today, Yesterday, Earlier.");

  // "Move to section" › "New section…" makes the section and moves the chat into it.
  await newSection("Spring trip", "Travel");
  await expect.poll(async () => (await snap()).chatSections.map((s) => s.name)).toEqual(["Travel"]);
  const travel = (await snap()).chatSections[0].id;
  assert.match(travel, /^cs_/);
  assert.equal(await sectionOf("trip"), travel);
  await expect.poll(list).toEqual([
    ["Pinned", ["Soup recipe"]],
    ["Travel", ["Spring trip"]],
    ["Today", ["Garden plan"]],
    ["Yesterday", ["Book list"]],
    ["Earlier", ["Tax notes"]],
  ]);
  // A second section, after the first.
  await newSection("Garden plan", "Home jobs");
  await expect.poll(async () => (await snap()).chatSections.map((s) => s.name)).toEqual(["Travel", "Home jobs"]);
  await expect.poll(list).toEqual([
    ["Pinned", ["Soup recipe"]],
    ["Travel", ["Spring trip"]],
    ["Home jobs", ["Garden plan"]],
    ["Yesterday", ["Book list"]],
    ["Earlier", ["Tax notes"]],
  ]);
  console.log("New section… from a chat's menu makes a section and moves the chat; the list is Pinned, the sections, the rest.");

  // The chat's own section is checked in its menu.
  await chatMenu("Garden plan");
  await item("Move to section").click();
  await expect(menu().getByRole("menuitemradio")).toHaveText(["Travel", "Home jobs", "None"]);
  await expect(menu().getByRole("menuitemradio", { name: "Home jobs" })).toHaveAttribute("aria-checked", "true");
  await expect(menu().getByRole("menuitemradio", { name: "None" })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await shot("chat-sections", null);
  await shot("chat-sections-menu", async () => {
    await chatMenu("Book list");
    await item("Move to section").click();
    await expect(item("New section…")).toBeVisible();
  });

  // Move up and Move down, and the ends say they can't.
  await sectionMenu("Home jobs");
  await expect(menu().getByRole("menuitem")).toHaveText(["Rename…", "Move up", "Move down", "Delete section…"]);
  await expect(item("Move down")).toBeDisabled();
  await item("Move up").click();
  await expect.poll(async () => (await snap()).chatSections.map((s) => s.name)).toEqual(["Home jobs", "Travel"]);
  await expect.poll(async () => (await list()).slice(1, 3).map(([name]) => name)).toEqual(["Home jobs", "Travel"]);
  await sectionMenu("Home jobs");
  await expect(item("Move up")).toBeDisabled();
  await item("Move down").click();
  await expect.poll(async () => (await snap()).chatSections.map((s) => s.name)).toEqual(["Travel", "Home jobs"]);
  console.log("Move up and Move down change the order of the sections.");

  // Rename…
  await sectionMenu("Travel");
  await item("Rename…").click();
  await expect(ask("Rename section")).toBeVisible();
  await ask("Rename section").getByRole("textbox").fill("Trips");
  await ask("Rename section").getByRole("button", { name: "Rename", exact: true }).click();
  await expect.poll(async () => (await snap()).chatSections.map((s) => s.name)).toEqual(["Trips", "Home jobs"]);
  await expect(section("Trips")).toBeVisible();
  // A name the person already has is refused with the computer's own sentence, and nothing changes.
  await newSection("Book list", "trips");
  await expect(page.getByRole("alert")).toHaveText("You already have a section with that name.");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  assert.equal((await snap()).chatSections.length, 2);
  assert.equal(await sectionOf("books"), undefined);
  console.log("Rename… renames a section; a name already taken is refused in the computer's words.");

  // Dragging a chat onto a section puts it there; onto the chats in no section takes it out again.
  await drag("Book list", section("Trips"));
  await expect.poll(() => sectionOf("books")).toBe(travel);
  await expect.poll(async () => (await list()).find(([name]) => name === "Trips")?.[1]).toEqual(["Spring trip", "Book list"]);
  await drag("Book list", page.locator(".chatgroups-loose"));
  await expect.poll(() => sectionOf("books")).toBe(undefined);
  await expect.poll(async () => (await list()).find(([name]) => name === "Yesterday")?.[1]).toEqual(["Book list"]);
  // Clicking a row still opens its chat.
  await row("Tax notes").locator(".chatrow").click();
  await expect(page.locator(".chathead h2")).toHaveText("Patch");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
  console.log("A chat is dragged into a section and back out; a click still opens it.");

  // A section folds with a click on its heading, and stays folded while the app is open.
  const head = section("Trips").locator(".chatsection-head > button").first();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(section("Trips").locator(".chatrow")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
  await expect(section("Trips").locator(".chatsection-head > button").first()).toHaveAttribute("aria-expanded", "false");
  await section("Trips").locator(".chatsection-head > button").first().click();
  await expect(section("Trips").locator(".chatrow")).toHaveCount(1);
  console.log("A section folds and opens with a click on its heading.");

  // A pinned chat in a section shows under Pinned; its section says so by being empty.
  await chatMenu("Soup recipe");
  await item("Move to section").click();
  await menu().getByRole("menuitemradio", { name: "Home jobs" }).click();
  await expect.poll(() => sectionOf("recipe")).toBe((await snap()).chatSections[1].id);
  await expect.poll(list).toEqual([
    ["Pinned", ["Soup recipe"]],
    ["Trips", ["Spring trip"]],
    ["Home jobs", ["Garden plan"]],
    ["Yesterday", ["Book list"]],
    ["Earlier", ["Tax notes"]],
  ]);
  // An empty section shows with its line.
  await chatMenu("Spring trip");
  await item("Move to section").click();
  await menu().getByRole("menuitemradio", { name: "None" }).click();
  await expect(section("Trips")).toContainText("No chats here yet.");
  console.log("A pinned chat in a section shows under Pinned; an empty section says No chats here yet.");

  // While searching, only groups with a match show.
  const search = page.getByRole("textbox", { name: "Search chats" });
  await search.fill("garden");
  await expect.poll(list).toEqual([["Home jobs", ["Garden plan"]]]);
  await search.fill("trip");
  await expect.poll(list).toEqual([["Today", ["Spring trip"]]]);
  await search.fill("");
  await expect.poll(async () => (await list()).length).toBe(6);
  console.log("A search shows only the groups with a match.");

  // Delete section…: its chats stay, in no section.
  await sectionMenu("Home jobs");
  await item("Delete section…").click();
  const confirm = ask("Delete “Home jobs”?");
  await expect(confirm).toContainText("Its chats stay. They move out of the section.");
  await confirm.getByRole("button", { name: "Delete section", exact: true }).click();
  await expect.poll(async () => (await snap()).chatSections.map((s) => s.name)).toEqual(["Trips"]);
  await expect.poll(list).toEqual([
    ["Pinned", ["Soup recipe"]],
    ["Trips", []],
    ["Today", ["Garden plan", "Spring trip"]],
    ["Yesterday", ["Book list"]],
    ["Earlier", ["Tax notes"]],
  ]);
  assert.equal(await sectionOf("garden"), undefined);
  console.log("Delete section… deletes it; its chats stay in the list.");

  // The sections are kept by the link: they are there after the app starts again on the same folder.
  await chatMenu("Garden plan");
  await item("Move to section").click();
  await menu().getByRole("menuitemradio", { name: "Trips" }).click();
  await expect.poll(() => sectionOf("garden")).toBe(travel);
  assert.equal("chatSections" in JSON.parse(readFileSync(join(dir, "app", "data", "workspace.json"), "utf8")), false, "the workspace knows nothing of them");
  await app.close();
  app = undefined;
  await launch();
  await expect.poll(list).toEqual([
    ["Pinned", ["Soup recipe"]],
    ["Trips", ["Garden plan"]],
    ["Today", ["Spring trip"]],
    ["Yesterday", ["Book list"]],
    ["Earlier", ["Tax notes"]],
  ]);
  assert.deepEqual(errors, []);
  console.log("Chat sections smoke passed. The sections are there after a restart; no renderer exceptions.");
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
