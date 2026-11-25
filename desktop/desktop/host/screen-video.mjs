import { AVC_31 } from "../link/video.mjs";
import { Failure } from "../link/tools.mjs";

// The advertised AVC level must cover both the encoded dimensions and the macroblocks per second.
export function videoLimits(mimeType, maxWidth, fps) {
  const level31 = mimeType === AVC_31;
  const long = level31 ? 1280 : 1920;
  const short = level31 ? 720 : 1080;
  const width = Math.min(long, Math.max(2, Math.floor(maxWidth) || long));
  return { long, short, width, fps: Math.min(level31 ? 30 : 60, Math.max(1, Math.round(fps) || 24)) };
}

const READ_BYTES = 256 * 1024;
const QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_LAG = 3000;

/** One continuous byte stream. A full queue must end the stream since skipping bytes corrupts the decoder. */
export class ScreenVideo {
  constructor(signal, dispose) {
    signal?.throwIfAborted();
    this.signal = signal;
    this.dispose = dispose;
    this.parts = [];
    this.size = 0;
    this.error = null;
    this.reader = null;
    this.opening = Promise.withResolvers();
    this.abort = () => this.close();
    signal?.addEventListener("abort", this.abort, { once: true });
    this.startup = setTimeout(() => this.close(new Failure("The desktop video encoder didn't start.")), 12_000);
  }

  push(mimeType, bytes) {
    if (this.error || !bytes.length) return;
    const now = performance.now();
    if (this.size + bytes.length > QUEUE_BYTES || (this.parts.length && now - this.parts[0].at > MAX_LAG)) {
      this.close(new Failure("The screen video fell behind."));
      return;
    }
    this.parts.push({ bytes, at: now });
    this.size += bytes.length;
    if (this.startup) {
      clearTimeout(this.startup);
      this.startup = null;
      this.opening.resolve({ mimeType, read: () => this.read(), close: () => this.close() });
    }
    if (this.reader) {
      this.reader.resolve(this.take());
      this.reader = null;
    }
  }

  take() {
    const length = Math.min(this.size, READ_BYTES);
    const chunks = [];
    for (let left = length; left > 0;) {
      const head = this.parts[0];
      const n = Math.min(head.bytes.length, left);
      chunks.push(head.bytes.subarray(0, n));
      if (n === head.bytes.length) this.parts.shift();
      else head.bytes = head.bytes.subarray(n);
      left -= n;
    }
    this.size -= length;
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }

  async read() {
    if (this.parts.length && performance.now() - this.parts[0].at > MAX_LAG) this.close(new Failure("The screen video fell behind."));
    if (this.error) throw this.error;
    if (this.size) return this.take();
    if (this.reader) throw new Failure("A screen video read is already waiting.");
    this.reader = Promise.withResolvers();
    return this.reader.promise;
  }

  close(reason = new Failure("Screen video stopped.")) {
    if (this.error) return;
    this.error = reason;
    clearTimeout(this.startup);
    this.signal?.removeEventListener("abort", this.abort);
    this.parts = [];
    this.size = 0;
    this.opening.reject(reason);
    this.reader?.reject(reason);
    this.reader = null;
    this.dispose();
  }
}
