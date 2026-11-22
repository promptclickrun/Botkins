#!/usr/bin/env node
// A demo computer for the phone app: the link in front of a made-up workspace (mock-backend.mjs).
//   npm run dev-host            prints a pairing QR code and keeps one open
//   PORT=47620 npm run dev-host listens on that port (47620 is also the default: never the real app's 47610,
//                               or a phone that is given only this machine's address would reach the demo)
//   BOTKINS_DEV_RELAY=https://relay.example.com   reach this demo computer through that relay (default: no relay)
//   BOTKINS_DEV_AWAY=1                    with a relay: tell phones only the relay address, as if they were away from home
//   BOTKINS_DEV_SCREEN=off|view|control   what phones may do with this computer's screen (default control here)
//   BOTKINS_DEV_PICTURE=<file.jpg>        show this picture as the screen, and only log clicks and typing
//   BOTKINS_DEV_PRS=1                     answer pull request lookups with made-up ones (a stand-in gh)
//   BOTKINS_DEV_APPENDS=off               act as an older computer, with full-string streaming replies and thinking
//   BOTKINS_DEV_TIMELINE=off              act as an older computer, without "turn-timeline-v1" (docs/turn-timeline.md)
//   BOTKINS_DEV_PLUGINS=off               act as an older computer, without "plugins-v1" (docs/plugins.md)
//   BOTKINS_DEV_AGENTS=off                act as an older computer, without "agent-templates-v1" (docs/agent-templates.md)
//   BOTKINS_DEV_BOT_VOICE=off             act as an older computer, without "bot-voice-v1" (a voice of its own for each bot)
//   BOTKINS_DEV_AUTO_APPROVE=1            approve team join requests after a short wait
//   BOTKINS_DEV_VOICE=mac                 speech for trying a gadget, with no key: macOS `say` reads replies, and
//                                         BOTKINS_DEV_STT="<command>" hears (it gets a WAV file's path and prints the
//                                         words; without it every recording is kept in <dir> and heard as BOTKINS_DEV_HEARD)
//   BOTKINS_DEV_GADGET=<serial port>      set a gadget up over that USB port at the start (gadget/docs/contract.md);
//                                         BOTKINS_DEV_WIFI_SSID and BOTKINS_DEV_WIFI_PASSWORD give it a network.
//                                         In this console: gadget <serial port> [network name] [password]
// The pairing link is also written to <dir>/pairing-url.txt for scripts and simulators.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { introduce, serialLines } from "./gadget-setup.mjs";
import { LinkHost, qrText } from "./index.mjs";
import { MockBackend } from "./mock-backend.mjs";
import { jpegSize } from "./screen.mjs";

const dir = process.env.BOTKINS_DEV_DIR ?? join(tmpdir(), "botkins-dev-host");
mkdirSync(dir, { recursive: true });
const backend = new MockBackend();

// Speech for trying a gadget without a provider's key: this Mac reads replies with `say`, and a
// command of the person's own hears. It stands where the desktop app's local speech models stand.
if (process.env.BOTKINS_DEV_VOICE === "mac") {
  const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  let files = 0;
  backend.voice = {
    local: {
      models: () => [
        { id: "dev-stt", name: "Demo hearing", kind: "stt", installed: true },
        { id: "dev-say", name: "macOS say", kind: "tts", installed: true, voices: [] },
      ],
      async transcribe(wav) {
        // Named by the time too, so a restart doesn't write over what was kept before.
        const path = join(dir, "heard-" + Date.now() + "-" + ++files + ".wav");
        writeFileSync(path, wav);
        const command = (process.env.BOTKINS_DEV_STT ?? "").split(/\s+/).filter(Boolean);
        if (!command.length) return { text: process.env.BOTKINS_DEV_HEARD ?? "Hello from the gadget" };
        return { text: String(await run(command[0], [...command.slice(1), path])).trim() };
      },
      async synthesize(text) {
        const path = join(dir, "say-" + ++files + ".wav");
        try {
          await run("say", ["-o", path, "--data-format=LEI16@24000", text]);
          return { audio: readFileSync(path) };
        } finally {
          rmSync(path, { force: true });
        }
      },
    },
  };
}

