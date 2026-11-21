// Skills, MCP servers, Teamwork and bot memory smoke, in an isolated data folder. No Copilot turns
// unless BOTKINS_LIVE=1 (then it also tests an MCP server, which starts a real session).
// Drives Settings › Skills, › MCP servers and › Teamwork, a bot's Capabilities and Memory views, and the
// bot page's Memory card, and checks the real state through window.botkins.
// Set BOTKINS_INT_SHOTS to a folder to save light and dark screenshots at 1190×830 and 760×560.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-int-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "app"), COMMANDER_DATA_DIR: join(dir, "app") };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(join(dir, "app"));
delete env.ELECTRON_RUN_AS_NODE;
const shots = (process.env.BOTKINS_INT_SHOTS ?? process.env.COMMANDER_INT_SHOTS);
let app, page;
const errors = [];
const snap = () => page.evaluate(() => window.botkins.snapshot());
const skills = () => page.evaluate(() => window.botkins.skills());
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
async function shot(name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
}
/** The next native folder picker answers with this path. */
const pick = (path) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
const stored = () => JSON.parse(readFileSync(join(dir, "app", "data", "workspace.json"), "utf8"));
const workspaceText = () => readFileSync(join(dir, "app", "data", "workspace.json"), "utf8");
const vaultText = () => readFileSync(join(dir, "app", "data", "vault.json"), "utf8");
const isRef = (value) => typeof value === "string" && /^vault:[0-9a-f-]{36}$/.test(value);
const vaultIds = () => Object.keys(JSON.parse(vaultText()).entries);
const credentials = () => page.evaluate(() => window.botkins.credentials());
/** Nothing secret in what the page holds, shows, or the workspace file keeps. */
async function nowhere(secret, what) {
  assert.ok(!JSON.stringify(await snap()).includes(secret), what + " reached the page's state");
  assert.ok(!JSON.stringify(await credentials()).includes(secret), what + " is in the credentials list");
  assert.ok(!(await page.content()).includes(secret), what + " is in the page");
  assert.ok(!workspaceText().includes(secret), what + " is in workspace.json");
  assert.ok(!vaultText().includes(secret), what + " is readable in vault.json");
}
const oauth = await oauthMcpServer({ registration: false, staticClient: { id: "approved-desktop" } });
// The approved client's callback is on a port this run asked the system for. The app listens there
// during the sign-in, and a test never listens on the port the installed app answers sign-ins on.
const callbackPort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const registeredRedirect = "http://127.0.0.1:" + callbackPort + "/botkins/sign-in";
env.BOTKINS_MCP_OAUTH_CLIENTS_FILE = join(dir, "approved-clients.json");
writeFileSync(env.BOTKINS_MCP_OAUTH_CLIENTS_FILE, JSON.stringify({ clients: [{
  serverUrl: oauth.url, issuer: oauth.origin, clientId: "approved-desktop",
  redirectUri: registeredRedirect, scopes: ["tools.read"],
}] }));

