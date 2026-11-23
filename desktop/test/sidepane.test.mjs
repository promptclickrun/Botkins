// The chat's side pane as a bot uses it (desktop/sidepane.mjs): the tools, the tabs they make,
// what the person does with them, and the rules a bot can't get around. Names are looked up by a
// stand-in, so nothing here reaches a network.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { MAX_PANELS, SIDE_PANE, localNetworkLiteral, tableFields, webAddress } from "../desktop/sidepane.mjs";
import { VIEWER_PARTITION, attachViewer, guardGuest, guardViewerSession, viewable } from "../desktop/webviewer.mjs";

const PAGE = "<h1>Pipeline</h1><script>document.title = String(window.botkins.getData())</script>";
const ADDRESSES = { "example.com": ["93.184.216.34"], "www.example.com": ["93.184.216.34"], "printer.home": ["192.168.1.20"], "dev.test": ["127.0.0.1"], "mixed.test": ["93.184.216.34", "10.0.0.5"] };
const resolve = async (host) => {
  if (!ADDRESSES[host]) throw new Error("ENOTFOUND");
  return ADDRESSES[host].map((address) => ({ address }));
};

/** A workspace with a chat in a turn, and that turn's side pane tools by name. */
function rig(t) {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { sidePane: { resolve } });
  const chat = ws.chat(ws.createChat("pip"));
  const turn = (bot = "pip", view = chat, more = {}) => {
    const task = { stopped: false };
    ws.active.set(chat.id, task);
    const run = { id: "run-" + (ws.state.runs.length + 1), chatId: chat.id, status: "Working", ...more };
    ws.state.runs.push(run);
    const tools = Object.fromEntries(ws.sidepane.tools(ws.bot(bot), view, run, task).map((tool) => [tool.name, tool]));
    const call = async (name, args) => JSON.parse(await tools[name].handler(args));
    return { task, run, tools, call, end: () => (run.status = "Completed") };
  };
  return { ws, chat, turn, pane: () => chat.pane };
}

test("the tools exist in a turn the person is there for, and only the website one asks first", (t) => {
  const { turn, chat } = rig(t);
  assert.equal(SIDE_PANE, "side-pane-v1");
  const { tools } = turn();
  assert.deepEqual(Object.keys(tools), ["side_pane_show", "side_pane_web", "side_pane_update", "side_pane_close", "side_pane_list"]);
  assert.equal(tools.side_pane_web.skipPermission, false, "a website is a request to an address the bot chose: it goes through the chat's approval");
  for (const name of ["side_pane_show", "side_pane_update", "side_pane_close", "side_pane_list"]) assert.equal(tools[name].skipPermission, true, name);
  assert.ok(!("url" in tools.side_pane_show.parameters.properties) && !("url" in tools.side_pane_update.parameters.properties), "no other tool takes an address");
  assert.deepEqual(tools.side_pane_show.parameters.properties.kind.enum, ["rich_ui", "table", "screen", "details"]);
  // A turn nobody watches opens nothing.
  for (const more of [{ scheduleId: "s" }, { taskId: "k" }, { panelId: "p" }]) assert.deepEqual(Object.keys(turn("pip", chat, more).tools), [], JSON.stringify(more));
  assert.deepEqual(Object.keys(turn("pip", { ...chat, helper: true }).tools), [], "nor does a helping teammate");
});

test("a turn's tools are among the session tools", (t) => {
  const { ws, chat } = rig(t);
  const task = { stopped: false };
  ws.active.set(chat.id, task);
  const names = (run) => ws.sessionTools(ws.bot("pip"), chat, run, task).map((tool) => tool.name);
  assert.ok(names({ id: "r" }).includes("side_pane_show") && names({ id: "r" }).includes("side_pane_web"));
  assert.ok(!names({ id: "r", scheduleId: "s" }).some((name) => name.startsWith("side_pane_")));
});

test("a table opens the pane as a tab in front, with the bot that opened it", async (t) => {
  const { turn, pane } = rig(t);
  const { call, run } = turn();
  const out = await call("side_pane_show", { kind: "table", title: "  Open   invoices ", columns: ["Account", "Due"], rows: [["Acme", 120], ["Globex", "75"]] });
  assert.deepEqual([out.kind, out.title, out.opened], ["table", "Open invoices", true]);
  const [panel] = pane().panels;
  assert.deepEqual([panel.id, panel.kind, panel.botId, panel.columns, panel.rows], [out.id, "table", "pip", ["Account", "Due"], [["Acme", "120"], ["Globex", "75"]]]);
  assert.equal(pane().active, panel.id);
  assert.deepEqual([pane().ask.seq, pane().ask.panelId, pane().ask.runId, pane().ask.botId], [1, panel.id, run.id, "pip"]);
});

