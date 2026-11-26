// A screen the stack opens as a sheet has no header, so it must draw its own with <Sheet>.
// A <Page> there renders an empty panel (the workflow screen did, 2026-11-26).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const app = join(__dirname, "..", "src", "app");
const layout = readFileSync(join(app, "_layout.tsx"), "utf8");

function sheetRoutes() {
  const routes = [...layout.matchAll(/name="([^"]+)" options=\{(?:sheet|tall|half)\}/g)].map((m) => m[1]);
  assert.ok(routes.length > 10, "found the sheet routes in _layout.tsx");
  return routes;
}

function source(route: string) {
  for (const file of [route + ".tsx", join(route, "index.tsx")]) {
    const path = join(app, file);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

test("every screen opened as a sheet draws a Sheet, not a Page", () => {
  const wrong = sheetRoutes().filter((route) => {
    const text = source(route);
    return text !== undefined && /<Page[\s>]/.test(text);
  });
  assert.deepEqual(wrong, []);
});

test("the workflow designer is a full page, so its canvas can fill a tablet or a phone on its side", () => {
  assert.ok(!sheetRoutes().includes("workflow/[id]"));
  assert.match(layout, /name="workflow\/\[id\]" \/>/);
});
