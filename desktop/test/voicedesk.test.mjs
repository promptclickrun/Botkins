// The desktop's voice desk (desktop/voicedesk.mjs) and the Codex live helper (desktop/codexvoice.mjs),
// with a stand-in Voice, a stand-in workspace and a stand-in Codex. Nothing here reaches a provider.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ASK_BOT, VoiceDesk, cutForSpeech, liveInstructions, speakable, splitSentences } from "../desktop/voicedesk.mjs";
import { CodexVoice } from "../desktop/codexvoice.mjs";
import { Voice, effectiveLive as linkLive, effectiveTts as linkTts, wavFromPcm } from "../desktop/link/voice.mjs";
import { botVoiceSummary, effectiveLive, effectiveTts, withProvider } from "../src/botVoice.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "sk-test-0123456789abcdefghijklmnop";

/** A stand-in for link.voice: records calls, holds settings, never a key in what it returns. */
function fakeVoice({ tts = "openai" } = {}) {
  const calls = [];
  const state = {
    stt: { provider: "openai" },
    tts: { provider: tts, speed: 1 },
    live: { provider: "openai" },
    providers: { openai: { baseUrl: "https://api.openai.com/v1", hasKey: false } },
  };
  const voice = {
    calls,
    // The link's public word for a voice file that can't be opened: a sentence, or null.
    locked: null,
    settings: () => structuredClone(state),
    set: (patch) => {
      calls.push(["set", patch]);
      for (const [k, v] of Object.entries(patch)) state[k] = { ...state[k], ...v };
    },
    setKey: (provider, key) => {
      calls.push(["setKey", provider, key ? "(key)" : null]);
      state.providers[provider] = { ...state.providers[provider], hasKey: key != null };
    },
    options: async (kind, provider) => ({ models: [{ id: kind + "-" + provider, name: "M" }], voices: [] }),
    transcribe: async ({ audio, format, language }) => {
      calls.push(["transcribe", audio.length, format, language]);
      return { text: " hello there " };
    },
    speak: async ({ text }) => {
      calls.push(["speak", text.length]);
      return { audio: Buffer.from([1, 2, 3]), format: "mp3" };
    },
    live: async (args) => {
      calls.push(["live", args]);
      return { id: "live-1", kind: "webrtc", sdp: "v=0 answer" };
    },
    endLive: (id) => calls.push(["endLive", id]),
  };
  return voice;
}

/** A stand-in workspace: send() runs a "turn" that adds the bot's reply. */
function fakeWorkspace({ reply = "Sure. **Done** with `code`.", messages = [], liveContext, voice } = {}) {
  const chat = { id: "chat-1", botId: "bot-1", messages };
  const ws = {
    sent: [],
    active: new Map(),
    state: { bots: [{ id: "bot-1", name: "Pip", role: "Keeps the garden notes.", ...(voice && { voice }) }, { id: "bot-2", name: "Nova", role: "Edits." }], chats: [chat] },
    chat: (id) => {
      if (id !== chat.id) throw new Error("Unknown chat");
      return chat;
    },
    async send(chatId, text) {
      if (ws.active.has(chatId)) throw new Error("Chat unavailable or already working");
      ws.sent.push(text);
      chat.messages.push({ role: "user", text });
      chat.messages.push({ role: "assistant", text: typeof reply === "function" ? reply(text) : reply });
    },
  };
  if (liveContext) ws.liveContext = liveContext;
  return ws;
}

test("settings say what this computer does itself and never hold a key", async () => {
  const voice = fakeVoice();
  const mac = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace, platform: "darwin", dictate: () => {} });
  const s = await mac.settings();
  assert.equal(s.ready, true);
  assert.deepEqual(s.device, { stt: true, tts: true });
  const win = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace, platform: "win32", dictate: () => {} });
  assert.equal((await win.settings()).device.stt, false);
  const after = await mac.setKey("openai", "  " + SECRET + "  ");
  assert.equal(after.providers.openai.hasKey, true);
  assert.ok(!JSON.stringify(after).includes(SECRET));
  assert.deepEqual(voice.calls.at(-1), ["setKey", "openai", "(key)"]);
  await assert.rejects(mac.setKey("openai", "   "), /Paste the key/);
  assert.equal((await mac.setKey("openai", null)).providers.openai.hasKey, false);
});

test("before the link is made the settings still draw, and changes say it isn't ready", async () => {
  const desk = new VoiceDesk({ voice: () => null, workspace: fakeWorkspace, platform: "linux" });
  const s = await desk.settings();
  assert.equal(s.ready, false);
  assert.equal(s.stt.provider, "device");
  await assert.rejects(desk.set({ stt: { provider: "openai" } }), /isn't ready/);
});

test("a locked voice file is reported, not hidden", async () => {
  const voice = fakeVoice();
  voice.locked = "The saved voice keys can't be opened on this computer.";
  const s = await new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace }).settings();
  assert.equal(s.ready, false);
  assert.match(s.problem, /can't be opened/);
});

test("transcribe takes the page's bytes, checks them, and trims the text", async () => {
  const voice = fakeVoice();
  const desk = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace });
  assert.deepEqual(await desk.transcribe(new Uint8Array([1, 2, 3, 4]), "webm", "en-US"), { text: "hello there" });
  assert.deepEqual(voice.calls.at(-1), ["transcribe", 4, "webm", "en-US"]);
  await assert.rejects(desk.transcribe(new Uint8Array(), "webm"), /nothing to hear/);
  await assert.rejects(desk.transcribe(new Uint8Array([1]), "ogg"), /format/);
  await assert.rejects(desk.transcribe("not bytes", "wav"), /nothing to hear/);
  const big = new Uint8Array(new ArrayBuffer(25 * 1024 * 1024 + 1));
  await assert.rejects(desk.transcribe(big, "wav"), /over 25 MB/);
});

