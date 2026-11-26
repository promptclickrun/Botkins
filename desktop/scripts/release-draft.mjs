// Run from a clean, tagged release checkout on the Mac signing host.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repo = "promptclickrun/Botkins";
const repoArgs = ["--repo", repo];
const root = fileURLToPath(new URL("..", import.meta.url));
function run(tool, args, capture = false) {
  return execFileSync(tool, args, { cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
}

function existingDraft(tag, run) {
  const list = JSON.parse(run("gh", ["release", "list", ...repoArgs, "--limit", "100", "--json", "tagName,isDraft"], true));
  const existing = list.find(release => release.tagName === tag);
  if (existing && !existing.isDraft) throw Error(tag + " is already published.");
  return existing;
}

export function uploadDraft({ version, names, local, notes, run }) {
  const tag = "v" + version;
  for (const name of names) {
    if (!local.paths.has(name) || !local.files.has(name)) throw Error("Missing release file " + name);
  }
  const existing = existingDraft(tag, run);
  if (!existing) {
    run("gh", ["release", "create", tag, ...repoArgs, "--verify-tag", "--draft", "--title", "Botkins " + version,
      ...(notes ? ["--notes-file", notes] : ["--generate-notes"])]);
  }
  function remaining() {
    const draft = JSON.parse(run("gh", ["release", "view", tag, ...repoArgs, "--json", "isDraft,assets"], true));
    if (!draft.isDraft) throw Error(tag + " is already published.");
    const pending = new Set(names);
    for (const asset of draft.assets) {
      if (!pending.delete(asset.name) || asset.state !== "uploaded" || asset.digest !== "sha256:" + local.files.get(asset.name)) {
        throw Error("Draft asset does not match the release build: " + asset.name);
      }
    }
    return [...pending];
  }
  const missing = remaining();
  if (missing.length) run("gh", ["release", "upload", tag, ...repoArgs, ...missing.map(name => local.paths.get(name))]);
  if (remaining().length) throw Error("The draft upload is incomplete.");
  run(process.execPath, ["scripts/check-release.mjs", version]);
}

function verifyDesktopSignatures(files, version) {
  const temp = mkdtempSync(join(tmpdir(), "botkins-verify-desktop-"));
  try {
    run("ditto", ["-x", "-k", files.get("Botkins-" + version + "-arm64-mac.zip"), temp]);
    const app = join(temp, "Botkins.app");
    run("codesign", ["--verify", "--deep", "--strict", app]);
    run("spctl", ["--assess", "--type", "execute", app]);
    run("xcrun", ["stapler", "validate", app]);
    const cuaApp = join(app, "Contents", "Resources", "cua-driver", "CuaDriver.app");
    if (!existsSync(join(cuaApp, "Contents", "MacOS", "cua-driver"))) {
      throw Error("Missing bundled cua-driver inside Botkins.app.");
    }
    if (existsSync(join(cuaApp, "Contents", "embedded.provisionprofile"))) {
      throw Error("Unexpected upstream embedded.provisionprofile inside bundled CuaDriver.app.");
    }
    run("codesign", ["--verify", "--deep", "--strict", cuaApp]);
    run("unzip", ["-q", files.get("Botkins-" + version + "-win.zip"), "Botkins.exe", "resources/cua-driver/cua-driver.exe", "-d", temp]);
    if (!existsSync(join(temp, "resources", "cua-driver", "cua-driver.exe"))) {
      throw Error("Missing bundled cua-driver.exe in Windows zip.");
    }
    const ca = process.env.BOTKINS_WINDOWS_CA_FILE;
    run("osslsigncode", ["verify", ...(ca ? ["-CAfile", ca, "-TSA-CAfile", ca] : []), "-in", join(temp, "Botkins.exe")]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { resume: { type: "boolean" }, notes: { type: "string" } } });
  const notes = values.notes && resolve(values.notes);
  if (notes) readFileSync(notes);
  if (!existsSync(join(root, "scripts/check-release.mjs"))) throw Error("This checkout needs the shared desktop and terminal release gate.");
  const { expectedFiles, readFolders, checkRelease } = await import("./check-release.mjs");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const names = expectedFiles(version).map(file => file.name);
  const tag = "refs/tags/v" + version;
  const commit = run("git", ["rev-parse", "HEAD"], true).trim();
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], true).trim()) throw Error("Build the release from a clean checkout.");
  const refs = run("git", ["ls-remote", "--exit-code", "https://github.com/" + repo + ".git", tag, tag + "^{}"], true);
  const tags = new Map(refs.trim().split("\n").map(line => line.split("\t").reverse()));
  if ((tags.get(tag + "^{}") ?? tags.get(tag)) !== commit) throw Error("Check out the commit tagged v" + version + " on GitHub.");
  if (process.platform !== "darwin" || process.env.BOTKINS_SIGN === "off") throw Error("Use the Mac release host with Windows signing enabled.");

  if (existingDraft("v" + version, run) && !values.resume) throw Error("A draft already exists. Resume its original build.");
  const out = join(root, "release", version);
  const receipt = join(root, "release", ".built-" + version);
  if (values.resume) {
    if (!existsSync(receipt) || readFileSync(receipt, "utf8") !== commit) throw Error("Finish packaging this tagged commit before resuming its upload.");
  } else {
    if (existsSync(out)) throw Error("This version already has build output. Resume its completed build or use a fresh checkout.");
    run("npm", ["run", "package", "--", "--mac", "zip", "--arm64"]);
    run("npm", ["run", "package:windows"]);
    run("npm", ["run", "package:linux"]);
    writeFileSync(receipt, commit);
  }
  const local = await readFolders([out, join(out, "windows"), join(out, "linux")]);
  const problems = checkRelease({ version, ...local });
  if (problems.length) throw Error(problems.join("\n"));
  verifyDesktopSignatures(local.paths, version);
  uploadDraft({ version, names, local, notes, run });
  console.log("Verified GitHub draft for Botkins " + version + ".");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