test("a rich UI is stored as a sandboxed view of the chat, and updates replace its page or its data", async (t) => {
  const { ws, chat, turn, pane } = rig(t);
  const { call } = turn();
  const out = await call("side_pane_show", { kind: "rich_ui", title: "Pipeline", html: PAGE, data: { won: 3 } });
  const panel = pane().panels[0];
  assert.equal(panel.kind, "rich_ui");
  assert.equal(ws.frames.get(panel.frame).owner, "chat:" + chat.id, "the same kind of view as an html block in a chat card");
  assert.deepEqual(ws.frames.data(panel.frame), { won: 3 });
  assert.equal(ws.frames.chatFor(panel.frame), chat.id, "an answer from the page goes to this chat");
  const first = panel.frame;
  const seq = pane().ask.seq;
  assert.deepEqual(await call("side_pane_update", { id: out.id, data: { won: 4 }, title: "Pipeline, today" }), { id: out.id, kind: "rich_ui", title: "Pipeline, today", updated: true });
  assert.notEqual(panel.frame, first, "new data is a new stored view, so an open page loads it");
  assert.deepEqual(ws.frames.data(panel.frame), { won: 4 });
  assert.equal(ws.frames.html(panel.frame), PAGE, "the page is kept when only data is sent");
  assert.ok(!existsSync(ws.frames.file(first, ".html")), "the earlier view is removed");
  assert.equal(pane().ask.seq, seq, "an update doesn't ask for the pane to open");
  await assert.rejects(call("side_pane_show", { kind: "rich_ui", title: "Empty" }), /needs its page/);
  await assert.rejects(call("side_pane_update", { id: out.id }), /Send `html`, `data` or `title`/);
  assert.equal(pane().panels.length, 1, "a refused panel leaves no tab");
});

test("several panels are tabs: the newest in front, the earlier ones kept", async (t) => {
  const { turn, pane } = rig(t);
  const { call } = turn();
  const a = await call("side_pane_show", { kind: "table", title: "A", columns: ["x"], rows: [["1"]] });
  const b = await call("side_pane_show", { kind: "rich_ui", title: "B", html: PAGE });
  const c = await call("side_pane_web", { url: "https://example.com/pricing" });
  assert.deepEqual(pane().panels.map((p) => [p.kind, p.title]), [["table", "A"], ["rich_ui", "B"], ["web", "example.com"]]);
  assert.equal(pane().active, c.id);
  assert.equal(pane().ask.seq, 3);
  const list = await call("side_pane_list", {});
  assert.deepEqual(list.panels.map((p) => [p.id, p.in_front ?? false, p.yours]), [[a.id, false, true], [b.id, false, true], [c.id, true, true]]);
  assert.equal(list.closed_by_person, false);
});

test("the Screen panel is one per chat, only shown, and details brings the chat's own tab forward", async (t) => {
  const { ws, turn, pane } = rig(t);
  const { call, tools } = turn();
  const first = await call("side_pane_show", { kind: "screen" });
  const again = await call("side_pane_show", { kind: "screen", title: "Ignored" });
  assert.equal(again.id, first.id);
  assert.equal(first.opened, false);
  assert.equal(pane().ask, undefined);
  assert.equal(pane().active, null);
  assert.deepEqual(pane().panels.map((p) => [p.kind, p.title]), [["screen", "Screen"]]);
  assert.deepEqual(Object.keys(pane().panels[0]).sort(), ["botId", "createdAt", "id", "kind", "title", "updatedAt"], "the panel holds no setting: the switch stays the person's");
  assert.ok(!/setScreen|screenMode|setPhoneScreen/.test(String(ws.sidepane.tools)) && !Object.keys(tools).some((name) => /screen/.test(name)), "no tool changes who may see the screen");
  const details = await call("side_pane_show", { kind: "details" });
  assert.deepEqual([details.kind, details.opened, pane().active, pane().ask.panelId], ["details", true, null, null]);
});

