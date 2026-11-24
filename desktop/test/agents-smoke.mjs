// Non-live smoke for Botkin looks and agent management: bot creation with a look and template, pin,
// sections, hide and show, primary, the bot page, and chat rename, archive and restore.
// Set AGENTS_SHOTS to a folder to save light and dark screenshots there.
import { stubTemplate } from "./template-fixture.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-agents-"));
const shots = process.env.AGENTS_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  args: process.env.BOTKINS_BINARY ? [] : ["."],
  executablePath: process.env.BOTKINS_BINARY,
  env,
});
try {
  const page = await home(app);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  const snapshot = () => page.evaluate(() => window.botkins.snapshot());
  const bot = async (name) => (await snapshot()).bots.find((b) => b.name === name);
  const main = page.locator("main");
  const dialog = page.getByRole("dialog");
  const item = (name) => page.getByRole("menuitem", { name, exact: true });
  const menuFor = (name) => main.getByRole("button", { name: "Options for " + name, exact: true }).click();
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

  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  // Every bot is a Botkin with a look of its own, drawn as a picture in its card.
  await page.locator(".botcard .bot-avatar").first().waitFor();
  const pipLook = (await snapshot()).bots[0].look;
  assert.ok(pipLook && typeof pipLook.head === "string" && typeof pipLook.palette === "string", "Pip has a look");

  // Create a bot from a template with a chosen character and palette.
  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  await stubTemplate(app);
  await dialog.getByRole("button", { name: "Start from template", exact: true }).click();
  await dialog.getByRole("group", { name: "Marketplace templates" }).getByRole("button", { name: /Archive Guide/ }).click();
  await expect(dialog.getByLabel("Role", { exact: true })).toHaveValue("Research assistant");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Archive Guide");
  // The Botkin opens Bot Studio in its own sheet, on the template's character.
  await dialog.getByRole("button", { name: "Open Bot Studio", exact: true }).click();
  const studio = page.getByRole("dialog", { name: "Bot Studio" });
  const preview = studio.locator(".look-preview .bot-avatar");
  const headPlayback = () => preview.locator(".botkin-head").evaluate((head) => head.getAnimations().map((a) => a.playState));
  const trackCount = () => preview.evaluate((avatar) => avatar.getAnimations({ subtree: true }).length);
  const characters = studio.getByRole("radiogroup", { name: "Character" });
  const palettes = studio.getByRole("radiogroup", { name: "Palette" });
  // All characters share a grid. The seven palettes and eight color templates share a row.
  await expect(characters.getByRole("radio")).toHaveCount(23);
  await expect(palettes.getByRole("radio")).toHaveCount(15);
  assert.equal(await studio.getByRole("tab").count(), 0, "no pack tabs");
  await expect(characters.getByRole("radio", { name: "Fathom", exact: true })).toHaveAttribute("aria-checked", "true");
  // Arrow keys move through the characters (they are in the kit's order: fathom, goggle, …).
  await characters.getByRole("radio", { name: "Fathom", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(characters.getByRole("radio", { name: "Goggle", exact: true })).toHaveAttribute("aria-checked", "true");
  await characters.getByRole("radio", { name: "Skiff", exact: true }).click();
  await palettes.getByRole("radio", { name: "Bluebell", exact: true }).click();
  await expect(studio.locator(".look-name")).toHaveText("Skiff");
  // The preview runs, its picker thumbnails hold still, and a clip pauses at its current pose
  // when scrolled away. It obeys the system preference and plays a reaction just once.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(headPlayback).toEqual(["running"]);
  assert.equal(await characters.evaluate((grid) => grid.getAnimations({ subtree: true }).length), 0);
  await preview.evaluate((avatar) => { avatar.style.translate = "-200vw"; });
  await expect.poll(headPlayback).toEqual(["paused"]);
  const heldTime = () => preview.locator(".botkin-head").evaluate(async (head) => (await head.getAnimations()[0].ready).currentTime);
  const frozen = await heldTime();
  await page.waitForTimeout(100);
  assert.equal(await heldTime(), frozen);
  await preview.evaluate((avatar) => { avatar.style.translate = ""; });
  await expect.poll(headPlayback).toEqual(["running"]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(trackCount).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await studio.getByRole("button", { name: /^Preview:/ }).click();
  await expect(preview).toHaveAttribute("data-state", "like");
  await expect.poll(headPlayback).toEqual(["finished"]);
  // Surprise me picks another look.
  await studio.getByRole("button", { name: "Surprise me", exact: true }).click();
  await expect
    .poll(async () => [await studio.locator(".look-name").textContent(), await palettes.getByRole("radio", { checked: true }).textContent()])
    .not.toEqual(["Skiff", "Bluebell"]);
  await characters.getByRole("radio", { name: "Orbit", exact: true }).click();
  await palettes.getByRole("radio", { name: "Bluebell", exact: true }).click();
  // Eyes: six, each drawn on the current character.
  const eyes = studio.getByRole("radiogroup", { name: "Eyes" });
  const shellImage = preview.locator("img");
  await expect(eyes.getByRole("radio")).toHaveCount(6);
  // Surprise me may have picked eyes too, and a character or palette keeps them.
  await eyes.getByRole("radio", { name: "Oval", exact: true }).click();
  await expect(eyes.getByRole("radio", { checked: true })).toHaveAccessibleName("Oval");
  await expect(preview).toHaveAttribute("data-state", "idle");
  await expect(preview.locator(".botkin-face ellipse")).toHaveCount(2);
  const originalShell = await shellImage.getAttribute("src");
  await eyes.getByRole("radio", { name: "Wink", exact: true }).click();
  await expect(eyes.getByRole("radio", { name: "Wink", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(preview.locator(".botkin-face ellipse")).toHaveCount(1);
  assert.equal(await shellImage.getAttribute("src"), originalShell, "the new expression uses the same shell");
  // A palette fills the four color slots; changing one makes the colors the bot's own.
  await palettes.getByRole("radio", { name: "Fern", exact: true }).click();
  const slots = studio.getByRole("group", { name: "Custom colors" });
  await expect(slots.getByRole("button")).toHaveCount(4);
  await expect(slots.getByRole("button", { name: "Accent color, #dfae52", exact: true })).toBeVisible();
  const fernShell = await shellImage.getAttribute("src");
  await slots.getByRole("button", { name: "Shell color, #748848", exact: true }).click();
  const shell = page.getByRole("dialog", { name: "Shell color", exact: true });
  await expect(shell).toBeVisible();
  await expect(shell.getByRole("slider", { name: "Shell saturation and brightness" })).toBeFocused();
  await expect(shell.getByRole("slider", { name: "Shell hue" })).toBeVisible();
  // The hex field takes the short form too.
  await shell.getByLabel("Hex", { exact: true }).fill("#36c");
  await expect(slots.getByRole("button", { name: "Shell color, #3366cc", exact: true })).toBeVisible();
  await expect.poll(() => shellImage.getAttribute("src")).not.toBe(fernShell);
  await expect(palettes.getByRole("radio", { checked: true })).toHaveCount(0);
  // Arrow keys move the square's point: down is darker, and up comes back.
  await shell.getByRole("slider", { name: "Shell saturation and brightness" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(shell.getByLabel("Hex", { exact: true })).not.toHaveValue("#3366cc");
  await page.keyboard.press("ArrowUp");
  await expect(shell.getByLabel("Hex", { exact: true })).toHaveValue("#3366cc");
  await shell.getByLabel("Hex", { exact: true }).fill("#3e4f86");
  await shoot("create-bot-colors");
  // Escape closes only the color picker.
  await page.keyboard.press("Escape");
  await expect(shell).toBeHidden();
  await expect(studio).toBeVisible();
  await expect(eyes.getByRole("radio", { name: "Wink", exact: true })).toHaveAttribute("aria-checked", "true");
  await shoot("create-bot-picker");
  await studio.getByRole("button", { name: "Save", exact: true }).click();
  await expect(studio).toHaveCount(0);
  await dialog.getByLabel("Name", { exact: true }).fill("Ranger");
  await shoot("create-bot");
  await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect.poll(async () => (await bot("Ranger"))?.look).toEqual({ head: "orbit", palette: "custom", eyes: "wink", colors: ["#3e4f86", "#dfae52", "#f4e8c4", "#373722"] });
  const ranger = await bot("Ranger");
  assert.match(ranger.instructions, /Cite your sources/);
  await page.evaluate(() =>
    window.botkins.addBot({
      name: "Quill",
      role: "Writing partner",
      instructions: "Help me write.",
      face: "idle",
      look: { head: "muse", palette: "fern" },
    }),
  );
  await main.getByRole("button", { name: "Options for Quill", exact: true }).waitFor();

  // Pin.
  await menuFor("Ranger");
  await item("Pin").click();
  await expect.poll(async () => (await bot("Ranger")).pinned).toBe(true);

  // A new section from the Move to section submenu.
  await menuFor("Quill");
  await item("Move to section").click();
  await item("New section…").click();
  await page.getByRole("dialog", { name: "New section" }).getByLabel("Section name").fill("Writing");
  await page.getByRole("dialog", { name: "New section" }).getByRole("button", { name: "Create section" }).click();
  await expect
    .poll(async () => {
      const s = await snapshot();
      return s.sections.find((x) => x.id === s.bots.find((b) => b.name === "Quill").sectionId)?.name;
    })
    .toBe("Writing");
  await main.locator(".botgroup-head", { hasText: "Writing" }).first().waitFor();

  // Hide, find it under Hidden, and show it again.
  await menuFor("Quill");
  await item("Hide").click();
  await expect.poll(async () => (await bot("Quill")).hidden).toBe(true);
  await expect(main.getByRole("button", { name: "Options for Quill", exact: true })).toHaveCount(0);
  await expect(page.locator("aside .botnav-item", { hasText: "Quill" })).toHaveCount(0);
  // On Home the bots' search and filters wait behind one button.
  await main.getByRole("button", { name: "Bot tools", exact: true }).click();
  await main.getByRole("button", { name: "Hidden · 1" }).first().click();
  await menuFor("Quill");
  await item("Show").click();
  await expect.poll(async () => (await bot("Quill")).hidden).toBe(false);
  await main.getByRole("button", { name: "All", exact: true }).first().click();

  // Make primary.
  await menuFor("Quill");
  await item("Make primary").click();
  await expect.poll(async () => (await snapshot()).bots[0].name).toBe("Quill");
  await main.locator(".botcard-wrap", { hasText: "Quill" }).locator(".botbadge", { hasText: "Primary" }).waitFor();
  assert.equal(await page.locator("aside .botnav-item .botnav-name").first().textContent(), "Quill");

  // Chats for the Chats page and the bot page.
  const [c1, c2] = await page.evaluate(async (id) => [
    await window.botkins.createChat(id),
    await window.botkins.createChat(id),
  ], ranger.id);
  await page.evaluate(async (id) => {
    await window.botkins.renameChat(id, "Draft notes");
    await window.botkins.setChatFlags(id, { unread: true });
  }, c2);
  await shoot("home");

  // The bot page, from the sidebar's right-click menu.
  await page.locator("aside .botnav-item", { hasText: "Ranger" }).click({ button: "right" });
  await item("Bot page").click();
  await main.getByRole("heading", { name: "Ranger", level: 1 }).waitFor();
  await main.locator(".profile-portrait .bot-avatar").waitFor();
  await shoot("bot-page-top");
  // Bot Studio opens on the saved look and saves a new palette straight to the bot.
  await main.getByRole("button", { name: "Bot Studio", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Bot Studio" });
  await expect(editor.getByRole("radiogroup", { name: "Character" }).getByRole("radio", { name: "Orbit", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(editor.getByRole("radiogroup", { name: "Eyes" }).getByRole("radio", { name: "Wink", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(editor.getByRole("group", { name: "Custom colors" }).getByRole("button", { name: "Shell color, #3e4f86", exact: true })).toBeVisible();
  await editor.getByRole("radiogroup", { name: "Palette" }).getByRole("radio", { name: "Fig", exact: true }).click();
  await shoot("edit-avatar");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  // A kit palette drops the custom colors and keeps the eyes.
  await expect.poll(async () => (await bot("Ranger")).look).toEqual({ head: "orbit", palette: "fig", eyes: "wink" });
  const about = main.getByPlaceholder("A line about what this bot is for");
  await expect(about).toHaveValue("Finds primary sources.");
  await about.fill("Digs up sources and sums them up.");
  await main.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await bot("Ranger")).summary).toBe("Digs up sources and sums them up.");
  await main.getByText("2 chats").waitFor();
  await shoot("bot-page");

  // Chats: rename, archive, restore, unread.
  await nav("Chats");
  await main.locator(".rowwrap .unread-dot").first().waitFor();
  const row = (title) => main.locator(".rowwrap", { hasText: title });
  const titleOf = async (id) => (await snapshot()).chats.find((c) => c.id === id).title;
  const first = await titleOf(c1);
  await row(first).getByRole("button", { name: "Chat options" }).click();
  await item("Rename…").click();
  await page.getByRole("dialog", { name: "Rename chat" }).getByLabel("Title").fill("Source review");
  await page.getByRole("dialog", { name: "Rename chat" }).getByRole("button", { name: "Rename" }).click();
  await expect.poll(() => titleOf(c1)).toBe("Source review");
  await row("Source review").click({ button: "right" });
  await item("Archive").click();
  await expect.poll(async () => (await snapshot()).chats.find((c) => c.id === c1).archived).toBe(true);
  await expect(row("Source review")).toHaveCount(0);
  await main.getByRole("button", { name: "Archived · 1" }).click();
  await row("Source review").getByRole("button", { name: "Chat options" }).click();
  await item("Restore").click();
  await expect.poll(async () => (await snapshot()).chats.find((c) => c.id === c1).archived).toBe(false);
  await main.getByRole("button", { name: "All", exact: true }).last().click();
  await row("Source review").waitFor();
  await shoot("chats");

  // Opening an unread chat marks it read.
  await row(await titleOf(c2)).locator(".row").click();
  await expect.poll(async () => (await snapshot()).chats.find((c) => c.id === c2).unread).toBe(false);
  await main.locator(".emptychat .bot-avatar").waitFor();
  await shoot("chat");

  assert.deepEqual(errors, [], "no page errors");
  console.log(
    "Botkin looks, Bot Studio, template bot creation, pin, sections, hide and show, primary, bot page edit, and chat rename, archive, restore and read passed.",
  );
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
