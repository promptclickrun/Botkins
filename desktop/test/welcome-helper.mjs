// Fresh test workspaces open on the welcome screen. Smokes that start on Home mark the welcome done first.
// The workspace keeps the setting, so a relaunch of the same data folder opens on Home too.
export async function skipWelcome(page) {
  await page.waitForFunction(() => !!window.botkins);
  await page.evaluate(() => window.botkins.setPreferences({ onboarded: true }));
  return page;
}

/** GitHub Copilot's status as providers() reports it, signed in as a made-up account or signed out. */
export const copilotStatus = (connected, login = "octocat") => ({
  id: "copilot",
  name: "GitHub Copilot",
  description: "",
  enabled: true,
  default: true,
  installed: true,
  connected,
  ...(connected && { account: login }),
  signIn: "browser",
  signOut: connected,
});

/**
 * Replaces providers() in the main process with a made-up list, so a smoke doesn't depend on which
 * providers this computer has signed in. `globalThis.__providers` can be changed later from app.evaluate.
 */
export async function stubProviders(app, list) {
  await app.evaluate(({ ipcMain }, list) => {
    globalThis.__providers = list;
    ipcMain.removeHandler("providers");
    ipcMain.handle("providers", () => globalThis.__providers);
  }, list);
}

/** Copilot signed in as a made-up account: auth() and providers() both say so. */
export async function signedInAs(app, login = "octocat") {
  await app.evaluate(({ ipcMain }, login) => {
    ipcMain.removeHandler("auth");
    ipcMain.handle("auth", () => ({ connected: true, login, type: "user" }));
  }, login);
  await stubProviders(app, [copilotStatus(true, login)]);
}
