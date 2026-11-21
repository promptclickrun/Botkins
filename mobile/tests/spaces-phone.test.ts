// Spaces on the phone: the words and the order of its screens (src/features/spaces/logic.ts). The
// words are the contract's "Words on screen" (docs/spaces.md), final for both apps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLine, changedSince, holds, initials, lastLine, linkNote, names, panelRows, pickRows, rowLine, shareChoices, since, spaceSections, spaceTitle, whoCanOpen, withMove, withPick, withPin } from "../src/features/spaces/logic";
import type { SpaceSummary } from "../src/link/types";

const space = (more: Partial<SpaceSummary> = {}): SpaceSummary => ({ id: "s", name: "Launch", by: { id: "owner", name: "Alex Kim" }, mine: true, access: "private", can: "own", count: 5, changed: 0, pinned: false, notify: "daily", here: [], rev: 1, updatedAt: 1, ...more });
const maya = { id: "m1", name: "Maya Chen" };
const dev = { id: "m2", name: "Dev Patel" };

test("a space's name, who can open it and what it holds", () => {
  assert.equal(spaceTitle(space()), "Launch");
  assert.equal(spaceTitle(space({ name: "Today", builtin: "today" })), "Today");
  assert.equal(spaceTitle(space({ name: "Today", builtin: "today", mine: false, by: maya })), "Maya's Today");
  assert.equal(spaceTitle(space({ name: "Trip", mine: false, by: maya })), "Trip", "only a built-in one says whose it is");

  assert.equal(whoCanOpen(space()), "Only you");
  assert.equal(whoCanOpen(space({ mine: false, by: maya })), "Only Maya");
  assert.equal(whoCanOpen(space({ access: "members", people: [{ ...maya, can: "edit" }, { ...dev, can: "view" }] })), "Maya and Dev");
  assert.equal(names(["Maya Chen", "Dev Patel", "Sam Ortiz", "Ana Ruiz"]), "Maya, Dev and 2 more");
  assert.equal(names(["Maya Chen"]), "Maya");
  assert.equal(whoCanOpen(space({ access: "members", people: [] })), "Only you", "nobody picked yet");
  assert.equal(whoCanOpen(space({ access: "team" })), "All members");
  assert.equal(whoCanOpen(space({ access: "link" })), "Anyone with the link");

  assert.equal(holds(space({ count: 4 })), "4 panels");
  assert.equal(holds(space({ count: 1 })), "1 panel");
  assert.equal(holds(space({ builtin: "feed", count: 7, changed: 3 })), "3 new");
  assert.equal(holds(space({ builtin: "feed", count: 1, changed: 0 })), "1 item");
  assert.equal(holds(space({ builtin: "ideas", count: 2 })), "2 ideas");
  assert.equal(holds(space({ builtin: "goals", count: 1 })), "1 goal");
  assert.equal(rowLine(space({ access: "link", count: 9 })), "9 panels · Anyone with the link");
});

test("what changed since the person last looked", () => {
  const now = new Date(2026, 10, 20, 15, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
  assert.equal(since(at(20, 9), now), "this morning");
  assert.equal(since(at(20, 13), now), "earlier today");
  assert.equal(since(at(19, 22), now), "yesterday");
  assert.equal(since(at(17, 10), now), new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(at(17, 10)));
  assert.equal(since(at(2, 10), now), new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at(2, 10)));
  const panels = [{ id: "a", updatedAt: at(20, 10), hidden: false }, { id: "b", updatedAt: at(20, 11), hidden: false }, { id: "c", updatedAt: at(18, 1), hidden: false }, { id: "d", updatedAt: at(20, 12), hidden: true }];
  assert.equal(changedLine(panels, at(20, 9), now), "2 panels changed since this morning");
  assert.equal(changedLine(panels.slice(0, 1), at(19, 9), now), "1 panel changed since yesterday");
  assert.equal(changedLine(panels, at(20, 14), now), undefined, "nothing changed");
  assert.equal(changedLine(panels, 0, now), undefined, "a space never opened has no line");
  assert.deepEqual([...changedSince(panels, at(20, 9))], ["a", "b", "d"]);
  assert.equal(changedSince(panels, 0).size, 0);
  // A person's own tick or note is not news to them; someone else's is.
  const ticked = [{ id: "a", updatedAt: at(20, 10), hidden: false, last: { by: "owner", name: "Alex", at: at(20, 10) } }, { id: "b", updatedAt: at(20, 11), hidden: false, last: { by: "m1", name: "Maya", at: at(20, 11) } }];
  assert.deepEqual([...changedSince(ticked, at(20, 9), "owner")], ["b"]);
  assert.equal(changedLine(ticked, at(20, 9), now, "owner"), "1 panel changed since this morning");
  assert.deepEqual([...changedSince(ticked, at(20, 9), "m1")], ["a"]);
  // A bot's refresh after the person's own tick is news again.
  assert.deepEqual([...changedSince([{ ...ticked[0]!, updatedAt: at(20, 12) }], at(20, 9), "owner")], ["a"]);
});

