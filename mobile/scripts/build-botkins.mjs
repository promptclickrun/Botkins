#!/usr/bin/env node
// Builds the Botkin characters the app draws from the design kit (design/botkins-kit):
//   assets/botkins/<head>-<palette>.webp          each head in each kit palette, without its eyes
//   assets/botkins/layers/<head>-<layer>.webp     each head split into layers, for any four colors
//   src/data/botkins.generated.ts                 where the eyes go, each head's colors, the image tables
// The app draws eyes, mouth, badge and motion itself (src/ui/BotAvatar.tsx), so one picture per
// head and palette is enough for the kit's palettes.
//
// Custom colors. The kit recolors only the paths marked data-role="shell" | "accent" | "paper"
// (customize.js, `tint`): a path color of lightness `value` becomes target × amount below the
// role's pivot (a shade), and target + (white − target) × amount above it (a tint). Every
// rendered pixel is a sum of path colors weighted by how much of each path shows there, so the
// head splits exactly into five layers that the app stacks, bottom to top:
//   shell, accent, paper   alpha masks, tinted at run time with the person's colors
//   shade                  black and white, how much darker or lighter than the target each pixel is
//   rest                   the art with no role (the grain), in its own colors
// scripts/botkins-layers.py does the split; scripts/check-botkins-layers.mjs proves it against
// the kit's own renders. Needs macOS (the SVGs are drawn by AppKit) and Python with Pillow and numpy.
//   node scripts/build-botkins.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const kit = require("../design/botkins-kit/customize.js");
const SIZE = 512;
/** The layers are drawn at this size: enough for the studio's large preview at 3x. */
const LAYER_SIZE = 384;
const ROLES = ["shell", "accent", "paper"];
const work = mkdtempSync(join(tmpdir(), "botkins-"));
const renderer = join(work, "render-svg");
execFileSync("swiftc", ["-O", "scripts/render-svg.swift", "-o", renderer], { stdio: "inherit" });
rmSync("assets/botkins", { recursive: true, force: true });
mkdirSync("assets/botkins/layers", { recursive: true });
mkdirSync(join(work, "layers"), { recursive: true });

