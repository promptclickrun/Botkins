// Maintainer-only. Cross-check Proton's release checksums, then regenerate both copies of the pins.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PROTON_DOWNLOADS, unzipPassCli } from "../desktop/link/proton-install.mjs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/update-pass-cli.mjs <version>");
}

const matrix = {
  "darwin-arm64": ["macos", "aarch64"],
  "darwin-x64": ["macos", "x86_64"],
  "linux-arm64": ["linux", "aarch64"],
  "linux-x64": ["linux", "x86_64"],
  "win32-x64": ["windows", "x86_64"],
};
const releases = "https://github.com/protonpass/pass-cli/releases/download/";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

const [manifest, release] = await Promise.all([
  download(`${PROTON_DOWNLOADS}/versions.json`).then((response) => response.json()).then((data) => data.passCliVersions),
  download(`https://api.github.com/repos/protonpass/pass-cli/releases/tags/${version}`).then((response) => response.json()),
]);
if (release.tag_name !== version || release.draft || release.prerelease) throw new Error("Proton hasn't published this stable release.");
const pins = await Promise.all(Object.entries(matrix).map(async ([platform, [os, arch]]) => {
  const windows = os === "windows";
  const asset = `pass-cli-${os}-${arch}${windows ? ".zip" : ""}`;
  const url = `${PROTON_DOWNLOADS}/${version}/${asset}`;
  const published = release.assets.find((entry) => entry.name === asset);
  const checksum = (await (await download(`${releases}${version}/${asset}.sha256`)).text()).trim().split(/\s+/);
  const [hash, file] = checksum;
  if (!published || !Number.isSafeInteger(published.size) || published.size < 1 || !/^[0-9a-f]{64}$/.test(hash) ||
      (file && file.replace(/^\*/, "") !== asset) || (published.digest && published.digest !== "sha256:" + hash)) {
    throw new Error(`The published GitHub checksums for ${asset} don't agree.`);
  }
  if (manifest?.version === version) {
    const listed = manifest.urls?.[os]?.[arch];
    if (listed?.url !== url || listed?.hash !== hash) throw new Error(`The Proton manifest disagrees with GitHub for ${asset}.`);
  }
  let files;
  if (windows || manifest?.version !== version) {
    const bytes = Buffer.from(await (await download(url)).arrayBuffer());
    if (bytes.length !== published.size || sha256(bytes) !== hash) throw new Error(`The Proton download doesn't match the GitHub checksum for ${asset}.`);
    if (windows) files = [...unzipPassCli(bytes)].sort(([a], [b]) => b.localeCompare(a, "en"))
      .map(([name, content]) => `${JSON.stringify(name)}: ${JSON.stringify(sha256(content))}`).join(", ");
  }
  return `  ${JSON.stringify(platform)}: { asset: ${JSON.stringify(asset)}, sizeBytes: ${published.size}, sha256: ${JSON.stringify(hash)}${files ? `, files: { ${files} }` : ""} },`;
}));

const source = `// Updated by scripts/update-pass-cli.mjs, never by the running app.\n`
  + `export const VERSION = ${JSON.stringify(version)};\n\nexport const PINS = {\n${pins.join("\n")}\n};\n`;
await Promise.all([
  writeFile(new URL("../desktop/link/proton-pins.mjs", import.meta.url), source),
  writeFile(new URL("../../mobile/link-host/proton-pins.mjs", import.meta.url), source),
]);
console.log(`Updated the Proton Pass CLI pins to ${version}.`);
