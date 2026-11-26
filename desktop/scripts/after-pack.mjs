// electron-builder afterPack hook: stages the checksum-verified pinned MIT cua-driver binary
// into the packaged app's resources/cua-driver folder before signing & notarization.
import { join } from "node:path";
import { stageCuaDriver } from "./cua-driver.mjs";

const ARCH_NAMES = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

function archName(arch) {
  if (typeof arch === "string") return arch;
  return ARCH_NAMES[arch] ?? process.arch;
}

function resourcesDirFor(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === "darwin") {
    const product = packager?.appInfo?.productFilename ?? "Botkins";
    return join(appOutDir, `${product}.app`, "Contents", "Resources");
  }
  return join(appOutDir, "resources");
}

export default async function afterPack(context) {
  if (process.env.BOTKINS_SKIP_CUA_DRIVER_DOWNLOAD === "1") {
    console.log("Skipping cua-driver bundling (BOTKINS_SKIP_CUA_DRIVER_DOWNLOAD=1).");
    return;
  }
  const platform = context.electronPlatformName;
  const arch = archName(context.arch);
  const targetArch = platform === "darwin" && arch === "universal" ? "arm64" : arch;
  const destDir = join(resourcesDirFor(context), "cua-driver");
  await stageCuaDriver({
    platform,
    arch: targetArch,
    destDir,
    log: console.log,
  });
}
