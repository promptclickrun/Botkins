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
import { liveContext, locationFor, locationOn } from "../src/features/voice/live/context";
import { BARGE_IN, CUT_SETTLE_MS, ECHO_TAIL_MS, MicGate, MIN_TURN_MS, pcmMs, RELEASE_TAIL_MS, silenceLike } from "../src/features/voice/live/input";
import { type AudioFrame, type DuplexLike, type Line, type LiveStatus, textOf } from "../src/features/voice/live/types";
import { WebRTCTransport } from "../src/features/voice/live/webrtc";
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
  private outputs = new Set<(event: { level: number }) => void>();
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
  setSpeaker() {}
  async stop() {
    this.stopped += 1;
  }
  addListener(name: string, listener: (value: never) => void) {
    const set = (name === "frame" ? this.frames : name === "output" ? this.outputs : null) as Set<(value: never) => void> | null;
    set?.add(listener);
    return { remove: () => void set?.delete(listener) };
  }
  frame(data: string, level = 0.5) {
    for (const listener of this.frames) listener({ data, level });
  }
  output(level: number) {
    for (const listener of this.outputs) listener({ level });
  }
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** Base64 of `ms` of 16-bit mono PCM at `rate`. */
const sound = (ms: number, rate = 24000) => "A".repeat(Math.ceil((((rate * ms) / 1000) * 2) / 3) * 4);

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

  socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "What is" });
  assert.deepEqual(seen.lines.get("u1"), { id: "u1", who: "you", text: "What is", final: false });
  socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "What's on my list?" });
  socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: " late" });
  socket.receive({ type: "response.output_audio.delta", item_id: "b1", delta: "AAAAAAAA" });
  socket.receive({ type: "response.output_audio_transcript.delta", item_id: "b1", delta: "You have " });
  socket.receive({ type: "response.output_audio_transcript.delta", item_id: "b1", delta: "three things." });
  assert.deepEqual(h.audio.played, ["AAAAAAAA"]);
  assert.deepEqual(seen.lines.get("u1"), { id: "u1", who: "you", text: "What's on my list?", final: true });
  assert.equal(seen.lines.get("b1")!.text, "You have three things.");

  // The person talks over the bot: playing stops and the item is cut.
  socket.receive({ type: "input_audio_buffer.speech_started", item_id: "u2" });
  assert.equal(h.audio.flushed, 1);
  socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "u2", delta: "One more thing" });
  transport.end();
  assert.equal(seen.lines.get("u2")?.final, true, "hanging up keeps the last words heard");
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

  socket.receive({ serverContent: { interimInputTranscription: { text: "Hallo" } } });
  assert.equal(seen.lines.get("you-1")?.text, "Hallo");
  socket.receive({ serverContent: { inputTranscription: { text: "Hello " } } });
  socket.receive({ serverContent: { interimInputTranscription: { text: "their" } } });
  assert.equal(seen.lines.get("you-1")?.text, "Hello their");
  socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "DDDD" } }] }, outputTranscription: { text: "Hi!" } } });
  socket.receive({ serverContent: { inputTranscription: { text: "there" } } });
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

  socket.receive({ type: "tentative_user_transcript", tentative_user_transcription_event: { event_id: 1, user_transcript: "What" } });
  socket.receive({ type: "tentative_user_transcript", tentative_user_transcription_event: { event_id: 2, user_transcript: "What's knew" } });
  assert.deepEqual(seen.lines.get("you-1"), { id: "you-1", who: "you", text: "What's knew", final: false });
  socket.receive({ type: "user_transcript", user_transcription_event: { event_id: 3, user_transcript: "What's new?" } });
  socket.receive({ type: "audio", audio_event: { audio_base_64: "FFFF", event_id: 3 } });
  socket.receive({ type: "agent_chat_response_part", text_response_part: { type: "delta", response_id: "r1", text: "Not" } });
  assert.equal(seen.lines.get("bot-r1")?.text, "Not");
  socket.receive({ type: "agent_response", agent_response_event: { response_id: "r1", agent_response: "Not much" } });
  socket.receive({ type: "agent_response_correction", agent_response_correction_event: { original_agent_response: "Not much", corrected_agent_response: "Not much at" } });
  assert.deepEqual(h.audio.played, ["FFFF"]);
  assert.equal(seen.lines.get("you-1")!.text, "What's new?");
  assert.equal(seen.lines.get("bot-r1")!.text, "Not much at");

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

