// Desktop LoadingGrid tests:
// 1. Renders nothing initially with default 120ms delay, and renders the 9-cell CSS-animated
//    grid when delay={0} or once 120ms elapses, with role="status" aria-label="Loading" and
//    aria-hidden="true" on the visual grid.
// 2. loading-grid.css uses theme tokens (light, dark, and glass backdrop) and honors
//    prefers-reduced-motion.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const outFile = join(new URL(".", import.meta.url).pathname, `.loading-grid-bundle-${process.pid}.mjs`);
const srcDir = new URL("../src/", import.meta.url).pathname;

await build({
  stdin: {
    contents: `export { LoadingGrid, LOADING_GRID_DELAY_MS } from "./LoadingGrid";`,
    resolveDir: srcDir,
    loader: "ts",
  },
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
  plugins: [
    {
      name: "css-stub",
      setup(b) {
        b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
});

let mod;
try {
  mod = await import(pathToFileURL(outFile).href);
} finally {
  try { unlinkSync(outFile); } catch {}
}

const { LoadingGrid, LOADING_GRID_DELAY_MS } = mod;

test("desktop LoadingGrid defaults to 120ms delay and hides initial markup before threshold", () => {
  assert.equal(LOADING_GRID_DELAY_MS, 120);
  const initial = renderToStaticMarkup(React.createElement(LoadingGrid, null));
  assert.equal(initial, "", "default 120ms delay renders nothing synchronously so fast switches never flash");
});

test("desktop LoadingGrid renders accessible Loading region and 9 aria-hidden cells when delay=0", () => {
  const html = renderToStaticMarkup(React.createElement(LoadingGrid, { delay: 0 }));
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Loading"/);
  assert.match(html, /class="loading-grid" aria-hidden="true"/);
  const cells = html.match(/class="loading-grid-cell"/g) ?? [];
  assert.equal(cells.length, 9, "3×3 grid renders 9 animated squares");
});

test("desktop loading-grid.css uses theme colors for light, dark, glass backdrops and reduced motion", () => {
  const css = readFileSync(new URL("../src/loading-grid.css", import.meta.url), "utf8");
  assert.match(css, /@keyframes loading-grid-wave/);
  assert.match(css, /var\(--accent\)/);
  assert.match(css, /:root:not\(\[data-backdrop="clean"\]\)\s+\.loading-grid-cell/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
