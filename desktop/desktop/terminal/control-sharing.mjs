// Sharing a space: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<word>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// What the Share sheet of the window does: who can open a space (only its maker, people that the maker picks, all
// members, or anyone who has a link), a person's own order and pins, and their "Notify me" for a space. The phone
// link keeps all of it (desktop/link/spaces.mjs). The app's calls for it are `link.spaces.*` and `link.team.setLinkSharing`
// (desktop/runtime.mjs); they act as the owner. The list of spaces is read from the window's snapshot (`spaces`, the
// owner's view of every space).
//
// Three of the calls make a space visible to more people, so each takes the caller's word that the person was shown
// what it opens, and to whom (`agreed: true`; on the command line `--yes`): a link that anyone can open, a space shared with
// all members, and the team's switch that lets members make such links. A link is a secret that is made to be handed on:
//  - Only `sharing.link` answers with one. No other call, and no line of the log, has it.
//  - `sharing.list` and `sharing.get` say that a space has a link, and never give it. The owner's window gets the link
//    in the app's own answer, but a list of spaces is no place for a secret.
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const iso = (time) => (time ? new Date(time).toISOString() : null);
const shortList = (entries, label) => entries.slice(0, 5).map((entry) => label(entry) + " (" + entry.id + ")").join(", ") + (entries.length > 5 ? " and " + (entries.length - 5) + " more" : "");
/** One of a list by its id, or by its name: the exact name first, then the start of a name, then the start of an id (6 characters at least). */
function pick(list, ref, what, see) {
  const wanted = text(ref, 200, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  for (const match of [(entry) => String(entry.name ?? "").toLowerCase() === lower, (entry) => String(entry.name ?? "").toLowerCase().startsWith(lower), (entry) => wanted.length >= 6 && entry.id.startsWith(wanted)]) {
    const found = list.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new ControlError("More than one " + what + " matches " + wanted + ": " + shortList(found, (entry) => entry.name) + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  }
  throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
}
const oneOf = (list, value, what) => {
  if (!list.includes(value)) throw new ControlError(what + " is one of " + list.join(", ") + ".", "BAD_ARGUMENT");
  return value;
};
const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

const NEEDS_YES = (what) => new ControlError(what + " needs a yes: it makes the space visible to more people. Show the person who can open the space, and give `agreed: true` (on the command line, `--yes`).", "NEEDS_YES");

/**
 * @param handlers   `runtime.handlers`.
 */
export function sharingApi({ handlers }) {
  /** The owner's view of the app's spaces and of the people on the team, from the window's snapshot. */
  const held = () => {
    let snapshot;
    try {
      snapshot = handlers.snapshot();
    } catch {
      snapshot = null;
    }
    if (!Array.isArray(snapshot?.spaces)) throw new ControlError("Spaces are kept by the phone link, and it is not ready on this computer yet (it is still opening, or it is too old). Try again in a moment.", "UNSUPPORTED");
    return { spaces: snapshot.spaces, people: Array.isArray(snapshot.team?.people) ? snapshot.team.people : [] };
  };
  const space = (ref) => pick(held().spaces, ref, "space", "botkins sharing list");
  const person = (ref) => pick(held().people, ref, "person", "botkins team people");
  /** A space as the command line shows it. It has no link: only whether there is one. */
  const view = (s) => ({
    id: s.id,
    name: s.name,
    ...(s.builtin && { builtin: s.builtin }),
    by: { id: s.by?.id ?? "owner", name: s.by?.name ?? "" },
    mine: s.mine === true,
    access: s.access,
    ...(s.access === "members" && { people: (s.people ?? []).map((one) => ({ id: one.id, name: one.name, can: one.can })) }),
    ...((s.access === "team" || s.access === "link") && { teamCan: s.teamCan ?? "view" }),
    ...(s.linkState && { linkState: s.linkState }),
    pinned: s.pinned === true,
    notify: s.notify,
    here: (s.here ?? []).map((one) => ({ id: one.id, name: one.name })),
    panels: s.count ?? 0,
    changed: s.changed ?? 0,
    updatedAt: iso(s.updatedAt),
  });
  const named = (s) => ({ id: s.id, name: s.name });
  const fresh = (id) => view(space(id));

  return {
    // ── Reads ──
    /** The owner's spaces, in the owner's order (pinned first). Every space of the host, the members' too. */
    "sharing.list": () => held().spaces.map(view),
    "sharing.get": ([ref]) => view(space(ref)),

    // ── Who can open a space ──
    /**
     * `options`: { access: "private" | "members" | "team", people?: [{ person, can }…], can?, agreed? }.
     * "members" is the people named (`people`, each with `can: "view" | "edit"`). "team" is every member, and `can` is what they may
     * do; it needs `agreed: true`. A link is made by `sharing.link`. The answer is the space as it is now.
     * A space that was shared by link and is shared at a narrower level now has its link taken away.
     */
    async "sharing.set"([ref, options]) {
      const found = space(ref);
      const o = plain(options);
      const access = oneOf(["private", "members", "team"], o.access, "A level (a link is made with `sharing link`)");
      const input = { access };
      if (access === "members") {
        if (!Array.isArray(o.people) || !o.people.length) throw new ControlError("Name the people who can open the space.", "BAD_ARGUMENT");
        const grants = new Map();
        for (const one of o.people) {
          const who = person(plain(one).person);
          if (who.id === found.by?.id) throw new ControlError(who.name + " made this space, so they can open it already.", "BAD_ARGUMENT");
          if (grants.has(who.id)) throw new ControlError(who.name + " is named twice.", "BAD_ARGUMENT");
          grants.set(who.id, { id: who.id, can: oneOf(["view", "edit"], plain(one).can ?? "view", "What a person can do") });
        }
        input.grants = [...grants.values()];
        if (o.can !== undefined) throw new ControlError("For the level members, give `can` with each person, not once for all.", "BAD_ARGUMENT");
      } else {
        if (o.people !== undefined) throw new ControlError("People are named for the level members only.", "BAD_ARGUMENT");
        if (access === "team") {
          if (o.can !== undefined) input.teamCan = oneOf(["view", "edit"], o.can, "What all members can do");
          if (o.agreed !== true) throw NEEDS_YES("Sharing a space with all members");
        } else if (o.can !== undefined) throw new ControlError("`can` is for the level team only.", "BAD_ARGUMENT");
      }
      await handlers["link.spaces.share"](found.id, input);
      return fresh(found.id);
    },
    /**
     * A link that anyone can open, for a space: it makes the space shared by link when it is not, and answers with the link.
     * `options`: { new?: true, agreed? }. A space that is shared by link already answers with the link it has (`made: false`), and
     * changes nothing; with `new: true` it gets another link, and the old one stops working. Making a link, and a new one, need
     * `agreed: true`. The answer is `{ id, name, link, made, new }`: the only call that gives a link.
     */
    async "sharing.link"([ref, options]) {
      const found = space(ref);
      const o = plain(options);
      const make = found.access !== "link";
      const another = !make && o.new === true;
      if ((make || another) && o.agreed !== true) throw NEEDS_YES(make ? "A link" : "A new link");
      let link;
      if (make) link = (await handlers["link.spaces.share"](found.id, { access: "link" }))?.link;
      else if (another) link = (await handlers["link.spaces.newLink"](found.id))?.link;
      else link = found.link;
      if (typeof link !== "string" || !link) throw new ControlError("This space has no link now: links are off while the relay is off. Turn it on with `botkins relay on`.", "LINK_OFF");
      return { ...named(found), link, made: make, new: another };
    },
    /** The team's switch "Members may share by link". Turning it on needs `agreed: true`. Turning it off leaves the links that exist. */
    async "sharing.setLinks"([on, options]) {
      if (typeof on !== "boolean") throw new ControlError("Give on or off.", "BAD_ARGUMENT");
      if (on && plain(options).agreed !== true) throw NEEDS_YES("Letting members share by link");
      return { on: (await handlers["link.team.setLinkSharing"](on)) === true };
    },

    // ── The owner's own view of the list ──
    /** The spaces named come first, in that order; the others follow in their order. The pins stay, and follow the new order. */
    async "sharing.order"([refs]) {
      if (!Array.isArray(refs) || !refs.length) throw new ControlError("Give the spaces in the order you want.", "BAD_ARGUMENT");
      const all = held().spaces;
      const first = refs.map((ref) => pick(all, ref, "space", "botkins sharing list").id);
      if (new Set(first).size !== first.length) throw new ControlError("A space is named twice.", "BAD_ARGUMENT");
      const order = [...first, ...all.map((entry) => entry.id).filter((id) => !first.includes(id))];
      const pinned = new Set(all.filter((entry) => entry.pinned).map((entry) => entry.id));
      await handlers["link.spaces.arrange"]({ order, pinned: order.filter((id) => pinned.has(id)) });
      return held().spaces.map(view);
    },
    /** Pins a space (at the end of the pinned ones) or takes its pin away. */
    async "sharing.pin"([ref, on]) {
      if (typeof on !== "boolean") throw new ControlError("Give pin or unpin.", "BAD_ARGUMENT");
      const found = space(ref);
      const all = held().spaces;
      const pinned = all.filter((entry) => entry.pinned && entry.id !== found.id).map((entry) => entry.id);
      await handlers["link.spaces.arrange"]({ order: all.map((entry) => entry.id), pinned: on ? [...pinned, found.id] : pinned });
      return fresh(found.id);
    },
    /** The owner's "Notify me" for a space: "off", "daily" (once a day) or "all" (every change). */
    async "sharing.notify"([ref, mode]) {
      const found = space(ref);
      await handlers["link.spaces.notify"](found.id, oneOf(["off", "daily", "all"], mode, "A choice"));
      return fresh(found.id);
    },
  };
}
