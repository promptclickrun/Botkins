// Pinned MIT-licensed cua-driver binary manifest, checksum-verified downloader, and macOS
// re-signing helper. Never invokes upstream curl/shell installers: only pinned GitHub Release
// archives verified against hard-coded SHA-256 checksums.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CUA_DRIVER_ASSETS,
  CUA_DRIVER_LICENSE,
  CUA_DRIVER_REPO,
  CUA_DRIVER_TAG,
  CUA_DRIVER_VERSION,
  assetFor,
  normalizeTarget,
  resolveBundledCuaDriver,
} from "../desktop/cua-driver-bundle.mjs";

export {
  CUA_DRIVER_ASSETS,
  CUA_DRIVER_LICENSE,
  CUA_DRIVER_REPO,
  CUA_DRIVER_TAG,
  CUA_DRIVER_VERSION,
  assetFor,
  normalizeTarget,
  resolveBundledCuaDriver,
};

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function defaultCacheDir(env = process.env) {
  if (env.BOTKINS_CUA_DRIVER_CACHE) return env.BOTKINS_CUA_DRIVER_CACHE;
  return join(homedir(), ".cache", "botkins", "cua-driver", CUA_DRIVER_VERSION);
}

/**
 * Downloads the pinned archive into cacheDir (reusing cached copy if its SHA-256 matches)
 * and throws if the downloaded bytes do not match the pinned checksum.
 */
export async function ensureArchive(platform, arch, { cacheDir = defaultCacheDir(), fetchImpl = fetch, log = () => {} } = {}) {
  const asset = assetFor(platform, arch);
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, asset.file);
  if (existsSync(archivePath)) {
    const existing = sha256File(archivePath);
    if (existing === asset.sha256) return { asset, archivePath };
    rmSync(archivePath, { force: true });
  }
  log(`Downloading ${asset.file} (${CUA_DRIVER_TAG})...`);
  const response = await fetchImpl(asset.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Failed to download ${asset.url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`SHA-256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}`);
  }
  const tmp = archivePath + ".part-" + process.pid;
  writeFileSync(tmp, buffer);
  copyFileSync(tmp, archivePath);
  rmSync(tmp, { force: true });
  return { asset, archivePath };
}

/**
 * Extracts the verified archive into `destDir`, strips upstream provisioning profile on macOS
 * (so Botkins' own Developer ID signing + notarization signs cleanly under Botkins' Team ID),
 * and sets executable bits on Unix binaries.
 */
