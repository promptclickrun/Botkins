// Html blocks in Today panels and chat cards: pages kept as frames (desktop/frames.mjs).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { FRAME_CSP, framePage } from "../desktop/frames.mjs";
import { VIEW_GUARD, guardedPage, unshadow } from "../desktop/view-guard.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

function setup(t) {
  const dir = tempDir(t);
  const ws = new Workspace(dir, fakeClient().client, () => {});
  const files = () => (existsSync(join(dir, "frames")) ? readdirSync(join(dir, "frames")).sort() : []);
  return { dir, ws, files };
}
const PAGE = "<h1 id=t>Sales</h1><script>commander.getData().then((d) => (t.textContent = d.title))</script>";

test("a panel's html block is stored as a frame, out of the workspace file and the page's state", (t) => {
  const { ws, dir, files } = setup(t);
  ws.panels.write("pip", "c", {
    key: "sales",
    title: "Sales",
    blocks: [
      { type: "metric", label: "Total", value: "42" },
      { type: "html", html: PAGE, data: { title: "Q3", points: [1, 2, 3] }, height: 5000 },
    ],
  });
  const panel = ws.state.panels[0];
  const block = panel.blocks[1];
  assert.deepEqual(Object.keys(block).sort(), ["frame", "height", "type"]);
  assert.equal(block.height, 1200, "the height is kept within bounds");
  assert.match(block.frame, /^[0-9a-f-]{36}$/);
  assert.deepEqual(ws.state.frames.map((f) => [f.owner, f.botId]), [["panel:" + panel.id, "pip"]]);
  assert.deepEqual(files(), [block.frame + ".html", block.frame + ".json"]);
  for (const text of [readFileSync(join(dir, "workspace.json"), "utf8"), JSON.stringify(ws.snapshot())])
    assert.doesNotMatch(text, /Sales<\/h1>|points/, "the page and its data stay out");
  assert.equal(ws.frames.html(block.frame), PAGE);
  assert.deepEqual(ws.frames.data(block.frame), { title: "Q3", points: [1, 2, 3] });
  // The bot reads its panel back: data in full, the page itself only when it is short or asked for.
  const read = ws.panels.readable(panel);
  assert.deepEqual(read.blocks[1], { type: "html", height: 1200, data: { title: "Q3", points: [1, 2, 3] }, html: PAGE });
  ws.panels.write("pip", "c", { key: "big", title: "Big", blocks: [{ type: "html", html: "<p>" + "x".repeat(3000) + "</p>" }] });
  const big = ws.panels.readable(ws.state.panels[1]).blocks[0];
  assert.deepEqual([big.html, big.html_start.length, big.html_characters], [undefined, 1200, 3007]);
  assert.equal(ws.panels.readable(ws.state.panels[1], true).blocks[0].html.length, 3007);
});

test("updating a panel replaces its frames, and a block without a page keeps the page with new data", (t) => {
  const { ws, files } = setup(t);
  const publish = (blocks, revision) => ws.panels.write("pip", "c", { key: "k", title: "T", blocks, revision });
  publish([{ type: "html", html: PAGE, data: { title: "one" } }]);
  const first = ws.state.panels[0].blocks[0].frame;
  // Only data: the page stays, a new frame holds it with the new data, and the old frame is gone.
  publish([{ type: "html", data: { title: "two" } }], 1);
  const second = ws.state.panels[0].blocks[0].frame;
  assert.notEqual(second, first);
  assert.equal(ws.frames.html(second), PAGE);
  assert.deepEqual(ws.frames.data(second), { title: "two" });
  assert.deepEqual(files(), [second + ".html", second + ".json"]);
  assert.throws(() => ws.frames.html(first), /no longer exists/);
  // Nothing sent for the block at all: the same frame stays.
  publish([{ type: "html" }, { type: "metric", label: "A", value: "1" }], 2);
  assert.equal(ws.state.panels[0].blocks[0].frame, second);
  // A new page replaces it.
  publish([{ type: "html", html: "<p>new</p>" }], 3);
  const third = ws.state.panels[0].blocks[0].frame;
  assert.equal(ws.frames.html(third), "<p>new</p>");
  assert.equal(ws.frames.data(third), null);
  assert.deepEqual(files(), [third + ".html", third + ".json"]);
  // A refused write stores nothing.
  assert.throws(() => publish([{ type: "html", html: "<p>x</p>" }, { type: "metric", label: "", value: "1" }], 4), /Invalid label/);
  assert.throws(() => publish([{ type: "html", html: "<p>x</p>" }], 1), /Panel changed/);
  assert.throws(() => publish([{ type: "html", html: "  " }], 4), /needs its page/);
  assert.throws(() => publish([{ type: "html", html: "x".repeat(300001) }], 4), /under 300,000 characters/);
  assert.throws(() => publish([{ type: "html", html: "<p>x</p>", data: "y".repeat(200001) }], 4), /data under 200,000/);
  assert.throws(() => publish([1, 2, 3].map(() => ({ type: "html", html: "<p>x</p>" })), 4), /at most two html blocks/);
  assert.deepEqual(files(), [third + ".html", third + ".json"]);
  assert.throws(() => ws.panels.write("pip", "c", { key: "fresh", title: "T", blocks: [{ type: "html", data: {} }] }), /An html block needs its page/);
  ws.panels.write("pip", "c", { key: "plain", title: "T", blocks: [{ type: "metric", label: "A", value: "1" }] });
  assert.throws(() => ws.panels.write("pip", "c", { key: "plain", title: "T", revision: 1, blocks: [{ type: "html", data: {} }] }), /has no html block to keep/);
  ws.panels.change(ws.state.panels[1].id, "delete");
  // Removing the panel removes its frames.
  ws.panels.change(ws.state.panels[0].id, "delete");
  assert.deepEqual(files(), []);
  assert.deepEqual(ws.state.frames, []);
});

