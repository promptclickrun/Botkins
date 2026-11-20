// Builds the Linux AppImage and tarball for x64 and arm64, then writes SHA256SUMS with a detached
// GPG signature. Linux has no notarization; the signed checksums are how users verify a download.
// BOTKINS_GPG_KEY picks the key (default releases@botkins.app); its passphrase comes from
// BOTKINS_GPG_PASSPHRASE or, on a Mac, the Keychain item "Botkins Linux release GPG".
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildTerminal } from "./package-terminal.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, pkg.build.directories.output.replace("${version}", pkg.version), "linux");
const key = process.env.BOTKINS_GPG_KEY || "releases@botkins.app";

function passphrase() {
  if (process.env.BOTKINS_GPG_PASSPHRASE) return process.env.BOTKINS_GPG_PASSPHRASE;
  return execFileSync(
    "security",
    ["find-generic-password", "-a", "botkins-release", "-s", "Botkins Linux release GPG", "-w"],
    { encoding: "utf8" },
  ).trim();
}

for (const arch of ["x64", "arm64"]) {
  const stage = mkdtempSync(join(tmpdir(), `botkins-linux-${arch}-`));
  try {
    for (const item of ["dist", "desktop", "assets"])
      cpSync(join(root, item), join(stage, item), { recursive: true });
    const staged = structuredClone(pkg);
    staged.build.directories.output = out;
    staged.build.npmRebuild = false;
    staged.build.linux = {
      icon: "assets/icon-mac.png",
      category: "Utility",
      maintainer: "Botkins <releases@botkins.app>",
      ...staged.build.linux,
    };
    writeFileSync(join(stage, "package.json"), JSON.stringify(staged));
    copyFileSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
    // Resolve platform-specific Copilot runtime packages for the target, including on a Mac build host.
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, "ci", "--omit=dev", "--os=linux", `--cpu=${arch}`, "--ignore-scripts", "--no-audit"],
      { cwd: stage, stdio: "inherit" },
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/electron-builder/cli.js"),
        "--projectDir", stage,
        "--linux", "AppImage", "tar.gz",
        `--${arch}`,
        "--publish", "never",
      ],
      { cwd: root, stdio: "inherit" },
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// The terminal host's tarballs (scripts/package-terminal.mjs) go in the same folder, so the one
// signed SHA256SUMS of the release covers them and `botkins update` can check what it downloads.
buildTerminal({ out });

const files = readdirSync(out).filter((f) => /\.(AppImage|tar\.gz)$/.test(f)).sort();
const sums = files
  .map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`)
  .join("\n") + "\n";
writeFileSync(join(out, "SHA256SUMS"), sums);
rmSync(join(out, "SHA256SUMS.asc"), { force: true });
execFileSync(
  "gpg",
  ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--local-user", key, "--armor", "--detach-sign", "--output", join(out, "SHA256SUMS.asc"), join(out, "SHA256SUMS")],
  { input: passphrase(), stdio: ["pipe", "inherit", "inherit"] },
);
execFileSync("gpg", ["--yes", "--armor", "--output", join(out, "botkins-release.asc"), "--export", key], { stdio: "inherit" });
console.log(`Signed ${files.length} Linux packages in ${out}`);
