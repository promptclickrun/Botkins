// Voice in the page: reading replies aloud, recording for dictation, and the live voice clients.
// Every provider call goes through the main process (desktop/voicedesk.mjs); keys never reach here.
// A live session's audio goes straight between this page and the provider, as desktop/link/VOICE.md says.
import { useSyncExternalStore } from "react";
import type { DeskLiveSession, DeskVoiceSettings, LiveVoiceEvent } from "./types";
import { liveInputMode, MicGate, RELEASE_TAIL_MS, type InputMode } from "./liveInput";
import { geminiManualTurn, openAiManualTurn } from "./liveProtocol";
import { botDeviceVoices } from "./botVoice";

const api = window.botkins;

/** A main-process error as a sentence (drops Electron's "Error invoking remote method …" prefix). */
export function voiceError(e: unknown) {
  return String(e instanceof Error ? e.message : e)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(Error: )+/, "");
}

/** A tiny store a component can watch with useSyncExternalStore. */
function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const fn of subs) fn();
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

// ── Text for speaking ───────────────────────────────────────────────────────────────────────────

/** Plain text for speech: Markdown marks, code blocks and link addresses left out. */
export function speakable(text: string) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " (The code is in the chat.) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>]+>?/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>|#]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** `text` in parts of up to `max` characters, cut at sentence ends where one is near. */
export function sentences(text: string, max: number) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = -1;
    const re = /[.!?…](?:["'”’)\]]*)(?=\s|$)|\n/g;
    for (let m: RegExpExecArray | null; (m = re.exec(rest)) && m.index < max; ) cut = m.index + m[0].length;
    if (cut < max / 3) {
      const space = rest.lastIndexOf(" ", max);
      cut = space > max / 3 ? space : max;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

// ── Reading aloud ───────────────────────────────────────────────────────────────────────────────

type Reading = { key: string | null; error: string };
const reading = store<Reading>({ key: null, error: "" });
let stopCurrent: (() => void) | null = null;
let generation = 0;

/** Which message is being read now (its key), and the last reading's error, for the page to show. */
export function useReading() {
  return useSyncExternalStore(reading.subscribe, reading.get);
}
/** Stops what is being read, if anything. */
export function stopReading() {
  generation++;
  const stop = stopCurrent;
  stopCurrent = null;
  stop?.();
  if (reading.get().key) reading.set({ key: null, error: "" });
}
export function clearReadingError() {
  if (reading.get().error) reading.set({ ...reading.get(), error: "" });
}

/** The system's voices, once the page has them (they load late on some systems). */
export function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

/** The system voice and speed to read with: this computer's own choice for the bot, else the one in Settings › Voice. */
function systemVoiceFor(botId: string | undefined, tts: DeskVoiceSettings["tts"]) {
  const own = botId ? botDeviceVoices()[botId] : undefined;
  // The shared voice and speed are a system voice's only while "This computer" is the shared choice.
  const shared = tts.provider === "device" ? tts : undefined;
  return { voice: own?.voice ?? shared?.voice, speed: own?.speed ?? shared?.speed ?? 1 };
}

/**
 * Reads `text` aloud with the voice chosen in Settings › Voice, or stops when `key` is already
 * being read. Only one thing is read at a time: starting one stops the other. `botId` is the bot
 * speaking: it may have a voice of its own, which the main process applies over the shared one.
 */
export async function readAloud(key: string, text: string, botId?: string) {
  const same = reading.get().key === key;
  stopReading();
  if (same) return;
  const words = speakable(text);
  if (!words) return;
  const mine = ++generation;
  reading.set({ key, error: "" });
  const finish = (error = "") => {
    if (mine !== generation) return;
    stopCurrent = null;
    reading.set({ key: null, error });
  };
  try {
    const settings = await api.voiceSettings();
    if (mine !== generation) return;
    const system = systemVoiceFor(botId, settings.tts);
    // A bot's own voice may be "This computer" or a provider whatever the shared one is: the main process says which.
    if (!settings.ready || (!botId && settings.tts.provider === "device")) await speakWithSystem(words, system.voice, system.speed, mine);
    else await speakWithProvider(words, mine, botId, system);
    finish();
  } catch (e) {
    finish(voiceError(e));
  }
}

async function speakWithSystem(words: string, voiceName: string | undefined, speed: number, mine: number) {
  const synth = window.speechSynthesis;
  if (!synth) throw new Error("This computer has no voice for reading aloud.");
  const voices = await systemVoices();
  const voice = voices.find((v) => v.voiceURI === voiceName) ?? voices.find((v) => v.name === voiceName);
  if (mine !== generation) return;
  // Short parts: some systems stop a long utterance part way.
  const parts = sentences(words, 220);
  await new Promise<void>((resolve, reject) => {
    let left = parts.length;
    stopCurrent = () => {
      synth.cancel();
      resolve();
    };
    synth.cancel();
    for (const part of parts) {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) u.voice = voice;
      u.rate = Math.min(2, Math.max(0.5, speed));
      u.onend = () => {
        if (--left === 0) resolve();
      };
      u.onerror = (event) => (event.error === "canceled" || event.error === "interrupted" ? resolve() : reject(new Error("This computer couldn't read that aloud.")));
      synth.speak(u);
    }
  });
}

/** A provider's audio, a part at a time: the next part is fetched while one plays. */
async function speakWithProvider(words: string, mine: number, botId: string | undefined, system: { voice?: string; speed: number }) {
  const parts = sentences(words, 1200);
  const audio = new Audio();
  let url = "";
  let cancel: () => void = () => {};
  stopCurrent = () => {
    audio.pause();
    cancel();
  };
  try {
    const options = botId ? { botId } : undefined;
    let next = api.speak(parts[0], options);
    for (let i = 0; i < parts.length; i++) {
      const answer = await next;
      if (mine !== generation) return;
      if (i + 1 < parts.length) next = api.speak(parts[i + 1], options);
      next?.catch(() => {});
      if ("device" in answer) {
        // This computer is the voice (for this bot, or the choice changed meanwhile): the rest is read by the system.
        await speakWithSystem(parts.slice(i).join(" "), system.voice, system.speed, mine);
        return;
      }
      for (const part of answer.parts) {
        if (mine !== generation) return;
        URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob([part.audio as BlobPart], { type: part.format === "mp3" ? "audio/mpeg" : "audio/wav" }));
        audio.src = url;
        await new Promise<void>((resolve, reject) => {
          cancel = resolve;
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("That audio couldn't be played."));
          audio.play().catch(reject);
        });
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Recording (dictation through a provider) ────────────────────────────────────────────────────

/** Audio from the microphone, for transcribe(). Shows how loud it is while it records. */
export class Recorder {
  stream: MediaStream | null = null;
  recorder: MediaRecorder | null = null;
  chunks: Blob[] = [];
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  async start() {
    this.stream = await microphone();
    const type = ["audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
  }
  level() {
    return levelOf(this.analyser);
  }
  /** Stops and gives the recording's bytes. */
  async stop(): Promise<{ bytes: Uint8Array; format: "webm" }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Nothing was recorded.");
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    if (recorder.state !== "inactive") recorder.stop();
    await done;
    const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    this.release();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), format: "webm" };
  }
  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }
  release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/** The microphone, with the browser's echo and noise handling. A refusal is said plainly. */
async function microphone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This computer has no microphone Botkins can use.");
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError")
      throw new Error(
        /Mac/.test(navigator.platform)
          ? "Botkins can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone."
          : "Botkins can't use the microphone. Allow it in your system's privacy settings.",
      );
    if (name === "NotFoundError") throw new Error("No microphone was found.");
    throw new Error("The microphone couldn't be opened.");
  }
}

