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
import { createHash, randomUUID } from "node:crypto";
import { POSES } from "./botkin-svg.mjs";
import { agree } from "./crypto.mjs";
import { Failure } from "./tools.mjs";
import { wavFromPcm } from "./voice.mjs";

export const GADGET_CAPABILITY = "gadgets-v1";
/** Settings, Wi-Fi, restart and the Botkin's faces (gadget/docs/contract.md, "Settings"). */
export const GADGET_SETTINGS_CAPABILITY = "gadget-settings-v1";
/** A gadget's settings before its owner changes any. */
export const GADGET_DEFAULTS = Object.freeze({ volume: 60, mic: "normal", mute: false, brightness: 80, dimAfter: 30, offAfter: 300 });
const MICS = ["low", "normal", "high"];
/** A Wi-Fi change waits this long for the gadget to take it; the password is kept nowhere else, and not after. */
const WIFI_WAIT_MS = 10 * 60_000;
const MAX_WIFI_CHANGES = 4;
const MAX_SAVED_NETWORKS = 8;
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

/** A Wi-Fi network's name as a gadget or a person gives it: 1 to 32 bytes, no control characters. */
function networkName(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return "";
  return value.length >= 1 && Buffer.byteLength(value, "utf8") <= 32 ? value : "";
}

/** Settings a person (or the gadget) changes, checked. Throws a sentence a person can read. */
export function cleanSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Failure("Those aren't a gadget's settings.");
  const whole = (value, low, high, sentence) => {
    if (!Number.isInteger(value) || value < low || value > high) throw new Failure(sentence);
    return value;
  };
  const out = {};
  if (patch.volume !== undefined) out.volume = whole(patch.volume, 0, 100, "Volume is from 0 to 100.");
  if (patch.mic !== undefined) {
    if (!MICS.includes(patch.mic)) throw new Failure("The microphone is low, normal or high.");
    out.mic = patch.mic;
  }
  if (patch.mute !== undefined) {
    if (typeof patch.mute !== "boolean") throw new Failure("Mute is on or off.");
    out.mute = patch.mute;
  }
  if (patch.brightness !== undefined) out.brightness = whole(patch.brightness, 5, 100, "Brightness is from 5 to 100.");
  if (patch.dimAfter !== undefined) out.dimAfter = whole(patch.dimAfter, 0, 3600, "The screen dims after 0 to 3,600 seconds (0 is never).");
  if (patch.offAfter !== undefined) out.offAfter = whole(patch.offAfter, 0, 86400, "The screen turns off after 0 to 86,400 seconds (0 is never).");
  return out;
}

/** A Wi-Fi change a person asks for: `{ add: { ssid, password } }` or `{ forget: ssid }`. Throws a sentence. */
export function cleanWifiChange(change) {
  if (change?.add && typeof change.add === "object") {
    const ssid = networkName(change.add.ssid);
    if (!ssid) throw new Failure("Give the Wi-Fi network's name (up to 32 letters).");
    const password = change.add.password ?? "";
    // WPA2 asks for 8 to 63 characters; an open network has none.
    if (typeof password !== "string" || (password.length > 0 && (password.length < 8 || password.length > 63))) throw new Failure("A Wi-Fi password has 8 to 63 characters, or none for an open network.");
    return { add: { ssid, password } };
  }
  const forget = networkName(change?.forget);
  if (forget) return { forget };
  throw new Failure("Say which network to add or forget.");
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
    ...(input?.wifi && typeof input.wifi === "object" && { wifi: cleanWifiReport(input.wifi) }),
  };
}

