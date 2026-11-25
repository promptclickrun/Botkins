import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";
import { BACKDROP_IDS, BACKDROPS, backdropBaseColor, backdropById, DEFAULT_BACKDROP, isBackdrop } from "../src/ui/backdrops";

const load = createRequire(__filename);
function standIn(path: string, exports: unknown) {
  const id = load.resolve(path);
  const replacement = new Module(id);
  replacement.exports = exports;
  replacement.loaded = true;
  load.cache[id] = replacement;
}

test("backdrop definitions, lookup, and validation", () => {
  assert.equal(DEFAULT_BACKDROP, "clean");
  assert.deepEqual(BACKDROP_IDS, ["clean", "mesh", "botkins", "grid"]);
  assert.deepEqual(
    BACKDROPS.map((item) => [item.id, item.name]),
    [
      ["clean", "Clean"],
      ["mesh", "Mesh"],
      ["botkins", "Botkins"],
      ["grid", "Grid"],
    ],
  );

  for (const id of BACKDROP_IDS) {
    assert.equal(isBackdrop(id), true);
    assert.equal(backdropById(id).id, id);
    assert.match(backdropBaseColor(id, true, "#111111"), /^#[0-9a-f]{6}$/i);
    assert.match(backdropBaseColor(id, false, "#ffffff"), /^#[0-9a-f]{6}$/i);
  }
  assert.equal(backdropBaseColor("clean", true, "#111111"), "#111111");
  assert.equal(backdropBaseColor("clean", false, "#ffffff"), "#ffffff");
  assert.equal(backdropBaseColor("grid", true, "#111111"), "#10131a");
  assert.equal(backdropBaseColor("grid", false, "#ffffff"), "#f4f6fa");

  for (const invalid of ["", "aurora", "CLEAN", null, undefined, 42, {}]) {
    assert.equal(isBackdrop(invalid), false);
    assert.equal(backdropById(invalid).id, DEFAULT_BACKDROP);
  }
});

test("prefs persists backdrop and falls back to clean on invalid stored values", async () => {
  let stored = "";
  standIn("react-native", { Platform: { OS: "ios", isPad: false } });
  standIn("../src/state/keep", {
    readKept: async () => stored || null,
    keep: async (_key: string, json: string) => {
      stored = json;
    },
  });

  async function restart() {
    const path = load.resolve("../src/state/prefs");
    delete load.cache[path];
    const prefs = load(path) as typeof import("../src/state/prefs");
    await prefs.loadPrefs();
    return prefs;
  }

  // Default when nothing is stored
  const initial = await restart();
  assert.equal(initial.usePrefs.getState().backdrop, "clean");

  // Persists valid backdrop changes across restarts
  for (const id of BACKDROP_IDS) {
    const prefs = await restart();
    prefs.setPrefs({ backdrop: id });
    await Promise.resolve();
    const after = await restart();
    assert.equal(after.usePrefs.getState().backdrop, id);
  }

  // Invalid or missing backdrop in saved JSON safely falls back to clean
  stored = JSON.stringify({ mode: "dark", backdrop: "unsupported" });
  assert.equal((await restart()).usePrefs.getState().backdrop, "clean");

  stored = JSON.stringify({ mode: "light", backdrop: 123 });
  assert.equal((await restart()).usePrefs.getState().backdrop, "clean");

  stored = JSON.stringify({ mode: "system" });
  assert.equal((await restart()).usePrefs.getState().backdrop, "clean");
});