test("through the real Voice module: a silent or tap-short WAV is never sent to a provider, and live voice gets the language hint", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-voicedesk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    // A speech model's answer to silence: a made-up word in another language.
    return Response.json(String(url).endsWith("/audio/transcriptions") ? { text: "Qué" } : {});
  };
  const voice = new Voice({ dir, fetch });
  voice.setKey("openai", SECRET);
  voice.set({ stt: { provider: "openai", language: "en-US" } });
  const wav = (ms, loud) => {
    const pcm = Buffer.alloc(16 * ms * 2);
    if (loud) for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(loud * Math.sin(i / 3)), i * 2);
    return wavFromPcm(pcm, 16000);
  };
  const desk = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace });
  assert.deepEqual(await desk.transcribe(wav(1000, 0), "wav"), { text: "" });
  assert.deepEqual(await desk.transcribe(wav(100, 8000), "wav"), { text: "" });
  assert.deepEqual(asked, []);
  assert.deepEqual(await desk.transcribe(wav(1000, 8000), "wav"), { text: "Qué" });
  assert.equal(asked.length, 1);
  const { audio } = voice.openaiSession({ model: "gpt-realtime-2.1", voice: "marin", tools: [] }, false);
  assert.deepEqual(audio.input.transcription, { model: "gpt-transcribe", language: "en" });
});

test("speak: This computer speaks in the page; a provider's audio comes in parts at sentence ends", async () => {
  const device = new VoiceDesk({ voice: () => fakeVoice({ tts: "device" }), workspace: fakeWorkspace });
  assert.deepEqual(await device.speak("Hello."), { device: true });
  const voice = fakeVoice();
  const desk = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace });
  const sentence = "This is one sentence that is fairly long. ";
  const text = sentence.repeat(200); // about 8,400 characters
  const { parts } = await desk.speak(text);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.audio instanceof Uint8Array);
    assert.equal(p.format, "mp3");
  }
  const spoken = voice.calls.filter((c) => c[0] === "speak").map((c) => c[1]);
  assert.ok(spoken.every((n) => n <= 4000));
  await assert.rejects(desk.speak("   "), /nothing to read/);
});

test("a bot's own voice goes over the shared one for reading aloud and live voice, for that bot only", async () => {
  const bots = { tts: { provider: "gemini", voice: "Puck" }, live: { provider: "gemini", voice: "Puck" } };
  const workspace = () => fakeWorkspace({ voice: bots });
  const sent = [];
  const voice = fakeVoice();
  voice.speak = async (args) => (sent.push(args), { audio: Buffer.from([1]), format: "mp3" });
  const desk = new VoiceDesk({ voice: () => voice, workspace });
  await desk.speak("Hello.", { botId: "bot-1" });
  assert.deepEqual(sent.at(-1).override, bots.tts);
  await desk.speak("Hello.", { botId: "bot-2" });
  assert.equal(sent.at(-1).override, undefined, "a bot with no voice of its own reads in the shared one");
  await desk.speak("Hello.");
  assert.equal(sent.at(-1).override, undefined);
  // "This computer" for one bot is read by the window, even when the shared reading is a provider's.
  const quiet = new VoiceDesk({ voice: () => voice, workspace: () => fakeWorkspace({ voice: { tts: { provider: "device" } } }) });
  assert.deepEqual(await quiet.speak("Hello.", { botId: "bot-1" }), { device: true });
  assert.equal((await quiet.speak("Hello.", { botId: "bot-2" })).parts.length, 1);
  // And the other way: the shared choice is "This computer", the bot's own is a provider.
  const shared = new VoiceDesk({ voice: () => fakeVoice({ tts: "device" }), workspace });
  assert.deepEqual(await shared.speak("Hello.", { botId: "bot-2" }), { device: true });
  assert.ok((await shared.speak("Hello.", { botId: "bot-1" })).parts);
  // Live voice: the bot's own live voice reaches the session.
  await desk.startLive("chat-1", { sdp: "v=0 offer" });
  assert.deepEqual(voice.calls.find((c) => c[0] === "live")[1].override, bots.live);
});

test("speakable drops Markdown marks, code blocks and link addresses", () => {
  const out = speakable("# Title\n\n- **Bold** item with [a page](https://example.com/x) and `x()`\n\n```js\nlet a = 1;\n```\nSee https://example.com/long");
  assert.ok(!/[#*`]/.test(out));
  assert.ok(!out.includes("example.com"));
  assert.match(out, /a page/);
  assert.match(out, /The code is in the chat/);
});

test("splitSentences and cutForSpeech cut at sentence ends", () => {
  const parts = splitSentences("One. Two two. Three three three.", 15);
  assert.deepEqual(parts, ["One. Two two.", "Three three", "three."]);
  for (const p of splitSentences("word ".repeat(3000), 4000)) assert.ok(p.length <= 4000);
  assert.equal(cutForSpeech("Short."), "Short.");
  const cut = cutForSpeech("A sentence here. ".repeat(300), 2000);
  assert.ok(cut.length <= 2000);
  assert.match(cut, /here\. The rest is in the chat\.$/);
});

const ACK_FIRST = /first say one short sentence out loud that you're on it and who or what you're asking.*and only then call the tool\. Never call a tool silently\./;

test("startLive gives the voice the bot's name and role and the one ask_bot tool", async () => {
  const voice = fakeVoice();
  const desk = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace });
  const session = await desk.startLive("chat-1", { sdp: "v=0 offer" });
  assert.equal(session.id, "live-1");
  assert.deepEqual(session.tools, [ASK_BOT]);
  const [, args] = voice.calls.find((c) => c[0] === "live");
  assert.equal(args.sdp, "v=0 offer");
  assert.deepEqual(args.tools, [ASK_BOT]);
  assert.match(args.instructions, /voice of Pip/);
  assert.match(args.instructions, /garden notes/);
  assert.match(args.instructions, /ask_bot/);
  assert.match(ASK_BOT.description, /new work/);
  assert.match(ASK_BOT.description, /Not for what the conversation or your notes already answer/);
  // Acknowledge first, then call the tool: in the instructions every provider gets, and in the tool's own description.
  assert.match(args.instructions, ACK_FIRST);
  assert.match(ASK_BOT.description, /Always speak first: say one short sentence out loud that you're on it and who you're asking, and only then call this tool\. Never call it silently\./);
  assert.deepEqual(args.about, { chatId: "chat-1", botId: "bot-1", botName: "Pip" }, "whom the voice speaks for, for a helper that needs to know");
  assert.equal(desk.isOwn("live-1"), true, "a session this window started");
  assert.deepEqual(ASK_BOT.parameters.required, ["request"]);
  await assert.rejects(desk.startLive("nope"), /Unknown chat/);
  desk.endLive("live-1");
  assert.deepEqual(voice.calls.at(-1), ["endLive", "live-1"]);
  await assert.rejects(desk.liveTool("live-1", "ask_bot", { request: "hi" }), /ended/);
});