test("the page a frame loads has the bridge and its data first, safely", () => {
  const page = framePage("<p>Hi</p>", { text: "</script><script>alert(1)</script>", line: "a b" });
  assert.match(page, /^<!doctype html><html><head><meta charset="utf-8"><style>/);
  assert.ok(page.indexOf("window, \"botkins\"") > 0 && page.indexOf("window, \"botkins\"") < page.indexOf("<p>Hi</p>"), "the bridge runs before the page");
  // Pages written when the app was called Commander, or for Bighelp, find the same bridge under those names.
  for (const name of ["commander", "bighelp"]) assert.ok(page.includes("Object.defineProperty(window, \"" + name + "\", { value: window.botkins })"), name);
  assert.equal(page.split("</script>").length - 1, 1, "data can't end the bridge's script");
  assert.match(page, /\\u003c\/script\\u003e\\u003cscript\\u003ealert\(1\)/);
  assert.match(page, /a\\u2028b/);
  // A whole document keeps its doctype and gets the bridge at the start of its head.
  const full = framePage("<!DOCTYPE html><html lang=en><head><title>T</title></head><body>x</body></html>", null);
  assert.match(full, /^<!DOCTYPE html><html lang=en><head><meta charset="utf-8"><style>/);
  assert.match(full, /const data = null;/);
  assert.match(framePage("<html><body>x</body></html>", 1), /^<html><meta charset/);
  // What the frame may do: its own inline code, nothing from anywhere, sandboxed with scripts only.
  assert.match(FRAME_CSP, /default-src 'none'/);
  assert.match(FRAME_CSP, /connect-src 'none'/);
  assert.match(FRAME_CSP, /sandbox allow-scripts$/);
  assert.doesNotMatch(FRAME_CSP, /allow-same-origin|https?:/);
});

test("a card's html block belongs to its chat, and answers go to the right chat", async (t) => {
  const dir = tempDir(t);
  const fake = fakeClient(async (_id, _options, session) => {
    const names = session.toolNames();
    if (names.includes("render_card")) await session.tool("render_card", { title: "Chart", blocks: [{ type: "html", html: PAGE, data: { title: "card" } }] });
    return { data: { content: "done" } };
  });
  const ws = new Workspace(dir, fake.client, () => {});
  const chat = ws.createChat("pip");
  await ws.send(chat, "show a chart");
  const card = ws.state.runs[0].cards[0];
  const frame = card.blocks[0].frame;
  assert.deepEqual(ws.state.frames.map((f) => f.owner), ["chat:" + chat]);
  assert.equal(ws.frames.chatFor(frame), chat);
  // A panel's frame answers into the chat the panel was made in; when that is gone, a new chat with its bot.
  ws.panels.write("scout", chat, { key: "p", title: "P", blocks: [{ type: "html", html: "<p>p</p>" }] });
  const panelFrame = ws.state.panels[0].blocks[0].frame;
  assert.equal(ws.frames.chatFor(panelFrame), chat);
  await ws.agents.deleteChat(chat);
  assert.throws(() => ws.frames.html(frame), /no longer exists/, "the card's frame went with its chat");
  const made = ws.frames.chatFor(panelFrame);
  assert.equal(ws.chat(made).botId, "scout");
  assert.throws(() => ws.frames.get("../../etc/passwd"), /no longer exists/);
  // Deleting a bot removes its panels' frames.
  await ws.agents.deleteBot("scout");
  assert.deepEqual(ws.state.frames, []);
  assert.deepEqual(existsSync(join(dir, "frames")) ? readdirSync(join(dir, "frames")) : [], []);
});

