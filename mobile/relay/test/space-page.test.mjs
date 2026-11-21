// The page a shared link opens (src/space-page.js.txt), run here with a small document of our own:
// it opens a sealed copy as a browser would (WebCrypto, DecompressionStream), and whatever a copy
// holds becomes text, never markup. No relay is started and nothing leaves this process.
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { MAX_SPACE_BYTES_PER_KEY, MAX_SPACES_PER_KEY, SPACE_PUTS_PER_MINUTE, admitSpace, shareIdOf, spaceBytes, spaceGoneUntil, spacePutAllowed } from "../src/shared.ts";

// ---- a document that only remembers what was made ------------------------------------------------

class Element {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, style: {}, listeners: {}, className: "", hidden: false });
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    this.removed = true;
  }
  set textContent(value) {
    this.children = [String(value)];
  }
  get textContent() {
    return this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
}
const all = (node, tag, found = []) => {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === tag) found.push(child);
    all(child, tag, found);
  }
  return found;
};

const byId = Object.fromEntries(["head", "name", "from", "grid", "cards", "state"].map((id) => [id, new Element("div")]));
const windowListeners = {};
globalThis.document = { title: "", createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), getElementById: (id) => byId[id] };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.addEventListener = (type, fn) => (windowListeners[type] ??= []).push(fn);
globalThis.__botkinsSpaceTest = {};
new Function(readFileSync(new URL("../src/space-page.js.txt", import.meta.url), "utf8"))();
const page = globalThis.__botkinsSpaceTest;

// ---- a copy, sealed as the computer seals it ----------------------------------------------------

function seal(copy, key, id) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("botkins-space-v1:" + id));
  const packed = Buffer.isBuffer(copy) ? copy : gzipSync(JSON.stringify(copy));
  return Buffer.concat([nonce, cipher.update(packed), cipher.final(), cipher.getAuthTag()]);
}
const serve = (body, status = 200) => {
  globalThis.fetch = async (url, options) => {
    serve.asked = { url, options };
    return new Response(status === 200 ? body : "Not found\n", { status });
  };
};
const look = { head: "beacon", palette: "fern" };
const copy = {
  v: 1,
  name: "Launch",
  from: "Acme",
  kind: "panels",
  updatedAt: Date.now() - 5 * 60_000,
  panels: [
    { title: "Signups", size: "wide", bot: { name: "Pip", look }, updatedAt: Date.now(), blocks: [{ type: "metric", label: "Today", value: "42" }] },
    { title: "Checklist", size: "tall", bot: { name: "Pip", look }, updatedAt: Date.now(), state: { done: ["a"] }, blocks: [{ type: "html", height: 300, page: "<b>hi</b><script>parent.x=1</script>", data: { items: ["a", "b"] } }] },
    { title: "Big", size: "small", bot: { name: "Pip", look }, updatedAt: Date.now(), blocks: [], left: "size" },
  ],
  cards: [{ kind: "idea", title: "An idea", body: "Try **this**", links: ["https://example.com/a", "javascript:alert(1)"], category: "Growth", bot: { name: "Mo", look: { head: "crumb", palette: "custom" } }, createdAt: Date.now() }],
};