// ---- The microphone while the bot talks, and push to talk

test("the gate: closed while the bot's queued sound plays and for its echo after, then open", () => {
  const c = clock();
  const gate = new MicGate("conversation", c.now);
  assert.ok(gate.open());
  gate.queued(500);
  gate.queued(500); // queued after the first: the sound ends 1 s from now
  assert.ok(!gate.open());
  c.advance(1000 + ECHO_TAIL_MS - 1);
  assert.ok(!gate.open(), "the echo's tail is waited out");
  assert.equal(gate.wait(), 1);
  c.advance(1);
  assert.ok(gate.open());
  assert.equal(gate.wait(), null);
  // Sound that plays longer than was counted (a level above the line) keeps it closed.
  gate.level(0.3);
  assert.ok(!gate.open());
  // A provider that says when the sound starts and stops (WebRTC).
  gate.cut();
  gate.playing(true);
  c.advance(60_000);
  assert.ok(!gate.open());
  assert.equal(gate.wait(), null);
  gate.playing(false);
  assert.equal(gate.wait(), ECHO_TAIL_MS);
  gate.cut();
  assert.ok(gate.open(), "a cut leaves no echo to wait for");
  // The sound module's last buffer after a cut is not new sound.
  gate.level(0.5);
  assert.ok(gate.open());
  c.advance(CUT_SETTLE_MS);
  gate.level(0.5);
  assert.ok(!gate.open());
});

test("the gate: only talk clearly louder than the echo, for long enough, barges in", () => {
  const c = clock();
  const gate = new MicGate("conversation", c.now);
  gate.queued(10_000);
  // The echo the canceller left: never sent, never an interruption.
  for (let i = 0; i < 20; i++) assert.deepEqual(gate.frame("echo", 0.12), { send: [], barge: false });
  // Louder than the floor but not three times the echo: still nothing.
  for (let i = 0; i < 10; i++) assert.deepEqual(gate.frame("loudish", 0.3), { send: [], barge: false });
  // A short loud noise is not a barge-in.
  for (let i = 0; i < BARGE_IN.frames - 1; i++) gate.frame("bang", 0.9);
  assert.deepEqual(gate.frame("echo", 0.1), { send: [], barge: false });
  // Talk: the pieces that made the barge-in are all sent, in order.
  const said = Array.from({ length: BARGE_IN.frames }, (_, i) => "me" + i);
  const decisions = said.map((piece) => gate.frame(piece, 0.8));
  assert.ok(decisions.slice(0, -1).every((decision) => !decision.barge && !decision.send.length));
  assert.deepEqual(decisions.at(-1), { send: said, barge: true });
});

test("the gate: push to talk sends only while held and a moment after, or silence for a provider that needs it", () => {
  const c = clock();
  const gate = new MicGate("push", c.now);
  assert.deepEqual(gate.frame("idle", 0.9), { send: [], barge: false });
  gate.press();
  assert.ok(gate.holding);
  assert.deepEqual(gate.frame("talk", 0.1), { send: ["talk"], barge: false });
  c.advance(800);
  assert.equal(gate.release(), 800);
  assert.equal(gate.release(), 0, "a second release is nothing");
  assert.deepEqual(gate.frame("end", 0.1).send, ["end"], "the last word isn't cut");
  assert.equal(gate.wait(), RELEASE_TAIL_MS);
  c.advance(RELEASE_TAIL_MS);
  assert.deepEqual(gate.frame("after", 0.9).send, []);
  // The bot's sound changes nothing in push to talk.
  gate.queued(5000);
  gate.press();
  assert.deepEqual(gate.frame("over", 0.1).send, ["over"]);

  const quiet = new MicGate("push", c.now, "silence");
  assert.deepEqual(quiet.frame("EEEE", 0.9).send, ["AAAA"]);
  assert.equal(silenceLike("QUJD+w=="), "AAAAAA==");
  assert.equal(pcmMs(sound(1000), 24000), 1000);
  assert.equal(pcmMs("", 24000), 0);
});