// A stand-in screen: one picture, so the phone's screen pages can be tried without showing (or
// touching) the real one. Clicks and typing are printed, never posted.
let screenInput;
if (process.env.BOTKINS_DEV_PICTURE) {
  const jpeg = readFileSync(process.env.BOTKINS_DEV_PICTURE);
  const size = jpegSize(jpeg);
  if (!size) throw new Error("BOTKINS_DEV_PICTURE has to be a JPEG file.");
  backend.screen = {
    displays: async () => [{ id: "demo", label: "Demo display", ...size, primary: true }],
    capture: async () => ({ jpeg, ...size }),
    permissions: async () => ({ screenRecording: true, accessibility: true }),
  };
  screenInput = async ({ events }) => console.log("Screen input  " + JSON.stringify(events));
}

// Stand-in pull requests: a tiny gh that prints made-up ones, found before the real gh.
let searchPath;
if (process.env.BOTKINS_DEV_PRS === "1" && process.platform !== "win32") {
  const bin = join(dir, "demo-bin");
  mkdirSync(bin, { recursive: true });
  const pr = (number, title, state, extra = {}) => ({ number, title, url: "https://github.com/example/botkins/pull/" + number, state, isDraft: false, author: { login: "mira-bot" }, headRefName: "branch-" + number, baseRefName: "main", updatedAt: new Date(Date.now() - number * 3_600_000).toISOString(), ...extra });
  const list = [pr(42, "Share one in-flight token renewal per server", "OPEN"), pr(41, "Pricing page: final copy pass", "OPEN", { isDraft: true, author: { login: "quill-bot" } }), pr(39, "Compress hero images", "MERGED"), pr(37, "Try a darker footer", "CLOSED")];
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nif [ \"$2\" = view ]; then cat \"$(dirname \"$0\")/pr-one.json\"; else cat \"$(dirname \"$0\")/pr-list.json\"; fi\n");
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "pr-list.json"), JSON.stringify(list));
  writeFileSync(join(bin, "pr-one.json"), JSON.stringify(list[0]));
  searchPath = [bin, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
}

const host = new LinkHost({
  dir,
  backend,
  port: process.env.PORT ? Number(process.env.PORT) : 47620,
  // A simulator reaches this computer on loopback.
  extraHosts: ["127.0.0.1"],
  searchPath,
  screenInput,
  // The demo computer uses no relay unless one is named, so it never opens an outside connection by itself.
  relay: process.env.BOTKINS_DEV_RELAY ? { url: process.env.BOTKINS_DEV_RELAY } : false,
  // A space can be shared by link without a relay here, so the Share sheet can be tried: the link is made, nothing is published.
  demoSpaceLinks: !process.env.BOTKINS_DEV_RELAY,
  log: (line) => console.log(line),
});
// The demo bot can use a paired phone: a message with "calendar", "contact", "where am I", "photo",
// "steps" or "email" in it calls the matching phone tool.
backend.phone = { call: (name, args, options) => host.callDeviceTool(name, args, options) };
// Its made-up updates (BOTKINS_DEV_UPDATE): a newer version tells the phones, and an install
// "restarts" the link for a few seconds, as a real update restarts the app.
backend.updates.onAvailable = (version) => host.push.updateAvailable(version);
// A note or a change in a space: the link tells the others who want to hear of it (space-alerts.mjs).
backend.onSpaceEvent = (event) => host.spaceEvent(event);
backend.updates.onRestart = async () => {
  console.log("Restarting for the update…");
  await host.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await host.setEnabled(true);
  console.log("Back after the update.");
};
host.setName(process.env.BOTKINS_DEV_NAME ?? "Demo Mac");
if (process.env.BOTKINS_DEV_VOICE === "mac") host.voice.set({ stt: { provider: "local" }, tts: { provider: "local" } });

