// Live voice on the gadget, push to talk, against a stand-in for Gemini Live (a local WebSocket server
// that speaks its messages) and the computer's real link with the demo backend. The link builds the
// session as it would for Gemini: only the two network steps are replaced on this LinkHost's Voice (the
// token request answers a made-up token, and the socket's address is the stand-in's).
//
//   sh firmware/build-host.sh && node --test tests/live.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { introduce } from "../../mobile/link-host/gadget-setup.mjs";
import { pcmFromWav, speakable } from "../../mobile/link-host/gadget.mjs";
import { wavFromPcm } from "../../mobile/link-host/voice.mjs";
import { SIM, cleanup, folder, gadget, heard, host, said, tone, until } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { Server: WebSocketServer } = createRequire(join(here, "../../mobile/package.json"))("ws");
let computer = null;
let standIn = null;
after(async () => {
  cleanup();
  standIn?.close();
  await computer?.stop();
});

/** Gemini Live as the gadget sees it: answers the setup, keeps every message, and lets the test answer the rest. */
async function gemini() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const it = {
    url: "ws://127.0.0.1:" + server.address().port + "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
    connections: [],
    /** (connection, message) for each message after the setup. */
    onMessage: null,
    close() {
      for (const connection of it.connections) connection.socket.terminate();
      server.close();
    },
  };
  server.on("connection", (socket, request) => {
    const connection = { socket, path: request.url, protocol: socket.protocol, messages: [], closed: false };
    connection.send = (message) => socket.send(JSON.stringify(message));
    it.connections.push(connection);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      connection.messages.push(message);
      if (message.setup) connection.send({ setupComplete: {} });
      else it.onMessage?.(connection, message);
    });
    socket.on("close", () => (connection.closed = true));
  });
  return it;
}

/** A quiet room at the microphone: soft noise, about 0.002 of full scale, under the speech level (0.01). */
function roomNoise(seconds, rate = 16000) {
  const pcm = Buffer.alloc(Math.floor(seconds * rate) * 2);
  let seed = 7;
  for (let i = 0; i < pcm.length / 2; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pcm.writeInt16LE((seed % 201) - 100, i * 2);
  }
  return pcm;
}
const kinds = (connection) => connection.messages.map((message) => (message.setup ? "setup" : message.toolResponse ? "toolResponse" : Object.keys(message.realtimeInput ?? {})[0] ?? "?"));
const audioBytes = (messages) => messages.filter((message) => message.realtimeInput?.audio).reduce((sum, message) => sum + Buffer.from(message.realtimeInput.audio.data, "base64").length, 0);
/** The voice's sound as Gemini sends it: base64 PCM at 24 kHz, in pieces of `piece` seconds. */
const voice = (seconds, piece = 0.5) => {
  const pcm = tone(seconds, 24000);
  const parts = [];
  for (let at = 0; at < pcm.length; at += piece * 24000 * 2) parts.push({ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm.subarray(at, at + piece * 24000 * 2).toString("base64") } });
  return parts;
};
const spokenLines = (sim) => sim.lines.filter((line) => line.startsWith("spoken "));