test("OpenAI socket: the bot's own sound never reaches OpenAI, so it can't cut itself off", async () => {
  const h = harness();
  const c = clock();
  const transport = new OpenAISocketTransport({ url: "wss://x", token: "ek_1", session: { type: "session.update", session: {} } }, h.audio, h.connect, h.tools, c.now);
  const started = transport.start();
  const socket = h.sockets[0]!;
  socket.open();
  await started;
  socket.receive({ type: "response.created", response: { id: "r1" } });
  socket.receive({ type: "response.output_audio.delta", item_id: "b1", delta: sound(500) });
  const before = socket.sent.length;
  // What the canceller left of the bot's voice, while it plays and just after.
  h.audio.frame("ECHO", 0.1);
  c.advance(400);
  h.audio.output(0.4);
  h.audio.frame("ECHO", 0.1);
  // The sound ends at 500 ms; its echo's tail runs on after it.
  c.advance(100 + ECHO_TAIL_MS - 10);
  h.audio.frame("ECHO", 0.1);
  assert.equal(socket.sent.length, before, "no echo is sent");
  assert.equal(h.audio.flushed, 0);
  c.advance(10);
  h.audio.frame("MINE", 0.1);
  assert.deepEqual(socket.sent.at(-1), { type: "input_audio_buffer.append", audio: "MINE" });
  transport.end();
});

test("OpenAI socket: talking over the bot, or a tap, stops it at once", async () => {
  const h = harness();
  const c = clock();
  const transport = new OpenAISocketTransport({ url: "wss://x", token: "ek_1", session: { type: "session.update", session: {} } }, h.audio, h.connect, h.tools, c.now);
  const started = transport.start();
  const socket = h.sockets[0]!;
  socket.open();
  await started;
  socket.receive({ type: "response.created", response: { id: "r1" } });
  socket.receive({ type: "response.output_audio.delta", item_id: "b1", delta: sound(3000) });
  c.advance(1000);
  for (let i = 0; i < 5; i++) h.audio.frame("ECHO", 0.05);
  const before = socket.sent.length;
  for (let i = 0; i < BARGE_IN.frames; i++) h.audio.frame("ME" + i, 0.7);
  assert.equal(h.audio.flushed, 1);
  const after = socket.sent.slice(before);
  assert.deepEqual(after[0], { type: "response.cancel" });
  assert.deepEqual(after[1], { type: "conversation.item.truncate", item_id: "b1", content_index: 0, audio_end_ms: 1000 });
  assert.deepEqual(
    after.slice(2).map((event) => event.audio),
    Array.from({ length: BARGE_IN.frames }, (_, i) => "ME" + i),
  );
  // From then on the person is heard.
  h.audio.frame("MORE", 0.1);
  assert.deepEqual(socket.sent.at(-1), { type: "input_audio_buffer.append", audio: "MORE" });

  // A tap: the bot's next answer stops; a response that already finished is not cancelled.
  socket.receive({ type: "response.done", response: { status: "cancelled" } });
  socket.receive({ type: "response.created", response: { id: "r2" } });
  socket.receive({ type: "response.output_audio.delta", item_id: "b2", delta: sound(2000) });
  socket.receive({ type: "response.done", response: { status: "completed", output: [] } });
  const mark = socket.sent.length;
  transport.interrupt();
  assert.equal(h.audio.flushed, 2);
  assert.ok(!socket.types().slice(mark).includes("response.cancel"), "nothing to cancel");
  assert.deepEqual(socket.types().slice(mark), ["conversation.item.truncate"]);
  assert.equal(transport.status, "listening");
  transport.end();
});

