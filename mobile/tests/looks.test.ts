// A bot's look: the color math behind the studio's picker, the color templates, and how a look
// with eyes and colors of its own resolves. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { COLOR_SLOTS, contrastOf, hexToHsv, hexToRgb, hsvToHex, isFourColors, isHex, parseHex, remember, rgbToHex, SUGGESTED, TEMPLATES, templateOf } from "../src/data/lookTemplates";

// botLook.ts reaches the pictures through require("….webp"), which only Metro understands. Here
// each picture stands for its own path.
const load = createRequire(__filename);
(load.extensions as Record<string, (module: { exports: unknown }, file: string) => void>)[".webp"] = (module, file) => {
  module.exports = file;
};
const looks = load("../src/data/botLook") as typeof import("../src/data/botLook");
const generated = load("../src/data/botkins.generated") as typeof import("../src/data/botkins.generated");

test("hex and HSV go back and forth without losing a color", () => {
  for (let index = 0; index < 4096; index++) {
    const hex = rgbToHex([(index * 37) % 256, (index * 101) % 256, (index * 13) % 256]);
    assert.equal(hsvToHex(hexToHsv(hex)), hex, hex);
  }
  assert.deepEqual(hexToHsv("#ff0000"), { h: 0, s: 1, v: 1 });
  assert.equal(hsvToHex({ h: 120, s: 1, v: 1 }), "#00ff00");
  assert.equal(hsvToHex({ h: 240, s: 1, v: 0.5 }), "#000080");
  assert.deepEqual(hexToRgb("#c75e35"), [199, 94, 53]);
});

test("the picker never makes an invalid color", () => {
  const odd = [-1, 0, 0.5, 1, 2, 359.999, 360, 720, -720, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const h of [...odd, 0, 60, 180, 300])
    for (const s of odd)
      for (const v of odd) assert.ok(isHex(hsvToHex({ h, s, v })), `${h} ${s} ${v} gave ${hsvToHex({ h, s, v })}`);
  assert.equal(rgbToHex([300, -5, Number.NaN]), "#ff0000");
});

test("a gray keeps the hue and black keeps the saturation the picker had", () => {
  assert.equal(hexToHsv("#808080", { h: 200, s: 0.7 }).h, 200);
  assert.equal(hexToHsv("#000000", { h: 30, s: 0.4 }).s, 0.4);
  assert.equal(hexToHsv("#000000", { h: 30, s: 0.4 }).h, 30);
});

test("typed colors are read as #rrggbb or refused", () => {
  assert.equal(parseHex("C75E35"), "#c75e35");
  assert.equal(parseHex(" #c75e35 "), "#c75e35");
  assert.equal(parseHex("#c5e"), "#cc55ee");
  for (const bad of ["", "#", "c75e3", "c75e355", "ggg", "#12345z", "red"]) assert.equal(parseHex(bad), null, bad);
  assert.equal(isHex("#C75E35"), false, "the computer saves lower case");
});

test("recent colors put the newest first, without repeats", () => {
  assert.deepEqual(remember(["#111111", "#222222"], "#222222"), ["#222222", "#111111"]);
  assert.deepEqual(remember([], "nope"), []);
  assert.equal(remember(Array.from({ length: 20 }, (_, index) => rgbToHex([index, 0, 0])), "#ffffff").length, 8);
});

test("templates are valid, named apart from the kit's palettes, and their eyes read on the face", () => {
  const kit = new Set(generated.PALETTE_LIST.map((palette) => palette.id));
  const ids = new Set<string>();
  assert.ok(TEMPLATES.length >= 8);
  for (const template of TEMPLATES) {
    assert.ok(isFourColors(template.colors), template.id);
    assert.ok(!kit.has(template.id) && template.id !== looks.CUSTOM, template.id + " is a kit palette's id");
    assert.ok(!ids.has(template.id), template.id + " twice");
    ids.add(template.id);
    const [shell, , face, eyes] = template.colors;
    assert.ok(contrastOf(eyes, face) >= 7, `${template.name}: eyes on face ${contrastOf(eyes, face).toFixed(2)}`);
    assert.ok(contrastOf(shell, face) >= 1.8, `${template.name}: the face stands out from the shell`);
    assert.equal(templateOf(template.colors)?.id, template.id);
    assert.equal(templateOf(template.colors.map((color) => color.toUpperCase()))?.id, template.id);
  }
  assert.equal(templateOf(["#000000", "#000000", "#000000", "#000001"]), undefined);
  assert.ok(SUGGESTED.every(isHex));
  assert.equal(COLOR_SLOTS.length, 4);
});

