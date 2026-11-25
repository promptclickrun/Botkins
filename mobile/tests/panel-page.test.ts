// An opened panel's layout (src/features/spaces/PanelPage.tsx): a panel that is only an app fills
// the screen, its notes open as a sheet from the bar with a count, and its page keeps room under its
// end for the floating ask bar. Any other panel keeps its notes under it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { askRoom, noteBadge, panelLayout } from "../src/features/spaces/logic";
import type { PanelView } from "../src/link/types";
import { framePage } from "../src/ui/frame";
import { isSheet } from "../src/ui/onShow";

type Blocks = PanelView["blocks"];
const app = [{ type: "html", frame: "f1", height: 400 }] as unknown as Blocks;
const text = [{ type: "markdown", text: "Hello" }] as unknown as Blocks;
const mixed = [...text, ...app] as Blocks;
const note = { id: "n1", by: "u1", name: "Maya Chen", text: "Looks good", at: 1 };

test("a panel that is only an app fills the screen, with its notes in a sheet", () => {
  assert.deepEqual(panelLayout({ blocks: app }, true), { fill: true, notesInSheet: true, notesButton: true });
  assert.deepEqual(panelLayout({ blocks: app, notes: [note] }, false), { fill: true, notesInSheet: true, notesButton: true }, "a viewer reads the notes there");
  assert.deepEqual(panelLayout({ blocks: app }, false), { fill: true, notesInSheet: true, notesButton: false }, "no notes and no way to write one: no button");
});

test("any other panel scrolls as a page with its notes under it", () => {
  assert.deepEqual(panelLayout({ blocks: text, notes: [note] }, true), { fill: false, notesInSheet: false, notesButton: false });
  assert.deepEqual(panelLayout({ blocks: mixed }, true), { fill: false, notesInSheet: false, notesButton: false }, "an app beside text takes its own height");
  assert.deepEqual(panelLayout({ blocks: [] }, true), { fill: false, notesInSheet: false, notesButton: false });
});

test("the count on the notes button", () => {
  assert.equal(noteBadge(0), undefined);
  assert.equal(noteBadge(1), "1");
  assert.equal(noteBadge(9), "9");
  assert.equal(noteBadge(10), "9+");
});

test("the room under a full-screen app is what floats over it", () => {
  assert.equal(askRoom({ bottom: 34, bar: 0, chips: 0, gap: 8 }), 42, "no ask bar: the home indicator and a gap");
  assert.equal(askRoom({ bottom: 34, bar: 50, chips: 0, gap: 8 }), 34 + 8 + 50 + 8);
  assert.equal(askRoom({ bottom: 34, bar: 50, chips: 52, gap: 8 }), 34 + 8 + 50 + 52 + 4 + 8);
});

test("the frame's page keeps that room under its end, only on the whole screen", () => {
  const theme = { mode: "dark" as const, colors: {} };
  const full = framePage("<p>hi</p>", null, theme, { fill: true, bottom: 150 });
  assert.ok(full.includes("html{padding-bottom:150px}"));
  assert.ok(full.includes("--inset-bottom:150px"));
  assert.ok(!framePage("<p>hi</p>", null, theme, { fill: true }).includes("padding-bottom"), "no room asked: none added");
  assert.ok(!framePage("<p>hi</p>", null, theme, { bottom: 150 }).includes("padding-bottom"), "a card's frame sizes to its page");
  assert.ok(framePage("<p>hi</p>", null, theme, { fill: true, bottom: 99999 }).includes("padding-bottom:400px"), "kept to a sane size");
});

test("the notes open as a sheet route", () => {
  assert.equal(isSheet("space/notes"), true);
  const layout = readFileSync(new URL("../src/app/_layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /name="space\/notes" options=\{half\}/);
});
