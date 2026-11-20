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
 * write to; the temporary name is removed first and then made new without following a link, so
 * nothing that was put there beforehand decides where the bytes go.
 * @returns true when it was written.
 */
export function writeLastUpdate(installRoot, record) {
  const clean = cleanLastUpdate(record);
  if (!clean) return false;
  const file = lastUpdateFile(installRoot);
  const temp = file + ".tmp";
  try {
    const folder = lstatSync(installRoot);
    if (!folder.isDirectory()) return false;
    if (process.getuid?.() === 0 && (folder.uid !== 0 || folder.mode & 0o022)) return false;
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

/** As root, the install folder and everything above it must be root's and not writable by anyone else. */
function rootOwned(path) {
  for (;;) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) throw new Error("The install folder " + path + " is not root's own, so nothing is installed into it.");
    if (path === dirname(path)) return;
    path = dirname(path);
  }
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
 * Puts a verified tarball in place and makes it the one in use.
 * @param options.manager  { restart(), status() → { active, pid? } } for the installed service, or
 *   nothing when there is none (the caller restarts by hand).
 * @returns { version, folder, previous }
 */
export async function switchTo({ archive, installRoot, version, platform = process.platform, arch = process.arch, manager, healthMs = 30_000, pollMs = 1000, checkOwner = process.getuid?.() === 0, exec = run }) {
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
    return { version, folder: target, previous: priorVersion };
  } catch (error) {
    if (switched) {
      renameSync(join(temp, "previous"), current);
      await manager?.restart().catch(() => {});
    }
    if (placed) rmSync(target, { recursive: true, force: true });
    throw switched ? new Error(error.message + " Botkins " + priorVersion + " was put back.") : error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * The whole update: the latest release, downloaded, verified, installed and watched.
 * @param options.entry    This copy's own cli/botkins.mjs.
 * @param options.manager  The installed service (desktop/terminal/manager.mjs), or nothing.
 * @param options.say      (line) → what is happening.
 * @param options.report   ({ at, from, to, ok, message? }) → how an install ended, a failed or
 *   undone one included. Not called when there was nothing newer to install.
 * @returns { status: "current" | "installed", current, latest?, previous? }
 */
export async function applyUpdate({ report = () => {}, now = () => new Date(), ...options }) {
  const layout = installLayout(options.entry);
  let to;
  try {
    const result = await install({ ...options, layout, found: (version) => (to = version) });
    if (result.status === "installed") report({ at: now().toISOString(), from: result.previous, to: result.current, ok: true });
    return result;
  } catch (error) {
    // A copy that doesn't update itself has no install to report. Anything else is an install that didn't end well.
    if (layout) report({ at: now().toISOString(), from: layout.version, to: to ?? layout.version, ok: false, message: error.message });
    throw error;
  }
}
/** Why a copy that wasn't installed from a release doesn't update itself, and what to do instead. */
export function unmanaged(env = process.env) {
  // A container is replaced by a new image, never updated from inside.
  if (env.BOTKINS_IMAGE) return "This Botkins runs from the Docker image " + env.BOTKINS_IMAGE + ", so it is updated by pulling the new image, not from inside the container. On the computer that runs it: `docker compose pull && docker compose up -d` (or `docker pull " + env.BOTKINS_IMAGE + ":latest` and start the container again). The data volume stays.";
  return "This copy of Botkins wasn't installed from a release, so it doesn't update itself. Update it the way it was installed (a checkout: `git pull`).";
}
async function install({ entry, layout, found, env = process.env, manager, say = () => {}, platform = process.platform, arch = process.arch, latest = () => latestRelease({ token: "" }), fetcher = fetch, verifier, healthMs }) {
  if (!layout) throw Object.assign(new Error(unmanaged(env)), { code: "UNMANAGED" });
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
    const done = await switchTo({ archive: join(dir, name), installRoot: layout.installRoot, version, platform, arch, manager, healthMs });
    return { status: "installed", current: version, latest: version, previous: done.previous };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
