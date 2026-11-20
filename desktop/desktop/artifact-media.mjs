// Byte-range media served only to the app's own renderer. The URL is an opaque
// short-lived handle, so a path in bot-authored HTML confers no file access.
import { randomUUID } from "node:crypto";

function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start
    ? { start, end, partial: true } : null;
}

export class ArtifactMedia {
  constructor(scheme) { this.scheme = scheme; this.entries = new Map(); }
  add(mime, size, read) {
    if (!/^(audio|video)\/[a-z0-9.+-]+$/i.test(mime) || !Number.isSafeInteger(size) || size < 0) throw new Error("This file cannot be played.");
    while (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value);
    const url = this.scheme + "://media-" + randomUUID() + "/";
    this.entries.set(url, { mime, size, read });
    return url;
  }
  close(url) { this.entries.delete(url); }
  response(request) {
    const item = this.entries.get(request.url);
    if (!item || !["HEAD", "GET"].includes(request.method)) return new Response(null, { status: 404 });
    const range = byteRange(request.headers.get("Range"), item.size);
    if (!range) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + item.size } });
    const { start, end, partial } = range;
    const headers = {
      "Content-Type": item.mime, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      ...(partial && { "Content-Range": "bytes " + start + "-" + end + "/" + item.size }),
    };
    let offset = start;
    const entries = this.entries;
    const body = request.method === "HEAD" ? null : new ReadableStream({
      async pull(controller) {
        if (offset > end) { controller.close(); return; }
        if (request.signal.aborted || !entries.has(request.url)) throw new Error("This preview was closed.");
        const length = Math.min(512 * 1024, end - offset + 1);
        const reply = await item.read(offset, length);
        const bytes = Buffer.from(reply.data, "base64");
        if (reply.offset !== offset || !bytes.length || bytes.length > length || reply.artifact.size !== item.size) throw new Error("The file changed. Open the preview again.");
        offset += bytes.length;
        controller.enqueue(bytes);
      },
    });
    return new Response(body, { headers, status: partial ? 206 : 200 });
  }
}
