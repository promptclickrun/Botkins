// Voice on the phone: text made speakable and split into parts, dictation's phrases, the live
// transports' event handling against a fake socket and a fake sound module, and the ask_bot round
// trip against a fake chat. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceSettings } from "../src/link/types";
import { missing, providerState } from "../src/features/voice/choices";
import { ElevenLabsTransport, pcmRate } from "../src/features/voice/live/elevenlabs";
import { GeminiTransport } from "../src/features/voice/live/gemini";
import { OpenAIRealtime, OpenAISocketTransport, withTranscription } from "../src/features/voice/live/openai";
import { askBot, type ChatMessage, CUT_NOTE, LOOK_AT_PHONE, MAX_REPLY, replyText, STILL_WORKING } from "../src/features/voice/live/askBot";
import { type AudioFrame, type DuplexLike, type Line, type LiveStatus, textOf } from "../src/features/voice/live/types";
import { FIRST_PART, LATER_PART_MAX, nextPhrase, speakable, splitForSpeech } from "../src/features/voice/speakable";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Speakable text

test("code blocks are said once, never symbol by symbol", () => {
  const text = speakable("Run this:\n\n```js\nconst a = { b: [1, 2] };\nconsole.log(a);\n```\n\nThen this:\n```\nnpm test\n```\n```\nmore\n```");
  assert.equal(text, "Run this: Code block. Then this: Code block.");
  assert.ok(!/[{}\[\];]/.test(text));
  // A block still open at the end (a reply being written) is the same.
  assert.equal(speakable("Here:\n```py\nprint(1)"), "Here: Code block.");
});

test("addresses are not spelled out, links keep their words", () => {
  assert.equal(speakable("See [the docs](https://example.com/a/b?c=d) now."), "See the docs now.");
  assert.equal(speakable("Go to https://www.github.com/botkins/app/pull/12 for it."), "Go to a link to github.com for it.");
  assert.equal(speakable("![A chart of sales](https://x.io/c.png)"), "Image: A chart of sales.");
  assert.ok(!speakable("Read <https://example.com/x> first").includes("https"));
});

test("lists, headings and tables become sentences", () => {
  assert.equal(speakable("# Plan\n\n- Buy milk\n- Call Sam\n1. First step\n2. Second step"), "Plan. Buy milk. Call Sam. First step. Second step.");
  assert.equal(speakable("| Name | Size |\n| --- | --- |\n| a.txt | 2 KB |"), "Name, Size. a.txt, 2 KB.");
  assert.equal(speakable("This is **bold**, _soft_ and `code`."), "This is bold, soft and code.");
  assert.equal(speakable("> Quoted line"), "Quoted line");
});

test("the first part is short, later parts grow up to about 400 characters", () => {
  const sentence = (n: number) => "This is sentence number " + n + " and it says a little more than that.";
  const text = Array.from({ length: 40 }, (_, n) => sentence(n)).join(" ");
  const parts = splitForSpeech(text);
  assert.ok(parts[0]!.length >= FIRST_PART.min && parts[0]!.length <= FIRST_PART.max, "first part " + parts[0]!.length);
  for (const part of parts) assert.ok(part.length <= LATER_PART_MAX, "part too long: " + part.length);
  assert.ok(parts[parts.length - 2]!.length > 200, "later parts grow");
  assert.equal(parts.join(" "), text);
  // Every part ends at a sentence.
  for (const part of parts) assert.match(part, /\.$/);
});

test("one long sentence is cut at a comma or a space", () => {
  const long = Array.from({ length: 60 }, (_, n) => "word" + n).join(" ") + ", and then " + Array.from({ length: 80 }, (_, n) => "more" + n).join(" ") + ".";
  const parts = splitForSpeech(long);
  assert.ok(parts.length > 2);
  assert.ok(parts[0]!.length <= FIRST_PART.max);
  for (const part of parts) assert.ok(part.length <= LATER_PART_MAX);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long);
  assert.deepEqual(splitForSpeech("Short."), ["Short."]);
  assert.deepEqual(splitForSpeech("   "), []);
});

