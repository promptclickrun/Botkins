// Settings › Credentials smoke, in an isolated data folder: the password managers and the saved
// credentials phones share (src/SavedCredentials.tsx, desktop/savedcredentials.mjs).
// The app looks for the managers' tools only in BOTKINS_TOOL_PATH (a trial run's own folder), so no
// real 1Password, Bitwarden or Proton Pass is started. A stand-in `op` is put there halfway through.
// Run after `npm run build`. Set BOTKINS_CRED_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const VALUE = "sk-smoke-VALUE-7f3a9c21d4";
const OP_VALUE = "ghp_SMOKE_STANDIN_88e1";
const dir = mkdtempSync(join(tmpdir(), "botkins-cred-ui-"));
const tools = join(dir, "tools");
mkdirSync(tools);
const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "app"), COMMANDER_DATA_DIR: join(dir, "app"), BOTKINS_TOOL_PATH: tools };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BOTKINS_KEYCHAIN;
delete env.BOTKINS_COPILOT_SIGNIN;
seedApp(join(dir, "app"));
const shots = process.env.BOTKINS_CRED_SHOTS;
const OP = `#!/bin/sh
case "$*" in
  "--version") echo 2.30.0 ;;
  "whoami --format json") echo '{"url":"team.example.com","email":"someone@example.com"}' ;;
  "vault list --format json") echo '[{"id":"vault-1","name":"Work"},{"id":"vault-2","name":"Home"}]' ;;
  "item list --vault vault-1 --format json") echo '[{"id":"item-1","title":"GitHub","additional_information":"octo"},{"id":"item-2","title":"Cloud","additional_information":"root"}]' ;;
  "item get item-1 --vault vault-1 --format json") echo '{"id":"item-1","title":"GitHub","fields":[{"id":"username","label":"username","type":"STRING","value":"octo"},{"id":"tok1","label":"token","type":"CONCEALED","value":"${OP_VALUE}"}]}' ;;
  "read --no-newline op://vault-1/item-1/tok1") printf %s ${OP_VALUE} ;;
  *) echo "unexpected" >&2; exit 2 ;;
esac
`;

let app, page;
const errors = [];
/** Every file under the data folder whose name ends with `name`. */
function find(root, name, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) find(path, name, out);
    else if (entry.name === name) out.push(path);
  }
  return out;
}
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
/** Nothing of a value in the page, its fields, the app's state, what the page can list, or the data files. */
async function nowhere(secret, what) {
  assert.ok(!(await page.content()).includes(secret), what + " is in the page");
  const fields = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((el) => el.value).join("\n"));
  assert.ok(!fields.includes(secret), what + " is in a field");
  assert.ok(!JSON.stringify(await page.evaluate(() => window.botkins.snapshot())).includes(secret), what + " reached the app's state");
  assert.ok(!JSON.stringify(await page.evaluate(() => window.botkins.savedCredentials())).includes(secret), what + " is in the list");
  const workspace = find(join(dir, "app"), "workspace.json");
  assert.ok(workspace.length, "workspace.json exists");
  for (const file of workspace) assert.ok(!read(file).includes(secret), what + " is in " + file);
  for (const file of find(join(dir, "app"), "credentials.json")) assert.ok(!read(file).includes(secret), what + " is readable in " + file);
}
async function shot(name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
}

