// Desktop interim update and ActivityPanel MEDIA: rendering tests:
// InterimUpdate and ActivityPanel must pass ChatFiles (`files`) into RichText so that
// MEDIA: attachments in interim messages resolve and render via ChatMedia instead of raw text.
import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

globalThis.window ??= { botkins: {} };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const outFile = join(new URL(".", import.meta.url).pathname, `.interim-media-bundle-${process.pid}.mjs`);
const srcDir = new URL("../src/", import.meta.url).pathname;

await build({
  stdin: {
    contents: [
      `export { InterimUpdate } from "./ChatActivity";`,
      `export { ActivityPanel } from "./ActivityInspector";`,
    ].join("\n"),
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
        b.onResolve({ filter: /^\.\/Backdrop$/ }, () => ({ path: "Backdrop", namespace: "test-backdrop" }));
        b.onLoad({ filter: /.*/, namespace: "test-backdrop" }, () => ({ contents: `export const Backdrop = () => null; export const BackdropPreview = () => null;`, loader: "js" }));
        b.onResolve({ filter: /^\.\/Avatar$/ }, () => ({ path: "Avatar", namespace: "test-avatar" }));
        b.onLoad({ filter: /.*/, namespace: "test-avatar" }, () => ({
          contents: `import React from "react";
export function BotAvatar() { return React.createElement("span", { className: "avatar-stub" }); }`,
          loader: "js",
        }));
        b.onResolve({ filter: /^\.\/Pages$/ }, () => ({ path: "Pages", namespace: "test-pages" }));
        b.onLoad({ filter: /.*/, namespace: "test-pages" }, () => ({
          contents: `export const useAsk = () => ({ ask: async () => null, node: null });`,
          loader: "js",
        }));
        b.onResolve({ filter: /^\.\/RichText$/ }, () => ({ path: "RichText", namespace: "test-richtext" }));
        b.onLoad({ filter: /.*/, namespace: "test-richtext" }, () => ({
          contents: `import React from "react";
export function RichText({ text, files }) {
  return React.createElement("div", {
    className: "rich-text-stub",
    "data-has-files": files ? "yes" : "no",
    "data-chat-id": files?.chatId ?? "",
  }, text);
}`,
          loader: "js",
        }));
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

const { InterimUpdate, ActivityPanel } = mod;
const sampleFiles = { chatId: "chat-1", botId: "pip", remote: false, revision: 1, preview() {} };
const mediaLine = "Preview ready:\nMEDIA:/opt/data/files/pip/shot.png";

test("InterimUpdate forwards ChatFiles to RichText so MEDIA: resolves instead of showing raw text", () => {
  const html = renderToStaticMarkup(React.createElement(InterimUpdate, { text: mediaLine, files: sampleFiles }));
  assert.match(html, /data-has-files="yes"/, "InterimUpdate must pass files to RichText");
  assert.match(html, /data-chat-id="chat-1"/);
});

test("ActivityPanel forwards ChatFiles to RichText when showing an interim update detail (during and after a run)", () => {
  const workingRun = {
    id: "run-1",
    chatId: "chat-1",
    title: "Generate chart",
    status: "Working",
    time: 1000,
    steps: [{ id: "s1", name: "bash", label: "render chart", status: "Running", started: 1200 }],
  };
  const updates = [{ key: "interim-1", at: 1100, text: mediaLine }];
  const liveHtml = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      run: workingRun,
      updates,
      files: sampleFiles,
      target: { runId: "run-1", select: "update-interim-1", seq: 1 },
    }),
  );
  assert.match(liveHtml, /data-has-files="yes"/, "ActivityPanel must pass files to RichText for live interim updates");

  const doneRun = { ...workingRun, status: "Completed", finished: 2000, steps: [{ ...workingRun.steps[0], status: "Done", finished: 1800 }] };
  const doneHtml = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      run: doneRun,
      updates,
      files: sampleFiles,
      target: { runId: "run-1", select: "update-interim-1", seq: 2 },
    }),
  );
  assert.match(doneHtml, /data-has-files="yes"/, "ActivityPanel must pass files to RichText for finished interim updates");
});
