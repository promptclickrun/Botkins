// Live voice, live: real speech on this computer's own ChatGPT sign-in, through Codex's realtime
// voice. It needs Codex signed in here and macOS (it makes the speech with `say`), costs a little
// of the plan, and is not part of `npm test`. Run it after `npm run build`:
//   node test/voice-live.mjs                 every scenario
//   VOICE_SCENARIOS=window node test/…       one of: window, approval, phone
// Set BOTKINS_BINARY to test a packaged app. The data folder is the test's own, the app is muted,
// and the "microphone" is a sound file, so nothing is heard and nothing of the person's is recorded.
//
// What each scenario shows, as the owner asked for it:
//   window    In the desktop window: the voice speaks as the chat's bot, a spoken request is handed
//             to that bot as a normal turn in that chat, the voice says the bot's answer, and End
//             ends the session on both sides.
//   approval  In the desktop window: the bot stops for an approval, the voice says so, the request
//             is on screen, and after it is answered there the voice says the bot's answer.
//   phone     Through the link, as a paired phone does it: `link.voice.live` with a WebRTC offer,
//             the tool call arriving for that chat on the computer, and `link.voice.endLive`.
//   phone-approval  The same way in, with a request that makes the bot stop for an approval: the
//             voice says so, the phone answers the request through the link (`respond`), and the
//             voice then says the bot's answer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { agree, b64u, box, cleanCode, hkdf, INFO, newKeyPair, open, random, seal, seqNonce, unb64u, unbox } from "../desktop/link/crypto.mjs";
import { skipWelcome } from "./welcome-helper.mjs";
import { createSources } from "./fixtures/sources.mjs";
import { seedApp } from "./starter.mjs";

