// Smoke for first launch: the welcome screen with its three main choices (ChatGPT, Claude, GitHub Copilot)
// as equals: none connected, a failed sign-in for each, a sign-in in progress and cancelled, a tool that
// isn't installed, one that was switched off, one connected, More providers, all connected, Get started; a second
// launch that skips the welcome, every Settings section through the side menu, Settings › Model providers
// (sign-out question, remove and add back, the last provider kept), and Create a bot with Bot Studio.
// Uses an isolated data folder. Set WELCOME_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-welcome-"));
const shots = process.env.WELCOME_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
// GitHub Copilot and Claude only, whatever else this computer has; the provider list itself is stubbed below.
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot,claude", COMMANDER_PROVIDERS: "copilot,claude" };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
const errors = [];
let app, page;
async function start() {
  app = await launch();
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
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
/**
 * Replaces the auth, provider list, sign-in, sign-out and switch-on IPC handlers in the main process, so
 * no test touches a real account. GitHub Copilot follows `auth`; Claude starts switched off.
 * `mode` decides what Sign in does: "fail", "hang" (until cancelled) or "ok".
 */
const stubAuth = (auth, mode = "ok") =>
  app.evaluate(
    ({ ipcMain }, [auth, mode]) => {
      const t = (globalThis.__welcome ??= { signIns: 0, cancels: 0, signOuts: 0, claude: false });
      t.auth = auth;
      for (const name of ["auth", "signIn", "cancelSignIn", "signOut", "providers", "setProviderEnabled"]) ipcMain.removeHandler(name);
      ipcMain.handle("auth", () => t.auth);
      ipcMain.handle("providers", () => [
        {
          id: "copilot",
          name: "GitHub Copilot",
          description: "",
          enabled: true,
          default: true,
          installed: true,
          connected: !!t.auth.connected,
          ...(t.auth.login && { account: t.auth.login }),
          signIn: "browser",
          signOut: !!t.auth.connected,
        },
        {
          id: "claude",
          name: "Claude",
          description: "Your Claude plan, through Claude Code.",
          enabled: t.claude,
          default: false,
          installed: true,
          connected: false,
          signIn: t.claude ? "browser" : null,
          signOut: false,
        },
      ]);
      ipcMain.handle("setProviderEnabled", (_e, id, on) => {
        if (id !== "claude" && !on) throw new Error("Keep at least one model provider on.");
        if (id === "claude") t.claude = on;
      });
      ipcMain.handle("signIn", async () => {
        t.signIns++;
        await new Promise((r) => setTimeout(r, 500));
        if (mode === "fail") throw new Error("This account does not have access to GitHub Copilot.");
        if (mode === "hang")
          return new Promise((_, reject) => {
            t.reject = () => reject(new Error("Sign-in cancelled."));
          });
        t.auth = { connected: true, login: "octocat", type: "user" };
      });
      ipcMain.handle("cancelSignIn", () => {
        t.cancels++;
        t.reject?.();
      });
      ipcMain.handle("signOut", () => {
        t.signOuts++;
      });
    },
    [auth, mode],
  );
/**
 * The welcome's own stand-in: ChatGPT, Claude, GitHub Copilot and OpenCode, each as `states` says
 * ({ enabled, installed, connected, account, install, message }; switched on, installed and signed
 * out unless said otherwise). The list comes in the registry's order, GitHub Copilot first, so the
 * screen's own order is what is tested. `mode` decides what Sign in does: "fail", "hang" or "ok".
 */
const stubSetup = (states, mode = "ok") =>
  app.evaluate(
    ({ ipcMain }, [states, mode]) => {
      const t = (globalThis.__welcome ??= { signIns: 0, cancels: 0, signOuts: 0, claude: false });
      Object.assign(t, { setup: states, calls: [], cancels: 0 });
      const names = { copilot: "GitHub Copilot", codex: "ChatGPT", claude: "Claude", opencode: "OpenCode" };
      const accounts = { copilot: "octocat", codex: "sam@example.com", claude: "claude@example.com" };
      const failures = { copilot: "This account does not have access to GitHub Copilot.", codex: "403 Forbidden: this subscription can't be used.", claude: "Your plan does not include this." };
      for (const name of ["auth", "signIn", "cancelSignIn", "signOut", "providers", "setProviderEnabled"]) ipcMain.removeHandler(name);
      ipcMain.handle("auth", () => ({ connected: !!t.setup.copilot?.connected, login: t.setup.copilot?.account, type: "user" }));
      ipcMain.handle("providers", () =>
        Object.keys(names).map((id) => {
          const state = t.setup[id] ?? {};
          const enabled = state.enabled !== false;
          const installed = state.installed !== false;
          return {
            id,
            name: names[id],
            description: "",
            enabled,
            default: id === "copilot",
            installed,
            connected: enabled && installed && !!state.connected,
            ...(enabled && state.connected && state.account && { account: state.account }),
            ...(state.install && { install: state.install }),
            ...(state.message && { message: state.message }),
            signIn: enabled && installed ? "browser" : null,
            signOut: enabled && !!state.connected,
          };
        }),
      );
      ipcMain.handle("setProviderEnabled", (_e, id, on) => {
        t.calls.push(["enable", id, on]);
        (t.setup[id] ??= {}).enabled = on;
      });
      ipcMain.handle("signIn", async (_e, id) => {
        t.signIns++;
        t.calls.push(["signIn", id]);
        await new Promise((r) => setTimeout(r, 400));
        if (mode === "fail") throw new Error(failures[id]);
        if (mode === "hang")
          return new Promise((_, reject) => {
            t.reject = () => reject(new Error("Sign-in cancelled."));
          });
        Object.assign((t.setup[id] ??= {}), { connected: true, account: accounts[id] });
      });
      ipcMain.handle("cancelSignIn", () => {
        t.cancels++;
        t.reject?.();
      });
      ipcMain.handle("signOut", () => {
        t.signOuts++;
      });
    },
    [states, mode],
  );
const stubbed = () => app.evaluate(() => globalThis.__welcome);
const button = (name) => page.getByRole("button", { name, exact: true });
const welcome = () => page.getByRole("heading", { name: /^Welcome/ });

try {
  // 1. First launch shows the welcome. With this Mac's real sign-ins it offers Get started or a sign-in.
  await start();
  await welcome().waitFor();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toHaveCount(0);
  await expect(button("Get started").or(page.getByRole("button", { name: /^Sign in /, disabled: false })).first()).toBeVisible({ timeout: 30000 });

  // 2. The three main choices: ChatGPT, Claude and GitHub Copilot, in that order and as equals,
  // whatever order the app's own list has them in. Every state below is made up, so no real account shows.
  const rows = () => page.getByRole("list", { name: "Model providers", exact: true }).getByRole("listitem");
  const row = (id) => page.locator(`[data-provider-row="${id}"]`);
  const shootBoth = async (name) => {
    await shoot(name);
    await size(760, 560);
    await shoot(name + "-min");
    await size(1190, 830);
  };
  const off = { opencode: { enabled: false } };

  // Nothing connected, as on a new computer.
  await stubSetup({ ...off }, "fail");
  await page.reload();
  await row("copilot").waitFor();
  assert.deepEqual(await rows().evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["ChatGPT", "Claude", "GitHub Copilot"]);
  const signIns = ["Sign in to ChatGPT", "Sign in to Claude", "Sign in with GitHub"];
  for (const [index, name] of signIns.entries()) await expect(rows().nth(index).getByRole("button", { name, exact: true })).toBeEnabled();
  // Equals: the same button in the same size, and each row the same height.
  const boxes = await Promise.all(signIns.map((name) => button(name).boundingBox()));
  assert.deepEqual(boxes.map((box) => [Math.round(box.width), Math.round(box.height)]), Array(3).fill([Math.round(boxes[0].width), Math.round(boxes[0].height)]), "the three sign-in buttons are one size");
  assert.equal(new Set(await Promise.all(signIns.map((name) => button(name).getAttribute("class")))).size, 1, "and one style");
  assert.equal(new Set((await rows().evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height))))).size, 1, "the three rows are one height");
  // None is chosen ahead: no button has the focus, nothing says recommended, and there is no Get started yet.
  await expect(welcome()).toBeFocused();
  for (const name of signIns) await expect(button(name)).not.toBeFocused();
  await expect(page.getByText(/recommended/i)).toHaveCount(0);
  await expect(button("Get started")).toHaveCount(0);
  // Everything else waits under More providers.
  await expect(row("opencode")).toBeHidden();
  await shootBoth("welcome-none-connected");

  // A failed sign-in says why under its own row, for each of the three. Only GitHub Copilot's offers the Copilot plans.
  for (const [id, name, message] of [
    ["codex", "Sign in to ChatGPT", /This account's ChatGPT plan can't be used here/],
    ["claude", "Sign in to Claude", /This account's Claude plan can't be used here/],
    ["copilot", "Sign in with GitHub", /doesn't have GitHub Copilot/],
  ]) {
    await button(name).click();
    await row(id).getByText("Waiting…").waitFor();
    await row(id).getByRole("alert").getByText(message).waitFor();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "See Copilot plans" })).toHaveCount(id === "copilot" ? 1 : 0);
    await shootBoth("welcome-failed-" + id);
  }
  assert.deepEqual((await stubbed()).calls, [["signIn", "codex"], ["signIn", "claude"], ["signIn", "copilot"]]);

  // A sign-in in progress: its row waits and can be cancelled, and the other two wait their turn.
  await stubSetup({ ...off }, "hang");
  await page.reload();
  await button("Sign in to Claude").click();
  await row("claude").getByText(/Your browser opened a sign-in page for Claude/).waitFor();
  await row("claude").getByText("Waiting…").waitFor();
  await expect(button("Sign in to ChatGPT")).toBeDisabled();
  await expect(button("Sign in with GitHub")).toBeDisabled();
  await shootBoth("welcome-waiting");
  await row("claude").getByRole("button", { name: "Cancel", exact: true }).click();
  await row("claude").getByRole("alert").getByText("Sign-in was cancelled.", { exact: false }).waitFor();
  await expect.poll(async () => (await stubbed()).cancels).toBe(1);
  await button("Sign in with GitHub").click();
  await row("copilot").getByText(/Your browser opened github.com/).waitFor();
  await row("copilot").getByRole("button", { name: "Cancel", exact: true }).click();

  // A tool that isn't on this computer: its row offers to get it, in the same place and size as a sign-in.
  await stubSetup({ ...off, codex: { installed: false, install: { url: "https://example.com/codex" }, message: "The Codex CLI isn't on this computer." } });
  await page.reload();
  await row("codex").getByRole("button", { name: "Get the Codex CLI", exact: true }).waitFor();
  await row("codex").getByText("The Codex CLI isn't on this computer.").waitFor();
  await expect(row("codex").getByRole("button", { name: /Sign in/ })).toHaveCount(0);
  await expect(button("Sign in to Claude")).toBeEnabled();
  await shootBoth("welcome-not-installed");

  // One that was switched off before is still one of the three. One click turns it on and signs in.
  await stubSetup({ ...off, claude: { enabled: false } }, "ok");
  await page.reload();
  assert.deepEqual(await rows().evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["ChatGPT", "Claude", "GitHub Copilot"]);
  await button("Sign in to Claude").click();
  await row("claude").getByText("Connected", { exact: true }).waitFor();
  await row("claude").getByText("claude@example.com").waitFor();
  assert.deepEqual((await stubbed()).calls, [["enable", "claude", true], ["signIn", "claude"]]);
  // One connected is enough to go on: Get started is the one main action, and has the focus.
  await expect(button("Get started")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Your model providers" })).toBeVisible();
  await expect(button("Sign in to ChatGPT")).toBeEnabled();
  await expect(button("Sign in with GitHub")).toBeEnabled();
  await shootBoth("welcome-one-connected");

  // More providers: Add switches another one on. It stays there, in the open, with its own action and the focus.
  await page.getByText("More providers", { exact: true }).click();
  await button("Add OpenCode").click();
  await expect(row("opencode")).toBeFocused();
  await expect(button("Add OpenCode")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "More providers", exact: true }).getByRole("listitem")).toHaveCount(1);
  assert.equal((await rows().count()), 3, "the three main choices stay three");
  await shoot("welcome-more-providers");

  // All three connected.
  await stubSetup({ ...off, codex: { connected: true, account: "sam@example.com" }, claude: { connected: true, account: "claude@example.com" }, copilot: { connected: true, account: "octocat" } });
  await page.reload();
  await button("Get started").waitFor();
  await row("copilot").getByText("octocat").waitFor();
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(3);
  await expect(button("Get started")).toBeFocused();
  await shootBoth("welcome-signed-in");
  await button("Get started").click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).settings.onboarded, true);
  await app.close();

  // 3. The second launch skips the welcome (real auth again).
  await start();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 30000 });
  await expect(welcome()).toHaveCount(0);
  await stubAuth({ connected: true, login: "octocat", type: "user" });
  // Claude stays switched on from the welcome, as the saved setting would keep it.
  await app.evaluate(() => void (globalThis.__welcome.claude = true));

  // 4. Settings: the side menu reaches every section, by click and by arrow keys.
  await button("Settings").click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const sections = [
    "General",
    "Appearance",
    "Side menu",
    "Chat",
    "Notifications",
    "Bots & capabilities",
    "Skills",
    "Marketplace",
    "MCP servers",
    "Credentials",
    "Teamwork",
    "Team",
    "Access",
    "Phone",
    "Voice",
    "Usage",
    "Storage",
    "Model providers",
    "About",
  ];
  const tabs = dialog.getByRole("tablist", { name: "Settings" });
  await expect(tabs.getByRole("tab")).toHaveCount(sections.length);
  await expect(tabs.getByRole("tab", { name: "General" })).toBeFocused();
  for (const name of sections) {
    await tabs.getByRole("tab", { name, exact: true }).click();
    await expect(tabs.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("heading", { name, exact: true, level: 2 }).waitFor();
    if (name === "Model providers") await dialog.getByText("Signed in as octocat").waitFor();
  }
  await tabs.getByRole("tab", { name: "About", exact: true }).click();
  const { version } = await page.evaluate(() => window.botkins.appInfo());
  await dialog.getByText("Version " + version, { exact: true }).waitFor();
  // Arrow keys move through the menu and wrap.
  await tabs.getByRole("tab", { name: "General", exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await expect(tabs.getByRole("tab", { name: "Appearance", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "Appearance", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(tabs.getByRole("tab", { name: "About", exact: true })).toHaveAttribute("aria-selected", "true");
  // A switch row works and persists.
  await tabs.getByRole("tab", { name: "Appearance", exact: true }).click();
  await dialog.getByRole("switch", { name: "Read replies aloud" }).check();
  await expect.poll(async () => (await page.evaluate(() => window.botkins.snapshot())).settings.readAloud).toBe(true);
  await dialog.getByRole("switch", { name: "Read replies aloud" }).uncheck();
  if (shots)
    for (const [w, h, suffix] of [
      [1190, 830, ""],
      [760, 560, "-min"],
    ]) {
      await size(w, h);
      for (const name of sections) {
        await tabs.getByRole("tab", { name, exact: true }).click();
        if (name === "Bots & capabilities") {
          for (const view of ["Model", "Profile", "Capabilities", "Memory"]) {
            await dialog.getByRole("tab", { name: view, exact: true }).click();
            await shoot("settings-bots-" + view.toLowerCase() + suffix);
          }
          await dialog.getByRole("tab", { name: "Model", exact: true }).click();
        } else await shoot("settings-" + name.toLowerCase().replace(/[^a-z]+/g, "-") + suffix);
      }
    }
  await size(1190, 830);
  // Old tab names still land in the right place: a chat's Bot settings opens Bots & capabilities.
  await button("Close dialog").click();
  await expect(dialog).toHaveCount(0);
  // The sidebar's Models button opens Model providers.
  await page.locator("aside").getByRole("button", { name: /^Models/ }).click();
  await expect(tabs.getByRole("tab", { name: "Model providers", exact: true })).toHaveAttribute("aria-selected", "true");
  // Signing out asks first and says what else it signs out; Cancel keeps the sign-in.
  await dialog.getByRole("button", { name: "Sign out of GitHub Copilot…", exact: true }).click();
  const question = page.getByRole("dialog", { name: "Sign out of GitHub Copilot?" });
  await question.getByText("Copilot CLI on this computer is signed out too.", { exact: false }).waitFor();
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // Claude, added on the welcome, has a card; Remove asks, then it waits under Add a provider with focus on Add.
  const claudeCard = dialog.locator("[data-provider-card=claude]");
  await claudeCard.getByRole("button", { name: "Sign in to Claude", exact: true }).waitFor();
  await claudeCard.getByRole("button", { name: "Remove Claude from Botkins", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove Claude from Botkins?" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(claudeCard).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add Claude", exact: true })).toBeFocused();
  // Adding it back brings the card back, with focus on its Sign in.
  await dialog.getByRole("button", { name: "Add Claude", exact: true }).click();
  await expect(claudeCard.getByRole("button", { name: "Sign in to Claude", exact: true })).toBeFocused();
  // The last provider can't be removed; the main process says why.
  await dialog.locator("[data-provider-card=copilot]").getByRole("button", { name: "Remove GitHub Copilot from Botkins", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove GitHub Copilot from Botkins?" }).getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("alert").getByText("Keep at least one model provider on.").waitFor();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // 5. Create a bot: name, role and instructions up front; the Botkin opens Bot Studio.
  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Create a bot" });
  await sheet.getByLabel("Name", { exact: true }).fill("Juniper");
  await sheet.getByLabel("Role", { exact: true }).fill("Garden planner");
  await sheet.getByLabel("Instructions", { exact: true }).fill("Plan plantings by season and keep lists short.");
  await sheet.getByText("Click to change").waitFor();
  await shoot("create-bot");
  await sheet.getByRole("button", { name: "Start from a template", exact: true }).click();
  await sheet.getByRole("group", { name: "Built-in templates" }).waitFor();
  await shoot("create-bot-templates");
  await page.keyboard.press("Escape");
  await expect(sheet.getByRole("group", { name: "Built-in templates" })).toHaveCount(0);
  await expect(sheet).toBeVisible();

  const studio = page.getByRole("dialog", { name: "Bot Studio" });
  const characters = studio.getByRole("radiogroup", { name: "Character" });
  const checked = () => characters.getByRole("radio", { checked: true }).textContent();
  await sheet.getByRole("button", { name: "Open Bot Studio", exact: true }).click();
  await studio.waitFor();
  const initial = await checked();
  // Cancel discards the change.
  const other = initial === "Skiff" ? "Muse" : "Skiff";
  await characters.getByRole("radio", { name: other, exact: true }).click();
  await expect.poll(checked).not.toBe(initial);
  await studio.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(studio).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Open Bot Studio", exact: true }).click();
  await expect.poll(checked).toBe(initial);
  // Escape closes only the studio.
  await page.keyboard.press("Escape");
  await expect(studio).toHaveCount(0);
  await expect(sheet).toBeVisible();
  // Save returns the look to the form.
  await sheet.getByRole("button", { name: "Open Bot Studio", exact: true }).click();
  await characters.getByRole("radio", { name: other, exact: true }).click();
  await studio.getByRole("radiogroup", { name: "Palette" }).getByRole("radio", { name: "Tidepool", exact: true }).click();
  await shoot("bot-studio");
  await size(760, 560);
  await shoot("bot-studio-min");
  await size(1190, 830);
  await studio.getByRole("button", { name: "Save", exact: true }).click();
  await expect(studio).toHaveCount(0);
  await sheet.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.botkins.snapshot())).bots.find((b) => b.name === "Juniper")?.look)
    .toEqual({ head: other.toLowerCase(), palette: "tidepool" });
  const t = await stubbed();
  assert.equal(t.signOuts, 0);
  assert.deepEqual(errors, []);
  console.log(
    "Welcome: ChatGPT, Claude and GitHub Copilot as three equal choices (none connected, a failed sign-in for each, waiting and cancel, a tool not installed, one switched off, one connected, More providers, all connected), Get started, second launch; Settings sections and keys; Model providers sign-out question, remove, add back and last provider kept; Create a bot with Bot Studio Save and Cancel passed.",
  );
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