/** How loud a stream is now, 0 to 1. */
function levelOf(analyser: AnalyserNode | null) {
  if (!analyser) return 0;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.min(1, Math.sqrt(sum / data.length) * 4);
}

// ── Live voice ──────────────────────────────────────────────────────────────────────────────────

/** Providers that speak the OpenAI realtime protocol: OpenAI itself and an Azure resource (the computer holds the key for both). */
const speaksOpenAi = (provider: string) => provider === "openai" || provider === "azure";

export type LiveState = {
  chatId: string;
  provider: string;
  status: "connecting" | "live" | "ended" | "error";
  /** Who is speaking now. */
  speaking: "you" | "bot" | null;
  /** The bot is working on a request (ask_bot). */
  working: boolean;
  muted: boolean;
  /** The voice is heard. Off, the call goes on in silence and the chat still shows what is said. */
  speaker: boolean;
  /** 0 to 1: the microphone's level, or the voice's while it speaks. */
  level: number;
  error: string;
  inputMode: InputMode;
};
const live = store<LiveState | null>(null);
let call: LiveCall | null = null;

/** A live voice is on (replies are not read aloud over it). */
export function liveOn() {
  return !!live.get() && live.get()!.status !== "error";
}
export function useLive() {
  return useSyncExternalStore(live.subscribe, live.get);
}
/** Starts a live voice for a chat, ending one that was already on. */
export function startLive(chatId: string, provider: string) {
  call?.end();
  // The voice does the talking now: nothing else is read aloud over it.
  stopReading();
  call = new LiveCall(chatId, provider);
  void call.start();
}
export function endLive() {
  call?.end();
}
export function closeLive() {
  call?.end();
  call = null;
  live.set(null);
}
export function muteLive(on: boolean) {
  call?.mute(on);
}
/** Turns the voice's sound on or off; the call goes on either way. */
export function speakerLive(on: boolean) {
  call?.speaker(on);
}
/** Stops the bot's current answer and lets the person speak over it. */
export function interruptLive() {
  call?.interrupt();
}
/** The talk key/button for push-to-talk. */
export function pressLive() {
  call?.pressInput();
}
export function releaseLive() {
  call?.releaseInput();
}

