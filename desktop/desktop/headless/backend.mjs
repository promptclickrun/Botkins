import { EventEmitter } from "node:events";
import { REMOTE_METHODS } from "../link/methods.mjs";

/**
 * A person no team has. A call that names no person, or names one the workspace cannot read, is
 * this person's: their chat and message are marked as a member's and their turn gets the
 * narrowest limits. It is never taken for the owner's.
 */
export const NOBODY = "nobody";

/**
 * Who called, as it crosses from the link's container to the workspace's: the link's own words
 * for a person, and nothing else a caller could add. Both sides cut it the same way.
 */
export function callContext(context) {
  const principal = context?.principal;
  if (principal?.kind === "owner") return { principal: { kind: "owner" } };
  if (principal?.kind === "member" && typeof principal.memberId === "string" && principal.memberId)
    return { principal: { kind: "member", memberId: principal.memberId.slice(0, 200), name: typeof principal.name === "string" ? principal.name.slice(0, 200) : "", ...(typeof principal.groupId === "string" && { groupId: principal.groupId.slice(0, 200) }) } };
  return { principal: { kind: "member", memberId: NOBODY, name: "" } };
}

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
    // `context` says who called ({ principal } from the link). It goes with the call. The
    // workspace marks a member's chat and message as theirs, and holds their turn to a member's limits.
    async call(method, args, context) {
      if (!REMOTE_METHODS.has(method)) throw new Error("Unknown workspace call.");
      const value = await request("call", [method, args, callContext(context)]);
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