test("dictation keeps a phrase the recognizer dropped after a pause", () => {
  assert.deepEqual(nextPhrase("", "hello"), { current: "hello" });
  assert.deepEqual(nextPhrase("hello", "hello there"), { current: "hello there" });
  assert.deepEqual(nextPhrase("Hello there, how are you doing today", "Fine"), { done: "Hello there, how are you doing today", current: "Fine" });
  // A correction of the same phrase is not a new phrase.
  assert.deepEqual(nextPhrase("I scream", "Ice cream for everyone"), { current: "Ice cream for everyone" });
});

// ---- Fakes for the transports

class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string[],
    readonly headers?: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown, binary = false) {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
  types() {
    return this.sent.map((message) => message.type ?? Object.keys(message)[0]);
  }
}

class FakeAudio implements DuplexLike {
  started: { inputRate: number; outputRate: number; speaker?: boolean }[] = [];
  played: string[] = [];
  flushed = 0;
  muted = false;
  stopped = 0;
  private frames = new Set<(frame: AudioFrame) => void>();
  async start(options: { inputRate: number; outputRate: number; speaker?: boolean }) {
    this.started.push(options);
  }
  play(base64: string) {
    this.played.push(base64);
  }
  flush() {
    this.flushed += 1;
  }
  setMuted(muted: boolean) {
    this.muted = muted;
  }
  async stop() {
    this.stopped += 1;
  }
  addListener(name: string, listener: (value: never) => void) {
    if (name === "frame") this.frames.add(listener as (frame: AudioFrame) => void);
    return { remove: () => void this.frames.delete(listener as (frame: AudioFrame) => void) };
  }
  frame(data: string) {
    for (const listener of this.frames) listener({ data, level: 0.5 });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const connect = (url: string, protocols?: string[], headers?: Record<string, string>) => {
    const socket = new FakeSocket(url, protocols, headers);
    sockets.push(socket);
    return socket;
  };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const tools = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    await tick(5);
    return "The bot says hi.";
  };
  return { sockets, connect, calls, tools, audio: new FakeAudio() };
}

function watch(transport: { on(event: "status", listener: (value: LiveStatus) => void): () => void; on(event: "line", listener: (value: Line) => void): () => void }) {
  const statuses: LiveStatus[] = [];
  const lines = new Map<string, Line>();
  transport.on("status", (status) => statuses.push(status));
  transport.on("line", (line) => lines.set(line.id, line));
  return { statuses, lines };
}

// ---- OpenAI

test("OpenAI: the session asks for the person's transcript, once", () => {
  const given = { type: "session.update", session: { type: "realtime", audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { voice: "marin" } } } };
  const out = withTranscription(given) as typeof given & { session: { audio: { input: Record<string, unknown> } } };
  assert.deepEqual(out.session.audio.input.transcription, { model: "gpt-transcribe" });
  assert.deepEqual(out.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  const already = { type: "session.update", session: { audio: { input: { transcription: null } } } };
  assert.equal(withTranscription(already), already);
});

