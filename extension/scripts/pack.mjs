// Packages the built Chromium (Chrome + Edge) extension into release/botkins-browser-extension.zip.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distFiles = [join(root, "dist/background.js"), join(root, "dist/dom-driver.js")];
for (const file of distFiles) {
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. Run \`npm run build\` in extension/ first.`);
  }
}
const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const outZip = join(outDir, "botkins-browser-extension.zip");
rmSync(outZip, { force: true });

execFileSync("zip", ["-rq", outZip, "manifest.json", "dist", "icons", "popup", "options"], {
  cwd: root,
  stdio: "inherit",
});
console.log("Packaged " + outZip);
