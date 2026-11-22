// Gadgets: small devices with a microphone, a speaker and maybe a screen (an ESP32 board) that
// talk with a bot through the link. The contract a gadget builds against is gadget/docs/contract.md.
//
// A gadget is one more paired device, of kind "gadget". It is the owner's: what a bot may do in a
// chat started from a gadget is what it may do in any of the owner's chats, and the gadget answers
// a bot's requests itself. What differs is what it is sent. A phone follows the whole app; a gadget
// has a few hundred kilobytes of memory, so it follows two small parts ("meta" and "gadget") and the
// text of the reply being written, and the computer does the work a phone does for itself: it
// turns speech into text, text into plain samples at the gadget's rate, and Markdown into words.
//
// Pairing by introduction ("link.gadgets.add", `LinkHost.addGadget`): a device that is already
// trusted (the computer's own app, or a paired owner device) read the gadget's public key over a
// cable or a few meters of radio, and names it here. The gadget gets back this computer's key and
// addresses and opens a session like any device. No code is typed on either side.
import { createHash } from "node:crypto";
import { agree } from "./crypto.mjs";
import { Failure } from "./tools.mjs";
import { wavFromPcm } from "./voice.mjs";

export const GADGET_CAPABILITY = "gadgets-v1";
/** The newest reply as a gadget is sent it. A screen shows a page or two; the whole of it is still spoken. */
export const MAX_REPLY = 2000;
const MAX_BOTS = 24;
const MAX_CHOICES = 6;
/** One recording: a minute and a half at 24 kHz. */
const MAX_HEAR = 4_500_000;
const HEAR_IDLE_MS = 60_000;
/** Samples for one call: a second or so by default, so a gadget plays while it fetches. */
const SLICE = { min: 2_000, normal: 32_000, max: 512_000 };
const RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const SPOKEN_KEPT = 12;
const SPOKEN_MS = 5 * 60_000;
/** The most of a reply that is made into words: far more than a voice reads in one go, and it bounds the work. */
const MAX_SPEAKABLE = 20_000;
const TAKE = /^[A-Za-z0-9_-]{1,40}$/;

const clip = (text, limit) => (text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text);
const line = (value, limit) => clip(String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), limit);

/** What a gadget may say about itself: letters, digits and a few marks, kept short. */
const label = (value, limit = 40) => (typeof value === "string" ? value.replace(/[^\w .:+()/-]/g, "").trim().slice(0, limit) : "");

/** The key and names of a gadget being introduced. Throws a sentence a person can read. */
export function cleanIntroduction(input) {
  let key;
  try {
    key = Buffer.from(String(input?.publicKey ?? ""), "base64url");
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32 || key.every((byte) => byte === 0)) throw new Failure("That isn't a gadget's key.");
  const botId = typeof input?.botId === "string" && input.botId.length <= 200 ? input.botId : "";
  return { publicKey: key, name: typeof input?.name === "string" ? input.name : "", board: label(input?.board), ...(botId && { botId }) };
}

/** What a gadget said of itself in "link.gadget.hello", cut to what is kept. */
export function cleanHello(input) {
  const rate = Number(input?.rate);
  const screen = input?.screen;
  const size = (n) => Number.isInteger(n) && n > 0 && n <= 4096;
  return {
    ...(label(input?.board) && { board: label(input.board) }),
    ...(label(input?.firmware) && { firmware: label(input.firmware) }),
    ...(RATES.includes(rate) && { rate }),
    ...(size(screen?.width) && size(screen?.height) && { screen: { width: screen.width, height: screen.height, ...(screen.round === true && { round: true }) } }),
    ...(input?.mic === false && { mic: false }),
    ...(input?.speaker === false && { speaker: false }),
  };
}

/** The id a gadget names a reply by: the chat and the message's place in it. */
const replyId = (chatId, index) => chatId + ":" + index;

/** The newest thing a bot said in a chat that is for the person: `{ index, message }`, or null. */
function lastReply(chat) {
  const messages = chat?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return null;
    if (message?.role === "assistant" && !message.interim && !message.voicePartial && typeof message.text === "string" && message.text.trim()) return { index, message };
  }
  return null;
}

/**
 * The part "gadget": everything one gadget shows, in one small object. Pure.
 * `chat` is the gadget's chat with its messages (or undefined), `live` the owner's `live` part.
 */