/** The kit's tint, taken apart: is the path a shade or a tint of its target, and by how much. */
function shading(hex, role) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const value = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
  const pivot = role === "paper" ? 0.86 : 0.49;
  const shade = value < pivot;
  return { shade, amount: shade ? value / pivot : (value - pivot) / (1 - pivot) };
}
const byte = (unit) => Math.max(0, Math.min(255, Math.round(unit * 255)));
const hexOf = (rgb) => "#" + rgb.map((c) => byte(c).toString(16).padStart(2, "0")).join("");
/** Repaints every drawn tag: `paint(role or null, its color)` gives the new color. */
const repaint = (art, paint) =>
  art.replace(/<(path|ellipse|circle|rect|polygon|g)\b[^>]*>/g, (tag) => {
    const role = /data-role="(shell|accent|paper)"/.exec(tag)?.[1] ?? null;
    return tag.replace(/#[0-9a-f]{6}/gi, (color) => paint(role, color));
  });
const channel = (role, unit) => hexOf(ROLES.map((other) => (other === role ? unit : 0)));
/** The coded pictures scripts/botkins-layers.py splits into layers. */
const CODES = {
  // How much of the target each role's paths keep: amount for a shade, 1 − amount for a tint.
  weights: (role, color) => (role ? channel(role, ((s) => (s.shade ? s.amount : 1 - s.amount))(shading(color, role))) : "#000000"),
  // Where each role shows.
  cover: (role) => (role ? channel(role, 1) : "#000000"),
  // How much white the tints add.
  white: (role, color) => (role ? ((s) => (s.shade ? "#000000" : hexOf([s.amount, s.amount, s.amount])))(shading(color, role)) : "#000000"),
  // The art with no role, in its own colors.
  rest: (role, color) => (role ? "#000000" : color),
  // The roles in their own colors, to find the four colors that come closest to Original.
  own: (role, color) => (role ? color : "#000000"),
};

const slug = (name) => name.toLowerCase();
const heads = [];
for (const file of readdirSync("design/botkins-kit/avatars").filter((name) => name.endsWith(".svg")).sort()) {
  const id = file.replace(/\.svg$/, "");
  const source = readFileSync(join("design/botkins-kit/avatars", file), "utf8");
  const name = /<title>([^<]+)<\/title>/.exec(source)[1];
  const [, tx, ty, scale] = /<g transform="translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.-]+)\)">/.exec(source).map(Number);
  const [, anchors, ink] = /<g data-layer="eyes" data-anchors="([^"]+)" fill="(#[0-9a-fA-F]{6})"/.exec(source);
  const [left, right, y] = anchors.split(",").map(Number);
  const shell = /<path data-role="shell" fill="(#[0-9a-fA-F]{6})"/.exec(source)[1];
  heads.push({ id, name, tx, ty, scale, left, right, y, ink, shell });
  const bare = (palette) => kit.render(source, "Oval", palette, { blink: false }).replace(/<g data-layer="eyes"[\s\S]*?<\/g>/, "");
  for (const palette of Object.keys(kit.palettes)) {
    const base = join(work, id + "-" + slug(palette));
    writeFileSync(base + ".svg", bare(palette));
    execFileSync(renderer, [base + ".svg", base + ".png", String(SIZE)]);
  }
  const original = bare("Original");
  for (const [code, paint] of Object.entries(CODES)) {
    const base = join(work, "layers", id + "." + code);
    writeFileSync(base + ".svg", repaint(original, paint));
    execFileSync(renderer, [base + ".svg", base + ".png", String(LAYER_SIZE)]);
  }
  process.stdout.write(".");
}
execFileSync("python3", ["-I", "-c", `
import glob, os, sys
from PIL import Image
for path in glob.glob(os.path.join(sys.argv[1], "*.png")):
    Image.open(path).save(os.path.join("assets/botkins", os.path.basename(path)[:-4] + ".webp"), "WEBP", quality=88, method=6)
`, work], { stdio: "inherit" });
const split = JSON.parse(execFileSync("python3", ["-I", "scripts/botkins-layers.py", join(work, "layers"), "assets/botkins/layers", ...heads.map((head) => head.id)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
for (const head of heads) head.own = [...split[head.id].own, head.ink];

const palettes = Object.entries(kit.palettes).map(([name, colors]) => ({ id: slug(name), name, colors }));
const LAYERS = [...ROLES, "shade", "rest"];
const layerTable = (head) => "{ " + LAYERS.map((layer) => layer + ": " + (split[head.id].layers.includes(layer) ? 'require("../../assets/botkins/layers/' + head.id + "-" + layer + '.webp")' : "null")).join(", ") + " }";
const lines = [
  "// Generated by scripts/build-botkins.mjs from design/botkins-kit. Do not edit by hand.",
  "",
  "/**",
  " * A character's head: where its eyes sit (in the head's own units) and its own colors. `own` is",
  " * [shell, accent, faceplate, eyes]: the custom colors that come closest to the character's own.",
  " */",
  "export type BotkinHead = { id: string; name: string; tx: number; ty: number; scale: number; left: number; right: number; y: number; ink: string; shell: string; own: [string, string, string, string] };",
  "export const HEAD_LIST: BotkinHead[] = " + JSON.stringify(heads, null, 2) + ";",
  "",
  "/** shell, accent, faceplate and eye colors. Original keeps each character's own. */",
  "export const PALETTE_LIST: { id: string; name: string; colors: [string, string, string, string] | null }[] = " + JSON.stringify(palettes, null, 2) + ";",
  "",
  "/** The picture of each head in each palette, without eyes. */",
  "export const HEAD_IMAGES: Record<string, Record<string, number>> = {",
  ...heads.map((head) => "  " + JSON.stringify(head.id) + ": { " + palettes.map((palette) => JSON.stringify(palette.id) + ': require("../../assets/botkins/' + head.id + "-" + palette.id + '.webp")').join(", ") + " },"),
  "};",
  "",
  "/**",
  " * Each head in layers, for custom colors, bottom to top: shell, accent and paper are masks to tint",
  " * with the shell, accent and faceplate colors; shade and rest are drawn as they are.",
  " */",
  "export type BotkinLayers = { shell: number | null; accent: number | null; paper: number | null; shade: number | null; rest: number | null };",
  "export const HEAD_LAYERS: Record<string, BotkinLayers> = {",
  ...heads.map((head) => "  " + JSON.stringify(head.id) + ": " + layerTable(head) + ","),
  "};",
  "",
];
writeFileSync("src/data/botkins.generated.ts", lines.join("\n"));
rmSync(work, { recursive: true, force: true });
console.log("\n" + heads.length + " heads × " + palettes.length + " palettes, and " + LAYERS.length + " layers each");