test("OpenAI socket: push to talk turns OpenAI's turn detection off and sends the turn on release", async () => {
  const h = harness();
  const c = clock();
  const event = { type: "session.update", session: { type: "realtime", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "semantic_vad" } } } } };
  const transport = new OpenAISocketTransport({ url: "wss://x", token: "ek_1", session: event }, h.audio, h.connect, h.tools, c.now);
  transport.setInput("push");
  assert.equal(transport.input, "push");
  const started = transport.start();
  const socket = h.sockets[0]!;
  socket.open();
  await started;
  const first = socket.sent[0] as { session: { audio: { input: Record<string, unknown> } } };
  assert.equal(first.session.audio.input.turn_detection, null);
  assert.deepEqual(first.session.audio.input.transcription, { model: "gpt-transcribe" });
  assert.deepEqual(first.session.audio.input.format, { type: "audio/pcm", rate: 24000 });

  h.audio.frame("IDLE", 0.9);
  assert.equal(socket.sent.length, 1, "nothing is sent until the button is held");
  transport.press();
  assert.deepEqual(socket.sent.at(-1), { type: "input_audio_buffer.clear" });
  h.audio.frame("TALK", 0.2);
  assert.deepEqual(socket.sent.at(-1), { type: "input_audio_buffer.append", audio: "TALK" });
  c.advance(900);
  transport.release();
  h.audio.frame("TAIL", 0.2);
  assert.deepEqual(socket.sent.at(-1), { type: "input_audio_buffer.append", audio: "TAIL" });
  c.advance(RELEASE_TAIL_MS);
  h.audio.frame("AFTER", 0.9);
  assert.equal(socket.sent.at(-1)!.audio, "TAIL");
  await tick(RELEASE_TAIL_MS + 30);
  assert.deepEqual(socket.types().slice(-2), ["input_audio_buffer.commit", "response.create"]);
  assert.equal(transport.status, "thinking");

  // A press too short to be a turn is dropped.
  transport.press();
  c.advance(50);
  transport.release();
  await tick(RELEASE_TAIL_MS + 30);
  assert.deepEqual(socket.types().slice(-2), ["input_audio_buffer.clear", "input_audio_buffer.clear"]);

  // Pressing while the bot talks stops it first.
  socket.receive({ type: "response.created", response: { id: "r3" } });
  socket.receive({ type: "response.output_audio.delta", item_id: "b3", delta: sound(2000) });
  const mark = socket.sent.length;
  transport.press();
  assert.equal(h.audio.flushed, 1);
  assert.deepEqual(socket.types().slice(mark), ["response.cancel", "conversation.item.truncate", "input_audio_buffer.clear"]);
  transport.end();
});