test("an old look resolves as before", () => {
  const resolved = looks.resolveLook({ head: "sprig", palette: "honey" });
  assert.equal(resolved.custom, null);
  assert.equal(resolved.eyes, "oval");
  assert.match(String(resolved.image), /sprig-honey\.webp$/);
  assert.equal(resolved.shell, "#dfa12e");
  assert.equal(resolved.ink, "#553819");
  const original = looks.resolveLook({ head: "sprig", palette: "original" });
  assert.equal(original.shell, generated.HEAD_LIST.find((head) => head.id === "sprig")!.shell);
  assert.equal(looks.colorOf({ id: "x", look: { head: "sprig", palette: "fern" } }), "#748848");
});

test("a bot without a saved look keeps its original character as the kit grows", () => {
  const original = "beacon crumb fathom goggle luna morel muse oakley pearl pip posy pounce ramble skiff spool sprig tinker toast wick wicket".split(" ");
  assert.deepEqual(looks.availableHeads().map((head) => head.id), original);
  for (let i = 0; i < original.length; i++) {
    const id = String.fromCharCode(97 + i);
    assert.equal(looks.defaultLook(id).head, original[(7 * 31 + 97 + i) % original.length]);
    assert.equal(looks.lookOf({ id }).head, looks.defaultLook(id).head);
  }
});

test("new characters are offered on a capable computer, with real artwork for every palette and color slot", () => {
  const previousHeads = looks.availableHeads().map((head) => head.id);
  const first = looks.availableHeads(["botkin-heads-v2"]).filter((head) => !previousHeads.includes(head.id));
  assert.deepEqual(first.map((head) => head.id), ["drip", "orbit", "pebble"]);
  const added = looks.availableHeads(["botkin-heads-v3"]).filter((head) => !previousHeads.includes(head.id));
  assert.deepEqual(added.map((head) => head.id), ["brim", "clover", "drip", "dune", "gloop", "mallow", "orbit", "pebble", "ripple", "wisp"]);
  for (const { id } of added) {
    for (const palette of generated.PALETTE_LIST) {
      const look = { head: id, palette: palette.id, eyes: "curious" as const };
      const resolved = looks.resolveLook(look);
      assert.equal(resolved.head.id, id);
      assert.equal(resolved.eyes, "curious");
      assert.ok(String(resolved.image).endsWith(id + "-" + palette.id + ".webp"));
      assert.deepEqual(looks.lookOf({ id: "historical-bot", look }), look);
    }
    const colors = TEMPLATES[0].colors;
    for (const { id: eyes } of looks.EYES) {
      const custom = looks.resolveLook({ head: id, palette: "custom", colors, eyes });
      assert.equal(custom.eyes, eyes);
      assert.equal(custom.ink, colors[3]);
      assert.deepEqual(custom.custom?.colors, colors);
    }
    const layers = generated.HEAD_LAYERS[id];
    for (const key of ["shell", "accent", "paper", "shade"] as const) {
      assert.ok(String(layers[key]).endsWith(id + "-" + key + ".webp"));
    }
  }
});

test("a template keeps the parts of its look that the paired host can save", () => {
  const look = { head: "drip", palette: "custom", eyes: "wink" as const, colors: TEMPLATES[0].colors };
  const fallback = looks.defaultLook("template").head;
  assert.deepEqual(looks.lookForHost(look, "template", { advanced: true, capabilities: ["botkin-heads-v2"] }), look);
  assert.deepEqual(looks.lookForHost(look, "template", { advanced: true }), { ...look, head: fallback });
  const wisp = { ...look, head: "wisp" };
  assert.deepEqual(looks.lookForHost(wisp, "template", { advanced: true, capabilities: ["botkin-heads-v2"] }), { ...wisp, head: fallback });
  assert.deepEqual(looks.lookForHost(wisp, "template", { advanced: true, capabilities: ["botkin-heads-v3"] }), wisp);
  assert.deepEqual(looks.lookForHost(look, "template", {}), { head: fallback, palette: "original" });
});

