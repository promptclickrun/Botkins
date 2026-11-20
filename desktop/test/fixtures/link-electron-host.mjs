// Runs the phone link on Electron's own Node (test/link-electron.test.mjs starts this with
// ELECTRON_RUN_AS_NODE=1 <electron> link-electron-host.mjs <temp dir>). Electron has no
// "chacha20-poly1305" cipher, so this is the runtime where the link has to seal with @noble.
// It prints one line of JSON (what a phone needs to pair), then serves until its stdin closes.
import { join } from "node:path";
import { CIPHER } from "../../desktop/link/crypto.mjs";
import { LinkHost } from "../../desktop/link/index.mjs";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: link-electron-host.mjs <temp dir>");

const backend = {
  info: () => ({ app: "botkins", version: "0.0.0", platform: process.platform }),
  snapshot: () => ({ bots: [], chats: [], runs: [], settings: {} }),
  call: () => {},
  subscribe: () => () => {},
};
const link = new LinkHost({ dir: join(dir, "link"), backend, port: 0, relay: false, extraHosts: ["127.0.0.1"] });
await link.setEnabled(true);
const { code } = link.startPairing();
const { port, serverId } = link.status();
const { publicKey } = link.hello();
process.stdout.write(JSON.stringify({ cipher: CIPHER, electron: process.versions.electron, port, code, serverId, publicKey }) + "\n");

// The test closes our stdin when it is done.
process.stdin.resume();
await new Promise((resolve) => process.stdin.on("close", resolve).on("end", resolve));
await link.stop();
process.exit(0);