class FakeTrack {
  enabled = true;
  stop() {}
}
class FakeChannel {
  readyState = "connecting";
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  addEventListener(name: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
  open() {
    this.readyState = "open";
    for (const listener of this.listeners.get("open") ?? []) listener({ data: null });
  }
  receive(message: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(message) });
  }
  types() {
    return this.sent.map((event) => event.type);
  }
}
function fakeWebRTC() {
  const track = new FakeTrack();
  const stream = { getAudioTracks: () => [track], getTracks: () => [track], release() {} };
  const channels: FakeChannel[] = [];
  class Peer {
    connectionState = "new";
    addTrack() {}
    createDataChannel() {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    }
    addEventListener() {}
    async createOffer() {
      return { sdp: "v=0 offer", type: "offer" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  const webrtc = { RTCPeerConnection: Peer, mediaDevices: { getUserMedia: async () => stream } };
  const negotiate = async () => ({ id: "call_1", kind: "webrtc" as const, sdp: "v=0 answer" });
  return { webrtc: webrtc as never, negotiate, track, channels };
}

test("WebRTC: the microphone is off while the bot's sound plays and for its echo after", async () => {
  const h = harness();
  const rtc = fakeWebRTC();
  const transport = new WebRTCTransport(rtc.webrtc, rtc.negotiate, h.tools, async () => {});
  await transport.start();
  const channel = rtc.channels[0]!;
  channel.open();
  assert.ok(rtc.track.enabled);
  channel.receive({ type: "response.created", response: { id: "r1" } });
  assert.ok(rtc.track.enabled, "the person may still finish their sentence");
  channel.receive({ type: "output_audio_buffer.started", response_id: "r1" });
  assert.ok(!rtc.track.enabled, "the bot's sound plays: nothing of it goes back");
  channel.receive({ type: "output_audio_buffer.stopped", response_id: "r1" });
  assert.ok(!rtc.track.enabled);
  await tick(ECHO_TAIL_MS + 50);
  assert.ok(rtc.track.enabled);

  // A tap stops the bot's sound and its response at once, and the microphone opens.
  channel.receive({ type: "output_audio_buffer.started", response_id: "r2" });
  transport.interrupt();
  assert.deepEqual(channel.types().slice(-2), ["response.cancel", "output_audio_buffer.clear"]);
  assert.ok(rtc.track.enabled);
  // Mute still wins.
  transport.mute(true);
  assert.ok(!rtc.track.enabled);
  transport.end();
});

test("WebRTC: push to talk turns turn detection off, and the track is on only while held", async () => {
  const h = harness();
  const rtc = fakeWebRTC();
  const transport = new WebRTCTransport(rtc.webrtc, rtc.negotiate, h.tools, async () => {});
  transport.setInput("push");
  await transport.start();
  assert.ok(!rtc.track.enabled, "nothing is sent until the button is held");
  const channel = rtc.channels[0]!;
  channel.open();
  const update = channel.sent[0] as { type: string; session: { audio: { input: Record<string, unknown> } } };
  assert.equal(update.type, "session.update");
  assert.equal(update.session.audio.input.turn_detection, null);
  assert.deepEqual(update.session.audio.input.transcription, { model: "gpt-transcribe" });
  channel.receive({ type: "session.updated", session: { audio: { input: { turn_detection: null } } } });

  transport.press();
  assert.ok(rtc.track.enabled);
  assert.deepEqual(channel.types().at(-1), "input_audio_buffer.clear");
  await tick(MIN_TURN_MS + 20);
  transport.release();
  assert.ok(rtc.track.enabled, "the last word isn't cut");
  await tick(RELEASE_TAIL_MS + 40);
  assert.ok(!rtc.track.enabled);
  assert.deepEqual(channel.types().slice(-2), ["input_audio_buffer.commit", "response.create"]);

  // Pressing while the bot talks stops it first.
  channel.receive({ type: "response.created", response: { id: "r2" } });
  channel.receive({ type: "output_audio_buffer.started", response_id: "r2" });
  const mark = channel.sent.length;
  transport.press();
  assert.deepEqual(channel.types().slice(mark), ["response.cancel", "output_audio_buffer.clear", "input_audio_buffer.clear"]);
  transport.release();
  transport.end();
});

test("WebRTC: where turn detection stayed on, a release sends only silence and the provider takes its turn", async () => {
  const h = harness();
  const rtc = fakeWebRTC();
  const transport = new WebRTCTransport(rtc.webrtc, rtc.negotiate, h.tools, async () => {});
  transport.setInput("push");
  await transport.start();
  const channel = rtc.channels[0]!;
  channel.open();
  channel.receive({ type: "session.updated", session: { audio: { input: { turn_detection: { type: "semantic_vad" } } } } });
  transport.press();
  await tick(MIN_TURN_MS + 20);
  transport.release();
  await tick(RELEASE_TAIL_MS + 40);
  assert.ok(!rtc.track.enabled);
  assert.ok(!channel.types().includes("input_audio_buffer.commit"), "no second answer on top of the provider's own");
  transport.end();
});

test("Gemini: its own sound never reaches it; push to talk marks the person's turn by hand", async () => {
  const h = harness();
  const c = clock();
  const session = { url: "wss://x", setup: { setup: { model: "models/gemini-3.8-live" } }, input: { sampleRate: 16000 }, output: { sampleRate: 24000 } };
  const talk = new GeminiTransport(session, h.audio, h.connect, h.tools, c.now);
  let started = talk.start();
  let socket = h.sockets[0]!;
  socket.open();
  assert.deepEqual(socket.sent[0], session.setup, "hands-free keeps Gemini's own setup");
  socket.receive({ setupComplete: {} });
  await started;
  socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: sound(500) } }] } } });
  const before = socket.sent.length;
  h.audio.frame("ECHO", 0.1);
  c.advance(500 + ECHO_TAIL_MS - 10);
  h.audio.frame("ECHO", 0.1);
  assert.equal(socket.sent.length, before);
  c.advance(10);
  h.audio.frame("MINE", 0.1);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audio: { data: "MINE", mimeType: "audio/pcm;rate=16000" } } });
  talk.end();

  const push = new GeminiTransport(session, h.audio, h.connect, h.tools, c.now);
  push.setInput("push");
  started = push.start();
  socket = h.sockets[1]!;
  socket.open();
  assert.deepEqual(socket.sent[0], { setup: { model: "models/gemini-3.8-live", realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } });
  socket.receive({ setupComplete: {} });
  await started;
  h.audio.frame("IDLE", 0.9);
  assert.equal(socket.sent.length, 1);
  push.press();
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { activityStart: {} } });
  h.audio.frame("TALK", 0.2);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audio: { data: "TALK", mimeType: "audio/pcm;rate=16000" } } });
  c.advance(700);
  push.release();
  c.advance(RELEASE_TAIL_MS);
  await tick(RELEASE_TAIL_MS + 30);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { activityEnd: {} } });
  // Muting doesn't send audioStreamEnd here: Gemini takes it only with its own detection on.
  push.mute(true);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { activityEnd: {} } });
  push.mute(false);

  // Pressing while the bot talks stops it, and the rest of that turn is not played.
  const flushed = h.audio.flushed;
  const played = h.audio.played.length;
  socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: sound(300) } }] } } });
  push.press();
  assert.equal(h.audio.flushed, flushed + 1);
  socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "OLD" } }] } } });
  assert.equal(h.audio.played.length, played + 1, "the cut turn's sound is dropped");
  socket.receive({ serverContent: { interrupted: true } });
  socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "NEW" } }] } } });
  assert.equal(h.audio.played.at(-1), "NEW");
  push.release();
  push.end();
});

