// Updates for the running terminal host: looking for a newer release now and then, telling the
// owner's phones when there is one, and getting it installed when the person (at the terminal,
// from a paired phone, or by a bot they asked) says so, or by itself when they chose that.
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
// request: the latest release from the project's own address, checked against its signed
// checksums. Nothing a phone, a bot or a setting says names a version or an address.
//
// How it ended is in <data folder>/last-update.json, which the install writes and the service
// reads (`last` in the status a phone is shown): after a restart on the new version, and also
// when the new version didn't stay up and the old one was put back.
//
// `updates.auto` (off unless switched on, here or from a phone) installs a new release without
// being asked, once no bot is in the middle of a turn.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppUpdates, latestRelease } from "../updates.mjs";
import { serviceManager } from "./manager.mjs";
import { withSetting } from "./config.mjs";
import { assetName, installLayout, readLastUpdate } from "./update-install.mjs";

const ENTRY = fileURLToPath(new URL("../../cli/botkins.mjs", import.meta.url));
export const REQUEST = "update-requested";

/** How long the service waits to hear how an install it asked for ended, before it says the install never started. */
const HEARD_MS = 10 * 60_000;

/** The update service for `botkins serve` (desktop/terminal/serve.mjs). */
export function terminalUpdates(service, { entry = ENTRY, platform = process.platform, arch = process.arch, latest = () => latestRelease({ token: "" }), manager = serviceManager({ command: [process.execPath, entry] }), launch = spawn, env = process.env, pollMs = 2000, heardMs = HEARD_MS, autoPollMs } = {}) {
  const layout = installLayout(entry);
  const found = () => manager.installed();
  const last = () => readLastUpdate(service.paths.root);
  // A container is replaced, not updated from inside: its image is named, so the person knows what to pull.
  const image = env.BOTKINS_IMAGE;
  const updates = new AppUpdates({
    current: service.version,
    mac: false,
    // "linux" here means: a copy installed from a tarball, which is what the terminal host is on every system.
    linux: !!layout,
    arch,
    latest,
    linuxAsset: (version) => assetName(version, platform, arch),
    linuxUnitAvailable: async () => !!found(),
    unitMissing: "This computer runs Botkins from a terminal, not as a service, so it can't update itself. On the computer, run `botkins service install`, or `botkins update`.",
    cannotInstall: layout
      ? "This computer can't install this release by itself: it has no signed build for this system yet, or Botkins isn't installed as a service there. On the computer, `botkins update` says which."
      : image
        ? "This Botkins runs from a Docker image, which is replaced, not updated from inside. On the computer, pull the new image (" + image + ") and start the container again."
        : "This copy of Botkins wasn't installed from a release, so it doesn't update itself.",
    // Installing by itself is a choice only where this copy can install at all.
    ...(layout && {
      auto: {
        get: () => service.config().updates.auto === true,
        set: (on) => void Promise.resolve(service.setConfig(withSetting(service.config(), "updates.auto", on))).catch((error) => service.log.error("updates.auto: " + error.message)),
      },
    }),
    idle: () => !service.runtime || service.runtime.workspace.active.size === 0,
    last,
    autoPollMs,
    log: (line) => service.log.info(line),
    words: {
      check: "Check the version of Botkins on this host against the latest stable GitHub release.",
      install: "When the person asks to update Botkins, install its signed update. The service on this host restarts after this reply.",
    },
    // The log has it for whoever reads the log; the owner's phones are told by the link (desktop/runtime.mjs).
    notify: (version) => service.log.info("Botkins " + version + " is available (this is " + service.version + "). Install it with `botkins update`, or from a paired phone."),
    stage: async () => {},
    restart: () => {
      const scope = found()?.scope;
      const before = last()?.at;
      service.log.info("An update was asked for.");
      if (scope === "system" && platform !== "darwin") closeSync(openSync(join(service.paths.runDir, REQUEST), "w", 0o600));
      else {
        // Its own session, so the service's restart leaves it running; systemd-run where there is one, so the unit's own cleanup does too.
        const command = platform === "darwin" ? [process.execPath, [entry, "update", "--apply"]] : ["systemd-run", ["--user", "--collect", "--unit=botkins-update", process.execPath, entry, "update", "--apply"]];
        launch(command[0], command[1], { detached: true, stdio: "ignore", env: { ...env, BOTKINS_DATA_DIR: service.paths.root } }).unref();
      }
      // An install that works restarts this service, and the next one reads how it ended. One
      // that fails before that leaves this service running: it hears of it here, and says so.
      const started = Date.now();
      const watch = setInterval(() => {
        const record = last();
        const heard = record && record.at !== before;
        if (!heard && Date.now() - started < heardMs) return;
        clearInterval(watch);
        if (heard && record.ok) return;
        updates.state = { ...updates.state, status: "error", canInstall: false, message: heard ? record.message ?? "The update could not be installed." : "The update did not start. On the computer, `botkins update` says why." };
        service.log.error("Update: " + updates.state.message);
        service.changed?.();
      }, pollMs);
      watch.unref?.();
    },
  });
  return updates;
}