export function extractArchive(archivePath, asset, destDir, { run = execFileSync } = {}) {
  const work = mkdtempSync(join(tmpdir(), "botkins-cua-extract-"));
  try {
    if (asset.format === "tar.gz") {
      run("tar", ["-xzf", archivePath, "-C", work], { stdio: "pipe" });
    } else if (asset.format === "zip") {
      if (process.platform === "win32") {
        run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${work.replace(/'/g, "''")}' -Force`], { stdio: "pipe" });
      } else {
        run("unzip", ["-q", "-o", archivePath, "-d", work], { stdio: "pipe" });
      }
    } else {
      throw new Error(`Unknown archive format: ${asset.format}`);
    }

    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });

    // Upstream release archives wrap their files in a single top-level directory
    // (e.g. `cua-driver-rs-0.63.2-darwin-universal/`). Unwrap it when present.
    let root = work;
    const expectedRel = asset.appBundleRelPath || asset.binaryRelPath;
    if (!existsSync(join(root, expectedRel))) {
      const entries = readdirSync(work).filter((name) => !name.startsWith(".") && name !== "__MACOSX");
      if (entries.length === 1 && statSync(join(work, entries[0])).isDirectory()) {
        root = join(work, entries[0]);
      }
    }

    if (asset.appBundleRelPath) {
      const appSrc = join(root, asset.appBundleRelPath);
      if (!existsSync(appSrc)) throw new Error(`Expected ${asset.appBundleRelPath} in ${basename(archivePath)}`);
      const appDest = join(destDir, asset.appBundleRelPath);
      cpSync(appSrc, appDest, { recursive: true });
      // Upstream ships an embedded provisioning profile tied to trycua's Team ID (no restricted
      // entitlements). Strip it before Botkins re-signs with Botkins' Developer ID + hardened runtime.
      rmSync(join(appDest, "Contents", "embedded.provisionprofile"), { force: true });
      for (const binName of ["cua-driver", "cua-cursor-theme"]) {
        const binPath = join(appDest, "Contents", "MacOS", binName);
        if (existsSync(binPath)) chmodSync(binPath, 0o755);
      }
    } else {
      const binSrc = join(root, asset.binaryRelPath);
      if (!existsSync(binSrc)) throw new Error(`Expected ${asset.binaryRelPath} in ${basename(archivePath)}`);
      const binDest = join(destDir, asset.binaryRelPath);
      copyFileSync(binSrc, binDest);
      if (!asset.binaryRelPath.endsWith(".exe")) chmodSync(binDest, 0o755);
    }

    for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      const noticeSrc = join(root, notice);
      if (existsSync(noticeSrc)) copyFileSync(noticeSrc, join(destDir, notice));
    }

    const binaryPath = join(destDir, asset.binaryRelPath);
    if (!existsSync(binaryPath)) throw new Error(`Missing staged binary: ${binaryPath}`);
    writeFileSync(
      join(destDir, "manifest.json"),
      JSON.stringify({ version: CUA_DRIVER_VERSION, tag: CUA_DRIVER_TAG, license: CUA_DRIVER_LICENSE, target: asset.key, sha256: asset.sha256, binary: asset.binaryRelPath }, null, 2) + "\n",
    );
    return { binaryPath, destDir };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Re-signs a staged macOS CuaDriver.app bundle with Botkins' Developer ID identity and hardened
 * runtime (inside-out: helper executables first, then the .app bundle).
 */
export function signMacCuaDriver(destDir, { identity, entitlements, run = execFileSync } = {}) {
  const appDir = join(destDir, "CuaDriver.app");
  if (!existsSync(appDir)) throw new Error(`Missing CuaDriver.app in ${destDir}`);
  rmSync(join(appDir, "Contents", "embedded.provisionprofile"), { force: true });
  const signId = identity || process.env.BOTKINS_MAC_SIGN_IDENTITY || process.env.CSC_NAME;
  if (!signId) return { signed: false, appDir };
  const baseArgs = ["--force", "--timestamp", "--options", "runtime", "--sign", signId];
  const entArgs = entitlements ? ["--entitlements", entitlements] : [];
  for (const binName of ["cua-cursor-theme", "cua-driver"]) {
    const binPath = join(appDir, "Contents", "MacOS", binName);
    if (existsSync(binPath)) run("codesign", [...baseArgs, ...entArgs, binPath], { stdio: "inherit" });
  }
  run("codesign", [...baseArgs, ...entArgs, appDir], { stdio: "inherit" });
  run("codesign", ["--verify", "--deep", "--strict", appDir], { stdio: "inherit" });
  return { signed: true, appDir };
}

export async function stageCuaDriver({ platform, arch, destDir, cacheDir, fetchImpl, log, signIdentity, entitlements, run } = {}) {
  const { asset, archivePath } = await ensureArchive(platform, arch, { cacheDir, fetchImpl, log });
  const staged = extractArchive(archivePath, asset, destDir, { run });
  if (asset.key.startsWith("darwin-") && signIdentity) {
    signMacCuaDriver(destDir, { identity: signIdentity, entitlements, run });
  }
  return { ...staged, asset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const destDir = process.argv[4] || join(dirname(fileURLToPath(new URL("../package.json", import.meta.url))), "vendor", "cua-driver");
  const signIdentity = process.env.BOTKINS_MAC_SIGN_IDENTITY || process.env.CSC_NAME || undefined;
  stageCuaDriver({ platform, arch, destDir, signIdentity, log: console.log })
    .then(({ binaryPath }) => console.log("Staged cua-driver:", binaryPath))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