test("ElevenLabs: silence goes while the agent talks or the button is up, so its own turn taking still works", async () => {
  const h = harness();
  const c = clock();
  const session = { url: "wss://x", init: {}, input: { sampleRate: 16000 }, output: { sampleRate: 16000 } };
  const talk = new ElevenLabsTransport(session, h.audio, h.connect, h.tools, 10, c.now);
  let started = talk.start();
  let socket = h.sockets[0]!;
  socket.open();
  await started;
  socket.receive({ type: "audio", audio_event: { audio_base_64: sound(500, 16000), event_id: 1 } });
  h.audio.frame("EEEE", 0.1);
  assert.deepEqual(socket.sent.at(-1), { user_audio_chunk: "AAAA" }, "the agent's echo goes as silence");
  c.advance(500 + ECHO_TAIL_MS + 1);
  h.audio.frame("EEEE", 0.1);
  assert.deepEqual(socket.sent.at(-1), { user_audio_chunk: "EEEE" });
  talk.end();

  const push = new ElevenLabsTransport(session, h.audio, h.connect, h.tools, 10, c.now);
  push.setInput("push");
  started = push.start();
  socket = h.sockets[1]!;
  socket.open();
  await started;
  h.audio.frame("EEEE", 0.9);
  assert.deepEqual(socket.sent.at(-1), { user_audio_chunk: "AAAA" });
  socket.receive({ type: "audio", audio_event: { audio_base_64: sound(800, 16000), event_id: 2 } });
  push.press();
  assert.equal(h.audio.flushed, 1, "pressing stops the agent");
  assert.deepEqual(socket.sent.at(-1), { type: "user_activity" });
  h.audio.frame("EEEE", 0.2);
  assert.deepEqual(socket.sent.at(-1), { user_audio_chunk: "EEEE" });
  // The rest of the answer the person cut is dropped until ElevenLabs takes their turn.
  socket.receive({ type: "audio", audio_event: { audio_base_64: "OLD", event_id: 3 } });
  assert.ok(!h.audio.played.includes("OLD"));
  push.release();
  c.advance(RELEASE_TAIL_MS);
  h.audio.frame("EEEE", 0.2);
  assert.deepEqual(socket.sent.at(-1), { user_audio_chunk: "AAAA" });
  socket.receive({ type: "user_transcript", user_transcription_event: { user_transcript: "Stop there" } });
  socket.receive({ type: "audio", audio_event: { audio_base_64: "NEW", event_id: 4 } });
  assert.equal(h.audio.played.at(-1), "NEW");
  push.end();
});

