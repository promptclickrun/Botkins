import { execFileSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "botkins-win-"));
try {
  for (const item of ["dist", "desktop", "assets"])
    cpSync(join(root, item), join(stage, item), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.build.directories.output = join(
    root,
    pkg.build.directories.output,
    "windows",
  );
  pkg.build.npmRebuild = false;
  // Signs with Azure Artifact Signing (scripts/sign-windows.cjs). BOTKINS_SIGN=off builds unsigned.
  if (process.env.BOTKINS_SIGN !== "off") {
    if (!process.env.BOTKINS_SIGN_PUBLISHER) throw new Error("Set BOTKINS_SIGN_PUBLISHER to the publisher on the certificate.");
    pkg.build.win.signtoolOptions = {
      sign: join(root, "scripts/sign-windows.cjs"),
      signingHashAlgorithms: ["sha256"],
      publisherName: process.env.BOTKINS_SIGN_PUBLISHER,
    };
  } else {
    pkg.build.win.signExecutable = false;
  }
  writeFileSync(join(stage, "package.json"), JSON.stringify(pkg));
  copyFileSync(
    join(root, "package-lock.json"),
    join(stage, "package-lock.json"),
  );
  // Resolve platform-specific Copilot runtime packages for the target, including on a Mac build host.
  execFileSync(
    process.execPath,
    [
      process.env.npm_execpath,
      "ci",
      "--omit=dev",
      "--os=win32",
      "--cpu=x64",
      "--ignore-scripts",
      "--no-audit",
    ],
    { cwd: stage, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/electron-builder/cli.js"),
      "--projectDir",
      stage,
      "--win",
      "zip",
      "--x64",
      "--publish",
      "never",
    ],
    { cwd: root, stdio: "inherit" },
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
