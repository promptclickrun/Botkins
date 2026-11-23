// The gadget's screen, drawn on this computer: every screen to a PNG file (firmware/host/screens.cpp),
// then a look at the pixels that say the most: the Botkin's own colours, the ring's colour for the
// state, and a dimmed screen darker than an awake one.
//
//   sh firmware/build-host.sh && node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const SCREENS = process.env.BOTKINS_GADGET_SCREENS ?? join(here, "../firmware/build/botkins-gadget-screens");
const dir = mkdtempSync(join(tmpdir(), "gadget-screens-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let output = "";
before(() => {
  output = execFileSync(SCREENS, [dir], { encoding: "utf8" });
});

/** An 8-bit RGB or RGBA PNG, as stb_image_write writes it: { width, height, at(x, y) -> [r, g, b] }. */
function png(file) {
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} is a PNG`);
  let width = 0, height = 0, channels = 0;
  const data = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0), height = body.readUInt32BE(4);
      assert.equal(body[8], 8, "8 bits a channel");
      channels = { 2: 3, 6: 4 }[body[9]];
    } else if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[y * stride + i] = (line[i] + predictor) & 0xff;
    }
  }
  const at = (x, y) => [...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)];
  return { width, height, at };
}

const hex = (value) => [value >> 16, (value >> 8) & 0xff, value & 0xff];
const near = (pixel, colour, tolerance = 12) => pixel.every((v, i) => Math.abs(v - colour[i]) <= tolerance);
/** How many pixels of the square (the 466 design's units, at 466) are near `colour`. */
function count(image, colour, [x0, y0, x1, y1], tolerance = 12) {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (near(image.at(x, y), colour, tolerance)) n++;
  return n;
}
function brightness(image, [x0, y0, x1, y1]) {
  let sum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += image.at(x, y).reduce((a, b) => a + b, 0);
  return sum / ((x1 - x0) * (y1 - y0) * 3);
}
const FACE = [123, 62, 343, 282]; // where the large Botkin sits
const read = (name) => png(join(dir, `${name}.png`));
/** The ring's colour at the top of the screen, just right of centre. */
const top = (image) => image.at(Math.floor(image.width / 2) + 3, 1);

test("every screen is a PNG of its canvas's size", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
  const listed = output.split("\n").filter((l) => l.includes(".png")).map((l) => l.split(" ")[0]);
  assert.ok(files.length >= 39, `${files.length} screens`);
  assert.deepEqual(files.sort(), listed.sort());
  for (const file of files) {
    const { width, height } = png(join(dir, file));
    const want = file.includes("-320x240") ? [320, 240] : file.includes("-240") ? [240, 240] : [466, 466];
    assert.deepEqual([width, height], want, file);
  }
  assert.match(output, /quick checks ok/);
});

test("the Botkin is drawn in its own colours", () => {
  // Tidepool's honey paint and teal shell; Spool's gold; the original Botkin's green at first start.
  const ready = read("ready");
  assert.ok(count(ready, hex(0xe1b364), FACE) > 500, "Tidepool's honey");
  assert.ok(count(ready, hex(0x426c62), FACE) > 300, "Tidepool's shell");
  assert.ok(count(read("spool-ready"), hex(0xc58e29), FACE) > 300, "Spool's gold");
  assert.ok(count(read("setup"), hex(0x75926c), FACE) > 300, "the original Botkin's green");
  assert.equal(count(read("setup"), hex(0x426c62), FACE, 6), 0, "not Tidepool at first start");
  // A pose the bot has no face for: the original Botkin stands in.
  assert.ok(count(read("missing-face"), hex(0x75926c), FACE) > 300);
});

test("the ring says the state", () => {
  assert.ok(near(top(read("working")), hex(0xe8a945)), "honey while working");
  assert.ok(near(top(read("working-240")), hex(0xe8a945)), "honey at 240 too");
  assert.ok(near(top(read("needs-permission")), hex(0xe07a55)), "clay while a request waits");
  assert.ok(near(top(read("listening")), hex(0xfff8ea)), "cream while listening");
  assert.ok(near(top(read("ready")), hex(0x3a332e), 16), "a hairline at rest");
  assert.ok(near(top(read("removed")), hex(0xe07a55)), "clay when removed");
  // Speaking: the shell colour from the face (Tidepool's #548679, a fifth of the way to white).
  assert.ok(near(top(read("speaking")), hex(0x769e94)), "Tidepool's shell while speaking");
  assert.ok(!near(top(read("spool-speaking")), hex(0x769e94)), "another bot, another colour");
  // The working arc grows with the steps: it reaches the left side (three quarters round) only after many.
  const left = (name) => read(name).at(1, 233);
  assert.ok(!near(left("working-first-step"), hex(0xe8a945)));
  assert.ok(near(left("working-many-steps"), hex(0xe8a945)));
  for (const name of ["setup", "dimmed"]) assert.ok(near(top(read(name)), [0, 0, 0], 4), `no ring: ${name}`);
});

test("dimmed is much darker than ready", () => {
  const awake = brightness(read("ready"), FACE), dimmed = brightness(read("dimmed"), FACE);
  assert.ok(dimmed < awake * 0.45, `${dimmed} against ${awake}`);
  assert.ok(dimmed > 0, "the Botkin is still there");
});
