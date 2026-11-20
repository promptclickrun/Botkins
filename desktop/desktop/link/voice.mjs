// Voice: the one place that talks to speech providers, for the desktop app and for paired phones.
// It does speech to text (STT), text to speech (TTS) and the set-up of a live (realtime, full
// duplex) voice session. Keys stay on this computer: a phone never receives a long-lived key, only
// a short-lived secret for one live session. Provider routes and shapes are in VOICE.md, with the
// documentation each one was taken from.
//
// Settings and keys live in <dir>/voice.json, written whole through a temp file and renamed, readable
// only by the person (0600). Each key is wrapped with the optional protect/reveal pair (the system
// keychain, as in credentials.mjs). When the file can't be read, or a wrapped key can't be opened in
// this run, saving is refused and the file is left exactly as it is.
//
// No dependencies beyond Node's standard library (and global fetch, FormData, Blob).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, random } from "./crypto.mjs";
import { Failure } from "./tools.mjs";

export const STT_PROVIDERS = ["device", "openai", "azure", "elevenlabs", "custom", "local"];
export const TTS_PROVIDERS = ["device", "openai", "azure", "elevenlabs", "gemini", "custom", "local"];
export const LIVE_PROVIDERS = ["codex", "openai", "gemini", "elevenlabs"];
export const KEY_PROVIDERS = ["openai", "azure", "elevenlabs", "gemini", "custom"];

export const MAX_SPEAK = 4000;
export const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_ANSWER = 40 * 1024 * 1024; // the most audio a provider may send back
const REQUEST_MS = 60_000;
const LIST_MS = 15_000;
const CACHE_MS = 5 * 60_000;
const MAX_TOOLS = 64;
const MAX_SESSIONS = 32;
const FORMATS = { wav: "audio/wav", m4a: "audio/mp4", mp3: "audio/mpeg", webm: "audio/webm" };

const OPENAI_BASE = "https://api.openai.com/v1";
const ELEVEN = "https://api.elevenlabs.io";
const GEMINI = "https://generativelanguage.googleapis.com";
const GEMINI_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const AZURE_API_VERSION = "2025-04-01-preview";
const AZURE_FAST_VERSION = "2025-10-15";

const NAMES = { openai: "OpenAI", azure: "Azure", elevenlabs: "ElevenLabs", gemini: "Gemini", custom: "Your speech server", codex: "Codex" };
const KEY_PLEASE = {
  openai: "Add an OpenAI key in Settings › Voice first.",
  azure: "Add an Azure key in Settings › Voice first.",
  elevenlabs: "Add an ElevenLabs key in Settings › Voice first.",
  gemini: "Add a Gemini key in Settings › Voice first.",
  custom: "Add the key for your speech server in Settings › Voice first.",
};
const DEVICE = "This device does its own speech.";

// ── What each provider offers, from the documentation (see VOICE.md) ────────────────────────────
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
const OPENAI_LIVE_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];
const AZURE_OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const GEMINI_VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];
const pick = (ids, names = {}) => ids.map((id) => ({ id, name: names[id] ?? id }));
const OPENAI_STT = pick(["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"], {
  "gpt-4o-transcribe": "gpt-4o-transcribe (retires Feb 2027)",
  "gpt-4o-mini-transcribe": "gpt-4o-mini-transcribe (retires Feb 2027)",
  "whisper-1": "whisper-1 (retires Feb 2027)",
});
const OPENAI_TTS = pick(["gpt-4o-mini-tts", "tts-1-hd", "tts-1"], {
  "gpt-4o-mini-tts": "gpt-4o-mini-tts (retires Jan 2027)",
  "tts-1-hd": "tts-1-hd (retires Jan 2027)",
  "tts-1": "tts-1 (retires Jan 2027)",
});
const OPENAI_LIVE = pick(["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2", "gpt-realtime"]);
const ELEVEN_STT = pick(["scribe_v2", "scribe_v3", "scribe_v2_medical"]);
const GEMINI_TTS = pick(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-pro-preview-tts"]);
const GEMINI_LIVE = pick(["gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025"]);

const DEFAULTS = {
  openai: { stt: "gpt-transcribe", tts: "gpt-4o-mini-tts", ttsVoice: "marin", live: "gpt-realtime-2.1", liveVoice: "marin" },
  custom: { stt: "whisper-1", tts: "tts-1", ttsVoice: "alloy" },
  azureOpenaiVoice: "alloy",
  azureSpeechVoice: "en-US-JennyNeural",
  elevenStt: "scribe_v2",
  elevenTts: "eleven_multilingual_v2",
  geminiTts: "gemini-3.8-flash-tts",
  geminiVoice: "Kore",
  geminiLive: "gemini-3.8-live",
};

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => isPlain(object) && Object.hasOwn(object, key);
const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const sentence = (text) => (/[.!?]$/.test(text) ? text : text + ".");
const isLoopback = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

/** Every way a known secret may be written, longest first, replaced by "•••" in `text`. */
function scrub(text, secrets) {
  let out = String(text);
  const forms = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join("•••");
  // Anything shaped like a key or a token, in case a provider echoes one that isn't ours.
  return out.replace(/\b(?:sk|ek|xi|sess|rtc)[-_][A-Za-z0-9_-]{6,}/g, "•••").replace(/[A-Za-z0-9_\-+/=]{40,}/g, "•••");
}

/** The provider's own message from an error body, as one line (cut short only after secrets are removed). */
function providerSays(body) {
  const text = String(body ?? "").slice(0, 4000);
  let found;
  try {
    const json = JSON.parse(text);
    const detail = json?.detail;
    found =
      json?.error?.message ??
      (typeof json?.error === "string" ? json.error : undefined) ??
      detail?.message ??
      (typeof detail === "string" ? detail : undefined) ??
      (Array.isArray(detail) ? detail.map((d) => d?.msg).filter(Boolean).join("; ") : undefined) ??
      json?.message ??
      json?.error?.status;
  } catch {
    // Not JSON: a short plain answer is kept; a page of markup is not.
    found = text.length > 0 && !/^\s*</.test(text) ? text : undefined;
  }
  return typeof found === "string" ? clean(found) : "";
}

function sniff(buffer) {
  if (buffer.length > 12 && buffer.toString("latin1", 0, 4) === "RIFF") return "wav";
  if (buffer.length > 3 && buffer.toString("latin1", 0, 3) === "ID3") return "mp3";
  if (buffer.length > 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}

/** Raw 16-bit little-endian mono samples as a WAV file. */
export function wavFromPcm(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** A language as the OpenAI routes want it: "en-US" is "en" (the page only keeps regional codes for Chinese). */
const iso = (language) => (/^zh-/i.test(language) ? language.toLowerCase() : language.split("-")[0].toLowerCase());

/** Text fields: absent keeps what there is, null or empty clears. */
function text(value, before, limit, label, pattern) {
  if (value === undefined) return before;
  if (value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > limit || (pattern && !pattern.test(value.trim()))) throw new Failure("Use up to " + limit + " plain characters for the " + label + ".");
  return value.trim();
}

/** A web address: an origin and optional path, no login in it, no query. Plain http only where `plainOk` or for this computer. */
function address(value, before, label, { plainOk = false } = {}) {
  if (value === undefined) return before;
  if (value === null || value === "") return undefined;
  const bad = new Failure("That " + label + " isn't a valid web address.");
  if (typeof value !== "string" || value.length > 300) throw bad;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw bad;
  }
  if (url.username || url.password || url.search || url.hash) throw bad;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (plainOk || isLoopback(url.hostname)))) throw new Failure("Use an https address for the " + label + ".");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/ -]{0,199}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ── The class ───────────────────────────────────────────────────────────────────────────────────

