// Spaces on the link host ("spaces-v1"; docs/spaces.md). A space's content is the app's: this
// module keeps what is the link's, in the team (`store.data.team`): how each space is shared, each
// person's own view of the list (order, pins, last opened, "Notify me"), who is looking now, and a
// link's id and key. The rules themselves are pure functions in team.mjs (`spaceCan`, `spaceView`).
//
// Every method takes the person first: "owner", or a member's id. The link's calls
// (`link.spaces.*`) pass the caller; the app on the host passes "owner" for its own window.
import { createHash } from "node:crypto";
import { b64u, random } from "./crypto.mjs";
import { retiredCopy } from "./space-links.mjs";
import { hasAction, makerOf, OWNER, roleOfMember, SPACE_ACCESS, SPACE_LIMITS, spaceCan, spaceShare, spacesViewOf, spaceView } from "./team.mjs";
import { Failure } from "./tools.mjs";

const GONE = "This space no longer exists.";
const HERE_MS = 75_000;
const NOTIFY = ["off", "daily", "all"];
/** At most this many single items a person opened are remembered (`seenItems`); the oldest go first. */
const SEEN_ITEMS = 400;

/** A link's id: it belongs to the host's relay key and a salt, so nobody else can ever put a copy under it. */
export const shareIdOf = (relayPublicKey, salt) => b64u(createHash("sha256").update("botkins-space-id-v1:" + relayPublicKey + ":" + salt, "utf8").digest().subarray(0, 16));

export class Spaces {
  /**
   * @param records   () => the app's spaces (`SpaceRecord & { items }`), or null when the app has none
   * @param team      () => the team as stored
   * @param setTeam   (team) => saves it and tells every device
   * @param names     () => Map of person id → name
   * @param relay     () => { on, base, publicKey }: the relay in use, for links
   * `onShare(id)` and `leaving()` are set by the host once it has a publisher (space-links.mjs).
   * @param changed   () => the parts changed without the team changing (who is here)
   * @param app       the app's own half, host-side: `ensure(person)`, `release(person)`, `snapshot(id)`
   * @param demoLinks links are made without a relay (the demo computer): nothing is published
   */
  constructor({ records, team, setTeam, names, relay, changed, app, demoLinks = false }) {
    Object.assign(this, { records, team, setTeam, names, relay, changed, app, demoLinks });
    this.looking = new Map(); // person → { spaceId, panelId?, at }
    this.ensured = new Set();
    this.sweep = null;
  }
  /** Whether the app has spaces at all. Without them nothing here applies and today's Today page stays. */
  get on() {
    return Array.isArray(this.records());
  }
  record(id) {
    return typeof id === "string" ? (this.records() ?? []).find((space) => space?.id === id) : undefined;
  }
  role(person) {
    return person === OWNER ? null : roleOfMember(this.team(), person);
  }
  /** What goes with the app's list to make one person's view of it. */
  context(person) {
    return { role: this.role(person), names: this.names(), here: this.here(), linkOf: (share) => this.linkOf(share), leaving: this.leaving?.() };
  }
  /** The `spaces` part for one person: `SpaceSummary[]`. */
  for(person, { partOnly = false } = {}) {
    return this.on ? spaceView(this.team(), this.records(), person, { ...this.context(person), partOnly }) : [];
  }
  /** What a person may do with a space. `space` is its id, or the app's own record of it. */
  can(space, person) {
    return spaceCan(this.team(), typeof space === "string" ? this.record(space) : space, person);
  }
  /** The space, for someone who owns it; else it fails as the link's own check does. */
  owned(person, id) {
    const space = this.record(id);
    const can = spaceCan(this.team(), space, person);
    if (!can) throw new Failure(GONE);
    if (can !== "own") throw new Failure("Only the person who made this space can do that.");
    return space;
  }
  saveEntry(id, entry, more = {}) {
    const team = this.team();
    const spaces = { ...(team.spaces ?? {}) };
    if (entry) spaces[id] = entry;
    else delete spaces[id];
    this.setTeam({ ...team, spaces, ...more });
  }

  // ── Sharing ─────────────────────────────────────────────────────────────────────────────────