export function gadgetPart({ device, bots = [], chat, live = {}, voice = {}, words = (text) => ({ text: speakable(text), parts: splitForSpeech(speakable(text)).length }) }) {
  const mine = device.gadget ?? {};
  const bot = bots.find((item) => item.id === (chat?.botId ?? mine.botId)) ?? bots.find((item) => !item.hidden) ?? bots[0];
  const chatId = chat?.id;
  const request = chatId ? (live.requests ?? []).find((item) => item.chatId === chatId) : undefined;
  const working = !!chatId && ((live.active ?? []).includes(chatId) || Object.hasOwn(live.streams ?? {}, chatId));
  const writing = working && !!(live.streams ?? {})[chatId];
  const reply = lastReply(chat);
  return {
    name: device.name,
    bot: bot ? { id: bot.id, name: line(bot.name, 60), ...(bot.look && { look: bot.look }) } : null,
    bots: bots.filter((item) => !item.hidden).slice(0, MAX_BOTS).map((item) => ({ id: item.id, name: line(item.name, 60) })),
    chat: chat ? { id: chat.id, title: line(chat.title, 80) } : null,
    // What the gadget's face shows: "request" comes first, since the turn waits on the person.
    phase: request ? "request" : writing ? "writing" : working ? "working" : "idle",
    ...(working && typeof live.intents?.[chatId] === "string" && live.intents[chatId] && { doing: line(live.intents[chatId], 60) }),
    ...(request && {
      request: {
        id: request.id,
        kind: request.kind,
        title: line(request.title, 120),
        ...(request.preview && { preview: line(request.preview, 200) }),
        ...(Array.isArray(request.choices) && request.choices.length && { choices: request.choices.slice(0, MAX_CHOICES).map((choice) => line(choice, 80)) }),
        ...(request.remember && { remember: true }),
        ...(request.freeform && { freeform: true }),
      },
    }),
    ...(chatId && (live.queued?.[chatId]?.length ?? 0) > 0 && { queued: live.queued[chatId].length }),
    ...(reply && !working && { reply: (({ text, parts }) => ({ id: replyId(chatId, reply.index), text: clip(text, MAX_REPLY), parts }))(words(reply.message.text)) }),
    voice: { hear: voice.hear === true, speak: voice.speak === true, ...(voice.live && { live: voice.live }) },
  };
}

// ── Text for a voice and a small screen ─────────────────────────────────────────────────────────
// The same rules as the phone's src/features/voice/speakable.ts. tests/gadget.test.ts holds the two equal.

const siteOf = (url) => {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:www\.)?([^/\s?#:]+)/i.exec(url)?.[1];
  return host ? "a link to " + host : "a link";
};
const endSentence = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?:;…]["')\]]?$/.test(trimmed) ? trimmed : trimmed + ".";
};

/** Markdown to words a voice can read and a small screen can show. */
export function speakable(markdown) {
  let text = String(markdown ?? "").slice(0, MAX_SPEAKABLE).replace(/\r\n?/g, "\n");
  text = text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "$1\nCode block.\n");
  text = text.replace(/(^|\n\n)((?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*)/g, "$1Code block.");
  text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-z][^>]*>/gi, " ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt) => (alt.trim() ? "Image: " + alt.trim() + "." : ""));
  text = text.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "");
  text = text.replace(/\[\^[^\]]+\]/g, "");
  text = text.replace(/<?\b(?:https?|ftp):\/\/[^\s<>()]+[^\s<>().,;:!?'"]>?/gi, (url) => siteOf(url.replace(/^<|>$/g, "")));
  text = text.replace(/\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>()]*/gi, (url) => siteOf("http://" + url));
  text = text.replace(/`+([^`\n]+)`+/g, "$1");
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  text = text.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_all, cells) => endSentence(cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ")));
  text = text.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, (_all, heading) => endSentence(heading));
  text = text.replace(/^[ \t]*(>[ \t]?)+/gm, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/gm, (_all, item) => endSentence(item));
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2").replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/[*_~`|#]+/g, " ");
  text = text
    .split(/\n{1,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index, parts) => (index < parts.length - 1 ? endSentence(part) : part))
    .join(" ");
  text = text.replace(/(Code block\.\s*){2,}/g, "Code block. ");
  return text.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}

const FIRST_PART = { min: 40, max: 80 };
// A phone's later parts hold 400 characters; a gadget's hold less, so one part's samples stay small.
const LATER_PART_MAX = 240;
const SENTENCE = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g;

