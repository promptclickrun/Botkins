import { AppUpdates, githubToken, latestRelease, repository } from "./updates.mjs";
import { linuxUpdates } from "./linux-update.mjs";

// electron-updater checks the artifact hash and hands the ZIP to Squirrel.Mac for
// native signature validation, atomic replacement and relaunch.
export function desktopUpdates({ app, native, notify, mac = app.isPackaged && process.platform === "darwin" }) {
  if (app.isPackaged && process.platform === "linux") {
    return linuxUpdates({
      app,
      notify,
      latest: async () => latestRelease({ token: "" }),
    });
  }
  let driver;
  const service = new AppUpdates({
    current: app.getVersion(), mac, arch: process.arch, notify,
    // The Mac app installs from files only it needs: it says so, and they are looked for.
    latest: async () => latestRelease({ token: await githubToken(), mac: process.platform === "darwin" }),
    stage: async version => {
      if (!driver) {
        const { default: library } = await import("electron-updater");
        driver = library.autoUpdater;
        driver.logger = null;
        driver.autoDownload = false;
        driver.autoInstallOnAppQuit = false;
        driver.allowPrerelease = false;
        driver.allowDowngrade = false;
        driver.on("error", () => service.failedInstall());
      }
      const token = await githubToken();
      driver.setFeedURL({ provider: "github", ...repository, ...(token && { private: true, token }) });
      const result = await driver.checkForUpdates();
      if (!result?.isUpdateAvailable || result.updateInfo.version !== version) throw new Error("The release changed. Check again.");
      await driver.downloadUpdate();
    },
    restart: () => driver.quitAndInstall(),
  });
  native.on("error", () => { if (service.state.status === "restarting") service.failedInstall(); });
  return service;
}