test("a custom look resolves to its layers and its own colors", () => {
  const colors: [string, string, string, string] = ["#3E4F86", "#e0b354", "#e8ecf6", "#151a2e"];
  const resolved = looks.resolveLook({ head: "sprig", palette: "custom", colors, eyes: "wink" });
  assert.ok(resolved.custom);
  assert.deepEqual(resolved.custom.colors, ["#3e4f86", "#e0b354", "#e8ecf6", "#151a2e"]);
  assert.match(String(resolved.custom.layers.shell), /layers\/sprig-shell\.webp$/);
  assert.match(String(resolved.custom.layers.rest), /layers\/sprig-rest\.webp$/);
  assert.equal(resolved.eyes, "wink");
  assert.equal(resolved.ink, "#151a2e", "eyes are drawn in the fourth color");
  assert.equal(resolved.shell, "#3e4f86");
  assert.equal(looks.colorOf({ look: { head: "sprig", palette: "custom", colors } }), "#3e4f86", "a custom bot's own color is its shell");
  // "custom" without four good colors falls back to the character's own colors.
  assert.equal(looks.resolveLook({ head: "sprig", palette: "custom" }).custom, null);
  assert.equal(looks.resolveLook({ head: "sprig", palette: "custom", colors: ["#fff", "#000000", "#000000", "#000000"] as never }).custom, null);
  assert.equal(looks.resolveLook({ head: "sprig", palette: "fern", eyes: "nope" as never }).eyes, "oval");
});

test("every head has layers, and a fitted set of its own colors", () => {
  for (const head of generated.HEAD_LIST) {
    const layers = generated.HEAD_LAYERS[head.id];
    assert.ok(layers.shell && layers.paper && layers.shade, head.id);
    assert.ok(isFourColors(head.own), head.id);
    assert.equal(looks.hasAccent(head.id), layers.accent != null);
    assert.deepEqual(looks.colorsOf({ head: head.id, palette: "original" }), head.own);
  }
  assert.deepEqual(looks.colorsOf({ head: "sprig", palette: "fig" }), ["#946079", "#b99655", "#f7e1cf", "#482d39"]);
});

test("looks compare and save the way the computer keeps them", () => {
  const colors: [string, string, string, string] = ["#3e4f86", "#e0b354", "#e8ecf6", "#151a2e"];
  assert.ok(looks.sameLook({ head: "sprig", palette: "fern" }, { head: "sprig", palette: "fern", eyes: "oval" }));
  assert.ok(!looks.sameLook({ head: "sprig", palette: "fern" }, { head: "sprig", palette: "fern", eyes: "wink" }));
  assert.ok(looks.sameLook({ head: "sprig", palette: "custom", colors }, { head: "sprig", palette: "custom", colors: colors.map((color) => color.toUpperCase()) as typeof colors }));
  assert.ok(!looks.sameLook({ head: "sprig", palette: "custom", colors }, { head: "sprig", palette: "custom", colors: [...colors.slice(0, 3), "#000000"] as typeof colors }));
  assert.deepEqual(looks.cleanLook({ head: "sprig", palette: "fern", eyes: "oval", colors }), { head: "sprig", palette: "fern" });
  assert.deepEqual(looks.cleanLook({ head: "sprig", palette: "custom", eyes: "smile", colors }), { head: "sprig", palette: "custom", eyes: "smile", colors });
  assert.ok(!looks.needsLooksV2({ head: "sprig", palette: "fern", eyes: "oval" }));
  assert.ok(looks.needsLooksV2({ head: "sprig", palette: "fern", eyes: "sleepy" }));
  assert.ok(looks.needsLooksV2({ head: "sprig", palette: "custom", colors }));
});

test("a random look needs looks-v2 only when asked for one", () => {
  for (let index = 0; index < 300; index++) {
    const simple = looks.randomLook();
    assert.ok(!looks.needsLooksV2(simple), JSON.stringify(simple));
    assert.ok(looks.availableHeads().some((head) => head.id === simple.head));
    const advanced = looks.randomLook({ advanced: true });
    assert.ok(generated.HEAD_LIST.some((head) => head.id === advanced.head));
    if (advanced.palette === looks.CUSTOM) assert.ok(isFourColors(advanced.colors));
    assert.ok(advanced.eyes === undefined || looks.EYES.some((eyes) => eyes.id === advanced.eyes));
  }
});
