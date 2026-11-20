import { EventEmitter } from "node:events";
import { REMOTE_METHODS } from "../link/methods.mjs";

export function headlessBackend(request, version) {
  const changes = new EventEmitter();
  let snapshot = { bots: [], chats: [], runs: [], settings: {} };
  let revision = null;
  let available = false;
  let reading;
  const backend = {
    headless: true,
    capabilities: [],
    info: () => ({ app: "botkins", version, platform: "linux" }),
    displayStatus: () => available ? { available: true, kind: "xvfb" } : { available: false, note: "The virtual display is unavailable." },
    snapshot: () => snapshot,
    subscribe(listener) {
      changes.on("change", listener);
      return () => changes.off("change", listener);
    },
    async call(method, args) {
      if (!REMOTE_METHODS.has(method)) throw new Error("Unknown workspace call.");
      const value = await request("call", [method, args]);
      await refresh();
      return value;
    },
    async setLook(...args) { await request("setLook", args); await refresh(); },
    frames: { page: (id) => request("framePage", [id]), chatFor: (id) => request("frameChat", [id]) },
    extras: { adoptMcpSignIn: (...args) => request("adoptMcpSignIn", args) },
    screen: {
      displays: () => request("displays"),
      permissions: () => request("permissions"),
      async capture(options) {
        const shot = await request("capture", [options]);
        return { ...shot, jpeg: Buffer.from(shot.jpeg, "base64") };
      },
    },
  };
  // LinkHost takes a synchronous snapshot. One conditional read covers all
  // connected phones. A new Electron process has a new revision namespace.
  function refresh() {
    reading ??= (async () => {
      try {
        const next = await request("state", [revision]);
        const changed = revision !== next.version || available !== next.display;
        if (next.snapshot) {
          snapshot = next.snapshot;
          backend.capabilities = next.capabilities ?? [];
        }
        revision = next.version;
        available = next.display === true;
        if (changed) changes.emit("change");
      } catch {
        if (available) {
          available = false;
          changes.emit("change");
        }
      }
    })().finally(() => { reading = undefined; });
    return reading;
  }
  return { backend, refresh, screenInput: (job) => request("input", [job]) };
}
