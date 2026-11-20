// This app as a client of another computer's Botkins (desktop/remotehosts.mjs), against a real
// link host in this process: pairing, the credential, switching hosts, the host's state in the
// window's shape, calls, and several clients on one host. The only sockets are to this computer
// itself; the relay is never used.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { HERE, REMOTE_HOSTS, RemoteHosts, snapshotOf } from "../desktop/remotehosts.mjs";
import * as lib from "../desktop/remote/link-client.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const digest = (folder) => {
  const hash = createHash("sha256");
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".ts")).sort()) hash.update(name + "\n").update(readFileSync(join(folder, name)));
  return hash.digest("hex");
};

test("the compiled link client matches the five phone sources approved for this release", () => {
  const made = /^\/\/ sources: ([0-9a-f]{64})$/m.exec(readFileSync(join(root, "desktop/remote/link-client.mjs"), "utf8"))?.[1];
  assert.equal(made, digest(join(root, "desktop/remote/client")), "run `node scripts/build-link-client.mjs` after the copy changes");
  const folder = join(root, "desktop/remote/client");
  const approved = JSON.parse(readFileSync(join(root, "desktop/remote/client-sources.json"), "utf8"));
  const hashes = Object.fromEntries(readdirSync(folder).filter(name => name.endsWith(".ts")).map(name =>
    [name, createHash("sha256").update(readFileSync(join(folder, name))).digest("hex")]));
  assert.deepEqual(hashes, approved);
});

test("the host's parts become the state the window reads", () => {
  const parts = {
    meta: { name: "Studio", version: "1.2.3", capabilities: ["devices-v1"] },
    settings: { model: { model: "auto" }, appearance: { theme: "dark" }, notifications: { replies: true } },
    bots: [{ id: "pip", name: "Pip" }],
    chats: [
      { id: "c1", botId: "pip", title: "One", time: 5, count: 2, last: { role: "assistant", text: "Hello" } },
      { id: "c2", botId: "pip", title: "Two", time: 4, count: 9 },
    ],
    "chat:c1": { id: "c1", from: 0, total: 2, messages: [{ role: "user", text: "Hi", runId: "r1" }, { role: "assistant", text: "Hello", runId: "r1" }], runs: [{ id: "r1", chatId: "c1", status: "Completed", steps: [{ name: "search" }] }], todos: [{ text: "x" }] },
    "run:c2": { id: "r9", chatId: "c2", status: "Working", steps: [] },
    runs: [{ id: "r1", chatId: "c1", status: "Completed" }, { id: "r0", chatId: "c2", status: "Completed" }],
    live: { streams: { c2: "Wor" }, intents: { c2: "Thinking" }, thinking: {}, speakers: {}, queued: {}, requests: [{ id: "q", kind: "permission" }], active: ["c2"] },
    tasks: [{ id: "t" }],
    mcp: [{ id: "m" }],
    revs: { wiki: 7, providers: 3 },
  };
  const state = snapshotOf(parts, { appearance: { theme: "light" }, sidebar: { collapsed: true }, model: { model: "mine" } });
  assert.deepEqual(state.settings, { model: { model: "auto" }, appearance: { theme: "light" }, notifications: { replies: true }, sidebar: { collapsed: true } }, "the window keeps its own look; everything else is the host's");
  assert.deepEqual(state.chats.map((chat) => [chat.id, chat.messages.length, chat.loaded, chat.count]), [["c1", 2, { from: 0, total: 2 }, 2], ["c2", 0, null, 9]], "messages are there for a chat that is followed; the rest are listed");
  assert.deepEqual(state.chats[0].todos, [{ text: "x" }]);
  assert.deepEqual(state.runs.map((run) => [run.id, run.status, !!run.steps]), [["r1", "Completed", true], ["r0", "Completed", false], ["r9", "Working", true]], "a followed chat's runs come with their steps, and its running turn is among them");
  assert.deepEqual([state.streams, state.intents, state.requests], [{ c2: "Wor" }, { c2: "Thinking" }, [{ id: "q", kind: "permission" }]]);
  assert.deepEqual([state.tasks, state.mcpServers, state.wiki, state.providers], [[{ id: "t" }], [{ id: "m" }], { revision: 7 }, { revision: 3 }]);
  const empty = snapshotOf({});
  assert.deepEqual([empty.bots, empty.chats, empty.runs, empty.requests, empty.streams, empty.settings], [[], [], [], [], {}, {}], "a host that hasn't answered yet is an empty workspace, not a crash");
});

