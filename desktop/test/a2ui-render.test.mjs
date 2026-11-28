// Desktop A2uiSurface Button label rendering and theme contrast regression tests.
// Verifies that:
// 1. A Button whose label comes from a child Text component renders visible text inside <button>,
//    as inline <span> rather than a block <p>, for default, primary, and borderless variants.
// 2. a2uiSurface.css gives .a2ui-btn.primary var(--on-accent), .a2ui-btn.borderless var(--accent-text),
//    and forces child .a2ui-text inside .a2ui-btn to inherit color so labels are never invisible
//    against the button background in any light or dark theme (e.g. Ink dark where --accent and --ink are both #FFFFFF).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

globalThis.window ??= { botkins: {} };

const outFile = join(new URL(".", import.meta.url).pathname, `.a2ui-render-bundle-${process.pid}.mjs`);
const srcDir = new URL("../src/", import.meta.url).pathname;

await build({
  stdin: {
    contents: `export { default as A2uiSurface } from "./A2uiSurface";`,
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
      name: "test-stubs",
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

const { A2uiSurface } = mod;

test("A2UI Button renders its child Text label visibly for default, primary, and borderless variants", () => {
  const surface = {
    surfaceId: "botkins-smoke-20261127",
    catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
    dataModel: {},
    components: [
      { id: "root", component: "Row", children: ["btn-primary", "btn-default", "btn-borderless"] },
      {
        id: "btn-primary",
        component: "Button",
        variant: "primary",
        child: "lbl-primary",
        action: { event: { name: "smoke_click" } },
      },
      { id: "lbl-primary", component: "Text", text: "Test A2UI click" },
      {
        id: "btn-default",
        component: "Button",
        variant: "default",
        child: "lbl-default",
        action: { event: { name: "default_click" } },
      },
      { id: "lbl-default", component: "Text", text: "Default action" },
      {
        id: "btn-borderless",
        component: "Button",
        variant: "borderless",
        child: "lbl-borderless",
        action: { event: { name: "borderless_click" } },
      },
      { id: "lbl-borderless", component: "Text", text: "Borderless action" },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(A2uiSurface, {
      chatId: "chat-1",
      surface,
      rich: true,
      onAction: async () => {},
    }),
  );

  assert.match(html, /<button[^>]*class="a2ui-btn primary"[^>]*><span class="a2ui-text body">Test A2UI click<\/span><\/button>/);
  assert.match(html, /<button[^>]*class="a2ui-btn default"[^>]*><span class="a2ui-text body">Default action<\/span><\/button>/);
  assert.match(html, /<button[^>]*class="a2ui-btn borderless"[^>]*><span class="a2ui-text body">Borderless action<\/span><\/button>/);
});

test("a2uiSurface.css enforces accessible button foreground tokens and child Text color inheritance across all themes", () => {
  const css = readFileSync(new URL("../src/a2uiSurface.css", import.meta.url), "utf8");
  assert.match(css, /\.a2ui-btn\.primary\s*\{[^}]*color:\s*var\(--on-accent\)/s, "primary button uses --on-accent instead of hardcoded #fff");
  assert.match(css, /\.a2ui-btn\.borderless\s*\{[^}]*color:\s*var\(--accent-text\)/s, "borderless button uses --accent-text");
  assert.match(css, /\.a2ui-btn\s+\.a2ui-text[^{]*\{[^}]*color:\s*inherit/s, "child Text inside .a2ui-btn inherits the button color");

  // Verify every theme's light and dark palettes have distinct button background/foreground colors.
  const catalog = JSON.parse(readFileSync(new URL("../desktop/themes.json", import.meta.url), "utf8"));
  for (const theme of catalog.themes) {
    for (const mode of ["light", "dark"]) {
      const palette = theme[mode];
      assert.notEqual(palette.accent.toLowerCase(), palette.onAccent.toLowerCase(), `${theme.id} ${mode}: primary button accent != onAccent`);
      assert.notEqual(palette.sunken.toLowerCase(), palette.ink.toLowerCase(), `${theme.id} ${mode}: default button sunken != ink`);
      assert.notEqual(palette.surface.toLowerCase(), palette.accentText.toLowerCase(), `${theme.id} ${mode}: borderless button surface != accentText`);
    }
  }
});
