// Isolated Electron renderer smoke for Settings › Marketplace. It uses a local marketplace folder
// only, never GitHub or the person's real Copilot data. Run after `npm run build`:
//   node test/plugins-smoke.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-plugin-ui-"));
const data = root;
const market = join(root, "market");
const plugin = join(market, "plugins", "fixture");
mkdirSync(join(market, ".github", "plugin"), { recursive: true });
mkdirSync(join(plugin, "hooks"), { recursive: true });
writeFileSync(join(market, ".github", "plugin", "marketplace.json"), JSON.stringify({
  name: "local-fixture-market",
  plugins: [{ name: "fixture", source: "plugins/fixture", description: "A local plugin fixture", version: "1.0.0" }],
}));
const manifest = (version) => JSON.stringify({
  name: "fixture",
  version,
  description: "A local plugin fixture",
  userConfig: { FIXTURE_SECRET: { title: "Fixture secret", sensitive: true, required: true } },
});
writeFileSync(join(plugin, "plugin.json"), manifest("1.0.0"));
// The first hook's command has two lines and a mark that turns text around: the window must show
// all of it, with the mark as its number. The second has a matcher, so Botkins does not run it.
const TURN = "\u202e";
const hookCommand = "node ${PLUGIN_ROOT}/hook.mjs --first\necho done " + TURN + "txt.exe # " + "long ".repeat(80) + "END-OF-COMMAND";
const hooksFile = (command) => JSON.stringify({ hooks: {
  userPromptSubmitted: [{ type: "command", bash: command, env: { HOOK_MODE: "quiet", HOOK_KEY: "${FIXTURE_SECRET}" }, timeoutSec: 10 }],
  preToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo never" }] }],
} });
writeFileSync(join(plugin, "hooks", "hooks.json"), hooksFile(hookCommand));
writeFileSync(join(plugin, "hook.mjs"), "console.log(JSON.stringify({ additionalContext: 'fixture' }));\n");
// Two tools, never started here (no chat runs): a program with arguments, a folder and an
// environment, and an address with a header. One argument has a space in it.
mkdirSync(join(plugin, "server"), { recursive: true });
writeFileSync(join(plugin, "server", "main.mjs"), "// fixture\n");
writeFileSync(join(plugin, ".npmrc"), "registry=https://registry.example.invalid/\n");
writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: {
  notes: { command: "node", args: ["main.mjs", "--title", "two words", "--port", 3000], env: { NOTES_TOKEN: "${FIXTURE_SECRET}", NOTES_MODE: "fast", NODE_OPTIONS: "--require ./x.js" }, cwd: "server" },
  docs: { type: "sse", url: "https://docs.example.invalid/mcp", headers: { Authorization: "Bearer ${FIXTURE_SECRET}" } },
} }));
seedApp(root);

const binary = process.env.BOTKINS_BINARY;
const env = { ...process.env, BOTKINS_DATA_DIR: data, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
let page;
const errors = [];
const settings = () => page.locator("dialog.settings-window");
async function openMarketplace() {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = settings();
  await dialog.getByRole("tab", { name: "Marketplace", exact: true }).click();
  await dialog.getByRole("heading", { name: "Marketplace", exact: true }).waitFor();
  // Marketplace opens on the view last looked at (Apps the first time): these checks are in Plugins.
  await dialog.getByRole("tab", { name: "Plugins", exact: true }).click();
  return dialog;
}
async function snapshot() { return page.evaluate(() => window.botkins.snapshot()); }
async function call(name, ...args) { return page.evaluate(({ name, args }) => window.botkins[name](...args), { name, args }); }
// What the window sends with a switch-on and a choice of bots, as the app's own handler gets it.
async function recordCalls() {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__pluginCalls = [];
    for (const name of ["plugins.setEnabled", "plugins.setBots"]) {
      const real = ipcMain._invokeHandlers.get(name);
      ipcMain.removeHandler(name);
      ipcMain.handle(name, (event, ...args) => {
        globalThis.__pluginCalls.push([name, ...args]);
        return real(event, ...args);
      });
    }
  });
}
const pluginCalls = () => app.evaluate(() => globalThis.__pluginCalls);
const clickAsk = (title, button) => page.getByRole("dialog", { name: title, exact: true }).getByRole("button", { name: button, exact: true }).click();
const RUNS = "This plugin runs commands on this computer";

