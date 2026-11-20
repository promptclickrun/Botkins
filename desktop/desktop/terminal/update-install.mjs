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
import { createWriteStream, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
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
 * @returns { status: "current" | "installed", current, latest?, previous? }
 */
export async function applyUpdate({ entry, manager, say = () => {}, platform = process.platform, arch = process.arch, latest = () => latestRelease({ token: "" }), fetcher = fetch, verifier, healthMs }) {
  const layout = installLayout(entry);
  if (!layout) throw Object.assign(new Error("This copy of Botkins wasn't installed from a release, so it doesn't update itself. Update it the way it was installed (a checkout: `git pull`; Docker: pull the new image)."), { code: "UNMANAGED" });
  const { version, assets } = await latest();
  if (!semver.gt(version, layout.version)) return { status: "current", current: layout.version };
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
