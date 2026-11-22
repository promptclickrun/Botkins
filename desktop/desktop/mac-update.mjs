import { AppUpdates, latestRelease } from "./updates.mjs";
import { linuxUpdates } from "./linux-update.mjs";

// Native error details can contain paths and request headers. Show only the recognized cause.
function macInstallFailure(error) {
  const message = String(error?.message ?? "");
  if (error?.code === "EROFS" || /read.only|translocat/i.test(message))
    return "Move Botkins.app to Applications, open it there, then check for the update again.";
  if (error?.code === "EACCES" || /permission denied|permission to write/i.test(message))
    return "macOS could not replace Botkins.app. Install the signed release in an Applications folder you can write to.";
  if (/signature|checksum|sha512/i.test(message))
    return "The downloaded update failed verification. Check for the update again to retry.";
  if (error?.code === "RELEASE_CHANGED") return "The release changed. Check for updates again.";
}

// electron-updater checks the artifact hash and hands the ZIP to Squirrel.Mac for
// native signature validation, atomic replacement and relaunch.
export function desktopUpdates({ app, native, notify, auto, idle, autoPollMs, mac = app.isPackaged && process.platform === "darwin",
  latest = () => latestRelease({ token: "", mac }), getDriver = async () => (await import("electron-updater")).default.autoUpdater }) {
  if (app.isPackaged && process.platform === "linux") {
    return linuxUpdates({
      app,
      notify,
      latest: async () => latestRelease({ token: "" }),
    });
  }
  let driver;
  const service = new AppUpdates({
    current: app.getVersion(), mac, arch: process.arch, notify, latest,
    ...(mac && { auto, idle, autoPollMs, installFailure: macInstallFailure }),
    stage: async version => {
      if (!driver) {
        driver = await getDriver();
        driver.logger = null;
        driver.autoDownload = false;
        driver.autoInstallOnAppQuit = false;
        driver.allowPrerelease = false;
        driver.allowDowngrade = false;
        driver.on("error", error => service.failedInstall(error));
      }
      // Use the manifest of the public release discovery actually selected.
      driver.setFeedURL({ provider: "generic", url: "https://github.com/promptclickrun/Botkins/releases/download/v" + version + "/" });
      const result = await driver.checkForUpdates();
      if (!result?.isUpdateAvailable || result.updateInfo.version !== version) throw Object.assign(new Error("The release changed."), { code: "RELEASE_CHANGED" });
      await driver.downloadUpdate();
    },
    restart: () => driver.quitAndInstall(),
  });
  native.on("error", error => { if (service.state.status === "restarting") service.failedInstall(error); });
  return service;
}
