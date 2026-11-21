// Non-live smoke for a first launch with no bots. With agents in the person's Copilot home it offers
// them as bots (choose, Create a new bot instead, Add); with none it opens on the Create a bot form.
// Also covers the agents section of the Create a bot sheet and a second launch.
// Uses isolated data folders and a made-up Copilot home; the real ~/.copilot is never read.
// Set FIRSTRUN_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { signedInAs } from "./welcome-helper.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-first-run-"));
const shots = process.env.FIRSTRUN_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const errors = [];
let app, page;
async function start(data, home) {
  // Only GitHub Copilot, whose agents this smoke imports, whatever other providers this computer has.
  const env = { ...process.env, BOTKINS_DATA_DIR: join(root, data), COMMANDER_DATA_DIR: join(root, data), COPILOT_HOME: join(root, home), BOTKINS_PROVIDERS: "copilot", COMMANDER_PROVIDERS: "copilot" };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  // Signed in as a made-up account, so the welcome offers Get started whatever this computer's sign-in is.
  await signedInAs(app);
  await page.reload();
  await page.waitForFunction(() => !!window.botkins);
}
async function shoot(name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), theme);
    await page.locator(`html[data-mode="${theme}"]`).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
}
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const snapshot = () => page.evaluate(() => window.botkins.snapshot());
const button = (name) => page.getByRole("button", { name, exact: true });
const heading = (name) => page.getByRole("heading", { name, exact: true });

