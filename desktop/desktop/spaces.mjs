// Spaces: named pages of panels, private or shared ("spaces-v1", docs/spaces.md).
//
// A space is a page on this computer that holds panels and cards. A person makes one and keeps
// it private or shares it. Today, Feed, Ideas and Goals are spaces too: every person has those
// four, and they cannot be renamed or deleted.
//
// What is kept here is the content: the records, which space a panel or a card is in, an app
// panel's saved state and its notes. Who may open a space is the phone link's to keep
// (`team.spaces` in its store) and to decide (`spaceCan` in link/team.mjs). This file asks it
// through `workspace.spaceCanOf`, and without a link knows only the rule that needs none: a
// space is its maker's, and the computer's owner can open every space on it.
//
// A person is "owner" or a member's id, as everywhere a team is involved (TEAMS.md).
import { randomBytes } from "node:crypto";
import { textField } from "./panels.mjs";

export const SPACES = "spaces-v1";
export const OWNER = "owner";
/** The four spaces every person has, with the kind of card each holds. */
export const BUILTIN = { today: { name: "Today" }, feed: { name: "Feed", kind: "feed" }, ideas: { name: "Ideas", kind: "idea" }, goals: { name: "Goals", kind: "goal" } };
export const LIMITS = { spaces: 60, panels: 40, notes: 50, note: 2000, state: 64 * 1024, keys: 200, label: 80 };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const newId = () => "s_" + [...randomBytes(10)].map((byte) => BASE32[byte % 32]).join("");
const makerOf = (space) => space.createdBy ?? OWNER;

function record(name, person, builtin, now = Date.now()) {
  return { id: newId(), name, ...(builtin && { builtin }), ...(person !== OWNER && { createdBy: person }), createdAt: now, updatedAt: now, rev: 1 };
}

/**
 * Brings a workspace from before spaces to one with them, and is safe to run at every start:
 * the owner has the four built-in spaces, every panel is in a space, and so is every card.
 * What was on the one Today page goes to the owner's: panels to Today, cards to Feed, Ideas or
 * Goals by their kind.
 */
export function migrateSpaces(state) {
  state.spaces = Array.isArray(state.spaces) ? state.spaces : [];
  const mine = (builtin) => {
    let space = state.spaces.find((item) => item.builtin === builtin && !item.createdBy);
    if (!space) state.spaces.push((space = record(BUILTIN[builtin].name, OWNER, builtin)));
    return space;
  };
  const builtins = Object.fromEntries(Object.keys(BUILTIN).map((builtin) => [builtin, mine(builtin)]));
  const known = new Set(state.spaces.map((space) => space.id));
  const ofKind = { feed: builtins.feed, idea: builtins.ideas, goal: builtins.goals };
  // A panel or a card whose space is gone goes to the owner's too: it is never left where nobody can find it.
  for (const panel of state.panels ?? []) if (!known.has(panel.spaceId)) panel.spaceId = builtins.today.id;
  for (const card of state.board ?? []) if (!known.has(card.spaceId)) card.spaceId = (ofKind[card.kind] ?? builtins.feed).id;
}

export class Spaces {
  constructor(workspace) {
    this.ws = workspace;
    migrateSpaces(workspace.state);
  }
  get all() {
    return this.ws.state.spaces;
  }
  get(id) {
    const space = this.all.find((item) => item.id === id);
    if (!space) throw new Error("This space no longer exists.");
    return space;
  }
  maker(space) {
    return makerOf(space);
  }
  /** The space a panel or a card is in. */
  of(item) {
    return this.get(item.spaceId);
  }
  panels(spaceId) {
    return this.ws.state.panels.filter((panel) => panel.spaceId === spaceId);
  }
  cards(spaceId) {
    return this.ws.state.board.filter((card) => card.spaceId === spaceId);
  }

  /**
   * A person's four built-in spaces, made when they are not there: { today, feed, ideas, goals },
   * each a record. Safe to repeat. The link asks for a member's the first time their device is
   * sent anything; a bot's work for a person lands in them.
   */
  ensure(person = OWNER) {
    let made = false;
    const out = {};
    for (const builtin of Object.keys(BUILTIN)) {
      out[builtin] = this.all.find((space) => space.builtin === builtin && makerOf(space) === person);
      if (out[builtin]) continue;
      this.all.push((out[builtin] = record(BUILTIN[builtin].name, person, builtin)));
      made = true;
    }
    if (made) this.ws.save();
    return out;
  }
  /** The built-in space of a person that holds cards of a kind ("feed", "idea", "goal"). */
  forCards(person, kind) {
    const builtin = Object.keys(BUILTIN).find((name) => BUILTIN[name].kind === kind) ?? "feed";
    return this.ensure(person)[builtin];
  }