/** Computer A: a workspace behind a real link host on a port of its own. */
async function host(t, name = "Studio") {
  const listeners = new Set();
  const ws = new Workspace(tempDir(t), fakeClient().client, () => listeners.forEach((fn) => fn()));
  const handlers = {
    createChat: (botId) => ws.createChat(botId),
    renameChat: (id, title) => ((ws.chat(id).title = title), ws.save()),
    usage: () => ({ days: 30 }),
    startPhonePairing: () => "never from a client",
  };
  const link = new LinkHost({
    dir: join(tempDir(t), "link"),
    port: 0,
    backend: { info: () => ({ app: "botkins", version: "9.9.9", platform: process.platform }), capabilities: [REMOTE_HOSTS], snapshot: () => ws.snapshot(), call: (method, args) => handlers[method](...args), subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) },
  });
  t.after(() => link.stop());
  await link.start();
  await link.setEnabled(true);
  link.renameComputer?.(name);
  return { ws, link, address: "127.0.0.1:" + link.status().port };
}
/** Computer B (or a phone): the client side, with its credentials in a file of its own. */
function client(t, { protect = null, device = { name: "Laptop", platform: "darwin" } } = {}) {
  const file = join(tempDir(t), "remote-hosts.json");
  let changes = 0;
  const make = () => new RemoteHosts({ file, protect, lib, device, changed: () => changes++ });
  const remote = make();
  t.after(() => remote.stop());
  return { remote, file, make, changes: () => changes };
}
const until = async (what, check, ms = 15000) => {
  const limit = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > limit) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