  /** A link's address, or null while links are off (the relay is off): the space keeps its level and has no link. */
  linkOf(share) {
    const { base, on } = this.relay();
    if (!on && !this.demoLinks) return null;
    let origin = "https://relay.botkins.app";
    try {
      origin = new URL(base).origin.replace(/^ws/, "http");
    } catch {
      // The default relay's address stands in for one that can't be read.
    }
    return origin + "/s/" + share.id + "#k=" + share.key;
  }
  newShare() {
    const salt = b64u(random(16));
    return { id: shareIdOf(this.relay().publicKey, salt), salt, key: b64u(random(32)), createdAt: Date.now() };
  }
  /** A link's copy that has to leave the relay: kept until the relay says it is gone (the publisher works through the list). */
  retired(team, share, spaceId) {
    return share ? [...(team.spaceCopies ?? []), retiredCopy(spaceId, share, this.relay().base)].slice(-500) : (team.spaceCopies ?? []);
  }
  share(person, id, input) {
    const space = this.owned(person, id);
    const team = this.team();
    const maker = makerOf(space);
    const access = input?.access;
    if (!SPACE_ACCESS.includes(access)) throw new Failure("Choose who can open this space.");
    const before = spaceShare(team, id);
    let grants = [];
    if (access === "members") {
      const people = this.names();
      const seen = new Set();
      for (const grant of Array.isArray(input.grants) ? input.grants : []) {
        if (typeof grant?.id !== "string" || seen.has(grant.id) || grant.id === maker) continue;
        if (!people.has(grant.id)) throw new Failure("That person is no longer on the team.");
        // A grant never widens a role: a member whose role can't see spaces can't be picked.
        if (grant.id !== OWNER && !hasAction(this.role(grant.id)?.perms, "today", "view")) throw new Failure("That person's role can't open spaces. Change their role in Team settings first.");
        seen.add(grant.id);
        grants.push({ id: grant.id, can: grant.can === "edit" ? "edit" : "view" });
      }
      if (grants.length > SPACE_LIMITS.grants) throw new Failure("A space can be shared with up to " + SPACE_LIMITS.grants + " people. Share it with all members instead.");
    }
    // A link shows a copy that nobody can change; members who open the space itself keep what they could do.
    const teamCan = access === "team" || access === "link" ? (input.teamCan === "edit" ? "edit" : input.teamCan === "view" ? "view" : before.teamCan) : "view";
    let share;
    if (access === "link") {
      if (!this.relay().on && !this.demoLinks) throw new Failure("Turn on the relay on your computer to share by link.");
      share = before.share ?? this.newShare();
    }
    const entry = access === "private" ? null : { access, grants, teamCan, ...(share && { share }) };
    // Going back to a narrower level takes the link's copy off the relay.
    this.saveEntry(id, entry, { spaceCopies: share ? (team.spaceCopies ?? []) : this.retired(team, before.share, id) });
    this.onShare?.(id);
    return share ? { link: this.linkOf(share) } : {};
  }
  /** A fresh link for a space that is shared by link. The old copy leaves the relay. */
  newLink(person, id) {
    this.owned(person, id);
    const team = this.team();
    const before = spaceShare(team, id);
    if (before.access !== "link") throw new Failure("This space isn't shared by link.");
    if (!this.relay().on && !this.demoLinks) throw new Failure("Turn on the relay on your computer to share by link.");
    const share = this.newShare();
    this.saveEntry(id, { access: "link", grants: [], teamCan: before.teamCan, share }, { spaceCopies: this.retired(team, before.share, id) });
    this.onShare?.(id);
    return { link: this.linkOf(share) };
  }
  /** A space was deleted: its sharing goes, and its link's copy leaves the relay. */
  removed(id) {
    const team = this.team();
    if (!team.spaces || !Object.hasOwn(team.spaces, id)) return;
    // The space is gone, so the copy is of none: nothing shows "Taking the link back…" for it.
    this.saveEntry(id, null, { spaceCopies: this.retired(team, spaceShare(team, id).share) });
    this.onShare?.(id);
  }
  /** Owner only: whether members may share by link. */
  setLinkSharing(on) {
    this.setTeam({ ...this.team(), linkSharing: on === true });
    return on === true;
  }

  // ── Each person's own view of the list ──────────────────────────────────────────────────────

