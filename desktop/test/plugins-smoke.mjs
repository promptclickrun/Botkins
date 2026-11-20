// Isolated Electron renderer smoke for Settings › Marketplace. It uses a local marketplace folder
// only, never GitHub or the person's real Copilot data. Run after `npm run build`:
//   node test/plugins-smoke.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-plugin-ui-"));
const data = root;
const market = join(root, "market");
const plugin = join(market, "plugins", "fixture");
mkdirSync(join(market, ".github", "plugin"), { recursive: true });
mkdirSync(join(plugin, "hooks"), { recursive: true });
writeFileSync(join(market, ".github", "plugin", "marketplace.json"), JSON.stringify({
  name: "Local fixture market",
  plugins: [{ name: "fixture", source: "plugins/fixture", description: "A local plugin fixture", version: "1.0.0" }],
}));
const manifest = (version) => JSON.stringify({
  name: "fixture",
  version,
  description: "A local plugin fixture",
  userConfig: { FIXTURE_SECRET: { title: "Fixture secret", sensitive: true, required: true } },
});
writeFileSync(join(plugin, "plugin.json"), manifest("1.0.0"));
writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", bash: "node ${PLUGIN_ROOT}/hook.mjs" }] } }));
writeFileSync(join(plugin, "hook.mjs"), "console.log(JSON.stringify({ additionalContext: 'fixture' }));\n");
seedApp(root);

const binary = process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY;
const env = { ...process.env, BOTKINS_DATA_DIR: data, COMMANDER_DATA_DIR: data, BOTKINS_PROVIDERS: "copilot", COMMANDER_PROVIDERS: "copilot" };
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
  return dialog;
}
async function snapshot() { return page.evaluate(() => window.botkins.snapshot()); }
async function call(name, ...args) { return page.evaluate(({ name, args }) => window.botkins[name](...args), { name, args }); }

try {
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.title(), "Botkins", "desktop renderer keeps the app page name");

  // Add a local marketplace through the real desktop bridge, then refresh the renderer so the
  // Settings component exercises its initial marketplaces/browse loads.
  const addedMarket = await call("plugins.addMarketplace", market);
  assert.equal(addedMarket.name, "Local fixture market");
  await page.reload();
  await skipWelcome(page);
  let dialog = await openMarketplace();
  await dialog.getByRole("button", { name: "Local fixture market", exact: true }).click();
  await dialog.locator(".plugin-listing", { hasText: "fixture" }).waitFor({ timeout: 30000 });

  // Browse → preview → explicit executable approval → install.
  await dialog.locator(".plugin-listing", { hasText: "fixture" }).click();
  await dialog.getByRole("heading", { name: "fixture", exact: true }).waitFor();
  await dialog.getByText("What this plugin adds", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Install plugin", exact: true }).click();
  const allow = page.getByRole("dialog").getByRole("button", { name: "Allow and continue", exact: true });
  await allow.waitFor();
  await allow.click();
  const install = page.getByRole("dialog", { name: "Install plugin", exact: true });
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
  const useFor = dialog.getByLabel("Use for", { exact: true });
  await useFor.selectOption("selected");
  await dialog.getByLabel("Pip", { exact: true }).check();
  await page.getByText("Updated which bots use fixture.", { exact: true }).waitFor();
  state = await snapshot();
  assert.deepEqual(state.plugins[0].bots, ["pip"]);
  const enabled = dialog.getByRole("switch", { name: "fixture enabled", exact: true });
  await enabled.uncheck();
  await page.getByText("fixture is off.", { exact: true }).waitFor();
  await enabled.click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow and continue", exact: true }).click();
  await page.getByText("fixture is on.", { exact: true }).waitFor();

  // The UI shows a fresh update preview, including the exact hook command, and retries with a
  // newly reviewed revision when the source changes while the person is deciding.
  writeFileSync(join(plugin, "plugin.json"), manifest("1.1.0"));
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", bash: "echo fixture-v1.1" }] } }));
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  let review = page.getByRole("dialog", { name: "Review update · fixture", exact: true });
  await review.getByText("fixture-v1.1", { exact: false }).waitFor();
  writeFileSync(join(plugin, "plugin.json"), manifest("1.2.0"));
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", bash: "echo fixture-v1.2" }] } }));
  await review.getByRole("button", { name: "Approve update", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow and continue", exact: true }).click();
  review = page.getByRole("dialog", { name: "Review update · fixture", exact: true });
  await review.getByText("fixture-v1.2", { exact: false }).waitFor();
  await review.getByRole("button", { name: "Approve update", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow and continue", exact: true }).click();
  await page.getByText("Updated fixture.", { exact: true }).waitFor();
  state = await snapshot();
  assert.equal(state.plugins[0].version, "1.2.0");
  assert.deepEqual(state.plugins[0].bots, ["pip"], "update keeps the existing bot scope");
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  await dialog.getByRole("tab", { name: /Installed \(1\)/ }).waitFor();

  // Add the same source as a local folder plugin: the host leaves it off for review, and the
  // renderer reflects the second State.plugins entry without a reload.
  const local = await call("plugins.addFolder", plugin);
  assert.equal(local.enabled, false);
  await dialog.getByRole("tab", { name: /Installed \(2\)/ }).click();
  await dialog.locator(".plugin-listing", { hasText: "Computer" }).waitFor({ timeout: 30000 });

  // Remove the catalog plugin through its page and confirmation, then remove its marketplace.
  await dialog.locator(".plugin-listing", { hasText: "Local fixture market" }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Remove fixture?", exact: true }).getByRole("button", { name: "Remove", exact: true });
  await remove.click();
  await page.getByText("Removed fixture.", { exact: true }).waitFor();
  state = await snapshot();
  assert.equal(state.plugins.length, 1);
  await dialog.getByRole("tab", { name: "Browse", exact: true }).click();
  const marketGroup = dialog.locator(".set-group", { hasText: "Marketplaces" });
  await marketGroup.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove Local fixture market?", exact: true }).getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("Removed Local fixture market.", { exact: true }).waitFor();
  assert.equal((await snapshot()).plugins.length, 1, "removing a marketplace keeps the folder plugin");

  assert.deepEqual(errors, [], "no renderer page errors");
  console.log("Plugins renderer smoke: marketplace browse/preview/install approval, write-only settings, bot scope, enablement, stale/fresh revision update, folder snapshot refresh and remove passed.");
} finally {
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
