// Spaces on the phone: the words and the order of its screens (src/features/spaces/logic.ts). The
// words are the contract's "Words on screen" (docs/spaces.md), final for both apps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyArrangement, asksOf, changedLine, changedSince, holds, initials, lastLine, linkNote, names, panelProject, panelRows, pickRows, spaceDropPlan, spaceItems, rowLine, shareChoices, since, spaceSections, spaceTitle, whoCanOpen, withMove, withPick, withPin } from "../src/features/spaces/logic";
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

test("a panel's asks are its bot's own words, and a new panel's project starts on its space's", () => {
  // At most three, each on one line and at most 60 characters; anything that is not text is dropped.
  assert.deepEqual(asksOf({ asks: ["  Add a team   discount ", "", 7, "Compare with\nlast quarter", "x".repeat(80), "a fourth"] }), ["Add a team discount", "Compare with last quarter", "x".repeat(60)]);
  // Never made up: a panel without asks has no chips.
  assert.deepEqual(asksOf({}), []);
  assert.deepEqual(asksOf({ asks: [] }), []);
  assert.deepEqual(asksOf({ asks: "Add a column" }), []);
  assert.deepEqual(asksOf(undefined), []);

  const projects = [{ id: "p1" }, { id: "p2" }];
  // Until the person picks, the row follows the space's own project; "None" (null) stays None.
  assert.equal(panelProject(undefined, { projectId: "p1" }, projects), "p1");
  assert.equal(panelProject(undefined, {}, projects), undefined);
  assert.equal(panelProject("p2", { projectId: "p1" }, projects), "p2");
  assert.equal(panelProject(null, { projectId: "p1" }, projects), undefined);
  // A project that is gone is none.
  assert.equal(panelProject(undefined, { projectId: "gone" }, projects), undefined);
  assert.equal(panelProject("p1", {}, undefined), undefined);
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

test("dragging a space: the list, where a drop lands, and the list shown at once", () => {
  const owner = { owner: true, admin: true };
  const list = [
    space({ id: "today", pinned: true }),
    space({ id: "feed", pinned: true }),
    space({ id: "launch" }),
    space({ id: "theirs", mine: false, by: { id: "m1", name: "Maya" } }),
    space({ id: "money" }),
  ];
  const keys = (items: { key: string }[]) => items.map((item) => item.key);
  // Pinned, More, then what members made: fixed, so nothing is dropped among those.
  const items = spaceItems(list, owner, false);
  assert.deepEqual(keys(items), ["head:pinned", "space:today", "space:feed", "head:more", "space:launch", "space:money", "head:theirs", "space:theirs"]);
  assert.deepEqual(items.filter((item) => item.kind === "fixed").map((item) => item.key), ["head:theirs", "space:theirs"]);
  // With nothing pinned the heading shows only while a space is dragged, as a place to drop one.
  const none = list.map((one) => ({ ...one, pinned: false }));
  assert.deepEqual(keys(spaceItems(none, owner, false)).slice(0, 2), ["head:more", "space:today"]);
  assert.deepEqual(keys(spaceItems(none, owner, true)).slice(0, 2), ["head:pinned", "head:more"]);

  // Within Pinned: the row on Home takes that order.
  assert.deepEqual(spaceDropPlan(list, owner, "feed", "pinned", 0), { order: ["feed", "today", "launch", "theirs", "money"], pinned: ["feed", "today"] });
  assert.equal(spaceDropPlan(list, owner, "feed", "pinned", 1), undefined, "dropped where it was");
  // Into Pinned from More: pinned, at that place.
  assert.deepEqual(spaceDropPlan(list, owner, "money", "pinned", 1), { order: ["today", "money", "feed", "launch", "theirs"], pinned: ["today", "money", "feed"] });
  // Out of Pinned: unpinned, among More at that place. What members made keeps its place.
  assert.deepEqual(spaceDropPlan(list, owner, "today", "more", 1), { order: ["feed", "launch", "theirs", "today", "money"], pinned: ["feed"] });
  assert.deepEqual(spaceDropPlan(list, owner, "today", "more", 2), { order: ["feed", "launch", "theirs", "money", "today"], pinned: ["feed"] });
  // Within More.
  assert.deepEqual(spaceDropPlan(list, owner, "money", "more", 0), { order: ["today", "feed", "money", "launch", "theirs"], pinned: ["today", "feed"] });
  assert.equal(spaceDropPlan(list, owner, "launch", "more", 0), undefined);
  assert.equal(spaceDropPlan(list, owner, "gone", "more", 0), undefined);
  // An index past the end is the end.
  assert.deepEqual(spaceDropPlan(list, owner, "launch", "pinned", 9)?.pinned, ["today", "feed", "launch"]);

  // Shown at once: the order and the pins of the plan; a space the plan does not name stays, last.
  const plan = spaceDropPlan(list, owner, "money", "pinned", 1)!;
  const now = applyArrangement([...list, space({ id: "new" })], plan);
  assert.deepEqual(now.map((one) => one.id + (one.pinned ? "*" : "")), ["today*", "money*", "feed*", "launch", "theirs", "new"]);
});