if (process.platform !== "darwin") throw new Error("This check makes its speech with macOS's `say`.");
const scenarios = (process.env.VOICE_SCENARIOS ?? "window,approval,phone,phone-approval").split(",");
const binary = process.env.BOTKINS_BINARY;
const root = mkdtempSync(join(tmpdir(), "botkins-voice-live-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 48 kHz mono sound file: each part is seconds of silence or a sentence spoken by the system. */
function speech(name, parts) {
  const rate = 48000;
  const chunks = [];
  for (const [index, part] of parts.entries()) {
    if (typeof part === "number") chunks.push(Buffer.alloc(Math.round(part * rate) * 2));
    else {
      const aiff = join(root, name + "-" + index + ".aiff");
      const wav = join(root, name + "-" + index + ".wav");
      execFileSync("/usr/bin/say", ["-o", aiff, part]);
      execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@" + rate, "-c", "1", aiff, wav]);
      const file = readFileSync(wav);
      chunks.push(file.subarray(file.indexOf("data") + 8));
    }
  }
  const data = Buffer.concat(chunks);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  const out = join(root, name + ".wav");
  writeFileSync(out, Buffer.concat([head, data]));
  return out;
}

/** The app on a data folder of its own, muted, with `sound` as its microphone. */
async function launch(name, sound) {
  const dir = mkdtempSync(join(root, name + "-"));
  seedApp(dir);
  const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot,codex", BOTKINS_VOICE_LOG: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  // Chromium's sound service runs in a sandbox that can't read the sound file; for this check only, the app runs without that sandbox.
  const flags = ["--mute-audio", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=" + sound + "%noloop", "--no-sandbox"];
  const app = await _electron.launch({ args: binary ? flags : [".", ...flags], executablePath: binary, env });
  // What each voice and the person said, as the main process heard it (BOTKINS_VOICE_LOG).
  const said = [];
  const log = [];
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const heard = /^voice (\S+) (user|assistant): (.*)$/.exec(line);
        if (heard) said.push({ session: heard[1], role: heard[2], text: heard[3] });
        else if (/voice|Voice|codex|Codex/.test(line)) log.push(line.slice(0, 240));
      }
    });
  const page = await skipWelcome(await app.firstWindow());
  const snap = () => page.evaluate(() => window.botkins.snapshot());
  // The bot knows one thing nobody else does, so its answer can be told from a made-up one.
  await page.evaluate(() => window.botkins.setBotMemory("pip", "The gate code is heron forty two."));
  await page.evaluate(() => window.botkins.setVoice({ live: { provider: "codex" } }));
  const settings = await page.evaluate(() => window.botkins.voiceSettings());
  assert.deepEqual(settings.providers.codex, { available: true, signedIn: true }, "Codex is installed and signed in to ChatGPT here");
  // A chat with Pip, open in the window, as a person opens one.
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /Pip/ }).click();
  await page.locator(".chathead").getByRole("heading", { name: "Pip", exact: true }).waitFor();
  const chatId = (await snap()).chats[0].id;
  return { app, page, dir, said, log, snap, chatId, close: () => app.close().catch(() => {}) };
}
const until = async (what, check, ms = 90000) => {
  const limit = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > limit) throw new Error("Timed out waiting for " + what);
    await sleep(500);
  }
};
/** On a failure: what was said and what the chat holds, so it can be seen where it stopped. */
async function dump(run, error) {
  const state = await run.snap().catch(() => null);
  const chat = state?.chats.find((c) => c.id === run.chatId);
  console.log("FAILED: " + error.message);
  console.log(JSON.stringify({ said: run.said.map((l) => l.role + ": " + l.text.slice(0, 200)), messages: (chat?.messages ?? []).map((m) => m.role + ": " + String(m.text).slice(0, 160)), runs: (state?.runs ?? []).filter((r) => r.chatId === run.chatId).map((r) => [r.status, r.detail, (r.steps ?? []).map((st) => st.name)]), requests: (state?.requests ?? []).map((r) => [r.kind, String(r.title).slice(0, 80)]), log: run.log.slice(-25) }, null, 1));
}
const spoken = (said, role) => said.filter((line) => line.role === role).map((line) => line.text).join(" ");
/** Codex's own processes for live voice, by this app: a session's `codex app-server` child. */
const voiceProcesses = async (app) => {
  const pid = await app.evaluate(() => process.pid);
  return execFileSync("/bin/ps", ["-Ao", "ppid,command"], { encoding: "utf8" }).split("\n").filter((line) => line.trim().startsWith(pid + " ") && /codex.* app-server$/.test(line.trim())).length;
};
const results = {};

