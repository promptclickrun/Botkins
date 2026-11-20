import { AppUpdates, githubToken, latestRelease, repository } from "./updates.mjs";

// electron-updater checks the artifact hash and hands the ZIP to Squirrel.Mac for
// native signature validation, atomic replacement and relaunch.
export function desktopUpdates({ app, native, notify, mac = app.isPackaged && process.platform === "darwin" }) {
  let driver;
  const service = new AppUpdates({
    current: app.getVersion(), mac, arch: process.arch, notify,
    latest: async () => latestRelease({ token: await githubToken() }),
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
