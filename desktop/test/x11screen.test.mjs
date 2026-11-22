// The terminal host's X11 screen (desktop/host/x11screen.mjs), with stand-in tools: no X server.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessHost } from "../desktop/host/headless.mjs";
import { captureCommand, NEED_CAPTURE_TOOL, x11Screen } from "../desktop/host/x11screen.mjs";

// The smallest JPEG header jpegSize reads: SOI, then a baseline frame of 640x400.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);

function tools(t, which) {
  const dir = mkdtempSync(join(tmpdir(), "bk-x11-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "shot.jpg"), JPEG);
  const scripts = {
    xdotool: '#!/bin/sh\n[ "$DISPLAY" = ":20" ] && [ "$XAUTHORITY" = "/x/auth" ] && echo "1440 900"\n',
    // The last argument is where the picture goes.
    ffmpeg: '#!/bin/sh\nfor last; do :; done\necho "$@" > "' + join(dir, "args") + '"\ncp "' + join(dir, "shot.jpg") + '" "$last"\n',
  };
  for (const name of which) {
    writeFileSync(join(dir, name), scripts[name]);
    chmodSync(join(dir, name), 0o755);
  }
  return [dir];
}

test("an X11 display is read and captured with the computer's tools", { skip: process.platform === "win32" }, async (t) => {
  const screen = x11Screen({ display: ":20", xauthority: "/x/auth", dirs: tools(t, ["xdotool", "ffmpeg"]) });
  assert.deepEqual(await screen.displays(), [{ id: "1", label: "Display :20", width: 1440, height: 900, primary: true }]);
  const shot = await screen.capture({ display: "1", maxWidth: 641, quality: 60 });
  assert.deepEqual([shot.width, shot.height, shot.jpeg.length], [640, 400, JPEG.length]);
  await assert.rejects(screen.capture({ display: "2", maxWidth: 640 }), /That display isn't available\./);
  assert.deepEqual(await screen.permissions(), { screenRecording: true, accessibility: true });
});

test("with no capture tool, the screen says which to install", { skip: process.platform === "win32" }, async (t) => {
  const screen = x11Screen({ display: ":20", xauthority: "/x/auth", dirs: tools(t, ["xdotool"]) });
  await assert.rejects(screen.capture({ display: "1", maxWidth: 640 }), { message: NEED_CAPTURE_TOOL });
});

test("the capture commands scale to the width asked for", () => {
  const ff = captureCommand("ffmpeg", { display: ":20", screen: { width: 1440, height: 900 }, width: 720, quality: 100, file: "/o.jpg" });
  assert.deepEqual([ff[ff.indexOf("-video_size") + 1], ff[ff.indexOf("-i") + 1], ff[ff.indexOf("-vf") + 1], ff[ff.indexOf("-q:v") + 1], ff.at(-1)], ["1440x900", ":20", "scale=720:-2", "2", "/o.jpg"]);
  const im = captureCommand("import", { display: ":20", screen: { width: 1440, height: 900 }, width: 720, quality: 60, file: "/o.jpg" });
  assert.deepEqual(im.slice(-5), ["-resize", "720x", "-quality", "60", "jpg:/o.jpg"]);
});

test("the headless host shows a screen only on Linux with a DISPLAY", () => {
  assert.deepEqual(headlessHost({ env: { DISPLAY: ":20" }, platform: "linux" }).displayStatus(), { available: true, kind: "x11" });
  assert.equal(headlessHost({ env: { DISPLAY: ":20" }, platform: "darwin" }).displayStatus().available, false);
  assert.equal(headlessHost({ env: {}, platform: "linux" }).displayStatus().available, false);
  assert.equal(headlessHost({ env: { DISPLAY: "; rm -rf /" }, platform: "linux" }).displayStatus().available, false);
});