test("a pane the person closed stays closed for the rest of that turn, and opens again in the next", async (t) => {
  const { ws, chat, turn, pane } = rig(t);
  const one = turn();
  await one.call("side_pane_show", { kind: "table", title: "A", columns: ["x"], rows: [] });
  ws.sidepane.act(chat.id, "closed");
  assert.equal(pane().closed.runId, one.run.id);
  const seq = pane().ask.seq;
  const quiet = await one.call("side_pane_show", { kind: "table", title: "B", columns: ["x"], rows: [] });
  assert.equal(quiet.opened, false);
  assert.match(quiet.note, /stays closed/);
  assert.equal(pane().ask.seq, seq, "nothing asks the pane to open again");
  assert.deepEqual(pane().panels.map((p) => [p.title, p.unseen ?? false]), [["A", false], ["B", true]], "the panel waits as a tab the person hasn't seen");
  assert.equal((await one.call("side_pane_web", { url: "https://example.com" })).opened, false, "a website doesn't open it either");
  assert.equal((await one.call("side_pane_list", {})).closed_by_person, true);
  one.end();
  // The next turn is a new request of the person's: the pane may open for it.
  const two = turn();
  const next = await two.call("side_pane_show", { kind: "table", title: "C", columns: ["x"], rows: [] });
  assert.equal(next.opened, true);
  assert.equal(pane().ask.seq, seq + 1);
  assert.equal(pane().closed, undefined);
});

test("closing the pane between turns doesn't silence the next turn, and opening it marks the tab seen", async (t) => {
  const { ws, chat, turn, pane } = rig(t);
  const one = turn();
  await one.call("side_pane_show", { kind: "table", title: "A", columns: ["x"], rows: [] });
  ws.sidepane.act(chat.id, "closed");
  await one.call("side_pane_show", { kind: "table", title: "B", columns: ["x"], rows: [] });
  one.end();
  ws.sidepane.act(chat.id, "opened");
  assert.equal(pane().closed, undefined);
  assert.ok(!pane().panels.find((p) => p.title === "B").unseen);
  ws.sidepane.act(chat.id, "closed");
  assert.equal(pane().closed.runId, null, "closed while nothing runs");
  assert.equal((await turn().call("side_pane_show", { kind: "table", title: "C", columns: ["x"], rows: [] })).opened, true);
});

test("closing or opening the pane of a chat with no panels leaves nothing behind", (t) => {
  const { ws, chat } = rig(t);
  let saves = 0;
  const save = ws.save.bind(ws);
  ws.save = () => (saves++, save());
  ws.sidepane.act(chat.id, "closed");
  ws.sidepane.act(chat.id, "opened");
  assert.equal(chat.pane, undefined);
  assert.equal(saves, 0, "and nothing is written");
});

test("the person chooses a tab, pins one and closes one; a pinned tab stays in front and is never dropped", async (t) => {
  const { ws, chat, turn, pane } = rig(t);
  const { call } = turn();
  const a = await call("side_pane_show", { kind: "rich_ui", title: "A", html: PAGE });
  const b = await call("side_pane_show", { kind: "table", title: "B", columns: ["x"], rows: [] });
  ws.sidepane.act(chat.id, "select", a.id);
  ws.sidepane.act(chat.id, "pin", a.id);
  assert.deepEqual([pane().active, pane().panels[0].pinned], [a.id, true]);
  const c = await call("side_pane_show", { kind: "table", title: "C", columns: ["x"], rows: [] });
  assert.equal(pane().active, a.id, "a bot doesn't take the person off a tab they pinned");
  assert.match(c.note, /pinned another panel/);
  assert.deepEqual([pane().panels.find((p) => p.id === c.id).unseen, pane().ask.panelId], [true, a.id]);
  ws.sidepane.act(chat.id, "select", c.id);
  assert.equal(pane().panels.find((p) => p.id === c.id).unseen, undefined);
  ws.sidepane.act(chat.id, "unpin", a.id);
  assert.equal(pane().panels[0].pinned, undefined);
  const frame = pane().panels[0].frame;
  ws.sidepane.act(chat.id, "remove", a.id);
  assert.ok(!existsSync(ws.frames.file(frame, ".html")), "a closed rich UI's page is removed");
  assert.deepEqual(pane().panels.map((p) => p.id), [b.id, c.id]);
  ws.sidepane.act(chat.id, "select", null);
  assert.equal(pane().active, null, "back to the chat's details");
  assert.throws(() => ws.sidepane.act(chat.id, "select", a.id), /no longer exists/);
  assert.throws(() => ws.sidepane.act(chat.id, "shout"), /Unknown side pane action/);
  assert.throws(() => ws.sidepane.act("nope", "closed"));
});

