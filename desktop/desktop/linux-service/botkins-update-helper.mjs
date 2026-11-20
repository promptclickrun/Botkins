#!/usr/bin/env node
// Installed by the administrator in /usr/local/libexec; runs independently of the app service.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdtempSync,
  readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const repo = "https://github.com/promptclickrun/Botkins";
const fingerprint = "366DD24D230E9F6BAE3EDE0AEB0AB1B21A7BAA7E";
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fail = message => { throw new Error(message); };
function rootDirectory(path) {
  for (;;) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) fail("The updater needs a root-owned install directory and parents.");
    if (path === dirname(path)) return;
    path = dirname(path);
  }
}

function directoryName(version, arch) {
  if (!stable.test(version) || !["arm64","x64"].includes(arch)) fail("Unsupported release version or architecture.");
  return "botkins-desktop-" + version + (arch === "arm64" ? "-arm64" : "");
}

function newer(next, current) {
  const a = next.split(".").map(BigInt), b = current.split(".").map(BigInt);
  const different = a.findIndex((part, i) => part !== b[i]);
  return different >= 0 && a[different] > b[different];
}

export function performUpdate({ archive, installRoot, currentLink, service, version, arch = process.arch,
  execFile = execFileSync, systemctl = "systemctl", verifyOwnership = true, healthWindowMs = 60_000 }) {
  if (!isAbsolute(installRoot) || installRoot !== resolve(installRoot) || currentLink !== join(installRoot, "current") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9@_.-]*\.service$/.test(service)) fail("Invalid Botkins systemd install configuration.");
  if (verifyOwnership) rootDirectory(installRoot);
  const top = directoryName(version, arch);
  const target = join(installRoot, top);
  const prior = resolve(installRoot, readlinkSync(currentLink));
  const oldVersion = basename(prior).match(/^botkins-desktop-(\d+\.\d+\.\d+)(?:-arm64)?$/)?.[1];
  if (dirname(prior) !== installRoot || !oldVersion || !stable.test(oldVersion) || !lstatSync(prior).isDirectory()) fail("Invalid current Botkins version directory.");
  if (!newer(version, oldVersion)) fail("The release must be newer than the installed version.");
  if (existsSync(target)) fail("The requested version directory already exists.");
  const names = execFile("tar", ["-tzf", archive], {encoding:"utf8", maxBuffer:32 * 1024 * 1024}).trimEnd().split("\n");
  if (names.some(path => path.split("/")[0] !== top || path.split("/").includes(".."))) fail("Unexpected paths in the signed release.");
  const temp = mkdtempSync(join(installRoot, ".update-"));
  const stage = join(temp, top);
  const restart = () => execFile(systemctl, ["restart", service], {stdio:"ignore", timeout:60_000});
  let installed = false, switched = false;
  try {
    execFile("tar", ["--no-same-owner","--no-same-permissions","-xzf",archive,"-C",temp], {stdio:"ignore"});
    const sandbox = join(stage,"chrome-sandbox");
    if (!lstatSync(stage).isDirectory() || !lstatSync(sandbox).isFile() || !lstatSync(join(stage,"botkins-desktop")).isFile()) fail("Missing packaged Linux executable or sandbox.");
    if (verifyOwnership) chownSync(sandbox, 0, 0);
    chmodSync(sandbox, verifyOwnership ? 0o4755 : 0o755);
    symlinkSync(prior, join(temp,"previous"));
    symlinkSync(target, join(temp,"next"));
    renameSync(stage, target);
    installed = true;
    renameSync(join(temp,"next"), currentLink);
    switched = true;
    restart();
    const until = Date.now() + healthWindowMs;
    let initial;
    for (;;) {
      execFile(systemctl, ["is-active","--quiet",service], {stdio:"ignore", timeout:15_000});
      const invocation = String(execFile(systemctl, ["show","-p","InvocationID","--value",service], {encoding:"utf8", timeout:15_000})).trim();
      if (verifyOwnership && !/^[0-9a-f]{32}$/i.test(invocation)) fail("The new service has no running invocation.");
      if (initial !== undefined && invocation !== initial) fail("The new Botkins service restarted during its health check.");
      initial = invocation;
      if (Date.now() >= until) break;
      execFile("sleep", ["1"]);
    }
  } catch (error) {
    if (switched) {
      renameSync(join(temp,"previous"), currentLink);
      execFile(systemctl, ["reset-failed", service], {stdio:"ignore"});
      restart();
    }
    if (installed) rmSync(target, {force:true, recursive:true});
    throw error;
  } finally {
    rmSync(temp, {force:true, recursive:true});
  }
}

export async function verifyRelease(dir, name, keyring) {
  const sums = join(dir, "SHA256SUMS");
  const status = execFileSync("gpgv", ["--homedir",dir,"--status-fd=1","--keyring",keyring,sums+".asc",sums], {encoding:"utf8"});
  if (!status.split("\n").some(line => line.split(" ").slice(0,3).join(" ") === "[GNUPG:] VALIDSIG " + fingerprint)) fail("Unknown Botkins release signing key.");
  const matches = readFileSync(sums,"utf8").split(/\r?\n/).map(line => /^([a-f0-9]{64})  (.+)$/.exec(line)).filter(m => m && m[2] === name);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(join(dir,name))) hash.update(bytes);
  if (matches.length !== 1 || matches[0][1] !== hash.digest("hex")) fail("The archive does not match its signed checksum.");
}

async function main() {
  const configPath = "/etc/botkins/update.json";
  rootDirectory(dirname(configPath));
  for (const file of [configPath, "/etc/botkins/release.gpg"]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) fail("Unsafe Botkins updater configuration.");
  }
  const config = JSON.parse(readFileSync(configPath,"utf8"));
  const headers = { "User-Agent":"Botkins-systemd-updater" };
  // The release page, not GitHub's API: the API answers an address that is not signed in only 60
  // times an hour, counted for everyone behind that address, so a server can be refused through
  // no fault of its own. /releases/latest leads to the latest release that is neither a draft
  // nor a pre-release. What is installed is decided below, by the signature on its checksums.
  const page = await fetch(repo + "/releases/latest", {headers, redirect:"manual", signal:AbortSignal.timeout(30_000)});
  const version = /\/releases\/tag\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(page.headers.get("location") ?? "")?.[1];
  if (!version) fail("Cannot read the latest public Botkins release. Try again later.");
  const name = directoryName(version,process.arch) + ".tar.gz";
  const dir = mkdtempSync(join(tmpdir(), "botkins-download-"));
  try {
    for (const file of [name,"SHA256SUMS","SHA256SUMS.asc"]) {
      const url = repo + "/releases/download/v" + version + "/" + file;
      const asset = await fetch(url,{headers, signal:AbortSignal.timeout(300_000)});
      if (asset.status === 404) fail("Missing public release asset " + file);
      if (!asset.ok || !asset.body) fail("Failed to download " + file);
      await pipeline(asset.body,createWriteStream(join(dir,file),{flags:"wx",mode:0o600}));
    }
    await verifyRelease(dir, name, "/etc/botkins/release.gpg");
    const {installRoot,currentLink,service} = config;
    performUpdate({archive:join(dir,name), installRoot,currentLink,service, version});
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