test("all spaces: pinned, more, and for the owner with Admin mode on what members made", () => {
  const list = [space({ id: "today", pinned: true }), space({ id: "launch", pinned: true }), space({ id: "money" }), space({ id: "hers", mine: false, by: maya }), space({ id: "shared", mine: false, by: maya, access: "team" })];
  const keys = (sections: ReturnType<typeof spaceSections>) => sections.map((section) => [section.title, section.spaces.map((one) => one.id)]);
  assert.deepEqual(keys(spaceSections(list, { owner: true, admin: true })), [["Pinned", ["today", "launch"]], ["More", ["money", "shared"]], ["From members", ["hers"]]]);
  // With Admin mode off the owner is sent only what they are part of: no third section.
  assert.deepEqual(keys(spaceSections(list.filter((one) => one.id !== "hers"), { owner: true, admin: false })), [["Pinned", ["today", "launch"]], ["More", ["money", "shared"]]]);
  // A member never has it.
  assert.deepEqual(keys(spaceSections(list, { owner: false, admin: false })).map(([title]) => title), ["Pinned", "More"]);
  assert.deepEqual(spaceSections([], { owner: true, admin: true }), []);

  // Pinning keeps the pins' order and puts a new one last; unpinning takes it out.
  assert.deepEqual(withPin(list, "money", true), { order: ["today", "launch", "money", "hers", "shared"], pinned: ["today", "launch", "money"] });
  assert.deepEqual(withPin(list, "today", false).pinned, ["launch"]);
  // Move up and down stay within the pinned or the others.
  assert.deepEqual(withMove(list, "launch", -1), { order: ["launch", "today", "money", "hers", "shared"], pinned: ["launch", "today"] });
  assert.equal(withMove(list, "today", -1), null);
  assert.equal(withMove(list, "launch", 1), null, "the last pin does not cross into the others");
  assert.deepEqual(withMove(list, "money", 1)!.order, ["today", "launch", "hers", "money", "shared"]);
  assert.equal(withMove(list, "nope", 1), null);
});

test("the Share sheet: four choices with their lines, who can be picked, and what a pick sends", () => {
  const team = { people: [{ id: "owner", name: "Alex Kim" }, maya, dev], computer: "Studio Mac", linkSharing: false, relay: true };
  const picked = space({ access: "members", people: [{ ...maya, can: "edit" }, { ...dev, can: "view" }] });
  assert.deepEqual(shareChoices(picked, team, { member: false, manage: true }), [
    { access: "private", title: "Only you", line: "Private" },
    { access: "members", title: "Members you pick", line: "Maya Chen, Dev Patel" },
    { access: "team", title: "All members", line: "3 people on Studio Mac" },
    { access: "link", title: "Anyone with the link", line: "They can look, not change" },
  ]);
  // A member's private space is open to the owner too, and a link needs the owner's switch and the member's role.
  const asMember = shareChoices(space(), team, { member: true, manage: true });
  assert.equal(asMember[0]!.line, "The owner can open it too");
  assert.equal(asMember[1]!.line, "Pick who can open it");
  assert.equal(asMember[3]!.disabled, "The owner hasn't turned on sharing by link for members.");
  assert.equal(shareChoices(space(), { ...team, linkSharing: true }, { member: true, manage: false })[3]!.disabled, "Your team role can't share by link.");
  assert.equal(shareChoices(space(), { ...team, linkSharing: true }, { member: true, manage: true })[3]!.disabled, undefined);
  assert.equal(shareChoices(space(), { ...team, relay: false }, { member: false, manage: true })[3]!.disabled, "Turn on the relay on your computer to share by link.");
  const many = space({ access: "members", people: [maya, dev, { id: "m3", name: "Sam Ortiz" }, { id: "m4", name: "Ana Ruiz" }].map((person) => ({ ...person, can: "view" as const })) });
  assert.equal(shareChoices(many, team, { member: false, manage: true })[1]!.line, "4 picked");

  // The people to pick from: everyone but the maker (and this phone's own person).
  assert.deepEqual(pickRows(team.people, picked, "owner"), [{ id: "m1", name: "Maya Chen", initials: "MC", can: "edit" }, { id: "m2", name: "Dev Patel", initials: "DP", can: "view" }]);
  assert.deepEqual(pickRows(team.people, space({ by: maya, mine: true }), "m1").map((row) => row.id), ["owner", "m2"], "a member may pick the owner");
  assert.equal(initials("sam"), "S");
  assert.equal(initials("  "), "?");
  // A pick sends the whole list of picked people.
  assert.deepEqual(withPick(picked, "m2", "edit"), { access: "members", grants: [{ id: "m1", can: "edit" }, { id: "m2", can: "edit" }] });
  assert.deepEqual(withPick(picked, "m1", null), { access: "members", grants: [{ id: "m2", can: "view" }] });
  assert.deepEqual(withPick(space(), "m1", "view"), { access: "members", grants: [{ id: "m1", can: "view" }] });

  assert.equal(linkNote(space({ linkState: "leaving" })), "Taking the link back…");
  assert.equal(linkNote(space({ linkState: "off" })), "Links are off while the relay is off.");
  assert.equal(linkNote(space()), undefined);
});

test("a panel's last line, and panels laid out for a phone", () => {
  const ago = () => "2m";
  assert.equal(lastLine({ by: "m1", name: "Maya Chen", label: "Ticked Press kit", at: 1 }, ago), "Maya ticked Press kit · 2m");
  assert.equal(lastLine({ by: "m1", name: "Maya Chen", at: 1 }, ago), "Maya changed this · 2m");
  assert.equal(lastLine(undefined, ago), undefined);
  // Small panels sit two up; a wide or tall one has a row of its own.
  const sizes = (list: ("small" | "wide" | "tall")[]) => panelRows(list.map((size) => ({ size }))).map((row) => row.map((panel) => panel.size));
  assert.deepEqual(sizes(["small", "small", "tall", "small", "wide", "small", "small", "small"]), [["small", "small"], ["tall"], ["small"], ["wide"], ["small", "small"], ["small"]]);
  assert.deepEqual(sizes([]), []);
});