test("a refused card stores no page, and a panel's answers keep going to one chat", async (t) => {
  const dir = tempDir(t);
  let outcome;
  const fake = fakeClient(async (_id, _options, session) => {
    if (session.toolNames().includes("render_card")) {
      try {
        await session.tool("render_card", { title: "Chart", blocks: [{ type: "html", html: PAGE }], replies: ["1", "2", "3", "4", "5", "6", "7"] });
      } catch (error) {
        outcome = error.message;
      }
    }
    return { data: { content: "done" } };
  });
  const ws = new Workspace(dir, fake.client, () => {});
  const chat = ws.createChat("pip");
  await ws.send(chat, "show a chart");
  assert.match(outcome, /Invalid replies/);
  assert.deepEqual(ws.state.frames, [], "the page of a card that was refused isn't kept");
  assert.deepEqual(existsSync(join(dir, "frames")) ? readdirSync(join(dir, "frames")) : [], []);
  // A panel whose first chat is gone gets one new chat, once.
  ws.panels.write("scout", "gone-chat", { key: "p", title: "P", blocks: [{ type: "html", html: "<p>p</p>" }] });
  const frame = ws.state.panels[0].blocks[0].frame;
  const first = ws.frames.chatFor(frame);
  assert.equal(ws.frames.chatFor(frame), first);
  assert.equal(ws.frames.chatFor(frame), first);
  assert.equal(ws.state.chats.filter((c) => c.botId === "scout").length, 1);
  assert.equal(ws.state.panels[0].chatId, first);
});

test("a bot's page is served with the guard first, whatever its markup begins with", (t) => {
  // The guard takes away the ways to open a peer-to-peer connection, and keeps frames out of the page.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport"]) assert.ok(VIEW_GUARD.includes('"' + name + '"'), name);
  assert.ok(VIEW_GUARD.includes('"iframe,frame,object,embed,portal,fencedframe"'));
  assert.ok(!/<\/script/i.test(VIEW_GUARD), "the guard cannot end its own script");
  assert.doesNotThrow(() => new Function(VIEW_GUARD), "the guard is one whole piece of code");
  // It stands at the very start of the document, in a script of its own, before the bridge and the page.
  const early = "<script>window.first = 1</script><html><head><title>T</title></head><body><p>Hi</p></body></html>";
  const served = guardedPage(framePage(unshadow(early), null));
  assert.ok(served.startsWith("<!doctype html><script>" + VIEW_GUARD + "</script>"));
  assert.ok(served.indexOf(VIEW_GUARD) < served.indexOf("window.first = 1"), "a script the page puts before its head still runs after the guard");
  assert.ok(served.indexOf("window.first = 1") > 0 && served.indexOf('window, "botkins"') > 0);
  // Markup that would make a shadow root as the page is read is unnamed, in any spelling.
  assert.equal(unshadow('<template shadowrootmode="open"><iframe></iframe></template><div ShadowRootMode=closed>'), '<template data-no-shadowrootmode="open"><iframe></iframe></template><div data-no-shadowrootMode=closed>'.replace("data-no-shadowrootMode", "data-no-shadowroot" + "Mode"));
  assert.equal(unshadow("<p>Plain</p>"), "<p>Plain</p>");
  // What the workspace serves for a frame is the guarded page.
  const { ws } = setup(t);
  const chat = ws.createChat("pip");
  const id = ws.frames.create("chat:" + chat, "pip", { html: '<template shadowrootmode="open"><b>x</b></template><p>Mine</p>', json: JSON.stringify({ n: 1 }) });
  const page = ws.frames.page(id);
  assert.ok(page.startsWith("<!doctype html><script>" + VIEW_GUARD + "</script>"));
  assert.ok(page.includes("<p>Mine</p>") && page.includes("data-no-shadowrootmode") && !/<template shadowrootmode/i.test(page));
  assert.equal(ws.frames.html(id).includes("<template shadowrootmode"), true, "the page as the bot wrote it is kept as it is");
});