try {
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.title(), "Botkins", "desktop renderer keeps the app page name");

  // Add a local marketplace through the real desktop bridge, then refresh the renderer so the
  // Settings component exercises its initial marketplaces/browse loads.
  const addedMarket = await call("plugins.addMarketplace", market);
  assert.equal(addedMarket.name, "local-fixture-market");
  await page.reload();
  await skipWelcome(page);
  let dialog = await openMarketplace();
  await dialog.getByRole("button", { name: "local-fixture-market", exact: true }).click();
  await dialog.locator(".plugin-listing", { hasText: "fixture" }).waitFor({ timeout: 30000 });

  // Browse → preview → explicit executable approval → install.
  await dialog.locator(".plugin-listing", { hasText: "fixture" }).click();
  await dialog.getByRole("heading", { name: "fixture", exact: true }).waitFor();
  await dialog.getByText("What this plugin adds", { exact: true }).waitFor();

  // ---- What the plugin starts is shown whole, before anything is installed.
  // The program: its whole line word by word (a word with a space stays one word), its folder,
  // each environment name with its value, and the name that Botkins does not set, with the reason.
  const notes = dialog.getByRole("group", { name: "Tool notes", exact: true });
  assert.deepEqual(await notes.locator(".plugin-words span").allInnerTexts(), ["node", "main.mjs", "--title", "two words", "--port", "3000"]);
  await expect(notes).toContainText("In folder");
  await expect(notes).toContainText("server (in the plugin’s own folder)");
  assert.deepEqual(await notes.locator("dd .plugin-value").allInnerTexts(), ["server (in the plugin’s own folder)", "NOTES_TOKEN = ${FIXTURE_SECRET}", "NOTES_MODE = fast"]);
  await expect(notes).toContainText("Not set by Botkins");
  await expect(notes.locator(".plugin-reason")).toContainText("NODE_OPTIONS");
  await expect(notes.locator(".plugin-reason small")).toContainText("NODE_");
  // The address: that it is a stream, and each header with its written value. No secret is in it.
  const docs = dialog.getByRole("group", { name: "Tool docs", exact: true });
  assert.deepEqual(await docs.locator("dd .plugin-value").allInnerTexts(), ["https://docs.example.invalid/mcp (stream)", "Authorization = Bearer ${FIXTURE_SECRET}"]);
  // The hook: the whole command with its two lines, nothing cut, the mark written as its number.
  const hook = dialog.getByRole("group", { name: "Hook: Each message you send", exact: true });
  const shownCommand = await hook.locator(".plugin-command").innerText();
  assert.equal(shownCommand, hookCommand.replace(TURN, "\\u{202e}"), "the hook's command is whole, with the mark as its number");
  assert.ok(!(await dialog.innerText()).includes(TURN), "no mark that turns text around reaches the page");
  const box = await hook.locator(".plugin-command").evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth, cut: getComputedStyle(node).textOverflow }));
  assert.ok(box.scroll <= box.client + 1 && box.cut !== "ellipsis", "the command wraps and is not cut: " + JSON.stringify(box));
  await expect(hook).toContainText("Time limit");
  await expect(hook).toContainText("10 seconds");
  assert.deepEqual(await hook.locator("dd .plugin-value").allInnerTexts(), ["HOOK_MODE = quiet", "HOOK_KEY = ${FIXTURE_SECRET}"]);
  // What is not run, with the computer's reason, and the other files with the one that tools read by themselves.
  const added = dialog.locator(".set-group", { hasText: "What this plugin adds" });
  await expect(added.locator(".plugin-content-list", { hasText: "Not run" }).locator(".plugin-reason code")).toHaveText(["Hook · preToolUse"]);
  const otherFiles = added.locator(".plugin-content-list", { hasText: "Other files" });
  await expect(otherFiles).toContainText("Files that tools read by themselves");
  await expect(otherFiles.locator("li")).toContainText([".npmrc"]);
  if (process.env.BOTKINS_QA_DIR) {
    mkdirSync(process.env.BOTKINS_QA_DIR, { recursive: true });
    await notes.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "plugin-tools.png") });
    await hook.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "plugin-hook.png") });
    await otherFiles.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "plugin-other.png") });
  }

  await dialog.getByRole("button", { name: "Install plugin", exact: true }).click();
  // The question is asked from the description, with the computer's own warning as it comes.
  const asked = page.getByRole("dialog", { name: RUNS, exact: true });
  await expect(asked).toContainText("Only go on if you trust this plugin.");
  await asked.getByRole("button", { name: "Install", exact: true }).click();
  const install = page.getByRole("dialog", { name: "Install plugin", exact: true });
  // Where the setting's value goes, under its field.
  await expect(install.locator(".plugin-sent")).toHaveText([
    "Sent to the tool notes as NOTES_TOKEN",
    "Sent to the tool docs at https://docs.example.invalid/mcp in the header Authorization",
    "Sent to the hook “Each message you send” as HOOK_KEY",
  ]);
  await install.getByLabel(/Fixture secret/).fill("  initial fixture secret  ");
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByText("Installed fixture.", { exact: true }).waitFor({ timeout: 30000 });
  let state = await snapshot();
  assert.equal(state.plugins.length, 1);
  assert.equal(state.plugins[0].enabled, true);

  // Settings are write-only in the snapshot. Opening and saving an untouched form must not send
  // defaults or clear the existing secret; its UI shows only the saved marker.
  dialog = settings();
  await dialog.getByRole("button", { name: /Edit settings/ }).click();
  const config = page.getByRole("dialog", { name: "Settings · fixture", exact: true });
  const secret = config.getByLabel(/Fixture secret/);
  assert.equal(await secret.inputValue(), "", "saved secret is not copied into the renderer");
  assert.equal(await secret.getAttribute("placeholder"), "Saved securely");
  await config.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Saved plugin settings.", { exact: true }).waitFor();

  // Scope and enablement refresh from the host's pushed State.plugins part.
  await recordCalls();
  const revision = (await snapshot()).plugins[0].revision;
  assert.match(revision, /^[a-f0-9]{64}$/);
  const useFor = dialog.getByLabel("Use for", { exact: true });
  await useFor.selectOption("selected");
  // These switches show what the app says, so they change when the app's answer arrives, not at the
  // click: the click is made, and what the app then says is waited for.
  await dialog.getByLabel("Pip", { exact: true }).click();
  await page.getByText("Updated which bots use fixture.", { exact: true }).waitFor();
  state = await snapshot();
  assert.deepEqual(state.plugins[0].bots, ["pip"]);
  const enabled = dialog.getByRole("switch", { name: "fixture enabled", exact: true });
  await enabled.click();
  await page.getByText("fixture is off.", { exact: true }).waitFor();
  assert.equal(await enabled.isChecked(), false);
  await enabled.click();
  await clickAsk(RUNS, "Turn on");
  await page.getByText("fixture is on.", { exact: true }).waitFor();
  // A switch-on and a choice of bots name the revision that was looked at. A switch-off names none.
  assert.deepEqual(await pluginCalls(), [
    ["plugins.setBots", state.plugins[0].id, ["pip"], { revision }],
    ["plugins.setEnabled", state.plugins[0].id, false],
    ["plugins.setEnabled", state.plugins[0].id, true, { revision }],
  ]);

  // The UI shows a fresh update preview, including the exact hook command, and retries with a
  // newly reviewed revision when the source changes while the person is deciding.
  writeFileSync(join(plugin, "plugin.json"), manifest("1.1.0"));
  writeFileSync(join(plugin, "hooks", "hooks.json"), hooksFile("echo fixture-v1.1"));
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  let review = page.getByRole("dialog", { name: "Review update · fixture", exact: true });
  await review.getByText("fixture-v1.1", { exact: false }).waitFor();
  writeFileSync(join(plugin, "plugin.json"), manifest("1.2.0"));
  writeFileSync(join(plugin, "hooks", "hooks.json"), hooksFile("echo fixture-v1.2"));
  await review.getByRole("button", { name: "Approve update", exact: true }).click();
  await clickAsk(RUNS, "Update");
  review = page.getByRole("dialog", { name: "Review update · fixture", exact: true });
  await review.getByText("fixture-v1.2", { exact: false }).waitFor();
  await review.getByRole("button", { name: "Approve update", exact: true }).click();
  await clickAsk(RUNS, "Update");
  await page.getByText("Updated fixture.", { exact: true }).waitFor();
  state = await snapshot();
  assert.equal(state.plugins[0].version, "1.2.0");
  assert.deepEqual(state.plugins[0].bots, ["pip"], "update keeps the existing bot scope");
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  await dialog.getByRole("tab", { name: /Installed \(1\)/ }).waitFor();

  // Add the same source as a local folder plugin: the host switches it on, as an install does (the
  // window warns before a folder is added), and the renderer reflects the second State.plugins
  // entry without a reload.
  const local = await call("plugins.addFolder", plugin);
  assert.equal(local.enabled, true);
  await dialog.getByRole("tab", { name: /Installed \(2\)/ }).click();
  await dialog.locator(".plugin-listing", { hasText: "Computer" }).waitFor({ timeout: 30000 });

  // Remove the catalog plugin through its page and confirmation, then remove its marketplace.
  await dialog.locator(".plugin-listing", { hasText: "local-fixture-market" }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Remove fixture?", exact: true }).getByRole("button", { name: "Remove", exact: true });
  await remove.click();
  await page.getByText("Removed fixture.", { exact: true }).waitFor();
  state = await snapshot();
  assert.equal(state.plugins.length, 1);
  await dialog.getByRole("tab", { name: "Browse", exact: true }).click();
  const marketGroup = dialog.locator(".set-group", { hasText: "Marketplaces" });
  await marketGroup.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove local-fixture-market?", exact: true }).getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("Removed local-fixture-market.", { exact: true }).waitFor();
  assert.equal((await snapshot()).plugins.length, 1, "removing a marketplace keeps the folder plugin");

  // ---- What the computer says of a plugin that it switched off, of one that needs an update, of
  // a linked folder that could not be copied, and of a description without the mark. These states
  // come from an update of the app, so the window is given them as the app would send them.
  const empty = { skills: [], agents: [], commands: [], mcpServers: [], hooks: [], otherFiles: { count: 0, bytes: 0, files: [] } };
  const entry = (name, more) => ({ id: name + "@fixture", name, marketplace: "folder", installed: true, enabled: false, bots: "all", status: "ready", config: [], contents: empty, limits: "", installedAt: 1, revision: "a".repeat(64), starts: 1, ...more });
  const OFF = "Botkins switched this plugin off. An earlier version did not show all that it starts. Look at what it starts, and switch it on again if you agree.";
  const CHANGED = "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings.";
  const COPY = "This plugin folder was linked for its skills. Botkins could not copy it, so it is not used: the folder is gone. Put the folder right and start Botkins again, or remove it.";
  const current = await snapshot();
  current.plugins = [
    entry("held", { detail: OFF, contents: { ...empty, skills: ["skills/review/SKILL.md"], hooks: [{ event: "agentStop", command: "echo checked", env: [], timeoutSec: 5 }] }, warnings: ["Runs a command on your computer through plugin hooks."] }),
    entry("broken", { status: "error", detail: CHANGED, repair: "update" }),
    { ...entry("old-folder", { status: "error", detail: COPY, folder: join(root, "old-folder") }), id: "linked-1", revision: undefined, starts: undefined, contents: { skills: [], agents: [], commands: [], mcpServers: [], hooks: [] } },
    entry("unmarked", { starts: undefined, contents: { skills: [], agents: [], commands: [], mcpServers: [], hooks: [] } }),
  ];
  await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send("changed", state), current);
  await dialog.getByRole("tab", { name: /Installed \(4\)/ }).click();
  // Said one time, at the top of the page: closed with OK, and not there again.
  const notice = dialog.getByRole("status", { name: "Botkins switched off 2 plugins", exact: true });
  await expect(notice).toContainText("Botkins now shows everything a plugin runs on this computer. Review each one, then turn it on.");
  if (process.env.BOTKINS_QA_DIR) await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "plugins-switched-off.png") });
  await notice.getByRole("button", { name: "OK", exact: true }).click();
  await expect(notice).toHaveCount(0);
  const row = (name) => dialog.locator(".plugin-listing", { has: page.locator("strong", { hasText: new RegExp("^" + name + "$") }) });
  await expect(row("held").locator("em")).toContainText("Off · Needs review");
  await expect(row("unmarked").locator("em")).toContainText(/^Off · All bots/);
  await expect(row("old-folder").locator("em")).toContainText(/^Not used/);
  // The plugin's page: the computer's reason first, as it comes; turning it on asks from what it shows.
  await row("held").click();
  await expect(dialog.locator(".plugin-held")).toHaveText(OFF);
  await expect(dialog.locator(".set-group", { hasText: "Status" }).locator(".set-name")).toHaveText("Off · Needs review");
  await dialog.getByRole("switch", { name: "held enabled", exact: true }).click();
  const heldAsk = page.getByRole("dialog", { name: RUNS, exact: true });
  await expect(heldAsk.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
  await heldAsk.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  // An update is the way back: Update is offered from the mark, and the switch waits for it.
  await row("broken").click();
  await expect(dialog.locator(".plugin-held")).toHaveText(CHANGED);
  await expect(dialog.locator(".set-group", { hasText: "Status" }).getByRole("button", { name: "Update", exact: true })).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "broken enabled", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  // A linked folder that could not be copied: the reason, the folder, and Remove alone.
  await row("old-folder").click();
  await expect(dialog.locator(".set-group", { hasText: "Status" })).toContainText(COPY);
  await expect(dialog.locator(".set-group", { hasText: "Status" })).toContainText("old-folder");
  await expect(dialog.getByRole("switch")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  // A description without the mark is asked about always, also when it shows nothing that runs.
  await row("unmarked").click();
  await expect(dialog.locator(".plugin-warning").first()).toHaveText("This computer could not show everything this plugin runs.");
  await dialog.getByRole("switch", { name: "unmarked enabled", exact: true }).click();
  const unmarkedAsk = page.getByRole("dialog", { name: "This plugin may run commands on this computer", exact: true });
  await expect(unmarkedAsk).toContainText("This computer could not show everything this plugin runs. Go on only if you trust where the plugin comes from.");
  await expect(unmarkedAsk.getByRole("button", { name: "Turn on anyway", exact: true })).toBeVisible();
  await unmarkedAsk.getByRole("button", { name: "Cancel", exact: true }).click();
  // Where the skills are missed: one notice in Skills, and its button leads to the plugin's page.
  await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
  const missed = dialog.getByRole("status", { name: "Skills from held are off", exact: true });
  await expect(missed).toContainText("They are part of a plugin that is switched off. Review it, then turn it on.");
  await expect(dialog.getByRole("status", { name: /^Skills from/ })).toHaveCount(1);
  if (process.env.BOTKINS_QA_DIR) await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "skills-off.png") });
  await missed.getByRole("button", { name: "Open plugin", exact: true }).click();
  await dialog.getByRole("heading", { name: "held", exact: true }).waitFor();
  await expect(dialog.locator(".plugin-held")).toHaveText(OFF);
  if (process.env.BOTKINS_QA_DIR) await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "plugin-held.png") });
  await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(dialog.getByRole("status", { name: /^Skills from/ })).toHaveCount(0);

  assert.deepEqual(errors, [], "no renderer page errors");
  console.log("Plugins renderer smoke: marketplace browse/preview/install approval, write-only settings, bot scope, enablement, stale/fresh revision update, folder snapshot refresh, remove, what a plugin starts shown whole, the revision at a switch-on, and the words for a plugin that was switched off passed.");
} finally {
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
