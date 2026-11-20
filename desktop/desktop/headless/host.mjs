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
const { backend, refresh, screenInput } = headlessBackend((method, args) => workspaceRequest(socket, method, args), version);
const host = new LinkHost({ dir, backend, screenInput, port, relay: false, log: (s) => console.error(s) });
const hostName = process.env.BOTKINS_HOST_NAME?.trim();
if (hostName || !host.store.data.name) host.setName(hostName || "Botkins server");
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
function pair() {
  const pairing = host.startPairing();
  const uri = new URL(pairing.url);
  // A container's bridge address is not reachable from the phone.
  uri.searchParams.set("h", process.env.BOTKINS_PAIR_ADDRESS || "127.0.0.1:" + host.port);
  writeFileSync(file + ".tmp", JSON.stringify({ ...pairing, url: uri.href }) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
host.on("status", () => { if (!host.activePairing()) rmSync(file, { force: true }); });
await refresh();
await host.setEnabled(true);
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
