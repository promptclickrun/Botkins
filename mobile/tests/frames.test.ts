// Custom views (html blocks): the document the phone's web view loads and what a page may say back
// (src/ui/frame.ts), and the link's call that hands the phone a view's page (link-host/server.mjs).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { ChatDetail, Meta } from "../src/link/types";
import { AnswerPace, FRAME_CSP, allowsLoad, clampHeight, frameColors, framePage, frameScript, inlineJson, readFrameMessage } from "../src/ui/frame";

const theme = { mode: "dark" as const, colors: frameColors({ ink: "#ffffff", muted: "#aaaaaa", surface: "#111111", sunken: "#000000", accent: "#ef9e78", line: "#333333" }) };

test("the policy and the bridge come before anything the bot wrote", () => {
  const page = framePage('<head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><p id="x">hi</p><script>fetch("https://example.com")</script>', { n: 1 }, theme);
  const policy = page.indexOf('<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">');
  const bridge = page.indexOf("window.ReactNativeWebView.postMessage");
  const theirs = page.indexOf('<p id="x">');
  assert.ok(policy > 0 && bridge > policy && theirs > bridge, "policy, then bridge, then the bot's page");
  assert.ok(page.startsWith("<!doctype html><html><head>"));
  // A second policy can only take more away, so the bot's own can't open the network again.
  assert.match(FRAME_CSP, /default-src 'none'/);
  assert.match(FRAME_CSP, /connect-src 'none'/);
  assert.match(FRAME_CSP, /form-action 'none'/);
  assert.match(FRAME_CSP, /frame-src 'none'/);
  assert.doesNotMatch(FRAME_CSP, /https?:|\*/);
});

test("the page gets its data, the theme's colors and the same bridge names as on the computer", () => {
  const page = framePage("<p>hi</p>", { title: "T", items: [1, 2] }, theme);
  assert.ok(page.includes('const data = {"title":"T","items":[1,2]};'));
  assert.ok(page.includes('let mode = "dark";'));
  assert.ok(page.includes("color-scheme:dark;--ink:#ffffff;"));
  assert.ok(page.includes("--accent:#ef9e78"));
  for (const name of ['"botkins"', '"commander"', '"bighelp"', "getData", "onData", "sendAnswer", "sendMessage", "openLink", "onTheme"]) assert.ok(page.includes(name), name);
  // In a card the chat scrolls, not the view; full screen the page scrolls by itself.
  assert.ok(page.includes("html{overflow:hidden}"));
  assert.ok(!framePage("<p>hi</p>", null, theme, { fill: true }).includes("html{overflow:hidden}"));
});

test("data can't end the script it is written into", () => {
  const nasty = { text: "</script><script>alert(1)</script><!-- &amp; " + String.fromCharCode(0x2028) };
  const json = inlineJson(nasty);
  assert.ok(!json.includes("<") && !json.includes(">") && !json.includes("&") && !json.includes(String.fromCharCode(0x2028)));
  assert.deepEqual(JSON.parse(json), nasty);
  const page = framePage("<p>hi</p>", nasty, theme);
  assert.equal(page.split("</script>").length, 2, "only the bridge's own script ends");
  // A color that isn't a color is left out of the style.
  const odd = framePage("<p>hi</p>", null, { mode: "light", colors: { "--ink": "red;}</style><script>x()</script>", "--muted": "#123456" } });
  assert.ok(!odd.includes("x()") && odd.includes("--muted:#123456"));
});

test("only the few things a page may say are read", () => {
  const say = (value: unknown) => readFrameMessage(typeof value === "string" ? value : JSON.stringify(value));
  assert.deepEqual(say({ botkins: 1, type: "ready" }), { type: "ready" });
  assert.deepEqual(say({ botkins: 1, type: "size", height: 321.4 }), { type: "size", height: 321.4 });
  assert.deepEqual(say({ botkins: 1, type: "answer", id: 3, text: "Tell me more" }), { type: "answer", id: 3, text: "Tell me more" });
  assert.deepEqual(say({ botkins: 1, type: "open", id: 4, url: "https://example.com/a?b=1" }), { type: "open", id: 4, url: "https://example.com/a?b=1" });
  assert.equal(say({ botkins: 1, type: "answer", id: 5, text: "x".repeat(9000) })?.type === "answer" && (say({ botkins: 1, type: "answer", id: 5, text: "x".repeat(9000) }) as { text: string }).text.length, 4000);
  for (const bad of [
    "not json",
    { type: "ready" },
    { botkins: 1, type: "size", height: "tall" },
    { botkins: 1, type: "answer", text: "no id" },
    { botkins: 1, type: "navigate", id: 1, url: "https://example.com" },
    JSON.stringify({ botkins: 1, type: "answer", id: 1, text: "x".repeat(30_000) }),
  ])
    assert.equal(say(bad), null, JSON.stringify(bad).slice(0, 60));
  assert.equal(readFrameMessage(42), null);
  // A request the page may make, but not like this, is told no (so its promise ends).
  for (const refused of [
    { botkins: 1, type: "answer", id: 1, text: "   " },
    { botkins: 1, type: "open", id: 1, url: "javascript:alert(1)" },
    { botkins: 1, type: "open", id: 1, url: "botkins://pair?x=1" },
    { botkins: 1, type: "open", id: 1, url: "file:///etc/passwd" },
    { botkins: 1, type: "open", id: 1, url: "https://" },
  ])
    assert.deepEqual(say(refused), { type: "refused", id: 1 }, JSON.stringify(refused));
  assert.deepEqual(say({ botkins: 1, type: "error", message: "x".repeat(500) }), { type: "error", message: "x".repeat(200) });
});