test("local live voice carries bounded context and actual chat, not secret receipts or work records", async () => {
  const ws = fakeWorkspace({
    messages: [
      { role: "user", text: "What did we decide about basil?" },
      { role: "assistant", text: "Basil goes in the sunny bed." },
      { role: "assistant", text: "interim tool narration", interim: true },
      { role: "command", text: "secret command output" },
      { role: "user", text: "Provided Password", answer: { kind: "secure", title: "Credentials", runId: "r", requestId: "q" } },
    ],
    liveContext: async () => ({ userName: "Alex Example", identity: "Pip keeps the garden notes.", user: "Alex prefers short answers." }),
  });
  const voice = fakeVoice();
  const desk = new VoiceDesk({ voice: () => voice, workspace: () => ws });
  await desk.startLive("chat-1", { sdp: "v=0 offer" });
  const [, args] = voice.calls.find((call) => call[0] === "live");
  assert.match(args.instructions, /The person's name is Alex Example\./);
  assert.match(args.instructions, /Pip keeps the garden notes/);
  assert.match(args.instructions, /Alex prefers short answers/);
  assert.match(args.instructions, /What did we decide about basil\?/);
  assert.match(args.instructions, /Basil goes in the sunny bed/);
  assert.doesNotMatch(args.instructions, /interim tool narration|secret command output|Provided Password/);
  assert.doesNotMatch(args.instructions, /near /, "the desktop did not claim location permission");
});

test("a slow local live context hook fails open after two seconds", async () => {
  const ws = fakeWorkspace({ liveContext: () => new Promise(() => {}) });
  const voice = fakeVoice();
  const desk = new VoiceDesk({ voice: () => voice, workspace: () => ws });
  const started = Date.now();
  await desk.startLive("chat-1");
  assert.ok(Date.now() - started >= 1900 && Date.now() - started < 2600);
  const [, args] = voice.calls.find((call) => call[0] === "live");
  assert.doesNotMatch(args.instructions, /The person's name|identity:|About Alex/);
});

test("liveTool runs ask_bot as a normal turn and answers with the reply, ready to speak", async () => {
  const ws = fakeWorkspace({ reply: (t) => "You said " + t + ". **Done** with `code`. " + "More words follow here. ".repeat(200) });
  const desk = new VoiceDesk({ voice: fakeVoice, workspace: () => ws });
  const { id } = await desk.startLive("chat-1");
  const answer = await desk.liveTool(id, "ask_bot", { request: "  water the roses  " });
  assert.deepEqual(ws.sent, ["water the roses"]);
  assert.match(answer, /^You said water the roses\. Done with code\./);
  assert.ok(answer.length <= 2000);
  assert.match(answer, /The rest is in the chat\.$/);
  assert.equal(await desk.liveTool(id, "ask_bot", { request: " " }), "The request was empty.");
  await assert.rejects(desk.liveTool(id, "rm_rf", {}), /tool it doesn't have/);
});

test("liveTool waits for a turn already running in the chat", async () => {
  const ws = fakeWorkspace({ reply: "Later answer." });
  let finish;
  ws.active.set("chat-1", { done: new Promise((resolve) => (finish = resolve)) });
  const desk = new VoiceDesk({ voice: fakeVoice, workspace: () => ws });
  const { id } = await desk.startLive("chat-1");
  const pending = desk.liveTool(id, "ask_bot", { request: "next" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ws.sent, []);
  ws.active.delete("chat-1");
  finish();
  assert.equal(await pending, "Later answer.");
});

test("a tool call that arrives just before startLive returns waits for the session", async () => {
  const ws = fakeWorkspace({ reply: "Hi." });
  const voice = fakeVoice();
  let release;
  voice.live = () => new Promise((resolve) => (release = () => resolve({ id: "codex-x", kind: "webrtc", sdp: "v=0" })));
  const desk = new VoiceDesk({ voice: () => voice, workspace: () => ws });
  const starting = desk.startLive("chat-1", { sdp: "v=0" });
  const early = desk.liveTool("codex-x", "ask_bot", { request: "hello" });
  release();
  await starting;
  assert.equal(await early, "Hi.");
});

test("dictation starts only where this computer has its own", () => {
  let started = 0;
  const mac = new VoiceDesk({ voice: fakeVoice, workspace: fakeWorkspace, platform: "darwin", dictate: () => started++ });
  assert.deepEqual(mac.startDictation(), { started: true, platform: "darwin" });
  assert.equal(started, 1);
  const linux = new VoiceDesk({ voice: fakeVoice, workspace: fakeWorkspace, platform: "linux", dictate: () => started++ });
  assert.deepEqual(linux.startDictation(), { started: false, platform: "linux" });
  assert.equal(started, 1);
});

test("the instructions keep to the bot", () => {
  const text = liveInstructions({ name: "Wren", role: "Writes", instructions: "x".repeat(5000) });
  assert.ok(text.includes("x".repeat(5000)));
  assert.ok(liveInstructions({ name: "Wren" }).length < 1500);
  const layered = liveInstructions({ name: "Wren", instructions: "Speak in Spanish." }, "IDENTITY.md\nSpeak in English.");
  assert.ok(layered.indexOf("Speak in Spanish.") > layered.indexOf("Speak in English."));
  assert.match(liveInstructions({ instructions: "x".repeat(25000) }), /including small talk, call ask_bot/);
  assert.match(text, ACK_FIRST);
  assert.match(liveInstructions({ instructions: "x".repeat(25000) }), ACK_FIRST, "also when the long instructions are left out");
  assert.match(text, /Never make up/);
});

/** A stand-in Codex app-server: answers the calls the helper makes and sends the realtime events back. */
function fakeCodex({ failStart = false } = {}) {
  const peer = new EventEmitter();
  const seen = [];
  let notify, answerRequest;
  peer.exited = new Promise((resolve) => (peer.exit = resolve));
  Object.assign(peer, {
    seen,
    onNotification: (fn) => (notify = fn),
    onRequest: (fn) => (answerRequest = fn),
    notify: (method) => seen.push([method]),
    async request(method, params) {
      seen.push([method, params]);
      if (method === "initialize") return { userAgent: "codex/1.0.0" };
      if (method === "config/read") return { config: { mcp_servers: { notes: {}, mail: {} } } };
      if (method === "thread/start") return { thread: { id: "thread-9" } };
      if (method === "thread/realtime/listVoices") return { voices: { v1: ["alloy"], v2: ["marin"], v3: ["juniper", "maple"], defaultV1: "alloy", defaultV2: "marin" } };
      if (method === "thread/realtime/start") {
        if (failStart) throw new Error("realtime is off");
        setTimeout(() => {
          notify("thread/realtime/transcript/delta", { threadId: "other", role: "user", delta: "not ours" });
          notify("thread/realtime/sdp", { threadId: "thread-9", sdp: "v=0 codex answer" });
        }, 5);
        return {};
      }
      return {};
    },
    close: async () => peer.exit(),
    send: (method, params) => notify(method, params),
    ask: (method, params) => answerRequest(method, params),
  });
  return peer;
}

test("Codex live: an ephemeral thread with Botkins' tool only, realtime over WebRTC, tool calls answered, ended cleanly", async () => {
  const peer = fakeCodex();
  const events = [];
  const asked = [];
  const codex = new CodexVoice({
    provider: { status: async () => ({ installed: true, connected: true }) },
    spawn: async () => peer,
    botName: () => "Pip",
    onTool: async (id, name, args) => {
      asked.push([id, name, args]);
      return "It is sunny.";
    },
    onEvent: (id, event) => events.push(event),
  });
  assert.equal(codex.signedIn(), false);
  assert.equal(await codex.refresh(), true);
  assert.equal(codex.signedIn(), true);
  const { sdp, id } = await codex.live({ sdp: "v=0 offer", voice: "juniper", instructions: liveInstructions({ name: "Pip", role: "Writes", instructions: "Be Pip." }), tools: [ASK_BOT] });
  assert.equal(sdp, "v=0 codex answer");
  assert.match(id, /^codex-/);
  const init = peer.seen.find((c) => c[0] === "initialize")[1];
  assert.equal(init.capabilities.experimentalApi, true);
  const thread = peer.seen.find((c) => c[0] === "thread/start")[1];
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.match(thread.baseInstructions, /Be Pip\./);
  assert.deepEqual(thread.config.mcp_servers, { notes: { enabled: false }, mail: { enabled: false } });
  assert.equal(thread.config.features.shell_tool, false);
  assert.deepEqual(thread.dynamicTools[0].tools.map((t) => t.name), ["ask_bot"]);
  assert.deepEqual(thread.dynamicTools[0].tools[0].inputSchema, ASK_BOT.parameters);
  assert.match(thread.dynamicTools[0].tools[0].description, /Always speak first/, "Codex's voice is told to speak first too");
  const start = peer.seen.find((c) => c[0] === "thread/realtime/start")[1];
  assert.equal(start.threadId, "thread-9");
  assert.equal(start.outputModality, "audio");
  assert.deepEqual(start.transport, { type: "webrtc", sdp: "v=0 offer" });
  assert.equal(start.version, "v3");
  assert.equal(start.includeStartupContext, false);
  assert.equal(start.delegationAckFiller, true);
  assert.equal(start.voice, "juniper");
  assert.match(start.realtimeStartInstructions, /Pip/);
  assert.match(start.realtimeStartInstructions, /botkins\.ask_bot/);
  assert.equal(start.initialItems.length, 1);
  assert.equal(start.initialItems[0].role, "developer");
  assert.match(start.initialItems[0].text, /voice of my bot "Pip"/);
  assert.match(start.initialItems[0].text, /Be Pip\./);
  assert.ok(!/\bask_bot\b|Never call a tool silently/i.test(start.initialItems[0].text), "v3 voice initialItems omits direct-tool ask_bot instructions");
  assert.equal(peer.seen.some((c) => c[0] === "thread/realtime/appendText"), false, "startup uses developer initialItems instead of trailing user appendText");
  // A tool call from the voice.
  const result = await peer.ask("item/tool/call", { threadId: "thread-9", turnId: "t", callId: "c", namespace: "botkins", tool: "ask_bot", arguments: { request: "weather?" } });
  assert.deepEqual(result, { contentItems: [{ type: "inputText", text: "It is sunny." }], success: true });
  assert.deepEqual(asked, [[id, "ask_bot", { request: "weather?" }]]);
  await assert.rejects(peer.ask("item/tool/call", { threadId: "thread-9", namespace: "codex", tool: "shell" }), /only Botkins' tools/);
  // Transcripts reach the page; another thread's don't.
  peer.send("thread/realtime/transcript/done", { threadId: "thread-9", role: "assistant", text: "Hello!" });
  assert.deepEqual(events, [{ type: "transcript", role: "assistant", text: "Hello!", final: true }]);
  codex.end(id);
  await peer.exited;
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(peer.seen.some((c) => c[0] === "thread/realtime/stop" && c[1].threadId === "thread-9"));
});

test("Codex live: a voice that realtime v3 doesn't list is left for Codex to choose", async () => {
  const peer = fakeCodex();
  const codex = new CodexVoice({ provider: { status: async () => ({ installed: true, connected: true }) }, spawn: async () => peer, onTool: async () => "" });
  const { id } = await codex.live({ sdp: "v=0 offer", voice: "marin", tools: [ASK_BOT] });
  const start = peer.seen.find((c) => c[0] === "thread/realtime/start")[1];
  assert.equal("voice" in start, false);
  codex.end(id);
  await peer.exited;
});

test("Codex live: a refused start is an error, and the process is closed", async () => {
  const peer = fakeCodex({ failStart: true });
  const codex = new CodexVoice({ provider: { status: async () => ({ installed: true, connected: true }) }, spawn: async () => peer, onTool: async () => "" });
  await assert.rejects(codex.live({ sdp: "v=0 offer", tools: [ASK_BOT] }), /realtime is off/);
  await peer.exited;
  assert.equal(codex.sessions.size, 0);
});

test("through the real Voice module: a Codex session is started and ended with the helper", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-voicedesk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const peer = fakeCodex();
  const codex = new CodexVoice({ provider: { status: async () => ({ installed: true, connected: true }) }, spawn: async () => peer, onTool: async () => "ok" });
  const voice = new Voice({ dir, adapter: () => ({ codex }), fetch: async () => assert.fail("no network") });
  t.after(() => voice.close?.());
  const desk = new VoiceDesk({ voice: () => voice, workspace: fakeWorkspace, refresh: () => codex.refresh() });
  const before = await desk.settings();
  assert.deepEqual(before.providers.codex, { available: true, signedIn: true });
  await desk.set({ live: { provider: "codex" } });
  const session = await desk.startLive("chat-1", { sdp: "v=0 offer" });
  assert.equal(session.kind, "webrtc");
  assert.equal(session.sdp, "v=0 codex answer");
  desk.endLive(session.id);
  await peer.exited;
  // Saved settings hold no key, and the page's copy never does.
  await desk.setKey("openai", SECRET);
  assert.ok(!JSON.stringify(await desk.settings()).includes(SECRET));
});

test("a session the link started for a phone finds its chat, and is not taken for this window's own", async () => {
  const ws = fakeWorkspace({ reply: "It rained on Tuesday." });
  const desk = new VoiceDesk({ voice: () => fakeVoice(), workspace: () => ws });
  assert.equal(desk.noteSession("codex-phone", { chatId: "chat-1", botId: "bot-1" }), true);
  assert.equal(desk.isOwn("codex-phone"), false);
  assert.equal(await desk.liveTool("codex-phone", "ask_bot", { message: "When did it rain?" }), "It rained on Tuesday.", "the link's name for the argument is taken too");
  assert.deepEqual(ws.sent, ["When did it rain?"]);
  // A chat that isn't one of this workspace's, or no chat at all, is not taken.
  assert.equal(desk.noteSession("codex-x", { chatId: "someone-else" }), false);
  assert.equal(desk.noteSession("codex-y", {}), false);
  assert.equal(desk.noteSession("", { chatId: "chat-1" }), false);
  await assert.rejects(desk.liveTool("codex-x", "ask_bot", { request: "hi" }), /ended/);
  desk.forget("codex-phone");
  await assert.rejects(desk.liveTool("codex-phone", "ask_bot", { request: "hi" }), /ended/);
});

test("sessions that never said they ended are not kept for ever", () => {
  const desk = new VoiceDesk({ voice: () => fakeVoice(), workspace: fakeWorkspace });
  for (let i = 0; i < 80; i++) desk.noteSession("codex-" + i, { chatId: "chat-1" });
  assert.equal(desk.sessions.size, 64);
  assert.ok(!desk.sessions.has("codex-0") && desk.sessions.has("codex-79"));
});

test("Codex live: the helper is told the chat and the bot's name, says so before the voice can speak, and names the bot", async () => {
  const peer = fakeCodex();
  const noted = [];
  const codex = new CodexVoice({ provider: {}, spawn: async () => peer, onTool: async () => "ok", onSession: (id, about) => noted.push([id, about, peer.seen.some(([method]) => method === "thread/realtime/start")]), botName: () => "Someone else" });
  const { id } = await codex.live({ sdp: "v=0 offer", instructions: "Be brief.", tools: [ASK_BOT], chatId: "chat-1", botId: "bot-1", botName: "Pip" });
  assert.deepEqual(noted, [[id, { chatId: "chat-1", botId: "bot-1" }, false]], "before the session is started, so a tool call always finds its chat");
  const start = peer.seen.find(([method]) => method === "thread/realtime/start")[1];
  assert.equal(start.initialItems[0].role, "developer");
  assert.match(start.initialItems[0].text, /Pip/, "the name the link passed, not the fallback");
  assert.ok(!/Someone else/.test(start.initialItems[0].text));
  assert.match(start.realtimeStartInstructions, /Pip/);
  assert.equal(peer.seen.some(([method]) => method === "thread/realtime/appendText"), false);
  codex.end(id);
  await peer.exited;
  // Without a chat (an older link) nothing is noted, and the fallback name is used.
  const older = fakeCodex();
  const quiet = [];
  const plain = new CodexVoice({ provider: {}, spawn: async () => older, onTool: async () => "ok", onSession: (...args) => quiet.push(args), botName: () => "Fallback" });
  const other = await plain.live({ sdp: "v=0 offer", tools: [ASK_BOT] });
  assert.deepEqual(quiet, []);
  const olderStart = older.seen.find(([method]) => method === "thread/realtime/start")[1];
  assert.match(olderStart.initialItems[0].text, /Fallback/);
  assert.match(olderStart.realtimeStartInstructions, /Fallback/);
  plain.end(other.id);
  await older.exited;
});

test("Codex live: its voices are asked of Codex, in a run of their own that is closed, and remembered for a while", async () => {
  let runs = 0;
  let last;
  const codex = new CodexVoice({ provider: {}, spawn: async () => (runs++, (last = fakeCodex())), onTool: async () => "ok" });
  assert.deepEqual(await codex.voices(), [{ id: "juniper", name: "Juniper" }, { id: "maple", name: "Maple" }], "the realtime voices, not the ones in Codex's published types");
  await last.exited;
  assert.deepEqual(last.seen.map(([method]) => method), ["initialize", "initialized", "thread/realtime/listVoices"]);
  assert.deepEqual(last.seen[0][1].capabilities, { experimentalApi: true });
  await codex.voices();
  assert.equal(runs, 1, "asked once, then remembered");
  // A Codex that can't be started, or doesn't know the call, has no voices to offer.
  const broken = new CodexVoice({ provider: {}, spawn: async () => { throw new Error("not installed"); }, onTool: async () => "ok" });
  assert.deepEqual(await broken.voices(), []);
});

test("through the real Voice module: Codex's voices are offered for live voice, and a phone's session carries its chat", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-voicedesk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const peers = [];
  const noted = [];
  const codex = new CodexVoice({ provider: { status: async () => ({ installed: true, connected: true }) }, spawn: async () => (peers.push(fakeCodex()), peers.at(-1)), onTool: async () => "ok", onSession: (id, about) => noted.push(about) });
  await codex.refresh();
  const voice = new Voice({ dir, adapter: () => ({ codex }), fetch: async () => assert.fail("no network") });
  t.after(() => voice.close?.());
  assert.equal(voice.locked, null, "the public word for a locked file");
  const offered = await voice.options("live", "codex");
  assert.deepEqual(offered.voices.map((v) => v.id), ["juniper", "maple"]);
  // As the link does for a phone: whom the session is for travels in `about`.
  const author = { memberId: "m_avery", name: "Avery" };
  const session = await voice.live({ provider: "codex", sdp: "v=0 offer", instructions: "Be brief.", tools: [ASK_BOT], about: { chatId: "chat-1", botId: "bot-1", botName: "Pip", author } });
  assert.deepEqual(noted, [{ chatId: "chat-1", botId: "bot-1", author }]);
  assert.match(peers.at(-1).seen.find(([method]) => method === "thread/realtime/start")[1].initialItems[0].text, /Pip/);
  voice.endLive(session.id);
  await peers.at(-1).exited;
});

// ---- A request to the bot that outlasts its tool call: the bot stops for the person, or works for long ----

/** A workspace whose turn can be held open, with the events and waiting requests the real one has. */
function slowWorkspace() {
  const chat = { id: "chat-1", botId: "bot-1", messages: [] };
  const waiting = [];
  const turns = [];
  const ws = {
    sent: [],
    active: new Map(),
    events: new EventEmitter(),
    interactions: { snapshot: () => [...waiting] },
    state: { bots: [{ id: "bot-1", name: "Pip", role: "Keeps the garden notes." }], chats: [chat], runs: [] },
    chat: (id) => {
      if (id !== chat.id) throw new Error("Unknown chat");
      return chat;
    },
    send(chatId, text) {
      if (ws.active.has(chatId)) throw new Error("Chat unavailable or already working");
      ws.sent.push(text);
      const run = { id: "run-" + ws.sent.length, chatId, status: "Working", detail: "" };
      ws.state.runs.unshift(run);
      chat.messages.push({ role: "user", text, runId: run.id });
      let finish;
      const done = new Promise((resolve) => (finish = resolve));
      ws.active.set(chatId, { done });
      turns.push({
        /** The bot stops and asks the person. */
        ask(request) {
          const view = { id: "req-" + (waiting.length + 1), chatId, botId: "bot-1", ...request };
          waiting.push(view);
          ws.events.emit("request", view);
        },
        /** The turn ends, with a reply or with a failure noted on the run. */
        end({ reply, detail } = {}) {
          waiting.length = 0;
          if (reply) chat.messages.push({ role: "assistant", text: reply, runId: run.id });
          Object.assign(run, detail ? { status: "Needs you", detail } : { status: "Completed" });
          ws.active.delete(chatId);
          finish();
        },
      });
      return done;
    },
  };
  return { ws, turns, waiting };
}
const tick2 = () => new Promise((resolve) => setTimeout(resolve, 15));
function handoff(options = {}) {
  const { ws, turns, waiting } = slowWorkspace();
  const said = [];
  const desk = new VoiceDesk({ voice: () => fakeVoice(), workspace: () => ws, say: async (id, text) => (said.push([id, text]), options.told ?? true), handoffMs: options.handoffMs ?? 5000 });
  desk.noteSession("s1", { chatId: "chat-1" });
  return { ws, turns, waiting, said, desk };
}

test("when the bot stops for an approval the voice says so at once, and is told the bot's answer when the turn ends", async () => {
  const { ws, turns, said, desk } = handoff();
  const call = desk.liveTool("s1", "ask_bot", { request: "Send the notes to the team." });
  await tick2();
  turns[0].ask({ kind: "permission", title: "Send an email to **the team**" });
  const answer = await call;
  assert.match(answer, /^Pip needs your approval before it can go on: Send an email to the team/, "what the bot is asking, without its Markdown");
  assert.match(answer, /on screen in the chat/);
  assert.match(answer, /can't answer it for you/);
  assert.deepEqual(said, [], "nothing more until the turn ends");
  // The person answers on screen; the turn goes on and ends.
  turns[0].end({ reply: "Sent. **Three** people got it." });
  await tick2();
  assert.equal(said.length, 1);
  assert.equal(said[0][0], "s1");
  assert.match(said[0][1], /Pip has now answered.*Tell the person this, as Pip: Sent\. Three people got it\./);
  assert.deepEqual(ws.sent, ["Send the notes to the team."], "one turn in the chat, not two");
  assert.equal(desk.sessions.get("s1").turn, null);
});

test("a question from the bot is said as a question, and one that is already waiting is noticed", async () => {
  const { turns, waiting, desk } = handoff();
  const call = desk.liveTool("s1", "ask_bot", { request: "Book the room." });
  await tick2();
  turns[0].ask({ kind: "question", title: "Which day?" });
  assert.match(await call, /^Pip has a question for you: Which day\? It is on screen/);
  // The voice asks again while the question still waits: no second turn, the same word.
  assert.equal(waiting.length, 1);
  assert.match(await desk.liveTool("s1", "ask_bot", { request: "Did it book?" }), /^Pip has a question for you: Which day\?/);
});

test("while a handed-over request is still under way, the voice's next call waits for it and never starts a second turn", async () => {
  const { ws, turns, said, desk } = handoff();
  const first = desk.liveTool("s1", "ask_bot", { request: "Tidy the notes." });
  await tick2();
  turns[0].ask({ kind: "permission", title: "Delete old notes" });
  await first;
  // The person approved on screen (nothing waits now) and asks the voice how it went.
  turns[0].end({ reply: "All tidy." });
  const again = await desk.liveTool("s1", "ask_bot", { request: "How did that go?" });
  await tick2();
  assert.deepEqual(ws.sent, ["Tidy the notes."]);
  // Either the voice was told as the turn ended, or this call brought the reply: never both lost.
  assert.ok(again === "All tidy." || said.some(([, text]) => text.includes("All tidy.")), again + " / " + JSON.stringify(said));
});

test("a voice that can't be told later gets the bot's answer with its next call", async () => {
  const { ws, turns, said, desk } = handoff({ told: false });
  const first = desk.liveTool("s1", "ask_bot", { request: "Tidy the notes." });
  await tick2();
  turns[0].ask({ kind: "permission", title: "Delete old notes" });
  await first;
  turns[0].end({ reply: "All tidy." });
  await tick2();
  assert.equal(said.length, 1, "it was tried");
  assert.equal(await desk.liveTool("s1", "ask_bot", { request: "Is it done?" }), "All tidy.");
  assert.deepEqual(ws.sent, ["Tidy the notes."], "the question about it started no turn");
  // After that, a new request is a new turn again.
  const next = desk.liveTool("s1", "ask_bot", { request: "And the weeds?" });
  await tick2();
  turns[1].end({ reply: "Pulled." });
  assert.equal(await next, "Pulled.");
  assert.deepEqual(ws.sent, ["Tidy the notes.", "And the weeds?"]);
});

test("a turn that takes long is not waited out in silence", async () => {
  const { turns, said, desk } = handoff({ handoffMs: 60 });
  const call = desk.liveTool("s1", "ask_bot", { request: "Read every note." });
  assert.equal(await call, "Pip is still working on it. I will tell you when it is done.");
  turns[0].end({ reply: "Read them all." });
  await tick2();
  assert.match(said[0][1], /Read them all\./);
});

test("a turn that fails says why, and one that says nothing says so", async () => {
  const { turns, desk } = handoff();
  const failed = desk.liveTool("s1", "ask_bot", { request: "Open the vault." });
  await tick2();
  turns[0].end({ detail: "The model is unavailable. Try again later." });
  assert.equal(await failed, "Pip couldn't finish that: The model is unavailable. Try again later.");
  const empty = desk.liveTool("s1", "ask_bot", { request: "Hello?" });
  await tick2();
  turns[1].end({});
  assert.equal(await empty, "The bot didn't answer that. Its reply, if any, is in the chat.");
});

test("the voice is told what to do when the bot needs the person", () => {
  const text = liveInstructions({ name: "Pip" });
  assert.match(text, /needs the person's approval, has a question for them, or is still working/);
  assert.match(text, /you can't approve or answer for them/);
  assert.match(text, /When you are then told that Pip has answered, tell the person what it said/);
});

test("Codex live: words for the voice to say later go into the session, and not into one that has ended", async () => {
  const peer = fakeCodex();
  const codex = new CodexVoice({ provider: {}, spawn: async () => peer, onTool: async () => "ok" });
  const { id } = await codex.live({ sdp: "v=0 offer", tools: [ASK_BOT], botName: "Pip" });
  assert.equal(await codex.say(id, "Pip has now answered: all tidy."), true);
  const sent = peer.seen.filter(([method]) => method === "thread/realtime/appendText").at(-1)[1];
  assert.deepEqual(sent, { threadId: "thread-9", text: "Pip has now answered: all tidy.", role: "user" });
  assert.equal(await codex.say("codex-unknown", "x"), false);
  codex.end(id);
  await peer.exited;
  assert.equal(await codex.say(id, "too late"), false);
});

test("the window resolves and names a bot's own voice as the main process does", () => {
  const shared = { tts: { provider: "openai", model: "tts-1-hd", voice: "cedar", speed: 1.5 }, live: { provider: "openai", voice: "marin" }, providers: { openai: { hasKey: true }, gemini: { hasKey: true } } };
  for (const own of [undefined, { voice: "sage" }, { provider: "openai", speed: 0.8 }, { provider: "gemini", voice: "Puck" }, { provider: "device" }]) assert.deepEqual(effectiveTts(shared.tts, own), linkTts(shared.tts, own), JSON.stringify(own));
  for (const own of [undefined, { voice: "Puck" }, { provider: "gemini", voice: "Puck" }]) assert.deepEqual(effectiveLive(shared.live, own), linkLive(shared.live, own), JSON.stringify(own));
  assert.equal(botVoiceSummary(undefined, shared), "Same as Settings");
  assert.equal(botVoiceSummary({ tts: { provider: "openai", voice: "nova" }, live: { provider: "gemini", voice: "Puck" } }, shared), "OpenAI · Nova · Live: Gemini · Puck");
  assert.equal(botVoiceSummary({ tts: { provider: "device" } }, shared), "This computer");
  // Another provider keeps the speed and drops the model and voice that wouldn't fit it.
  assert.deepEqual(withProvider({ tts: { provider: "openai", model: "tts-1", voice: "nova", speed: 1.25 } }, "tts", "gemini"), { tts: { provider: "gemini", speed: 1.25 } });
});

test("a phone's Codex transcript is recorded in its chat and hangup keeps the last partial", () => {
  const ws = fakeWorkspace();
  const writes = [];
  ws.recordVoiceLine = (...args) => writes.push(args);
  const desk = new VoiceDesk({ voice: fakeVoice, workspace: () => ws });
  desk.noteSession("codex-1", { chatId: "chat-1" });
  desk.heard("codex-1", "What ", false);
  desk.heard("codex-1", "time", false);
  desk.heard("codex-1", "What time?", true);
  desk.heard("codex-1", "Tomorrow", false);
  desk.forget("codex-1");
  assert.deepEqual(writes.map(([chatId, , text, final]) => [chatId, text, final]), [
    ["chat-1", "What ", false], ["chat-1", "What time", false], ["chat-1", "What time?", true],
    ["chat-1", "Tomorrow", false], ["chat-1", "Tomorrow", true],
  ]);
  assert.equal(writes[0][1], writes[2][1]);
  assert.notEqual(writes[2][1], writes[3][1]);
});

test("desktop speech keeps overlapping items separate and finalizes the last revision on hangup", async () => {
  const ws = fakeWorkspace();
  const writes = [];
  ws.recordVoiceLine = (...args) => writes.push(args);
  const desk = new VoiceDesk({ voice: fakeVoice, workspace: () => ws });
  const { id } = await desk.startLive("chat-1");
  desk.heard(id, "One", false, { item: "u1" });
  desk.heard(id, "Two", false, { item: "u2" });
  desk.heard(id, "One!", true, { item: "u1" });
  desk.heard(id, " stale", false, { item: "u1" });
  desk.heard(id, "Twenty", false, { item: "u2", replace: true });
  desk.endLive(id);
  assert.deepEqual(writes.map(([, key, words, final]) => [key, words, final]), [
    [id + ":item-u1", "One", false], [id + ":item-u2", "Two", false], [id + ":item-u1", "One!", true],
    [id + ":item-u2", "Twenty", false], [id + ":item-u2", "Twenty", true],
  ]);
});

test("Codex item transcripts stream once when the flat events are also delivered", async t => {
  const peer = fakeCodex();
  const ws = fakeWorkspace();
  const { recordVoiceLine } = await import("../desktop/link/voice-history.mjs");
  ws.recordVoiceLine = (chatId, ...line) => recordVoiceLine(ws.chat(chatId), ...line);
  const desk = new VoiceDesk({ workspace: () => ws });
  const codex = new CodexVoice({
    spawn: async () => peer,
    onSession: (id, about) => desk.noteSession(id, about),
    onEvent: (id, e) => {
      if (e.type === "transcript") desk.heard(id, e.text, e.final, e);
    },
  });
  const { id } = await codex.live({ sdp: "v=0 offer", chatId: "chat-1" });
  t.after(() => codex.end(id));
  const event = (type, data) => peer.send("thread/realtime/" + type, { threadId: "thread-9", ...data });
  const utterance = { type: "transcriptSegment", id: "a", role: "assistant", text: "" };
  event("item/started", { item: utterance });
  event("item/transcript/delta", { itemId: "a", delta: "Hel" });
  assert.equal(ws.chat("chat-1").messages[0]?.text, "Hel");
  event("transcript/delta", { role: "assistant", delta: "Hel" });
  event("item/completed", { item: { ...utterance, text: "Hello!" } });
  event("transcript/done", { role: "assistant", text: "Hello!" });
  assert.deepEqual(ws.chat("chat-1").messages.map(m => [m.role, m.text]), [["assistant", "Hello!"]]);
});