/** The Wi-Fi a gadget reports: the network in use, the saved ones' names, the signal (dBm). Never a password. */
function cleanWifiReport(wifi) {
  const network = networkName(wifi.network);
  const saved = Array.isArray(wifi.saved) ? [...new Set(wifi.saved.map(networkName).filter(Boolean))].slice(0, MAX_SAVED_NETWORKS) : [];
  const signal = Number.isInteger(wifi.signal) && wifi.signal < 0 && wifi.signal > -128 ? wifi.signal : undefined;
  return { ...(network && { network }), saved, ...(signal !== undefined && { signal }) };
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
export function gadgetPart({ device, bots = [], chat, live = {}, voice = {}, words = (text) => ({ text: speakable(text), parts: splitForSpeech(speakable(text)).length }), steps = 0, face, wifi = [], restart }) {
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
    ...(working && steps > 0 && { steps }),
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
    settings: { ...GADGET_DEFAULTS, ...mine.settings },
    ...(face && { face }),
    // Changes the owner asked for, until the gadget says it took them. A password travels only here, sealed for this gadget.
    ...(wifi.length > 0 && { wifi: { changes: wifi.map(({ id, add, forget }) => ({ id, ...(add && { add }), ...(forget && { forget }) })) } }),
    ...(restart && { restart }),
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
    this.wifi = new Map(); // device id → the Wi-Fi changes waiting for the gadget: [{ id, add?, forget?, at }]
    this.restarts = new Map(); // device id → the id of a restart the owner asked for
  }
  /** The renderer of Botkins faces (botkin-svg.mjs), or null on a computer without the design kit. */
  get faces() {
    return this.host.botkins;
  }
  /** The bot a gadget talks with now, as the "bots" part has it (with its look). */
  botOf(device) {
    const bots = JSON.parse(this.host.parts.get("bots")?.json ?? "[]");
    const id = this.chatOf(device)?.botId ?? device.gadget?.botId;
    return bots.find((bot) => bot.id === id) ?? bots.find((bot) => !bot.hidden) ?? bots[0];
  }
  /** One gadget, by id, for an owner's call. Throws a sentence when there is none. */
  gadget(id) {
    const device = typeof id === "string" ? this.host.store.device(id) : null;
    if (device?.kind !== "gadget") throw new Failure("That gadget is no longer paired.");
    return device;
  }
  /** Waiting Wi-Fi changes for a gadget, without the ones that waited too long. */
  pendingWifi(deviceId) {
    const now = Date.now();
    const left = (this.wifi.get(deviceId) ?? []).filter((change) => now - change.at < WIFI_WAIT_MS);
    if (left.length) this.wifi.set(deviceId, left);
    else this.wifi.delete(deviceId);
    return left;
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
    this.wifi.delete(deviceId);
    this.restarts.delete(deviceId);
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
    // What the owner set for it stays: its settings, and its bot unless another is named.
    const kept = same.at(-1)?.gadget ?? {};
    for (const old of same) host.removeDevice(old.id);
    let device;
    try {
      device = host.store.addDevice({ name: name || board || "Gadget", platform: "esp32", kind: "gadget", publicKey });
    } catch (error) {
      throw new Failure(error.message);
    }
    host.store.setGadget(device.id, { ...(kept.settings && { settings: kept.settings }), ...(kept.botId && { botId: kept.botId }), ...(board && { board }), ...(botId && { botId }) });
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
    const run = chat ? read("run:" + chat.id) : undefined;
    const bot = this.faces ? this.botOf(device) : undefined;
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
        steps: run?.status === "Working" && Array.isArray(run.steps) ? run.steps.length : 0,
        ...(bot && { face: { look: this.faces.lookId(bot.look) } }),
        wifi: this.pendingWifi(device.id),
        restart: this.restarts.get(device.id),
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
    // The app's own page shows what the gadget reports (its Wi-Fi).
    this.host.emit("status");
    return this.settings(device);
  }
  settings(device) {
    const { botId, chatId, rate } = this.host.store.device(device.id)?.gadget ?? {};
    return { ...(botId && { botId }), ...(chatId && { chatId }), ...(rate && { rate }) };
  }
  /** The bot's Botkin in one pose, as SVG text, for the gadget to draw: `{ look, pose, svg }`. */
  face(device, input) {
    const pose = input?.pose;
    if (typeof pose !== "string" || !Object.hasOwn(POSES, pose)) throw new Failure("That isn't a pose a Botkin takes.");
    if (!this.faces) throw new Failure("This computer can't draw Botkins.");
    const look = this.botOf(device)?.look;
    return { look: this.faces.lookId(look), pose, svg: this.faces.svg(look, pose) };
  }
  /** Changes the settings of a gadget and tells it at its next look. */
  saveSettings(device, patch) {
    const clean = cleanSettings(patch);
    if (!Object.keys(clean).length) return;
    const now = this.host.store.device(device.id)?.gadget?.settings ?? {};
    this.host.store.setGadget(device.id, { settings: { ...now, ...clean } });
  }

  // ── What the owner does with a gadget (a phone's Settings › Devices, the app's own page, `botkins gadgets`) ──

  /** Settings and the bot, from the owner: `{ volume?, mic?, mute?, brightness?, dimAfter?, offAfter?, botId? }`. */
  configure(id, patch) {
    const device = this.gadget(id);
    const { botId, ...rest } = patch && typeof patch === "object" ? patch : {};
    if (botId !== undefined) {
      if (typeof botId !== "string" || !(this.host.backend.snapshot().bots ?? []).some((bot) => bot.id === botId)) throw new Failure("This bot no longer exists.");
    }
    // Checked whole before anything is kept, so a bad value changes nothing.
    const clean = cleanSettings(rest);
    if (Object.keys(clean).length) this.saveSettings(device, clean);
    if (botId !== undefined && botId !== device.gadget?.botId) this.host.store.setGadget(device.id, { botId, chatId: null });
    this.host.dirty = true;
    this.host.changed();
    this.host.emit("status");
  }
  /** A Wi-Fi network to add (with its password) or forget, for the gadget to take at its next look. */
  queueWifi(id, change) {
    const device = this.gadget(id);
    const clean = cleanWifiChange(change);
    const waiting = this.pendingWifi(device.id).filter((item) => (item.add?.ssid ?? item.forget) !== (clean.add?.ssid ?? clean.forget));
    if (waiting.length >= MAX_WIFI_CHANGES) throw new Failure("The gadget hasn't taken the last changes yet. Check that it is on.");
    this.wifi.set(device.id, [...waiting, { id: randomUUID().slice(0, 12), ...clean, at: Date.now() }]);
    this.host.dirty = true;
    this.host.changed();
    this.host.emit("status");
    return { queued: true };
  }
  /** Asks the gadget to restart. It says it is restarting, and its sessions come back by themselves. */
  restart(id) {
    const device = this.gadget(id);
    this.restarts.set(device.id, randomUUID().slice(0, 12));
    this.host.dirty = true;
    this.host.changed();
    this.host.emit("status");
    return null;
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
    // Settings the person changed on the gadget itself.
    if (input?.settings !== undefined) this.saveSettings(device, input.settings);
    // Wi-Fi changes and a restart the gadget took.
    if (Array.isArray(input?.wifiDone)) {
      const done = new Set(input.wifiDone.filter((item) => typeof item === "string"));
      const left = this.pendingWifi(device.id).filter((change) => !done.has(change.id));
      if (left.length) this.wifi.set(device.id, left);
      else this.wifi.delete(device.id);
    }
    if (typeof input?.restarting === "string" && this.restarts.get(device.id) === input.restarting) this.restarts.delete(device.id);
    this.host.store.setGadget(device.id, patch);
    this.host.dirty = true;
    this.host.changed();
    // The app's own page shows settings changed on the gadget, and Wi-Fi changes and restarts it took.
    this.host.emit("status");
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