  saveView(person, patch) {
    const team = this.team();
    const mine = team.views?.[person] ?? {};
    const spaces = { ...spacesViewOf(team, person), ...patch };
    // A person who never pinned anything keeps the starting row until they do.
    if (spaces.pinned === null) delete spaces.pinned;
    this.setTeam({ ...team, views: { ...(team.views ?? {}), [person]: { ...mine, spaces } } });
  }
  /** The caller's own order and pins. Ids they cannot open are dropped. */
  arrange(person, input) {
    const opens = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string"))].filter((id) => this.can(id, person)).slice(0, 2 * SPACE_LIMITS.spaces);
    this.saveView(person, { order: opens(input?.order), pinned: opens(input?.pinned) });
    return null;
  }
  /**
   * The caller has seen this space now, or with `itemId` only that panel or card of it (they
   * opened it). Seeing the whole space forgets its items' own marks, which it covers.
   */
  seen(person, id, itemId) {
    if (!this.can(id, person)) throw new Failure(GONE);
    const view = spacesViewOf(this.team(), person);
    const now = Date.now();
    const items = (this.record(id)?.items ?? []).map((item) => item?.id).filter((one) => typeof one === "string");
    if (itemId != null) {
      if (typeof itemId !== "string" || !items.includes(itemId)) return null;
      // The newest marks are kept: a person's marks never grow past what a few spaces hold.
      const kept = Object.entries({ ...view.seenItems, [itemId]: now }).sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0)).slice(0, SEEN_ITEMS);
      this.saveView(person, { seenItems: Object.fromEntries(kept) });
      return null;
    }
    const seenItems = Object.fromEntries(Object.entries(view.seenItems).filter(([one]) => !items.includes(one)));
    this.saveView(person, { seen: { ...view.seen, [id]: now }, seenItems });
    return null;
  }
  notify(person, id, mode) {
    if (!this.can(id, person)) throw new Failure(GONE);
    if (!NOTIFY.includes(mode)) throw new Failure("Choose Off, Once a day or Every change.");
    this.saveView(person, { notify: { ...spacesViewOf(this.team(), person).notify, [id]: mode } });
    return null;
  }

  // ── Who is looking now (kept in memory only) ────────────────────────────────────────────────

  /** The caller is looking at this space (and this panel) now, or at none (`null`). Forgotten after 75 seconds of silence. */
  lookingAt(person, id, panelId) {
    const before = this.looking.get(person);
    if (id == null) {
      if (this.looking.delete(person)) this.changed();
      return null;
    }
    if (!this.can(id, person)) throw new Failure(GONE);
    const panel = typeof panelId === "string" && panelId.length <= 200 ? panelId : undefined;
    this.looking.set(person, { spaceId: id, ...(panel && { panelId: panel }), at: Date.now() });
    if (before?.spaceId !== id || before?.panelId !== panel) this.changed();
    clearTimeout(this.sweep);
    this.sweep = setTimeout(() => this.forget(), HERE_MS + 1000);
    this.sweep.unref?.();
    return null;
  }
  forget() {
    const now = Date.now();
    let gone = false;
    for (const [person, entry] of this.looking) if (now - entry.at > HERE_MS) gone = this.looking.delete(person) || gone;
    if (gone) this.changed();
    if (this.looking.size) {
      this.sweep = setTimeout(() => this.forget(), HERE_MS / 2);
      this.sweep.unref?.();
    }
  }
  /** Space id → the people looking at it now. */
  here() {
    const now = Date.now();
    const bySpace = new Map();
    for (const [person, entry] of this.looking) {
      if (now - entry.at > HERE_MS) continue;
      bySpace.set(entry.spaceId, [...(bySpace.get(entry.spaceId) ?? []), { id: person, ...(entry.panelId && { panelId: entry.panelId }) }]);
    }
    return bySpace;
  }

  // ── The app's half, host-side ───────────────────────────────────────────────────────────────

  /** A person's four built-in spaces, asked of the app the first time their device is sent parts. Safe to repeat. */
  async ensure(person) {
    if (!this.on || this.ensured.has(person) || typeof this.app()?.ensure !== "function") return;
    if (person !== OWNER && !hasAction(this.role(person)?.perms, "today", "view")) return;
    this.ensured.add(person);
    try {
      await this.app().ensure(person);
    } catch {
      this.ensured.delete(person);
    }
  }
  /**
   * The first time an app with spaces is seen: the owner's four built-in spaces are shared with all
   * members when the team has one, so no member loses what their role shows them now.
   */
  moveOnce() {
    const team = this.team();
    if (!this.on || team.spacesMoved) return;
    const spaces = { ...(team.spaces ?? {}) };
    if ((team.members ?? []).length) {
      for (const space of this.records()) if (space.builtin && makerOf(space) === OWNER && !spaces[space.id]) spaces[space.id] = { access: "team", grants: [], teamCan: "edit" };
    }
    this.setTeam({ ...team, spaces, spacesMoved: true });
  }
  /**
   * A member was removed: the team without their grants and without the sharing of the spaces they
   * made (those pass to the owner and become private), their link copies queued to leave the relay.
   */
  withoutMember(team, memberId) {
    const mine = new Set((this.records() ?? []).filter((space) => space.createdBy === memberId).map((space) => space.id));
    let copies = team.spaceCopies ?? [];
    const spaces = {};
    for (const [id, entry] of Object.entries(team.spaces ?? {})) {
      if (mine.has(id)) {
        if (entry?.share) copies = [...copies, retiredCopy(id, entry.share, this.relay().base)];
        continue;
      }
      spaces[id] = Array.isArray(entry?.grants) ? { ...entry, grants: entry.grants.filter((grant) => grant.id !== memberId) } : entry;
    }
    this.looking.delete(memberId);
    this.ensured.delete(memberId);
    // The app drops `createdBy` from what they made and pauses the routines they set.
    Promise.resolve(this.app()?.release?.(memberId)).catch(() => {});
    return { ...team, spaces, spaceCopies: copies };
  }
  dispose() {
    clearTimeout(this.sweep);
  }
}