try {
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 830));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Credentials", exact: true }).click();
  await settings.getByRole("heading", { name: "Credentials", level: 2 }).waitFor();

  // 1. What these are for, and each manager with its state: none is installed here.
  await expect(settings.getByText("Save a password or key here once", { exact: false })).toBeVisible();
  await expect(settings.getByText("never sent to a phone", { exact: false }).first()).toBeVisible();
  const manager = (name) => settings.getByRole("group", { name, exact: true });
  for (const [name, tool] of [["1Password", "op"], ["Bitwarden", "bw"], ["Proton Pass", "pass-cli"]]) {
    await expect(manager(name)).toContainText("Not installed");
    await expect(manager(name)).toContainText("Install the " + name + " command-line tool (" + tool + ") on your computer.");
  }
  if (process.platform === "darwin") {
    await expect(manager("1Password").getByLabel("Install command for 1Password", { exact: true })).toHaveText("brew install --cask 1password-cli");
    await expect(manager("1Password").getByRole("button", { name: "Copy the install command for 1Password" })).toBeVisible();
  }
  await expect(manager("Proton Pass").getByRole("button", { name: /install/i })).toBeVisible();
  // The MCP servers' own list is still there, under a heading of its own.
  await expect(settings.getByRole("heading", { name: "Saved for MCP servers" })).toBeVisible();
  await expect(settings.getByText("No saved credentials")).toBeVisible();
  await expect(settings.getByText("Nothing saved yet")).toBeVisible();
  await shot("credentials-new");
  console.log("Managers: 1Password, Bitwarden and Proton Pass each say Not installed, with how to install the tool.");

  // 2. A credential typed in by hand: saved, listed, never shown again.
  await settings.getByRole("button", { name: "Add credential" }).click();
  let sheet = page.getByRole("dialog", { name: "Add credential" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("Deploy key");
  await sheet.getByRole("textbox", { name: /^Username/ }).fill("ci-bot");
  await sheet.getByRole("textbox", { name: /^Website/ }).fill("https://deploy.example.com/login");
  await sheet.getByLabel(/^Key/).fill(VALUE);
  await sheet.getByRole("button", { name: "Save credential" }).click();
  await expect(sheet).toHaveCount(0);
  const saved = settings.locator("section.set-group", { has: page.getByRole("heading", { name: "Saved credentials", exact: true }) });
  const row = (name) => saved.locator(".scred-item", { has: page.getByText(name, { exact: true }) });
  await expect(row("Deploy key")).toContainText("API key · Typed in here");
  await expect(row("Deploy key")).toContainText("ci-bot · deploy.example.com");
  await expect(settings.getByRole("status").filter({ hasText: "Saved Deploy key." })).toBeVisible();
  await nowhere(VALUE, "the typed-in value");
  console.log("Add credential: saved and listed with its username and website; the value is nowhere in the page, its fields, the state or the data files.");

  // 3. Check: whether it can be read now, never the value.
  await row("Deploy key").getByRole("button", { name: "Check Deploy key" }).click();
  await expect(row("Deploy key")).toContainText("Can be read now.");
  await nowhere(VALUE, "the checked value");

  // 4. Edit: a new name; the value stays and isn't shown.
  await row("Deploy key").getByRole("button", { name: "Edit Deploy key" }).click();
  sheet = page.getByRole("dialog", { name: "Edit Deploy key" });
  await expect(sheet.getByRole("button", { name: "Replace value" })).toBeVisible();
  await expect(sheet.locator("input[type=password]")).toHaveCount(0);
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("Deploy key (CI)");
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row("Deploy key (CI)")).toHaveCount(1);
  await expect(row("Deploy key")).toHaveCount(0);
  const { entries } = await page.evaluate(() => window.botkins.savedCredentials());
  assert.deepEqual(entries.map((c) => c.name), ["Deploy key (CI)"]);
  await nowhere(VALUE, "the edited credential's value");
  console.log("Check says it can be read now; Edit renames it and keeps the value without showing it.");

  // 5. Answering a bot with it: the computer puts the value in before the answer reaches the workspace.
  // (No request is open, so the workspace says so: that comes after the reference was filled in.)
  const answer = (value) => page.evaluate((value) => window.botkins.respond("no-such-request", { action: "answer", value }).then(() => "sent", (e) => String(e.message)), value);
  assert.match(await answer({ $credential: entries[0].id }), /This request has already closed\./);
  assert.match(await answer({ $credential: "cred-gone" }), /That credential can't be read right now: That credential no longer exists\./);
  assert.match(await answer("typed text"), /This request has already closed\./);
  console.log("respond: a { $credential } answer is resolved in the main process; a typed answer passes through as before.");

  // 6. A password manager that is ready (a stand-in op): Browse, pick a field, save it.
  writeFileSync(join(tools, "op"), OP, { mode: 0o755 });
  await settings.getByRole("button", { name: "Check again" }).click();
  await expect(manager("1Password")).toContainText("Ready");
  await expect(manager("1Password")).toContainText("someone@example.com · Version 2.30.0");
  await expect(manager("Bitwarden")).toContainText("Not installed");
  await manager("1Password").getByRole("button", { name: "Browse 1Password" }).click();
  sheet = page.getByRole("dialog", { name: "Browse 1Password" });
  await sheet.getByRole("list", { name: "Vaults" }).getByRole("listitem").filter({ hasText: "Work" }).click();
  await sheet.getByRole("searchbox", { name: "Search Work" }).fill("git");
  await expect(sheet.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1);
  await sheet.getByRole("listitem").filter({ hasText: "GitHub" }).click();
  // The item's one hidden field is picked already, and the name is made from the item and field.
  await expect(sheet.getByRole("radio", { name: /token/ })).toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByRole("textbox", { name: /^Name/ })).toHaveValue("GitHub token");
  await shot("credentials-browse");
  await sheet.getByRole("button", { name: "Save credential" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row("GitHub token")).toContainText("From 1Password");
  await expect(row("GitHub token")).toContainText("Work / GitHub / token");
  await row("GitHub token").getByRole("button", { name: "Check GitHub token" }).click();
  await expect(row("GitHub token")).toContainText("Can be read now.");
  await nowhere(OP_VALUE, "the 1Password value");
  await shot("credentials-saved");
  console.log("Browse: a stand-in 1Password is Ready; vault → search → item → field → Save makes a linked credential that checks out, without its value reaching the page.");

  // 7. Remove asks first.
  await row("Deploy key (CI)").getByRole("button", { name: "Remove Deploy key (CI)" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Deploy key (CI)?" });
  await expect(confirm).toContainText("Its value is deleted from this computer.");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(row("Deploy key (CI)")).toHaveCount(0);
  assert.deepEqual((await page.evaluate(() => window.botkins.savedCredentials())).entries.map((c) => c.name), ["GitHub token"]);
  await nowhere(VALUE, "the removed value");
  console.log("Remove: asks, then the credential is gone.");

  assert.deepEqual(errors, []);
  console.log("Credentials smoke passed.");
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
