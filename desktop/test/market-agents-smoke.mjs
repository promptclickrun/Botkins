// Isolated Electron renderer smoke for Marketplace › Agents: the Marketplace button beside New chat,
// a local marketplace's agent templates, a template's page, and Install filling in Create a bot.
// It uses a local marketplace folder for its templates. Run after `npm run build`:
//   node test/market-agents-smoke.mjs        (BOTKINS_QA_DIR=<folder> keeps screenshots)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-market-agents-"));
const market = join(root, "market");
mkdirSync(join(market, ".github", "plugin"), { recursive: true });
mkdirSync(join(market, "agents"), { recursive: true });
const template = (name, role, summary, look) => JSON.stringify({ format: "botkins.bot-template", version: 1, name, role, summary, instructions: "You help me with " + role.toLowerCase() + ".\n\nAsk before you send or delete anything.", look });
writeFileSync(join(market, "agents", "sorter.json"), template("Sorter", "Inbox triage", "Sorts your inbox into what needs you today and what can wait.", { head: "pip", palette: "fern" }));
writeFileSync(join(market, "agents", "quill.json"), template("Quill", "Editor and proofreader", "Tightens your drafts and catches the typos.", { head: "muse", palette: "fig" }));
writeFileSync(join(market, "agents", "coach.json"), template("Coach", "Training coach", "Plans your workouts and keeps you honest.", { head: "pounce", palette: "honey" }));
writeFileSync(join(market, ".github", "plugin", "marketplace.json"), JSON.stringify({
  name: "local-agent-market",
  plugins: [],
  agents: [
    { name: "sorter", source: "./agents/sorter.json", category: "productivity", version: "1.0.0", author: { name: "Botkins" } },
    { name: "quill", source: "./agents/quill.json", category: "writing", version: "1.0.0" },
    { name: "coach", source: "./agents/coach.json", category: "health", version: "1.0.0" },
  ],
}));
seedApp(root);

const qa = process.env.BOTKINS_QA_DIR;
if (qa) mkdirSync(qa, { recursive: true });
const shot = async (page, name) => qa && (await page.screenshot({ path: join(qa, name + ".png") }));

const binary = process.env.BOTKINS_BINARY;
const env = { ...process.env, BOTKINS_DATA_DIR: root, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
const errors = [];
let page;
const call = (name, ...args) => page.evaluate(({ name, args }) => window.botkins[name](...args), { name, args });
try {
  page = await home(app);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });
  // Only the local fixture is needed. Treat the public catalog as offline.
  await app.evaluate(() => { globalThis.fetch = async () => { throw new Error("Offline smoke"); }; });
  assert.equal((await call("plugins.addMarketplace", market)).name, "local-agent-market");

  // The Marketplace button sits left of New chat at the top of the side menu, and opens Marketplace.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.waitForTimeout(300);
  const expand = page.getByRole("button", { name: "Expand side menu", exact: true });
  if (await expand.count()) await expand.click();
  await page.waitForTimeout(600);
  const brand = page.locator("aside .brand");
  const order = await brand.locator("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
  assert.deepEqual(order.slice(0, 2), ["Marketplace", "New chat"], "Marketplace sits left of New chat");
  await shot(page, "sidebar-top");
  await brand.getByRole("button", { name: "Marketplace", exact: true }).click();
  const dialog = page.locator("dialog.settings-window");
  await dialog.getByRole("heading", { name: "Marketplace", exact: true }).waitFor();

  // Agents: the local templates, with their categories as chips.
  await dialog.getByRole("tab", { name: "Agents", exact: true }).click();
  const mine = dialog.locator(".agent-listing", { hasText: "local-agent-market" });
  const listing = (text) => mine.filter({ hasText: text });
  const sorter = listing("Sorter");
  await sorter.waitFor({ timeout: 60000 });
  await expect(sorter).toContainText("Sorts your inbox");
  await expect(sorter).toContainText("Productivity · local-agent-market");
  await shot(page, "agents-list");
  await dialog.getByRole("button", { name: /^Writing/ }).click();
  await expect(listing("Quill")).toBeVisible();
  await expect(listing("Sorter")).toHaveCount(0);
  await dialog.getByRole("button", { name: /^All/ }).click();
  await dialog.getByRole("searchbox", { name: "Search agents" }).fill("inbox");
  await expect(mine).toHaveCount(1);
  await dialog.getByRole("searchbox", { name: "Search agents" }).fill("");

  // A template's page: its Botkin, role, where it is from, and its instructions as they will be given.
  await listing("Sorter").click();
  await dialog.getByRole("heading", { name: "Sorter", exact: true }).waitFor();
  await expect(dialog.locator(".agent-detail")).toContainText("Inbox triage");
  await expect(dialog.locator(".agent-detail")).toContainText("Productivity · local-agent-market · v1.0.0 · Botkins");
  await expect(dialog.locator(".agent-instructions")).toContainText("Ask before you send or delete anything.");
  await expect(dialog.locator(".agent-detail")).toContainText("Someone else wrote these instructions");
  await shot(page, "agent-page");

  // Install opens Create a bot, filled in. The person changes the name and creates it.
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  const sheet = page.locator("dialog.bot-sheet");
  await sheet.getByRole("heading", { name: "Create a bot", exact: true }).waitFor();
  await expect(sheet.locator("input[name=name]")).toHaveValue("Sorter");
  await expect(sheet.locator("input[name=role]")).toHaveValue("Inbox triage");
  await expect(sheet.locator("input[name=summary]")).toHaveValue("Sorts your inbox into what needs you today and what can wait.");
  await expect(sheet.locator("textarea[name=instructions]")).toHaveValue(/Ask before you send or delete anything\./);
  await expect(sheet.getByRole("note")).toContainText("From local-agent-market. Someone else wrote these instructions: read them first.");
  await expect(sheet.getByRole("button", { name: "Start from template", exact: true })).toBeVisible();
  await shot(page, "create-bot-filled");
  await sheet.locator("input[name=name]").fill("Sorter Two");
  await sheet.getByRole("button", { name: "Create bot", exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
  const made = (await call("snapshot")).bots.find((bot) => bot.name === "Sorter Two");
  assert.ok(made, "the bot was made");
  assert.equal(made.role, "Inbox triage");
  assert.equal(made.summary, "Sorts your inbox into what needs you today and what can wait.");
  assert.match(made.instructions, /Ask before you send or delete anything\./);
  assert.deepEqual({ head: made.look?.head, palette: made.look?.palette }, { head: "pip", palette: "fern" });

  // Create a bot opened plainly starts empty again.
  await page.getByRole("button", { name: "Create bot", exact: true }).first().click();
  await page.locator("dialog.bot-sheet").getByRole("heading", { name: "Create a bot", exact: true }).waitFor();
  await expect(page.locator("dialog.bot-sheet input[name=name]")).toHaveValue("");
  assert.deepEqual(errors, []);
  console.log("market agents smoke: ok");
} finally {
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
