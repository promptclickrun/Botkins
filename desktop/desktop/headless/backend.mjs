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

/**
 * `team` answers the cut of the team that the workspace is told, with its revision ({ cut, rev },
 * desktop/headless/team-cut.mjs), or null when there is none to tell. The revision goes with every
 * call and every look, and the whole cut is sent whenever the workspace does not hold that one.
 */
export function headlessBackend(request, version, { team = () => null } = {}) {
  const changes = new EventEmitter();
  // The revision the workspace last said it holds.
  let held = null;
  let telling;
  // A workspace from before this takes no cut. It is not asked again until it starts anew.
  let deaf = false;
  /** Sends the cut when the workspace does not hold the one the link has now, one at a time. A workspace that cannot take it holds none, and its members get the narrowest limits. */
  async function tell(now = team()) {
    if (!now || deaf) return;
    while (telling) await telling;
    if (held === now.rev) return;
    telling = request("team", [now.cut, now.rev])
      .then(
        (rev) => void (held = rev === now.rev ? rev : null),
        (error) => {
          held = null;
          if (/Unknown workspace action/.test(String(error?.message))) deaf = true;
        },
      )
      .finally(() => { telling = undefined; });
    await telling;
  }
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
      const who = callContext(context);
      // The workspace hears of a change to the team before the call that follows it: a member who
      // was removed, or moved to a smaller role, does not get one more turn under the old one.
      const now = team();
      await tell(now);
      const value = await request("call", [method, args, who, now?.rev ?? null]);
      await refresh();
      return value;
    },
    // The app's own half of Spaces, for the link itself and never for a device (desktop/link/SPACES.md).
    spaces: {
      ensure: (person) => request("spaces", ["ensure", person]),
      release: (person) => request("spaces", ["release", person]),
      snapshot: (id, options) => request("spaces", ["snapshot", id, options]),
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
        const now = team();
        const next = await request("state", [revision, now?.rev ?? null]);
        // A workspace that started again holds no cut, and says so here.
        if (String(next.version).split("/")[0] !== String(revision).split("/")[0]) deaf = false;
        held = typeof next.team === "string" ? next.team : null;
        if (now && held !== now.rev) await tell(now);
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
