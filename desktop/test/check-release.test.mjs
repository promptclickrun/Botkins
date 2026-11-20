import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINGERPRINT, checkFiles, checkInstaller, checkMacManifest, checkRelease, checkSignature, expectedFiles, parseSums, readFolders, readGitHub } from "../scripts/check-release.mjs";

const VERSION = "1.4.2";
const sha = (text) => createHash("sha256").update(text).digest("hex");
/** A whole release: every expected file, its made-up bytes, and a SHA256SUMS that fits. */
function whole(version = VERSION) {
  const bytes = new Map(expectedFiles(version).map(({ name }) => [name, "bytes of " + name]));
  bytes.set("latest-mac.yml", "version: " + version + "\nfiles:\n  - url: Botkins-" + version + "-arm64-mac.zip\npath: Botkins-" + version + "-arm64-mac.zip\n");
  bytes.set("install.sh", '#!/bin/sh\nREPO="promptclickrun/Botkins"\nFINGERPRINT="' + FINGERPRINT + '"\n');
  bytes.set("SHA256SUMS", expectedFiles(version).filter((file) => file.signed).map(({ name }) => sha(bytes.get(name)) + "  " + name).join("\n") + "\n");
  return { bytes, files: new Map([...bytes].map(([name, text]) => [name, sha(text)])), sums: bytes.get("SHA256SUMS") };
}
const hasGpg = (() => {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    execFileSync("gpgv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
/** A signing key made for one test: { home, fingerprint, sign(file), exportTo(file) }. */
function testKey(t) {
  const home = mkdtempSync(join(tmpdir(), "bk-key-"));
  t.after(() => {
    try {
      execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], { stdio: "ignore" });
    } catch {
      // No agent was started.
    }
    rmSync(home, { recursive: true, force: true });
  });
  const gpg = (args) => execFileSync("gpg", ["--batch", "--yes", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", "", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  gpg(["--quick-generate-key", "Release check test <test@example.invalid>", "ed25519", "sign", "never"]);
  const fingerprint = /^fpr:+([0-9A-F]{40}):/m.exec(gpg(["--list-keys", "--with-colons"]))[1];
  return { fingerprint, sign: (file) => gpg(["--armor", "--detach-sign", "--output", file + ".asc", file]), exportTo: (file) => gpg(["--armor", "--output", file, "--export", fingerprint]) };
}

test("a release has sixteen files, and only a stable version names one", () => {
  const names = expectedFiles(VERSION).map((file) => file.name);
  assert.equal(names.length, 16);
  assert.equal(new Set(names).size, 16);
  for (const target of ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"]) assert.ok(names.includes("botkins-terminal-1.4.2-" + target + ".tar.gz"));
  assert.ok(names.includes("install.sh"));
  // What the desktop app's updaters look for (desktop/updates.mjs).
  for (const name of ["Botkins-1.4.2-arm64-mac.zip", "latest-mac.yml", "botkins-desktop-1.4.2.tar.gz", "botkins-desktop-1.4.2-arm64.tar.gz"]) assert.ok(names.includes(name));
  assert.deepEqual(expectedFiles(VERSION).filter((file) => file.signed).length, 8);
  for (const bad of ["1.4", "v1.4.2", "1.4.2-beta.1", ""]) assert.throws(() => expectedFiles(bad), /version like 1\.2\.3/);
});

test("a whole release has no problems", () => {
  const { files, sums } = whole();
  assert.deepEqual(checkFiles({ version: VERSION, files, sums }), []);
});

test("a missing file is named with who needs it", () => {
  const { files, sums } = whole();
  files.delete("botkins-terminal-1.4.2-linux-arm64.tar.gz");
  files.delete("install.sh");
  const problems = checkFiles({ version: VERSION, files, sums });
  assert.ok(problems.includes("botkins-terminal-1.4.2-linux-arm64.tar.gz is missing. It is needed for `botkins update` and the installer on linux/arm64."));
  assert.ok(problems.includes("install.sh is missing. It is needed for the one-line installer."));
  // A missing file is reported once, not again for its line in SHA256SUMS.
  assert.equal(problems.length, 2);
});

test("a release without the terminal host is refused, as every release before it would be", () => {
  const { files, sums } = whole();
  const desktopOnly = new Map([...files].filter(([name]) => !name.startsWith("botkins-terminal-") && name !== "install.sh"));
  const desktopSums = sums.split("\n").filter((line) => !line.includes("botkins-terminal-")).join("\n");
  const problems = checkFiles({ version: VERSION, files: desktopOnly, sums: desktopSums });
  assert.equal(problems.length, 5);
  assert.ok(problems.every((problem) => / is missing\. /.test(problem)));
});

test("checksums: a file left out, a file that changed, a file of another version, a line that is not one", () => {
  const { files, sums } = whole();
  const without = sums.split("\n").filter((line) => !line.endsWith("  Botkins-1.4.2.AppImage")).join("\n");
  assert.deepEqual(checkFiles({ version: VERSION, files, sums: without }), ["SHA256SUMS does not list Botkins-1.4.2.AppImage, so no updater will install it."]);

  const changed = new Map(files).set("botkins-desktop-1.4.2.tar.gz", sha("other bytes"));
  assert.deepEqual(checkFiles({ version: VERSION, files: changed, sums }), ["botkins-desktop-1.4.2.tar.gz does not match its checksum in SHA256SUMS."]);

  const stale = sums + sha("old") + "  botkins-desktop-1.4.1.tar.gz\n";
  assert.deepEqual(checkFiles({ version: VERSION, files, sums: stale }), ["SHA256SUMS lists botkins-desktop-1.4.1.tar.gz, which is not a file of 1.4.2."]);

  assert.deepEqual(parseSums("not a checksum line\n" + sums).problems, ["SHA256SUMS has a line that is not a checksum and a name: not a checksum line"]);
  assert.deepEqual(parseSums(sums + sums).problems.length, 8);

  const unknown = new Map(files).set("Botkins-1.4.2.AppImage", undefined);
  assert.match(checkFiles({ version: VERSION, files: unknown, sums })[0], /The checksum of Botkins-1\.4\.2\.AppImage is not known here/);
});

test("the Mac manifest and the installer are for this release", () => {
  const { bytes } = whole();
  assert.deepEqual(checkMacManifest(bytes.get("latest-mac.yml"), VERSION), []);
  assert.equal(checkMacManifest(bytes.get("latest-mac.yml"), "1.4.3").length, 2);
  // 1.4.20 is not 1.4.2.
  assert.equal(checkMacManifest("version: 1.4.20\npath: Botkins-1.4.20-arm64-mac.zip\n", VERSION).length, 2);
  assert.deepEqual(checkInstaller(bytes.get("install.sh")), []);
  assert.deepEqual(checkInstaller('FINGERPRINT="' + "A".repeat(40) + '"\n'), ["install.sh trusts the key " + "A".repeat(40) + ", not the Botkins release key."]);
  assert.deepEqual(checkInstaller("echo hello\n"), ["install.sh trusts no key, not the Botkins release key."]);
});

test("the signature must be good, and the release key's", { skip: !hasGpg && "GnuPG is not installed" }, (t) => {
  const key = testKey(t);
  const dir = mkdtempSync(join(tmpdir(), "bk-sig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { sums: join(dir, "SHA256SUMS"), signature: join(dir, "SHA256SUMS.asc"), key: join(dir, "botkins-release.asc") };
  writeFileSync(paths.sums, whole().sums);
  key.sign(paths.sums);
  key.exportTo(paths.key);
  assert.deepEqual(checkSignature(paths, key.fingerprint), []);
  // A good signature from another key is not enough: the fingerprint is fixed here, not taken from the release.
  assert.deepEqual(checkSignature(paths), ["SHA256SUMS is signed by " + key.fingerprint + ", not the Botkins release key (" + FINGERPRINT + ")."]);
  writeFileSync(paths.sums, whole().sums + "\n");
  assert.deepEqual(checkSignature(paths, key.fingerprint), ["SHA256SUMS has no good signature from the key in botkins-release.asc."]);
  writeFileSync(paths.key, "not a key");
  assert.equal(checkSignature(paths, key.fingerprint).length, 1);
});

test("a folder of files is hashed and checked as a whole", { skip: !hasGpg && "GnuPG is not installed" }, async (t) => {
  const key = testKey(t);
  const [mac, linux] = [mkdtempSync(join(tmpdir(), "bk-mac-")), mkdtempSync(join(tmpdir(), "bk-linux-"))];
  t.after(() => [mac, linux].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const { bytes } = whole();
  // As the package scripts leave them: the Mac and Windows files in one folder, the rest in another.
  for (const [name, text] of bytes) writeFileSync(join(/mac|win|latest/.test(name) && !name.includes("terminal") ? mac : linux, name), text);
  key.sign(join(linux, "SHA256SUMS"));
  key.exportTo(join(linux, "botkins-release.asc"));
  const found = await readFolders([mac, linux]);
  assert.equal(found.files.size, 16);
  assert.deepEqual(checkRelease({ version: VERSION, ...found, fingerprint: key.fingerprint }), []);

  writeFileSync(join(linux, "botkins-terminal-1.4.2-macos-arm64.tar.gz"), "changed after signing");
  assert.deepEqual(checkRelease({ version: VERSION, ...(await readFolders([mac, linux])), fingerprint: key.fingerprint }), ["botkins-terminal-1.4.2-macos-arm64.tar.gz does not match its checksum in SHA256SUMS."]);
});

test("a draft on GitHub is found by its tag, with GitHub's own checksums", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { bytes, files } = whole();
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "api") {
      return JSON.stringify([
        { tag_name: "v1.4.1", draft: false, prerelease: false, assets: [] },
        { tag_name: "v1.4.2", draft: true, prerelease: false, assets: [...files].map(([name, hex]) => ({ name, digest: name === "Botkins-1.4.2-win.zip" ? null : "sha256:" + hex })) },
      ]);
    }
    for (const name of args.filter((_, index) => args[index - 1] === "--pattern")) writeFileSync(join(dir, name), bytes.get(name));
    return "";
  };
  const found = readGitHub(VERSION, dir, gh);
  assert.equal(found.where, "a draft on GitHub");
  assert.equal(found.files.get("Botkins-1.4.2.AppImage"), files.get("Botkins-1.4.2.AppImage"));
  assert.equal(found.files.get("Botkins-1.4.2-win.zip"), undefined);
  // Only the small files are downloaded.
  assert.deepEqual(calls[1].filter((_, index) => calls[1][index - 1] === "--pattern"), ["SHA256SUMS", "SHA256SUMS.asc", "botkins-release.asc", "latest-mac.yml", "install.sh"]);
  assert.deepEqual(checkFiles({ version: VERSION, files: found.files, sums: bytes.get("SHA256SUMS") }), []);
  assert.throws(() => readGitHub("9.9.9", dir, gh), /GitHub has no release v9\.9\.9/);
});
