import { EventEmitter } from "node:events";
import { REMOTE_METHODS } from "../link/methods.mjs";

/**
 * What a call that names no person, or one that cannot be read, is answered with. The link always
 * names who called, so such a call means the two containers do not fit each other, most likely
 * because they are from two versions. It is refused: taken as the owner's it would have the
 * owner's limits, and marked as someone else's it would leave that mark in the owner's own chats.
 */
export const NO_PERSON = "This computer's two Botkins containers are not the same version. Update both.";

/**
 * Who called, as it crosses from the link's container to the workspace's: the link's own words
 * for a person, and nothing else a caller could add. Both sides cut it the same way, and both
 * refuse a call with no person they can read.
 */
export function callContext(context) {
  const principal = context?.principal;
  if (principal?.kind === "owner") return { principal: { kind: "owner" } };
  if (principal?.kind === "member" && typeof principal.memberId === "string" && principal.memberId)
    return { principal: { kind: "member", memberId: principal.memberId.slice(0, 200), name: typeof principal.name === "string" ? principal.name.slice(0, 200) : "", ...(typeof principal.groupId === "string" && { groupId: principal.groupId.slice(0, 200) }) } };
  throw new Error(NO_PERSON);
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
