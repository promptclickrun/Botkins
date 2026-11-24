import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Level, onShow, SHEETS } from "../src/ui/onShow";

const tabs = {
  type: "tab", key: "tab-nav", index: 0,
  routes: [{ name: "index", key: "home" }, { name: "work", key: "work" }],
};
const home = { state: tabs, key: "home" };
const work = { state: tabs, key: "work" };

function stack(route: number, ...names: string[]): Level {
  const routes = names.map((name, i) => ({ key: "route-" + i, name }));
  return { key: "route-" + route, state: { type: "stack", key: "root", index: routes.length - 1, routes } };
}

test("a sheet leaves the selected tab in view and a page covers it", () => {
  assert.equal(onShow([home, stack(0, "(tabs)", "chat/[id]")]), false);
  assert.equal(onShow([home, stack(0, "(tabs)", "chat/new")]), true);
  assert.equal(onShow([home, stack(0, "(tabs)", "chat/new", "chat/[id]")]), false);
});

test("only sheets above a page leave it in view", () => {
  const names = ["(tabs)", "chat/[id]", "chat/model"];
  assert.equal(onShow([home, stack(0, ...names)]), false);
  assert.equal(onShow([stack(1, ...names, "chat/model-info")]), true);
  assert.equal(onShow([stack(1, "(tabs)", "chat/[id]", "bot/[id]/index")]), false);
});

test("only the selected tab is on show", () => {
  for (const above of [[], ["pair/index"]]) {
    const root = stack(0, "(tabs)", ...above);
    assert.equal(onShow([work, root]), false);
    assert.equal(onShow([home, root]), true);
  }
});

test("an unknown level leaves known levels to decide", () => {
  const top = stack(1, "(tabs)", "chat/[id]");
  const unknown = { state: top.state, key: "missing" };
  assert.equal(onShow([work, unknown]), false);
  assert.equal(onShow([unknown]), true);
  assert.equal(onShow([{ state: tabs, key: "missing" }]), true);
  assert.equal(onShow([]), true);
  assert.equal(onShow([top]), true);
});

test("SHEETS matches the root stack's sheet routes", () => {
  const layout = readFileSync(new URL("../src/app/_layout.tsx", import.meta.url), "utf8");
  const screens = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"([^\n]*)/g)];
  assert.ok(screens.length >= 20, "expected to find at least 20 root stack screens");
  const sheets = new Set(screens.filter(([, , options]) => /options=\{(?:tall|half)\}|\.\.\.sheet\b/.test(options)).map(([, name]) => name));
  const add = [...sheets].filter((name) => !SHEETS.has(name));
  const remove = [...SHEETS].filter((name) => !sheets.has(name));
  assert.deepEqual(SHEETS, sheets, `Update SHEETS in src/ui/onShow.ts. Add: ${add.join(", ") || "none"}. Remove: ${remove.join(", ") || "none"}.`);
});

test("the agent you're with stops moving when a page covers it, and keeps moving under a sheet", () => {
  // A bot's page and its chat are where avatars move (avatarMotion.tsx); a list never moves at all.
  assert.equal(onShow([stack(1, "(tabs)", "bot/[id]/index")]), true);
  assert.equal(onShow([stack(1, "(tabs)", "bot/[id]/index", "chat/[id]")]), false, "its chat over its page");
  assert.equal(onShow([stack(1, "(tabs)", "chat/[id]", "bot/[id]/index")]), false, "its page over its chat");
  assert.equal(onShow([stack(1, "(tabs)", "bot/[id]/index", "bot/[id]/edit")]), true);
  assert.equal(onShow([stack(1, "(tabs)", "chat/[id]", "chat/activity")]), true);
  assert.equal(onShow([work, stack(0, "(tabs)")]), false, "a screen in a tab that is not selected");
});