function cut(piece, max) {
  if (piece.length <= max) return [piece, ""];
  const window = piece.slice(0, max + 1);
  let at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "), window.lastIndexOf(" – "), window.lastIndexOf(" — "));
  if (at < max * 0.4) at = window.lastIndexOf(" ");
  if (at <= 0) at = max;
  else if (/[,;:]/.test(piece[at] ?? "")) at += 1;
  return [piece.slice(0, at).trim(), piece.slice(at).trim()];
}

/** Speakable text in parts to say one after another. The first is short, so sound starts soon. */
export function splitForSpeech(text, laterMax = LATER_PART_MAX) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const queue = (clean.match(SENTENCE) ?? []).map((part) => part.trim()).filter(Boolean);
  const parts = [];
  let current = "";
  let limit = FIRST_PART.max;
  const flush = () => {
    if (current) parts.push(current);
    current = "";
    limit = Math.min(laterMax, Math.max(limit * 2, 160));
  };
  while (queue.length) {
    const sentence = queue.shift();
    const joined = current ? current + " " + sentence : sentence;
    if (joined.length <= limit) {
      current = joined;
      if (!parts.length && current.length >= FIRST_PART.min) flush();
      continue;
    }
    if (current) {
      flush();
      queue.unshift(sentence);
      continue;
    }
    const [head, rest] = cut(sentence, limit);
    current = head;
    flush();
    if (rest) queue.unshift(rest);
  }
  flush();
  return parts;
}

// ── Samples ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The samples of a WAV file as 16-bit mono: `{ pcm, rate }`. Takes 8, 16, 24 and 32-bit integer
 * samples and 32-bit floats, any number of channels (they are averaged). Throws on anything else.
 */
export function pcmFromWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let format;
  let data;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("latin1", at, at + 4);
    const declared = wav.readUInt32LE(at + 4);
    // A stream's header may say 0 or 0xFFFFFFFF for a length nobody knew yet: the samples run to the end.
    const size = id === "data" && (declared === 0 || at + 8 + declared > wav.length) ? wav.length - at - 8 : declared;
    if (id === "fmt " && size >= 16) format = { tag: wav.readUInt16LE(at + 8), channels: wav.readUInt16LE(at + 10), rate: wav.readUInt32LE(at + 12), bits: wav.readUInt16LE(at + 22), sub: size >= 26 ? wav.readUInt16LE(at + 32) : 0 };
    if (id === "data") {
      data = wav.subarray(at + 8, at + 8 + size);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error("not a WAV file");
  // 0xFFFE is "extensible": the real kind is the first two bytes of its sub-format.
  const tag = format.tag === 0xfffe ? format.sub : format.tag;
  const { channels, bits, rate } = format;
  const bytes = bits / 8;
  if (!(tag === 1 || (tag === 3 && bits === 32)) || ![8, 16, 24, 32].includes(bits) || channels < 1 || channels > 8 || rate < 4000 || rate > 192000) throw new Error("unsupported WAV");
  if (tag === 1 && bits === 16 && channels === 1) return { pcm: data.subarray(0, data.length - (data.length % 2)), rate };
  const frames = Math.floor(data.length / (bytes * channels));
  const pcm = Buffer.alloc(frames * 2);
  const sample = (at) => {
    if (tag === 3) return Math.max(-1, Math.min(1, data.readFloatLE(at))) * 32767;
    if (bits === 8) return (data[at] - 128) << 8;
    if (bits === 16) return data.readInt16LE(at);
    if (bits === 24) return data.readIntLE(at, 3) >> 8;
    return data.readInt32LE(at) >> 16;
  };
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += sample((frame * channels + channel) * bytes);
    pcm.writeInt16LE(Math.round(sum / channels), frame * 2);
  }
  return { pcm, rate };
}

/**
 * 16-bit mono samples at another rate. Going down, each output sample is the mean of the input it
 * covers (which keeps the hiss of folded high tones out); going up, a straight line between two.
 */
export function resample(pcm, from, to) {
  if (from === to) return pcm;
  const input = pcm.length >> 1;
  const count = Math.floor((input * to) / from);
  const out = Buffer.alloc(count * 2);
  const step = from / to;
  for (let i = 0; i < count; i++) {
    const start = i * step;
    let value;
    if (step > 1) {
      const end = Math.min(input, Math.max(Math.floor(start) + 1, Math.floor(start + step)));
      let sum = 0;
      for (let j = Math.floor(start); j < end; j++) sum += pcm.readInt16LE(j * 2);
      value = sum / (end - Math.floor(start));
    } else {
      const at = Math.floor(start);
      const a = pcm.readInt16LE(at * 2);
      const b = at + 1 < input ? pcm.readInt16LE((at + 1) * 2) : a;
      value = a + (b - a) * (start - at);
    }
    out.writeInt16LE(Math.round(value), i * 2);
  }
  return out;
}

