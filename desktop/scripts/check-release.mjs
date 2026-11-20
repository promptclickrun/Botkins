#!/usr/bin/env node
// Checks that a release is whole, before it becomes the latest one.
//
//   node scripts/check-release.mjs [version] [--dir <folder>]… [--json]
//
// Every copy of Botkins looks for its update in the latest release: the desktop app, a Linux
// tarball under systemd, and the terminal host (`botkins update`, and the one-line installer at
// releases/latest/download/install.sh). A release that is missing one file leaves one of them
// with "no build for this system". So a release is made as a draft, this check is run on the
// draft, and the draft is published only when it passes.
//
// Without --dir it reads the GitHub release v<version> (a draft too) with the GitHub CLI and
// compares the checksums GitHub reports, so nothing large is downloaded. With --dir it reads the
// files in those folders, as the package scripts leave them, and hashes each one.
//
// It checks that:
//   - every file a release must have is there (expectedFiles below is the one list);
//   - SHA256SUMS lists every tarball and AppImage, lists nothing else, and each checksum matches;
//   - SHA256SUMS carries a good signature from the Botkins release key (the fingerprint the
//     updaters and install.sh trust);
//   - latest-mac.yml is for this version, and install.sh trusts the same key.
//
// It exits 0 when the release is whole, 1 when it is not, and 2 when it could not be read.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const REPO = "promptclickrun/Botkins";
/** The release key. desktop/linux-service/botkins-update-helper.mjs and install/install.sh trust the same one. */
export const FINGERPRINT = "366DD24D230E9F6BAE3EDE0AEB0AB1B21A7BAA7E";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TERMINAL = ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"];

/**
 * Every file a release of `version` must have.
 * @returns [{ name, signed, use }]: `signed` files must be in SHA256SUMS; `use` says who needs the file.
 */
export function expectedFiles(version) {
  if (!STABLE.test(version)) throw new Error("A release has a version like 1.2.3, not " + version + ".");
  const file = (name, use, signed = false) => ({ name, signed, use });
  return [
    file("Botkins-" + version + "-arm64-mac.zip", "the desktop app on a Mac"),
    file("Botkins-" + version + "-arm64-mac.zip.blockmap", "the desktop app's update on a Mac"),
    file("latest-mac.yml", "the desktop app's update on a Mac"),
    file("Botkins-" + version + "-win.zip", "the desktop app on Windows"),
    file("Botkins-" + version + ".AppImage", "the desktop app on Linux", true),
    file("Botkins-" + version + "-arm64.AppImage", "the desktop app on Linux", true),
    file("botkins-desktop-" + version + ".tar.gz", "the desktop app's update on Linux", true),
    file("botkins-desktop-" + version + "-arm64.tar.gz", "the desktop app's update on Linux", true),
    ...TERMINAL.map((target) => file("botkins-terminal-" + version + "-" + target + ".tar.gz", "`botkins update` and the installer on " + target.replace("-", "/"), true)),
    file("install.sh", "the one-line installer"),
    file("SHA256SUMS", "every updater's check"),
    file("SHA256SUMS.asc", "every updater's check"),
    file("botkins-release.asc", "a person who checks a download by hand"),
  ];
}

/** SHA256SUMS as { sums: Map(name → hex), problems }. */
export function parseSums(text) {
  const sums = new Map();
  const problems = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (\S.*)$/.exec(line);
    if (!match) problems.push("SHA256SUMS has a line that is not a checksum and a name: " + line.slice(0, 80));
    else if (sums.has(match[2])) problems.push("SHA256SUMS lists " + match[2] + " twice.");
    else sums.set(match[2], match[1]);
  }
  return { sums, problems };
}

/**
 * Compares what a release has with what it must have.
 * @param options.files  Map(name → the file's SHA-256 as hex, or undefined when it is not known).
 * @param options.sums   The text of SHA256SUMS, or undefined when the release has none.
 * @returns the problems, one sentence each. None means the files are right.
 */
export function checkFiles({ version, files, sums }) {
  const expected = expectedFiles(version);
  const problems = expected.filter(({ name }) => !files.has(name)).map(({ name, use }) => name + " is missing. It is needed for " + use + ".");
  if (sums === undefined) return problems;
  const parsed = parseSums(sums);
  problems.push(...parsed.problems);
  const signed = new Set(expected.filter((file) => file.signed).map((file) => file.name));
  for (const name of signed) {
    if (!files.has(name)) continue;
    const listed = parsed.sums.get(name);
    if (!listed) problems.push("SHA256SUMS does not list " + name + ", so no updater will install it.");
    else if (!files.get(name)) problems.push("The checksum of " + name + " is not known here, so it was not compared. Check the files themselves with --dir.");
    else if (listed !== files.get(name)) problems.push(name + " does not match its checksum in SHA256SUMS.");
  }
  for (const name of parsed.sums.keys()) {
    if (!signed.has(name)) problems.push("SHA256SUMS lists " + name + ", which is not a file of " + version + ".");
  }
  return problems;
}

/** latest-mac.yml must be for this version and name this version's ZIP. */
export function checkMacManifest(text, version) {
  const problems = [];
  if (!new RegExp("^version: " + version.replaceAll(".", "\\.") + "\\s*$", "m").test(text)) problems.push("latest-mac.yml is not for " + version + ", so a Mac will not take this update.");
  if (!text.includes("Botkins-" + version + "-arm64-mac.zip")) problems.push("latest-mac.yml does not name Botkins-" + version + "-arm64-mac.zip.");
  return problems;
}

