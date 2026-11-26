// Smoke for bot templates: save a bot as a template, export it as a file, import a file someone shared,
// create a bot from it, and delete a template. Native file dialogs are stubbed to temporary paths.
// Set TEMPLATES_SHOTS to a folder to save light and dark screenshots.
import { stubTemplate } from "./template-fixture.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-templates-"));
const shots = process.env.TEMPLATES_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
try {
  const page = await home(app);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  const snapshot = () => page.evaluate(() => window.botkins.snapshot());
  const main = page.locator("main");
  const dialog = page.getByRole("dialog");
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
  const stubDialogs = (save, open) =>
    app.evaluate(({ dialog }, [save, open]) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: save });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [open] });
    }, [save, open]);

  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  // Save Scout as a template and export it from its bot page.
  await main.getByRole("button", { name: "Options for Scout", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bot page", exact: true }).click();
  await main.getByRole("button", { name: "Save as template", exact: true }).click();
  await main.getByText("Saved as a template.").waitFor();
  const scout = (await snapshot()).bots.find((b) => b.name === "Scout");
  const savedTemplate = (await snapshot()).templates.find((t) => t.name === "Scout");
  assert.deepEqual([savedTemplate.role, savedTemplate.instructions, savedTemplate.source], [scout.role, scout.instructions, "saved"]);
  const exported = join(dir, "Scout.json");
  const shared = join(dir, "From a friend.json");
  await stubDialogs(exported, shared);
  await main.getByRole("button", { name: "Export template…", exact: true }).click();
  await main.getByText("Template exported.").waitFor();
  const file = JSON.parse(readFileSync(exported, "utf8"));
  assert.equal(file.format, "botkins.bot-template");
  assert.equal(file.instructions, scout.instructions);
  assert.equal(JSON.stringify(file).includes(dir), false, "no local paths in the shared file");

  // Someone else edits it and shares it back; import it in Create a bot and make a bot from it.
  const bundle = { skills: [{ name: "check-source", description: "Check a citation.", instructions: "Read the source before trusting the claim." }] };
  writeFileSync(shared, JSON.stringify({ ...file, version: 2, bundle, name: "Fact Finder", role: "Checks claims", summary: "Finds the source", instructions: "Check every claim against a primary source." }));
  await page.getByRole("navigation").getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  await stubTemplate(app);
  await dialog.getByRole("button", { name: "Start from template", exact: true }).click();
  await dialog.getByRole("group", { name: "Your templates" }).getByRole("button", { name: "Scout", exact: true }).waitFor();
  await shoot("create-bot-template-menu");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await dialog.getByRole("button", { name: "Import from file…", exact: true }).click();
  // Importing picks the template and closes the menu; reopen it to see the choice.
  await dialog.getByRole("button", { name: "Start from template", exact: true }).click();
  await expect(dialog.getByRole("group", { name: "Your templates" }).getByRole("button", { name: "Fact Finder", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("group", { name: "Your templates" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByText("Someone else wrote these instructions").waitFor();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Fact Finder");
  await expect(dialog.getByLabel("Role", { exact: true })).toHaveValue("Checks claims");
  await expect(dialog.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Check every claim against a primary source.");
  await expect(dialog.locator(".template-bundle")).toContainText("check-source");
  await shoot("create-bot-templates");
  await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect.poll(async () => (await snapshot()).bots.find((b) => b.name === "Fact Finder")?.summary).toBe("Finds the source");
  assert.deepEqual((await snapshot()).bots.find((b) => b.name === "Fact Finder").bundle, bundle);
  const imported = (await snapshot()).templates.find((t) => t.name === "Fact Finder");
  assert.deepEqual([imported.source, imported.from], ["imported", "From a friend.json"]);

  // A marketplace template fills the form, and a saved template can be deleted.
  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  await dialog.getByRole("button", { name: "Start from template", exact: true }).click();
  await dialog.getByRole("group", { name: "Your templates" }).getByRole("button", { name: "Fact Finder", exact: true }).click();
  await expect(dialog.locator(".template-bundle")).toContainText("check-source");
  await dialog.getByRole("button", { name: "Start from template", exact: true }).click();
  await dialog.getByRole("button", { name: /Archive Guide/ }).click();
  await expect(dialog.locator(".template-bundle")).toHaveCount(0);
  await expect(dialog.getByLabel("Role", { exact: true })).toHaveValue("Research assistant");
  await dialog.getByRole("button", { name: "Start from template", exact: true }).click();
  await dialog.getByRole("button", { name: "Options for template Scout", exact: true }).click();
  await dialog.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(async () => (await snapshot()).templates.some((t) => t.name === "Scout")).toBe(false);
  assert.deepEqual(errors, []);
  console.log("Templates: save from a bot, export a file, import a shared file with a review note, create a bot from it, marketplace templates and delete passed.");
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
