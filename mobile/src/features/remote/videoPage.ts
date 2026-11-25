// The viewer's decoder has no network access. Media arrives from the paired link.
// Ask for the next bytes only when SourceBuffer is ready to accept them.
export const VIDEO_SOURCE = {
  baseUrl: "about:blank",
  html: `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:">
<style>*{box-sizing:border-box}html,body,video{margin:0;width:100%;height:100%;overflow:hidden;background:#151515}video{display:block;object-fit:contain;pointer-events:none}</style>
</head><body><video autoplay muted playsinline disableRemotePlayback></video><script>
(() => {
  const video = document.querySelector("video");
  const Source = window.ManagedMediaSource || window.MediaSource;
  const formats = ['video/mp4; codecs="avc1.42C02A"', 'video/mp4; codecs="avc1.42C01F"', 'video/webm; codecs="vp8"'];
  const send = (type, value) => window.ReactNativeWebView.postMessage(JSON.stringify({ type, value }));
  let media, buffer, lastTrim = 0, stopped = false, live = false;
  function fail(reason) {
    if (!stopped) send("error", reason);
    stopped = true;
  }
  function readyForBytes() {
    if (stopped) return;
    try {
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        const lag = end - video.currentTime;
        // Shed old latency after a slow network interval. Leave enough video for decoding.
        if (lag > 0.65) video.currentTime = end - 0.14;
        video.playbackRate = lag > 0.28 ? 1.08 : 1;
        if (video.currentTime - lastTrim > 4) {
          lastTrim = video.currentTime;
          buffer.remove(0, lastTrim - 2);
          return; // updateend asks again after the removal
        }
      }
      send("pull");
    } catch (error) { fail("The video buffer stopped (" + error.name + ")."); }
  }
  function receive(event) {
    event.stopPropagation();
    if (stopped) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "open" && !media) {
        media = new Source();
        media.addEventListener("sourceopen", () => {
          try {
            buffer = media.addSourceBuffer(message.value);
            buffer.addEventListener("updateend", readyForBytes);
            buffer.addEventListener("error", () => fail("The decoder rejected a desktop video fragment."));
            send("pull");
          } catch (error) { fail("The desktop video format could not start (" + error.name + ")."); }
        }, { once: true });
        video.disableRemotePlayback = true;
        // WebKit accepts a MediaSource directly. This also works in a WKWebView
        // with an opaque document origin where a blob URL cannot be played.
        try { video.srcObject = media; }
        catch { video.src = URL.createObjectURL(media); }
        video.play().catch(error => fail("Video playback could not start (" + error.name + ")."));
      } else if (message.type === "bytes" && buffer) {
        const binary = atob(message.value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        buffer.appendBuffer(bytes);
      }
    } catch (error) { fail("The desktop video could not be appended (" + error.name + ")."); }
  }
  // Android dispatches native messages on document, iOS on window.
  document.addEventListener("message", receive);
  window.addEventListener("message", receive);
  video.addEventListener("error", () => fail("Desktop video playback failed (media error " + (video.error?.code || "unknown") + ")."));
  let frames = 0, lastFrames = 0, lastTime = 0;
  function presented(now, frame) {
    if (stopped) return;
    frames = frame.presentedFrames;
    if (!live || now - lastTime >= 1000) {
      send("playing", { width: video.videoWidth, height: video.videoHeight,
        fps: lastTime ? Math.round((frames - lastFrames) * 1000 / (now - lastTime)) : 0 });
      live = true;
      lastFrames = frames;
      lastTime = now;
    }
    video.requestVideoFrameCallback(presented);
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(presented);
  else video.addEventListener("playing", () => send("playing", { width: video.videoWidth, height: video.videoHeight, fps: 0 }));
  send("formats", Source ? formats.filter(format => Source.isTypeSupported(format)) : []);
})();
</script></body></html>`,
};
