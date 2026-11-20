// The app starts a fixed system unit. Only the independently installed root helper can update files.
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { AppUpdates, latestRelease } from "./updates.mjs";

const exec = promisify(execFile);
const unit = "botkins-update.service";

export function isLinuxTarballExecutable(executable, stat = lstatSync, realpath = realpathSync) {
  if (basename(executable) !== "botkins-desktop") return false;
  try {
    const directory = dirname(executable);
    const current = join(dirname(directory), "current");
    return stat(current).isSymbolicLink() &&
      (basename(directory) === "current" || realpath(current) === realpath(directory));
  } catch { return false; }
}

export async function linuxUnitAvailable(run = exec) {
  try {
    const { stdout } = await run("systemctl", ["show", unit, "--property=LoadState", "--value"], {timeout:10_000});
    return stdout.trim() === "loaded";
  } catch { return false; }
}

export function installLinuxTarball(run = exec) {
  // systemd owns the job and health check even after it restarts this process.
  return run("systemctl", ["--no-ask-password", "start", unit], {timeout:480_000});
}

export function linuxUpdates({ app, notify, latest = () => latestRelease({token:""}), run = exec, executable = app.getPath("exe") }) {
  return new AppUpdates({
    current:app.getVersion(), mac:false, linux: app.isPackaged && !process.env.APPIMAGE &&
      ["arm64","x64"].includes(process.arch) && isLinuxTarballExecutable(executable),
    arch:process.arch, latest, notify, linuxUnitAvailable:() => linuxUnitAvailable(run),
    stage:async () => {}, restart:() => installLinuxTarball(run),
  });
}