test("OpenAI socket: token, first message, microphone, transcripts and sound", async () => {
  const h = harness();
  const session = { url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", token: "ek_test", session: { type: "session.update", session: { type: "realtime" } } };
  const transport = new OpenAISocketTransport(session, h.audio, h.connect, h.tools);
  const seen = watch(transport);
  const started = transport.start();
  const socket = h.sockets[0]!;
  assert.deepEqual(socket.protocols, ["realtime", "openai-insecure-api-key.ek_test"]);
  assert.equal(socket.headers?.Authorization, "Bearer ek_test");
  socket.open();
  await started;
  assert.equal(socket.sent[0]!.type, "session.update");
  assert.deepEqual(h.audio.started[0], { inputRate: 24000, outputRate: 24000, speaker: true });
  h.audio.frame("AAAA");
  assert.deepEqual(socket.sent[1], { type: "input_audio_buffer.append", audio: "AAAA" });
  transport.mute(true);
  h.audio.frame("BBBB");
  assert.equal(socket.sent.length, 2, "nothing is sent while muted");
  transport.mute(false);

  socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "What's on my list?" });
  socket.receive({ type: "response.output_audio.delta", item_id: "b1", delta: "AAAAAAAA" });
  socket.receive({ type: "response.output_audio_transcript.delta", item_id: "b1", delta: "You have " });
  socket.receive({ type: "response.output_audio_transcript.delta", item_id: "b1", delta: "three things." });
  assert.deepEqual(h.audio.played, ["AAAAAAAA"]);
  assert.deepEqual(seen.lines.get("u1"), { id: "u1", who: "you", text: "What's on my list?", final: true });
  assert.equal(seen.lines.get("b1")!.text, "You have three things.");

  // The person talks over the bot: playing stops and the item is cut.
  socket.receive({ type: "input_audio_buffer.speech_started", item_id: "u2" });
  assert.equal(h.audio.flushed, 1);
  transport.end();
  assert.ok(socket.closed);
  assert.equal(transport.status, "ended");
  assert.equal(seen.statuses[seen.statuses.length - 1], "ended");
});

test("OpenAI: a tool call runs once, answers, then asks for a response", async () => {
  const sent: Record<string, unknown>[] = [];
  const statuses: LiveStatus[] = [];
  const calls: string[] = [];
  const realtime = new OpenAIRealtime({
    send: (event) => sent.push(event),
    status: (status) => statuses.push(status),
    line: () => {},
    tool: async (name, args) => {
      calls.push(name + ":" + String(args.message));
      return { output: "Done: 3 items.", error: false };
    },
    error: () => {},
  });
  const call = { type: "function_call", call_id: "call_1", name: "ask_bot", arguments: JSON.stringify({ message: "What's on my list?" }) };
  realtime.handle(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call_1", name: "ask_bot", arguments: call.arguments }));
  realtime.handle(JSON.stringify({ type: "response.done", response: { status: "completed", output: [call] } }));
  await tick(1);
  assert.deepEqual(calls, ["ask_bot:What's on my list?"]);
  assert.deepEqual(sent, [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ result: "Done: 3 items." }) } },
    { type: "response.create" },
  ]);
  // The same call again (a repeated event) doesn't run twice; a cancelled response runs nothing.
  realtime.handle(JSON.stringify({ type: "response.done", response: { status: "completed", output: [call] } }));
  realtime.handle(JSON.stringify({ type: "response.done", response: { status: "cancelled", output: [{ ...call, call_id: "call_2" }] } }));
  await tick(1);
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 2);
});