test("the page opens a sealed copy with the key from the link, and says why when it can't", async () => {
  const key = randomBytes(32);
  const id = randomBytes(16).toString("base64url");
  serve(seal(copy, key, id));
  assert.deepEqual(await page.open(id, key.toString("base64url")), copy);
  assert.equal(serve.asked.url, "/v1/spaces/" + id);
  assert.equal(serve.asked.options.cache, "no-store");

  await assert.rejects(page.open(id, randomBytes(32).toString("base64url")), /This link isn't complete\. Ask for it again\./, "another key");
  serve(seal(copy, key, randomBytes(16).toString("base64url")));
  await assert.rejects(page.open(id, key.toString("base64url")), /This link isn't complete/, "a copy sealed for another id");
  serve(null, 404);
  await assert.rejects(page.open(id, key.toString("base64url")), /This space is no longer shared\./);
  serve(null, 429);
  await assert.rejects(page.open(id, key.toString("base64url")), /couldn't be loaded\. Try again in a minute\./);
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  await assert.rejects(page.open(id, key.toString("base64url")), /couldn't be loaded/);
  // A copy that unpacks to more than 32 MiB is refused before it is all in memory.
  serve(seal(gzipSync(Buffer.alloc(33 * 1024 * 1024, 0x20)), key, id));
  await assert.rejects(page.open(id, key.toString("base64url")), /too large to show here/);
  serve(seal({ v: 2 }, key, id));
  await assert.rejects(page.open(id, key.toString("base64url")), /couldn't be loaded/, "a copy of a kind this page doesn't know");
});

test("what a copy says is written as text: no markup, and only http and https links", () => {
  const box = new Element("div");
  page.markdown(
    box,
    [
      "# Title <img src=x onerror=alert(1)>",
      "<script>alert(1)</script> **bold** and `code` and *soft*",
      "[bad](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.com/x) https://example.org",
      "- [x] done <b>",
      "- [ ] todo",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | <i>2</i> |",
      "```",
      "<script>in a fence</script>",
      "```",
    ].join("\n"),
  );
  for (const tag of ["script", "img", "b", "i", "iframe"]) assert.equal(all(box, tag).length, 0, tag);
  assert.ok(box.textContent.includes("<script>alert(1)</script>"));
  assert.ok(box.textContent.includes("<img src=x onerror=alert(1)>"));
  // An address is kept as the browser reads it; a bare one is shown that way too.
  assert.deepEqual(all(box, "a").map((a) => a.href), ["https://example.com/x", "https://example.org/"]);
  assert.deepEqual(all(box, "a").map((a) => a.textContent), ["ok", "https://example.org/"]);
  const named = new Element("div");
  page.markdown(named, "[bank](https://bank.example@other.example/) https://bank.example@other.example/login");
  assert.equal(all(named, "a").length, 0, "an address with a name before the host is never a link");
  for (const a of all(box, "a")) assert.deepEqual([a.target, a.rel], ["_blank", "noopener noreferrer"]);
  assert.ok(box.textContent.includes("bad") && box.textContent.includes("data"), "a link that is refused stays as its words");
  assert.equal(all(box, "strong")[0].textContent, "bold");
  assert.deepEqual(all(box, "li").map((li) => li.className), ["done", "todo"]);
  assert.equal(all(box, "h3").length, 1, "a copy's heading sits under the page's own");
  assert.deepEqual(all(box, "td").map((td) => td.textContent), ["1", "<i>2</i>"]);
  assert.equal(all(box, "pre")[0].textContent, "<script>in a fence</script>");
  // A long line of marks does not hang it.
  const started = Date.now();
  page.markdown(new Element("div"), "*".repeat(20000) + "[".repeat(20000) + "`".repeat(20000));
  assert.ok(Date.now() - started < 2000);
});

test("a space is drawn with its panels, its cards and each bot's Botkin, and a panel's own page only in a frame", () => {
  page.draw(copy);
  assert.equal(document.title, "Launch · Botkins");
  assert.equal(byId.name.textContent, "Launch");
  assert.equal(byId.from.textContent, "Shared from Acme · Updated 5m");
  const panels = byId.grid.children;
  assert.deepEqual(panels.map((panel) => panel.className), ["panel wide", "panel tall", "panel small"]);
  assert.deepEqual(all(byId.grid, "h2").map((h) => h.textContent), ["Signups", "Checklist", "Big"]);
  assert.equal(all(panels[0], "img")[0].src, "/s/botkin/beacon-fern.webp");
  assert.ok(panels[2].textContent.includes("This panel is too large to share by link."));
  assert.ok(panels[1].textContent.includes("App"), "an app panel is marked");
  // The panel's page is never put in this page: it is handed to an empty frame with no origin.
  const frames = all(byId.grid, "iframe");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].attrs.sandbox, "allow-scripts");
  assert.equal(frames[0].src, "/s/frame");
  assert.equal(all(byId.grid, "script").length + all(byId.grid, "b").length, 0);
  const sent = [];
  frames[0].contentWindow = { postMessage: (message, target) => sent.push({ message, target }) };
  frames[0].listeners.load[0]();
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0].message, colors: undefined }, { botkins: 1, type: "init", html: copy.panels[1].blocks[0].page, data: { items: ["a", "b"] }, state: { done: ["a"] }, mode: "light", colors: undefined });
  assert.equal(sent[0].message.colors["--ink"], "#000000");

  // A card, with only its web links. A bot with its own colors wears its character's original ones.
  const card = byId.cards.children[0];
  assert.equal(all(card, "h2")[0].textContent, "An idea");
  assert.deepEqual(all(card, "a").map((a) => a.href), ["https://example.com/a"]);
  assert.equal(all(card, "img")[0].src, "/s/botkin/crumb-original.webp");
  assert.ok(card.textContent.includes("Growth"));

  // A look that is not a plain name gets no picture: nothing of a copy reaches an address.
  byId.grid.replaceChildren();
  page.draw({ ...copy, cards: [], panels: [{ title: "x", size: "huge", bot: { name: "Pip", look: { head: "../../v1/health?", palette: "fern" } }, updatedAt: 0, blocks: [{ type: "nonsense" }, null, "text"] }] });
  assert.equal(all(byId.grid, "img").length, 0);
  assert.equal(byId.grid.children[0].className, "panel small");
});