test("pairing with a code makes this app a desktop device of the host, and the credential is kept wrapped", async (t) => {
  const a = await host(t);
  const wrapped = [];
  const protect = { wrap: (text) => (wrapped.push(text), "sealed:" + Buffer.from(text).toString("base64")), unwrap: (data) => Buffer.from(String(data).replace(/^sealed:/, ""), "base64").toString() };
  const b = client(t, { protect });
  await assert.rejects(b.remote.pair({ address: "", code: "x" }), /Enter the other computer's address/);
  await assert.rejects(b.remote.pair({ address: a.address }), /Enter the pairing code/);
  await assert.rejects(b.remote.pair({ link: "https://example.com/" }), /isn't a Botkins pairing link/);
  const { code } = a.link.startPairing();
  await assert.rejects(b.remote.pair({ address: a.address, code: "WRONGCODE234" }), /That code isn't right/);
  const paired = await b.remote.pair({ address: a.address, code });
  assert.equal(paired.id, a.link.status().serverId ?? paired.id);
  const devices = a.link.status().devices;
  assert.deepEqual(devices.map((d) => [d.name, d.kind, d.platform]), [["Laptop", "desktop", "darwin"]], "the host lists this app by its name, as a desktop");
  // Nothing of the secret key is readable in the file, and what is listed holds no credential.
  const kept = readFileSync(b.file, "utf8");
  const secret = JSON.parse(wrapped.at(-1)).secretKey;
  assert.ok(secret.length > 20 && !kept.includes(secret), "the secret key is not in the file as it is");
  assert.ok(!JSON.stringify(b.remote.list()).includes(secret));
  assert.deepEqual(Object.keys(b.remote.list()[0]).sort(), ["addedAt", "current", "id", "name"]);
  // The app opened again later knows the host; with another key for the credentials it knows none.
  assert.deepEqual(b.make().list().map((h) => h.id), [paired.id]);
  assert.deepEqual(new RemoteHosts({ file: b.file, protect: { wrap: (x) => x, unwrap: () => null }, lib }).list(), []);
  // The pairing link the host shows works too, and pairing again replaces this app's entry on both sides.
  // (The link lists this computer's network addresses; the test keeps to the loopback one.)
  const shown = new URL(a.link.startPairing().url);
  shown.searchParams.set("h", a.address);
  const again = await b.remote.pair({ link: shown.href });
  assert.equal(again.id, paired.id);
  assert.equal(b.remote.list().length, 1);
  assert.equal(a.link.status().devices.length, 1);
});

test("using a host shows its bots and chats, sends the window's calls there, and follows a chat", async (t) => {
  const a = await host(t);
  const b = client(t);
  const { id } = await b.remote.pair({ address: a.address, code: a.link.startPairing().code });
  assert.equal(b.remote.inUse(), null, "pairing alone changes nothing in the window");
  await assert.rejects(b.remote.call("createChat", ["pip"]), /No other computer is in use/);
  const used = b.remote.use(id);
  assert.deepEqual([used.id, used.state], [id, "connecting"]);
  await until("the host to answer", () => b.remote.state === "online" && b.remote.snapshot().bots.length > 0);
  assert.deepEqual(b.remote.snapshot().bots.map((bot) => bot.id), a.ws.state.bots.map((bot) => bot.id));
  assert.deepEqual([b.remote.inUse().state, b.remote.inUse().version, b.remote.list()[0].current], ["online", "9.9.9", true]);
  // A call is made on the host, and the change comes back by itself.
  const before = b.changes();
  const chatId = await b.remote.call("createChat", ["pip"]);
  assert.ok(a.ws.state.chats.some((chat) => chat.id === chatId), "the chat exists on the host");
  await until("the new chat to be listed here", () => b.remote.snapshot().chats.some((chat) => chat.id === chatId));
  assert.ok(b.changes() > before, "the window is told");
  assert.equal(b.remote.snapshot().chats.find((chat) => chat.id === chatId).loaded, null, "a chat nobody looks at is only listed");
  // Looking at a chat brings its messages.
  a.ws.chat(chatId).messages.push({ role: "user", text: "What is the gate code?", time: 1 }, { role: "assistant", text: "Heron forty two.", time: 2 });
  a.ws.save();
  b.remote.watch([chatId, chatId, "", null]);
  assert.deepEqual(b.remote.watching, [chatId]);
  await until("the chat's messages", () => b.remote.snapshot().chats.find((chat) => chat.id === chatId).messages.length === 2);
  assert.deepEqual(b.remote.snapshot().chats.find((chat) => chat.id === chatId).messages.map((m) => m.text), ["What is the gate code?", "Heron forty two."]);
  // What a client may not do is refused here, in words, and never reaches the host.
  await assert.rejects(b.remote.call("startPhonePairing", []), /can only be done on .* itself/);
  await assert.rejects(b.remote.call("exportUsage", [30]), /can only be done on .* itself/);
  assert.deepEqual(await b.remote.call("usage", [30]), { days: 30 });
  for (const name of ["snapshot", "viewing", "remoteHosts", "pairRemoteHost", "useRemoteHost", "forgetRemoteHost"]) assert.ok(HERE.has(name), name + " runs on this computer whichever host is shown");
  // Back to this computer: the host's state is let go of.
  assert.equal(b.remote.use(null), null);
  assert.deepEqual([b.remote.inUse(), b.remote.state, b.remote.snapshot().bots], [null, "idle", []]);
});

test("the paired hosts and the one in use are remembered when the app is opened again", async (t) => {
  const a = await host(t);
  const sealed = { wrap: (text) => "sealed:" + Buffer.from(text).toString("base64"), unwrap: (data) => Buffer.from(String(data).replace(/^sealed:/, ""), "base64").toString() };
  const b = client(t, { protect: sealed });
  const { id } = await b.remote.pair({ address: a.address, code: a.link.startPairing().code });
  // Paired but not in use: the app opened again knows the host and is on this computer.
  const idle = b.make();
  t.after(() => idle.stop());
  assert.deepEqual([idle.list().map((h) => [h.id, h.current]), idle.resume(), idle.inUse()], [[[id, false]], null, null]);
  // In use when the app closes: the app opened again goes back to it by itself and reaches it.
  b.remote.use(id);
  await until("the host to answer", () => b.remote.state === "online");
  assert.equal(JSON.parse(readFileSync(b.file, "utf8")).current, id, "which host is in use is written down when it is chosen");
  b.remote.stop(); // the app closes: its connection ends, nothing is chosen anew
  const again = b.make();
  t.after(() => again.stop());
  assert.equal(again.inUse(), null, "nothing connects before the app says it has started");
  assert.deepEqual([again.resume().id, again.list()[0].current], [id, true]);
  await until("the reopened app to reach the host", () => again.state === "online" && again.snapshot().bots.length > 0);
  assert.equal(again.resume().id, id, "asking twice changes nothing");
  // Renamed here, and pairing again while in use: both are kept, and the window stays on the host.
  again.rename(id, "Studio");
  await again.pair({ address: a.address, code: a.link.startPairing().code });
  assert.deepEqual([again.inUse().id, again.list()[0].name, again.list()[0].current], [id, "Studio", true]);
  await until("the host again, with the new credential", () => again.state === "online");
  assert.equal(a.link.status().devices.length, 1);
  // Back on this computer: that is remembered too.
  again.use(null);
  assert.equal(JSON.parse(readFileSync(b.file, "utf8")).current, null);
  const home = b.make();
  t.after(() => home.stop());
  assert.deepEqual([home.resume(), home.list().length], [null, 1], "the host is still paired, and the window is on this computer");
  // A host that was in use and is then forgotten is not gone back to.
  home.use(id);
  await home.forget(id);
  const none = b.make();
  assert.deepEqual([none.resume(), none.list()], [null, []]);
  // A file that names a host which isn't paired any more opens on this computer.
  const stray = client(t);
  writeFileSync(stray.file, JSON.stringify({ current: "gone", hosts: [] }));
  assert.equal(stray.make().resume(), null);
});

test("a host serves a desktop and a phone at once, and removing one leaves the other", async (t) => {
  const a = await host(t);
  const desk = client(t, { device: { name: "Laptop", platform: "win32" } });
  const first = await desk.remote.pair({ address: a.address, code: a.link.startPairing().code });
  // A phone pairs afterwards, with the same library: the desktop's pairing is untouched.
  const phonePairing = await lib.pair(fetch, { hosts: [a.address], code: a.link.startPairing().code }, { name: "Phone", platform: "ios" });
  const phoneParts = {};
  let phoneState = "connecting";
  const phone = new lib.LinkClient(phonePairing, { fetch, onParts: (parts) => Object.assign(phoneParts, parts), onState: (state) => (phoneState = state) });
  t.after(() => phone.stop());
  phone.start();
  desk.remote.use(first.id);
  await until("both to be online", () => desk.remote.state === "online" && phoneState === "online" && phoneParts.bots);
  assert.deepEqual(a.link.status().devices.map((d) => [d.name, d.kind]).sort(), [["Laptop", "desktop"], ["Phone", "phone"]]);
  // A change one client makes reaches the other.
  const chatId = await desk.remote.call("createChat", ["scout"]);
  await until("the phone to hear of the desktop's chat", () => (phoneParts.chats ?? []).some((chat) => chat.id === chatId));
  await phone.call("renameChat", chatId, "From the phone");
  await until("the desktop to hear of the phone's change", () => desk.remote.snapshot().chats.find((chat) => chat.id === chatId)?.title === "From the phone");
  // The host removes the desktop: it is told so and stops; the phone goes on.
  const listed = a.link.status().devices.find((d) => d.kind === "desktop");
  a.link.removeDevice(listed.id);
  await until("the desktop to learn it was removed", () => desk.remote.state === "revoked");
  await assert.rejects(desk.remote.call("createChat", ["pip"]), /no longer knows this computer/);
  assert.deepEqual(a.link.status().devices.map((d) => d.name), ["Phone"]);
  assert.equal(typeof (await phone.call("createChat", "pip")), "string", "the phone's pairing still works");
});

test("forgetting a host unpairs on both sides", async (t) => {
  const a = await host(t);
  const b = client(t);
  const { id } = await b.remote.pair({ address: a.address, code: a.link.startPairing().code });
  b.remote.use(id);
  await until("the host to answer", () => b.remote.state === "online");
  b.remote.rename(id, "  The studio computer ");
  assert.equal(b.remote.list()[0].name, "The studio computer");
  assert.throws(() => b.remote.rename(id, " "), /Give the computer a name/);
  await b.remote.forget(id);
  assert.deepEqual([b.remote.list(), b.remote.inUse()], [[], null]);
  assert.deepEqual(a.link.status().devices, [], "the host no longer lists this app");
  assert.ok(!readFileSync(b.file, "utf8").includes("secretKey"));
  assert.throws(() => b.remote.use(id), /no longer paired/);
  // A host that isn't in use is unpaired the same way.
  const again = await b.remote.pair({ address: a.address, code: a.link.startPairing().code });
  await b.remote.forget(again.id);
  assert.deepEqual(a.link.status().devices, []);
});
