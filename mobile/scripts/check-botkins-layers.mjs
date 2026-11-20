#!/usr/bin/env node
// Proves the custom-color layers (assets/botkins/layers, made by scripts/build-botkins.mjs): for
// every head and each of the kit's six palettes, stacks the layers the way BotAvatar does (masks
// tinted with the palette's shell, accent and faceplate colors, then shade, then rest) and compares
// the result with the picture the kit's own renderer (customize.js) draws for that palette.
//   node scripts/check-botkins-layers.mjs            (BOTKINS_HEADS=sprig,crumb checks only those)
// Needs macOS swiftc and Python with Pillow and numpy. Fails when the mean or the 99.9th
// percentile difference is too big (edge anti-aliasing aside, the worst single pixel is reported).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const kit = require("../design/botkins-kit/customize.js");
const SIZE = 384; // LAYER_SIZE in build-botkins.mjs
const work = mkdtempSync(join(tmpdir(), "botkins-check-"));
const renderer = join(work, "render-svg");
execFileSync("swiftc", ["-O", "scripts/render-svg.swift", "-o", renderer], { stdio: "inherit" });
mkdirSync(join(work, "kit"));

const palettes = Object.entries(kit.palettes).filter(([, colors]) => colors);
const only = process.env.BOTKINS_HEADS?.split(",");
const heads = readdirSync("design/botkins-kit/avatars").filter((name) => name.endsWith(".svg")).sort().map((name) => name.replace(/\.svg$/, "")).filter((head) => !only || only.includes(head));
const jobs = [];
for (const head of heads) {
  const source = readFileSync(join("design/botkins-kit/avatars", head + ".svg"), "utf8");
  for (const [name, colors] of palettes) {
    const base = join(work, "kit", head + "-" + name.toLowerCase());
    writeFileSync(base + ".svg", kit.render(source, "Oval", name, { blink: false }).replace(/<g data-layer="eyes"[\s\S]*?<\/g>/, ""));
    execFileSync(renderer, [base + ".svg", base + ".png", String(SIZE)]);
    jobs.push({ head, palette: name, colors, reference: base + ".png" });
  }
  process.stdout.write(".");
}
process.stdout.write("\n");
writeFileSync(join(work, "jobs.json"), JSON.stringify(jobs));
try {
  execFileSync("python3", ["-I", "scripts/check-botkins-layers.py", join(work, "jobs.json"), "assets/botkins/layers"], { stdio: "inherit" });
} finally {
  rmSync(work, { recursive: true, force: true });
}