test("a view may ask to open a web page; the person presses a real link, and nothing else is listened to", () => {
  const answers = [];
  const source = { postMessage: (message) => answers.push(message) };
  const entry = { frame: new Element("iframe"), box: new Element("div"), ask: null };
  page.views.set(source, entry);
  const [listen] = windowListeners.message;

  listen({ source, data: { botkins: 1, type: "open", id: 1, url: "javascript:alert(1)" } });
  assert.deepEqual(answers.pop(), { botkins: 1, type: "result", id: 1, value: false });
  assert.equal(entry.box.children.length, 0);

  listen({ source, data: { botkins: 1, type: "open", id: 2, url: "https://example.com/page" } });
  const bar = entry.box.children[0];
  const link = all(bar, "a")[0];
  assert.deepEqual([link.href, link.target, link.rel, link.textContent], ["https://example.com/page", "_blank", "noopener noreferrer", "Open link"]);
  assert.ok(bar.textContent.includes("https://example.com/page"), "the whole address is shown");
  assert.equal(answers.length, 0, "nothing opens until the person says");
  // One question at a time: a second ask cannot take the place of the one being read. It is answered no.
  listen({ source, data: { botkins: 1, type: "open", id: 3, url: "https://example.org/" } });
  assert.deepEqual(answers.pop(), { botkins: 1, type: "result", id: 3, value: false });
  assert.equal(all(entry.box, "a")[0].href, "https://example.com/page");
  all(bar, "button")[0].listeners.click[0]();
  assert.deepEqual(answers.pop(), { botkins: 1, type: "result", id: 2, value: false });
  // An address is shown as the browser reads it, and one that reads as another site is refused.
  listen({ source, data: { botkins: 1, type: "open", id: 4, url: "https://trusted.example@evil.example/" } });
  assert.deepEqual(answers.pop(), { botkins: 1, type: "result", id: 4, value: false });
  listen({ source, data: { botkins: 1, type: "open", id: 5, url: "https://EXAMPLE.com\\path/../x" } });
  const shown = entry.box.children.find((child) => !child.removed && child !== bar);
  assert.equal(all(shown, "a")[0].href, new URL("https://EXAMPLE.com\\path/../x").href);
  assert.ok(shown.textContent.includes(all(shown, "a")[0].href), "what is shown is what opens");
  all(shown, "button")[0].listeners.click[0]();
  answers.pop();

  // Its height, within what a panel can be.
  listen({ source, data: { botkins: 1, type: "size", height: 99999 } });
  assert.equal(entry.frame.style.height, "4000px");
  // Another window's message, or one of another shape, changes nothing.
  listen({ source: {}, data: { botkins: 1, type: "size", height: 500 } });
  listen({ source, data: { type: "size", height: 500 } });
  listen({ source, data: "size" });
  assert.equal(entry.frame.style.height, "4000px");
});

test("one computer holds 100 copies, 64 MiB in all, and puts 30 a minute", () => {
  const now = 1_000_000_000_000;
  let state = null;
  for (let n = 0; n < SPACE_PUTS_PER_MINUTE; n++) state = admitSpace(state, "id" + n, now + 60_000, 100, now);
  assert.equal(Object.keys(state.live).length, 30);
  assert.equal(spaceBytes(state.live), 3000);
  assert.equal(admitSpace(state, "one-more", now + 60_000, 100, now + 59_999), null, "the 31st in a minute");
  assert.ok(admitSpace(state, "one-more", now + 60_000, 100, now + 60_000), "the next minute");
  // A hundred live copies: a new id is refused, one it already has is not, and ended copies make room.
  const live = Object.fromEntries(Array.from({ length: MAX_SPACES_PER_KEY }, (_unused, n) => ["id" + n, { until: now + (n === 0 ? 10 : 600_000), size: 100 }]));
  const full = { live, puts: { start: now - 120_000, count: 30 } };
  assert.equal(admitSpace(full, "new", now + 600_000, 100, now), null);
  assert.ok(admitSpace(full, "id5", now + 600_000, 100, now));
  assert.ok(admitSpace(full, "new", now + 600_000, 100, now + 11), "id0 ended");
  assert.equal(Object.hasOwn(admitSpace(full, "new", now + 600_000, 100, now + 11).live, "id0"), false);
  // 64 MiB in all: a copy that would take the computer over it is refused; a smaller one in its place is not.
  const big = { live: { a: { until: now + 600_000, size: MAX_SPACE_BYTES_PER_KEY - 1000 } }, puts: { start: now, count: 0 } };
  assert.equal(admitSpace(big, "b", now + 600_000, 1001, now), null);
  assert.ok(admitSpace(big, "b", now + 600_000, 1000, now));
  assert.equal(admitSpace(big, "a", now + 600_000, MAX_SPACE_BYTES_PER_KEY + 1, now), null);
  assert.equal(spaceBytes(admitSpace(big, "a", now + 600_000, 5, now).live), 5, "a copy put again counts once");
});

test("a copy must be newer than the one held and than the last time it was taken back", async () => {
  assert.equal(spacePutAllowed(null, null, 100), true);
  assert.equal(spacePutAllowed(100, null, 100), false);
  assert.equal(spacePutAllowed(100, null, 101), true);
  assert.equal(spacePutAllowed(null, 100, 100), false);
  assert.equal(spacePutAllowed(90, 100, 101), true);
  // The taken-back time is kept until no PUT that old can still be signed.
  assert.ok(spaceGoneUntil(100) >= (100 + 300) * 1000);
  // A link's id is 16 bytes of a hash of the key and the salt.
  assert.match(await shareIdOf("k".repeat(43), "s".repeat(22)), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(await shareIdOf("k".repeat(43), "s".repeat(22)), await shareIdOf("k".repeat(43), "t".repeat(22)));
});