test("a view's web view goes nowhere but its own blank page", () => {
  assert.equal(allowsLoad("about:blank", true), true);
  for (const url of ["https://example.com/?secret=1", "http://10.0.0.1/", "about:srcdoc", "file:///etc/hosts", "botkins://x", "tel:123", "data:text/html,hi", "javascript:1"]) assert.equal(allowsLoad(url, true), false, url);
  assert.equal(allowsLoad("about:blank", false), false, "no frames inside a view");
});

test("heights stay within a card, and answers are paced", () => {
  assert.equal(clampHeight(10, 160), 48);
  assert.equal(clampHeight(99999, 160), 4000);
  assert.equal(clampHeight(Number.NaN, 160), 160);
  assert.equal(clampHeight("300", 200), 200);
  const pace = new AnswerPace();
  assert.equal(pace.allow("a", 1000), true);
  assert.equal(pace.allow("a", 3000), false, "one answer every five seconds from a view");
  assert.equal(pace.allow("a", 6100), true);
  for (const [i, id] of ["b", "c", "d", "e"].entries()) assert.equal(pace.allow(id, 7000 + i), true);
  assert.equal(pace.allow("g", 8000), false, "six a minute from all views");
  assert.equal(pace.allow("g", 70_000), true);
});

test("what the app tells a page is written safely", () => {
  const script = frameScript({ type: "result", id: 2, error: "</script> didn't work" });
  assert.ok(script.startsWith("try{window.__botkinsIn(") && script.endsWith("true;"));
  assert.ok(!script.includes("</script>"));
});

test("the computer hands a phone a view's page, and only a view it has", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: mkdtempSync(join(tmpdir(), "botkins-frames-")), backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const paired = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const parts: Record<string, unknown> = {};
  const client = new LinkClient(paired, { fetch: fetch as unknown as FetchLike, onParts: (next) => void Object.assign(parts, next), onState: () => {} });
  client.start();
  const until = async (check: () => boolean, what: string) => {
    const end = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
  await until(() => !!parts.meta, "the first state");
  assert.ok((parts.meta as Meta).capabilities.includes("frames-v1"));

  const chatId = await client.call<string>("createChat", "bot-mira");
  client.watch([chatId]);
  await client.call("send", chatId, "Show me a chart");
  await until(() => !!(parts["chat:" + chatId] as ChatDetail | undefined)?.runs.some((run) => run.cards?.length), "the card");
  const card = (parts["chat:" + chatId] as ChatDetail).runs.flatMap((run) => run.cards ?? [])[0];
  const block = card.blocks.find((b) => b.type === "html");
  assert.ok(block && block.type === "html");
  // The state a phone follows carries the view's id and height, never its page.
  assert.deepEqual(Object.keys(block).sort(), ["frame", "height", "type"]);
  assert.ok(!JSON.stringify(parts).includes("botkins.getData"));

  const page = await client.call<{ html: string; data: { title: string } }>("link.frame.page", block.frame);
  assert.match(page.html, /botkins\.getData\(\)/);
  assert.equal(page.data.title, "Open issues by repo");
  assert.deepEqual(await client.call("link.frame.chat", block.frame), { chatId });

  await assert.rejects(client.call("link.frame.page", "00000000-0000-0000-0000-000000000000"), /no longer exists/);
  await assert.rejects(client.call("link.frame.page", "../../etc/passwd"), /no longer exists/);
  await assert.rejects(client.call("link.frame.page", { toString: () => "x" }), /no longer exists/);

  // A page or data over the limits is not sent.
  backend.pages.set("11111111-1111-1111-1111-111111111111", { html: "x".repeat(300_001), data: null, chatId });
  await assert.rejects(client.call("link.frame.page", "11111111-1111-1111-1111-111111111111"), /too large/);
  client.stop();
  await link.stop();
});

test("a computer without custom views says so", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  delete (backend as { frames?: unknown }).frames;
  const link = new LinkHost({ relay: false, dir: mkdtempSync(join(tmpdir(), "botkins-frames-")), backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  assert.ok(!link.meta().capabilities.includes("frames-v1"));
  const paired = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const client = new LinkClient(paired, { fetch: fetch as unknown as FetchLike, onParts: () => {}, onState: () => {} });
  await assert.rejects(client.call("link.frame.page", "00000000-0000-0000-0000-000000000000"), /Update the app on your computer/);
  client.stop();
  await link.stop();
});