const b64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function addOpenAiManualTurn(session: Record<string, unknown>) {
  const inner = session.session && typeof session.session === "object" ? session.session as Record<string, unknown> : session;
  const audio = inner.audio && typeof inner.audio === "object" ? inner.audio as Record<string, unknown> : {};
  const input = audio.input && typeof audio.input === "object" ? audio.input as Record<string, unknown> : {};
  return { ...session, session: { ...inner, audio: { ...audio, input: { ...input, turn_detection: null } } } };
}

function addGeminiManualTurn(session: Record<string, unknown>) {
  const inner = session.setup && typeof session.setup === "object" ? session.setup as Record<string, unknown> : session;
  const config = inner.realtimeInputConfig && typeof inner.realtimeInputConfig === "object" ? inner.realtimeInputConfig as Record<string, unknown> : {};
  const detection = config.automaticActivityDetection && typeof config.automaticActivityDetection === "object" ? config.automaticActivityDetection as Record<string, unknown> : {};
  return { ...session, setup: { ...inner, realtimeInputConfig: { ...config, automaticActivityDetection: { ...detection, disabled: true } } } };
}

/** Plays a provider's 16-bit PCM without gaps, and stops at once when the person talks over it. */
class PcmPlayer {
  next = 0;
  sources = new Set<AudioBufferSourceNode>();
  out: GainNode;
  analyser: AnalyserNode;
  /** The last step before the speakers: its gain is 0 while the person has the sound off. */
  private heard: GainNode;
  constructor(public ctx: AudioContext) {
    this.out = ctx.createGain();
    this.heard = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    this.out.connect(this.heard).connect(ctx.destination);
  }
  silence(on: boolean) {
    this.heard.gain.value = on ? 0 : 1;
  }
  play(data: string | Uint8Array, rate: number) {
    const bytes = typeof data === "string" ? unb64(data) : data;
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.out);
    const at = Math.max(this.next, this.ctx.currentTime + 0.04);
    source.start(at);
    this.next = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }
  get playing() {
    return this.sources.size > 0;
  }
  flush() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.next = 0;
  }
}

