// Updates for the running terminal host: looking for a newer release now and then, and asking
// for it to be installed when the person (at the terminal, or from a paired phone) says so.
//
// The service runs without privileges and can't replace its own program. It can only ask:
//
//   the whole computer's service   it makes an empty file, <data folder>/run/update-requested.
//                                  A systemd watch (botkins-update.path) sees it and starts the
//                                  root job that installs the latest signed release.
//   one person's service           it starts `botkins update --apply` as that person, outside
//                                  the service's own group of processes, so the restart that
//                                  ends the service doesn't end the update.
//
// Either way what gets installed is decided by desktop/terminal/update-install.mjs, not by the
// request: the latest release from the project's own address, checked against its signed checksums.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppUpdates, latestRelease } from "../updates.mjs";
import { serviceManager } from "./manager.mjs";
import { assetName, installLayout } from "./update-install.mjs";

const ENTRY = fileURLToPath(new URL("../../cli/botkins.mjs", import.meta.url));
export const REQUEST = "update-requested";

/** The update service for `botkins serve` (desktop/terminal/serve.mjs). */
export function terminalUpdates(service, { entry = ENTRY, platform = process.platform, arch = process.arch, latest = () => latestRelease({ token: "" }), manager = serviceManager({ command: [process.execPath, entry] }), launch = spawn } = {}) {
  const layout = installLayout(entry);
  const found = () => manager.installed();
  return new AppUpdates({
    current: service.version,
    mac: false,
    // "linux" here means: a copy installed from a tarball, which is what the terminal host is on every system.
    linux: !!layout,
    arch,
    latest,
    linuxAsset: (version) => assetName(version, platform, arch),
    linuxUnitAvailable: async () => !!found(),
    unitMissing: "Install Botkins as a service (`botkins service install`) so it can update itself, or run `botkins update` at a terminal.",
    cannotInstall: layout ? "This release has no signed terminal host build for this system, or Botkins isn't installed as a service. Run `botkins update` at a terminal to see which." : "This copy of Botkins wasn't installed from a release, so it doesn't update itself.",
    notify: (version) => service.log.info("Botkins " + version + " is available (this is " + service.version + "). Install it with `botkins update`."),
    stage: async () => {},
    restart: () => {
      const scope = found()?.scope;
      service.log.info("An update was asked for.");
      if (scope === "system" && platform !== "darwin") return void closeSync(openSync(join(service.paths.runDir, REQUEST), "w", 0o600));
      // Its own session, so the service's restart leaves it running; systemd-run where there is one, so the unit's own cleanup does too.
      const command = platform === "darwin" ? [process.execPath, [entry, "update", "--apply"]] : ["systemd-run", ["--user", "--collect", "--unit=botkins-update", process.execPath, entry, "update", "--apply"]];
      launch(command[0], command[1], { detached: true, stdio: "ignore", env: { ...process.env, BOTKINS_DATA_DIR: service.paths.root } }).unref();
    },
  });
}
