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
  // (No member is called "owner": the link never makes that id, and a rule that reads a person's id would take it for the owner.)
  if (principal?.kind === "member" && typeof principal.memberId === "string" && principal.memberId && principal.memberId !== "owner")
    return { principal: { kind: "member", memberId: principal.memberId.slice(0, 200), name: typeof principal.name === "string" ? principal.name.slice(0, 200) : "", ...(typeof principal.groupId === "string" && { groupId: principal.groupId.slice(0, 200) }) } };
  throw new Error(NO_PERSON);
}

/**
 * `team` answers the cut of the team that the workspace is told, with its revision ({ cut, rev },
 * desktop/headless/team-cut.mjs), or null when there is none to tell. The revision goes with every
 * call and every look, and the whole cut is sent whenever the workspace does not hold that one.
 */
export function headlessBackend(request, version, { team = () => null, log = (line) => console.error(line), clock = () => performance.now() } = {}) {
  const changes = new EventEmitter();
  // The revision the workspace last said it holds.
  let held = null;
  let telling;
  // A workspace from before this takes no cut, and knows nothing of spaces. It is not asked again until it starts anew.
  let deaf = false;
  let noSpaces = false;
  // A cut that the workspace refused is not sent again at every look: later each time, up to a minute.
  let refused = null;
  let saidWhy = "";
  // A member who was removed while the workspace could not be reached: said again at each look until it is heard.
  const toRelease = new Set();
  /**
   * The team as it is now, read anew each time: never one from before a wait. A team that cannot
   * be cut (a name or a list over its limit) gives no cut. Members then get the narrowest limits,
   * the owner's calls go on as they are, and the log says why once.
   */
  function current() {
    try {
      return team();
    } catch (error) {
      const why = String(error?.message ?? error);
      if (why !== saidWhy) log("The workspace is told nothing about the team (" + why + "). Team members get the narrowest limits until that is put right.");
      saidWhy = why;
      return null;
    }
  }
  /**
   * Sends the cut when the workspace does not hold the one the link has now, one at a time. It
   * carries no cut across a wait: after each wait it reads the team again, so a cut from before a
   * change is never sent after the one from after it. A workspace that cannot take the cut holds
   * none, and its members get the narrowest limits.
   */
  async function tell() {
    for (let tries = 0; tries < 4; tries++) {
      while (telling) await telling;
      const now = current();
      if (!now || deaf || held === now.rev) return;
      if (refused?.rev === now.rev && clock() < refused.until) return;
      telling = request("team", [now.cut, now.rev])
        .then(
          (rev) => {
            held = rev === now.rev ? rev : null;
            refused = null;
          },
          (error) => {
            held = null;
            if (/Unknown workspace action/.test(String(error?.message))) deaf = true;
            else {
              const times = refused?.rev === now.rev ? refused.times + 1 : 1;
              refused = { rev: now.rev, times, until: clock() + Math.min(60_000, 750 * 2 ** times) };
            }
          },
        )
        .finally(() => { telling = undefined; });
      await telling;
    }
  }
  /** One of the app's own three for Spaces. A workspace from before spaces is not asked again while it runs. */
  async function spaces(name, ...args) {
    if (noSpaces) throw new Error("This computer's app doesn't support that yet.");
    try {
      return await request("spaces", [name, ...args]);
    } catch (error) {
      if (/Unknown workspace action/.test(String(error?.message))) noSpaces = true;
      throw error;
    }
  }
  /** A member who left: what they made passes to the owner and what they set stops. Kept and said again until the workspace has heard it. */
  async function release(person) {
    toRelease.add(person);
    await spaces("release", person);
    toRelease.delete(person);
  }
  let snapshot = { bots: [], chats: [], runs: [], settings: {} };
  let revision = null;
  let available = false;
  // Set when the list of capabilities was dropped: the next look asks for a whole answer, so a
  // workspace that comes back with the same epoch still sends its list.
  let needList = false;
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
      await tell();
      // The revision is read after that wait, and the call follows it with no wait in between.
      const value = await request("call", [method, args, who, current()?.rev ?? null]);
      await refresh();
      return value;
    },
    // The app's own half of Spaces, for the link itself and never for a device (desktop/link/SPACES.md).
    spaces: {
      ensure: (person) => spaces("ensure", person),
      release,
      snapshot: (id, options) => spaces("snapshot", id, options),
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
        const next = await request("state", [needList ? null : revision, current()?.rev ?? null]);
        const newEpoch = String(next.version).split("/")[0] !== String(revision).split("/")[0];
        // A workspace that started again holds no cut, and says so here.
        if (newEpoch) {
          deaf = false;
          noSpaces = false;
          refused = null;
        }
        // What the workspace holds is what it said just now. The team may have changed during that
        // wait, so it is read again (in `tell`), never taken from before the wait.
        if (!telling) held = typeof next.team === "string" ? next.team : null;
        await tell();
        for (const person of [...toRelease]) await release(person).catch(() => {});
        const changed = revision !== next.version || available !== next.display;
        if (next.snapshot) {
          snapshot = next.snapshot;
          backend.capabilities = Array.isArray(next.capabilities) ? next.capabilities : [];
          needList = false;
        } else if (newEpoch) {
          // The list is a promise about the workspace's own code. This is another start of it, so the
          // old list is not told (it always sends a new one here; this is only for a reply that does not).
          backend.capabilities = [];
          needList = true;
        }
        revision = next.version;
        available = next.display === true;
        if (changed) changes.emit("change");
      } catch {
        // The workspace may come back from an older image, so what it promised before is not told
        // while it cannot be reached. Phones are told through the same change as the display.
        const hadList = backend.capabilities.length > 0;
        backend.capabilities = [];
        needList = true;
        if (available || hadList) {
          available = false;
          changes.emit("change");
        }
      }
    })().finally(() => { reading = undefined; });
    return reading;
  }
  return { backend, refresh, screenInput: (job) => request("input", [job]) };
}