  /** A new space, private until its maker shares it. Answers its id. */
  create({ name } = {}, person = OWNER) {
    if (this.all.filter((space) => makerOf(space) === person).length >= LIMITS.spaces) throw new Error("You have " + LIMITS.spaces + " spaces, which is the most a person has. Delete one first.");
    const space = record(textField(name, 40, "name"), person);
    this.all.push(space);
    this.ws.save();
    return space.id;
  }

  /** A change to a space or to anything in it: its time and its count go up. Does not save. */
  touch(spaceId, now = Date.now()) {
    const space = this.all.find((item) => item.id === spaceId);
    if (!space) return;
    space.updatedAt = now;
    space.rev = (space.rev ?? 0) + 1;
  }

  /**
   * What a person may do with a space: "own", "edit", "view" or null. The link decides
   * (`spaceCan`, with what it keeps about sharing). Without it, the rules that need no record of
   * sharing: the maker and the computer's owner own a space; the owner's four built-in spaces
   * are every member's to change, as the one Today page was before spaces and as the link shares
   * them when it first meets spaces; and any other space is there for nobody else.
   */
  can(space, person) {
    const told = this.ws.spaceCanOf?.(space, person);
    if (told !== undefined) return told;
    if (person === OWNER || makerOf(space) === person) return "own";
    return space.builtin && makerOf(space) === OWNER ? "edit" : null;
  }
  /** What several people may all do with a space: the least of what each may. A turn works for the chat's starter and for whoever wrote the message. */
  canAll(space, people) {
    const order = [null, "view", "edit", "own"];
    return people.map((person) => this.can(space, person)).reduce((least, can) => (order.indexOf(can) < order.indexOf(least) ? can : least), "own");
  }
  /** The spaces every one of these people can open. */
  open(people) {
    return this.all.filter((space) => this.canAll(space, people));
  }
  /** One of those spaces, by its id or its name (a bot names a space either way). Another person's built-in is found by id only. */
  find(reference, people) {
    const wanted = String(reference ?? "").trim();
    const open = this.open(people);
    const space = open.find((item) => item.id === wanted) ?? open.find((item) => item.name.toLowerCase() === wanted.toLowerCase() && (!item.builtin || people.includes(makerOf(item)))) ?? open.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
    // A space these people can't open is not there for them: the same words as for one that doesn't exist.
    if (!space) throw new Error("No space named " + JSON.stringify(wanted.slice(0, 60)) + ". Use space_list to see the spaces.");
    return space;
  }

  // ── What people do in an app panel: its saved state, and notes ───────────────────────────────

  /**
   * Merges top-level keys into a panel's saved state (null removes a key), so two people who
   * change different things do not undo each other. `by` is { id, name }: the person, for the
   * panel's last line. Answers { rev }.
   */
  patchState(panelId, patch, label, by) {
    const panel = this.ws.panels.get(panelId);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A panel's state is changed with an object of the keys to set.");
    const state = { ...(panel.state ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete state[key];
      else state[key] = value;
    }
    const now = Date.now();
    panel.state = checkedState(state);
    panel.stateRev = (panel.stateRev ?? 0) + 1;
    if (by) panel.last = { by: by.id, name: by.name, ...(label != null && String(label).trim() && { label: plain(label, LIMITS.label) }), at: now };
    this.touch(panel.spaceId, now);
    this.ws.save();
    return { rev: panel.stateRev };
  }
  /** A short note on a panel. Answers its id. */
  note(panelId, text, by) {
    const panel = this.ws.panels.get(panelId);
    const notes = (panel.notes ??= []);
    if (notes.length >= LIMITS.notes) throw new Error("This panel has " + LIMITS.notes + " notes. Remove one first.");
    const now = Date.now();
    const note = { id: newId().replace("s_", "n_"), by: by.id, name: by.name, text: textField(text, LIMITS.note, "note"), at: now };
    notes.push(note);
    panel.last = { by: by.id, name: by.name, label: "wrote a note", at: now };
    this.touch(panel.spaceId, now);
    this.ws.save();
    return note.id;
  }
  /** Removes a note. `mayRemoveAny` is for the space's maker and the computer's owner; anyone else removes their own. */
  removeNote(panelId, noteId, person, mayRemoveAny = false) {
    const panel = this.ws.panels.get(panelId);
    const note = panel.notes?.find((item) => item.id === noteId);
    if (!note) throw new Error("This note no longer exists.");
    if (!mayRemoveAny && note.by !== person) throw new Error("You can remove your own notes.");
    panel.notes = panel.notes.filter((item) => item !== note);
    this.touch(panel.spaceId);
    this.ws.save();
  }
}

/** A whole saved state, as a bot or the first write gives it: an object within the limits. */
export function checkedState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("A panel's state is an object.");
  if (Object.keys(state).length > LIMITS.keys) throw new Error("A panel's state holds at most " + LIMITS.keys + " keys.");
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > LIMITS.state) throw new Error("A panel's state is at most 64 KB.");
  return JSON.parse(json);
}

/** A page's own words, as one line of plain text. */
function plain(value, max) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}