/** One live voice session: the connection for its kind, the microphone, the meter and the transcript. */
class LiveCall {
  state: LiveState;
  ended = false;
  session: DeskLiveSession | null = null;
  mic: MediaStream | null = null;
  ctx: AudioContext | null = null;
  micAnalyser: AnalyserNode | null = null;
  outAnalyser: AnalyserNode | null = null;
  player: PcmPlayer | null = null;
  pc: RTCPeerConnection | null = null;
  channel: RTCDataChannel | null = null;
  ws: WebSocket | null = null;
  worklet: AudioWorkletNode | null = null;
  remote: HTMLAudioElement | null = null;
  timer = 0;
  off: (() => void) | null = null;
  // Gemini and ElevenLabs: sound goes up only once the provider is ready for it.
  sending = false;
  inputRate = 16000;
  outputRate = 16000;
  tools = 0;
  private answeredCalls = new Set<string>();
  readonly inputMode = liveInputMode();
  gate: MicGate;
  private releaseTimer: number | null = null;
  private micTimer: number | null = null;
  private turnMs = 0;
  private geminiInput = "";
  private geminiSpeaking = false;
  private lastElevenFinal?: number;
  private elevenReplies = 0;
  private lastElevenReply?: string;

  constructor(chatId: string, provider: string) {
    this.state = { chatId, provider, status: "connecting", speaking: null, working: false, muted: false, speaker: true, level: 0, error: "", inputMode: this.inputMode };
    this.gate = new MicGate(this.inputMode, Date.now, provider === "elevenlabs" ? "silence" : "drop");
    live.set(this.state);
  }
  update(patch: Partial<LiveState>) {
    if (call !== this) return;
    this.state = { ...this.state, ...patch };
    live.set(this.state);
  }
  /** Codex records both speakers in the host. Other providers report their words from here. */
  heard(role: "user" | "assistant", text: string, final: boolean, options?: { item?: string; replace?: boolean; started?: boolean }) {
    if (this.state.provider !== "codex" && this.session && !this.ended) {
      void api.liveVoiceTranscript(this.session.id, text, final, { role, ...options }).catch(e => this.update({ error: voiceError(e) }));
    }
  }
  fail(e: unknown) {
    if (this.ended) return;
    this.update({ status: "error", error: voiceError(e) });
    this.stop();
  }

