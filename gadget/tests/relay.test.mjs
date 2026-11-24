// The gadget away from its computer's network: introduced with nothing but the computer's relay entry,
// it reaches the computer through the real relay (mobile/relay/node/server.mjs, on this computer over
// ws://), as a phone does. Typed words and their reply, the reply read aloud, the Botkin's faces and the
// owner's settings all go over the relay's socket; the relay restarting and the computer's link being
// turned off and on are each come back from; and once home again, the gadget moves to the direct address.
//
//   sh firmware/build-host.sh && node --test tests/relay.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { introduce } from "../../mobile/link-host/gadget-setup.mjs";
import { pcmFromWav } from "../../mobile/link-host/gadget.mjs";
import { SIM, cleanup, folder, freePort, gadget, host, said, spokenBytes, track, until } from "./harness.mjs";

const RELAY = join(dirname(fileURLToPath(import.meta.url)), "../../mobile/relay/node/server.mjs");
let computer = null;
after(async () => {
  cleanup();
  await computer?.stop();
});

/** The self-hosted relay as its own process, on a port that stays the same across a restart. */
async function relay() {
  const port = await freePort();
  const dataDir = folder("botkins-gadget-relay-");
  const base = "http://127.0.0.1:" + port;
  let child = null;
  const it = {
    base,
    async start() {
      child = track(spawn(process.execPath, [RELAY], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, RATE_LIMITS: "off", PUSH_UPSTREAM: "off" } }));
      const end = Date.now() + 10000;
      for (;;) {
        try {
          if ((await fetch(base + "/v1/health")).ok) return;
        } catch {}
        if (Date.now() > end) throw new Error("The relay didn't start");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    // Ended at once, sockets and all (on SIGTERM it would wait for its sockets to close).
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGKILL");
    }),
  };
  await it.start();
  return it;
}

test("a gadget away from home reaches its computer through the relay, and comes back after the relay or the computer went", { timeout: 240000, skip: !existsSync(SIM) && "build the gadget first: sh firmware/build-host.sh" }, async () => {
  const server = await relay();
  const { link } = await host({ relay: { url: server.base } });
  computer = link;
  link.setRelay({ enabled: true });
  await until(() => link.status().relay.connected, "the computer on the relay");
  const entry = link.hosts().find((host) => host.startsWith("relay!"));
  assert.match(entry, /^relay![A-Za-z0-9_-]{43}@127\.0\.0\.1:\d+$/);
  // How each request reached the computer: "http" straight to it, or "relay".
  const vias = [];
  const serve = link.serve.bind(link);
  link.serve = (request) => (vias.push(request.via ?? "http"), serve(request));

  // Away: none of the computer's own addresses answers. The introduction names only the relay.
  const dir = folder("botkins-gadget-away-");
  const sim = gadget(dir, { BOTKINS_SIM_AWAY: "1", BOTKINS_SIM_PROBE_MS: "1000" });
  const done = await introduce({ io: sim.io, name: "Away gadget", botId: "bot-mira", add: async (input) => ({ ...(await link.addGadget(input)), hosts: [entry] }) });
  assert.equal(done.status.link, "online");
  await until(() => sim.view.stage === "online" && sim.view.bot === "Mira", "the gadget online through the relay");
  const id = link.status().devices.find((device) => device.kind === "gadget").id;
  assert.ok(vias.length > 0 && vias.every((via) => via === "relay"), "every request came through the relay: " + [...new Set(vias)]);
  // The session taught it the computer's own addresses too, and the relay entry is kept among them.
  const saved = JSON.parse(readFileSync(join(dir, "link.txt"), "utf8")).hosts;
  assert.equal(saved[0], entry);
  assert.ok(saved.some((host) => host.startsWith("127.0.0.1:")), "the direct address learned: " + saved);

  // A typed turn and its reply, read aloud: the samples are fetched over the relay too.
  sim.send("say Plan the launch week");
  await until(() => sim.view.phase !== "idle", "the turn under way");
  await until(() => sim.view.phase === "idle" && !!sim.view.text && sim.spoken.length === 1 && !sim.view.speaking, "the reply, read aloud", 20000);
  const first = pcmFromWav(readFileSync(sim.spoken[0]));
  assert.equal(first.rate, 16000);
  assert.ok(said.length > 0 && first.pcm.length === spokenBytes(), "every part of the reply was played whole");

  // The Botkin's faces, one call for each pose.
  await until(() => sim.view.faces === 7 && !!sim.view.look, "the Botkin's seven faces");
  // A setting changed on the owner's page reaches the gadget's long wait for news.
  link.configureGadget(id, { volume: 25 });
  await until(() => sim.view.settings?.volume === 25, "the owner's volume on the gadget");
  assert.ok(vias.every((via) => via === "relay"));

  // The relay restarts: what waited on it fails, and the gadget opens a new socket by itself.
  await server.stop();
  await until(() => sim.view.stage === "connecting", "the gadget noticing the relay went", 15000);
  await server.start();
  await until(() => link.status().relay.connected, "the computer back on the relay", 30000);
  await until(() => sim.view.stage === "online", "the gadget back through the new relay", 40000);
  link.configureGadget(id, { volume: 30 });
  await until(() => sim.view.settings.volume === 30, "news through the new relay");

  // The computer's link is turned off: the gadget says what to check (not the Wi-Fi: the relay reaches it
  // from anywhere). Turned on again, the gadget opens a new session through the relay by itself.
  await link.setEnabled(false);
  await until(() => sim.view.stage === "connecting" && /^Can't reach .+\. Check that Botkins is open there\.$/.test(sim.view.notice ?? ""), "the gadget saying it can't reach the computer", 40000);
  let mark = vias.length;
  await link.setEnabled(true);
  // Within a few seconds: after a failed look the gadget asks once without waiting, so it is online as soon as it is answered.
  await until(() => sim.view.stage === "online" && !sim.view.notice, "online again, the sentence gone", 8000);
  sim.send("say One more thing");
  await until(() => sim.view.phase === "idle" && sim.spoken.length === 2 && !sim.view.speaking, "a second turn after the computer came back", 30000);
  assert.ok(vias.slice(mark).length > 0 && vias.slice(mark).every((via) => via === "relay"));

  // Home again: the gadget's next look finds the computer's own address, and it moves there. With the
  // relay gone, it still talks.
  mark = vias.length;
  sim.send("home");
  const home = Date.now() + 40000;
  for (let volume = 40; !vias.slice(mark).includes("http"); volume = volume < 80 ? volume + 1 : 40) {
    // News ends the long wait, so the next look (1 s after the session, doubling) comes soon.
    assert.ok(Date.now() < home, "the gadget never looked at home");
    link.configureGadget(id, { volume });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await server.stop();
  link.configureGadget(id, { volume: 90 });
  await until(() => sim.view.settings.volume === 90 && sim.view.stage === "online", "news straight from the computer, with no relay");

  await sim.quit();
  await link.stop();
});