try {
  // ---- 1. A computer with Copilot agents ----
  mkdirSync(join(root, "home", "agents"), { recursive: true });
  await start("with-agents", "home");
  await heading("Welcome to Botkins").waitFor();
  assert.deepEqual((await snapshot()).bots, [], "a new workspace has no bots");
  // An agent's model carries over when the account has it. Signed out, there is no model list to match.
  const models = await page.evaluate(() => window.botkins.models().catch(() => []));
  const model = models.find((m) => m.available && m.id !== "auto");
  const agentFile = (name) => join(root, "home", "agents", name);
  const backend =
    "---\nname: backend-development\ndescription: Backend development specialist for APIs, services, data models, auth, integrations, queues and workers. Use for backend feature work.\n" +
    (model ? "model: " + model.id + "\n" : "") +
    "tools: ['*']\n---\n\nYou are the backend development specialist.\n\n1. Build the real feature end to end.\n";
  const reviewer =
    "---\ndescription: >\n  Reviews a change for bugs\n  and missed cases.\nmodel: not-a-model\ntools:\n  - read\n  - search\n---\nReview the diff. Report findings by severity.\n";
  writeFileSync(agentFile("backend-development.agent.md"), backend);
  writeFileSync(agentFile("reviewer.agent.md"), reviewer);
  writeFileSync(agentFile("huge.agent.md"), "---\nname: huge\ndescription: Too long to use.\n---\n" + "x".repeat(30001));
  writeFileSync(agentFile("README.md"), "# Notes\n\nNot an agent.");

  await button("Get started").click();
  await heading("Bring in your agents").waitFor();
  await expect(heading("Home")).toHaveCount(0);
  await page.getByText("Botkins found 2 agents you already use with GitHub Copilot.", { exact: false }).waitFor();
  const list = page.getByRole("list", { name: "Your GitHub Copilot agents" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  const box = (name) => list.getByRole("checkbox", { name, exact: true });
  await expect(box("Backend Development")).toBeChecked();
  await expect(box("Reviewer")).toBeChecked();
  await expect(box("Huge")).toBeDisabled();
  await expect(box("Huge")).not.toBeChecked();
  await list.getByText("Can't be added. Its instructions are longer than 30,000 characters.").waitFor();
  await list.getByText("Reviews a change for bugs and missed cases.").waitFor();
  await list.getByText("Sets its own tools in GitHub Copilot.", { exact: false }).waitFor();
  if (model) await list.getByText(model.name, { exact: true }).waitFor();
  // A model the account doesn't have is said plainly; signed out, nothing is known about models.
  const missing = list.getByText("Its model, not-a-model, isn't on your account. The bot will use your default model.");
  if (models.length) await missing.waitFor();
  else await expect(missing).toHaveCount(0);

  // The button says how many bots it will make.
  await button("Add 2 bots").waitFor();
  await box("Reviewer").uncheck();
  await button("Add 1 bot").waitFor();
  await box("Backend Development").uncheck();
  await expect(button("Choose an agent")).toBeDisabled();
  await box("Backend Development").check();
  await box("Reviewer").check();
  await button("Add 2 bots").waitFor();
  await shoot("agents");
  await size(760, 560);
  await button("Create a new bot instead").scrollIntoViewIfNeeded();
  await shoot("agents-min");
  await size(1190, 830);

  // Create a new bot instead: the form, which can still start from an agent. Back keeps the choices.
  await button("Create a new bot instead").click();
  await heading("Create your first bot").waitFor();
  await page.getByRole("button", { name: "Start from a template" }).click();
  const group = page.getByRole("group", { name: "Your GitHub Copilot agents" });
  await expect(group.getByRole("button", { name: "Huge", exact: true })).toBeDisabled();
  await group.getByRole("button", { name: "Reviewer", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Reviewer");
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("Reviews a change for bugs and missed cases");
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Review the diff. Report findings by severity.");
  await page.getByRole("note").getByText("Copied from your GitHub Copilot agent reviewer", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Agent: Reviewer" }).waitFor();
  await shoot("form-from-agent");
  await button("Back to your agents").click();
  await heading("Bring in your agents").waitFor();
  assert.deepEqual((await snapshot()).bots, [], "nothing is made until the person asks");

  await button("Add 2 bots").click();
  await heading("Home").waitFor();
  let bots = (await snapshot()).bots;
  assert.deepEqual(bots.map((b) => [b.name, b.role]), [
    ["Backend Development", "Backend development specialist"],
    ["Reviewer", "Reviews a change for bugs and missed cases"],
  ]);
  assert.equal(bots[0].instructions, "You are the backend development specialist.\n\n1. Build the real feature end to end.");
  assert.deepEqual(bots[0].origin, { provider: "copilot", agent: "backend-development", file: agentFile("backend-development.agent.md") });
  assert.equal(bots[0].model?.model, model?.id, "the agent's model carries over when the account has it");
  assert.equal(bots[1].model, undefined);
  assert.ok(bots[0].look?.head && bots[0].look.head !== bots[1].look?.head, "each bot gets its own look");
  // The first agent is the primary bot: Home's message box talks to it.
  await page.getByPlaceholder("Ask Backend Development…").waitFor();
  await shoot("home-after-import");

  // Create a bot later: agents that are bots already say so, and can still be used as a start.
  await button("Add bot").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Start from a template", exact: true }).click();
  const menu = dialog.getByRole("group", { name: "Your GitHub Copilot agents" });
  await menu.getByText("Already a bot · Backend development specialist").waitFor();
  await shoot("create-bot-agents");
  await menu.getByRole("button", { name: "Backend Development", exact: true }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Backend Development");
  await dialog.getByLabel("Name", { exact: true }).fill("Bea");
  await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(dialog).toBeHidden();
  bots = (await snapshot()).bots;
  assert.deepEqual(bots.map((b) => b.name), ["Backend Development", "Reviewer", "Bea"]);
  assert.equal(bots[2].origin.agent, "backend-development");
  assert.equal(bots[2].model?.model, model?.id);

  // Botkins only reads the agent files.
  assert.equal(readFileSync(agentFile("backend-development.agent.md"), "utf8"), backend);
  assert.equal(readFileSync(agentFile("reviewer.agent.md"), "utf8"), reviewer);
  await app.close();

  // A second launch opens the workspace: the bots are there, so the first-run step is gone.
  await start("with-agents", "home");
  await heading("Home").waitFor({ timeout: 30000 });
  await expect(heading("Bring in your agents")).toHaveCount(0);
  assert.equal((await snapshot()).bots.length, 3);
  await app.close();

  // ---- 2. A computer with no Copilot agents: the Create a bot form ----
  mkdirSync(join(root, "empty-home"), { recursive: true });
  await start("no-agents", "empty-home");
  await heading("Welcome to Botkins").waitFor();
  await button("Get started").click();
  await heading("Create your first bot").waitFor();
  await expect(heading("Home")).toHaveCount(0);
  await expect(button("Back to your agents")).toHaveCount(0);
  await page.getByRole("button", { name: "Start from a template" }).click();
  await page.getByRole("group", { name: "Built-in templates" }).waitFor();
  await expect(page.getByRole("group", { name: /agents$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await shoot("create-first-bot");
  await size(760, 560);
  await shoot("create-first-bot-min");
  await size(1190, 830);
  // The form's own checks still apply.
  await page.getByLabel("Name", { exact: true }).fill("Nova");
  await page.getByLabel("Role", { exact: true }).fill("Everyday helper");
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Help me plan my day.");
  await button("Create bot").click();
  await heading("Home").waitFor();
  bots = (await snapshot()).bots;
  assert.deepEqual(bots.map((b) => [b.name, b.role, b.instructions, b.origin]), [["Nova", "Everyday helper", "Help me plan my day.", undefined]]);
  await page.getByPlaceholder("Ask Nova…").waitFor();
  await app.close();

  assert.deepEqual(errors, [], "no page errors");
  console.log("first-run smoke: ok" + (model ? " (model " + model.id + " carried over)" : " (no model list; model carry-over not checked)"));
} finally {
  await app?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