// ── The computer's side ─────────────────────────────────────────────────────────────────────────

/**
 * What LinkHost keeps for its gadgets: each one's view, the recording it is sending, and the
 * samples of what is being read to it. `host` is the LinkHost.
 */
export class Gadgets {
  constructor(host) {
    this.host = host;
    this.views = new Map(); // device id → the parts it is sent, each with its version
    this.takes = new Map(); // device id → { take, rate, chunks, size, at }
    this.spoken = new Map(); // "reply|part|rate|bot" → { pcm: Promise<Buffer>, at }
    this.saying = new Map(); // device id → the send under way, so two at once don't start two chats
    this.worded = { from: null, text: "", parts: [] }; // the last reply made into words: made once, not at every sync
  }
  /** A reply as plain words and the parts it is read in. The newest one is kept, since every gadget's every sync asks. */
  words(markdown) {
    if (this.worded.from !== markdown) {
      const text = speakable(markdown);
      this.worded = { from: markdown, text, parts: splitForSpeech(text) };
    }
    return this.worded;
  }
  /** The gadget a session belongs to. Only a gadget makes a gadget's calls. */
  of(session) {
    const device = this.host.store.device(session.deviceId);
    if (device?.kind !== "gadget") throw new Failure("Only a gadget can do that.");
    return device;
  }
  /** A device that was removed takes what was kept for it along. */
  forget(deviceId) {
    this.views.delete(deviceId);
    this.takes.delete(deviceId);
    this.saying.delete(deviceId);
  }

  /**
   * Names a gadget by its key, so it can open a session without a pairing code. Answers what the
   * gadget needs to find and know this computer; the caller hands that to the gadget.
   */
  add(input) {
    const { publicKey, name, board, botId } = cleanIntroduction(input);
    const host = this.host;
    const bots = host.backend.snapshot().bots ?? [];
    if (botId && !bots.some((bot) => bot.id === botId)) throw new Failure("This bot no longer exists.");
    // A key no session could ever be opened with (a low-order point) is refused here, in words.
    try {
      agree(host.store.data.keys, publicKey);
    } catch {
      throw new Failure("That isn't a gadget's key.");
    }
    // A gadget that is introduced again (after a reset of its settings, or to another bot) replaces its own earlier
    // entry, and only that: a key some phone or computer paired with is not a gadget's to take.
    const same = host.store.data.devices.filter((device) => device.publicKey === publicKey.toString("base64url"));
    if (same.some((device) => device.kind !== "gadget" || device.memberId)) throw new Failure("That key belongs to another paired device.");
    for (const old of same) host.removeDevice(old.id);
    let device;
    try {
      device = host.store.addDevice({ name: name || board || "Gadget", platform: "esp32", kind: "gadget", publicKey });
    } catch (error) {
      throw new Failure(error.message);
    }
    host.store.setGadget(device.id, { ...(board && { board }), ...(botId && { botId }) });
    host.dirty = true;
    host.changed();
    host.emit("paired", device);
    host.emit("status");
    const { serverId, keys } = host.store.data;
    return { deviceId: device.id, serverId, serverKey: keys.publicKey.toString("base64url"), name: host.store.name, hosts: host.hosts() };
  }

  /** The gadget's chat as the app has it now, with its messages. Undefined when it has none, or it is gone. */
  chatOf(device, state = this.host.backend.snapshot()) {
    const id = device.gadget?.chatId;
    return id ? (state.chats ?? []).find((chat) => chat.id === id) : undefined;
  }
  /** The two parts a gadget follows, each with a version that changes only when its content does. */
  view(device, parts) {
    const host = this.host;
    const view = this.views.get(device.id) ?? new Map();
    const read = (name) => {
      const json = parts.get(name)?.json;
      return json ? JSON.parse(json) : undefined;
    };
    const meta = read("meta") ?? {};
    const chat = this.chatOf(device);
    const settings = read("voice") ?? {};
    const put = (name, value) => {
      const json = JSON.stringify(value);
      if (view.get(name)?.json !== json) view.set(name, { json, v: ++host.version });
    };
    put("meta", { app: meta.app, version: meta.version, name: meta.name, serverId: meta.serverId, protocol: meta.protocol, capabilities: meta.capabilities ?? [], you: { kind: "gadget", deviceId: device.id } });
    put(
      "gadget",
      gadgetPart({
        device,
        bots: read("bots") ?? [],
        chat,
        live: read("live") ?? {},
        // "device" means a phone's own speech: a gadget has none, so it needs a provider on the computer.
        voice: { hear: !!settings.stt && settings.stt.provider !== "device", speak: !!settings.tts && settings.tts.provider !== "device", live: settings.live?.provider ?? undefined },
        words: (text) => (({ text: plain, parts }) => ({ text: plain, parts: parts.length }))(this.words(text)),
      }),
    );
    view.names = ["meta", "gadget"];
    // The reply being written is sent as text only for the gadget's own chat.
    view.texts = new Set(chat ? [chat.id] : []);
    this.views.set(device.id, view);
    return view;
  }

