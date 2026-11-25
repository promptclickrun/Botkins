// Runs inside Electron on the private, changing X display created by screen-video-capture.test.mjs.
import { app, BrowserWindow, webContents } from "electron";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { electronHost } from "../../desktop/host/electron.mjs";

// Executed in a separate Chromium renderer as the peer's MediaSource player.
async function play(mimeType, packets) {
  const video = document.querySelector("video");
  const mse = new MediaSource();
  const opened = new Promise(resolve => mse.addEventListener("sourceopen", resolve, { once: true }));
  video.src = URL.createObjectURL(mse);
  await opened;
  const buffer = mse.addSourceBuffer(mimeType);
  for (const packet of packets) {
    await new Promise((resolve, reject) => {
      buffer.addEventListener("updateend", resolve, { once: true });
      buffer.onerror = () => reject(new Error("SourceBuffer rejected the encoded video"));
      buffer.appendBuffer(Uint8Array.from(atob(packet), c => c.charCodeAt(0)));
    });
  }
  mse.endOfStream();
  await video.play();
  return new Promise((resolve, reject) => {
    video.onerror = () => reject(new Error("Playback failed"));
    video.ontimeupdate = () => { if (video.currentTime > 0.1) resolve(video.videoWidth); };
  });
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const { screen } = electronHost({});
  assert.equal(typeof screen.openVideo, "function");
  const [monitor] = await screen.displays();
  const formats = [["screen.mp4", 'video/mp4; codecs="avc1.42C01F"'], ["screen-high.mp4", 'video/mp4; codecs="avc1.42C02A"'], ["screen.webm", 'video/webm; codecs="vp8"']];
  for (const [file, mimeType] of formats) {
    const cancel = new AbortController();
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(12_000)]);
    const video = await screen.openVideo({ display: monitor.id, maxWidth: 321, fps: 15, mimeTypes: [mimeType], signal });
    assert.equal(video.mimeType, mimeType);
    const [recorder] = webContents.getAllWebContents();
    assert.equal(await recorder.executeJavaScript("typeof require"), "undefined");
    const until = Date.now() + 1200;
    const parts = [];
    do {
      const data = await video.read();
      assert.ok(Buffer.isBuffer(data) && data.length && data.length <= 256 * 1024);
      parts.push(data);
    } while (Date.now() < until);
    const destroyed = once(recorder, "destroyed");
    cancel.abort();
    await assert.rejects(video.read());
    await destroyed;
    await writeFile(join(process.argv.at(-1), file), Buffer.concat(parts));
    // Chromium pauses hidden playback. The peer's window is visible only on the test's private X display.
    const peer = new BrowserWindow({ width: 320, height: 240, webPreferences: { sandbox: true } });
    const page = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob:"><video muted playsinline></video>`;
    await peer.loadURL("data:text/html," + encodeURIComponent(page));
    const packets = JSON.stringify(parts.map(part => part.toString("base64")));
    const width = await peer.webContents.executeJavaScript("(" + play + ")(" + JSON.stringify(mimeType) + "," + packets + ")", true);
    assert.ok(width >= 316 && width <= 321);
    const closed = once(peer.webContents, "destroyed");
    peer.destroy();
    await closed;
  }
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
