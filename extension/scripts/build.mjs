// Bundles the MV3 service worker (src/background.mjs) into dist/background.js using esbuild.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");

// Reuse esbuild already installed in profiles/ or desktop/ so extension/ needs no extra install step.
function loadEsbuild() {
  for (const candidate of [
    join(root, "node_modules/esbuild"),
    join(repo, "profiles/node_modules/esbuild"),
    join(repo, "desktop/node_modules/esbuild"),
    join(repo, "mobile/node_modules/esbuild"),
  ]) {
    if (existsSync(candidate)) {
      const req = createRequire(import.meta.url);
      return req(candidate);
    }
  }
  throw new Error("esbuild not found. Run `npm ci` in profiles/ or desktop/ first.");
}

const esbuild = loadEsbuild();
mkdirSync(join(root, "dist"), { recursive: true });

// Resolve @noble/* crypto dependencies from mobile/ or desktop/ node_modules when bundling client/crypto.ts.
const nodePaths = [
  join(root, "node_modules"),
  join(repo, "desktop/node_modules"),
  join(repo, "mobile/node_modules"),
  join(repo, "profiles/node_modules"),
].filter((p) => existsSync(p));

await esbuild.build({
  entryPoints: [join(root, "src/background.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  nodePaths,
  outfile: join(root, "dist/background.js"),
  legalComments: "none",
});

console.log("Built extension/dist/background.js");
