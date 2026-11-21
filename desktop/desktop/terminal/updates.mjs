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
// How it ended is in <install folder>/last-update.json, which the install writes and the service
// reads (`last` in the status a phone is shown): after a restart on the new version, and also
// when the new version didn't stay up and the old one was put back. It is beside the versions,
// in a folder that is root's own, and not in the data folder, where a bot's tool could have put
// a link under any name (desktop/terminal/update-install.mjs).
//
// `updates.auto` (off unless switched on, here or from a phone) installs a new release without
// being asked, once no bot is in the middle of a turn.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppUpdates, latestRelease } from "../updates.mjs";
import { serviceManager } from "./manager.mjs";
import { withSetting } from "./config.mjs";
import { assetName, installLayout, notRootOwned, notRootOwnedWords, readLastUpdate } from "./update-install.mjs";

const ENTRY = fileURLToPath(new URL("../../cli/botkins.mjs", import.meta.url));
export const REQUEST = "update-requested";

/** How long the root job has to take the request up, before the service says the install never started and takes the request back. */
const STARTED_MS = 2 * 60_000;
/** How long an install that started may take to say how it ended: three downloads of five minutes at most, and the watch on the new version. */
const HEARD_MS = 25 * 60_000;

/** The update service for `botkins serve` (desktop/terminal/serve.mjs). */
const NO_SERVICE = "This computer runs Botkins from a terminal, not as a service, so it can't update itself. On the computer, run `botkins service install`, or `botkins update`.";

export function terminalUpdates(service, { entry = ENTRY, platform = process.platform, arch = process.arch, latest = () => latestRelease({ token: "" }), manager = serviceManager({ command: [process.execPath, entry] }), launch = spawn, env = process.env, pollMs = 2000, startedMs = STARTED_MS, heardMs = HEARD_MS, autoPollMs, folder = notRootOwned } = {}) {
  const layout = installLayout(entry);
  const found = () => manager.installed();
  const last = () => (layout ? readLastUpdate(layout.installRoot) : null);
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
    linuxUnitAvailable: async () => {
      // The whole computer's service is updated by root, and root installs nothing into a folder
      // somebody else can write to. That is known now, so it is said now, to whoever looks (a
      // phone too), and no request is left for a job that would only refuse it.
      const unsafe = layout && found()?.scope === "system" ? folder(layout.installRoot) : null;
      updates.unitMissing = unsafe ? notRootOwnedWords(unsafe, layout.installRoot) : NO_SERVICE;
      return !!found() && !unsafe;
    },
    unitMissing: NO_SERVICE,
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
      const request = join(service.paths.runDir, REQUEST);
      // The whole computer's service leaves a request for the root job; anyone else's starts the install itself.
      const asked = scope === "system" && platform !== "darwin";
      service.log.info("An update was asked for.");
      if (asked) closeSync(openSync(request, "w", 0o600));
      else {
        // Its own session, so the service's restart leaves it running; systemd-run where there is one, so the unit's own cleanup does too.
        const command = platform === "darwin" ? [process.execPath, [entry, "update", "--apply"]] : ["systemd-run", ["--user", "--collect", "--unit=botkins-update", process.execPath, entry, "update", "--apply"]];
        launch(command[0], command[1], { detached: true, stdio: "ignore", env: { ...env, BOTKINS_DATA_DIR: service.paths.root } }).unref();
      }
      // An install that works restarts this service, and the next one reads how it ended. One
      // that fails before that leaves this service running: it hears of it here, and says so.
      const started = Date.now();
      const giveUp = (message) => {
        clearInterval(watch);
        updates.state = { ...updates.state, status: "error", canInstall: false, message };
        service.log.error("Update: " + message);
        service.changed?.();
      };
      const watch = setInterval(() => {
        const record = last();
        if (record && record.at !== before) {
          // An install that went well may still have something to say (service files that could not be written).
          if (record.ok) return void (clearInterval(watch), record.message && service.log.info("Update: " + record.message));
          return giveUp(record.message ?? "The update could not be installed.");
        }
        const waited = Date.now() - started;
        // The root job takes the request away as its first act. Still there after a while: no job
        // came for it. It is taken back, so a watch that starts later doesn't install unasked.
        if (asked && existsSync(request) && waited >= startedMs) {
          rmSync(request, { force: true });
          return giveUp("The update did not start: this computer's update job did not take the request. On the computer, `botkins doctor` and `botkins update` say why.");
        }
        if (waited >= heardMs) giveUp("The update started and did not say how it ended. On the computer, `botkins update` says where it stands.");
      }, pollMs);
      watch.unref?.();
    },
  });
  // What the install that brought this version had to say, for whoever reads the log: the phone
  // is shown the same record (`last`), and `botkins status` shows it too.
  const brought = updates.lastInstall();
  if (brought?.ok && brought.message) service.log.info("The update to Botkins " + brought.to + " went well, with this to know: " + brought.message);
  return updates;
}