test("OpenAI socket: the bot thinks while the tool runs", async () => {
  const h = harness();
  const transport = new OpenAISocketTransport({ url: "wss://x", token: "ek_1", session: { type: "session.update", session: {} } }, h.audio, h.connect, h.tools);
  const seen = watch(transport);
  const started = transport.start();
  h.sockets[0]!.open();
  await started;
  h.sockets[0]!.receive({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", call_id: "c9", name: "ask_bot", arguments: '{"message":"hi"}' }] } });
  await tick(1);
  assert.equal(transport.status, "thinking");
  await tick(20);
  assert.ok(seen.statuses.includes("thinking"));
  assert.equal(transport.status, "listening");
  assert.deepEqual(h.calls, [{ name: "ask_bot", args: { message: "hi" } }]);
  assert.deepEqual(h.sockets[0]!.types().slice(-2), ["conversation.item.create", "response.create"]);
  transport.end();
});

// ---- Gemini

test("Gemini: setup first, sound after setupComplete, transcripts, interruption and tools", async () => {
  const h = harness();
  const setup = { setup: { model: "models/gemini-3.8-live" } };
  const transport = new GeminiTransport({ url: "wss://generativelanguage.googleapis.com/ws/x?access_token=t", setup, input: { sampleRate: 16000 }, output: { sampleRate: 24000 } }, h.audio, h.connect, h.tools);
  const seen = watch(transport);
  const started = transport.start();
  const socket = h.sockets[0]!;
  socket.open();
  assert.deepEqual(socket.sent[0], setup);
  assert.equal(h.audio.started.length, 0, "no sound before the setup took");
  // Gemini may send JSON in a binary frame.
  socket.receive({ setupComplete: {} }, true);
  await started;
  assert.deepEqual(h.audio.started[0], { inputRate: 16000, outputRate: 24000, speaker: true });
  h.audio.frame("CCCC");
  assert.deepEqual(socket.sent[1], { realtimeInput: { audio: { data: "CCCC", mimeType: "audio/pcm;rate=16000" } } });

  socket.receive({ serverContent: { inputTranscription: { text: "Hello " } } });
  socket.receive({ serverContent: { inputTranscription: { text: "there" } } });
  socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "DDDD" } }] }, outputTranscription: { text: "Hi!" } } });
  socket.receive({ serverContent: { turnComplete: true } });
  assert.deepEqual(h.audio.played, ["DDDD"]);
  assert.deepEqual(seen.lines.get("you-1"), { id: "you-1", who: "you", text: "Hello there", final: true });
  assert.deepEqual(seen.lines.get("bot-1"), { id: "bot-1", who: "bot", text: "Hi!", final: true });

  socket.receive({ serverContent: { interrupted: true } });
  assert.equal(h.audio.flushed, 1);

  socket.receive({ toolCall: { functionCalls: [{ id: "f1", name: "ask_bot", args: { message: "Plan my day" } }] } });
  await tick(20);
  assert.deepEqual(socket.sent[socket.sent.length - 1], { toolResponse: { functionResponses: [{ id: "f1", name: "ask_bot", response: { result: "The bot says hi." } }] } });

  // A call Gemini took back gets no answer.
  socket.receive({ toolCall: { functionCalls: [{ id: "f2", name: "ask_bot", args: { message: "x" } }] } });
  socket.receive({ toolCallCancellation: { ids: ["f2"] } });
  const before = socket.sent.length;
  await tick(20);
  assert.equal(socket.sent.length, before);

  transport.mute(true);
  assert.deepEqual(socket.sent[socket.sent.length - 1], { realtimeInput: { audioStreamEnd: true } });
  transport.end();
  assert.ok(socket.closed);
  assert.ok(h.audio.stopped >= 1);
});

test("Gemini: a socket that closes before the setup took is a plain error", async () => {
  const h = harness();
  const transport = new GeminiTransport({ url: "wss://x", setup: { setup: {} }, input: { sampleRate: 16000 }, output: { sampleRate: 24000 } }, h.audio, h.connect, h.tools);
  const started = transport.start();
  h.sockets[0]!.open();
  h.sockets[0]!.onclose?.({ code: 1008, reason: "Token expired" });
  await assert.rejects(started, /Gemini refused the call: Token expired/);
});

// ---- ElevenLabs

