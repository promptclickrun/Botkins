import test from "node:test";
import assert from "node:assert/strict";
import { LinkPreviews, isPrivateAddress, parsePreview } from "../desktop/linkpreview.mjs";

test("private, local and embedded-IPv4 addresses are recognized", () => {
  for (const a of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "192.0.0.8", "192.0.2.1", "198.51.100.7", "203.0.113.9", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "::ffff:192.168.0.1", "::127.0.0.1",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "not-an-ip",
  ])
    assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "93.184.216.34", "::ffff:8.8.8.8"])
    assert.equal(isPrivateAddress(a), false, a);
});

test("Open Graph tags are read with a title fallback and entity decoding", () => {
  const html = `<html><head><title>Fallback</title><meta property="og:title" content="Rates &amp; Fees"><meta name="description" content="Plain description"><meta property="og:image" content="/img.png"></head></html>`;
  assert.deepEqual(parsePreview(html, "https://www.example.com/a"), {
    url: "https://www.example.com/a",
    title: "Rates & Fees",
    description: "Plain description",
    site: "example.com",
    imageUrl: "https://www.example.com/img.png",
  });
  assert.equal(parsePreview("<title>Only title</title>", "https://x.org/").title, "Only title");
});

test("hostile markup parses quickly", () => {
  for (const unit of ["<meta ", "<title ", "<meta property='og:title' content='"]) {
    const page = unit.repeat(Math.ceil((512 * 1024) / unit.length));
    const started = performance.now();
    parsePreview(page, "https://example.com/");
    assert.ok(performance.now() - started < 500, unit + " took " + Math.round(performance.now() - started) + " ms");
  }
});

function fakePages(pages) {
  const calls = [];
  const fetchPage = async (url) => {
    calls.push(url.href);
    const page = pages[url.href];
    if (!page) return { status: 404, headers: {}, bytes: Buffer.alloc(0) };
    return { status: page.status ?? 200, location: page.location, headers: page.headers ?? { "content-type": "text/html" }, bytes: Buffer.from(page.body ?? "") };
  };
  return { fetchPage, calls };
}

test("previews follow redirects, inline small images and cache results", async () => {
  const { fetchPage, calls } = fakePages({
    "https://example.com/start": { status: 301, location: "/article" },
    "https://example.com/article": { body: '<meta property="og:title" content="Article"><meta property="og:image" content="https://example.com/i.png">' },
    "https://example.com/i.png": { body: "\x89PNG", headers: { "content-type": "image/png" } },
  });
  const previews = new LinkPreviews({ fetchPage });
  const p = await previews.preview("https://example.com/start");
  assert.equal(p.title, "Article");
  assert.equal(p.url, "https://example.com/article");
  assert.match(p.image, /^data:image\/png;base64,/);
  await previews.preview("https://example.com/start");
  assert.equal(calls.filter((c) => c.endsWith("/start")).length, 1, "the second preview comes from the cache");
});

test("private literals, local names, redirects into private hosts and non-web links get no preview", async () => {
  const { fetchPage, calls } = fakePages({
    "https://example.com/sneaky": { status: 302, location: "http://192.168.1.1/admin" },
  });
  const previews = new LinkPreviews({ fetchPage });
  for (const url of ["http://127.0.0.1:8080/", "http://[::1]/", "http://printer.local/", "http://localhost:3000/", "file:///etc/passwd", "https://user:pw@example.com/"])
    assert.equal(await previews.preview(url), null, url);
  assert.equal(await previews.preview("https://example.com/sneaky"), null);
  assert.deepEqual(calls, ["https://example.com/sneaky"], "nothing private was ever requested");
});

test("a host that resolves to a private address is refused when the connection is made", async (t) => {
  // A real local server would serve a preview; DNS answers 127.0.0.1 as a rebinding attack would.
  const { createServer } = await import("node:http");
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/html" }).end("<title>Internal admin</title>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const lookup = (_host, _opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
  assert.equal(await new LinkPreviews({ lookup }).preview(`http://rebind.example.com:${port}/`), null);
  assert.equal(hits, 0, "the private server never saw a request");
});
