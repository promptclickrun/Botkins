// The page a shared link opens lives on the relay (relay/src/space*.ts and the two scripts beside
// them), and it repeats a few things the phone owns: the custom-view policy, what is removed from a
// view's page, the Ink theme's colors and how a link's id is made. These tests keep the copies the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { shareIdOf as hostShareId } from "../link-host/spaces.mjs";
import { shareIdOf as relayShareId } from "../relay/src/shared.ts";
import { FRAME_CSP as RELAY_FRAME_CSP } from "../relay/src/space.ts";
import { FRAME_CSP, FRAME_GUARD, frameColors, framePage, NESTED_FRAME_GUARD } from "../src/ui/frame";
import { themeById } from "../src/ui/themes";

const read = (name: string) => readFileSync(new URL("../relay/src/" + name, import.meta.url), "utf8");

test("a panel's page on a shared link runs under the phone's own custom-view policy", () => {
  assert.equal(RELAY_FRAME_CSP, FRAME_CSP);
  const frame = read("space-frame.js.txt");
  const removed = [...FRAME_GUARD.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]!);
  assert.ok(removed.length >= 10);
  for (const name of removed) assert.ok(frame.includes(`"${name}"`), name + " is removed there too");
  // No frame is left inside a view's page: the relay's frame and the phone's views run one block, word for word.
  assert.ok(frame.includes(NESTED_FRAME_GUARD), "the relay's frame holds the phone's nested-frame guard");
  assert.ok(NESTED_FRAME_GUARD.length > 2000 && NESTED_FRAME_GUARD.includes("MutationObserver") && NESTED_FRAME_GUARD.includes("attachShadow"));
  // On the phone it runs before the bridge and before anything of the bot's.
  const page = framePage("<p id=bot>hi</p>", null, { mode: "light", colors: {} });
  assert.ok(page.indexOf(NESTED_FRAME_GUARD) > 0 && page.indexOf(NESTED_FRAME_GUARD) < page.indexOf("window.ReactNativeWebView") && page.indexOf("window.ReactNativeWebView") < page.indexOf("<p id=bot>"));
  new Function(NESTED_FRAME_GUARD.replace(/^/, "return;"));
  // Nothing in either script can end the <script> it is served in.
  assert.ok(!/<\/script/i.test(NESTED_FRAME_GUARD));
  for (const name of ["space-frame.js.txt", "space-page.js.txt"]) assert.ok(!/<\/script/i.test(read(name)), name);
});

test("the shared page wears Ink, and tells a panel's page the same colors the phone would", () => {
  const page = read("space-page.js.txt");
  const css = read("space.ts");
  const ink = themeById("ink");
  for (const mode of ["light", "dark"] as const) {
    const colors = ink[mode] as unknown as Record<string, string>;
    const told = new RegExp(mode + ": \\{([^}]+)\\}").exec(page)?.[1] ?? "";
    const table = Object.fromEntries([...told.matchAll(/(\w+): "(#[0-9A-F]{6})"/g)].map((match) => [match[1]!, match[2]!]));
    // Every color a page is told by name (frameColors) is in the relay's table, with Ink's value.
    const names = ["ink", "muted", "faint", "line", "lineStrong", "surface", "sunken", "raised", "canvas", "accent", "onAccent", "accentSoft", "success", "warning", "danger", "info", "bubble"];
    assert.deepEqual(Object.keys(table).sort(), [...names].sort());
    for (const name of names) assert.equal(table[name], colors[name], mode + " " + name);
    assert.equal(Object.values(frameColors(colors)).filter((value) => !value).length, 0);
    // The page's own styles use the same values.
    for (const name of ["canvas", "surface", "sunken", "ink", "muted", "faint", "line", "success", "warning", "danger", "info"]) assert.ok(css.includes(colors[name]!), mode + " " + name + " in the page's styles");
  }
});

test("the relay works out a link's id as the computer does", async () => {
  const key = "A".repeat(43);
  const salt = "b".repeat(22);
  assert.equal(await relayShareId(key, salt), hostShareId(key, salt));
  assert.match(hostShareId(key, salt), /^[A-Za-z0-9_-]{22}$/);
});