  async start() {
    try {
      this.mic = await microphone();
      if (this.ended) return this.stop();
      this.ctx = new AudioContext();
      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = 1024;
      this.ctx.createMediaStreamSource(this.mic).connect(this.micAnalyser);
      this.timer = window.setInterval(() => this.meter(), 80);
      if (this.state.provider === "codex" || speaksOpenAi(this.state.provider)) await this.webrtc();
      else await this.socket();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Who is speaking, from the levels and what the provider said. */
  meter() {
    const mic = this.state.muted ? 0 : levelOf(this.micAnalyser);
    const out = levelOf(this.outAnalyser);
    const bot = out > 0.02 || !!this.player?.playing;
    this.gate.level(out);
    this.gate.playing(bot);
    const speaking = bot ? "bot" : mic > 0.06 ? "you" : null;
    const level = Math.round((bot ? Math.max(out, 0.15) : mic) * 20) / 20;
    if (speaking !== this.state.speaking || level !== this.state.level) this.update({ speaking, level });
  }

  /** Runs a tool the voice called and gives back its answer (or what went wrong, for the voice to say). */
  async tool(name: string, args: unknown): Promise<{ text: string; ok: boolean }> {
    this.tools++;
    this.update({ working: true });
    try {
      const parsed = typeof args === "string" ? (args ? JSON.parse(args) : {}) : (args ?? {});
      return { text: await api.liveVoiceTool(this.session!.id, name, parsed as Record<string, unknown>), ok: true };
    } catch (e) {
      return { text: voiceError(e), ok: false };
    } finally {
      if (--this.tools === 0) this.update({ working: false });
    }
  }

  // ── "webrtc": OpenAI with a key, or Codex on the ChatGPT sign-in ──

  async webrtc() {
    await api.startLiveVoice(this.state.chatId, { prepare: true });
    const pc = (this.pc = new RTCPeerConnection());
    for (const track of this.mic!.getAudioTracks()) pc.addTrack(track, this.mic!);
    this.applyMic();
    // The events channel is made before the offer, so the offer carries it.
    const channel = (this.channel = pc.createDataChannel("oai-events"));
    channel.onmessage = (e) => this.openaiEvent(e.data, (event) => channel.readyState === "open" && channel.send(JSON.stringify(event)));
    channel.onopen = () => {
      if (this.inputMode === "push") channel.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } }));
    };
    pc.ontrack = (e) => {
      const audio = (this.remote = new Audio());
      audio.autoplay = true;
      audio.muted = !this.state.speaker;
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      const source = this.ctx!.createMediaStreamSource(audio.srcObject as MediaStream);
      this.outAnalyser = this.ctx!.createAnalyser();
      this.outAnalyser.fftSize = 1024;
      source.connect(this.outAnalyser);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.update({ status: "live" });
      else if (pc.connectionState === "failed") this.fail(new Error("The live voice couldn't connect. Check your network and try again."));
      else if (pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        if (!this.ended && this.state.status === "live") this.fail(new Error("The live voice was disconnected."));
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    // The offer goes with the addresses found in the first moment; the provider finds the rest itself.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, 1200);
      pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && (clearTimeout(timer), resolve()));
    });
    if (this.ended) return this.stop();
    this.session = await api.startLiveVoice(this.state.chatId, { sdp: pc.localDescription!.sdp });
    if (this.ended) return this.stop();
    if (this.session.kind !== "webrtc") throw new Error("The live voice answered in a way Botkins doesn't know.");
    // A Codex session runs its tool calls and transcript in the main process, which tells the page.
    // With a key, the main process only sends words for the voice to say later (see `later`).
    const codex = this.state.provider === "codex";
    this.off = api.onLiveVoice((event: LiveVoiceEvent) => {
      if (event.sessionId !== this.session?.id) return;
      if (event.type === "say") {
        if (!codex) this.later(event.text, (message) => channel.readyState === "open" && channel.send(JSON.stringify(message)));
      } else if (!codex) return;
      else if (event.type === "ended") event.reason ? this.fail(new Error(event.reason)) : this.end();
    });
    await pc.setRemoteDescription({ type: "answer", sdp: this.session.sdp });
  }

  /** An OpenAI Realtime event, from the data channel or the socket. `send` answers on the same way. */
  openaiEvent(data: unknown, send: (event: Record<string, unknown>) => void) {
    let event: Record<string, any>;
    try {
      event = JSON.parse(String(data));
    } catch {
      return;
    }
    const codex = this.state.provider === "codex";
    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.update({ status: "live" });
        return;
      case "input_audio_buffer.speech_started":
        if (!codex && event.item_id) this.heard("user", "", false, { item: event.item_id, started: true });
        // The person talks over the voice: it stops at once.
        this.player?.flush();
        return;
      case "input_audio_buffer.committed":
        if (!codex && event.item_id) this.heard("user", "", false, { item: event.item_id, started: true });
        return;
      case "output_audio_buffer.started":
        this.gate.playing(true);
        for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = false;
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.gate.playing(false);
        this.applyMic();
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (this.player && typeof event.delta === "string") {
          this.player.play(event.delta, 24000);
          const pad = event.delta.endsWith("==") ? 2 : event.delta.endsWith("=") ? 1 : 0;
          this.gate.queued((Math.floor((event.delta.length * 3) / 4) - pad) / 2 / 24000 * 1000);
        }
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (!codex) this.heard("user", String(event.delta ?? ""), false, { item: event.item_id });
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (!codex) this.heard("user", String(event.transcript ?? ""), true, { item: event.item_id });
        return;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (!codex) this.heard("assistant", String(event.delta ?? ""), false, { item: event.item_id });
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (!codex) this.heard("assistant", String(event.transcript ?? ""), true, { item: event.item_id });
        return;
      case "response.function_call_arguments.done": {
        // Codex answers its own tool calls; with a key, the page does.
        if (codex || typeof event.call_id !== "string" || this.answeredCalls.has(event.call_id)) return;
        this.answeredCalls.add(event.call_id);
        void this.tool(String(event.name), event.arguments).then(({ text }) => {
          if (this.ended) return;
          send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: text } });
          send({ type: "response.create" });
        });
        return;
      }
      case "error":
        if (event.error?.message) this.update({ error: String(event.error.message).slice(0, 300) });
        return;
    }
  }

  /**
   * Words for the voice to say outside a tool call: the bot's answer to a request that outlasted
   * its call (the bot stopped for an approval, or worked for a long time). They go into the
   * conversation in the provider's own way. `send` is how this session sends JSON to its provider.
   */
  later(text: string, send: (message: Record<string, unknown>) => void) {
    if (this.ended || !this.session) return;
    const kind = this.session.kind;
    if (kind === "webrtc" || kind === "openai-ws") {
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      send({ type: "response.create" });
    } else if (kind === "gemini-ws") send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
    else if (kind === "elevenlabs-ws") send({ type: "user_message", text });
  }

  // ── The socket kinds: "openai-ws", "gemini-ws", "elevenlabs-ws" ──

  async socket() {
    const session = (this.session = await api.startLiveVoice(this.state.chatId, {}));
    if (this.ended) return this.stop();
    this.player = new PcmPlayer(this.ctx!);
    this.applySpeaker();
    this.outAnalyser = this.player.analyser;
    let ws: WebSocket;
    if (session.kind === "openai-ws") {
      this.inputRate = this.outputRate = 24000;
      ws = new WebSocket(session.url, ["realtime", "openai-insecure-api-key." + session.token]);
      ws.onopen = () => {
        const initial = this.inputMode === "push" ? addOpenAiManualTurn(session.session) : session.session;
        ws.send(JSON.stringify(initial));
        this.sending = true;
        this.update({ status: "live" });
      };
      ws.onmessage = (e) => this.openaiEvent(e.data, (event) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event)));
    } else if (session.kind === "gemini-ws") {
      this.inputRate = session.input.sampleRate;
      this.outputRate = session.output.sampleRate;
      ws = new WebSocket(session.url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(JSON.stringify(this.inputMode === "push" ? addGeminiManualTurn(session.setup) : session.setup));
      ws.onmessage = (e) => this.geminiMessage(e.data, ws);
    } else if (session.kind === "elevenlabs-ws") {
      this.inputRate = session.input.sampleRate;
      this.outputRate = session.output.sampleRate;
      ws = new WebSocket(session.url);
      ws.onopen = () => {
        ws.send(JSON.stringify(session.init));
        this.sending = true;
        this.update({ status: "live" });
      };
      ws.onmessage = (e) => this.elevenMessage(e.data, ws);
    } else throw new Error("The live voice answered in a way Botkins doesn't know.");
    this.ws = ws;
    this.off = api.onLiveVoice((event: LiveVoiceEvent) => {
      if (event.sessionId === session.id && event.type === "say") this.later(event.text, (message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message)));
    });
    ws.onerror = () => this.fail(new Error("The live voice couldn't connect. Check your network and try again."));
    ws.onclose = (e) => {
      if (this.ended) return;
      if (e.code === 1000 || e.code === 1005) this.end();
      else this.fail(new Error("The live voice ended" + (e.reason ? ": " + e.reason.slice(0, 200).replace(/\.?$/, ".") : ".")));
    };
    await this.capture(ws, session.kind);
  }

  /** The microphone as 16-bit PCM at the session's input rate, sent in the provider's own message. */
  async capture(ws: WebSocket, kind: string) {
    const ctx = this.ctx!;
    await ctx.audioWorklet.addModule(new URL("./pcm-capture.js", document.baseURI).href);
    if (this.ended) return;
    const node = (this.worklet = new AudioWorkletNode(ctx, "botkins-pcm-capture", { processorOptions: { rate: this.inputRate } }));
    ctx.createMediaStreamSource(this.mic!).connect(node);
    // A worklet runs only while it leads somewhere; this leads to silence.
    const quiet = ctx.createGain();
    quiet.gain.value = 0;
    node.connect(quiet).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const audio = b64(new Uint8Array(e.data));
      if (!this.sending || this.state.muted || ws.readyState !== WebSocket.OPEN) return;
      const decision = this.gate.frame(audio, levelOf(this.micAnalyser));
      if (decision.barge) this.interrupt();
      for (const data of decision.send) {
        if (kind === "openai-ws") ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data }));
        else if (kind === "gemini-ws") ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=" + this.inputRate } } }));
        else ws.send(JSON.stringify({ user_audio_chunk: data }));
      }
    };
  }

  geminiMessage(data: unknown, ws: WebSocket) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (message.setupComplete) {
      this.sending = true;
      this.update({ status: "live" });
    }
    const content = message.serverContent;
    if (content) {
      if (content.interrupted) this.player?.flush();
      for (const part of content.modelTurn?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data && /^audio\/pcm/.test(inline.mimeType ?? "audio/pcm")) {
          const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1]) || this.outputRate;
          this.player?.play(inline.data, rate);
          this.gate.queued((inline.data.length * 3 / 4) / 2 / rate * 1000);
        }
      }
      if (content.inputTranscription?.text || content.interimInputTranscription?.text) {
        this.geminiSpeaking = true;
        this.geminiInput += content.inputTranscription?.text ?? "";
        this.heard("user", this.geminiInput + (content.interimInputTranscription?.text ?? ""), false, { replace: true });
      }
      if (this.geminiSpeaking && (content.turnComplete || content.inputTranscription?.finished)) {
        this.heard("user", "", true);
        this.geminiInput = "";
        this.geminiSpeaking = false;
      }
      if (content.outputTranscription?.text) this.heard("assistant", content.outputTranscription.text, false);
      if (content.turnComplete || content.interrupted || content.outputTranscription?.finished) this.heard("assistant", "", true);
    }
    for (const fc of message.toolCall?.functionCalls ?? []) {
      void this.tool(String(fc.name), fc.args ?? {}).then(({ text, ok }) => {
        if (this.ended || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: ok ? { result: text } : { error: text } }] } }));
      });
    }
    if (message.goAway) this.update({ error: "The live voice is about to end." });
  }

  elevenMessage(data: unknown, ws: WebSocket) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (message.type) {
      case "conversation_initiation_metadata": {
        const meta = message.conversation_initiation_metadata_event ?? {};
        const rate = (format: unknown) => Number(/^pcm_(\d+)$/.exec(String(format ?? ""))?.[1]) || 0;
        this.outputRate = rate(meta.agent_output_audio_format) || this.outputRate;
        const input = rate(meta.user_input_audio_format);
        if (input && input !== this.inputRate) {
          // The agent wants another rate: the capture starts again at that rate.
          this.inputRate = input;
          this.worklet?.disconnect();
          void this.capture(ws, "elevenlabs-ws").catch((e) => this.fail(e));
        }
        return;
      }
      case "audio": {
        const audio = message.audio_event?.audio_base_64;
        if (typeof audio === "string") this.player?.play(audio, this.outputRate);
        return;
      }
      case "interruption":
        this.player?.flush();
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
        return;
      case "tentative_user_transcript":
      case "user_transcript": {
        const final = message.type === "user_transcript";
        const event = final ? message.user_transcription_event : message.tentative_user_transcription_event;
        if (!event?.user_transcript || (typeof event.event_id === "number" && event.event_id === this.lastElevenFinal)) return;
        this.heard("user", event.user_transcript, final, { replace: true });
        if (final) this.lastElevenFinal = event.event_id;
        return;
      }
      case "agent_chat_response_part": {
        const part = message.text_response_part;
        if (part?.type === "delta" && part.response_id) {
          this.lastElevenReply = part.response_id;
          this.heard("assistant", String(part.text ?? ""), false, { item: part.response_id });
        }
        return;
      }
      case "agent_response": {
        const event = message.agent_response_event;
        this.lastElevenReply = event?.response_id ?? "reply-" + ++this.elevenReplies;
        this.heard("assistant", String(event?.agent_response ?? ""), true, { item: this.lastElevenReply });
        return;
      }
      case "agent_response_correction": {
        const event = message.agent_response_correction_event;
        const item = event?.response_id ?? this.lastElevenReply;
        if (item && event?.corrected_agent_response) this.heard("assistant", event.corrected_agent_response, true, { item, replace: true });
        return;
      }
      case "client_tool_call": {
        const callInfo = message.client_tool_call ?? {};
        void this.tool(String(callInfo.tool_name), callInfo.parameters ?? {}).then(({ text, ok }) => {
          if (this.ended || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "client_tool_result", tool_call_id: callInfo.tool_call_id, result: text, is_error: !ok }));
        });
        return;
      }
    }
  }

  mute(on: boolean) {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !on;
    this.update({ muted: on });
    this.applyMic();
  }
  /** The sound is cut where it leaves, after the meter, so the dock still shows the voice speaking. */
  speaker(on: boolean) {
    this.update({ speaker: on });
    this.applySpeaker();
  }
  private applySpeaker() {
    if (this.remote) this.remote.muted = !this.state.speaker;
    this.player?.silence(!this.state.speaker);
  }
  private applyMic() {
    if (this.micTimer !== null) window.clearTimeout(this.micTimer);
    this.micTimer = null;
    const enabled = !this.state.muted && !this.ended && this.gate.open();
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = enabled;
    const wait = this.gate.wait();
    if (wait !== null && !this.ended) this.micTimer = window.setTimeout(() => this.applyMic(), wait + 5);
  }
  interrupt() {
    if (this.ended) return;
    if (this.state.provider === "codex" || speaksOpenAi(this.state.provider)) {
      if (this.channel?.readyState === "open") {
        this.channel.send(JSON.stringify({ type: "response.cancel" }));
        this.channel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
      } else if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "response.cancel" }));
        this.ws.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
      }
    } else if (this.state.provider === "gemini") this.player?.flush();
    else if (this.state.provider === "elevenlabs") this.player?.flush();
    this.gate.cut();
    this.applyMic();
  }
  pressInput() {
    if (this.inputMode !== "push" || this.ended || this.gate.holding) return;
    this.turnMs = 0;
    if (this.inputMode === "push") this.interrupt();
    this.gate.press();
    if (this.ws?.readyState === WebSocket.OPEN && this.state.provider === "gemini") this.ws.send(JSON.stringify(geminiManualTurn("start")));
    const socket = speaksOpenAi(this.state.provider) ? this.ws : this.channel;
    const open = speaksOpenAi(this.state.provider) ? socket?.readyState === WebSocket.OPEN : socket?.readyState === "open";
    if (open && socket && (speaksOpenAi(this.state.provider) || this.state.provider === "codex")) socket.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    this.applyMic();
  }
  releaseInput() {
    if (this.inputMode !== "push" || !this.gate.holding) return;
    this.turnMs += this.gate.release();
    this.applyMic();
    if (this.releaseTimer !== null) window.clearTimeout(this.releaseTimer);
    if (this.micTimer !== null) window.clearTimeout(this.micTimer);
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      if (this.ended) return;
      if (this.ws?.readyState === WebSocket.OPEN && this.state.provider === "gemini") this.ws.send(JSON.stringify(geminiManualTurn("end")));
      const socket = speaksOpenAi(this.state.provider) ? this.ws : this.channel;
      const open = speaksOpenAi(this.state.provider) ? socket?.readyState === WebSocket.OPEN : socket?.readyState === "open";
      if (open && socket && (speaksOpenAi(this.state.provider) || this.state.provider === "codex")) {
        for (const message of openAiManualTurn(this.turnMs)) socket.send(JSON.stringify(message));
      }
      this.applyMic();
    }, RELEASE_TAIL_MS + 10);
  }
  /** The person ended it. */
  end() {
    if (this.ended) return;
    this.update({ status: "ended" });
    this.stop();
    if (call === this) {
      call = null;
      live.set(null);
    }
  }
  /** Closes everything this session opened. */
  stop() {
    this.ended = true;
    window.clearInterval(this.timer);
    if (this.releaseTimer !== null) window.clearTimeout(this.releaseTimer);
    this.off?.();
    this.off = null;
    this.player?.flush();
    try {
      this.ws?.close(1000);
    } catch {
      /* already closed */
    }
    this.channel?.close();
    this.pc?.close();
    if (this.remote) this.remote.srcObject = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => {});
    this.ws = null;
    this.pc = null;
    this.mic = null;
    if (this.session) void api.endLiveVoice(this.session.id).catch(() => {});
    else if (this.state.provider === "codex" || speaksOpenAi(this.state.provider)) void api.endLiveVoice("").catch(() => {});
    this.session = null;
  }
}

/** Whether a live voice can start: a provider is chosen (and, for Codex, signed in). */
export function liveReady(settings: DeskVoiceSettings | null) {
  const provider = settings?.live.provider ?? null;
  return { provider, ok: !!settings?.ready && !!provider };
}
