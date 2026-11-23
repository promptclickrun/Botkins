// The gadget's core, built for this computer (firmware/host), against the computer's real link
// (mobile/link-host) with the demo backend: setup over its "USB port" (standard input), a session
// with no code, a typed turn, a recording, a reply read aloud as samples, a request answered on the
// gadget, a restart, and being removed. The same C++ runs on a board.
//
//   sh firmware/build-host.sh && node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { introduce } from "../../mobile/link-host/gadget-setup.mjs";
import { pcmFromWav } from "../../mobile/link-host/gadget.mjs";
import { LinkHost } from "../../mobile/link-host/index.mjs";
import { MockBackend } from "../../mobile/link-host/mock-backend.mjs";
import { wavFromPcm } from "../../mobile/link-host/voice.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SIM = process.env.BOTKINS_GADGET_SIM ?? join(here, "../firmware/build/botkins-gadget-sim");
const folders = [];
const running = [];
after(() => {
  for (const child of running) child.kill();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const folder = (name) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  folders.push(dir);
  return dir;
};
function tone(seconds, rate) {
  const pcm = Buffer.alloc(Math.floor(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return pcm;
}

/** The gadget as a process: lines in, lines out. `view` is what a board would draw now. */
function gadget(dir) {
  const child = spawn(SIM, [dir], { stdio: ["pipe", "pipe", "inherit"] });
  running.push(child);
  const lines = [];
  const sim = { view: {}, views: [], spoken: [], answers: [], lines };
  let held = "";
  child.stdout.on("data", (chunk) => {
    held += chunk;
    for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
      const line = held.slice(0, at);
      held = held.slice(at + 1);
      lines.push(line);
      if (line.startsWith("view ")) sim.views.push((sim.view = JSON.parse(line.slice(5))));
      else if (line.startsWith("@botkins ")) sim.answers.push(JSON.parse(line.slice(9)));
      else if (line.startsWith("spoken ")) sim.spoken.push(line.split(" ")[1]);
    }
  });
  sim.send = (line) => child.stdin.write(line + "\n");
  sim.ask = async (object) => {
    const before = sim.answers.length;
    sim.send("@botkins " + JSON.stringify(object));
    await until(() => sim.answers.length > before, "an answer to " + object.do);
    return sim.answers[before];
  };
  // The same pair of line streams as a serial port gives the introducer (gadget-setup.mjs).
  const listeners = new Set();
  child.stdout.on("data", () => {
    for (; sim.heardLines < lines.length; sim.heardLines++) for (const listener of listeners) listener(lines[sim.heardLines]);
  });
  sim.heardLines = 0;
  sim.io = { write: sim.send, onLine: (listener) => (listeners.add(listener), () => listeners.delete(listener)) };
  sim.quit = () => new Promise((resolve) => {
    child.once("exit", resolve);
    sim.send("quit");
  });
  return sim;
}
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const heard = [];
const said = [];
async function host() {
  const backend = new MockBackend({ speed: 0.05 });
  backend.voice = {
    local: {
      models: () => [{ id: "ears", name: "Ears", kind: "stt", installed: true }, { id: "mouth", name: "Mouth", kind: "tts", installed: true, voices: ["one"] }],
      transcribe: async (wav) => {
        const { pcm, rate } = pcmFromWav(wav);
        heard.push({ bytes: pcm.length, rate });
        return { text: "Plan the launch week" };
      },
      // A second of tone for each 40 characters, at 24 kHz: the gadget asks for 16 kHz.
      synthesize: async (text) => {
        said.push(text);
        return { audio: wavFromPcm(tone(text.length / 40, 24000), 24000) };
      },
    },
  };
  // A port of its own, kept when the link is turned off and on, as the app's is: the gadget finds it again there.
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const link = new LinkHost({ relay: false, dir: folder("botkins-gadget-host-"), backend, port, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  link.voice.set({ stt: { provider: "local" }, tts: { provider: "local" } });
  return { link, backend };
}

test("a gadget is set up over its USB port, talks, listens, reads replies aloud, answers a request, restarts and is removed", { skip: !existsSync(SIM) && "build the gadget first: sh firmware/build-host.sh" }, async () => {
  const { link } = await host();
  const dir = folder("botkins-gadget-sim-");
  let sim = gadget(dir);

  // Setup: the introducer reads the key, names the gadget to the computer, and hands the answer back.
  const hello = await sim.ask({ do: "hello" });
  assert.deepEqual([hello.hello, hello.board, hello.paired, hello.wifi], [1, "sim", false, true]);
  assert.equal(Buffer.from(hello.publicKey, "base64url").length, 32);
  assert.equal((await sim.ask({ do: "status" })).status.link, "off");
  assert.match((await sim.ask({ do: "setup", link: { deviceId: "x" } })).error, /introduction/);
  assert.match((await sim.ask({ do: "nonsense" })).error, /doesn't know/);
  // The introducer's own code does the rest: it names the gadget to the computer and waits until it is online.
  const statuses = [];
  const done = await introduce({ io: sim.io, name: "Sim gadget", botId: "bot-mira", add: (input) => link.addGadget(input), onStatus: (status) => statuses.push(status.link) });
  assert.deepEqual([done.board, done.firmware, done.status.link, statuses.at(-1)], ["sim", "0.1.0", "online", "online"]);
  await until(() => sim.view.stage === "online" && sim.view.bot === "Mira", "the gadget online");
  assert.equal(link.status().pairing, null, "no pairing code was ever open");
  assert.deepEqual([sim.view.name, sim.view.phase, sim.view.hear, sim.view.speak], ["Sim gadget", "idle", true, true]);
  const listed = link.status().devices.find((device) => device.kind === "gadget");
  assert.deepEqual([listed.name, listed.connected, listed.gadget.board, listed.gadget.firmware, listed.gadget.rate], ["Sim gadget", true, "sim", "0.1.0", 16000]);
  assert.equal((await sim.ask({ do: "status" })).status.link, "online");
  // Nothing secret is ever printed: not the key the gadget keeps, in any line so far.
  const secret = readFileSync(join(dir, "key.txt"), "utf8");
  assert.ok(secret.length > 40 && !sim.lines.some((line) => line.includes(secret)));

  // Typed words: the reply is written as it comes, then read aloud at the gadget's rate.
  sim.send("say Plan the launch week");
  await until(() => sim.view.phase !== "idle", "the turn under way");
  await until(() => sim.view.phase === "idle" && !!sim.view.text && sim.spoken.length === 1, "the reply, read aloud");
  assert.ok(sim.views.some((view) => (view.phase === "writing" || view.phase === "working") && view.text), "the text came as it was written");
  assert.ok(sim.views.some((view) => view.speaking), "the gadget said it was speaking");
  const first = pcmFromWav(readFileSync(sim.spoken[0]));
  assert.equal(first.rate, 16000);
  // Every part of the reply was played, whole: a second for each 40 characters, at two thirds the samples.
  const expected = said.reduce((sum, text) => sum + Math.floor((Math.floor((text.length / 40) * 24000) * 16000) / 24000) * 2, 0);
  assert.equal(first.pcm.length, expected);
  let peak = 0;
  for (let i = 0; i < first.pcm.length; i += 2) peak = Math.max(peak, Math.abs(first.pcm.readInt16LE(i)));
  assert.ok(peak > 6500 && peak <= 8000, "the samples are the tone, peak " + peak);

  // The bot's Botkin arrives in every pose, from the computer's design kit.
  await until(() => sim.view.faces === 7 && !!sim.view.look, "the Botkin's seven faces");
  // A working turn counted its steps, for the halo's arc.
  assert.ok(sim.views.some((view) => view.steps > 0), "the steps of the turn reached the gadget");

  // Settings from the owner's page reach the gadget; the gadget's own reach the page.
  assert.deepEqual(sim.view.settings, { volume: 60, mic: "normal", mute: false, brightness: 80, dimAfter: 30, offAfter: 300 });
  link.configureGadget(listed.id, { volume: 25, brightness: 50 });
  await until(() => sim.view.settings.volume === 25 && sim.view.settings.brightness === 50, "the owner's settings on the gadget");
  await sim.ask({ do: "settings", mute: true });
  await until(() => link.status().devices.find((device) => device.id === listed.id).gadget.settings?.mute === true, "the gadget's mute on the computer");
  assert.equal(sim.view.settings.volume, 25, "the computer's answer kept the volume");
  // Muted, holding talk says so and sends nothing.
  heard.length = 0;
  sim.send("hear " + join(dir, "nothing.wav"));
  writeFileSync(join(dir, "short.wav"), wavFromPcm(tone(1, 16000), 16000));
  sim.send("hear " + join(dir, "short.wav"));
  await until(() => /microphone is off/.test(sim.view.notice ?? ""), "the microphone is off");
  assert.equal(heard.length, 0);
  await sim.ask({ do: "settings", mute: false });
  await until(() => link.status().devices.find((device) => device.id === listed.id).gadget.settings?.mute === false, "unmuted");
  // Kept across a restart (below): the gadget's own copy.
  assert.match(readFileSync(join(dir, "settings.txt"), "utf8"), /"volume":25/);

  // A Wi-Fi network from the owner's page: saved on the gadget, and the page sees it by name.
  link.gadgetWifi(listed.id, { add: { ssid: "Cabin", password: "pine-needles-9" } });
  await until(() => (link.status().devices.find((device) => device.id === listed.id).gadget.wifi?.saved ?? []).includes("Cabin"), "the network saved on the gadget");
  assert.equal(link.devices().find((device) => device.id === listed.id).gadget.wifiWaiting, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "wifi.txt"), "utf8")).networks.map((network) => network.ssid), ["Cabin"]);
  assert.ok(!sim.lines.some((line) => line.includes("pine-needles-9")), "the password is in no line the gadget printed");
  link.gadgetWifi(listed.id, { forget: "Cabin" });
  await until(() => !existsSync(join(dir, "wifi.txt")), "the network forgotten");

  // A restart from the owner's page: the gadget says it is restarting, and the page stops waiting.
  link.restartGadget(listed.id);
  await until(() => sim.lines.includes("restart"), "the gadget restarting");
  await until(() => !link.devices().find((device) => device.id === listed.id).gadget.restarting, "the restart taken");

  // A recording: it goes up in pieces while it is made, and is heard once.
  const recording = join(dir, "question.wav");
  writeFileSync(recording, wavFromPcm(tone(2, 16000), 16000));
  heard.length = 0;
  sim.send("hear " + recording);
  await until(() => heard.length === 1 && sim.view.heard === "Plan the launch week" && !sim.view.sending, "the recording heard");
  assert.deepEqual(heard, [{ bytes: 2 * 16000 * 2, rate: 16000 }]);
  assert.ok(sim.views.some((view) => view.listening), "the gadget said it was listening");
  await until(() => sim.view.phase === "idle" && sim.spoken.length === 2 && !sim.view.speaking, "the second reply, read aloud");

  // A request shows on the gadget and is answered there.
  sim.send("say Please approve the deploy");
  await until(() => sim.view.phase === "request", "the request");
  assert.deepEqual([sim.view.request.kind, sim.view.request.title, sim.view.request.remember], ["permission", "Run a command", true]);
  sim.send("answer approve");
  await until(() => sim.view.phase === "idle" && /deploy finished/.test(sim.view.text ?? ""), "the reply after the approval");
  await until(() => sim.spoken.length === 3 && !sim.view.speaking, "that reply read aloud");

  // A restart: the key, the computer and its addresses were kept, and the old reply is not read again.
  await sim.quit();
  sim = gadget(dir);
  await until(() => sim.view.stage === "online" && sim.view.bot === "Mira" && /deploy finished/.test(sim.view.text ?? ""), "online again after a restart");
  assert.equal((await sim.ask({ do: "hello" })).paired, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sim.spoken.length, 0, "a reply from before the restart stays quiet");
  // The cable's own verbs, for a board with nobody at its buttons: what is on show, and typed words.
  const shown = (await sim.ask({ do: "view" })).view;
  assert.deepEqual([shown.stage, shown.phase, shown.bot, shown.speaking], ["online", "idle", "Mira", false]);
  assert.deepEqual(await sim.ask({ do: "say", text: "One more thing" }), { ok: true });
  await until(() => sim.view.heard === "One more thing" && sim.view.phase === "idle" && sim.spoken.length === 1 && !sim.view.speaking, "words typed over the cable, answered and read");
  // A new chat with the next thing said, and the next bot.
  sim.send("new");
  sim.send("next");
  await until(() => sim.view.bot && sim.view.bot !== "Mira", "the next bot");

  // Removed on the computer: it says so, and keeps what it was told. ("Unknown" is an answer anyone on the
  // network could give, so it erases nothing.) Its key stays.
  link.removeDevice(listed.id);
  await until(() => sim.view.stage === "removed", "the gadget told it was removed", 40000);
  assert.match(sim.view.notice, /removed/);
  assert.equal((await sim.ask({ do: "status" })).status.link, "removed");
  const again = await sim.ask({ do: "hello" });
  assert.deepEqual([again.paired, again.publicKey], [true, hello.publicKey]);
  // Set up again, it is the same gadget with a new place among the devices, and online at once.
  const back = await introduce({ io: sim.io, name: "Sim gadget", botId: "bot-mira", add: (input) => link.addGadget(input) });
  assert.notEqual(back.deviceId, listed.id);
  await until(() => sim.view.stage === "online" && sim.view.bot === "Mira", "online again after being set up again");
  // Set up once more while it is online: the entry before ends, and the new one is the one it keeps.
  const third = await introduce({ io: sim.io, name: "Sim gadget", botId: "bot-quill", add: (input) => link.addGadget(input) });
  await until(() => sim.view.stage === "online" && sim.view.bot === "Quill", "online on the newest introduction");
  assert.equal(JSON.parse(readFileSync(join(dir, "link.txt"), "utf8")).deviceId, third.deviceId);
  assert.equal(link.status().devices.filter((device) => device.kind === "gadget").length, 1);
  // The computer goes away: after a couple of tries the screen says why it waits, and what to check.
  await link.setEnabled(false);
  await until(() => sim.view.stage === "connecting" && /Can't reach .+\. Check that Botkins is open there/.test(sim.view.notice ?? ""), "the gadget saying it can't reach the computer", 20000);
  await link.setEnabled(true);
  await until(() => sim.view.stage === "online" && !sim.view.notice, "online again, the sentence gone", 30000);
  // "forget" takes the computer and the network away; "erase" makes it another gadget.
  await sim.ask({ do: "forget" });
  await until(() => sim.view.stage === "setup", "waiting for setup after forget");
  assert.equal((await sim.ask({ do: "hello" })).publicKey, hello.publicKey);
  await sim.ask({ do: "erase" });
  assert.notEqual((await sim.ask({ do: "hello" })).publicKey, hello.publicKey);

  await sim.quit();
  await link.stop();
});