export class Voice {
  /**
   * @param options.dir       Folder for voice.json.
   * @param options.protect / options.reveal  Wrap a key at rest (the keychain).
   * @param options.fetch     Defaults to globalThis.fetch (a test passes its own).
   * @param options.adapter   () => { local?, codex? } from the desktop app, or undefined.
   * @param options.onChange  Called after settings change.
   * @param options.log       Where a short note goes (never a key or a token).
   * @param options.timeouts  { request, list } in ms (a test shortens them).
   * @param options.now       Clock in ms (a test passes its own).
   */
  constructor({ dir, protect, reveal, fetch = globalThis.fetch, adapter = () => undefined, onChange = () => {}, log = () => {}, timeouts = {}, now = Date.now }) {
    Object.assign(this, { dir, file: join(dir, "voice.json"), protect, reveal, fetchImpl: fetch, adapter, onChange, log, now });
    this.timeouts = { request: timeouts.request ?? REQUEST_MS, list: timeouts.list ?? LIST_MS };
    this.abort = new AbortController();
    this.cache = new Map();
    this.sessions = new Map();
    this.data = this.load();
  }

  // ── Disk ────────────────────────────────────────────────────────────────────────────────────

  fresh() {
    return {
      locked: null,
      keys: {},
      tools: {},
      stt: { provider: "device" },
      tts: { provider: "device", speed: 1, auto: false },
      live: { provider: null },
      providers: { openai: { baseUrl: OPENAI_BASE }, azure: { kind: "openai" }, elevenlabs: {}, custom: {} },
    };
  }
  load() {
    const data = this.fresh();
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") data.locked = "The saved voice settings can't be read.";
      return data;
    }
    if (saved?.version !== 1 || !isPlain(saved.settings)) return { ...data, locked: "The saved voice settings can't be read." };
    try {
      // Each part goes through the same checks a change would, so a hand-edited file can't make a bad address.
      this.merge(data, saved.settings, true);
    } catch {
      // A part that fails its checks is dropped; the rest stays.
    }
    if (isPlain(saved.tools)) for (const [hash, id] of Object.entries(saved.tools)) if (typeof id === "string" && /^[\w-]{1,100}$/.test(id) && /^[0-9a-f]{64}$/.test(hash)) data.tools[hash] = id;
    if (isPlain(saved.keys)) {
      for (const [provider, stored] of Object.entries(saved.keys)) {
        if (!KEY_PROVIDERS.includes(provider) || typeof stored !== "string") continue;
        try {
          if (saved.wrapped && !this.reveal) throw new Error("locked");
          data.keys[provider] = saved.wrapped ? this.reveal(stored) : stored;
        } catch {
          data.locked = "The saved voice keys can't be opened on this computer.";
        }
      }
    }
    return data;
  }
  /** Writes the file. Throws when it is locked, so a file that couldn't be read is never overwritten. */
  persist(data = this.data) {
    if (data.locked) throw new Failure(data.locked);
    let keys;
    try {
      keys = Object.fromEntries(Object.entries(data.keys).map(([provider, key]) => [provider, this.protect ? this.protect(key) : key]));
    } catch {
      throw new Failure("The computer's keychain didn't answer, so nothing was saved.");
    }
    const { stt, tts, live, providers } = data;
    const body = { version: 1, ...(this.protect && { wrapped: true }), settings: { stt, tts, live, providers }, tools: data.tools, keys };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file + ".tmp", JSON.stringify(body, null, 1), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  /** Saves `next` and makes it current; a write that fails leaves things as they were. `notify` is false for bookkeeping a person never sees. */
  commit(next, notify = true) {
    const before = this.data;
    this.data = next;
    try {
      this.persist();
    } catch (error) {
      this.data = before;
      throw error;
    }
    if (!notify) return;
    this.cache.clear();
    this.onChange();
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────────

  /** What the person has chosen, with the helpers the app offers. No key in it. */
  settings() {
    const { stt, tts, live, providers, keys } = this.data;
    const local = this.helpers().local;
    let models = [];
    try {
      models = local ? (local.models() ?? []).filter((m) => m && typeof m.id === "string" && typeof m.name === "string" && (m.kind === "stt" || m.kind === "tts")) : [];
    } catch (error) {
      this.log("voice: the local models could not be listed");
    }
    const codex = this.helpers().codex;
    let signedIn = false;
    try {
      signedIn = !!codex && !!codex.signedIn();
    } catch {
      signedIn = false;
    }
    return structuredClone({
      stt,
      tts,
      live,
      providers: {
        openai: { ...providers.openai, hasKey: "openai" in keys },
        azure: { ...providers.azure, hasKey: "azure" in keys },
        elevenlabs: { ...providers.elevenlabs, hasKey: "elevenlabs" in keys },
        gemini: { hasKey: "gemini" in keys },
        custom: { ...providers.custom, hasKey: "custom" in keys },
        local: { available: !!local, models },
        codex: { available: !!codex, signedIn },
      },
    });
  }
  helpers() {
    try {
      return this.adapter() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Saves a partial VoiceSettings. A section is merged into what there is; null or "" clears an
   * optional value. Choosing another provider drops the old model (and voice), which wouldn't fit.
   * `hasKey`, `local` and `codex` are read only and ignored, so settings() can be sent back whole.
   */
  set(patch) {
    if (!isPlain(patch)) throw new Failure("Those voice settings can't be saved.");
    const next = structuredClone({ ...this.data, locked: this.data.locked });
    this.merge(next, patch, false);
    this.commit(next);
  }

  merge(data, patch, loading) {
    const choose = (section, providers, label) => {
      const given = patch[section];
      if (given === undefined) return;
      if (!isPlain(given)) throw new Failure("Those " + label + " settings can't be saved.");
      const before = data[section];
      const provider = given.provider === undefined ? before.provider : given.provider;
      if (section === "live" ? provider !== null && !providers.includes(provider) : !providers.includes(provider)) throw new Failure("That " + label + " choice isn't supported.");
      const changed = provider !== before.provider;
      const next = { provider };
      const keep = (key) => (changed && given[key] === undefined ? undefined : before[key]);
      const model = text(given.model, keep("model"), 200, "model", NAME);
      if (model !== undefined) next.model = model;
      if (section === "stt") {
        const language = text(given.language, before.language, 20, "language", LANGUAGE);
        if (language !== undefined) next.language = language;
      } else {
        const voice = text(given.voice, keep("voice"), 200, "voice", NAME);
        if (voice !== undefined) next.voice = voice;
      }
      if (section === "tts") {
        let speed = given.speed === undefined ? before.speed : given.speed;
        if (speed === null) speed = 1;
        if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Failure("Speed is between 0.5 and 2.");
        next.speed = Math.round(speed * 100) / 100;
        let auto = given.auto === undefined ? before.auto : given.auto;
        if (typeof auto !== "boolean") throw new Failure("Reading replies aloud is on or off.");
        next.auto = auto;
      }
      data[section] = next;
    };
    // Each section is checked on its own, and a bad one stops the whole change (a load keeps what it can).
    const attempt = (run) => {
      if (!loading) return run();
      try {
        run();
      } catch {
        // dropped
      }
    };
    attempt(() => choose("stt", STT_PROVIDERS, "speech to text"));
    attempt(() => choose("tts", TTS_PROVIDERS, "text to speech"));
    attempt(() => choose("live", LIVE_PROVIDERS, "live voice"));
    const given = patch.providers;
    if (given === undefined) return;
    if (!isPlain(given)) throw new Failure("Those provider settings can't be saved.");
    for (const name of Object.keys(given)) {
      if (!["openai", "azure", "elevenlabs", "gemini", "custom", "local", "codex"].includes(name)) continue;
      if (!isPlain(given[name])) throw new Failure("Those " + (NAMES[name] ?? name) + " settings can't be saved.");
    }
    // A key was given for one address. When that address is changed to another, the key is dropped,
    // so it is never sent somewhere the person did not give it for; they enter it again for the new
    // address. Setting an address for the first time keeps the key (there was nowhere to send it yet).
    const moved = (provider, before, after) => {
      if (!loading && before && before !== after) delete data.keys[provider];
    };
    attempt(() => {
      const openai = given.openai;
      if (!openai) return;
      const before = data.providers.openai.baseUrl ?? OPENAI_BASE;
      data.providers.openai = { baseUrl: address(openai.baseUrl, data.providers.openai.baseUrl, "OpenAI address") ?? OPENAI_BASE };
      moved("openai", before, data.providers.openai.baseUrl);
    });
    attempt(() => {
      const azure = given.azure;
      if (!azure) return;
      const before = data.providers.azure;
      const kind = azure.kind === undefined ? before.kind : azure.kind;
      if (kind !== "openai" && kind !== "speech") throw new Failure("Azure is either OpenAI audio or Speech.");
      const next = { kind };
      const endpoint = address(azure.endpoint, before.endpoint, "Azure endpoint");
      if (endpoint !== undefined) next.endpoint = endpoint;
      for (const [key, label, pattern, limit] of [["region", "region", /^[a-z0-9-]{2,40}$/, 40], ["sttDeployment", "speech to text deployment", SLUG, 64], ["ttsDeployment", "text to speech deployment", SLUG, 64], ["apiVersion", "API version", /^[0-9A-Za-z.-]{4,40}$/, 40]]) {
        const value = text(azure[key], before[key], limit, label, pattern);
        if (value !== undefined) next[key] = value;
      }
      data.providers.azure = next;
      moved("azure", before.endpoint ?? before.region, next.endpoint ?? next.region);
    });
    attempt(() => {
      const eleven = given.elevenlabs;
      if (!eleven) return;
      const agentId = text(eleven.agentId, data.providers.elevenlabs.agentId, 100, "agent id", /^[A-Za-z0-9_-]{1,100}$/);
      data.providers.elevenlabs = agentId === undefined ? {} : { agentId };
    });
    attempt(() => {
      const custom = given.custom;
      if (!custom) return;
      const before = data.providers.custom.baseUrl;
      const baseUrl = address(custom.baseUrl, data.providers.custom.baseUrl, "server address", { plainOk: true });
      data.providers.custom = baseUrl === undefined ? {} : { baseUrl };
      moved("custom", before, baseUrl);
    });
  }

  /** Saves a key (a string) or removes it (null). Nothing here ever reads one back out. */
  setKey(provider, key) {
    if (!KEY_PROVIDERS.includes(provider)) throw new Failure("That provider doesn't take a key.");
    if (key !== null && (typeof key !== "string" || !/^[\x21-\x7e]{4,4096}$/.test(key.trim()))) throw new Failure("That key isn't valid.");
    const next = structuredClone({ ...this.data, locked: this.data.locked });
    if (key === null) delete next.keys[provider];
    else next.keys[provider] = key.trim();
    this.commit(next);
  }
  hasKey(provider) {
    return provider in this.data.keys;
  }
  /** The saved settings couldn't be opened (a keychain that didn't answer): nothing is saved until they can. A sentence, or null. */
  get locked() {
    return this.data.locked ?? null;
  }
  keyOf(provider) {
    const key = this.data.keys[provider];
    if (!key) throw new Failure(KEY_PLEASE[provider]);
    return key;
  }
  secrets(...more) {
    return [...Object.values(this.data.keys), ...more];
  }
  /** Stops every request that is waiting. */
  close() {
    this.abort.abort();
  }

  // ── Talking to a provider ───────────────────────────────────────────────────────────────────

  /**
   * One request with a time limit. A failure becomes one plain sentence: the provider, the HTTP
   * status and its own short message. Keys, tokens, the request and the audio never appear in it.
   */
  async send(provider, url, init, { list = false, secrets = [] } = {}) {
    const label = NAMES[provider];
    const signal = AbortSignal.any([AbortSignal.timeout(list ? this.timeouts.list : this.timeouts.request), this.abort.signal]);
    let response;
    try {
      response = await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (this.abort.signal.aborted) throw new Failure("Voice was stopped.");
      if (error?.name === "TimeoutError" || signal.reason?.name === "TimeoutError") throw new Failure(label + " took too long to answer.");
      throw new Failure("Couldn't reach " + label + ".");
    }
    if (response.ok) return response;
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    // Secrets are taken out of the whole message first, then it is cut short, so a cut can't leave half of one.
    const said = scrub(providerSays(body), this.secrets(...secrets)).slice(0, 200).trim();
    throw new Failure(sentence(label + " returned " + response.status + (said ? ": " + said : "")));
  }
  async json(provider, url, init, options) {
    const response = await this.send(provider, url, init, options);
    try {
      return await response.json();
    } catch {
      throw new Failure(NAMES[provider] + " sent back something unexpected.");
    }
  }
  async bytes(provider, url, init, options) {
    const response = await this.send(provider, url, init, options);
    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Failure(NAMES[provider] + " stopped before it finished.");
    }
    if (!buffer.length) throw new Failure(NAMES[provider] + " sent back no audio.");
    if (buffer.length > MAX_ANSWER) throw new Failure(NAMES[provider] + " sent back too much.");
    return buffer;
  }

  // ── Where each provider is ──────────────────────────────────────────────────────────────────

  openaiBase() {
    return this.data.providers.openai.baseUrl;
  }
  customBase() {
    const base = this.data.providers.custom.baseUrl;
    if (!base) throw new Failure("Add the address of your speech server in Settings › Voice first.");
    return base;
  }
  azure(need) {
    const azure = this.data.providers.azure;
    if (need === "openai-stt" || need === "openai-tts") {
      const deployment = need === "openai-stt" ? azure.sttDeployment : azure.ttsDeployment;
      if (!azure.endpoint || !deployment) throw new Failure("Add your Azure endpoint and " + (need === "openai-stt" ? "speech to text" : "text to speech") + " deployment in Settings › Voice first.");
      return { base: `${azure.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/audio/${need === "openai-stt" ? "transcriptions" : "speech"}`, deployment, version: azure.apiVersion ?? AZURE_API_VERSION };
    }
    if (!azure.endpoint && !azure.region) throw new Failure("Add your Azure Speech region or endpoint in Settings › Voice first.");
    // A custom subdomain (https://name.cognitiveservices.azure.com) and a regional host take different paths.
    if (azure.endpoint) return { stt: `${azure.endpoint}/speechtotext/transcriptions:transcribe`, tts: `${azure.endpoint}/tts/cognitiveservices/v1`, voices: `${azure.endpoint}/tts/cognitiveservices/voices/list` };
    return {
      stt: `https://${azure.region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe`,
      tts: `https://${azure.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      voices: `https://${azure.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    };
  }
  local(need) {
    const local = this.helpers().local;
    if (!local) throw new Failure("Local speech isn't available in this app.");
    if (typeof local[need] !== "function") throw new Failure("Local speech isn't available in this app.");
    return local;
  }
  /** The model to use for a local run: the chosen one, else the first installed one. */
  localModel(kind, chosen) {
    if (chosen) return chosen;
    const model = this.settings().providers.local.models.find((m) => m.kind === kind && m.installed);
    if (!model) throw new Failure("Install a " + (kind === "stt" ? "speech to text" : "text to speech") + " model in the app first.");
    return model.id;
  }

  // ── Speech to text ──────────────────────────────────────────────────────────────────────────

  /** audio: Buffer; format: wav, m4a, mp3 or webm. Returns { text }. */
  async transcribe({ audio, format, language } = {}) {
    const { provider, model, language: chosenLanguage } = this.data.stt;
    if (provider === "device") throw new Failure(DEVICE);
    if (!(audio instanceof Uint8Array) || !audio.length) throw new Failure("There is no audio to transcribe.");
    if (audio.length > MAX_AUDIO) throw new Failure("That recording is over 25 MB.");
    if (!Object.hasOwn(FORMATS, format)) throw new Failure("Use a wav, m4a, mp3 or webm recording.");
    if (language != null && (typeof language !== "string" || !LANGUAGE.test(language))) throw new Failure("That language isn't valid.");
    const lang = language || chosenLanguage;
    const buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    const file = () => new Blob([buffer], { type: FORMATS[format] });
    let result;
    if (provider === "local") {
      if (format !== "wav") throw new Failure("Local speech needs a wav recording.");
      const local = this.local("transcribe");
      try {
        result = await local.transcribe(buffer, { model: this.localModel("stt", model), language: lang });
      } catch (error) {
        if (error instanceof Failure) throw error;
        this.log("voice: the local speech model failed");
        throw new Failure("The local speech model couldn't read that.");
      }
    } else if (provider === "openai" || provider === "custom") {
      const key = provider === "openai" ? this.keyOf("openai") : this.data.keys.custom;
      const base = provider === "openai" ? this.openaiBase() : this.customBase();
      const chosen = model ?? (provider === "openai" ? DEFAULTS.openai.stt : DEFAULTS.custom.stt);
      const form = new FormData();
      form.append("file", file(), "audio." + format);
      form.append("model", chosen);
      // gpt-transcribe takes a list of languages in place of one (the page says not to send both).
      if (lang) {
        if (provider === "openai") form.append(/^gpt-transcribe/.test(chosen) ? "languages[]" : "language", iso(lang));
        else form.append("language", lang);
      }
      result = await this.json(provider, base + "/audio/transcriptions", { method: "POST", headers: key ? { Authorization: "Bearer " + key } : {}, body: form }, { secrets: [key] });
    } else if (provider === "azure") {
      const key = this.keyOf("azure");
      if (this.data.providers.azure.kind === "openai") {
        const { base, deployment, version } = this.azure("openai-stt");
        const form = new FormData();
        form.append("file", file(), "audio." + format);
        form.append("model", model ?? deployment);
        if (lang) form.append("language", iso(lang));
        result = await this.json("azure", `${base}?api-version=${encodeURIComponent(version)}`, { method: "POST", headers: { "api-key": key }, body: form }, { secrets: [key] });
      } else {
        const { stt } = this.azure("speech");
        const form = new FormData();
        form.append("audio", file(), "audio." + format);
        form.append("definition", JSON.stringify({ locales: lang ? [lang] : [] }));
        const answer = await this.json("azure", `${stt}?api-version=${AZURE_FAST_VERSION}`, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key }, body: form }, { secrets: [key] });
        const phrases = Array.isArray(answer?.combinedPhrases) ? answer.combinedPhrases.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean) : [];
        result = { text: phrases.join(" ") };
      }
    } else if (provider === "elevenlabs") {
      const key = this.keyOf("elevenlabs");
      const form = new FormData();
      form.append("model_id", model ?? DEFAULTS.elevenStt);
      form.append("file", file(), "audio." + format);
      if (lang) form.append("language_code", lang);
      result = await this.json("elevenlabs", ELEVEN + "/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form }, { secrets: [key] });
    } else throw new Failure("That provider doesn't do speech to text.");
    if (typeof result?.text !== "string") throw new Failure(NAMES[provider] + " sent back something unexpected.");
    return { text: result.text.trim() };
  }

  // ── Text to speech ──────────────────────────────────────────────────────────────────────────

  /** Returns { audio: Buffer, format: "mp3" | "wav" }. Callers split long replies by sentence. */
  async speak({ text: input, voice, speed } = {}) {
    const { provider, model, voice: chosenVoice, speed: chosenSpeed } = this.data.tts;
    if (provider === "device") throw new Failure(DEVICE);
    if (typeof input !== "string" || !input.trim()) throw new Failure("There is nothing to read.");
    if (input.length > MAX_SPEAK) throw new Failure("That is too long to read at once. Use up to " + MAX_SPEAK.toLocaleString("en-US") + " characters.");
    let rate = speed ?? chosenSpeed ?? 1;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Failure("Speed is between 0.5 and 2.");
    if (voice != null && (typeof voice !== "string" || !NAME.test(voice))) throw new Failure("That voice isn't valid.");
    const who = voice || chosenVoice;
    if (provider === "local") {
      const local = this.local("synthesize");
      let made;
      try {
        made = await local.synthesize(input, { model: this.localModel("tts", model), voice: who, speed: rate });
      } catch (error) {
        if (error instanceof Failure) throw error;
        this.log("voice: the local speech model failed");
        throw new Failure("The local speech model couldn't read that.");
      }
      const audio = made?.audio;
      if (!(audio instanceof Uint8Array) || !audio.length) throw new Failure("The local speech model sent back no audio.");
      return { audio: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength), format: "wav" };
    }
    if (provider === "openai" || provider === "custom") {
      const key = provider === "openai" ? this.keyOf("openai") : this.data.keys.custom;
      const base = provider === "openai" ? this.openaiBase() : this.customBase();
      const defaults = provider === "openai" ? DEFAULTS.openai : DEFAULTS.custom;
      const body = { model: model ?? defaults.tts, input, voice: who ?? defaults.ttsVoice, response_format: "mp3" };
      if (rate !== 1) body.speed = rate;
      const audio = await this.bytes(provider, base + "/audio/speech", { method: "POST", headers: { ...(key && { Authorization: "Bearer " + key }), "Content-Type": "application/json" }, body: JSON.stringify(body) }, { secrets: [key] });
      const format = sniff(audio);
      // Our own account asked for mp3. A server of the person's own may answer in anything else.
      if (!format && provider === "custom") throw new Failure("Your speech server sent audio this app can't play.");
      return { audio, format: format ?? "mp3" };
    }
    if (provider === "azure") {
      const key = this.keyOf("azure");
      if (this.data.providers.azure.kind === "openai") {
        const { base, deployment, version } = this.azure("openai-tts");
        const body = { model: model ?? deployment, input, voice: who ?? DEFAULTS.azureOpenaiVoice, response_format: "mp3" };
        if (rate !== 1) body.speed = rate;
        const audio = await this.bytes("azure", `${base}?api-version=${encodeURIComponent(version)}`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }, { secrets: [key] });
        return { audio, format: sniff(audio) ?? "mp3" };
      }
      const { tts } = this.azure("speech");
      const name = who ?? DEFAULTS.azureSpeechVoice;
      const locale = name.split("-").slice(0, 2).join("-");
      const spoken = rate === 1 ? xml(input) : `<prosody rate="${rate}">${xml(input)}</prosody>`;
      const ssml = `<speak version='1.0' xml:lang='${xml(locale)}'><voice xml:lang='${xml(locale)}' name='${xml(name)}'>${spoken}</voice></speak>`;
      const headers = { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": "Botkins" };
      const audio = await this.bytes("azure", tts, { method: "POST", headers, body: ssml }, { secrets: [key] });
      return { audio, format: sniff(audio) ?? "mp3" };
    }
    if (provider === "elevenlabs") {
      const key = this.keyOf("elevenlabs");
      let id = who;
      if (!id) id = (await this.options("tts", "elevenlabs")).voices[0]?.id;
      if (!id) throw new Failure("Pick an ElevenLabs voice in Settings › Voice first.");
      if (!SLUG.test(id)) throw new Failure("That voice isn't valid.");
      const body = { text: input, model_id: model ?? DEFAULTS.elevenTts };
      if (rate !== 1) body.voice_settings = { speed: rate };
      const audio = await this.bytes("elevenlabs", `${ELEVEN}/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }, { secrets: [key] });
      return { audio, format: sniff(audio) ?? "mp3" };
    }
    if (provider === "gemini") {
      const key = this.keyOf("gemini");
      // The page has no speed setting, so `speed` is not sent to Gemini.
      const body = {
        model: model ?? DEFAULTS.geminiTts,
        input: [{ type: "user_input", content: [{ type: "text", text: input }] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: who ?? DEFAULTS.geminiVoice }] },
      };
      const answer = await this.json("gemini", GEMINI + "/v1beta/interactions", { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }, { secrets: [key] });
      const parts = (Array.isArray(answer?.steps) ? answer.steps : []).filter((step) => step?.type === "model_output").flatMap((step) => (Array.isArray(step.content) ? step.content : []));
      const data = parts.filter((part) => part?.type === "audio" && typeof part.data === "string").at(-1)?.data;
      if (!data) throw new Failure("Gemini sent back no audio.");
      const audio = Buffer.from(data, "base64");
      if (!audio.length) throw new Failure("Gemini sent back no audio.");
      // The page says a whole answer is WAV; headerless 24 kHz 16-bit samples are wrapped in case it is not.
      return sniff(audio) === "wav" ? { audio, format: "wav" } : { audio: wavFromPcm(audio, 24000), format: "wav" };
    }
    throw new Failure("That provider doesn't do text to speech.");
  }

  // ── Models and voices ───────────────────────────────────────────────────────────────────────

  /** kind: stt, tts or live. Returns { models, voices }; a provider's own lists are kept for 5 minutes. */
  async options(kind, provider) {
    const allowed = { stt: STT_PROVIDERS, tts: TTS_PROVIDERS, live: LIVE_PROVIDERS }[kind];
    if (!allowed) throw new Failure("That isn't a kind of voice.");
    if (!allowed.includes(provider)) throw new Failure("That provider doesn't do " + { stt: "speech to text", tts: "text to speech", live: "live voice" }[kind] + ".");
    const stamp = JSON.stringify([kind, provider, this.data.providers, provider in this.data.keys]);
    const cached = this.cache.get(stamp);
    if (cached && this.now() - cached.at < CACHE_MS) return structuredClone(cached.value);
    const value = await this.lists(kind, provider);
    this.cache.set(stamp, { at: this.now(), value });
    return structuredClone(value);
  }
  async lists(kind, provider) {
    const none = { models: [], voices: [] };
    if (provider === "device") return none;
    if (provider === "codex") {
      // Codex has its own voices, and only it knows them.
      const codex = this.helpers().codex;
      if (kind !== "live" || typeof codex?.voices !== "function") return none;
      try {
        const voices = await codex.voices();
        return { models: [], voices: (Array.isArray(voices) ? voices : []).filter((v) => typeof v?.id === "string" && NAME.test(v.id)).slice(0, 100).map((v) => ({ id: v.id, name: typeof v.name === "string" ? v.name.slice(0, 60) : v.id })) };
      } catch {
        return none;
      }
    }
    if (provider === "local") {
      const local = this.helpers().local;
      if (!local) return none;
      const models = this.settings().providers.local.models.filter((m) => m.kind === kind && m.installed);
      const voices = kind === "tts" ? models.flatMap((m) => (Array.isArray(m.voices) ? m.voices : [])).map((v) => ({ id: v.id, name: v.name })) : [];
      return { models: models.map((m) => ({ id: m.id, name: m.name })), voices };
    }
    if (provider === "openai") {
      if (kind === "stt") return { models: OPENAI_STT, voices: [] };
      if (kind === "tts") return { models: OPENAI_TTS, voices: pick(OPENAI_VOICES) };
      return { models: OPENAI_LIVE, voices: pick(OPENAI_LIVE_VOICES) };
    }
    if (provider === "gemini") {
      if (kind === "tts") return { models: GEMINI_TTS, voices: pick(GEMINI_VOICES) };
      return { models: GEMINI_LIVE, voices: pick(GEMINI_VOICES) };
    }
    if (provider === "azure") {
      const azure = this.data.providers.azure;
      if (azure.kind === "openai") {
        const deployment = kind === "stt" ? azure.sttDeployment : azure.ttsDeployment;
        return { models: deployment ? [{ id: deployment, name: deployment }] : [], voices: kind === "tts" ? pick(AZURE_OPENAI_VOICES) : [] };
      }
      if (kind === "stt") return none;
      const key = this.keyOf("azure");
      const { voices } = this.azure("speech");
      const list = await this.json("azure", voices, { method: "GET", headers: { "Ocp-Apim-Subscription-Key": key } }, { list: true, secrets: [key] });
      return {
        models: [],
        voices: (Array.isArray(list) ? list : [])
          .filter((v) => v && typeof v.ShortName === "string")
          .map((v) => ({ id: v.ShortName, name: clean((v.DisplayName || v.LocalName || v.ShortName) + (v.Gender ? " (" + v.Gender + ")" : "")), ...(typeof v.Locale === "string" && { language: v.Locale }) })),
      };
    }
    if (provider === "elevenlabs") {
      if (kind === "stt") return { models: ELEVEN_STT, voices: [] };
      const key = this.keyOf("elevenlabs");
      const headers = { "xi-api-key": key };
      const options = { list: true, secrets: [key] };
      const voices = [];
      let token;
      for (let page = 0; page < 3; page++) {
        const url = `${ELEVEN}/v2/voices?page_size=100${token ? "&next_page_token=" + encodeURIComponent(token) : ""}`;
        const answer = await this.json("elevenlabs", url, { method: "GET", headers }, options);
        for (const v of Array.isArray(answer?.voices) ? answer.voices : []) {
          if (!v || typeof v.voice_id !== "string") continue;
          const language = typeof v.labels?.language === "string" ? v.labels.language : v.verified_languages?.[0]?.language;
          voices.push({ id: v.voice_id, name: clean(v.name ?? v.voice_id), ...(typeof language === "string" && { language }), ...(typeof v.preview_url === "string" && /^https:\/\//.test(v.preview_url) && { preview: v.preview_url }) });
        }
        token = answer?.has_more && typeof answer.next_page_token === "string" ? answer.next_page_token : undefined;
        if (!token) break;
      }
      if (kind === "live") return { models: [], voices };
      const list = await this.json("elevenlabs", ELEVEN + "/v1/models", { method: "GET", headers }, options);
      const models = (Array.isArray(list) ? list : []).filter((m) => m && m.can_do_text_to_speech === true && typeof m.model_id === "string").map((m) => ({ id: m.model_id, name: clean(m.name ?? m.model_id) }));
      return { models, voices };
    }
    // custom: the person's own OpenAI-compatible server.
    const key = this.data.keys.custom;
    const base = this.customBase();
    const headers = key ? { Authorization: "Bearer " + key } : {};
    const answer = await this.json("custom", base + "/models", { method: "GET", headers }, { list: true, secrets: [key] });
    const models = (Array.isArray(answer?.data) ? answer.data : []).filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, name: m.id }));
    if (kind === "stt") return { models, voices: [] };
    let voices = pick(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]);
    try {
      const found = await this.json("custom", base + "/audio/voices", { method: "GET", headers }, { list: true, secrets: [key] });
      const raw = Array.isArray(found) ? found : Array.isArray(found?.voices) ? found.voices : Array.isArray(found?.data) ? found.data : [];
      const listed = raw
        .map((v) => (typeof v === "string" ? { id: v, name: v } : v && typeof (v.id ?? v.voice_id ?? v.name) === "string" ? { id: v.id ?? v.voice_id ?? v.name, name: clean(v.name ?? v.id ?? v.voice_id) } : null))
        .filter(Boolean);
      if (listed.length) voices = listed;
    } catch {
      // No voices route on that server: the standard names stay.
    }
    return { models, voices };
  }

  // ── Live sessions ───────────────────────────────────────────────────────────────────────────

  /**
   * Sets up one live voice session and returns what the caller needs to connect (see VOICE.md).
   * `tools` is [{ name, description, parameters }]; the caller runs a tool itself and answers on
   * its socket or data channel. `firstMessage` is optional (ElevenLabs only).
   */
  /**
   * `about` ({ chatId?, botId?, botName? }) says whom the voice speaks for. It is handed to the Codex
   * helper, which answers the voice's tool call itself (the call arrives at the app, not at the caller).
   */
  async live({ provider, sdp, instructions, voice, tools, firstMessage, about } = {}) {
    const choice = provider ?? this.data.live.provider;
    if (!choice) throw new Failure("Pick a live voice in Settings › Voice first.");
    if (!LIVE_PROVIDERS.includes(choice)) throw new Failure("That provider doesn't do live voice.");
    if (instructions != null && (typeof instructions !== "string" || instructions.length > 20_000)) throw new Failure("The instructions are up to 20,000 characters.");
    if (firstMessage != null && (typeof firstMessage !== "string" || firstMessage.length > 1000)) throw new Failure("The first message is up to 1,000 characters.");
    if (voice != null && (typeof voice !== "string" || !NAME.test(voice))) throw new Failure("That voice isn't valid.");
    if (sdp != null && (typeof sdp !== "string" || sdp.length > 100_000 || !sdp.startsWith("v=0"))) throw new Failure("That connection offer isn't valid.");
    const list = this.tools(tools);
    const settings = this.data.live;
    const same = settings.provider === choice;
    const model = same ? settings.model : undefined;
    const who = voice ?? (same ? settings.voice : undefined);
    const prompt = instructions ?? "";
    let session;
    if (choice === "codex") session = await this.liveCodex({ sdp, voice: who, instructions: prompt, tools: list, about });
    else if (choice === "openai") session = await this.liveOpenai({ sdp, model: model ?? DEFAULTS.openai.live, voice: who ?? DEFAULTS.openai.liveVoice, instructions: prompt, tools: list });
    else if (choice === "gemini") session = await this.liveGemini({ model: model ?? DEFAULTS.geminiLive, voice: who ?? DEFAULTS.geminiVoice, instructions: prompt, tools: list });
    else session = await this.liveEleven({ voice: who, instructions: prompt, tools: list, firstMessage });
    // Only the oldest sessions are forgotten when too many are open; a Codex one is ended first.
    this.sessions.set(session.id, { provider: choice, at: this.now() });
    while (this.sessions.size > MAX_SESSIONS) this.endLive(this.sessions.keys().next().value);
    return session;
  }

  /** Ends a session this module set up. An id it doesn't know is ignored. */
  endLive(id) {
    const known = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (!known) return;
    this.sessions.delete(id);
    if (known.provider !== "codex") return;
    try {
      this.helpers().codex?.end(id);
    } catch {
      this.log("voice: a Codex live session did not end cleanly");
    }
  }

  tools(tools) {
    if (tools == null) return [];
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS) throw new Failure("Use up to " + MAX_TOOLS + " tools.");
    const names = new Set();
    return tools.map((tool) => {
      if (!isPlain(tool) || typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) throw new Failure("A tool needs its own name of up to 64 letters, digits, - or _.");
      names.add(tool.name);
      if (tool.description != null && (typeof tool.description !== "string" || tool.description.length > 2000)) throw new Failure("A tool's description is up to 2,000 characters.");
      if (tool.parameters != null && (!isPlain(tool.parameters) || JSON.stringify(tool.parameters).length > 50_000)) throw new Failure("A tool's parameters need to be a JSON schema object.");
      return { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } };
    });
  }

  async liveCodex({ sdp, voice, instructions, tools, about }) {
    const codex = this.helpers().codex;
    if (!codex) throw new Failure("Codex isn't available in this app.");
    let signedIn = false;
    try {
      signedIn = !!codex.signedIn();
    } catch {
      signedIn = false;
    }
    if (!signedIn) throw new Failure("Sign in to Codex on your computer first.");
    if (!sdp) throw new Failure("Live voice with Codex needs a connection offer.");
    let answer;
    try {
      const short = (value) => (typeof value === "string" && value.length <= 200 ? value : undefined);
      answer = await codex.live({ sdp, voice, instructions, tools, chatId: short(about?.chatId), botId: short(about?.botId), botName: short(about?.botName) });
    } catch (error) {
      if (error instanceof Failure) throw error;
      this.log("voice: Codex live failed");
      throw new Failure("Codex couldn't start a live voice session.");
    }
    if (typeof answer?.sdp !== "string" || !answer.sdp || typeof answer.id !== "string" || !answer.id) throw new Failure("Codex sent back something unexpected.");
    return { id: answer.id, kind: "webrtc", sdp: answer.sdp };
  }

  /**
   * The OpenAI realtime session. Over WebRTC the audio formats are negotiated, so they are left out.
   * What the person says is transcribed too, so the caller can show both sides of the talk.
   */
  openaiSession({ model, voice, instructions, tools }, socket) {
    const session = { type: "realtime", model, ...(instructions && { instructions }), output_modalities: ["audio"], audio: { input: { turn_detection: { type: "semantic_vad" }, transcription: { model: DEFAULTS.openai.stt } }, output: { voice } } };
    if (socket) {
      session.audio.input.format = { type: "audio/pcm", rate: 24000 };
      session.audio.output.format = { type: "audio/pcm", rate: 24000 };
    }
    if (tools.length) {
      session.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
      session.tool_choice = "auto";
    }
    return session;
  }
  async liveOpenai({ sdp, model, voice, instructions, tools }) {
    const key = this.keyOf("openai");
    const base = this.openaiBase();
    const auth = { Authorization: "Bearer " + key };
    if (sdp) {
      // The computer posts the caller's offer with the real key and hands back only the answer.
      const form = new FormData();
      form.set("sdp", sdp);
      form.set("session", JSON.stringify(this.openaiSession({ model, voice, instructions, tools }, false)));
      const response = await this.send("openai", base + "/realtime/calls", { method: "POST", headers: auth, body: form }, { secrets: [key] });
      let answer;
      try {
        answer = await response.text();
      } catch {
        throw new Failure("OpenAI stopped before it finished.");
      }
      if (!answer.startsWith("v=0")) throw new Failure("OpenAI sent back something unexpected.");
      // The call's id is the last part of the Location header, when the answer carries one.
      const location = response.headers?.get?.("location");
      const callId = typeof location === "string" ? location.split("?")[0].split("/").filter(Boolean).at(-1) : undefined;
      return { id: callId && /^[\w.-]{1,100}$/.test(callId) ? callId : "live-" + b64u(random(9)), kind: "webrtc", sdp: answer };
    }
    const event = { type: "session.update", session: this.openaiSession({ model, voice, instructions, tools }, true) };
    const minted = await this.json("openai", base + "/realtime/client_secrets", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session: event.session }) }, { list: true, secrets: [key] });
    if (typeof minted?.value !== "string" || !minted.value || !Number.isFinite(minted.expires_at)) throw new Failure("OpenAI sent back something unexpected.");
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = url.pathname.replace(/\/+$/, "") + "/realtime";
    url.search = "?model=" + encodeURIComponent(model);
    return { id: "live-" + b64u(random(9)), kind: "openai-ws", url: url.toString(), token: minted.value, expiresAt: minted.expires_at * 1000, session: event };
  }

  /** Gemini and ElevenLabs take a schema subset: `$schema` and `additionalProperties` are dropped, and an empty one left out. */
  trimSchema(schema) {
    const drop = (value) => (Array.isArray(value) ? value.map(drop) : isPlain(value) ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== "$schema" && k !== "additionalProperties").map(([k, v]) => [k, drop(v)])) : value);
    const out = drop(schema);
    return isPlain(out.properties) && Object.keys(out.properties).length ? out : undefined;
  }
  async liveGemini({ model, voice, instructions, tools }) {
    const key = this.keyOf("gemini");
    // A new session has to start within 2 minutes; the token's own life is the default 30 minutes and one use.
    const opens = new Date(this.now() + 2 * 60_000).toISOString();
    const ends = new Date(this.now() + 30 * 60_000).toISOString();
    const minted = await this.json("gemini", GEMINI + "/v1beta/auth_tokens", { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ uses: 1, expireTime: ends, newSessionExpireTime: opens }) }, { list: true, secrets: [key] });
    const token = minted?.name;
    if (typeof token !== "string" || !token) throw new Failure("Gemini sent back something unexpected.");
    const setup = {
      model: "models/" + model,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      ...(instructions && { systemInstruction: { parts: [{ text: instructions }] } }),
      ...(tools.length && { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, ...(t.description && { description: t.description }), ...(this.trimSchema(t.parameters) && { parameters: this.trimSchema(t.parameters) }) })) }] }),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    return { id: "live-" + b64u(random(9)), kind: "gemini-ws", url: `${GEMINI_WS}?access_token=${encodeURIComponent(token)}`, expiresAt: Date.parse(opens), setup: { setup }, input: { sampleRate: 16000 }, output: { sampleRate: 24000 } };
  }

  /** The id of a client tool on ElevenLabs, made once for each tool as it is described. */
  async elevenTool(tool, key) {
    const hash = createHash("sha256").update(JSON.stringify([tool.name, tool.description, tool.parameters])).digest("hex");
    const known = this.data.tools[hash];
    if (known) return known;
    const schema = this.trimSchema(tool.parameters);
    const config = { type: "client", name: tool.name, description: tool.description || tool.name, expects_response: true, ...(schema && { parameters: schema }) };
    const made = await this.json("elevenlabs", ELEVEN + "/v1/convai/tools", { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ tool_config: config }) }, { list: true, secrets: [key] });
    if (typeof made?.id !== "string" || !/^[\w-]{1,100}$/.test(made.id)) throw new Failure("ElevenLabs sent back something unexpected.");
    const next = structuredClone({ ...this.data, locked: this.data.locked });
    next.tools[hash] = made.id;
    this.commit(next, false);
    return made.id;
  }
  async liveEleven({ voice, instructions, tools, firstMessage }) {
    const key = this.keyOf("elevenlabs");
    const toolIds = [];
    for (const tool of tools) toolIds.push(await this.elevenTool(tool, key));
    let agent = this.data.providers.elevenlabs.agentId;
    if (!agent) {
      const body = {
        name: "Botkins",
        conversation_config: { agent: { first_message: "", language: "en", prompt: { prompt: "You are a helpful voice assistant.", tool_ids: toolIds } } },
        platform_settings: { overrides: { conversation_config_override: { agent: { first_message: true, language: true, prompt: { prompt: true, tool_ids: true } }, tts: { voice_id: true } } } },
      };
      let made;
      try {
        made = await this.json("elevenlabs", ELEVEN + "/v1/convai/agents/create", { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }, { list: true, secrets: [key] });
      } catch (error) {
        throw new Failure(error.message + " You can also paste an agent id in Settings › Voice.");
      }
      if (typeof made?.agent_id !== "string" || !/^[\w-]{1,100}$/.test(made.agent_id)) throw new Failure("ElevenLabs sent back something unexpected. You can also paste an agent id in Settings › Voice.");
      agent = made.agent_id;
      const next = structuredClone({ ...this.data, locked: this.data.locked });
      next.providers.elevenlabs = { agentId: agent };
      this.commit(next);
    }
    const signed = await this.json("elevenlabs", `${ELEVEN}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`, { method: "GET", headers: { "xi-api-key": key } }, { list: true, secrets: [key] });
    if (typeof signed?.signed_url !== "string" || !/^wss:\/\//.test(signed.signed_url)) throw new Failure("ElevenLabs sent back something unexpected.");
    const override = { agent: { prompt: { ...(instructions && { prompt: instructions }), ...(toolIds.length && { tool_ids: toolIds }) }, ...(firstMessage != null && { first_message: firstMessage }) }, ...(voice && { tts: { voice_id: voice } }) };
    if (!Object.keys(override.agent.prompt).length) delete override.agent.prompt;
    if (!Object.keys(override.agent).length) delete override.agent;
    const init = { type: "conversation_initiation_client_data", ...(Object.keys(override).length && { conversation_config_override: override }) };
    // The agent's audio is 16 kHz both ways unless it was set up otherwise (its first server message says).
    return { id: "live-" + b64u(random(9)), kind: "elevenlabs-ws", url: signed.signed_url, init, input: { sampleRate: 16000 }, output: { sampleRate: 16000 } };
  }
}

// ── What a live voice knows ─────────────────────────────────────────────────────────────────────
// The voice speaks for a bot in one chat. It is told the chat so far, a light identity (the bot's
// name, role and the start of its instructions; the person's name; the bot's identity file and the
// person's user file, when the app has them) and, when the phone sent it, roughly where the person
// is. With that it answers what is already known itself, and asks the bot only for new work.

/** Character limits. The whole stays well under the 20,000 `live()` takes. */
export const LIVE_LIMITS = { transcript: 8000, message: 1200, note: 2000, name: 80, about: 1500, place: 120 };

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const cut = (text, limit) => (text.length > limit ? text.slice(0, limit).trimEnd() + "…" : text);
const near = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

/**
 * What the phone sent about itself for a live call: `{ location?: { place?, latitude?, longitude? } }`.
 * A place is up to 120 characters; coordinates come as a pair and are rounded to about a kilometre.
 * Anything else in `context` is ignored; a location of the wrong shape is refused.
 */
export function liveContextOf(context) {
  if (context === undefined || context === null) return {};
  const bad = () => new Failure("That location isn't valid.");
  if (!isPlain(context)) throw bad();
  if (context.location === undefined) return {};
  const given = context.location;
  if (!isPlain(given)) throw bad();
  const location = {};
  if (given.place !== undefined) {
    if (typeof given.place !== "string") throw bad();
    const place = oneLine(given.place);
    if (!place || place.length > LIVE_LIMITS.place) throw bad();
    location.place = place;
  }
  const { latitude, longitude } = given;
  if (latitude !== undefined || longitude !== undefined) {
    const valid = (value, limit) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
    if (!valid(latitude, 90) || !valid(longitude, 180)) throw bad();
    location.latitude = near(latitude);
    location.longitude = near(longitude);
  }
  if (!Object.keys(location).length) throw bad();
  return { location };
}

/** One message as the voice hears it: code is named, not read, and the whole is one cut line. */
function spoken(text) {
  return cut(oneLine(String(text ?? "").replace(/```[\s\S]*?(```|$)/g, " (code) ")), LIVE_LIMITS.message);
}

/**
 * The chat so far, oldest first: what the person said and the bots' replies, one line each, labelled
 * with who said it. Text a bot wrote on the way (`interim`), commands and empty messages are left out.
 * Within `budget` characters, the newest messages are kept.
 */
export function liveTranscript(messages, { botName, bots = [], userName, budget = LIVE_LIMITS.transcript } = {}) {
  const person = oneLine(userName).slice(0, LIVE_LIMITS.name) || "Person";
  const names = new Map(bots.map((item) => [item.id, oneLine(item.name)]));
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isPlain(message) || message.interim || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = spoken(message.text);
    if (!text) continue;
    const who = message.role === "user" ? person : (message.botId && names.get(message.botId)) || oneLine(botName) || "Bot";
    lines.push(who + ": " + text);
  }
  const LEFT_OUT = "(Earlier messages left out.)";
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const room = budget - (i > 0 ? LEFT_OUT.length + 1 : 0);
    if (size + lines[i].length + (kept.length ? 1 : 0) > room) break;
    size += lines[i].length + (kept.length ? 1 : 0);
    kept.unshift(lines[i]);
  }
  if (kept.length < lines.length) kept.unshift(LEFT_OUT);
  return kept.join("\n");
}

/**
 * The live voice's instructions. `notes` is what the app gave (`backend.liveContext`):
 * `{ userName?, identity?, user? }`, each cut here. `location` is from `liveContextOf`.
 */
export function liveInstructions({ bot, messages = [], bots = [], notes = {}, location } = {}) {
  const name = oneLine(bot?.name).slice(0, LIVE_LIMITS.name) || "the bot";
  const note = (value) => (typeof value === "string" ? cut(value.trim(), LIVE_LIMITS.note) : "");
  const userName = typeof notes.userName === "string" ? oneLine(notes.userName).slice(0, LIVE_LIMITS.name) : "";
  const identity = note(notes.identity);
  const user = note(notes.user);
  const about = [oneLine(bot?.role), String(bot?.instructions ?? "").trim().slice(0, LIVE_LIMITS.about)].filter(Boolean).join("\n\n");
  const transcript = liveTranscript(messages, { botName: name, bots, userName });
  const coords = location && Number.isFinite(location.latitude) ? location.latitude + ", " + location.longitude : "";
  const place = location?.place ? location.place + (coords ? " (" + coords + ")" : "") : coords && "latitude " + location.latitude + ", longitude " + location.longitude;
  return [
    "You are the voice of " + name + ", a bot the person works with. Speak as " + name + ", in the first person, warmly and briefly: this is a spoken conversation, so no lists, no Markdown, and one or two sentences unless asked for more.",
    "When the answer is already in the conversation below or in these notes, answer it yourself: what " + name + " already said or found, who you are, who the person is, where they are. Don't ask the bot again for something it already answered. Call the ask_bot tool only for new work: fresh or current information, anything to look up, do, change or remember, or when you aren't sure. Then call it once with the request in the person's own words, say a few words such as \"One moment\" while it works, and tell them what it answered in your own words. Never make up what the bot would say.",
    userName && "The person's name is " + userName + ".",
    place && "The person is near " + place + ". Use it only when it helps, such as for the time, the weather or places nearby.",
    about && "About " + name + ":\n" + about,
    identity && name + "'s identity:\n" + identity,
    user && "About " + (userName || "the person") + ":\n" + user,
    transcript && "The conversation so far in this chat, oldest first:\n" + transcript,
  ]
    .filter(Boolean)
    .join("\n\n");
}
