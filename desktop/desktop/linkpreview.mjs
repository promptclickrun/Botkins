// Link previews: title, description, site and a small image for the first visible link in a reply.
// Like Bighelp, private and local-network hosts are never fetched. The address is checked when the
// connection is made, so a DNS answer that changes between checks can't reach a private host.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const MAX_PAGE = 512 * 1024;
const SCAN = 64 * 1024; // only the start of a page is parsed
const MAX_IMAGE = 300 * 1024;
const TIMEOUT = 6000;
const FAILURE_TTL = 5 * 60 * 1000;

function ipv4Private(p) {
  const [a, b, c] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
function expand6(address) {
  let a = address.toLowerCase().split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    a = a.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.map((g) => parseInt(g || "0", 16));
}
/** True for loopback, private, link-local, shared, test, multicast and other non-public addresses, including IPv4 embedded in IPv6. */
export function isPrivateAddress(address) {
  if (isIP(address) === 4) return ipv4Private(address.split(".").map(Number));
  if (isIP(address) !== 6) return true;
  const g = expand6(address);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true;
  const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4Private(v4); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39|apos|#x27);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", "#x27": "'" })[e] ?? m);
/** Reads a page's preview fields. Patterns are bounded so hostile markup can't make parsing slow. */
export function parsePreview(page, url) {
  const html = page.slice(0, SCAN);
  const tags = new Map();
  for (const [tag] of html.matchAll(/<meta\s[^<>]{0,2000}>/gi)) {
    const key = /(?:property|name)\s*=\s*["']([^"'<>]{1,80})["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"'<>]{0,2000})["']/i.exec(tag)?.[1];
    if (key && content?.trim() && !tags.has(key)) tags.set(key, decode(content.trim()));
  }
  const first = (...keys) => keys.map((k) => tags.get(k)).find(Boolean);
  const title = first("og:title", "twitter:title") ?? decode(/<title[^<>]{0,200}>([^<]{0,500})<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  const image = first("og:image", "og:image:url", "twitter:image");
  let imageUrl;
  try {
    imageUrl = image ? new URL(image, url).href : undefined;
  } catch {}
  return {
    url,
    title: title.slice(0, 200),
    description: (first("og:description", "twitter:description", "description") ?? "").slice(0, 400),
    site: (first("og:site_name") ?? new URL(url).hostname.replace(/^www\./, "")).slice(0, 80),
    imageUrl,
  };
}

/** A DNS lookup that refuses private answers; used when the connection is made. */
function publicLookup(lookup) {
  return (host, options, callback) =>
    lookup(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
      if (!list.length || list.some((a) => isPrivateAddress(a.address)))
        return callback(new Error("Private and local addresses don't get previews."));
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
}

/** GET with no redirects followed, a size cap and a timeout; the connection only reaches public addresses. */
function request(url, accept, max, lookup) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      {
        lookup: publicLookup(lookup),
        timeout: TIMEOUT,
        headers: { accept, "user-agent": "Mozilla/5.0 (compatible; BotkinsPreview/1.0)", "accept-encoding": "identity" },
      },
      (res) => {
        const done = (value) => {
          res.destroy();
          resolve(value);
        };
        if (res.statusCode >= 300 && res.statusCode < 400) return done({ status: res.statusCode, location: res.headers.location, headers: res.headers, bytes: Buffer.alloc(0) });
        if (res.statusCode !== 200) return done({ status: res.statusCode, headers: res.headers, bytes: Buffer.alloc(0) });
        if (Number(res.headers["content-length"] ?? 0) > max) return done({ status: 413, headers: res.headers, bytes: Buffer.alloc(0) });
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= max) done({ status: 200, headers: res.headers, bytes: Buffer.concat(chunks).subarray(0, max) });
        });
        res.on("end", () => resolve({ status: 200, headers: res.headers, bytes: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The page took too long.")));
    req.on("error", reject);
  });
}

export class LinkPreviews {
  constructor({ lookup = dnsLookup, fetchPage = request } = {}) {
    this.lookup = lookup;
    this.fetchPage = fetchPage;
    this.cache = new Map(); // url → {value, expires}
  }
  check(raw) {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only web links have previews.");
    if (url.username || url.password) throw new Error("Links with credentials don't get previews.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host)) throw new Error("Private and local addresses don't get previews.");
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) throw new Error("Local names don't get previews.");
    return url;
  }
  async get(raw, accept, max) {
    let url = this.check(raw);
    for (let hop = 0; hop < 4; hop++) {
      const res = await this.fetchPage(url, accept, max, this.lookup);
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = this.check(new URL(res.location, url).href);
        continue;
      }
      if (res.status !== 200) throw new Error("The page answered " + res.status + ".");
      return { ...res, url: url.href };
    }
    throw new Error("Too many redirects.");
  }
  /** A preview for a public web page, or null. Failures are remembered for a few minutes. */
  async preview(url) {
    const hit = this.cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = (async () => {
      try {
        const page = await this.get(url, "text/html,application/xhtml+xml", MAX_PAGE);
        if (!/html/i.test(String(page.headers["content-type"] ?? ""))) return null;
        const preview = parsePreview(page.bytes.toString("utf8"), page.url);
        if (!preview.title) return null;
        if (preview.imageUrl) {
          try {
            const image = await this.get(preview.imageUrl, "image/*", MAX_IMAGE);
            const type = String(image.headers["content-type"] ?? "");
            if (/^image\/(png|jpeg|gif|webp)/.test(type) && image.bytes.length < MAX_IMAGE)
              preview.image = "data:" + type.split(";")[0] + ";base64," + image.bytes.toString("base64");
          } catch {}
        }
        delete preview.imageUrl;
        return preview;
      } catch {
        return null;
      }
    })();
    this.cache.set(url, { value, expires: Date.now() + 24 * 3600 * 1000 });
    value.then((v) => v === null && this.cache.set(url, { value, expires: Date.now() + FAILURE_TTL }));
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}