test("ElevenLabs: init, formats from the first message, pong, tools and interruption", async () => {
  const h = harness();
  const init = { type: "conversation_initiation_client_data", conversation_config_override: { agent: { prompt: { prompt: "Be brief", tool_ids: ["t1"] } } } };
  const transport = new ElevenLabsTransport({ url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&token=t", init, input: { sampleRate: 16000 }, output: { sampleRate: 16000 } }, h.audio, h.connect, h.tools, 1000);
  const seen = watch(transport);
  const started = transport.start();
  const socket = h.sockets[0]!;
  socket.open();
  assert.deepEqual(socket.sent[0], init);
  socket.receive({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c1", agent_output_audio_format: "pcm_24000", user_input_audio_format: "pcm_16000" } });
  await started;
  assert.deepEqual(h.audio.started[0], { inputRate: 16000, outputRate: 24000, speaker: true });
  h.audio.frame("EEEE");
  assert.deepEqual(socket.sent[1], { user_audio_chunk: "EEEE" });

  socket.receive({ type: "user_transcript", user_transcription_event: { user_transcript: "What's new?" } });
  socket.receive({ type: "audio", audio_event: { audio_base_64: "FFFF", event_id: 3 } });
  socket.receive({ type: "agent_response", agent_response_event: { agent_response: "Not much" } });
  socket.receive({ type: "agent_response_correction", agent_response_correction_event: { original_agent_response: "Not much", corrected_agent_response: "Not much at" } });
  assert.deepEqual(h.audio.played, ["FFFF"]);
  assert.equal(seen.lines.get("you-1")!.text, "What's new?");
  assert.equal(seen.lines.get("bot-2")!.text, "Not much at");

  socket.receive({ type: "interruption", interruption_event: { event_id: 5 } });
  socket.receive({ type: "audio", audio_event: { audio_base_64: "OLD", event_id: 4 } });
  socket.receive({ type: "audio", audio_event: { audio_base_64: "NEW", event_id: 6 } });
  assert.equal(h.audio.flushed, 1);
  assert.deepEqual(h.audio.played, ["FFFF", "NEW"]);

  socket.receive({ type: "ping", ping_event: { event_id: 7, ping_ms: 0 } });
  await tick(5);
  assert.deepEqual(socket.sent[socket.sent.length - 1], { type: "pong", event_id: 7 });

  socket.receive({ type: "client_tool_call", client_tool_call: { tool_name: "ask_bot", tool_call_id: "tc1", parameters: { message: "Check mail" } } });
  await tick(20);
  assert.deepEqual(socket.sent[socket.sent.length - 1], { type: "client_tool_result", tool_call_id: "tc1", result: "The bot says hi.", is_error: false });
  assert.deepEqual(h.calls, [{ name: "ask_bot", args: { message: "Check mail" } }]);
  transport.end();
});

test("ElevenLabs: a μ-law agent is refused in one sentence; no formats in time uses the session's", async () => {
  assert.equal(pcmRate("pcm_16000"), 16000);
  assert.equal(pcmRate("ulaw_8000"), null);
  const h = harness();
  const refused = new ElevenLabsTransport({ url: "wss://x", init: {}, input: { sampleRate: 16000 }, output: { sampleRate: 16000 } }, h.audio, h.connect, h.tools, 1000);
  const first = refused.start();
  h.sockets[0]!.open();
  h.sockets[0]!.receive({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { agent_output_audio_format: "ulaw_8000", user_input_audio_format: "pcm_16000" } });
  await assert.rejects(first, /sound format isn't supported/);

  const quiet = new ElevenLabsTransport({ url: "wss://y", init: {}, input: { sampleRate: 16000 }, output: { sampleRate: 22050 } }, h.audio, h.connect, h.tools, 10);
  const second = quiet.start();
  h.sockets[1]!.open();
  await second;
  assert.deepEqual(h.audio.started[h.audio.started.length - 1], { inputRate: 16000, outputRate: 22050, speaker: true });
  quiet.end();
});

test("a socket message in bytes reads as text", () => {
  assert.equal(textOf(new TextEncoder().encode('{"a":"é😀"}').buffer), '{"a":"é😀"}');
  assert.equal(textOf("plain"), "plain");
  assert.equal(textOf(42), null);
});

// ---- ask_bot

function fakeChat(start: ChatMessage[] = []) {
  let messages = [...start];
  let busy = false;
  let asking = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const sent: string[] = [];
  return {
    sent,
    access: {
      send: async (text: string) => {
        sent.push(text);
      },
      snapshot: () => ({ busy, asking, total: messages.length, after: (from: number) => messages.slice(from) }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    push(message: ChatMessage) {
      messages = [...messages, message];
      notify();
    },
    setBusy(value: boolean) {
      busy = value;
      notify();
    },
    ask() {
      asking = true;
      notify();
    },
  };
}

test("ask_bot sends the message, waits out the turn and returns the reply", async () => {
  const chat = fakeChat([{ role: "assistant", text: "Earlier reply" }]);
  const answer = askBot("  What's on my list?  ", chat.access, { settleMs: 5 });
  await tick(1);
  assert.deepEqual(chat.sent, ["What's on my list?"]);
  chat.push({ role: "user", text: "What's on my list?" });
  chat.setBusy(true);
  // The earlier reply is never mistaken for the answer.
  await tick(10);
  chat.push({ role: "assistant", text: "Three things: milk, mail, Sam." });
  await tick(10);
  chat.setBusy(false);
  assert.equal(await answer, "Three things: milk, mail, Sam.");
});

test("ask_bot tells the voice to send the person to their phone when the bot asks something", async () => {
  const chat = fakeChat();
  const answer = askBot("Delete the old files", chat.access, { settleMs: 5 });
  await tick(1);
  chat.push({ role: "user", text: "Delete the old files" });
  chat.setBusy(true);
  chat.ask();
  assert.equal(await answer, LOOK_AT_PHONE);
});

test("ask_bot gives up after its limit, and a long reply is cut with a note", async () => {
  const chat = fakeChat();
  assert.equal(await askBot("Anything", chat.access, { timeoutMs: 20, settleMs: 5 }), STILL_WORKING);
  const long = "word ".repeat(2000);
  const cut = replyText([{ role: "user", text: "q" }, { role: "assistant", text: long }]);
  assert.ok(cut.length <= MAX_REPLY);
  assert.ok(cut.endsWith(CUT_NOTE));
  // Replies after the person's last message are joined; earlier ones are left out.
  assert.equal(replyText([{ role: "assistant", text: "old" }, { role: "user", text: "q" }, { role: "assistant", text: "one" }, { role: "assistant", text: "two" }]), "one\n\ntwo");
});

// ---- Settings lines

const settings = (patch: Partial<VoiceSettings["providers"]> = {}): VoiceSettings => ({
  stt: { provider: "device" },
  tts: { provider: "device" },
  live: { provider: null },
  providers: {
    openai: { baseUrl: "https://api.openai.com/v1", hasKey: false },
    azure: { kind: "openai", hasKey: false },
    elevenlabs: { hasKey: false },
    gemini: { hasKey: false },
    custom: { hasKey: false },
    local: { available: false, models: [] },
    codex: { available: true, signedIn: false },
    ...patch,
  },
});

test("each provider says in one line what it still needs", () => {
  const base = settings();
  assert.equal(missing("stt", "device", base), null);
  assert.equal(missing("tts", "openai", base), "Needs an OpenAI key");
  assert.equal(missing("live", "codex", base), "Sign in to ChatGPT on your computer");
  assert.equal(missing("stt", "local", base), "Not available on this computer");
  assert.equal(missing("tts", "custom", base), "Needs your server's address");
  const azure = settings({ azure: { kind: "openai", hasKey: true, endpoint: "https://a.openai.azure.com", sttDeployment: "whisper" } });
  assert.equal(missing("stt", "azure", azure), null);
  assert.equal(missing("tts", "azure", azure), "Needs a speech deployment");
  const local = settings({ local: { available: true, models: [{ id: "w", name: "Whisper", kind: "stt", installed: true }] } });
  assert.equal(missing("stt", "local", local), null);
  assert.equal(missing("tts", "local", local), "Install a model on your computer");
  assert.equal(providerState("openai", settings({ openai: { baseUrl: "x", hasKey: true } })), "Key saved");
  assert.equal(providerState("codex", base), "Not signed in");
  assert.equal(providerState("local", local), "1 installed");
});