try {
  if (scenarios.includes("window")) {
    // The file starts playing when the microphone is opened; the session is live some seconds later.
    const sound = speech("window", [20, "Hello. What is your name?", 14, "Please ask the bot what the gate code is.", 60]);
    const run = await launch("window", sound);
    try {
      const { page, said, snap, chatId, app } = run;
      const voiceButton = page.getByRole("button", { name: "Live voice", exact: true });
      await voiceButton.waitFor({ timeout: 20000 });
      const before = await voiceProcesses(app);
      await voiceButton.click();
      const panel = page.getByRole("region", { name: "Live voice" });
      await panel.waitFor({ timeout: 30000 });
      // 1. The voice speaks as the bot.
      await until("the voice to answer the greeting", () => /pip/i.test(spoken(said, "assistant")));
      const intro = spoken(said, "assistant");
      assert.ok(!/chatgpt|openai/i.test(intro), "it does not call itself ChatGPT: " + intro);
      // 2. A spoken request is handed to the bot as a normal turn in this chat, and the voice says its answer.
      const chat = await until("the request to reach the chat", async () => {
        const c = (await snap()).chats.find((each) => each.id === chatId);
        return c.messages.some((m) => m.role === "assistant" && /heron/i.test(m.text)) && c;
      });
      const asked = chat.messages.find((m) => m.role === "user" && m.runId);
      const run1 = (await snap()).runs.find((r) => r.id === asked.runId);
      assert.equal(run1?.status, "Completed", "the handed-over request is a normal, finished turn");
      await until("the voice to say the bot's answer", () => /heron/i.test(spoken(said, "assistant").replace(intro, "")));
      const during = await voiceProcesses(app);
      // 3. End ends it on both sides.
      await panel.getByRole("button", { name: "End live voice", exact: true }).click();
      await panel.waitFor({ state: "detached", timeout: 15000 });
      await until("Codex's voice process to end", async () => (await voiceProcesses(app)) === before, 20000);
      results.window = { voiceSaid: spoken(said, "assistant").slice(0, 400), personHeardAs: spoken(said, "user").slice(0, 200), requestInChat: asked.text, botReply: chat.messages.findLast((m) => m.role === "assistant").text.slice(0, 160), voiceProcesses: { before, during, after: await voiceProcesses(app) } };
      assert.ok(during > before, "a Codex voice process ran during the session");
      console.log("window: the voice spoke as Pip, handed the request to Pip in the chat (" + JSON.stringify(asked.text) + "), said Pip's answer, and End ended it on both sides.");
    } catch (error) {
      await dump(run, error);
      throw error;
    } finally {
      await run.close();
    }
  }

  if (scenarios.includes("approval")) {
    const sound = speech("approval", [20, "Please ask the bot to call the review note tool with the note: voice check.", 120]);
    const run = await launch("approval", sound);
    try {
      const { page, said, snap, chatId, dir } = run;
      const data = createSources(dir);
      const imported = await page.evaluate((json) => window.botkins.importMcpServers(json), readFileSync(data.mcp, "utf8"));
      assert.deepEqual(imported.added, ["botkins-sample"]);
      const voiceButton = page.getByRole("button", { name: "Live voice", exact: true });
      await voiceButton.waitFor({ timeout: 20000 });
      await voiceButton.click();
      const panel = page.getByRole("region", { name: "Live voice" });
      await panel.waitFor({ timeout: 30000 });
      // The bot stops for an approval: the request is on screen, and the voice says so.
      const request = page.getByRole("region", { name: "Approval request" });
      await request.waitFor({ timeout: 120000 });
      const pending = (await snap()).requests.find((r) => r.chatId === chatId);
      assert.equal(pending?.kind, "permission");
      await until("the voice to say that the bot needs an approval", () => /approv/i.test(spoken(said, "assistant")));
      const whileWaiting = spoken(said, "assistant");
      assert.equal((await snap()).runs.find((r) => r.chatId === chatId)?.status, "Working", "the turn waits for the person, as any turn does");
      // The person answers on screen; the turn goes on, and the voice says what the bot answered.
      await request.getByRole("button", { name: "Allow for this chat" }).click();
      await until("the turn to finish", async () => (await snap()).runs.find((r) => r.chatId === chatId)?.status === "Completed");
      const reply = (await snap()).chats.find((c) => c.id === chatId).messages.findLast((m) => m.role === "assistant").text;
      await until("the voice to speak again with the bot's answer", () => spoken(said, "assistant").length > whileWaiting.length + 10);
      results.approval = { requestTitle: String(pending.title).slice(0, 120), voiceSaidWhileWaiting: whileWaiting.slice(0, 300), botReply: reply.slice(0, 160), voiceSaidAfter: spoken(said, "assistant").slice(whileWaiting.length).trim().slice(0, 300), turns: (await snap()).runs.filter((r) => r.chatId === chatId).length };
      assert.equal(results.approval.turns, 1, "one turn in the chat, not a second one for the answer");
      await panel.getByRole("button", { name: "End live voice", exact: true }).click();
      console.log("approval: the bot stopped for an approval, the voice said so, the request was on screen, and after Allow the voice said the bot's answer.");
    } catch (error) {
      await dump(run, error);
      throw error;
    } finally {
      await run.close();
    }
  }

  for (const approval of [false, true]) {
    const name = approval ? "phone-approval" : "phone";
    if (!scenarios.includes(name)) continue;
    const sound = approval ? speech(name, [22, "Please ask the bot to call the review note tool with the note: voice check.", 120]) : speech(name, [22, "Hello. What is your name?", 14, "Please ask the bot what the gate code is.", 60]);
    const run = await launch(name, sound);
    try {
      const { page, said, snap, chatId, app, dir } = run;
      if (approval) {
        const data = createSources(dir);
        assert.deepEqual((await page.evaluate((json) => window.botkins.importMcpServers(json), readFileSync(data.mcp, "utf8"))).added, ["botkins-sample"]);
      }
      // A stand-in phone pairs and opens a session, as test/phone-smoke.mjs does.
      await page.evaluate(() => window.botkins.setPhoneLink(true));
      const status = await page.evaluate(() => window.botkins.startPhonePairing());
      const base = "http://127.0.0.1:" + status.port + "/botkins/v1/";
      const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream", ...headers }, body });
      const hello = await (await fetch(base + "hello")).json();
      const mine = newKeyPair();
      const pairKey = hkdf(agree(mine, unb64u(hello.publicKey)), Buffer.from(cleanCode(status.pairing.code), "utf8"), INFO.pair);
      const paired = await post("pair", JSON.stringify({ publicKey: b64u(mine.publicKey), box: box(pairKey, { name: "Test phone", platform: "ios" }, "pair:" + hello.serverId) }));
      assert.equal(paired.status, 200, "the stand-in phone pairs");
      const made = unbox(pairKey, (await paired.json()).box, "paired:" + hello.serverId);
      const deviceKey = hkdf(agree(mine, unb64u(hello.publicKey)), Buffer.from(made.device, "utf8"), INFO.device);
      const eph = newKeyPair();
      const nonce = random(16);
      const opened = await post("session", JSON.stringify({ device: made.device, eph: b64u(eph.publicKey), box: box(deviceKey, { eph: b64u(eph.publicKey), nonce: b64u(nonce) }, "session:" + hello.serverId) }));
      const session = unbox(deviceKey, (await opened.json()).box, "session-ok:" + hello.serverId);
      const salt = Buffer.concat([nonce, unb64u(session.nonce)]);
      const master = hkdf(Buffer.concat([agree(eph, unb64u(session.eph)), deviceKey]), salt, "botkins/session/v1");
      const [toHost, toPhone] = [hkdf(master, salt, INFO.toHost), hkdf(master, salt, INFO.toPhone)];
      let count = 0;
      const call = async (m, a) => {
        const n = ++count;
        const seq = Buffer.alloc(8);
        seq.writeBigUInt64BE(BigInt(n));
        const answer = await post("rpc", Buffer.concat([seq, seal(toHost, seqNonce(n), Buffer.from(JSON.stringify({ m, a }), "utf8"), "rpc:" + session.session)]), { "x-botkins-session": session.session });
        const raw = Buffer.from(await answer.arrayBuffer());
        let body;
        try {
          body = JSON.parse(open(toPhone, seqNonce(n), raw, "ok:" + session.session).toString("utf8"));
        } catch {
          throw new Error("The link refused " + m + ": " + answer.status + " " + raw.toString("utf8").slice(0, 200));
        }
        if (body.e) throw new Error(m + ": " + JSON.stringify(body.e).slice(0, 300));
        return body.r;
      };
      // The "phone's" side of the WebRTC call is made in the app's page: the same kind of offer a
      // phone sends, with the sound file as its microphone. The page's own live voice stays unused.
      const before = await voiceProcesses(app);
      const offer = await page.evaluate(async () => {
        const pc = (window.__phone = new RTCPeerConnection());
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
        pc.createDataChannel("oai-events");
        window.__phoneAudio = [];
        pc.ontrack = (e) => window.__phoneAudio.push(e.track.kind);
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((resolve) => (pc.iceGatheringState === "complete" ? resolve() : (setTimeout(resolve, 1500), pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve()))));
        return pc.localDescription.sdp;
      });
      // A WebRTC call from this window needs its peer-to-peer rule opened, which a phone doesn't.
      await page.evaluate((id) => window.botkins.startLiveVoice(id, { prepare: true }), chatId);
      const live = await call("link.voice.live", [{ chatId, botId: "pip", provider: "codex", sdp: offer }]);
      assert.equal(live.kind, "webrtc");
      assert.match(live.id, /^codex-/);
      await page.evaluate((sdp) => window.__phone.setRemoteDescription({ type: "answer", sdp }), live.sdp);
      await until("the phone's call to connect", () => page.evaluate(() => window.__phone.connectionState === "connected"), 30000);
      // The window's own live panel is not involved: this session is the phone's.
      assert.equal(await page.getByRole("region", { name: "Live voice" }).count(), 0, "a phone's session is not shown as this window's");
      if (approval) {
        // The bot stops for an approval in the phone's chat: the voice says so, and the request is in the state a phone reads.
        const pending = await until("the bot to ask for an approval", async () => (await snap()).requests.find((r) => r.chatId === chatId), 150000);
        assert.equal(pending.kind, "permission");
        await until("the voice to say that the bot needs an approval", () => /approv/i.test(spoken(said, "assistant")));
        const whileWaiting = spoken(said, "assistant");
        // The phone answers it, as its request panel does.
        await call("respond", [pending.id, { action: "approve" }]);
        await until("the turn to finish", async () => (await snap()).runs.find((r) => r.chatId === chatId)?.status === "Completed");
        const reply = (await snap()).chats.find((c) => c.id === chatId).messages.findLast((m) => m.role === "assistant").text;
        await until("the voice to speak again with the bot's answer", () => spoken(said, "assistant").length > whileWaiting.length + 10);
        results[name] = { requestTitle: String(pending.title).slice(0, 120), voiceSaidWhileWaiting: whileWaiting.slice(0, 300), botReply: reply.slice(0, 160), voiceSaidAfter: spoken(said, "assistant").slice(whileWaiting.length).trim().slice(0, 300), turns: (await snap()).runs.filter((r) => r.chatId === chatId).length };
        assert.equal(results[name].turns, 1);
        await call("link.voice.endLive", [live.id]);
        await until("Codex's voice process to end", async () => (await voiceProcesses(app)) === before, 20000);
        console.log("phone-approval: through the link, the bot stopped for an approval, the voice said so, the phone answered it, and the voice said the bot's answer.");
        continue;
      }
      await until("the voice to answer the greeting", () => /pip/i.test(spoken(said, "assistant")));
      const intro = spoken(said, "assistant");
      assert.ok(!/chatgpt|openai/i.test(intro), "it does not call itself ChatGPT: " + intro);
      const chat = await until("the request to reach the phone's chat", async () => {
        const c = (await snap()).chats.find((each) => each.id === chatId);
        return c.messages.some((m) => m.role === "assistant" && /heron/i.test(m.text)) && c;
      });
      await until("the voice to say the bot's answer", () => /heron/i.test(spoken(said, "assistant").replace(intro, "")));
      const during = await voiceProcesses(app);
      await call("link.voice.endLive", [live.id]);
      await until("Codex's voice process to end", async () => (await voiceProcesses(app)) === before, 20000);
      await until("the phone's call to drop", () => page.evaluate(() => ["disconnected", "failed", "closed"].includes(window.__phone.connectionState)), 30000).catch(() => {});
      results[name] = { voiceSaid: spoken(said, "assistant").slice(0, 400), requestInChat: chat.messages.find((m) => m.role === "user").text, botReply: chat.messages.findLast((m) => m.role === "assistant").text.slice(0, 160), sessions: [...new Set(said.map((line) => line.session))], phoneCallAfterEnd: await page.evaluate(() => window.__phone.connectionState), voiceProcesses: { before, during, after: await voiceProcesses(app) } };
      console.log("phone: through the link, the voice spoke as Pip, the tool call ran in the phone's chat on the computer, the voice said Pip's answer, and endLive ended Codex's side.");
    } catch (error) {
      await dump(run, error);
      throw error;
    } finally {
      await run.close();
    }
  }
  console.log(JSON.stringify(results, null, 1));
  console.log("voice live: ok (" + Object.keys(results).join(", ") + ")");
} finally {
  rmSync(root, { recursive: true, force: true });
}