/** install.sh must trust the release key and no other. */
export function checkInstaller(text) {
  const trusted = /^FINGERPRINT="([0-9A-F]+)"$/m.exec(text)?.[1];
  return trusted === FINGERPRINT ? [] : ["install.sh trusts " + (trusted ? "the key " + trusted : "no key") + ", not the Botkins release key."];
}

/**
 * SHA256SUMS must carry a good signature from the release key.
 * @param paths { sums, signature, key }: SHA256SUMS, SHA256SUMS.asc and botkins-release.asc.
 */
export function checkSignature(paths, fingerprint = FINGERPRINT) {
  const home = mkdtempSync(join(tmpdir(), "botkins-release-check-"));
  try {
    const keyring = join(home, "release.gpg");
    execFileSync("gpg", ["--batch", "--yes", "--homedir", home, "--dearmor", "--output", keyring, paths.key], { stdio: "ignore" });
    let status;
    try {
      status = execFileSync("gpgv", ["--homedir", home, "--status-fd=1", "--keyring", keyring, paths.signature, paths.sums], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return ["SHA256SUMS has no good signature from the key in botkins-release.asc."];
    }
    const signer = status.split("\n").map((line) => line.split(" ")).find((words) => words[0] === "[GNUPG:]" && words[1] === "VALIDSIG")?.[2];
    return signer === fingerprint ? [] : ["SHA256SUMS is signed by " + (signer ?? "an unknown key") + ", not the Botkins release key (" + fingerprint + ")."];
  } catch (error) {
    if (error.code === "ENOENT") return ["GnuPG is needed to check the signature, and it is not installed."];
    return ["botkins-release.asc could not be read as a key."];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The whole check, on files that are already listed and within reach. */
export function checkRelease({ version, files, paths, fingerprint = FINGERPRINT }) {
  const read = (name) => (paths.has(name) ? readFileSync(paths.get(name), "utf8") : undefined);
  const problems = checkFiles({ version, files, sums: read("SHA256SUMS") });
  if (["SHA256SUMS", "SHA256SUMS.asc", "botkins-release.asc"].every((name) => paths.has(name))) {
    problems.push(...checkSignature({ sums: paths.get("SHA256SUMS"), signature: paths.get("SHA256SUMS.asc"), key: paths.get("botkins-release.asc") }, fingerprint));
  }
  if (paths.has("latest-mac.yml")) problems.push(...checkMacManifest(read("latest-mac.yml"), version));
  if (paths.has("install.sh")) problems.push(...checkInstaller(read("install.sh")));
  return problems;
}

const SMALL = ["SHA256SUMS", "SHA256SUMS.asc", "botkins-release.asc", "latest-mac.yml", "install.sh"];

/** The GitHub release v<version>, a draft too: its files with GitHub's own checksums, and the small files downloaded into `dir`. */
export function readGitHub(version, dir, gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) {
  // A draft has no address by its tag, so the release is found in the list.
  const release = JSON.parse(gh(["api", "repos/" + REPO + "/releases?per_page=100"])).find((entry) => entry.tag_name === "v" + version);
  if (!release) throw new Error("GitHub has no release v" + version + " that this account can see.");
  const files = new Map(release.assets.map((asset) => [asset.name, /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ? asset.digest.slice(7) : undefined]));
  const small = SMALL.filter((name) => files.has(name));
  if (small.length) gh(["release", "download", "v" + version, "--repo", REPO, "--dir", dir, "--clobber", ...small.flatMap((name) => ["--pattern", name])]);
  return { files, paths: new Map(small.map((name) => [name, join(dir, name)])), where: release.draft ? "a draft on GitHub" : release.prerelease ? "a prerelease on GitHub" : "published on GitHub", prerelease: release.prerelease === true };
}

/** The files in `dirs`, each hashed. */
export async function readFolders(dirs) {
  const files = new Map();
  const paths = new Map();
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isFile() || files.has(name)) continue;
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      files.set(name, hash.digest("hex"));
      paths.set(name, path);
    }
  }
  return { files, paths, where: "in " + dirs.join(" and ") };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: "string", multiple: true }, json: { type: "boolean" } } });
  const version = (positionals[0] ?? JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version).replace(/^v/, "");
  const temp = mkdtempSync(join(tmpdir(), "botkins-release-files-"));
  try {
    const found = values.dir ? await readFolders(values.dir) : readGitHub(version, temp);
    const problems = checkRelease({ version, files: found.files, paths: found.paths });
    if (found.prerelease) problems.push("The release is marked as a prerelease. No copy of Botkins updates to a prerelease.");
    if (values.json) console.log(JSON.stringify({ version, where: found.where, ok: problems.length === 0, problems }));
    else if (problems.length) console.log("Botkins " + version + " (" + found.where + ") is not whole:\n\n" + problems.map((problem) => "  - " + problem).join("\n") + "\n\nDo not publish it as the latest release.");
    else console.log("Botkins " + version + " (" + found.where + ") is whole: " + expectedFiles(version).length + " files, signed checksums that match, and an installer and a Mac manifest for this version.");
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
