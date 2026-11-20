// Installing a new release of the terminal host, safely.
//
// Where a release comes from is fixed here: the project's own GitHub releases, and nowhere a
// chat, a setting or an environment variable could name. What is installed is only ever a file
// whose checksum is in SHA256SUMS, and SHA256SUMS only counts when it carries a good signature
// from the Botkins release key (the same check, and the same key, as the desktop app's Linux
// updater: desktop/linux-service/botkins-update-helper.mjs, `verifyRelease`). The key is the copy
// that came with the release already installed, which was itself verified when it was installed.
// An unsigned release, or one signed by another key, is never installed.
//
// A copy installed from a release sits in
//
//   <install folder>/botkins-terminal-<version>-<system>-<arch>/     one folder for each version
//   <install folder>/current → the one in use
//
// An update unpacks the new version beside the old one, points `current` at it in one step,
// restarts the service and watches it for a while. If the new one doesn't stay up, `current` goes
// back to the old version and that one is started again. The old version stays on disk.
import { execFile, execFileSync } from "node:child_process";
import { closeSync, constants, createWriteStream, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import semver from "semver";
import { verifyRelease } from "../linux-service/botkins-update-helper.mjs";
import { latestRelease } from "../updates.mjs";

const RELEASES = "https://github.com/promptclickrun/Botkins/releases/download/";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FOLDER = /^botkins-terminal-(\d+\.\d+\.\d+)-(linux|macos)-(x64|arm64)$/;
const run = promisify(execFile);

/**
 * How the last install ended, kept beside the versions: <install folder>/last-update.json. The
 * install runs in a process of its own (a root job, for the whole computer's service) and
 * restarts the service, so this file is the only way the service, and a phone that asked for the
 * update, learns afterwards that it worked, failed, or was put back.
 *
 * It is in the install folder, not the data folder, on purpose. The data folder belongs to the
 * user the service runs as, and so to every tool a bot runs: a name there can be made a link to
 * any file on the computer. The root job writes nothing into it. The install folder is root's
 * own (the job refuses any other), so what the job writes here can't be redirected.
 */
export const lastUpdateFile = (installRoot) => join(installRoot, "last-update.json");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A record as it may be shown: versions that are versions, a date that is a date, a message of a sensible length. Anything else is no record. */
export function cleanLastUpdate(record) {
  if (record === null || typeof record !== "object") return null;
  const { at, from, to, ok, message } = record;
  if (typeof at !== "string" || at.length > 40 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || Number.isNaN(Date.parse(at))) return null;
  if (typeof from !== "string" || from.length > 32 || !VERSION.test(from) || typeof to !== "string" || to.length > 32 || !VERSION.test(to) || typeof ok !== "boolean") return null;
  return { at, from, to, ok, ...(typeof message === "string" && message.trim() && { message: message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) }) };
}
/** { at, from, to, ok, message? }, or null when there is none or it can't be read. */
export function readLastUpdate(installRoot) {
  try {
    const file = lastUpdateFile(installRoot);
    // A link in its place is not followed: the record is a plain file the install made.
    if (!lstatSync(file).isFile()) return null;
    return cleanLastUpdate(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
/**
 * Writes the record. As root, only into a folder that is root's own and that nobody else can
 * write to, with every folder above it the same; the temporary name is removed first and then
 * made new without following a link, so nothing that was put there beforehand decides where the
 * bytes go.
 * @param options.top  Where the look upwards ends ("/"). The tests end it at a folder of their own.
 * @returns true when it was written.
 */
export function writeLastUpdate(installRoot, record, { top = "/" } = {}) {
  const clean = cleanLastUpdate(record);
  if (!clean) return false;
  const file = lastUpdateFile(installRoot);
  const temp = file + ".tmp";
  try {
    const folder = lstatSync(installRoot);
    if (!folder.isDirectory()) return false;
    // The folder and every folder above it: where somebody else can write to one of those, they
    // can put another folder under this one's name between the look and the write.
    if (process.getuid?.() === 0 && notRootOwned(installRoot, top)) return false;
    rmSync(temp, { force: true });
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(fd, JSON.stringify(clean) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // rename replaces the name itself, whatever it was: a link there is replaced, never written through.
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` with the rights of the user a folder belongs to, when this process is root. What
 * root does inside a folder that isn't root's own (the service's data folder) is done this way:
 * a name in there that was made a link then leads only where that user could go anyway.
 */
export function asOwnerOf(dir, fn) {
  if (process.getuid?.() !== 0) return fn();
  const folder = lstatSync(dir);
  if (!folder.isDirectory()) throw new Error(dir + " is not a folder.");
  if (folder.uid === 0) return fn();
  const groups = process.getgroups();
  process.setgroups([folder.gid]);
  process.setegid(folder.gid);
  process.seteuid(folder.uid);
  try {
    return fn();
  } finally {
    process.seteuid(0);
    process.setegid(0);
    process.setgroups(groups);
  }
}

/**
 * Takes the service's request for an update up: removes <data folder>/run/update-requested,
 * with the data folder owner's rights, whatever was put under that name. Left there, the watch
 * would start the job again. Never throws: a request that can't be removed is not a reason to
 * skip the install, and systemd's own limit stops a watch that keeps firing.
 * @returns true when nothing is left under that name.
 */
export function takeRequest(root, name = "update-requested") {
  try {
    return asOwnerOf(root, () => {
      rmSync(join(root, "run", name), { recursive: true, force: true });
      return true;
    });
  } catch {
    return false;
  }
}

/** "linux" or "macos", as a release names the system. */
export const systemName = (platform = process.platform) => (platform === "darwin" ? "macos" : "linux");
/** The folder a version is installed in, which is also the one folder inside its tarball. */
export function folderName(version, platform = process.platform, arch = process.arch) {
  if (!STABLE.test(version) || !["x64", "arm64"].includes(arch) || !["linux", "darwin"].includes(platform)) throw new Error("There is no Botkins terminal host release for this system (" + platform + "/" + arch + ").");
  return "botkins-terminal-" + version + "-" + systemName(platform) + "-" + arch;
}
export const assetName = (version, platform, arch) => folderName(version, platform, arch) + ".tar.gz";

/**
 * Where this copy is installed, when it came from a release:
 * { installRoot, current, folder, version }, or null for a checkout.
 */
export function installLayout(entry) {
  try {
    const folder = dirname(dirname(realpathSync(entry)));
    const installRoot = dirname(folder);
    const current = join(installRoot, "current");
    const version = FOLDER.exec(basename(folder))?.[1];
    if (!version || !lstatSync(current).isSymbolicLink() || realpathSync(current) !== folder) return null;
    return { installRoot, current, folder, version };
  } catch {
    return null;
  }
}

/**
 * The first folder, from `path` up to `top`, that is not root's own or that somebody other than
 * root can write to: { path, mode, uid }, or null when every one of them is root's alone.
 *
 * Root installs a version by unpacking it under the install folder and pointing `current` at
 * it. Whoever can write to that folder, or to a folder above it, can put their own files where
 * root is about to run them. So the installer, the updater and `botkins doctor` all ask this,
 * and a computer where the answer is not null is told so before anything is installed.
 */
export function notRootOwned(path, top = "/") {
  for (;;) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return { path, uid: -1, mode: 0 };
    }
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) return { path, uid: stat.uid, mode: stat.mode & 0o7777 };
    if (path === top || path === dirname(path)) return null;
    path = dirname(path);
  }
}
/** What to say of a folder `notRootOwned` found, with the commands that put it right. One or two sentences: a phone shows them as they are. */
export function notRootOwnedWords(found, installRoot) {
  const quoted = /^[A-Za-z0-9_./-]+$/.test(found.path) ? found.path : "'" + found.path.replace(/'/g, "'\\''") + "'";
  // A folder that could not be looked at: nothing is known of whose it is, so no command is offered that might not help.
  if (found.uid === -1) return "The folder " + found.path + " is not there or can't be read, so Botkins can't be updated in " + installRoot + ".";
  const why = found.uid !== 0 ? "does not belong to root" : "can be changed by users other than root (its mode is " + found.mode.toString(8) + ")";
  return "The folder " + found.path + " " + why + ", so Botkins can't be updated in " + installRoot + ". On the computer: `sudo chown root " + quoted + " && sudo chmod go-w " + quoted + "`.";
}
/** As root, the install folder and everything above it must be root's and not writable by anyone else. */
function rootOwned(path) {
  const found = notRootOwned(path);
  if (found) throw Object.assign(new Error(notRootOwnedWords(found, path)), { code: "INSTALL_FOLDER" });
}

/** Downloads a release's tarball and its signed checksums into `dir`. */
export async function download({ version, name, dir, fetcher = fetch, base = RELEASES }) {
  for (const file of [name, "SHA256SUMS", "SHA256SUMS.asc"]) {
    const response = await fetcher(base + "v" + version + "/" + file, { redirect: "follow", headers: { "User-Agent": "Botkins-terminal-updater" }, signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error("The release file " + file + " couldn't be downloaded (HTTP " + response.status + ").");
    await pipeline(response.body, createWriteStream(join(dir, file), { flags: "wx", mode: 0o600 }));
  }
}

/**
 * Checks the tarball in `dir` against the signed checksums, with the release key that came with
 * the installed copy. Throws unless the signature is the Botkins release key's and the checksum matches.
 */
export async function verify({ dir, name, keyFile, verifier = verifyRelease }) {
  const keyring = join(dir, "release.gpg");
  try {
    execFileSync("gpg", ["--batch", "--yes", "--homedir", dir, "--dearmor", "--output", keyring, keyFile], { stdio: "ignore" });
  } catch (error) {
    throw new Error(error.code === "ENOENT" ? "GnuPG is needed to check a release's signature, and it isn't installed. Install it (Debian and Ubuntu: `apt-get install gnupg`), then update again." : "The release key couldn't be read, so the release can't be checked.");
  }
  await verifier(dir, name, keyring);
}

/**
 * Asks a version that is in place to write the service's files as it would install them, with
 * what was chosen when the service was installed (`botkins service refresh`). The program that
 * runs is the new version's own, from the folder its verified tarball was unpacked into: this
 * updater is the old version's, and can't know what the new one's files say.
 */
const refreshWith = (exec) => (folder) => exec(join(folder, "bin", "botkins"), ["service", "refresh", "--no-restart", "--json"], { timeout: 120_000, maxBuffer: 1024 * 1024 });

/**
 * Puts a verified tarball in place and makes it the one in use.
 *
 * Between the switch and the restart, the service's files are brought up to date with the new
 * version, so the service starts under them. What they held is kept first, and is put back with
 * the old version when the new one doesn't stay up. When the files can't be brought up to date
 * they are left as they were and the update goes on: the new version under the earlier files is
 * what every update before this did, and `botkins doctor` says that they differ.
 *
 * @param options.manager  { restart(), status() → { active, pid? }, snapshot?(), restore?(saved) }
 *   for the installed service, or nothing when there is none (the caller restarts by hand).
 * @param options.refresh  (folder) → brings the service's files up to date with the version in `folder`.
 * @returns { version, folder, previous, note? }  `note` says what a person should know about an install that went well.
 */
export async function switchTo({ archive, installRoot, version, platform = process.platform, arch = process.arch, manager, healthMs = 30_000, pollMs = 1000, checkOwner = process.getuid?.() === 0, exec = run, refresh = refreshWith(exec) }) {
  const top = folderName(version, platform, arch);
  const target = join(installRoot, top);
  const current = join(installRoot, "current");
  if (installRoot !== resolve(installRoot)) throw new Error("The install folder isn't a whole path.");
  if (checkOwner) rootOwned(installRoot);
  const prior = resolve(installRoot, readlinkSync(current));
  const priorVersion = FOLDER.exec(basename(prior))?.[1];
  if (dirname(prior) !== installRoot || !priorVersion || !lstatSync(prior).isDirectory()) throw new Error("The version in use isn't one this updater installed.");
  if (!semver.gt(version, priorVersion)) throw new Error("Botkins " + version + " is not newer than the installed " + priorVersion + ".");
  if (existsSync(target)) throw new Error("Botkins " + version + " is already unpacked in " + target + ". Remove that folder to install it again.");
  // Everything in the tarball is inside its one folder, and nothing climbs out of it.
  const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 });
  if (stdout.trimEnd().split("\n").some((path) => path.split("/")[0] !== top || path.split("/").includes(".."))) throw new Error("The release holds files outside its own folder.");
  const temp = mkdtempSync(join(installRoot, ".update-"));
  let placed = false;
  let switched = false;
  // What the service's files held before the new version wrote its own, and why it couldn't, if it couldn't.
  let saved = null;
  let problem;
  try {
    await exec("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", temp]);
    const stage = join(temp, top);
    for (const file of ["bin/botkins", "cli/botkins.mjs", "package.json"]) if (!lstatSync(join(stage, file)).isFile()) throw new Error("The release is missing " + file + ".");
    if (JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).version !== version) throw new Error("The release's own version isn't " + version + ".");
    symlinkSync(prior, join(temp, "previous"));
    symlinkSync(target, join(temp, "next"));
    renameSync(stage, target);
    placed = true;
    // One rename: `current` is the old version or the new one, never neither.
    renameSync(join(temp, "next"), current);
    switched = true;
    if (manager) {
      if (manager.snapshot && manager.restore) {
        try {
          saved = manager.snapshot();
          await refresh(target);
        } catch (error) {
          problem = "The service's files could not be brought up to date with Botkins " + version + " (" + String(error.stderr || error.message || error).trim().split("\n").at(-1).replace(/^botkins: /, "").slice(0, 160) + ").";
          // Half-written is worse than old: whatever was changed goes back.
          await manager.restore(saved).catch(() => {});
          saved = null;
        }
      }
      await manager.restart();
      // The new version has to stay up, as one process, for the whole watch.
      const until = Date.now() + healthMs;
      let first;
      for (;;) {
        const status = await manager.status();
        if (!status.active) throw new Error("The new version didn't stay running.");
        if (first !== undefined && status.pid !== first) throw new Error("The new version restarted while it was being watched.");
        first = status.pid;
        if (Date.now() >= until) break;
        await new Promise((done) => setTimeout(done, pollMs));
      }
    }
    return { version, folder: target, previous: priorVersion, ...(problem && { note: problem + " `botkins doctor` says what to do." }) };
  } catch (error) {
    if (switched) {
      renameSync(join(temp, "previous"), current);
      // The old version runs under the files it had. When they can't be put back, that is said: it then runs under the newer ones.
      if (saved) await manager.restore(saved).catch((failure) => void (problem = "The service's files could not be put back as Botkins " + priorVersion + " had them (" + String(failure.message).slice(0, 160) + "); `botkins doctor` says what to do."));
      await manager?.restart().catch(() => {});
    }
    if (placed) rmSync(target, { recursive: true, force: true });
    throw switched ? new Error(error.message + (problem ? " " + problem : "") + " Botkins " + priorVersion + " was put back.") : error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * The whole update: the latest release, downloaded, verified, installed and watched.
 *
 * An update can also end without any of this code hearing of it: an error thrown outside every
 * promise ends the process. Node's own HTTP client has done that, with an assertion of its own,
 * when a server closed the connection in the middle of a download. The job would then be gone
 * with nothing written, and a phone that asked would wait for the service to give up on it
 * (25 minutes). So such an end is listened for while the update runs, and is recorded as what it
 * is: an install that did not end well. The record names no version it tried to install: a
 * death like this says nothing against the release, so a host that installs by itself tries it again.
 *
 * @param options.entry    This copy's own cli/botkins.mjs.
 * @param options.manager  The installed service (desktop/terminal/manager.mjs), or nothing.
 * @param options.say      (line) → what is happening.
 * @param options.report   ({ at, from, to, ok, message? }) → how an install ended, a failed or
 *   undone one included. Not called when there was nothing newer to install.
 * @param options.watched  What tells of an error nobody caught (the process). Tests pass their own.
 * @param options.die      (code) → ends the process once such an error is recorded.
 * @returns { status: "current" | "installed", current, latest?, previous?, note? }
 */
export async function applyUpdate({ report = () => {}, now = () => new Date(), watched = process, die = (code) => process.exit(code), ...options }) {
  const layout = installLayout(options.entry);
  let to;
  const died = (error) => {
    const why = (error?.code ? error.code + ": " : "") + String(error?.message ?? error).trim().split("\n")[0];
    const message = "The update" + (to ? " to Botkins " + to : "") + " stopped before it was done (" + why.slice(0, 140) + "). Ask for it again.";
    try {
      if (layout) report({ at: now().toISOString(), from: layout.version, to: layout.version, ok: false, message });
    } catch {
      // Nothing more can be done about a record that can't be written.
    }
    console.error("botkins: " + message);
    die(1);
  };
  watched.on("uncaughtException", died);
  try {
    const result = await install({ ...options, layout, found: (version) => (to = version) });
    if (result.status === "installed") report({ at: now().toISOString(), from: result.previous, to: result.current, ok: true, ...(result.note && { message: result.note }) });
    return result;
  } catch (error) {
    // A copy that doesn't update itself has no install to report. Anything else is an install that didn't end well.
    if (layout) report({ at: now().toISOString(), from: layout.version, to: to ?? layout.version, ok: false, message: error.message });
    throw error;
  } finally {
    watched.off("uncaughtException", died);
  }
}
/** Why a copy that wasn't installed from a release doesn't update itself, and what to do instead. */
export function unmanaged(env = process.env) {
  // A container is replaced by a new image, never updated from inside.
  if (env.BOTKINS_IMAGE) return "This Botkins runs from the Docker image " + env.BOTKINS_IMAGE + ", so it is updated by pulling the new image, not from inside the container. On the computer that runs it: `docker compose pull && docker compose up -d` (or `docker pull " + env.BOTKINS_IMAGE + ":latest` and start the container again). The data volume stays.";
  return "This copy of Botkins wasn't installed from a release, so it doesn't update itself. Update it the way it was installed (a checkout: `git pull`).";
}
async function install({ entry, layout, found, env = process.env, manager, say = () => {}, platform = process.platform, arch = process.arch, latest = () => latestRelease({ token: "" }), fetcher = fetch, verifier, healthMs, checkOwner = process.getuid?.() === 0 }) {
  if (!layout) throw Object.assign(new Error(unmanaged(env)), { code: "UNMANAGED" });
  // Said before anything is downloaded: an install folder root can't trust is one nothing will be installed into.
  if (checkOwner) rootOwned(layout.installRoot);
  const { version, assets } = await latest();
  if (!semver.gt(version, layout.version)) return { status: "current", current: layout.version };
  found(version);
  const name = assetName(version, platform, arch);
  for (const file of [name, "SHA256SUMS", "SHA256SUMS.asc"]) if (!assets.includes(file)) throw Object.assign(new Error("Botkins " + version + " has no signed terminal host build for this system yet (" + file + " is not in the release)."), { code: "NO_BUILD" });
  const dir = mkdtempSync(join(tmpdir(), "botkins-update-"));
  try {
    say("Downloading Botkins " + version + ".");
    await download({ version, name, dir, fetcher });
    say("Checking its signature and checksum.");
    await verify({ dir, name, keyFile: join(layout.folder, "desktop", "linux-service", "botkins-release.asc"), verifier });
    say("Installing it beside Botkins " + layout.version + (manager ? " and restarting the service." : "."));
    const done = await switchTo({ archive: join(dir, name), installRoot: layout.installRoot, version, platform, arch, manager, healthMs, checkOwner });
    return { status: "installed", current: version, latest: version, previous: done.previous, ...(done.note && { note: done.note }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
