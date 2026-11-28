// Pinned MIT-licensed cua-driver manifest and runtime binary resolver.
// Imported both by runtime code (desktop/computer-use.mjs) and build scripts (scripts/cua-driver.mjs).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CUA_DRIVER_VERSION = "0.63.2";
export const CUA_DRIVER_TAG = "cua-driver-rs-v" + CUA_DRIVER_VERSION;
export const CUA_DRIVER_LICENSE = "MIT";
export const CUA_DRIVER_REPO = "trycua/cua";
const BASE_URL = `https://github.com/${CUA_DRIVER_REPO}/releases/download/${CUA_DRIVER_TAG}`;

export const CUA_DRIVER_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
    url: `${BASE_URL}/cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
    sha256: "2b73a685f657d8110e28514b71c8db23beffa4a64e8e9724962c955d54a032d7",
    format: "tar.gz",
    binaryRelPath: "CuaDriver.app/Contents/MacOS/cua-driver",
    appBundleRelPath: "CuaDriver.app",
  }),
  "darwin-x64": Object.freeze({
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
    url: `${BASE_URL}/cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
    sha256: "2b73a685f657d8110e28514b71c8db23beffa4a64e8e9724962c955d54a032d7",
    format: "tar.gz",
    binaryRelPath: "CuaDriver.app/Contents/MacOS/cua-driver",
    appBundleRelPath: "CuaDriver.app",
  }),
  "linux-x64": Object.freeze({
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64.tar.gz`,
    url: `${BASE_URL}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64.tar.gz`,
    sha256: "302c592d212668ff77881a7cabff447c4565bfbffd4e52bcf0bde2e30779945e",
    format: "tar.gz",
    binaryRelPath: "cua-driver",
  }),
  "linux-arm64": Object.freeze({
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64.tar.gz`,
    url: `${BASE_URL}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64.tar.gz`,
    sha256: "77815b2d1bc40954158e9e0f2f3035096445cee8214345f7d68b85ad512853b2",
    format: "tar.gz",
    binaryRelPath: "cua-driver",
  }),
  "win32-x64": Object.freeze({
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64.zip`,
    url: `${BASE_URL}/cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64.zip`,
    sha256: "72ec4f14e3e5f25b8457f91acf1cdf31fff00aba89cebad4cc76e94e63eaf7c9",
    format: "zip",
    binaryRelPath: "cua-driver.exe",
  }),
  "win32-arm64": Object.freeze({
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64.zip`,
    url: `${BASE_URL}/cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64.zip`,
    sha256: "4fad443abc657a631bfd40489d32c360566661b7ad6b345898ea6880e0a11123",
    format: "zip",
    binaryRelPath: "cua-driver.exe",
  }),
});

export function normalizeTarget(platform, arch) {
  const os = platform === "macos" || platform === "mac" ? "darwin" : platform === "win" || platform === "windows" ? "win32" : platform;
  const cpu = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  return `${os}-${cpu}`;
}

export function assetFor(platform, arch) {
  const key = normalizeTarget(platform, arch);
  const asset = CUA_DRIVER_ASSETS[key];
  if (!asset) throw new Error(`Unsupported cua-driver target: ${key}`);
  return { key, ...asset };
}

/**
 * Resolves the bundled cua-driver binary at runtime across packaged Electron apps, terminal
 * host installations, local development checkouts, and explicit test/dev overrides.
 */
export function resolveBundledCuaDriver({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  resourcesPath = process.resourcesPath,
  packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
} = {}) {
  if (env.BOTKINS_CUA_DRIVER_BIN) {
    return { path: env.BOTKINS_CUA_DRIVER_BIN, source: "env" };
  }
  let asset;
  try {
    asset = assetFor(platform, arch);
  } catch {
    return null;
  }
  const candidates = [];
  if (resourcesPath) {
    candidates.push({ path: join(resourcesPath, "cua-driver", asset.binaryRelPath), source: "electron-resources" });
  }
  if (packageRoot) {
    candidates.push({ path: join(packageRoot, "vendor", "cua-driver", asset.binaryRelPath), source: "vendor" });
    candidates.push({ path: join(packageRoot, "build", "cua-driver", asset.key, asset.binaryRelPath), source: "build" });
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}