test("a gadget talks with the bot's live voice: push to talk, ask_bot, the voice played, interrupted, closed when idle, and the turn path when Gemini is down", { timeout: 120000, skip: !existsSync(SIM) && "build the gadget first: sh firmware/build-host.sh" }, async () => {
  standIn = await gemini();
  const { link, backend } = await host();
  computer = link;
  // Gemini is the computer's live voice. The session is built by the link as for the real one; only the
  // token request and the socket's address are the stand-in's.
  link.voice.setKey("gemini", "stand-in-key");
  link.voice.set({ live: { provider: "gemini" } });
  const json = link.voice.json.bind(link.voice);
  link.voice.json = (provider, url, init, options) => (provider === "gemini" && url.endsWith("/v1beta/auth_tokens") ? Promise.resolve({ name: "auth_tokens/stand-in" }) : json(provider, url, init, options));
  const liveGemini = link.voice.liveGemini.bind(link.voice);
  const sessions = [];
  link.voice.liveGemini = async (input) => {
    const session = await liveGemini(input);
    sessions.push(session);
    return { ...session, url: standIn.url + new URL(session.url).search };
  };

  const dir = folder("botkins-gadget-live-");
  const sim = gadget(dir, { BOTKINS_SIM_REALTIME: "1", BOTKINS_SIM_LIVE_IDLE_MS: "4000" });
  await introduce({ io: sim.io, name: "Live gadget", botId: "bot-mira", add: (input) => link.addGadget(input) });
  await until(() => sim.view.stage === "online" && sim.view.bot === "Mira", "the gadget online");
  const deviceId = link.status().devices.find((device) => device.kind === "gadget").id;
  const recording = join(dir, "question.wav");
  writeFileSync(recording, wavFromPcm(tone(1, 16000), 16000));

  // ── A held press. The gadget has no chat yet: it starts one, asks the computer for a session, and opens
  // Gemini's socket while it keeps what the microphone hears.
  let toolResponse = null;
  standIn.onMessage = (connection, message) => {
    if (message.realtimeInput?.activityEnd && !toolResponse) {
      connection.send({ serverContent: { inputTranscription: { text: "Plan the launch week", finished: true } } });
      connection.send({ toolCall: { functionCalls: [{ id: "call-1", name: "ask_bot", args: { message: "Plan the launch week" } }] } });
    } else if (message.toolResponse) {
      toolResponse = message.toolResponse;
      connection.send({ serverContent: { outputTranscription: { text: "Here is the plan " } } });
      connection.send({ serverContent: { modelTurn: { parts: voice(1.5) } } });
      connection.send({ serverContent: { outputTranscription: { text: "for the week." } } });
      connection.send({ serverContent: { turnComplete: true } });
    }
  };
  sim.send("hear " + recording);
  await until(() => sim.view.live === true, "the live session open");
  await until(() => !!toolResponse, "the gadget's answer to ask_bot", 20000);
  await until(() => spokenLines(sim).length === 1 && !sim.view.speaking, "the voice played", 15000);

  // Setup: the computer's own first message, with Gemini's activity detection off and the one tool.
  const first = standIn.connections[0];
  assert.equal(first.protocol, "", "no subprotocol");
  assert.match(first.path, /\?access_token=auth_tokens%2Fstand-in$/);
  const { setup } = first.messages[0];
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.disabled, true);
  assert.deepEqual(setup.tools[0].functionDeclarations.map((tool) => tool.name), ["ask_bot"]);
  assert.match(setup.model, /^models\//);
  assert.ok(setup.systemInstruction.parts[0].text.length > 0 && setup.inputAudioTranscription && setup.outputAudioTranscription);
  // The press: the turn's start, the whole second it held in pieces of 100 ms at 16 kHz (kept while the
  // session opened: nothing was lost), the turn's end, then the answer to the tool.
  assert.deepEqual(kinds(first), ["setup", "activityStart", ...Array(10).fill("audio"), "activityEnd", "toolResponse"]);
  const pieces = first.messages.filter((message) => message.realtimeInput?.audio);
  assert.ok(pieces.every((message) => message.realtimeInput.audio.mimeType === "audio/pcm;rate=16000"));
  assert.ok(pieces.every((message) => Buffer.from(message.realtimeInput.audio.data, "base64").length === 3200));
  assert.equal(audioBytes(first.messages), 32000);

  // ask_bot: the words went to the gadget's chat, and its answer is the demo bot's real reply from the link.
  const chatId = link.store.device(deviceId).gadget.chatId;
  assert.ok(chatId, "the gadget's own chat was started");
  const chat = backend.snapshot().chats.find((item) => item.id === chatId);
  const reply = chat.messages.findLast((message) => message.role === "assistant");
  assert.ok(reply?.text, "the bot replied");
  assert.deepEqual(toolResponse.functionResponses, [{ id: "call-1", name: "ask_bot", response: { result: speakable(reply.text) } }]);

  // On the gadget: what it heard, what the voice said, the voice played at the speaker's rate, and nothing
  // read aloud by the turn path (no reply was made into speech on the computer).
  assert.equal(sim.view.heard, "Plan the launch week");
  assert.equal(sim.view.text, "Here is the plan for the week.");
  assert.ok(sim.views.some((view) => view.listening) && sim.views.some((view) => view.speaking));
  const played = pcmFromWav(readFileSync(spokenLines(sim)[0].split(" ")[1]));
  assert.equal(played.rate, 16000);
  assert.ok(Math.abs(played.pcm.length / 2 - 1.5 * 16000) <= 2, "1.5 s of the voice at 16 kHz: " + played.pcm.length / 2 + " samples");
  let peak = 0;
  for (let i = 0; i < played.pcm.length; i += 2) peak = Math.max(peak, Math.abs(played.pcm.readInt16LE(i)));
  assert.ok(peak > 7000 && peak <= 8000, "the samples are the tone, peak " + peak);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(said.length, 0, "the turn path read nothing aloud");
  assert.equal(spokenLines(sim).length, 1);

  // On the computer: the person's words and the bot's reply in the chat, and the spoken lines recorded
  // (the demo backend names voice-history-v1 and voice-turns-v1): the person's line ran the request, and the
  // voice's caption went to the written reply's row.
  const session = sessions[0].id;
  await until(() => backend.snapshot().chats.find((item) => item.id === chatId).messages.some((message) => message.voiceId === session + ":output-bot-1"), "the voice's line recorded");
  const kept = backend.snapshot().chats.find((item) => item.id === chatId).messages;
  const person = kept.find((message) => message.role === "user");
  assert.deepEqual([person.text, person.voiceId, !!person.runId, !!person.voicePartial], ["Plan the launch week", session + ":input-you-1", true, false]);
  const answered = kept.find((message) => message.voiceId === session + ":output-bot-1");
  assert.deepEqual([answered.role, answered.text, answered.runId, answered.voiceCaption], ["assistant", reply.text, person.runId, undefined]);

  // ── Interrupting: a second press, and the voice answers at length; a third press while it speaks cuts the
  // speaker and starts the person's turn.
  standIn.onMessage = (connection, message) => {
    const starts = connection.messages.filter((item) => item.realtimeInput?.activityStart).length;
    if (message.realtimeInput?.activityEnd && starts === 2) {
      connection.send({ serverContent: { outputTranscription: { text: "A long answer" } } });
      for (const part of voice(8)) connection.send({ serverContent: { modelTurn: { parts: [part] } } });
    } else if (message.realtimeInput?.activityStart && starts === 3) connection.send({ serverContent: { interrupted: true } });
    else if (message.realtimeInput?.activityEnd && starts === 3) connection.send({ serverContent: { turnComplete: true } });
  };
  sim.send("hear " + recording);
  await until(() => sim.view.speaking && sim.view.text === "A long answer", "the long answer playing", 10000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  sim.send("hear " + recording);
  await until(() => spokenLines(sim).length === 2, "the speaker cut", 5000);
  assert.match(spokenLines(sim)[1], /\(cut\)$/);
  const cut = pcmFromWav(readFileSync(spokenLines(sim)[1].split(" ")[1]));
  assert.ok(cut.pcm.length / 2 < 4 * 16000, "cut well before its 8 s: " + cut.pcm.length / 2 + " samples");
  await until(() => kinds(first).filter((kind) => kind === "activityEnd").length === 3, "the third turn sent");
  const after2 = kinds(first).slice(kinds(first).lastIndexOf("toolResponse") + 1);
  assert.deepEqual(after2.filter((kind) => kind !== "audio"), ["activityStart", "activityEnd", "activityStart", "activityEnd"]);
  assert.equal(standIn.connections.length, 1, "one session for every press so far");
  await until(() => !sim.view.speaking, "quiet after the cut");

  // ── A press with no speech in it, as a tap or a quiet room gives: nothing goes to Gemini, which would
  // make up a word for it ("¿Qué?") and answer in that word's language. The gadget is ready again at once.
  const sentBefore = first.messages.length;
  const quietWav = join(dir, "quiet.wav");
  writeFileSync(quietWav, wavFromPcm(roomNoise(1), 16000));
  const logged = sim.logs.length;
  sim.send("hear " + quietWav);
  await until(() => sim.logs.length > logged, "the quiet press in the log");
  assert.match(sim.logs.at(-1), /^live press: .*no speech, nothing sent$/);
  await until(() => !sim.view.listening && !sim.view.sending, "ready again after the quiet press");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(first.messages.length, sentBefore, "nothing sent to Gemini for a press with no speech");

  // A tap, however loud (a click of the button, a word cut off): the board gives it up, and nothing of it
  // reaches Gemini either.
  const tapWav = join(dir, "tap.wav");
  writeFileSync(tapWav, wavFromPcm(tone(0.2, 16000), 16000));
  const tapped = sim.logs.length;
  sim.send("tap " + tapWav);
  await until(() => sim.logs.length > tapped, "the tap in the log");
  await until(() => !sim.view.listening && !sim.view.sending, "ready again after the tap");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(first.messages.length, sentBefore, "nothing sent to Gemini for a tap");

  // A press that is quiet at first and then speaks: the turn starts at the speech, with the second before
  // it (so a soft first word is whole), and not the quiet before that.
  standIn.onMessage = (connection, message) => {
    if (message.realtimeInput?.activityEnd) connection.send({ serverContent: { turnComplete: true } });
  };
  const lateWav = join(dir, "late.wav");
  writeFileSync(lateWav, wavFromPcm(Buffer.concat([roomNoise(1.5), tone(1, 16000)]), 16000));
  sim.send("hear " + lateWav);
  await until(() => first.messages.slice(sentBefore).some((message) => message.realtimeInput?.activityEnd), "the late speech's turn sent");
  const lateTurn = { messages: first.messages.slice(sentBefore) };
  assert.deepEqual(kinds(lateTurn), ["activityStart", ...Array(20).fill("audio"), "activityEnd"]);
  assert.equal(audioBytes(lateTurn.messages), 64000, "the second before the speech, then the second of it");
  assert.match(sim.logs.at(-1), /^live press: .*: speech$/);

  // ── Closing: no press and no sound for the idle time (4 s here) closes the session; the computer
  // forgets it, and the next press opens a new one.
  await until(() => first.closed && !sim.view.live, "the session closed when idle", 10000);
  await until(() => !link.voice.sessions.has(session), "the computer told the session ended");
  standIn.onMessage = (connection, message) => {
    if (message.realtimeInput?.activityEnd) connection.send({ serverContent: { turnComplete: true } });
  };
  sim.send("hear " + recording);
  await until(() => standIn.connections.length === 2 && kinds(standIn.connections[1]).includes("activityEnd"), "a new session for the next press");
  assert.equal(sessions.length, 2);

  // ── Gemini down: the press goes the turn path with the sound it holds, and is heard and answered there.
  standIn.close();
  standIn = null;
  await until(() => !sim.view.live, "the session gone with Gemini");
  heard.length = 0;
  sim.send("hear " + recording);
  await until(() => heard.length === 1 && sim.view.heard === "Plan the launch week" && !sim.view.sending, "the press heard by the turn path", 20000);
  assert.deepEqual(heard, [{ bytes: 32000, rate: 16000 }]);
  await until(() => said.length > 0 && spokenLines(sim).length === 3 && !sim.view.speaking, "that reply read aloud by the turn path", 20000);
  assert.ok(!/./.test(sim.view.notice ?? ""), "no notice: the turn path worked");

  await sim.quit();
  await link.stop();
  computer = null;
});
