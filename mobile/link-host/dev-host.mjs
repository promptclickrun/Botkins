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
//   BOTKINS_DEV_AUTO_APPROVE=1            approve team join requests after a short wait
// The pairing link is also written to <dir>/pairing-url.txt for scripts and simulators.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { LinkHost, qrText } from "./index.mjs";
import { MockBackend } from "./mock-backend.mjs";
import { jpegSize } from "./screen.mjs";

const dir = process.env.BOTKINS_DEV_DIR ?? join(tmpdir(), "botkins-dev-host");
mkdirSync(dir, { recursive: true });
const backend = new MockBackend();

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
backend.updates.onRestart = async () => {
  console.log("Restarting for the update…");
  await host.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await host.setEnabled(true);
  console.log("Back after the update.");
};
host.setName(process.env.BOTKINS_DEV_NAME ?? "Demo Mac");
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
  const [action, id = latestRequest?.id] = line.trim().split(/\s+/);
  if (action !== "approve" && action !== "deny") return;
  if (!id) return console.log("There is no team request waiting.");
  const work = action === "approve" ? host.approve(id) : host.deny(id);
  void work.then(() => console.log((action === "approve" ? "Approved " : "Denied ") + id + "."), (error) => console.log("That didn't work: " + error.message));
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  input.close();
  host.stop().finally(() => process.exit(0));
});