test("a chat keeps a few panels: the oldest unpinned one makes room, and one reply can't flood the pane", async (t) => {
  const { ws, chat, turn, pane } = rig(t);
  let current = turn();
  const first = await current.call("side_pane_show", { kind: "rich_ui", title: "First", html: PAGE });
  const frame = pane().panels[0].frame;
  const second = await current.call("side_pane_show", { kind: "table", title: "Second", columns: ["x"], rows: [] });
  ws.sidepane.act(chat.id, "pin", second.id);
  for (let i = 2; i < MAX_PANELS; i++) await current.call("side_pane_show", { kind: "table", title: "T" + i, columns: ["x"], rows: [] });
  assert.equal(pane().panels.length, MAX_PANELS);
  await assert.rejects(current.call("side_pane_show", { kind: "table", title: "Ninth", columns: ["x"], rows: [] }), /at most 8 panels in one reply/);
  current.end();
  current = turn();
  await current.call("side_pane_show", { kind: "table", title: "Newest", columns: ["x"], rows: [] });
  assert.equal(pane().panels.length, MAX_PANELS);
  assert.ok(!pane().panels.some((p) => p.id === first.id), "the oldest went");
  assert.ok(!existsSync(ws.frames.file(frame, ".html")), "with its page");
  assert.ok(pane().panels.some((p) => p.id === second.id), "the pinned one stayed");
  for (const panel of pane().panels) panel.pinned = true;
  await assert.rejects(current.call("side_pane_show", { kind: "table", title: "One more", columns: ["x"], rows: [] }), /pinned every panel/);
});

test("a bot changes and closes its own panels only, and can ask for the pane to close", async (t) => {
  const { turn, pane } = rig(t);
  const pip = turn("pip");
  const mine = await pip.call("side_pane_show", { kind: "table", title: "Pip's", columns: ["x"], rows: [["1"]] });
  const scout = turn("scout");
  await assert.rejects(scout.call("side_pane_update", { id: mine.id, title: "Taken" }), /Another bot opened this panel/);
  await assert.rejects(scout.call("side_pane_close", { id: mine.id }), /Another bot opened this panel/);
  assert.equal((await scout.call("side_pane_list", {})).panels[0].yours, false);
  assert.deepEqual(await scout.call("side_pane_update", { id: (await scout.call("side_pane_show", { kind: "table", title: "Scout's", columns: ["a", "b"], rows: [] })).id, rows: [["1", "2"]] }).then((out) => out.updated), true);
  assert.deepEqual(pane().panels[1].rows, [["1", "2"]]);
  const seq = pane().ask.seq;
  assert.deepEqual(await scout.call("side_pane_close", {}), { closed: "pane", left: 2 });
  assert.deepEqual([pane().ask.seq, pane().ask.close], [seq + 1, true]);
  const own = pane().panels[1].id;
  assert.deepEqual(await scout.call("side_pane_close", { id: own }), { closed: own, left: 1 });
  await assert.rejects(scout.call("side_pane_close", { id: own }), /no longer exists/);
});