  hello(device, input) {
    this.host.store.setGadget(device.id, cleanHello(input));
    this.host.emit("status");
    return this.settings(device);
  }
  settings(device) {
    const { botId, chatId, rate } = this.host.store.device(device.id)?.gadget ?? {};
    return { ...(botId && { botId }), ...(chatId && { chatId }), ...(rate && { rate }) };
  }
  /** Another bot, another chat, or a new chat with the next thing said. */
  set(device, input) {
    const state = this.host.backend.snapshot();
    const patch = {};
    if (typeof input?.botId === "string") {
      if (!(state.bots ?? []).some((bot) => bot.id === input.botId)) throw new Failure("This bot no longer exists.");
      patch.botId = input.botId;
      // The chat was with the bot before.
      patch.chatId = null;
    }
    if (typeof input?.chatId === "string") {
      const chat = (state.chats ?? []).find((item) => item.id === input.chatId);
      if (!chat) throw new Failure("This chat no longer exists.");
      patch.chatId = chat.id;
      patch.botId = chat.botId;
    }
    if (input?.newChat === true) patch.chatId = null;
    this.host.store.setGadget(device.id, patch);
    this.host.dirty = true;
    this.host.changed();
    return this.settings(device);
  }

  /** Sends words to the gadget's chat, starting the chat when there is none. Answers `{ chatId }`. One at a time for each gadget. */
  say(device, text, principal) {
    const before = this.saying.get(device.id) ?? Promise.resolve();
    const mine = before.then(() => this.send(device, text, principal));
    const settled = mine.catch(() => {});
    this.saying.set(device.id, settled);
    void settled.then(() => this.saying.get(device.id) === settled && this.saying.delete(device.id));
    return mine;
  }
  async send(device, text, principal) {
    const words = typeof text === "string" ? text.trim() : "";
    if (!words) throw new Failure("There was nothing to send.");
    if (words.length > 8000) throw new Failure("That is too long to send from a gadget.");
    const host = this.host;
    const state = host.backend.snapshot();
    let chat = this.chatOf(device, state);
    let chatId = chat?.id;
    if (!chat) {
      const mine = host.store.device(device.id)?.gadget ?? {};
      const bots = state.bots ?? [];
      const bot = bots.find((item) => item.id === mine.botId) ?? bots.find((item) => !item.hidden) ?? bots[0];
      if (!bot) throw new Failure("Make a bot on your computer first.");
      chatId = await host.backend.call("createChat", [bot.id], { principal });
      if (typeof chatId !== "string" || !chatId) throw new Failure("That didn't work on your computer.");
      host.store.setGadget(device.id, { chatId, botId: bot.id });
    }
    // A turn under way takes the words as a steer, as the apps' message boxes do.
    const busy = (state.streams && Object.hasOwn(state.streams, chatId)) || false;
    await host.backend.call("send", [chatId, words, busy ? { delivery: "steer" } : {}], { principal });
    host.dirty = true;
    host.changed();
    return { chatId };
  }

