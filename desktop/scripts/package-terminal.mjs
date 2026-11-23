// Builds the terminal host's release tarballs: the `botkins` command and the workspace it runs,
// with their dependencies for one system and no Electron.
//
//   botkins-terminal-<version>-linux-x64.tar.gz     botkins-terminal-<version>-macos-x64.tar.gz
//   botkins-terminal-<version>-linux-arm64.tar.gz   botkins-terminal-<version>-macos-arm64.tar.gz
//
// Each holds one folder of the same name: bin/botkins (the launcher, install/botkins), cli/,
// desktop/ and node_modules/. Node.js itself is not inside: the installer uses the computer's
// Node.js 24, or downloads one for Botkins alone.
//
//   node scripts/package-terminal.mjs [--out <dir>] [--only linux-arm64,macos-arm64] [--sums]
//
// `--sums` also writes SHA256SUMS for what it built, unsigned, for trying the installer by hand.
// A release is signed by scripts/package-linux.mjs, which calls build() below before it writes
// and signs the one SHA256SUMS of the release, so the terminal host's tarballs are in it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
export const TARGETS = ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"];
/** What the service never loads: the desktop app's updater, and the copies of Claude Code the SDK brings (the host uses the one that is installed). */
const LEFT_OUT = ["electron-updater", "builder-util-runtime"];

/** GNU tar and BSD tar name the owner of what they pack differently; everything is packed as root's. */
function tarOwner() {
  const gnu = /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
  return gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--numeric-owner"];
}

/**
 * Builds the tarballs into `out`.
 * @returns the names of the files it wrote.
 */
export function build({ out, only = TARGETS, npm = process.env.npm_execpath, log = console.log } = {}) {
  mkdirSync(out, { recursive: true });
  const built = [];
  for (const target of only) {
    if (!TARGETS.includes(target)) throw new Error("Unknown target " + target + ". The targets are " + TARGETS.join(", ") + ".");
    const [system, arch] = target.split("-");
    const name = "botkins-terminal-" + pkg.version + "-" + system + "-" + arch;
    const work = mkdtempSync(join(tmpdir(), "botkins-terminal-"));
    const stage = join(work, name);
    try {
      mkdirSync(join(stage, "bin"), { recursive: true });
      for (const item of ["cli", "desktop"]) cpSync(join(root, item), join(stage, item), { recursive: true });
      // A gadget's Botkin is drawn from the design kit beside the link (desktop/link/botkin-svg.mjs).
      for (const item of ["customize.js", "motion", "avatars"]) cpSync(join(root, "design", "botkins-kit", item), join(stage, "design", "botkins-kit", item), { recursive: true });
      // The command line's own package: what it is, how it starts, and what it needs.
      const { name: packageName, version, license, type, bin, dependencies, repository, description } = pkg;
      writeFileSync(join(stage, "package.json"), JSON.stringify({ name: packageName.replace(/-desktop$/, "-terminal"), version, description, license, private: true, type, bin, dependencies, repository }, null, 2) + "\n");
      copyFileSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
      copyFileSync(join(root, "install", "botkins"), join(stage, "bin", "botkins"));
      chmodSync(join(stage, "bin", "botkins"), 0o755);
      // The dependencies for the target system, whatever system this runs on. No package's own script runs.
      // Linux builds are for glibc (Debian, Ubuntu, Fedora and their kin), which is what the Copilot
      // runtime, the one large native part, is taken for. It comes once, not once for each C library.
      const npmArgs = ["ci", "--omit=dev", "--os=" + (system === "macos" ? "darwin" : "linux"), "--cpu=" + arch, ...(system === "linux" ? ["--libc=glibc"] : []), "--ignore-scripts", "--no-audit", "--no-fund"];
      if (npm) execFileSync(process.execPath, [npm, ...npmArgs], { cwd: stage, stdio: "inherit" });
      else execFileSync("npm", npmArgs, { cwd: stage, stdio: "inherit" });
      const modules = join(stage, "node_modules");
      for (const dir of LEFT_OUT) rmSync(join(modules, dir), { recursive: true, force: true });
      for (const dir of existsSync(join(modules, "@anthropic-ai")) ? readdirSync(join(modules, "@anthropic-ai")) : []) if (dir.startsWith("claude-agent-sdk-")) rmSync(join(modules, "@anthropic-ai", dir), { recursive: true, force: true });
      for (const scope of ["@microsoft", "@koromix"]) for (const dir of existsSync(join(modules, scope)) ? readdirSync(join(modules, scope)) : []) if (/-linuxmusl-|-musl-/.test(dir)) rmSync(join(modules, scope, dir), { recursive: true, force: true });
      rmSync(join(modules, ".package-lock.json"), { force: true });
      const file = name + ".tar.gz";
      execFileSync("tar", [...tarOwner(), "-czf", join(out, file), "-C", work, name], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
      built.push(file);
      log("Built " + file);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  // The installer goes out with the release, so one address gives the script and what it installs.
  copyFileSync(join(root, "install", "install.sh"), join(out, "install.sh"));
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" }, sums: { type: "boolean" } } });
  const out = values.out ?? join(root, "release", pkg.version, "terminal");
  const built = build({ out, ...(values.only && { only: values.only.split(",").map((target) => target.trim()) }) });
  if (values.sums) {
    writeFileSync(join(out, "SHA256SUMS"), built.map((file) => createHash("sha256").update(readFileSync(join(out, file))).digest("hex") + "  " + file).join("\n") + "\n");
    console.log("Wrote SHA256SUMS (unsigned: for trying the installer by hand, not for a release).");
  }
}
