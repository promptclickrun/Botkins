// The paired host sends ordered, contiguous encoded bytes. Wait for each append before pulling the next.
export const videoFormats = () => typeof MediaSource === "undefined" ? [] :
  ['video/mp4; codecs="avc1.42C02A"', 'video/mp4; codecs="avc1.42C01F"', 'video/webm; codecs="vp8"'].filter(type => MediaSource.isTypeSupported(type));

function nextEvent(target: EventTarget, name: string, signal: AbortSignal, start: () => void) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error("The desktop video could not be played.")); };
    const clean = () => {
      target.removeEventListener(name, done);
      target.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
    };
    target.addEventListener(name, done, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", failed, { once: true });
    try { start(); } catch (error) { clean(); reject(error); }
  });
}

export async function playComputerVideo(video: HTMLVideoElement, mimeType: string, read: (seq: number) => Promise<string>, close: () => Promise<void>, signal: AbortSignal, ready: () => void) {
  const media = new MediaSource();
  const url = URL.createObjectURL(media);
  const decoder = new AbortController();
  const live = AbortSignal.any([signal, decoder.signal]);
  const failed = () => { decoder.abort(); void close().catch(() => {}); };
  const startup = setTimeout(failed, 8000);
  const playing = () => { clearTimeout(startup); ready(); };
  video.addEventListener("error", failed);
  video.addEventListener("playing", playing, { once: true });
  try {
    await nextEvent(media, "sourceopen", live, () => { video.src = url; });
    const buffer = media.addSourceBuffer(mimeType);
    void video.play().catch(failed);
    for (let seq = 0; !live.aborted; seq++) {
      const base64 = await read(seq);
      live.throwIfAborted();
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
      await nextEvent(buffer, "updateend", live, () => buffer.appendBuffer(bytes));
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        const lag = end - video.currentTime;
        if (lag > 0.65) video.currentTime = end - 0.14;
        video.playbackRate = lag > 0.28 ? 1.08 : 1;
        if (video.currentTime - buffer.buffered.start(0) > 8) {
          await nextEvent(buffer, "updateend", live, () => buffer.remove(0, video.currentTime - 3));
        }
      }
    }
  } finally {
    clearTimeout(startup);
    video.removeEventListener("error", failed);
    video.removeEventListener("playing", playing);
    if (video.getAttribute("src") === url) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    URL.revokeObjectURL(url);
  }
}