// ---- Where the person is, for a live call

test("live voice: the location is asked for and sent only while Location is on in Device access", async () => {
  let asked = 0;
  const read = async () => (asked++, { place: "Lund, Skåne, Sweden", latitude: 55.7, longitude: 13.19 });
  assert.equal(locationOn({}), false);
  assert.equal(locationOn({ location: "off" }), false);
  assert.equal(locationOn({ calendar: "read" }), false);
  assert.equal(locationOn({ location: "read" }), true);
  assert.equal(await liveContext({}, read), undefined);
  assert.equal(await liveContext({ location: "off", calendar: "interact" }, read), undefined);
  assert.equal(await liveContext(undefined, read), undefined);
  assert.equal(asked, 0, "the phone isn't even asked");
  assert.deepEqual(await liveContext({ location: "read" }, read), { location: { place: "Lund, Skåne, Sweden", latitude: 55.7, longitude: 13.19 } });
  assert.equal(asked, 1);
});

test("live voice: a slow or failed fix never holds the call up", async () => {
  const slow = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
  const began = Date.now();
  assert.equal(await liveContext({ location: "read" }, slow as never, 30), undefined);
  assert.ok(Date.now() - began < 500);
  assert.equal(await liveContext({ location: "read" }, async () => Promise.reject(new Error("no fix"))), undefined);
  assert.equal(await liveContext({ location: "read" }, async () => null), undefined);
});

test("live voice: a fix becomes the town, region and country, about a kilometre, never a street", () => {
  assert.deepEqual(locationFor(59.325117, 18.071093, { city: "Stockholm", district: "Gamla stan", region: "Stockholm", country: "Sweden" }), { latitude: 59.33, longitude: 18.07, place: "Stockholm, Sweden" });
  assert.deepEqual(locationFor(-0.004, 0.001, null), { latitude: 0, longitude: 0 });
  assert.deepEqual(locationFor(Number.NaN, 0, { district: "Shibuya", region: "Tokyo", country: "Japan" }), { place: "Shibuya, Tokyo, Japan" });
  assert.ok(locationFor(10, 10, { city: "x".repeat(300) })!.place!.length <= 120);
  assert.equal(locationFor(Number.NaN, Number.NaN, {}), null);
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

test("ask_bot reads the reply when the spoken message already occupies its chat row", async () => {
  const chat = fakeChat([{ role: "user", text: "Check the time", voiceId: "call:u1", runId: "r" }]);
  const answer = askBot("Check the time", chat.access, { voiceId: "call:u1", timeoutMs: 70, settleMs: 1 });
  chat.push({ role: "assistant", text: "It is noon.", runId: "r" });
  chat.push({ role: "user", text: "Thanks", voiceId: "call:u2" });
  assert.equal(await answer, "It is noon.");
});

test("the voice canvas keeps typed and spoken rows in order as the computer acknowledges them", async () => {
  const { updateSpoken, voiceCanvas } = await import("../src/features/voice/live/history");
  const one: Line = { id: "a:1", who: "you", text: "Fir", final: false };
  const two: Line = { id: "a:2", who: "you", text: "Second", final: true };
  let spoken = updateSpoken([], one, 1);
  spoken = updateSpoken(spoken, two, 1);
  spoken = updateSpoken(spoken, { ...one, text: "First", final: true }, 3);
  const typed = { role: "user" as const, text: "Typed" };
  const ack = { role: "user" as const, text: "Fir", voiceId: one.id, voicePartial: true as const };
  const rows = (messages: any[]) => voiceCanvas(messages, 0, spoken).reverse().map(row => [row.key, row.message.text]);
  const expected = [["m:0", "Typed"], ["v:a:1", "First"], ["v:a:2", "Second"]];
  assert.deepEqual(rows([typed]), expected);
  assert.deepEqual(rows([typed, ack]), expected);
  assert.deepEqual(rows([typed, { ...ack, voicePartial: undefined, text: "First" }, { ...typed, voiceId: two.id, text: "Second" }]), expected);
});
