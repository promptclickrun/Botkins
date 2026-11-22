// Fresh test workspaces open on the welcome screen. Smokes that start on Home mark the welcome done first.
// The workspace keeps the setting, so a relaunch of the same data folder opens on Home too.
export async function skipWelcome(page) {
  await page.waitForFunction(() => !!window.botkins);
  await page.evaluate(() => window.botkins.setPreferences({ onboarded: true }));
  return page;
}

/**
 * A first launch opens on the choice of how Botkins is used here (src/SetupChoice.tsx). Chooses
 * Set up on this computer, which goes on to the provider welcome.
 */
export async function setUpHere(page) {
  await page.getByRole("list", { name: "Ways to use Botkins" }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /^Set up on this computer/ }).click();
  await page.getByRole("heading", { name: "Connect a model provider" }).or(page.getByRole("heading", { name: "Your model providers" })).first().waitFor({ timeout: 30000 });
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

/**
 * The app's first window on Home, with GitHub Copilot signed in as a made-up account. A smoke that
 * starts on Home uses this, so it does not depend on what this computer is signed in to: a
 * signed-out window shows the welcome page in place of Home. The window is read again after the
 * stand-in is in, because it asks for the providers as it opens.
 */
export async function home(app, login = "octocat") {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.botkins);
  await signedInAs(app, login);
  await page.reload();
  return skipWelcome(page);
}