test("a website's address is checked before anything is shown", async (t) => {
  const { turn, pane } = rig(t);
  const { call } = turn();
  const out = await call("side_pane_web", { url: " https://www.example.com/pricing?plan=team ", title: "Pricing" });
  assert.deepEqual([out.kind, out.title, out.url, out.opened], ["web", "Pricing", "https://www.example.com/pricing?plan=team", true]);
  assert.equal((await call("side_pane_web", { url: "http://localhost:5173/" })).title, "localhost", "a site running on this computer can be shown");
  assert.equal((await call("side_pane_web", { url: "http://127.0.0.1:3000/" })).opened, true);
  const before = pane().panels.length;
  for (const [url, why] of [
    ["file:///etc/passwd", /Only http and https/],
    ["javascript:alert(1)", /Only http and https/],
    ["example.com", /full web address/],
    ["https://user:secret@example.com/", /user name or a password/],
    ["http://192.168.1.1/admin", /local network/],
    ["http://[fe80::1]/", /local network/],
    ["http://169.254.169.254/latest/meta-data", /local network/],
    ["http://printer.home/", /local network/],
    ["https://mixed.test/", /local network/],
    ["https://nowhere.invalid/", /couldn't be found/],
    ["https://example.com/" + "a".repeat(2100), /too long/],
  ])
    await assert.rejects(call("side_pane_web", { url }), why, url);
  assert.equal(pane().panels.length, before, "a refused address leaves no tab");
  // Sending a web panel somewhere else is the same tool, with the same checks.
  const moved = await call("side_pane_web", { id: out.id, url: "https://example.com/docs" });
  assert.deepEqual([moved.id, moved.url, pane().panels[0].title], [out.id, "https://example.com/docs", "example.com"]);
  await assert.rejects(call("side_pane_web", { id: out.id, url: "http://10.0.0.5/" }), /local network/);
  const table = await call("side_pane_show", { kind: "table", title: "T", columns: ["x"], rows: [] });
  await assert.rejects(call("side_pane_web", { id: table.id, url: "https://example.com/" }), /isn't a website/);
  await assert.rejects(call("side_pane_update", { id: out.id, html: "<p>x</p>" }), /Only this panel's `title`/);
});

test("address checks by themselves", async () => {
  assert.equal(await webAddress("https://example.com", resolve), "https://example.com/");
  assert.equal(await webAddress("http://dev.test:8080/x", resolve), "http://dev.test:8080/x", "a name for this computer itself");
  assert.equal(await webAddress("http://app.localhost:3000/", resolve), "http://app.localhost:3000/");
  assert.equal(await webAddress("http://[::1]:3000/", resolve), "http://[::1]:3000/");
  for (const host of ["192.168.1.1", "10.0.0.5", "172.16.0.9", "169.254.169.254", "[fe80::1]", "[fd00::1]", "100.64.0.1"]) assert.equal(localNetworkLiteral(host), true, host);
  for (const host of ["127.0.0.1", "[::1]", "93.184.216.34", "example.com", "localhost", ""]) assert.equal(localNetworkLiteral(host), false, host);
});

test("a table is text in rows as wide as its header, within limits", () => {
  assert.deepEqual(tableFields({ columns: ["a", "b"], rows: [["1", 2], [true, "x".repeat(600)]] }), { columns: ["a", "b"], rows: [["1", "2"], ["true", "x".repeat(500)]] });
  assert.throws(() => tableFields({ columns: [], rows: [] }), /1 to 12 columns/);
  assert.throws(() => tableFields({ columns: Array(13).fill("c"), rows: [] }), /1 to 12 columns/);
  assert.throws(() => tableFields({ columns: ["a"], rows: Array(201).fill(["1"]) }), /at most 200 rows/);
  assert.throws(() => tableFields({ columns: ["a", "b"], rows: [["1"]] }), /Every row needs 2 cells/);
  assert.throws(() => tableFields({ columns: ["a"], rows: [[{ html: "<b>" }]] }), /Every cell of a table is text/);
  assert.throws(() => tableFields({ columns: ["a"] }), /at most 200 rows/);
});

test("a turn that is over shows nothing, and deleting the chat removes its panels' pages", async (t) => {
  const { ws, chat, turn, pane } = rig(t);
  const { call, task, tools, end } = turn();
  await call("side_pane_show", { kind: "rich_ui", title: "A", html: PAGE });
  const frame = pane().panels[0].frame;
  task.stopped = true;
  await assert.rejects(tools.side_pane_show.handler({ kind: "table", columns: ["x"], rows: [] }), /no longer active/);
  await assert.rejects(tools.side_pane_web.handler({ url: "https://example.com" }), /no longer active/);
  end();
  ws.active.delete(chat.id);
  await ws.agents.deleteChat(chat.id);
  assert.ok(!existsSync(ws.frames.file(frame, ".html")));
});

// ---- The website viewer's guards (desktop/webviewer.mjs) ----

test("the viewer loads the web and nothing else", () => {
  for (const url of ["https://example.com/", "http://example.com/a?b=c", "http://localhost:5173/", "http://127.0.0.1:3000/", "http://[::1]:8080/"]) assert.equal(viewable(url), true, url);
  for (const url of ["file:///etc/hosts", "botkins-app://frame-x/", "javascript:alert(1)", "data:text/html,<p>x", "about:blank", "chrome://settings", "https://user:pw@example.com/", "http://192.168.1.1/", "http://10.0.0.5:8080/", "http://169.254.169.254/", "http://[fd00::1]/", "", "example.com", null, undefined])
    assert.equal(viewable(url), false, String(url));
});

test("a guest is let in only as the viewer's, with its settings decided by the app", () => {
  const attach = (params, preferences = {}) => {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) };
    attachViewer(event, preferences, params);
    return { prevented: event.prevented, preferences, params };
  };
  const asked = { preload: "/tmp/evil.js", preloadURL: "file:///tmp/evil.js", nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, webviewTag: true };
  const let_in = attach({ src: "https://example.com/", partition: VIEWER_PARTITION, allowpopups: "", nodeintegration: "", preload: "file:///tmp/evil.js", webpreferences: "contextIsolation=no", disablewebsecurity: "" }, { ...asked });
  assert.equal(let_in.prevented, false);
  assert.deepEqual(
    (({ preload, preloadURL, nodeIntegration, nodeIntegrationInSubFrames, contextIsolation, sandbox, webSecurity, webviewTag, allowRunningInsecureContent }) => ({ preload, preloadURL, nodeIntegration, nodeIntegrationInSubFrames, contextIsolation, sandbox, webSecurity, webviewTag, allowRunningInsecureContent }))(let_in.preferences),
    { preload: undefined, preloadURL: undefined, nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false },
    "whatever the page asked for is overwritten",
  );
  assert.deepEqual(Object.keys(let_in.params).sort(), ["partition", "src"], "and nothing that loosens the guest is passed on");
  assert.ok(!VIEWER_PARTITION.startsWith("persist:"), "the viewer's storage is kept in memory only");
  for (const params of [
    { src: "https://example.com/", partition: "persist:mine" },
    { src: "https://example.com/" },
    { src: "file:///etc/hosts", partition: VIEWER_PARTITION },
    { src: "http://192.168.1.1/", partition: VIEWER_PARTITION },
    { src: "botkins-app://frame-x/", partition: VIEWER_PARTITION },
    { partition: VIEWER_PARTITION },
    undefined,
  ])
    assert.equal(attach(params).prevented, true, JSON.stringify(params));
});

test("a guest opens no window, stays on the web, and its storage grants nothing", () => {
  const handlers = {};
  const loaded = [];
  let opener;
  const guest = { setWindowOpenHandler: (fn) => (opener = fn), on: (name, fn) => (handlers[name] = fn), loadURL: async (url) => void loaded.push(url), setWebRTCIPHandlingPolicy: (policy) => (guest.policy = policy) };
  guardGuest(guest);
  assert.deepEqual(opener({ url: "https://example.com/next" }), { action: "deny" });
  assert.deepEqual(opener({ url: "file:///etc/hosts" }), { action: "deny" });
  assert.deepEqual(loaded, ["https://example.com/next"], "a link that wants a new window is followed in the viewer; anything else goes nowhere");
  const went = (name, url, legacy) => {
    const event = { url: legacy ? undefined : url, prevented: false, preventDefault: () => (event.prevented = true) };
    handlers[name](event, legacy ? url : undefined);
    return !event.prevented;
  };
  assert.equal(went("will-navigate", "https://example.com/a"), true);
  assert.equal(went("will-navigate", "file:///etc/hosts"), false);
  assert.equal(went("will-navigate", "http://192.168.1.1/", true), false);
  assert.equal(went("will-redirect", "http://10.0.0.5/"), false, "a redirect to the local network is stopped too");
  assert.equal(went("will-redirect", "https://example.org/"), true);
  assert.equal(guest.policy, "disable_non_proxied_udp");
  const session = { on: (name, fn) => (session[name] = fn), setPermissionRequestHandler: (fn) => (session.request = fn), setPermissionCheckHandler: (fn) => (session.check = fn), setDevicePermissionHandler: (fn) => (session.device = fn) };
  guardViewerSession(session);
  for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "fullscreen", "openExternal"]) {
    let answer;
    session.request({}, permission, (granted) => (answer = granted));
    assert.equal(answer, false, permission);
    assert.equal(session.check({}, permission), false, permission);
  }
  assert.equal(session.device({}), false);
  const download = { prevented: false, preventDefault: () => (download.prevented = true) };
  session["will-download"](download);
  assert.equal(download.prevented, true);
});
