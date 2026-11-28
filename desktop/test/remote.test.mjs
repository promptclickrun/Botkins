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
import { liveContextFor } from "../desktop/live-context.mjs";
import { writeProfile } from "../desktop/bot-profile-files.mjs";
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
  // A host with Spaces names them for the paired person; one without sends none, and the window keeps its Today page.
  const space = { id: "s_launch", name: "Launch", by: { id: "owner", name: "Studio" }, mine: true, access: "private", can: "own", count: 2, changed: 1, pinned: true, notify: "daily", here: [], rev: 4, updatedAt: 9 };
  assert.deepEqual(snapshotOf({ ...parts, spaces: [space] }).spaces, [space]);
  assert.equal("spaces" in state, false);
  // A host with chat sections names the paired person's own; one without sends none, and the window then has no sections.
  assert.deepEqual(snapshotOf({ ...parts, chatSections: [{ id: "cs_abcdefghijk", name: "Work" }] }).chatSections, [{ id: "cs_abcdefghijk", name: "Work" }]);
  assert.equal("chatSections" in state, false);
  // Admin mode is the owner's own devices': the window is told how the host keeps it for this one.
  assert.equal("adminMode" in state, false);
  assert.equal(snapshotOf({ ...parts, meta: { ...parts.meta, you: { kind: "owner", admin: false } } }).adminMode, false);
  assert.equal(snapshotOf({ ...parts, meta: { ...parts.meta, you: { kind: "owner", admin: true } } }).adminMode, true);
  assert.equal("adminMode" in snapshotOf({ ...parts, meta: { ...parts.meta, you: { kind: "member", memberId: "m_avery" } } }), false);
  // Paired phones from parts.phones are mapped to remotePhones (excluding gadgets) with canNotify.
  const withPhones = snapshotOf({
    ...parts,
    phones: {
      d_phone: { name: "Alex iPhone", kind: "phone", platform: "ios", push: { routines: true }, sources: {} },
      d_muted: { name: "Quiet iPhone", kind: "phone", platform: "ios", push: { routines: false }, sources: {} },
      d_mac: { name: "Desk Mac", kind: "desktop", platform: "darwin", sources: {} },
      d_gadget: { name: "Sensor", kind: "gadget", platform: "linux", sources: {} },
    },
  });
  assert.deepEqual(withPhones.remotePhones, [
    { id: "d_phone", name: "Alex iPhone", kind: "phone", platform: "ios", canNotify: true },
    { id: "d_muted", name: "Quiet iPhone", kind: "phone", platform: "ios", canNotify: false },
    { id: "d_mac", name: "Desk Mac", kind: "desktop", platform: "darwin", canNotify: false },
  ]);
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
    updateBot: (id, data) => ws.updateBot(id, data),
    usage: () => ({ days: 30 }),
    startPhonePairing: () => "never from a client",
  };
  const link = new LinkHost({
    dir: join(tempDir(t), "link"),
    port: 0,
    backend: { info: () => ({ app: "botkins", version: "9.9.9", platform: process.platform }), capabilities: [REMOTE_HOSTS], liveContext: (args) => liveContextFor(ws, args), snapshot: () => ws.snapshot(), call: (method, args) => handlers[method](...args), subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) },
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

test("a desktop viewer stays on its paired host, respects that host's grant, and releases held input on switching away", async t => {
  const a = await host(t);
  const b = client(t);
  const { id } = await b.remote.pair({ address: a.address, code: a.link.startPairing().code });
  b.remote.use(id);
  await until("connected", () => b.remote.inUse()?.state === "online");
  const input = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let closed = 0;
  a.link.backend.screen = {
    displays: async () => [{ id: "1", width: 100, height: 100, primary: true }], permissions: async () => ({ screenRecording: true, accessibility: true }),
    capture: async () => ({ width: 100, height: 100, jpeg }),
    openVideo: async ({ mimeTypes }) => ({ mimeType: mimeTypes[0], read: async () => Buffer.from("encoded"), close: () => closed++ }),
  };
  a.link.screen.override = async job => input.push(...job.events);
  const viewer = crypto.randomUUID();
  const call = (op, ...args) => b.remote.screenRequest(id, viewer, op, ...args);
  assert.equal(typeof b.remote.screenRequest, "function");
  await assert.rejects(b.remote.screenRequest("other", viewer, "start"), /computer/i);
  await assert.rejects(call("input", "1", []), /viewer/i);
  a.link.setScreenMode("view");
  assert.equal((await call("start")).canControl, false);
  assert.equal((await call("frame", { display: "1" })).jpeg, jpeg.toString("base64"));
  await assert.rejects(call("input", "1", [{ type: "click", x: 0.5, y: 0.5 }]), /control/i);
  await assert.rejects(call("grant.confirm"), /action/i);
  a.link.setScreenMode("control");
  await call("openVideo", { display: "1", mimeTypes: ['video/webm; codecs="vp8"'] });
  assert.equal(await call("readVideo", 0), Buffer.from("encoded").toString("base64"));
  await call("input", "1", [{ type: "down", x: 0.5, y: 0.5 }]);
  b.remote.use(null);
  await assert.rejects(call("input", "1", []), /computer/i);
  await until("the old host to release the drag and its encoder", () => input.at(-1)?.type === "up" && closed > 0);
});
const until = async (what, check, ms = 15000) => {
  const limit = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > limit) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

test("a team member's window: its own chats, a chat it is invited into, and leaving it", async (t) => {
  const a = await host(t);
  const b = client(t, { device: { name: "Avery's laptop", platform: "darwin" } });
  // The role lets a member see every bot and chat with it; then the laptop joins by invite, as a person would.
  const guest = structuredClone(a.link.team().roles.find((role) => role.id === "r_guest"));
  await a.link.saveRole({ ...guest, bots: "all" });
  const invite = await a.link.createInvite({ groupId: "g_everyone", days: 7, maxUses: 1 });
  const { serverKey } = lib.parseJoinUrl(invite.link);
  const pending = await b.remote.startTeamJoin({ hosts: [a.address], code: invite.code, serverId: a.link.status().serverId, serverKey, name: "Studio" });
  assert.equal(pending.status, "pending");
  await a.link.approve(a.link.team().requests[0].id);
  assert.equal((await b.remote.checkTeamJoin(pending.id)).status, "approved");
  const me = a.link.team().members[0].id;
  b.remote.use(b.remote.list()[0].id);
  await until("the member's view of the host", () => b.remote.state === "online" && b.remote.snapshot().team?.me?.memberId === me);
  const chats = () => b.remote.snapshot().chats.map((chat) => chat.id).sort();
  // Everyone on the team can be listed, the owner first.
  assert.deepEqual(b.remote.snapshot().team.people.map((person) => person.id), ["owner", me]);
  assert.equal(b.remote.inUse().member, true);

  // The owner's chat is not the member's to see; a chat the member made is.
  const owners = a.ws.createChat("pip");
  const mine = a.ws.createChat("pip");
  a.ws.chat(mine).createdBy = me;
  a.ws.save();
  await until("the member's own chat", () => chats().includes(mine));
  assert.deepEqual(chats(), [mine]);
  assert.deepEqual(await b.remote.call("chatPeople", [mine]), { createdBy: me, invited: [] });
  // In their own chat the member may invite: here, the owner.
  assert.deepEqual(await b.remote.call("inviteToChat", [mine, "owner"]), ["owner"]);
  assert.equal(a.link.notifiesOwner(mine), true);
  await until("the chat to say the owner was invited", () => b.remote.snapshot().chats.find((chat) => chat.id === mine).invited?.[0] === "owner");

  // Invited into the owner's chat, it appears, and says who started it and who was invited.
  assert.deepEqual(a.link.inviteToChat(owners, me), [me]);
  await until("the owner's chat to appear", () => chats().includes(owners));
  assert.deepEqual(await b.remote.call("chatPeople", [owners]), { createdBy: "owner", invited: [me] });
  // There the member may not invite or remove anyone else.
  a.link.store.data.team.members.push({ id: "m_blake", name: "Blake", groupId: "g_everyone", joinedAt: 1, deviceIds: [] });
  await assert.rejects(b.remote.call("inviteToChat", [owners, "m_blake"]));
  assert.deepEqual(a.link.chatPeople(owners).invited, [me]);
  // But may leave: the chat is gone from their window, and stays the owner's.
  assert.deepEqual(await b.remote.call("removeFromChat", [owners, me]), []);
  await until("the chat to leave the member's window", () => !chats().includes(owners));
  assert.deepEqual(a.link.chatPeople(owners), { createdBy: "owner", invited: [] });
  assert.ok(a.ws.state.chats.some((chat) => chat.id === owners));
});

test("a team member's window sets the voice of a bot its role manages, reading and live, and nothing else of the host's voice", async (t) => {
  const a = await host(t);
  a.link.voice.setKey("openai", "sk-owner-private-key");
  const b = client(t, { device: { name: "Avery's laptop", platform: "darwin" } });
  // Avery's role manages one bot: Pip.
  const guest = structuredClone(a.link.team().roles.find((role) => role.id === "r_guest"));
  await a.link.saveRole({ ...guest, perms: { ...guest.perms, agents: ["view", "chat", "manage"] }, bots: ["pip"] });
  const invite = await a.link.createInvite({ groupId: "g_everyone", days: 7, maxUses: 1 });
  const { serverKey } = lib.parseJoinUrl(invite.link);
  const pending = await b.remote.startTeamJoin({ hosts: [a.address], code: invite.code, serverId: a.link.status().serverId, serverKey, name: "Studio" });
  await a.link.approve(a.link.team().requests[0].id);
  assert.equal((await b.remote.checkTeamJoin(pending.id)).status, "approved");
  b.remote.use(b.remote.list()[0].id);
  await until("the member's view with the voice choices", () => b.remote.state === "online" && b.remote.parts.voice);
  assert.deepEqual(b.remote.snapshot().bots.map((bot) => bot.id), ["pip"]);

  // The card's own calls: the host's choices (what is ready, never a key), and a provider's voices.
  const shared = await b.remote.call("voiceSettings", []);
  assert.deepEqual([shared.ready, shared.providers.openai.hasKey], [true, true]);
  assert.equal(JSON.stringify(shared).includes("sk-owner-private-key"), false);
  assert.deepEqual(await b.remote.call("voiceOptions", ["tts", "device"]), { models: [], voices: [] });
  assert.deepEqual(await b.remote.call("speak", ["Hello", { botId: "pip" }]), { device: true }, "a bot that reads with the shared 'This computer' voice is read by the window");

  // Reading and live voice are saved on the bot, together and apart, and "Same as Settings" clears them.
  const voiceOf = (id) => a.ws.state.bots.find((bot) => bot.id === id).voice;
  await b.remote.call("updateBot", ["pip", { voice: { tts: { provider: "openai", voice: "nova", speed: 1.25 }, live: { provider: "gemini", model: "m-1", voice: "puck" } } }]);
  assert.deepEqual(voiceOf("pip"), { tts: { provider: "openai", voice: "nova", speed: 1.25 }, live: { provider: "gemini", model: "m-1", voice: "puck" } });
  await b.remote.call("updateBot", ["pip", { voice: { live: { provider: "gemini", model: "m-1", voice: "puck" } } }]);
  assert.deepEqual(voiceOf("pip"), { live: { provider: "gemini", model: "m-1", voice: "puck" } });
  await b.remote.call("updateBot", ["pip", { voice: null }]);
  assert.equal(voiceOf("pip"), undefined);

  // Another bot, the shared voice and the keys stay the owner's.
  await assert.rejects(b.remote.call("updateBot", ["scout", { voice: { live: { provider: "openai" } } }]), /isn't available to your team role/);
  assert.equal(voiceOf("scout"), undefined);
  await assert.rejects(b.remote.call("setVoice", [{ tts: { provider: "device" } }]), /can only be done on .* itself/);
  await assert.rejects(b.remote.call("setVoiceKey", ["openai", "sk-member-key"]), /can only be done on .* itself/);
  await assert.rejects(b.remote.client.call("link.voice.key", "openai", "sk-member-key"), /Only the owner/);
});

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
  assert.deepEqual(Object.keys(b.remote.list()[0]).sort(), ["addedAt", "current", "id", "included", "name"]);
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

test("a profile computer without a vault stays in memory and never writes its private key", (t) => {
  const root = tempDir(t);
  const file = join(root, "remote-hosts.json");
  const lib = { LinkClient: class {} };
  const remote = new RemoteHosts({ file, protect: null, lib });
  remote.adoptPairing({ serverId: "profile-server", serverKey: "public-key", secretKey: "profile-private-key", hosts: ["127.0.0.1:1"] }, { name: "Profile computer" });
  assert.equal(remote.list()[0].id, "profile-server");
  assert.equal(readFileSync(file, "utf8").includes("profile-private-key"), false);
  assert.equal(new RemoteHosts({ file, protect: null, lib }).list().length, 0);
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
  // The people in a chat are the host's link's to keep: the window's calls reach it by the link's own names.
  a.link.store.data.team.members.push({ id: "m_blake", name: "Blake", groupId: "g_everyone", joinedAt: 1, deviceIds: [] });
  assert.deepEqual(await b.remote.call("chatPeople", [chatId]), { createdBy: "owner", invited: [] });
  // An invite never widens a role: someone whose role can't use the chat's bot is refused, in the host's words.
  await assert.rejects(b.remote.call("inviteToChat", [chatId, "m_blake"]), /That person's role can't use this chat's bot\. Change their role in Team settings first\./);
  await a.link.saveRole({ ...structuredClone(a.link.team().roles.find((role) => role.id === "r_guest")), bots: "all" });
  assert.deepEqual(await b.remote.call("inviteToChat", [chatId, "m_blake"]), ["m_blake"]);
  assert.deepEqual(a.link.chatPeople(chatId), { createdBy: "owner", invited: ["m_blake"] });
  await until("the chat to say who was invited", () => b.remote.snapshot().chats.find((chat) => chat.id === chatId).invited?.length === 1);
  assert.deepEqual(await b.remote.call("chatPeople", [chatId]), { createdBy: "owner", invited: ["m_blake"] });
  await assert.rejects(b.remote.call("inviteToChat", [chatId, "m_nobody"]), /That person is no longer on the team\./);
  assert.deepEqual(await b.remote.call("removeFromChat", [chatId, "m_blake"]), []);
  assert.deepEqual(await b.remote.call("chatPeople", ["no-such-chat"]), { createdBy: "owner", invited: [] });
  // What a client may not do is refused here, in words, and never reaches the host.
  await assert.rejects(b.remote.call("startPhonePairing", []), /can only be done on .* itself/);
  await assert.rejects(b.remote.call("exportUsage", [30]), /can only be done on .* itself/);
  assert.deepEqual(await b.remote.call("usage", [30]), { days: 30 });
  for (const name of ["snapshot", "viewing", "remoteHosts", "remoteScreen", "pairRemoteHost", "useRemoteHost", "forgetRemoteHost"]) assert.ok(HERE.has(name), name + " runs on this computer whichever host is shown");
  // Back to this computer: the host's state is let go of.
  assert.equal(b.remote.use(null), null);
  assert.deepEqual([b.remote.inUse(), b.remote.state, b.remote.snapshot().bots], [null, "idle", []]);
});

test("choosing the host in use again while it isn't online is Try again: the same link looks for it at once", async (t) => {
  const a = await host(t);
  const b = client(t);
  const { id } = await b.remote.pair({ address: a.address, code: a.link.startPairing().code });
  b.remote.use(id);
  const link = b.remote.client;
  let wakes = [];
  const wake = link.wake.bind(link);
  link.wake = (reason) => (wakes.push(reason), wake(reason));
  assert.equal(b.remote.state, "connecting");
  b.remote.use(id);
  assert.deepEqual(wakes, ["network"], "not online yet: it is tried again, every address included");
  assert.equal(b.remote.client, link, "with the same link, not a new one");
  await until("the host to answer", () => b.remote.state === "online");
  wakes = [];
  b.remote.use(id);
  assert.deepEqual(wakes, [], "online: nothing to try again");
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

test("a resting paired client resumes for one sync and keeps its chat changes", async (t) => {
  const computer = await host(t);
  const pairing = await lib.pair(fetch, { hosts: [computer.address], code: computer.link.startPairing().code }, { name: "Phone", platform: "ios" });
  const parts = {};
  let syncs = 0;
  const phone = new lib.LinkClient(pairing, {
    fetch,
    onState() {},
    onParts: (changes) => Object.assign(parts, changes),
    onSync() {
      syncs++;
      phone.rest();
    },
  });
  t.after(() => phone.stop());
  assert.equal(typeof phone.rest, "function");
  phone.start();
  await until("initial sync", () => syncs === 1);
  const chat = await phone.call("createChat", "pip");
  assert.equal(syncs, 1);
  assert.ok(!parts.chats.some((item) => item.id === chat));
  phone.wake();
  await until("one sync after wake", () => syncs === 2 && parts.chats.some((item) => item.id === chat));
});

test("paired live voice passes its chat and profiles to the provider with location only on request", async (t) => {
  const { ws, link, address } = await host(t);
  const chatId = ws.createChat("pip");
  writeProfile(ws, "pip", { file: "IDENTITY.md", previous: "", text: "I keep the garden journal." });
  writeProfile(ws, "pip", { file: "USER.md", previous: "", text: "Name: Robin\nPrefers Celsius." });
  ws.chat(chatId).messages.push(
    { role: "user", text: "Which seedlings sprouted?" },
    { role: "assistant", text: "CHECKING_SEEDLINGS", interim: true },
    { role: "assistant", text: "The basil sprouted yesterday." }
  );
  const pairing = await lib.pair(fetch, { hosts: [address], code: link.startPairing().code }, { name: "Phone", platform: "ios" });
  const phone = new lib.LinkClient(pairing, { fetch, onState() {}, onParts() {} });
  t.after(() => phone.stop());
  const prompts = [];
  link.voice.live = async ({ instructions }) => {
    prompts.push(instructions);
    return { id: "voice-one" };
  };
  const request = { chatId, botId: "pip", provider: "openai" };
  await phone.call("link.voice.live", request);
  assert.match(prompts[0], /basil sprouted yesterday/);
  assert.match(prompts[0], /keep the garden journal/);
  assert.match(prompts[0], /Prefers Celsius/);
  assert.match(prompts[0], /person's name is Robin/);
  assert.doesNotMatch(prompts[0], /CHECKING_SEEDLINGS|The person is near/);
  await phone.call("link.voice.live", { ...request, context: { location: { place: "Greenhouse", latitude: 45.1234, longitude: -90.2345 } } });
  assert.match(prompts[1], /Greenhouse \(45\.12, -90\.23\)/);
  await assert.rejects(phone.call("link.voice.live", { ...request, context: { location: { latitude: 999, longitude: 0 } } }), /location/i);
  assert.equal(prompts.length, 2);
});
