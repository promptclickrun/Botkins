// Fresh test workspaces open on the welcome screen. Smokes that start on Home mark the welcome done first.
// The workspace keeps the setting, and a workspace that is set up opens on its primary bot's Main
// chat: after a relaunch of the same data folder, a smoke that wants Home goes there with goHome.
export async function skipWelcome(page) {
  await page.waitForFunction(() => !!window.botkins);
  await page.evaluate(async () => {
    // Seeded workspaces now receive the one-time profile continuity prompt. Smokes that only
    // need Home deliberately choose the documented local-only path before marking welcome done.
    const profile = await window.botkins.profileStatus();
    if (profile.migration?.needed) await window.botkins.profileOptOut();
    await window.botkins.setPreferences({ onboarded: true });
  });
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
  const opens = await opensOnBot(page);
  await page.reload();
  await skipWelcome(page);
  return opens ? goHome(page) : page;
}

/**
 * Whether this workspace's window opens on its primary bot's Main chat: one that is set up and has
 * a bot does (src/app.tsx). A new test workspace is not set up yet, so it opens on Home. Ask before
 * skipWelcome, which marks the workspace set up for the launches after this one.
 */
export const opensOnBot = (page) =>
  page.evaluate(async () => {
    const state = await window.botkins.snapshot();
    return !!state.settings.onboarded && state.bots.length > 0;
  });

/**
 * From the primary bot's chat a set-up workspace opens on, to Home by the side menu. It waits for
 * the chat first, so the chat does not open over Home a moment later.
 */
export async function goHome(page) {
  await page.locator(".chathead").waitFor({ timeout: 15000 }).catch(() => {});
  if (await page.locator(".chathead").count()) await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  return page;
}

/**
 * Puts places on the side menu. A new menu keeps most places as tiles on the All page; a smoke
 * that opens one of them from the menu pins it first.
 */
export const pinPlaces = (page, ...places) =>
  page.evaluate(async (places) => {
    const { hidden = [] } = (await window.botkins.snapshot()).settings.sidebar;
    await window.botkins.setPreferences({ sidebar: { hidden: hidden.filter((place) => !places.includes(place)) } });
  }, places);
