// Gadgets (gadget/docs/contract.md, link-host/gadget.mjs): a small device is paired by introduction,
// with no code; it follows two small parts instead of the whole app; what it says and hears goes
// through the computer as plain samples; and it is the owner's, so a bot's request is its to answer.
// The "gadget" here is the phone's own link client with a gadget's key: the firmware speaks the same link.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { b64u, newKeyPair } from "../link-host/crypto.mjs";
import { gadgetPart, pcmFromWav, resample, speakable, splitForSpeech } from "../link-host/gadget.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { wavFromPcm } from "../link-host/voice.mjs";
import { speakable as phoneSpeakable, splitForSpeech as phoneSplit } from "../src/features/voice/speakable";
import { type FetchLike, LinkClient, type LinkState, type Pairing, checkJoin, pair, startJoin } from "../src/link/client";
import type { GadgetIntroduction, GadgetPart, Meta, PairedDevice } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const folder = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  folders.push(dir);
  return dir;
};
async function until(check: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
function follow(pairing: Pairing) {
  const parts: Record<string, any> = {};
  const states: LinkState[] = [];
  const names = new Set<string>();
  const phases: string[] = [];
  let written = "";
  const client = new LinkClient(pairing, {
    fetch: real,
    streamAppends: true,
    onParts(next) {
      for (const name of Object.keys(next)) names.add(name.startsWith("text:") ? "text:" : name);
      Object.assign(parts, next);
      const phase = (next.gadget as GadgetPart | undefined)?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
      for (const [name, value] of Object.entries(next)) if (name.startsWith("text:") && value) written = (value as { stream: string }).stream;
    },
    onState: (state) => void states.push(state),
  });
  client.start();
  return { client, parts, states, names, phases, pairing, written: () => written, gadget: () => parts.gadget as GadgetPart };
}

/** A tone as 16-bit mono samples: what a gadget's microphone sends. */
function tone(seconds: number, rate: number) {
  const pcm = Buffer.alloc(Math.floor(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return pcm;
}

/** The computer's own speech: it "hears" a fixed sentence and "says" one second of tone for each 20 characters, at 24 kHz. */
const heard: { bytes: number; rate: number }[] = [];
const said: string[] = [];
const voice = {
  local: {
    models: () => [
      { id: "ears", name: "Ears", kind: "stt", installed: true },
      { id: "mouth", name: "Mouth", kind: "tts", installed: true, voices: ["one"] },
    ],
    transcribe: async (wav: Buffer) => {
      const { pcm, rate } = pcmFromWav(wav);
      heard.push({ bytes: pcm.length, rate });
      return { text: "Plan the launch week" };
    },
    synthesize: async (text: string) => {
      said.push(text);
      return { audio: wavFromPcm(tone(text.length / 20, 24000), 24000) };
    },
  },
};

async function host() {
  const backend = new MockBackend({ speed: 0.05 }) as MockBackend & { voice?: unknown };
  backend.voice = voice;
  const link = new LinkHost({ relay: false, dir: folder("botkins-gadget-"), backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  link.voice.set({ stt: { provider: "local" }, tts: { provider: "local" } });
  const at = "127.0.0.1:" + link.port;
  const phone = follow(await pair(real, { hosts: [at], code: link.startPairing().code }, { name: "Phone", platform: "ios" }));
  await until(() => phone.states.at(-1) === "online", "the phone online");
  return { link, backend, at, phone };
}
/** A gadget's key pair, and the pairing it holds once someone introduced it. */
function newGadget() {
  const keys = newKeyPair();
  const pairing = (intro: GadgetIntroduction): Pairing => ({ serverId: intro.serverId, serverKey: intro.serverKey, deviceId: intro.deviceId, secretKey: b64u(keys.privateKey), hosts: intro.hosts, name: intro.name });
  return { publicKey: b64u(keys.publicKey), pairing };
}

test("a phone introduces a gadget by its key, and the gadget opens a session with no code", async () => {
  const { link, phone } = await host();
  assert.ok((phone.parts.meta as Meta).capabilities.includes("gadgets-v1"));
  const device = newGadget();
  const intro = await phone.client.call<GadgetIntroduction>("link.gadgets.add", { publicKey: device.publicKey, name: "Desk gadget", board: "esp32-s3-box-3", botId: "bot-mira" });
  // What the gadget is handed: who the computer is and where, never a secret.
  assert.deepEqual(Object.keys(intro).sort(), ["deviceId", "hosts", "name", "serverId", "serverKey"]);
  assert.equal(link.status().pairing, null, "no pairing code was opened");

  const gadget = follow(device.pairing(intro));
  await until(() => gadget.states.at(-1) === "online" && !!gadget.parts.gadget, "the gadget online");
  // It follows two parts and nothing else of the app: no bots with their instructions, no chats, no settings.
  assert.deepEqual([...gadget.names].sort(), ["gadget", "meta"]);
  assert.deepEqual((gadget.parts.meta as Meta).you, { kind: "gadget", deviceId: intro.deviceId });
  assert.equal(gadget.gadget().bot?.id, "bot-mira");
  assert.equal(gadget.gadget().phase, "idle");
  assert.deepEqual(gadget.gadget().voice, { hear: true, speak: true });
  assert.ok(JSON.stringify(gadget.parts).length < 6000, "a gadget's whole state stays small");

  // The phone's device list names it as a gadget, with its board.
  const list = await phone.client.call<PairedDevice[]>("link.devices.list");
  const listed = list.find((item) => item.id === intro.deviceId)!;
  assert.deepEqual([listed.name, listed.kind, listed.platform, listed.connected], ["Desk gadget", "gadget", "esp32", true]);
  assert.deepEqual(listed.gadget, { board: "esp32-s3-box-3", botId: "bot-mira", settings: { volume: 60, mic: "normal", mute: false, brightness: 80, dimAfter: 30, offAfter: 300 } });

  // A key nobody introduced is a stranger, and a bad key is refused in words.
  // (The gadget's id with another key: the session's box doesn't open, so it never gets in.)
  const stranger = follow(newGadget().pairing(intro));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(!stranger.states.includes("online") && !stranger.parts.gadget, "a stranger is not served");
  await assert.rejects(phone.client.call("link.gadgets.add", { publicKey: "AAAA" }), /isn't a gadget's key/);
  await assert.rejects(phone.client.call("link.gadgets.add", { publicKey: newGadget().publicKey, botId: "bot-nobody" }), /no longer exists/);
  // Introduced again (its settings were reset on the computer's side, or it goes to another bot), it has one entry.
  const again = await phone.client.call<GadgetIntroduction>("link.gadgets.add", { publicKey: device.publicKey, name: "Desk gadget" });
  assert.notEqual(again.deviceId, intro.deviceId);
  assert.equal((await phone.client.call<PairedDevice[]>("link.devices.list")).filter((item) => item.kind === "gadget").length, 1);
  await until(() => gadget.states.includes("revoked"), "the earlier entry ended");

  for (const each of [gadget, stranger, phone]) each.client.stop();
  await link.stop();
});

test("the computer's own app introduces a gadget too, and a gadget's calls are a gadget's only", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const gadget = follow(device.pairing(link.addGadget({ publicKey: device.publicKey, board: "m5-atom-echo" })));
  await until(() => gadget.states.at(-1) === "online" && !!gadget.parts.gadget, "the gadget online");
  // With no name given it is named by its board; with no bot, the first bot on show.
  assert.equal(gadget.gadget().name, "m5-atom-echo");
  assert.ok(gadget.gadget().bot?.id);
  await assert.rejects(phone.client.call("link.gadget.say", { text: "Hello" }), /Only a gadget can do that/);
  await assert.rejects(phone.client.call("link.gadget.hello", { board: "x" }), /Only a gadget can do that/);

  // What it says of itself is kept, cut to plain words; the rate of its speaker decides the samples it is sent.
  assert.deepEqual(await gadget.client.call("link.gadget.hello", { board: "m5-atom-echo", firmware: "0.1.0 <script>", rate: 16000, screen: { width: 240, height: 240, round: true }, secret: "x" }), { rate: 16000 });
  const kept = link.status().devices.find((item: PairedDevice) => item.kind === "gadget").gadget;
  assert.deepEqual(kept, { board: "m5-atom-echo", firmware: "0.1.0 script", rate: 16000, screen: { width: 240, height: 240, round: true } });

  // Removed on the phone, it is a stranger at once.
  const id = (gadget.parts.meta as Meta & { you: { deviceId: string } }).you.deviceId;
  await phone.client.call("link.devices.remove", id);
  await until(() => gadget.states.includes("revoked"), "the gadget revoked");
  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("typed words start a chat with the gadget's bot, the reply streams, and the phone sees the same chat", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const gadget = follow(device.pairing(link.addGadget({ publicKey: device.publicKey, name: "Desk gadget", botId: "bot-mira" })));
  await until(() => !!gadget.parts.gadget, "the gadget's part");
  assert.equal(gadget.gadget().chat, null);

  const { chatId } = await gadget.client.call<{ chatId: string }>("link.gadget.say", { text: "Plan the launch week" });
  gadget.client.watch([chatId]);
  await until(() => gadget.gadget().chat?.id === chatId, "the gadget's chat");
  await until(() => gadget.gadget().phase === "idle" && !!gadget.gadget().reply, "the reply");
  // The face went through the turn, and the text came as it was written.
  assert.ok(gadget.phases.includes("working") || gadget.phases.includes("writing"), "phases: " + gadget.phases.join(","));
  assert.ok(gadget.names.has("text:"), "the reply's text was streamed");
  assert.ok(gadget.written().length > 0);
  const reply = gadget.gadget().reply!;
  assert.equal(reply.id.slice(0, reply.id.lastIndexOf(":")), chatId);
  assert.ok(reply.text.length > 0 && reply.parts >= 1);
  assert.ok(!/[*_#`]/.test(reply.text), "the reply is plain words for a small screen");
  // Still two parts: the chat's page and its run never went to the gadget.
  assert.deepEqual([...gadget.names].sort(), ["gadget", "meta", "text:"]);

  // It is an ordinary chat of the owner's: the phone lists it, with the gadget's words in it.
  await until(() => (phone.parts.chats as { id: string }[]).some((chat) => chat.id === chatId), "the chat on the phone");
  const page = await phone.client.call<{ messages: { role: string; text: string }[] }>("link.messages", chatId);
  assert.deepEqual(page.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(page.messages[0].text, "Plan the launch week");

  // The next words go to the same chat; "newChat" starts another with the next thing said.
  assert.equal((await gadget.client.call<{ chatId: string }>("link.gadget.say", { text: "And the week after" })).chatId, chatId);
  await until(() => gadget.gadget().phase === "idle" && gadget.gadget().reply?.id !== reply.id, "the second reply");
  assert.deepEqual(await gadget.client.call("link.gadget.set", { newChat: true }), { botId: "bot-mira" });
  await until(() => gadget.gadget().chat === null, "no chat");
  const next = await gadget.client.call<{ chatId: string }>("link.gadget.say", { text: "Something else" });
  assert.notEqual(next.chatId, chatId);
  // Another bot: the chat with the one before is left.
  await until(() => gadget.gadget().phase === "idle", "the turn over");
  assert.deepEqual(await gadget.client.call("link.gadget.set", { botId: "bot-quill" }), { botId: "bot-quill" });
  await until(() => gadget.gadget().bot?.id === "bot-quill" && gadget.gadget().chat === null, "the other bot");
  await assert.rejects(gadget.client.call("link.gadget.set", { botId: "bot-nobody" }), /no longer exists/);
  await assert.rejects(gadget.client.call("link.gadget.say", { text: "  " }), /nothing to send/);

  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("a recording goes up in pieces and is heard once; the reply comes back as samples at the gadget's rate", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const gadget = follow(device.pairing(link.addGadget({ publicKey: device.publicKey, botId: "bot-mira" })));
  await until(() => !!gadget.parts.gadget, "the gadget's part");
  await gadget.client.call("link.gadget.hello", { board: "test", rate: 16000 });
  heard.length = 0;
  said.length = 0;

  // Two seconds at 16 kHz, in four pieces, as a gadget sends them while the button is held.
  const recording = tone(2, 16000);
  const piece = recording.length / 4;
  for (let i = 0; i < 4; i++) {
    const answer = await gadget.client.call<{ got?: number; text?: string; chatId?: string }>("link.gadget.hear", { take: "t1", rate: 16000, audio: recording.subarray(i * piece, (i + 1) * piece).toString("base64"), ...(i === 3 && { last: true }) });
    if (i < 3) assert.deepEqual(answer, { got: (i + 1) * piece });
    else {
      assert.equal(answer.text, "Plan the launch week");
      gadget.client.watch([answer.chatId!]);
    }
  }
  // The computer's speech model got the whole of it, once, at the rate it was recorded.
  assert.deepEqual(heard, [{ bytes: recording.length, rate: 16000 }]);
  await until(() => gadget.gadget().phase === "idle" && !!gadget.gadget().reply, "the reply");
  const reply = gadget.gadget().reply!;

  // Read aloud: each part as 16-bit samples at 16 kHz (the model made 24 kHz), fetched a slice at a time.
  type Spoken = { audio: string; from: number; total: number; rate: number; part: number; parts: number };
  const first = await gadget.client.call<Spoken>("link.gadget.speak", { reply: reply.id, part: 0, max: 8000 });
  assert.deepEqual([first.from, first.rate, first.part, first.parts], [0, 16000, 0, reply.parts]);
  assert.equal(Buffer.from(first.audio, "base64").length, 8000);
  const samples = [Buffer.from(first.audio, "base64")];
  for (let from = 8000; from < first.total; from += 8000) samples.push(Buffer.from((await gadget.client.call<Spoken>("link.gadget.speak", { reply: reply.id, part: 0, from, max: 8000 })).audio, "base64"));
  const whole = Buffer.concat(samples);
  assert.equal(whole.length, first.total);
  // One second for each 20 characters at 24 kHz, so two thirds as many samples at 16 kHz.
  const expected = Math.floor((Math.floor((said[0].length / 20) * 24000) * 16000) / 24000) * 2;
  assert.equal(whole.length, expected);
  // The samples are the tone, not noise: its loudest sample is near the tone's.
  let peak = 0;
  for (let i = 0; i < whole.length; i += 2) peak = Math.max(peak, Math.abs(whole.readInt16LE(i)));
  assert.ok(peak > 6500 && peak <= 8000, "peak " + peak);
  // A part is made once however many slices are fetched, and the part after it is made ahead.
  assert.equal(said.filter((text) => text === said[0]).length, 1);
  if (reply.parts > 1) await until(() => said.length >= 2, "the next part made ahead");
  await assert.rejects(gadget.client.call("link.gadget.speak", { reply: reply.id, part: reply.parts }), /no more to read/);
  await assert.rejects(gadget.client.call("link.gadget.speak", { reply: "chat-nope:0", part: 0 }), /reply is gone/);
  // Another rate when asked for.
  assert.equal((await gadget.client.call<Spoken>("link.gadget.speak", { reply: reply.id, part: 0, rate: 24000, max: 2000 })).rate, 24000);

  // A slip of the button, a recording given up, and one with no end.
  await assert.rejects(gadget.client.call("link.gadget.hear", { take: "t2", rate: 16000, audio: tone(0.1, 16000).toString("base64"), last: true }), /too short/);
  await gadget.client.call("link.gadget.hear", { take: "t3", rate: 16000, audio: tone(1, 16000).toString("base64") });
  assert.deepEqual(await gadget.client.call("link.gadget.hear", { take: "t3", cancel: true }), { got: 0 });
  await assert.rejects(gadget.client.call("link.gadget.hear", { take: "t4", rate: 12345, audio: "" }), /rate/);
  await assert.rejects(gadget.client.call("link.gadget.hear", { take: "bad name!", rate: 16000, audio: "" }), /no name/);
  assert.equal(heard.length, 1, "nothing else was transcribed");

  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("a gadget is the owner's: it sees a bot's request and answers it itself", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const gadget = follow(device.pairing(link.addGadget({ publicKey: device.publicKey, botId: "bot-mira" })));
  await until(() => !!gadget.parts.gadget, "the gadget's part");
  const { chatId } = await gadget.client.call<{ chatId: string }>("link.gadget.say", { text: "Please approve the deploy" });
  await until(() => gadget.gadget().phase === "request", "the request");
  const request = gadget.gadget().request!;
  assert.deepEqual([request.kind, request.title, request.remember], ["permission", "Run a command", true]);
  assert.ok(request.preview?.includes("npm run deploy"));
  await gadget.client.call("respond", request.id, { action: "approve" });
  await until(() => gadget.gadget().phase === "idle" && !!gadget.gadget().reply, "the reply");
  assert.match(gadget.gadget().reply!.text, /deploy finished/);
  assert.equal(gadget.gadget().chat?.id, chatId);
  // Anything else the owner may call, a gadget may call: nothing is cut from it.
  assert.ok(Array.isArray(await gadget.client.call("models")));
  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("gadgets are the owner's: a team member can't add one, and a member's device that calls itself a gadget is a member's phone", async () => {
  const { link, at, phone } = await host();
  // A member joins, and their device says it is a gadget.
  const invite = await phone.client.call<{ code: string }>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
  const target = { hosts: [at], code: invite.code, serverId: link.status().serverId, serverKey: b64u(link.store.data.keys.publicKey), name: link.status().name };
  const started = await startJoin(real, target, { name: "Sam's thing", platform: "esp32", kind: "gadget" as unknown as "phone" });
  if (started.result.status !== "pending") throw new Error("not pending");
  await phone.client.call("link.team.approve", started.result.requestId);
  const joined = await checkJoin(real, started.attempt);
  if (joined.status !== "approved") throw new Error("not approved");
  const member = follow(joined.pairing);
  await until(() => member.states.at(-1) === "online" && !!member.parts.meta, "the member online");
  // It is kept as a phone, and sent a member's cut of the app: never the gadget's part, which is made from the owner's own.
  assert.equal(link.store.data.devices.find((device: { memberId?: string }) => device.memberId).kind, "phone");
  assert.equal((member.parts.meta as Meta).you?.kind, "member");
  assert.ok(!member.names.has("gadget") && member.names.has("bots"));
  // Neither a gadget's calls nor naming a gadget are a member's.
  await assert.rejects(member.client.call("link.gadgets.add", { publicKey: newGadget().publicKey }), /Only the owner can do that/);
  await assert.rejects(member.client.call("link.gadget.say", { text: "Hello" }), /Only the owner can do that/);
  await assert.rejects(member.client.call("link.gadget.hello", {}), /Only the owner can do that/);
  await assert.rejects(member.client.call("link.gadgets.configure", "any", { volume: 10 }), /Only the owner can do that/);
  await assert.rejects(member.client.call("link.gadgets.wifi", "any", { forget: "Home" }), /Only the owner can do that/);
  await assert.rejects(member.client.call("link.gadgets.restart", "any"), /Only the owner can do that/);
  assert.equal(link.status().devices.filter((device: PairedDevice) => device.kind === "gadget").length, 0);

  // A key some phone paired with is not a gadget's to take: the phone stays paired.
  const phoneKey = link.store.data.devices.find((device: { id: string }) => device.id === phone.pairing.deviceId).publicKey;
  await assert.rejects(phone.client.call("link.gadgets.add", { publicKey: phoneKey }), /belongs to another paired device/);
  assert.ok(Array.isArray(await phone.client.call("models")), "the phone is still served");
  for (const each of [member, phone]) each.client.stop();
  await link.stop();
});

test("a gadget is sent its bot's Botkin in each pose, and a new look gives it new faces", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const gadget = follow(device.pairing(link.addGadget({ publicKey: device.publicKey, botId: "bot-mira" })));
  await until(() => !!gadget.gadget()?.face, "the gadget's face");
  const first = gadget.gadget().face!.look;
  type Face = { look: string; pose: string; svg: string };
  for (const pose of ["ready", "listening", "working", "speaking", "needs", "waiting", "sleepy"]) {
    const face = await gadget.client.call<Face>("link.gadget.face", { pose });
    assert.equal(face.look, first);
    assert.match(face.svg, /^<svg [^>]*viewBox="0 0 256 256"/);
    // Nothing that moves, nothing a gadget can't draw.
    assert.ok(!/<style|<title|<animate/.test(face.svg), pose + " has nothing that moves");
  }
  // Speaking and listening are told apart by the eyes.
  const listening = await gadget.client.call<Face>("link.gadget.face", { pose: "listening" });
  const speaking = await gadget.client.call<Face>("link.gadget.face", { pose: "speaking" });
  assert.notEqual(listening.svg, speaking.svg);
  await assert.rejects(gadget.client.call("link.gadget.face", { pose: "dancing" }), /isn't a pose/);
  await assert.rejects(phone.client.call("link.gadget.face", { pose: "ready" }), /Only a gadget can do that/);

  // The bot gets another look on the phone: the gadget is told its faces are new.
  await phone.client.call("link.setLook", "bot-mira", { head: "spool", palette: "honey" });
  await until(() => gadget.gadget().face?.look !== first, "a new look");
  assert.match((await gadget.client.call<Face>("link.gadget.face", { pose: "ready" })).svg, /^<svg/);

  // Without the design kit there are no faces: the part says nothing of them, and asking says why.
  const plain = new LinkHost({ relay: false, dir: folder("botkins-gadget-plain-"), backend: new MockBackend({ speed: 0.05 }), port: 0, extraHosts: ["127.0.0.1"], botkins: null });
  await plain.setEnabled(true);
  const other = newGadget();
  const bare = follow(other.pairing(plain.addGadget({ publicKey: other.publicKey })));
  await until(() => !!bare.parts.gadget, "the gadget's part");
  assert.equal(bare.gadget().face, undefined);
  await assert.rejects(bare.client.call("link.gadget.face", { pose: "ready" }), /can't draw Botkins/);
  for (const each of [gadget, bare, phone]) each.client.stop();
  await link.stop();
  await plain.stop();
});

test("the owner sets a gadget's volume, microphone and screen from a phone, and the gadget's own changes reach the phone", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const intro = link.addGadget({ publicKey: device.publicKey, botId: "bot-mira" });
  const gadget = follow(device.pairing(intro));
  await until(() => !!gadget.parts.gadget, "the gadget's part");
  assert.deepEqual(gadget.gadget().settings, { volume: 60, mic: "normal", mute: false, brightness: 80, dimAfter: 30, offAfter: 300 });
  assert.ok((phone.parts.meta as Meta).capabilities.includes("gadget-settings-v1"));

  const listed = await phone.client.call<PairedDevice[]>("link.gadgets.configure", intro.deviceId, { volume: 35, mic: "high", dimAfter: 60 });
  assert.deepEqual(listed.find((item) => item.id === intro.deviceId)!.gadget!.settings, { volume: 35, mic: "high", mute: false, brightness: 80, dimAfter: 60, offAfter: 300 });
  await until(() => gadget.gadget().settings.volume === 35 && gadget.gadget().settings.mic === "high", "the new settings on the gadget");
  // A bad value changes nothing, also the good ones beside it.
  await assert.rejects(phone.client.call("link.gadgets.configure", intro.deviceId, { volume: 101, brightness: 50 }), /Volume is from 0 to 100/);
  await assert.rejects(phone.client.call("link.gadgets.configure", intro.deviceId, { mic: "loud" }), /low, normal or high/);
  assert.equal(link.status().devices.find((item: { id: string }) => item.id === intro.deviceId).gadget.settings.brightness, undefined);
  await assert.rejects(phone.client.call("link.gadgets.configure", "nobody", { volume: 10 }), /no longer paired/);
  await assert.rejects(phone.client.call("link.gadgets.configure", phone.pairing.deviceId, { volume: 10 }), /no longer paired/);

  // The person mutes the microphone on the gadget itself: the phone's list says so.
  await gadget.client.call("link.gadget.set", { settings: { mute: true } });
  await until(() => gadget.gadget().settings.mute, "muted on the gadget");
  assert.equal((await phone.client.call<PairedDevice[]>("link.devices.list")).find((item) => item.id === intro.deviceId)!.gadget!.settings!.mute, true);

  // Another bot, chosen on the phone: the gadget talks with it in a new chat.
  await gadget.client.call("link.gadget.say", { text: "Hello" });
  await until(() => !!gadget.gadget().chat, "a chat");
  await phone.client.call("link.gadgets.configure", intro.deviceId, { botId: "bot-quill" });
  await until(() => gadget.gadget().bot?.id === "bot-quill" && gadget.gadget().chat === null, "the other bot, no chat");
  await assert.rejects(phone.client.call("link.gadgets.configure", intro.deviceId, { botId: "bot-nobody" }), /no longer exists/);
  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("a Wi-Fi network and a restart go to the gadget once, and a password is kept nowhere but on its way", async () => {
  const { link, phone } = await host();
  const device = newGadget();
  const intro = link.addGadget({ publicKey: device.publicKey });
  const gadget = follow(device.pairing(intro));
  await until(() => !!gadget.parts.gadget, "the gadget's part");
  // The gadget says which networks it knows: names only.
  await gadget.client.call("link.gadget.hello", { board: "test", wifi: { network: "Home network", saved: ["Home network", "Studio", "Home network"], signal: -58, password: "nope" } });
  const shown = () => phone.client.call<PairedDevice[]>("link.devices.list").then((list) => list.find((item) => item.id === intro.deviceId)!.gadget!);
  assert.deepEqual((await shown()).wifi, { network: "Home network", saved: ["Home network", "Studio"], signal: -58 });

  assert.deepEqual(await phone.client.call("link.gadgets.wifi", intro.deviceId, { add: { ssid: "Cabin", password: "pine-needles-9" } }), { queued: true });
  await until(() => (gadget.gadget().wifi?.changes.length ?? 0) === 1, "the change on the gadget");
  const change = gadget.gadget().wifi!.changes[0] as { id: string; add: { ssid: string; password: string } };
  assert.deepEqual(change.add, { ssid: "Cabin", password: "pine-needles-9" });
  // The phone sees that it waits, by name; the password is in no list, status or file.
  assert.deepEqual((await shown()).wifiWaiting, [{ add: "Cabin" }]);
  assert.ok(!JSON.stringify(await phone.client.call("link.devices.list")).includes("pine-needles-9"));
  assert.ok(!JSON.stringify(link.status()).includes("pine-needles-9"));
  assert.ok(!readFileSync(join(link.store.dir ?? "", "link.json"), "utf8").includes("pine-needles-9"));
  assert.ok(!(phone.parts.phones && JSON.stringify(phone.parts.phones).includes("pine-needles-9")));
  // Taken: it leaves the part and the list.
  await gadget.client.call("link.gadget.set", { wifiDone: [change.id] });
  await until(() => !gadget.gadget().wifi, "the change taken");
  assert.equal((await shown()).wifiWaiting, undefined);

  await phone.client.call("link.gadgets.wifi", intro.deviceId, { forget: "Studio" });
  await until(() => (gadget.gadget().wifi?.changes[0] as { forget?: string } | undefined)?.forget === "Studio", "a network to forget");
  await assert.rejects(phone.client.call("link.gadgets.wifi", intro.deviceId, { add: { ssid: "Cabin", password: "short" } }), /8 to 63 characters/);
  await assert.rejects(phone.client.call("link.gadgets.wifi", intro.deviceId, { add: { ssid: "", password: "" } }), /network's name/);

  // A restart: the gadget says it is restarting, and the request is gone.
  assert.equal(await phone.client.call("link.gadgets.restart", intro.deviceId), null);
  await until(() => typeof gadget.gadget().restart === "string", "the restart on the gadget");
  assert.equal((await shown()).restarting, true);
  await gadget.client.call("link.gadget.set", { restarting: gadget.gadget().restart });
  await until(() => gadget.gadget().restart === undefined, "the restart taken");
  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("a computer with no speech provider says so, and the gadget is told in words", async () => {
  const { link, phone } = await host();
  link.voice.set({ stt: { provider: "device" }, tts: { provider: "device" } });
  const device = newGadget();
  const gadget = follow(device.pairing(link.addGadget({ publicKey: device.publicKey })));
  await until(() => !!gadget.parts.gadget, "the gadget's part");
  assert.deepEqual(gadget.gadget().voice, { hear: false, speak: false });
  await assert.rejects(gadget.client.call("link.gadget.hear", { take: "t1", rate: 16000, audio: tone(1, 16000).toString("base64"), last: true }), /does its own speech/);
  for (const each of [gadget, phone]) each.client.stop();
  await link.stop();
});

test("words for a gadget are the phone's words, in smaller parts", () => {
  const samples = [
    "# Launch plan\n\n- **Monday**: write the post\n- Tuesday: [ship it](https://example.com/x)\n\n```js\nconsole.log(1)\n```\n\nSee https://botkins.app/docs for more.",
    "A short answer.",
    "| Day | Task |\n| --- | --- |\n| Mon | Write |\n\n> Quoted *text* and `code`.",
    "One long sentence with no end that keeps going and going, past the first part's size, past the second part's size, so that it has to be cut at a comma or at a space somewhere along the way, and then some more words follow to make it longer still, and longer, and longer, until it is done",
  ];
  for (const sample of samples) {
    assert.equal(speakable(sample), phoneSpeakable(sample));
    // The same cut as the phone's when the phone's parts are held to a gadget's size.
    const parts = splitForSpeech(speakable(sample));
    assert.equal(parts.join(" "), phoneSplit(phoneSpeakable(sample)).join(" "));
    assert.ok(parts.every((part) => part.length <= 240), "a part's samples stay small");
  }
  assert.deepEqual(splitForSpeech(""), []);
});

test("samples: a WAV file of any common kind becomes 16-bit mono, and a rate becomes another", () => {
  const mono = tone(0.5, 24000);
  assert.deepEqual(pcmFromWav(wavFromPcm(mono, 24000)), { pcm: mono, rate: 24000 });
  // Stereo 16-bit: the two channels are averaged.
  const stereo = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length / 2; i++) {
    stereo.writeInt16LE(mono.readInt16LE(i * 2), i * 4);
    stereo.writeInt16LE(mono.readInt16LE(i * 2), i * 4 + 2);
  }
  const header = wavFromPcm(stereo, 24000);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(24000 * 4, 28);
  header.writeUInt16LE(4, 32);
  assert.deepEqual(pcmFromWav(header), { pcm: mono, rate: 24000 });
  // A stream whose header never learned its length: the samples run to the end.
  const open = wavFromPcm(mono, 24000);
  open.writeUInt32LE(0xffffffff, 40);
  assert.equal(pcmFromWav(open).pcm.length, mono.length);
  assert.throws(() => pcmFromWav(Buffer.from("ID3 not a wav file at all, only some bytes here..")), /not a WAV/);

  assert.equal(resample(mono, 24000, 24000), mono);
  const down = resample(mono, 24000, 16000);
  assert.equal(down.length, Math.floor((mono.length / 2) * (16000 / 24000)) * 2);
  const up = resample(tone(0.5, 16000), 16000, 24000);
  assert.equal(up.length, 0.5 * 24000 * 2);
  // A 440 Hz tone survives both ways at nearly its loudness.
  for (const out of [down, up]) {
    let peak = 0;
    for (let i = 0; i < out.length; i += 2) peak = Math.max(peak, Math.abs(out.readInt16LE(i)));
    assert.ok(peak > 7000 && peak <= 8000, "peak " + peak);
  }
});

test("the gadget's part: one small object for the face, the request and the reply", () => {
  const device = { name: "Desk", gadget: { botId: "b2" } };
  const bots = [{ id: "b1", name: "Mira" }, { id: "b2", name: "Quill", look: { head: "owl", palette: "fern" } }, { id: "b3", name: "Hidden", hidden: true }];
  const idle = gadgetPart({ device, bots, voice: { hear: true, speak: false, live: "gemini" } });
  assert.deepEqual(idle, { name: "Desk", bot: { id: "b2", name: "Quill", look: { head: "owl", palette: "fern" } }, bots: [{ id: "b1", name: "Mira" }, { id: "b2", name: "Quill" }], chat: null, phase: "idle", voice: { hear: true, speak: false, live: "gemini" }, settings: { volume: 60, mic: "normal", mute: false, brightness: 80, dimAfter: 30, offAfter: 300 } });
  // What the computer adds: the steps of a working turn, the face's name, waiting Wi-Fi changes and a restart.
  const extras = gadgetPart({ device: { name: "Desk", gadget: { settings: { volume: 20 } } }, bots, chat: { id: "c1", botId: "b1", title: "T", messages: [] }, live: { active: ["c1"], streams: { c1: "" }, requests: [] }, steps: 3, face: { look: "abc" }, wifi: [{ id: "w1", forget: "Studio" }], restart: "r1" });
  assert.deepEqual([extras.steps, extras.face, extras.wifi, extras.restart, extras.settings.volume, extras.settings.mic], [3, { look: "abc" }, { changes: [{ id: "w1", forget: "Studio" }] }, "r1", 20, "normal"]);
  const chat = { id: "c1", botId: "b1", title: "Launch", messages: [{ role: "user", text: "Hi" }, { role: "assistant", text: "**Hello** there." }] };
  // The chat's bot wins over the gadget's saved one; the reply is the newest thing the bot said.
  const done = gadgetPart({ device, bots, chat, live: { active: [], streams: {}, requests: [] } });
  assert.equal(done.bot?.id, "b1");
  assert.deepEqual(done.reply, { id: "c1:1", text: "Hello there.", parts: 1 });
  // While a turn runs there is no reply yet: the text comes as it is written.
  const working = gadgetPart({ device, bots, chat, live: { active: ["c1"], streams: { c1: "" }, intents: { c1: "Reading the plan" }, requests: [] } });
  assert.deepEqual([working.phase, working.doing, working.reply], ["working", "Reading the plan", undefined]);
  assert.equal(gadgetPart({ device, bots, chat, live: { active: ["c1"], streams: { c1: "Sure" }, requests: [] } }).phase, "writing");
  // The person spoke last: nothing of the bot's to read again.
  assert.equal(gadgetPart({ device, bots, chat: { ...chat, messages: [...chat.messages, { role: "user", text: "More" }] } }).reply, undefined);
});