try {
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await size(1190, 830);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const tab = (name) => settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name, exact: true });

  // 1. Skills: create, edit, switch off and on, add from folders, unlink, remove.
  await tab("Skills").click();
  await settings.getByRole("heading", { name: "Skills", level: 2 }).waitFor();
  await expect(settings.getByText("Loading skills…")).toHaveCount(0);
  await settings.getByRole("button", { name: "New skill" }).first().click();
  let sheet = page.getByRole("dialog", { name: "New skill" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("release-notes");
  await sheet.getByRole("textbox", { name: "When to use it" }).fill("Use when writing release notes.");
  await sheet.getByRole("textbox", { name: /^Instructions/ }).fill("# Release notes\n\nGroup the changes by area.");
  await sheet.getByRole("button", { name: "Create skill" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(settings.getByRole("status")).toHaveText("Created the skill release-notes.");
  await expect(settings.getByRole("switch", { name: "release-notes", exact: true })).toBeChecked();
  let skill = (await skills()).skills.find((s) => s.name === "release-notes");
  assert.equal(skill.editable, true);
  assert.equal(skill.origin, "commander");
  await settings.getByRole("button", { name: "Edit release-notes" }).click();
  sheet = page.getByRole("dialog", { name: "Edit skill" });
  await expect(sheet.getByRole("textbox", { name: "When to use it" })).toHaveValue("Use when writing release notes.");
  await sheet.getByRole("textbox", { name: "When to use it" }).fill("Use when turning a change list into release notes.");
  await sheet.getByRole("button", { name: "Save skill" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(settings.locator(".int-item", { hasText: "release-notes" })).toContainText("turning a change list");
  skill = (await skills()).skills.find((s) => s.name === "release-notes");
  assert.equal(skill.description, "Use when turning a change list into release notes.");
  // Escape closes only the sheet, not Settings.
  await settings.getByRole("button", { name: "New skill" }).first().click();
  await page.getByRole("dialog", { name: "New skill" }).waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New skill" })).toHaveCount(0);
  await expect(settings).toBeVisible();
  const relSwitch = settings.getByRole("switch", { name: "release-notes", exact: true });
  await relSwitch.click();
  await expect.poll(async () => (await snap()).skills.disabled).toContain("release-notes");
  await expect(relSwitch).not.toBeChecked();
  await relSwitch.click();
  await expect.poll(async () => (await snap()).skills.disabled).not.toContain("release-notes");
  // A folder of skills is linked; a folder that holds a SKILL.md is copied in.
  const lib = join(dir, "Team skills");
  mkdirSync(join(lib, "my-skill"), { recursive: true });
  writeFileSync(join(lib, "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: A linked test skill.\n---\n\nDo the thing.\n");
  await pick(lib);
  await settings.getByRole("button", { name: "Add from folder…" }).first().click();
  await expect(settings.getByRole("status")).toHaveText("Linked Team skills (1 skill).");
  await expect(settings.locator(".int-item", { hasText: "my-skill" })).toContainText("Team skills");
  const linked = settings.locator("section.set-group", { has: page.getByRole("heading", { name: "Linked folders" }) });
  await expect(linked).toContainText("1 skill");
  const solo = join(dir, "solo");
  mkdirSync(solo, { recursive: true });
  writeFileSync(join(solo, "SKILL.md"), "---\nname: solo-skill\ndescription: A copied test skill.\n---\n\nDo one thing well.\n");
  await pick(solo);
  await settings.getByRole("button", { name: "Add from folder…" }).first().click();
  await expect(settings.getByRole("status")).toHaveText("Added the skill solo-skill.");
  let list = await skills();
  assert.equal(list.folders.length, 1);
  assert.equal(list.skills.find((s) => s.name === "solo-skill").origin, "commander");
  assert.equal(list.skills.find((s) => s.name === "my-skill").origin, "folder");
  if (shots) {
    await shot("skills");
    await settings.getByRole("button", { name: "Edit release-notes" }).click();
    await expect(page.getByRole("dialog", { name: "Edit skill" }).getByRole("textbox", { name: "When to use it" })).not.toHaveValue("");
    await shot("skill-sheet");
    await page.getByRole("dialog", { name: "Edit skill" }).getByRole("button", { name: "Cancel" }).click();
  }
  await settings.getByRole("button", { name: "Remove the folder Team skills" }).click();
  await expect.poll(async () => (await skills()).folders.length).toBe(0);
  await expect(settings.locator(".int-item", { hasText: "my-skill" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Remove release-notes" }).click();
  await page.getByRole("dialog", { name: "Remove release-notes?" }).getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => (await skills()).skills.some((s) => s.name === "release-notes")).toBe(false);
  await expect(settings).toBeVisible();
  console.log("Skills: created, edited, switched off and on, linked a folder, copied one in, unlinked and removed.");

  // 2. Credentials before anything is saved: how they are protected, and the empty list.
  await tab("Credentials").click();
  await settings.getByRole("heading", { name: "Credentials", level: 2 }).waitFor();
  await expect(settings.getByText("No saved credentials")).toBeVisible();
  // The installed app keeps the vault's key in the system keychain. A run on a data folder of its
  // own, which every smoke is, keeps it in a file there, a packaged build too: a test must never
  // touch the keychain of whoever is using the computer (desktop/main.mjs, useKeychain).
  await expect(settings.getByText("This is a development build", { exact: false })).toBeVisible();
  // (The password managers above have pills of their own: src/SavedCredentials.tsx.)
  await expect(settings.locator(".cred-protection .set-pill")).toHaveText("Development");
  assert.equal(JSON.parse(vaultText()).key.by, "file");
  await shot("credentials-empty");

  // 3. MCP servers: add with a secret, edit keeping it, switch off, import, remove.
  await tab("MCP servers").click();
  await expect(settings.getByText("No MCP servers yet")).toBeVisible();
  await shot("mcp-empty");
  await settings.getByRole("button", { name: "Add server" }).first().click();
  sheet = page.getByRole("dialog", { name: "Add MCP server" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("local-tools");
  await sheet.getByRole("textbox", { name: "Command" }).fill("node");
  await sheet.getByRole("textbox", { name: /^Arguments/ }).fill("server.js\n--verbose");
  await sheet.getByRole("button", { name: "Add variable" }).click();
  await sheet.getByLabel("Variable 1 name").fill("API_KEY");
  await sheet.getByLabel("Variable 1 value").fill("secret-123");
  await sheet.getByRole("button", { name: "Add server" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(settings.getByRole("status").first()).toHaveText("Added local-tools.");
  let state = await snap();
  let server = state.mcpServers.find((s) => s.name === "local-tools");
  assert.deepEqual(server.env, ["API_KEY"]);
  assert.deepEqual(server.args, ["server.js", "--verbose"]);
  assert.ok(!JSON.stringify(state).includes("secret-123"), "a secret value reached the page");
  // The workspace keeps a reference; the key itself is only in the vault, encrypted.
  const sealed = stored().mcpServers.find((s) => s.name === "local-tools").env.API_KEY;
  assert.ok(isRef(sealed), "the workspace keeps a vault reference: " + sealed);
  assert.ok(vaultIds().includes(sealed.slice(6)), "the vault holds the key");
  await nowhere("secret-123", "the key");
  await expect(settings.locator(".int-item", { hasText: "local-tools" })).toContainText("node server.js --verbose");
  // Editing shows the name with an empty value; leaving it empty keeps the stored value.
  await settings.getByRole("button", { name: "Edit local-tools" }).click();
  sheet = page.getByRole("dialog", { name: "Edit local-tools" });
  // Keys for a local server go in Keys and settings: a variable name and its value.
  await expect(sheet.getByText("Keys and settings", { exact: true })).toBeVisible();
  await expect(sheet.getByLabel("Variable 1 name")).toHaveValue("API_KEY");
  await expect(sheet.getByLabel("Variable 1 value")).toHaveValue("");
  await expect(sheet.getByLabel("Variable 1 value")).toHaveAttribute("placeholder", /Saved/);
  // Adding a second variable changes nothing about where the key goes, so the key is kept.
  await sheet.getByRole("button", { name: "Add variable" }).click();
  await sheet.getByLabel("Variable 2 name").fill("REGION");
  await sheet.getByLabel("Variable 2 value").fill("eu");
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet).toHaveCount(0);
  let kept = stored().mcpServers.find((s) => s.name === "local-tools");
  assert.equal(kept.env.API_KEY, sealed, "the untouched key is kept exactly as it was stored");
  assert.ok(isRef(kept.env.REGION));
  // Changing what the server runs with the key left untouched is refused: a saved key never
  // follows the server to a different program unseen. Typing it again saves.
  await settings.getByRole("button", { name: "Edit local-tools" }).click();
  sheet = page.getByRole("dialog", { name: "Edit local-tools" });
  await sheet.getByRole("textbox", { name: /^Arguments/ }).fill("server2.js");
  await shot("mcp-sheet");
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Enter the value for API_KEY again");
  assert.deepEqual(stored().mcpServers.find((s) => s.name === "local-tools").args, ["server.js", "--verbose"], "a refused edit changes nothing");
  await sheet.getByLabel("Variable 1 value").fill("secret-123");
  await sheet.getByLabel("Variable 2 value").fill("eu");
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet).toHaveCount(0);
  kept = stored().mcpServers.find((s) => s.name === "local-tools");
  assert.ok(isRef(kept.env.API_KEY) && kept.env.API_KEY !== sealed, "the key typed again is a new vault entry");
  assert.ok(!vaultIds().includes(sealed.slice(6)), "the replaced key left the vault");
  await nowhere("secret-123", "the key");
  assert.deepEqual(kept.args, ["server2.js"]);
  // A bad name shows the main process's message in the sheet.
  await settings.getByRole("button", { name: "Add server" }).first().click();
  sheet = page.getByRole("dialog", { name: "Add MCP server" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("bad name!");
  await sheet.getByRole("textbox", { name: "Command" }).fill("node");
  await sheet.getByRole("button", { name: "Add server" }).click();
  await expect(sheet.getByRole("alert")).toContainText("letters, numbers, dashes or underscores");
  await expect(sheet.getByRole("alert")).not.toContainText("Error invoking");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  const localSwitch = settings.getByRole("switch", { name: "local-tools", exact: true });
  await localSwitch.click();
  await expect.poll(async () => (await snap()).mcpServers.find((s) => s.name === "local-tools").enabled).toBe(false);
  await expect(localSwitch).not.toBeChecked();
  await localSwitch.click();
  await expect.poll(async () => (await snap()).mcpServers.find((s) => s.name === "local-tools").enabled).toBe(true);
  // Import pasted JSON: two new servers and one that already exists.
  await settings.getByRole("button", { name: "Import…" }).first().click();
  sheet = page.getByRole("dialog", { name: "Import MCP servers" });
  await sheet.getByRole("textbox", { name: /^MCP JSON/ }).fill(
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp-test-secret" } },
        docs: { type: "http", url: "https://docs.example.com/mcp" },
        "local-tools": { command: "node" },
      },
    }),
  );
  await sheet.getByRole("button", { name: "Import", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(settings.getByRole("status").first()).toHaveText("Added github and docs. Skipped local-tools (a server with that name exists).");
  state = await snap();
  assert.deepEqual(state.mcpServers.map((s) => s.name), ["local-tools", "github", "docs"]);
  await nowhere("ghp-test-secret", "an imported token");
  await shot("mcp");
  await settings.getByRole("button", { name: "Remove docs" }).click();
  await page.getByRole("dialog", { name: "Remove docs?" }).getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => (await snap()).mcpServers.map((s) => s.name)).toEqual(["local-tools", "github"]);
  if ((process.env.BOTKINS_LIVE ?? process.env.COMMANDER_LIVE) === "1") {
    await settings.getByRole("button", { name: "Test github" }).click();
    await expect(settings.locator(".int-item", { hasText: "github" }).locator(".int-note")).not.toContainText("Connecting", { timeout: 30000 });
    console.log("Live test: " + (await settings.locator(".int-item", { hasText: "github" }).locator(".int-note").innerText()));
  }
  console.log("MCP servers: added with a secret the page never sees (a vault reference in workspace.json), edited keeping it, switched off and on, imported, removed.");

  // 4. A remote server with an API key in a header of its own, then switched to Bearer, then to None.
  const row = (name) => settings.locator(".int-item", { has: page.getByText(name, { exact: true }) });
  await settings.getByRole("button", { name: "Add server" }).first().click();
  sheet = page.getByRole("dialog", { name: "Add MCP server" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("tickets");
  await sheet.getByRole("radio", { name: "Remote server" }).click();
  await sheet.getByRole("textbox", { name: "URL" }).fill("https://tickets.example.com/mcp");
  await sheet.getByRole("combobox", { name: /^Sign in/ }).selectOption({ label: "API key or token" });
  await sheet.getByLabel("Key", { exact: true }).fill("tk-live-998877");
  await sheet.getByRole("radio", { name: "A header of its own" }).check();
  await sheet.getByLabel("Header name").fill("X-API-Key");
  await shot("mcp-sheet-key");
  await sheet.getByRole("button", { name: "Add server" }).click();
  await expect(sheet).toHaveCount(0);
  let tickets = stored().mcpServers.find((s) => s.name === "tickets");
  assert.deepEqual(Object.keys(tickets.headers), ["X-API-Key"]);
  assert.ok(isRef(tickets.headers["X-API-Key"]));
  assert.equal(tickets.oauth, undefined);
  await nowhere("tk-live-998877", "the API key");
  await expect(row("tickets").locator(".int-origin")).toHaveText("Remote · API key");
  // Editing says a key is saved; keeping it sends null, which keeps the stored value.
  await settings.getByRole("button", { name: "Edit tickets" }).click();
  sheet = page.getByRole("dialog", { name: "Edit tickets" });
  await expect(sheet.getByRole("combobox", { name: /^Sign in/ })).toHaveValue("key");
  await expect(sheet.getByText("A key is saved.")).toBeVisible();
  await expect(sheet.getByLabel("Header name")).toHaveValue("X-API-Key");
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet).toHaveCount(0);
  assert.equal(stored().mcpServers.find((s) => s.name === "tickets").headers["X-API-Key"], tickets.headers["X-API-Key"], "the saved key is kept");
  // Sending the key as Authorization: Bearer needs the key again.
  await settings.getByRole("button", { name: "Edit tickets" }).click();
  sheet = page.getByRole("dialog", { name: "Edit tickets" });
  await sheet.getByRole("radio", { name: "Authorization: Bearer <key>" }).check();
  await expect(sheet.getByLabel("Key", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Enter the key again");
  await sheet.getByLabel("Key", { exact: true }).fill("tk-live-998877");
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet).toHaveCount(0);
  tickets = stored().mcpServers.find((s) => s.name === "tickets");
  assert.deepEqual(Object.keys(tickets.headers), ["Authorization"]);
  assert.ok(!vaultText().includes("Bearer tk-live"), "the header value is encrypted");
  // None drops the key: nothing of it is kept.
  const keyRef = tickets.headers.Authorization;
  await settings.getByRole("button", { name: "Edit tickets" }).click();
  sheet = page.getByRole("dialog", { name: "Edit tickets" });
  await sheet.getByRole("combobox", { name: /^Sign in/ }).selectOption({ label: "None" });
  await sheet.getByRole("button", { name: "Save server" }).click();
  await expect(sheet).toHaveCount(0);
  assert.deepEqual(stored().mcpServers.find((s) => s.name === "tickets").headers, {});
  assert.ok(!vaultIds().includes(keyRef.slice(6)), "None removed the key from the vault");
  await expect(row("tickets").locator(".int-origin")).toHaveText("Remote · No sign-in");
  console.log("A remote server's API key: in a header of its own, kept on edit, moved to Bearer only when typed again, and gone with None.");

  // 5. Browser sign-in (OAuth) against the stand-in server: the browser is played by the test.
  await app.evaluate(({ shell }) => {
    globalThis.browserUrls = [];
    shell.openExternal = async (url) => void globalThis.browserUrls.push(url);
  });
  await settings.getByRole("button", { name: "Add server" }).first().click();
  sheet = page.getByRole("dialog", { name: "Add MCP server" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill("words");
  await sheet.getByRole("radio", { name: "Remote server" }).click();
  await sheet.getByRole("textbox", { name: "URL" }).fill(oauth.url);
  await sheet.getByRole("combobox", { name: /^Sign in/ }).selectOption({ label: "Sign in with your browser (OAuth)" });
  await sheet.getByRole("button", { name: "Advanced" }).click();
  await expect(sheet.locator(".int-copy code")).toHaveText("http://127.0.0.1:47823/callback");
  await shot("mcp-sheet-oauth");
  await sheet.getByRole("button", { name: "Advanced" }).click();
  await sheet.getByRole("button", { name: "Add server" }).click();
  await expect(sheet).toHaveCount(0);
  let words = (await snap()).mcpServers.find((s) => s.name === "words");
  assert.equal(words.auth.type, "oauth");
  assert.equal(words.auth.signedIn, false);
  assert.deepEqual(stored().mcpServers.find((s) => s.name === "words").headers, {});
  await expect(row("words").locator(".int-origin")).toHaveText("Remote · Browser sign-in");
  await expect(row("words")).toContainText("Not signed in");
  // A test that says the server wants a sign-in offers Sign in right there.
  await app.evaluate(({ ipcMain }) => {
    globalThis.realTest = ipcMain._invokeHandlers?.get("testMcpServer");
    ipcMain.removeHandler("testMcpServer");
    ipcMain.handle("testMcpServer", () => ({ status: "needs-auth", tools: [] }));
  });
  await settings.getByRole("button", { name: "Test words" }).click();
  await expect(row("words").getByText("This server needs you to sign in.")).toBeVisible();
  await shot("mcp-needs-auth");
  await row("words").locator(".int-note", { hasText: "needs you to sign in" }).getByRole("button", { name: "Sign in" }).click();
  await expect(row("words").getByText("Waiting for your browser…")).toBeVisible();
  await expect.poll(() => app.evaluate(() => globalThis.browserUrls.length)).toBe(1);
  const authorize = await app.evaluate(() => globalThis.browserUrls[0]);
  assert.ok(authorize.startsWith(oauth.origin + "/authorize?"), "the browser opens the server's sign-in page: " + authorize);
  const params = new URL(authorize).searchParams;
  assert.equal(params.get("client_id"), "approved-desktop");
  assert.equal(params.get("redirect_uri"), registeredRedirect);
  assert.equal(params.get("scope"), "tools.read");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.ok(!oauth.state.log.some((r) => r.path === "/register"));
  if (shots) await shot("mcp-signing-in");
  await oauth.browser(authorize);
  await expect(row("words").locator(".int-auth")).toHaveText(/Signed in/);
  await expect(settings.getByRole("status").first()).toHaveText("Signed in to words.");
  words = (await snap()).mcpServers.find((s) => s.name === "words");
  assert.equal(words.auth.signedIn, true);
  assert.equal(words.auth.canRenew, true);
  assert.equal(oauth.state.access.size, 1, "the server issued one token");
  for (const token of [...oauth.state.access.keys(), ...oauth.state.refresh.keys()]) await nowhere(token, "a sign-in token");
  await shot("mcp-signed-in");
  // Test connects with the sign-in when the Copilot runtime can run (BOTKINS_LIVE=1); otherwise the stand-in answer above stood in.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("testMcpServer");
    if (globalThis.realTest) ipcMain.handle("testMcpServer", globalThis.realTest);
  });
  if ((process.env.BOTKINS_LIVE ?? process.env.COMMANDER_LIVE) === "1") {
    await settings.getByRole("button", { name: "Test words" }).click();
    await expect(row("words").locator(".int-note", { hasText: /Connect|tool|sign|connect/ }).last()).not.toContainText("Connecting", { timeout: 60000 });
    console.log("Live test of words: " + (await row("words").locator(".int-note").last().innerText()));
  }
  // Sign out removes the sign-in from the vault.
  await row("words").getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: "Sign out of words?" }).getByRole("button", { name: "Sign out" }).click();
  await expect(row("words")).toContainText("Not signed in");
  assert.equal((await credentials()).entries.filter((c) => c.kind === "oauth").length, 0);
  for (const token of [...oauth.state.access.keys(), ...oauth.state.refresh.keys()]) await nowhere(token, "a sign-in token");
  console.log("Browser sign-in: needs-auth offered Sign in, the browser finished it, Signed in, Sign out; no token reached the page or the workspace file.");

  // Sign in again for the Credentials list.
  await row("words").getByRole("button", { name: "Sign in" }).click();
  await expect.poll(() => app.evaluate(() => globalThis.browserUrls.length)).toBe(2);
  await oauth.browser(await app.evaluate(() => globalThis.browserUrls[1]));
  await expect(row("words").locator(".int-auth")).toHaveText(/Signed in/);

  // 6. Credentials: what the vault holds, without values; Remove asks first.
  await tab("Credentials").click();
  // The MCP vault's own list, under the saved credentials phones share (src/SavedCredentials.tsx).
  const saved = settings.locator("section.set-group", { has: page.getByRole("heading", { name: "Saved for MCP servers" }) });
  await expect(saved.locator(".int-item")).toHaveCount((await credentials()).entries.length);
  const cred = (label) => saved.locator(".int-item", { has: page.getByText(label, { exact: true }) });
  await expect(cred("local-tools · API_KEY")).toContainText("Environment value");
  await expect(cred("local-tools · API_KEY")).toContainText("Used by local-tools");
  await expect(cred("local-tools · API_KEY")).toContainText("Changed");
  await expect(cred("words sign-in")).toContainText("Sign-in");
  await expect(cred("words sign-in")).toContainText("Used by words");
  await expect(settings.getByText("Values are never shown and can't be revealed.", { exact: false })).toBeVisible();
  assert.equal(await settings.getByRole("button", { name: /reveal|show value/i }).count(), 0);
  await nowhere("secret-123", "the key");
  await shot("credentials");
  await settings.getByRole("button", { name: "Remove local-tools · API_KEY" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove local-tools · API_KEY?" });
  await expect(confirm).toContainText("local-tools can't use this environment value until you enter it again");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(cred("local-tools · API_KEY")).toHaveCount(0);
  assert.ok(!(await credentials()).entries.some((c) => c.label === "local-tools · API_KEY"));
  // The server says which value must be entered again.
  await tab("MCP servers").click();
  await expect(row("local-tools")).toContainText("API_KEY has no saved value. Enter it again.");
  assert.deepEqual((await snap()).mcpServers.find((s) => s.name === "local-tools").needs, ["API_KEY"]);
  await shot("mcp-needs-key");
  // Removing a sign-in signs out.
  await tab("Credentials").click();
  await settings.getByRole("button", { name: "Remove words sign-in" }).click();
  await page.getByRole("dialog", { name: "Remove words sign-in?" }).getByRole("button", { name: "Remove" }).click();
  await expect(cred("words sign-in")).toHaveCount(0);
  assert.equal((await snap()).mcpServers.find((s) => s.name === "words").auth.signedIn, false);
  console.log("Credentials: lists what the vault holds with kind, server and date, never a value; Remove asks, and the server then asks for the value again.");

  // 7. Teamwork: the main switch and one bot.
  await tab("Teamwork").click();
  const main = settings.getByRole("switch", { name: "Bots ask each other for help" });
  await expect(main).toBeChecked();
  await main.click();
  await expect.poll(async () => (await snap()).settings.teamwork).toBe(false);
  await expect(settings.getByRole("switch", { name: "Scout takes part" })).toBeDisabled();
  await main.click();
  await expect.poll(async () => (await snap()).settings.teamwork).toBe(true);
  await settings.getByRole("switch", { name: "Scout takes part" }).click();
  await expect.poll(async () => (await snap()).bots.find((b) => b.id === "scout").teamwork).toBe(false);
  await shot("teamwork");
  console.log("Teamwork: main switch off and on; Scout left out.");

  // 8. A bot's Capabilities: switch a skill and a server off for Pip only.
  await tab("Bots & capabilities").click();
  await settings.getByLabel("Bot", { exact: true }).selectOption("pip");
  await settings.getByRole("tab", { name: "Capabilities", exact: true }).click();
  await settings.getByRole("switch", { name: "Skill solo-skill" }).click();
  await expect.poll(async () => (await snap()).bots.find((b) => b.id === "pip").skillsOff).toEqual(["solo-skill"]);
  const github = (await snap()).mcpServers.find((s) => s.name === "github");
  await settings.getByRole("switch", { name: "MCP server github" }).click();
  await expect.poll(async () => (await snap()).bots.find((b) => b.id === "pip").mcpOff).toEqual([github.id]);
  await expect(settings.getByRole("switch", { name: "MCP server local-tools" })).toBeChecked();
  assert.equal((await snap()).bots.find((b) => b.id === "scout").skillsOff?.length ?? 0, 0);
  await shot("bot-capabilities");
  console.log("Pip leaves out solo-skill and github; other bots keep them.");

  // 9. Pip's Memory: type, Save, check, Clear.
  await settings.getByRole("tab", { name: "Memory", exact: true }).click();
  const memory = settings.getByRole("textbox", { name: "Pip's memory" });
  await expect(memory).toBeEnabled();
  await memory.fill("Prefers short answers.\nWorks in Pacific time.");
  await expect(settings.locator(".int-count-note")).toContainText("Not saved");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.locator(".int-count-note")).toHaveText("Memory saved.");
  assert.equal((await page.evaluate(() => window.botkins.botMemory("pip"))).trim(), "Prefers short answers.\nWorks in Pacific time.");
  await shot("bot-memory");
  await settings.getByRole("button", { name: "Clear memory…" }).click();
  await page.getByRole("dialog", { name: "Clear Pip's memory?" }).getByRole("button", { name: "Clear memory" }).click();
  await expect(memory).toHaveValue("");
  assert.equal(await page.evaluate(() => window.botkins.botMemory("pip")), "");
  await expect(settings).toBeVisible();
  console.log("Pip's memory saved and cleared from Settings.");

  // 10. The bot page's Memory card, and Edit memory opens Settings on Memory.
  await page.evaluate(() => window.botkins.setBotMemory("pip", "Likes tea.\nShips on Fridays."));
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await expect(settings).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("botkins-open-bot", { detail: "pip" })));
  const card = page.getByRole("region", { name: "Memory", exact: true });
  await expect(card.locator(".memory-peek")).toHaveText("Likes tea.\nShips on Fridays.");
  if (shots) {
    await card.scrollIntoViewIfNeeded();
    await shot("bot-page-memory");
  }
  await card.getByRole("button", { name: "Edit memory" }).click();
  await expect(settings.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(settings.getByRole("textbox", { name: "Pip's memory" })).toHaveValue(/^Likes tea.\nShips on Fridays.\n?$/);
  console.log("The bot page shows Pip's memory; Edit memory opens Settings on it.");

  // 11. Screenshots at the minimum window size.
  if (shots) {
    await size(760, 560);
    for (const [name, open] of [
      ["skills-min", () => tab("Skills").click()],
      ["mcp-min", () => tab("MCP servers").click()],
      ["credentials-min", () => tab("Credentials").click()],
      ["teamwork-min", () => tab("Teamwork").click()],
      [
        "bot-capabilities-min",
        async () => {
          await tab("Bots & capabilities").click();
          await settings.getByRole("tab", { name: "Capabilities", exact: true }).click();
        },
      ],
      ["bot-memory-min", () => settings.getByRole("tab", { name: "Memory", exact: true }).click()],
    ]) {
      await open();
      await page.waitForTimeout(200);
      const wide = await settings.locator(".set-scroll").evaluate((el) => el.scrollWidth > el.clientWidth);
      assert.equal(wide, false, name + " scrolls sideways");
      await shot(name);
    }
    await tab("MCP servers").click();
    await settings.getByRole("button", { name: "Edit local-tools" }).click();
    await shot("mcp-sheet-min");
    await page.keyboard.press("Escape");
    await size(1190, 830);
  }
  // 12. A vault this computer can't read: Credentials says so, servers ask for their values, and Reset starts over.
  await app.close();
  writeFileSync(join(dir, "app", "data", "vault.json"), "not a vault");
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await size(1190, 830);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const again = page.getByRole("dialog", { name: "Settings" });
  const tabAgain = (name) => again.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name, exact: true });
  await tabAgain("Credentials").click();
  await expect(again.getByRole("alert")).toContainText("The file that holds your credentials can't be read.");
  await expect(again.getByText("No saved credentials")).toHaveCount(0);
  assert.equal((await credentials()).locked, "damaged");
  await shot("credentials-locked");
  await again.getByRole("button", { name: "Reset vault…" }).click();
  await page.getByRole("dialog", { name: "Reset the vault?" }).getByRole("button", { name: "Reset vault" }).click();
  await expect(again.getByRole("status")).toHaveText("The vault was reset. Enter keys and sign in again in MCP servers.");
  await expect(again.getByText("No saved credentials")).toBeVisible();
  assert.equal((await credentials()).locked, undefined);
  await tabAgain("MCP servers").click();
  await expect(again.locator(".int-item", { has: page.getByText("github", { exact: true }) })).toContainText("GITHUB_TOKEN has no saved value. Enter it again.");
  console.log("A vault that can't be read: Credentials says so; Reset vault asks, then starts an empty vault and servers ask for their values.");

  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Integrations smoke passed. No renderer exceptions." + (shots ? " Screenshots in " + shots : ""));
} finally {
  if (app) await app.close();
  await oauth.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
