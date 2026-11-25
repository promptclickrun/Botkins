// A continuous encoder per active viewer. Retrying a link request returns the same
// bytes. A late close/read from an old display selection cannot affect its successor.
import { Failure } from "./tools.mjs";

export const AVC_42 = 'video/mp4; codecs="avc1.42C02A"';
export const AVC_31 = 'video/mp4; codecs="avc1.42C01F"';
export const VP8 = 'video/webm; codecs="vp8"';
export const VIDEO_FORMATS = [AVC_42, AVC_31, VP8];
const MAX_BYTES = 256 * 1024;
const START_MS = 15_000;
const ended = () => new Failure("The desktop video session ended.");

export class VideoStreams {
  constructor() {
    this.viewers = new Map();
  }

  async open(owner, id, create) {
    if (typeof id !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) throw new Failure("Invalid desktop video session.");
    const previous = this.viewers.get(owner);
    if (previous?.id === id) return previous.opened;
    if (previous) this.close(owner, previous.id);
    if (this.viewers.size >= 4) throw new Failure("The computer is already streaming to four viewers.");

    const session = { id, controller: new AbortController(), seq: -1 };
    this.viewers.set(owner, session);
    this.renew(owner, session, START_MS);
    session.opened = (async () => {
      const media = await create(session.controller.signal);
      if (session.controller.signal.aborted) {
        media.close();
        throw ended();
      }
      session.media = media;
      this.renew(owner, session);
      return { mimeType: media.mimeType };
    })().catch(error => {
      this.close(owner, id);
      throw error;
    });
    return session.opened;
  }

  async read(owner, id, seq) {
    const session = this.viewers.get(owner);
    if (!session?.media || session.id !== id) throw ended();
    if (!Number.isSafeInteger(seq) || seq < 0 || (seq !== session.seq && seq !== session.seq + 1))
      throw new Failure("Invalid desktop video sequence.");
    this.renew(owner, session);
    if (seq === session.seq) return session.last;
    if (!session.reading) {
      session.reading = (async () => {
        const bytes = await session.media.read();
        if (session.controller.signal.aborted) throw ended();
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new Failure("The desktop video could not be read.");
        session.seq = seq;
        session.last = bytes.toString("base64");
        return session.last;
      })().catch(error => {
        this.close(owner, id);
        throw error;
      }).finally(() => { session.reading = null; });
    }
    return session.reading;
  }

  // The workspace also owns a timer. If its link process exits, its encoder is still reaped.
  renew(owner, session, ms = 10_000) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.close(owner, session.id), ms);
    session.timer.unref?.();
  }

  close(owner, id) {
    const session = this.viewers.get(owner);
    if (!session || (id !== undefined && session.id !== id)) return;
    this.viewers.delete(owner);
    clearTimeout(session.timer);
    session.controller.abort();
    session.media?.close();
  }

  closeAll() {
    for (const owner of this.viewers.keys()) this.close(owner);
  }
}
