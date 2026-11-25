// Sandboxed preload for the recorder's private local page. Only encoded video goes to the main process.
const { contextBridge, ipcRenderer } = require("electron");

async function publish(stream, format) {
  const { width, height, fps, mimeType } = format;
  await stream.getVideoTracks()[0].applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { ideal: fps, max: fps } });
  const recorder = new MediaRecorder(stream, {
    mimeType, videoBitsPerSecond: Math.min(6_000_000, Math.max(400_000, width * height * fps * 0.12)),
    videoKeyFrameIntervalDuration: 450,
  });
  const first = Promise.withResolvers();
  let sending = Promise.resolve(), buffered = 0, published = false, ended = false;
  const failed = () => {
    if (ended) return;
    ended = true;
    if (recorder.state !== "inactive") recorder.stop();
    if (published) ipcRenderer.send("screen-recorder-ended");
    first.reject(new Error("The video encoder stopped."));
  };
  recorder.onerror = failed;
  recorder.onstop = failed;
  recorder.ondataavailable = ({ data }) => {
    if (ended || !data.size) return;
    buffered += data.size;
    if (buffered > 2 * 1024 * 1024) return failed();
    // Wait for each IPC acknowledgement before converting the next blob, preserving order and bounding IPC in flight.
    sending = sending.then(async () => {
      if (ended) return;
      const bytes = await data.arrayBuffer();
      if (ended) return;
      published = true;
      first.resolve();
      await ipcRenderer.invoke("screen-recorder-bytes", mimeType, bytes);
      buffered -= data.size;
    }).catch(failed);
  };
  recorder.start(80);
  await first.promise;
}

async function start(formats) {
  const supported = formats.filter(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType));
  if (!supported.length) throw new Error("There is no shared desktop video format.");
  const { width, height, fps } = supported[0];
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false,
    video: { displaySurface: "monitor", cursor: "always", width: { max: width }, height: { max: height }, frameRate: { ideal: fps, max: fps } },
    surfaceSwitching: "exclude", selfBrowserSurface: "exclude",
  });
  const [track] = stream.getVideoTracks();
  const stop = () => {
    stream.getTracks().forEach(t => t.stop());
    ipcRenderer.send("screen-recorder-ended");
  };
  track.onended = stop;
  const surface = track.getSettings().displaySurface;
  if (!surface || surface === "monitor") {
    // A reported codec may still lack an encoder on this computer. Try the other offered format before the first byte.
    for (const format of supported) {
      try { await publish(stream, format); return; } catch {}
    }
  }
  stop();
}

contextBridge.exposeInMainWorld("botkinsScreenRecorder", { start });