  /**
   * One piece of a recording: 16-bit mono samples. The last piece (`last`) turns the whole of it
   * into words and sends them. `{ got }` (bytes so far), then `{ text, chatId }`.
   */
  async hear(device, input, principal) {
    const take = typeof input?.take === "string" && TAKE.test(input.take) ? input.take : "";
    if (!take) throw new Failure("That recording has no name.");
    const now = Date.now();
    for (const [id, old] of this.takes) if (now - old.at > HEAR_IDLE_MS) this.takes.delete(id);
    if (input.cancel === true) {
      if (this.takes.get(device.id)?.take === take) this.takes.delete(device.id);
      return { got: 0 };
    }
    let held = this.takes.get(device.id);
    // A new name starts over: the recording before was given up.
    if (held?.take !== take) {
      const rate = Number(input.rate);
      if (!RATES.includes(rate)) throw new Failure("That recording's rate isn't one this computer takes.");
      held = { take, rate, chunks: [], size: 0, at: now };
      this.takes.set(device.id, held);
    }
    const audio = Buffer.from(typeof input.audio === "string" ? input.audio : "", "base64");
    if (audio.length % 2) throw new Failure("That recording is cut off.");
    if (held.size + audio.length > MAX_HEAR) {
      this.takes.delete(device.id);
      throw new Failure("That recording is too long. Say it in shorter parts.");
    }
    if (audio.length) held.chunks.push(audio);
    held.size += audio.length;
    held.at = now;
    if (input.last !== true) return { got: held.size };
    this.takes.delete(device.id);
    // Under a quarter of a second is a slip of the button, not speech.
    if (held.size < held.rate / 2) throw new Failure("That was too short to hear.");
    const language = typeof input.language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language) ? input.language : undefined;
    const { text } = await this.host.voice.transcribe({ audio: wavFromPcm(Buffer.concat(held.chunks), held.rate), format: "wav", language });
    if (!text) throw new Failure("I didn't catch that.");
    const { chatId } = await this.say(device, text, principal);
    return { text: clip(text, 400), chatId };
  }

  /**
   * A piece of a reply read aloud: 16-bit mono samples at the gadget's rate, from byte `from`.
   * A reply is read in parts (`parts` in the gadget's part); a part's samples are made once and
   * kept a few minutes, so a gadget fetches them a second at a time and plays as it goes.
   */
  async speak(device, input) {
    const host = this.host;
    const id = String(input?.reply ?? "");
    const at = id.lastIndexOf(":");
    const chat = (host.backend.snapshot().chats ?? []).find((item) => item.id === id.slice(0, at));
    const message = at > 0 ? chat?.messages?.[Number(id.slice(at + 1))] : undefined;
    if (!message || message.role !== "assistant") throw new Failure("That reply is gone.");
    const { parts } = this.words(message.text);
    const part = Number(input.part ?? 0);
    if (!Number.isInteger(part) || part < 0 || part >= parts.length) throw new Failure("That reply has no more to read.");
    const rate = RATES.includes(Number(input.rate)) ? Number(input.rate) : (host.store.device(device.id)?.gadget?.rate ?? 16000);
    const botId = message.botId ?? chat.botId;
    const pcm = await this.samples(id, part, parts, rate, botId);
    const from = Number.isInteger(input.from) && input.from >= 0 ? input.from - (input.from % 2) : 0;
    const max = Math.max(SLICE.min, Math.min(Number.isInteger(input.max) ? input.max : SLICE.normal, SLICE.max));
    const slice = pcm.subarray(Math.min(from, pcm.length), Math.min(from + max - (max % 2), pcm.length));
    return { audio: slice.toString("base64"), from, total: pcm.length, rate, part, parts: parts.length };
  }
  /** The samples of one part, made once. The part after it is started too, so it is ready when this one has played. */
  samples(id, part, parts, rate, botId) {
    const host = this.host;
    const now = Date.now();
    for (const [key, kept] of this.spoken) if (now - kept.at > SPOKEN_MS) this.spoken.delete(key);
    const make = (index) => {
      const key = [id, index, rate, createHash("sha256").update(parts[index]).digest("base64url").slice(0, 12)].join("|");
      let kept = this.spoken.get(key);
      if (!kept) {
        const pcm = host.voice.speak({ text: parts[index], override: host.botVoice(botId)?.tts, samples: true }).then((spoken) => {
          if (spoken.format !== "wav") throw new Failure("Your speech provider sent audio a gadget can't play.");
          let wav;
          try {
            wav = pcmFromWav(spoken.audio);
          } catch {
            throw new Failure("Your speech provider sent audio a gadget can't play.");
          }
          return resample(wav.pcm, wav.rate, rate);
        });
        kept = { pcm, at: now };
        // A part that failed is asked for again, not remembered as failed.
        pcm.catch(() => this.spoken.get(key) === kept && this.spoken.delete(key));
        this.spoken.set(key, kept);
        while (this.spoken.size > SPOKEN_KEPT) this.spoken.delete(this.spoken.keys().next().value);
      }
      kept.at = now;
      return kept.pcm;
    };
    const wanted = make(part);
    if (part + 1 < parts.length) wanted.then(() => make(part + 1).catch(() => {}), () => {});
    return wanted;
  }
}