/** Sets a gadget up over a USB port: reads its key, names it to this demo computer, and hands it the answer. */
async function setUpGadget(port, wifi) {
  let io;
  try {
    io = serialLines(port);
    console.log("Gadget        looking on " + port + "…");
    let last = "";
    const done = await introduce({
      io,
      wifi,
      add: (input) => host.addGadget(input),
      onStatus: (status) => {
        const line = "Wi-Fi " + status.wifi + ", computer " + status.link;
        if (line !== last) console.log("Gadget        " + (last = line));
      },
    });
    console.log("Gadget        " + done.board + " (" + done.mac + ", firmware " + done.firmware + ") is set up and online.");
  } catch (error) {
    console.log("Gadget        " + error.message);
  } finally {
    io?.close();
  }
}
// The real app starts with the screen off. The demo host starts with it fully on, so the phone's screen
// pages can be tried; with no capture adapter, macOS uses its own screencapture tool.
// A headless demo keeps the level a phone set (it is saved); any other starts at BOTKINS_DEV_SCREEN.
const screen = process.env.BOTKINS_DEV_SCREEN ?? (process.env.BOTKINS_DEV_HEADLESS === "1" ? undefined : "control");
if (screen !== undefined) host.setScreenMode(["off", "view", "control"].includes(screen) ? screen : "control");
// Two made-up credentials, so the phone's credentials page has something to show.
if (!host.credentials.locked && !host.credentials.list().length) {
  await host.credentials.save({ name: "Demo API key", kind: "api-key", value: "demo-key-not-a-real-secret" });
  await host.credentials.save({ name: "Demo login", kind: "login", username: "demo@example.com", website: "https://example.com", value: "demo-password-not-real" });
}
// "Away": phones learn only the relay's address, so everything they do goes through it. This is how
// the relay path is tried on a simulator, which can always reach this computer directly.
if (process.env.BOTKINS_DEV_AWAY === "1" && process.env.BOTKINS_DEV_RELAY) {
  const all = host.hosts.bind(host);
  host.hosts = () => all().filter((entry) => entry.startsWith("relay!"));
}
await host.setEnabled(true);
if (process.env.BOTKINS_DEV_GADGET) {
  const ssid = process.env.BOTKINS_DEV_WIFI_SSID;
  void setUpGadget(process.env.BOTKINS_DEV_GADGET, ssid ? { ssid, password: process.env.BOTKINS_DEV_WIFI_PASSWORD ?? "" } : undefined);
}
// "Launch" starts shared with all members, who may change it, so a member's phone has a shared space to open.
const launch = host.spacesFor("owner").find((space) => space.name === "Launch" && space.access === "private");
if (launch) host.shareSpace("owner", launch.id, { access: "team", teamCan: "edit" });

async function open() {
  const pairing = host.startPairing(24 * 60 * 60_000);
  const invite = await host.createInvite({ groupId: "g_everyone", days: 7, maxUses: 5 });
  writeFileSync(join(dir, "pairing-url.txt"), pairing.url);
  console.log("\n" + qrText(pairing.url) + "\n");
  console.log("Pairing link  " + pairing.url);
  console.log("Address       " + host.hosts().join("  "));
  const relay = host.status().relay;
  console.log("Relay         " + (relay.enabled ? relay.url + (relay.connected ? " (connected)" : " (connecting)") : "off"));
  console.log("Screen        " + host.status().screen.mode);
  console.log("Turn timeline " + (backend.timeline ? "on (turn-timeline-v1)" : "off, as an older computer"));
  console.log("Code          " + pairing.code.replace(/(.{4})(?=.)/g, "$1-") + "\n");
  console.log("Team invite   " + invite.link);
  console.log("Invite code   " + invite.code.replace(/(.{5})(?=.)/g, "$1-") + "\n");
}
host.on("paired", (device) => {
  console.log("Paired with " + device.name + ". A new code is open for the next phone.");
  setImmediate(() => void open());
});
await open();

let latestRequest;
host.on("joinRequest", (request) => {
  latestRequest = request;
  console.log("\nTeam request  " + request.name + " (" + request.id + ")");
  console.log("Type approve " + request.id + " or deny " + request.id + " in this console.");
  if (process.env.BOTKINS_DEV_AUTO_APPROVE === "1") {
    const id = request.id;
    setTimeout(() => {
      void host.approve(id).then(() => console.log("Approved " + request.name + "."), (error) => console.log("Approval failed: " + error.message));
    }, 2500);
  }
});
const input = createInterface({ input: process.stdin, output: process.stdout });
input.on("line", (line) => {
  const [action, id = latestRequest?.id, ...more] = line.trim().split(/\s+/);
  if (action === "gadget") {
    if (!id) return console.log("Type: gadget <serial port> [network name] [password]");
    return void setUpGadget(id, more.length ? { ssid: more[0], password: more.slice(1).join(" ") } : undefined);
  }
  if (action !== "approve" && action !== "deny") return;
  if (!id) return console.log("There is no team request waiting.");
  const work = action === "approve" ? host.approve(id) : host.deny(id);
  void work.then(() => console.log((action === "approve" ? "Approved " : "Denied ") + id + "."), (error) => console.log("That didn't work: " + error.message));
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  input.close();
  host.stop().finally(() => process.exit(0));
});
