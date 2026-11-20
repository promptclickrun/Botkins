// Public phone link. No Workspace, model providers, Electron renderer or agent
// tools run in this container. Its data volume is never mounted in the workspace.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LinkHost } from "../link/index.mjs";
import { headlessBackend } from "./backend.mjs";
import { workspaceRequest } from "./transport.mjs";

const socket = process.env.BOTKINS_WORKSPACE_SOCKET || "/run/botkins-workspace/backend.sock";
const file = process.env.BOTKINS_OWNER_PAIRING_FILE || "/run/botkins-owner/pairing.json";
const dir = process.env.BOTKINS_DATA_DIR || "/var/lib/botkins-link";
const port = Number(process.env.BOTKINS_LINK_PORT ?? 59851);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid link port.");
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
// BOTKINS_RELAY_URL: the relay phones reach this server through (https, such as a self-hosted one).
// Unset, the relay stays off and phones need BOTKINS_PAIR_ADDRESS to reach the server directly.
const relayUrl = process.env.BOTKINS_RELAY_URL?.trim() || "";
// BOTKINS_RELAY_OWN=1: that relay is this server's own and the only way phones reach it (a cloud
// server behind its own relay). A phone can then set the screen's level through it, with the same
// ticket and Face ID signature as on the server's own network (link/grant.mjs).
const relayOwn = !!relayUrl && process.env.BOTKINS_RELAY_OWN === "1";
// How long a pairing code stays open. A deployment hands its link to a person who may open it later.
const ttl = Math.min(Math.max(Number(process.env.BOTKINS_PAIR_TTL_MS) || 5 * 60_000, 60_000), 24 * 60 * 60_000);
const { backend, refresh, screenInput } = headlessBackend((method, args) => workspaceRequest(socket, method, args), version);
const host = new LinkHost({ dir, backend, screenInput, port, relay: relayUrl ? { url: relayUrl, own: relayOwn } : false, log: (s) => console.error(s) });
const hostName = process.env.BOTKINS_HOST_NAME?.trim();
if (hostName || !host.store.data.name) host.setName(hostName || "Botkins server");
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
let current = null;
function write() {
  const pairing = host.activePairing();
  if (!pairing || pairing.code !== current?.code) return rmSync(file, { force: true });
  const status = host.status().relay;
  const value = { ...current, relay: relayUrl ? { url: status.url, connected: status.connected } : null };
  writeFileSync(file + ".tmp", JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
function pair() {
  const pairing = host.startPairing(ttl);
  const uri = new URL(pairing.url);
  // A container's bridge address is not reachable from the phone: offer the address the person gave,
  // and the relay's entry when it is on. Without either, only this machine itself can pair.
  const direct = process.env.BOTKINS_PAIR_ADDRESS?.trim() || (relayUrl ? "" : "127.0.0.1:" + host.port);
  const relay = host.relayEntry();
  uri.searchParams.set("h", [direct, relay].filter(Boolean).join(","));
  // A web page a person can open anywhere: the pairing link rides in the fragment, which no server sees.
  const link = relay ? new URL(host.relayUrl()).origin + "/pair#" + uri.searchParams : null;
  current = { ...pairing, url: uri.href, link };
  write();
}
host.on("status", write);
await refresh();
await host.setEnabled(true);
if (relayUrl) host.setRelay({ enabled: true, url: relayUrl });
if (!host.status().devices.length) pair();
process.on("SIGUSR2", pair);
const timer = setInterval(refresh, 750);
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
  clearInterval(timer);
  await host.stop();
  rmSync(file, { force: true });
  process.exit(0);
});
console.log("Botkins " + version + " is listening on port " + host.port + ".");
