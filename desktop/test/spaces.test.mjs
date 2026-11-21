// The pure parts of Spaces in the window (src/spaces.ts): when the computer has them, names, tags,
// lines and the lists of All spaces. Names here are invented.
import test from "node:test";
import assert from "node:assert/strict";
import {
  accessTag,
  ago,
  arrangePin,
  askBot,
  changedLine,
  deleteQuestion,
  hasSpaces,
  lastLine,
  panelChanged,
  seenWords,
  spaceIcon,
  spaceLine,
  spaceName,
  spaceSections,
  spaceWhen,
} from "../src/spaces.ts";

const maya = { id: "m1", name: "Maya Chen" };
const dev = { id: "m2", name: "Dev Patel" };
const me = { id: "owner", name: "Studio Mac" };
const space = (over = {}) => ({
  id: "s_1", name: "Launch", by: me, mine: true, access: "private", can: "own", count: 5, changed: 0,
  pinned: true, notify: "daily", here: [], rev: 1, updatedAt: 0, ...over,
});
// A Friday afternoon, in the local time zone.
const now = new Date(2026, 10, 20, 15, 30).getTime();
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

test("a computer has Spaces when its snapshot carries them, or the computer in use names spaces-v1", () => {
  assert.equal(hasSpaces({ spaces: [] }), true);
  assert.equal(hasSpaces({}), false);
  const using = (capabilities) => ({ remote: { using: { capabilities }, hosts: [] } });
  assert.equal(hasSpaces(using(["team-people-v1", "spaces-v1"])), true);
  assert.equal(hasSpaces(using(["team-people-v1"])), false);
  assert.equal(hasSpaces({ ...using([]), spaces: [] }), false, "the computer in use decides, not a stale part");
});

test("a space's name, and another person's built-in named with its maker", () => {
  assert.equal(spaceName(space()), "Launch");
  assert.equal(spaceName(space({ name: "Today", builtin: "today" })), "Today");
  assert.equal(spaceName(space({ name: "Today", builtin: "today", mine: false, by: maya })), "Maya's Today");
  assert.equal(spaceName(space({ mine: false, by: maya })), "Launch");
});

test("who can open it, in the contract's words", () => {
  assert.equal(accessTag(space()), "Only you");
  assert.equal(accessTag(space({ mine: false, by: maya })), "Only Maya");
  const people = (...list) => list.map((p) => ({ ...p, can: "edit" }));
  assert.equal(accessTag(space({ access: "members", people: people(maya) })), "Maya");
  assert.equal(accessTag(space({ access: "members", people: people(maya, dev) })), "Maya and Dev");
  assert.equal(
    accessTag(space({ access: "members", people: people(maya, dev, { id: "m3", name: "Sam Ortiz" }, { id: "m4", name: "Rae Kim" }) })),
    "Maya, Dev and 2 more",
  );
  assert.equal(accessTag(space({ access: "members", people: [] })), "Only you", "nobody picked is private");
  assert.equal(accessTag(space({ access: "team" })), "All members");
  assert.equal(accessTag(space({ access: "link" })), "Anyone with the link");
});

test("when it was last seen, in words", () => {
  assert.equal(seenWords(at(20, 9), now), "this morning");
  assert.equal(seenWords(at(20, 13), now), "earlier today");
  assert.equal(seenWords(at(19, 22), now), "yesterday");
  assert.equal(seenWords(at(17, 8), now, "en-US"), "Tuesday");
  assert.equal(seenWords(at(14, 8), now, "en-US"), "Saturday", "six days back is still a weekday");
  assert.equal(seenWords(at(10, 8), now, "en-US"), "Nov 10");
});

test("the changed line", () => {
  assert.equal(changedLine(2, at(19, 18), now), "2 panels changed since yesterday");
  assert.equal(changedLine(1, at(20, 8), now), "1 panel changed since this morning");
  assert.equal(changedLine(3, 0, now), "3 panels changed");
  assert.equal(changedLine(0, at(19, 18), now), null);
});

test("a panel's last line, and whether it changed", () => {
  assert.equal(lastLine({ by: "m1", name: "Maya Chen", label: "Ticked Press kit", at: now - 2 * 60000 }, now), "Maya ticked Press kit · 2m");
  assert.equal(lastLine({ by: "m1", name: "Maya", at: now - 2 * 60000 }, now), "Maya changed this · 2m");
  assert.equal(lastLine({ by: "m1", name: "Maya", label: "  ", at: now }, now), "Maya changed this · now");
  assert.equal(panelChanged({ updatedAt: 10 }, 5), true);
  assert.equal(panelChanged({ updatedAt: 10 }, 20), false);
  assert.equal(panelChanged({ updatedAt: 10 }, 0), false, "never opened: nothing is marked");
});

test("times on a panel and a row", () => {
  assert.equal(ago(now - 5 * 60000, now), "5m");
  assert.equal(ago(now - 3 * 3600000, now), "3h");
  assert.equal(ago(now - 3 * 86400000, now, "en-US"), "Nov 17");
  assert.equal(spaceWhen(now - 5 * 60000, now), "5m");
  assert.equal(spaceWhen(at(20, 18), now, "en-US"), "6:00 PM");
  assert.equal(spaceWhen(at(21, 10), now, "en-US"), "Nov 21, 10:00 AM");
  assert.equal(
    spaceLine(space({ access: "members", people: [{ ...maya, can: "edit" }, { ...dev, can: "view" }], updatedAt: now - 5 * 60000 }), now),
    "5 panels · Maya and Dev · Updated 5m",
  );
  assert.equal(spaceLine(space({ count: 1, updatedAt: now }), now), "1 panel · Only you · Updated now");
});

test("icons: a built-in keeps its own, a shared space has people, any other a grid", () => {
  assert.equal(spaceIcon(space({ builtin: "today", access: "team" })), "today");
  assert.equal(spaceIcon(space({ builtin: "feed" })), "feed");
  assert.equal(spaceIcon(space({ access: "members" })), "shared");
  assert.equal(spaceIcon(space({ access: "link" })), "shared");
  assert.equal(spaceIcon(space()), "grid");
});

test("deleting asks with the name and the panels", () => {
  assert.equal(deleteQuestion("Launch", 5), "Delete Launch and its 5 panels?");
  assert.equal(deleteQuestion("Launch", 1), "Delete Launch and its 1 panel?");
  assert.equal(deleteQuestion("Launch", 0), "Delete Launch?");
});

test("pinning and unpinning keep the person's order", () => {
  const list = [
    { id: "today", pinned: true },
    { id: "launch", pinned: true },
    { id: "money", pinned: false },
    { id: "trip", pinned: false },
  ];
  assert.deepEqual(arrangePin(list, "trip", true), { order: ["today", "launch", "trip", "money"], pinned: ["today", "launch", "trip"] });
  assert.deepEqual(arrangePin(list, "launch", false), { order: ["today", "launch", "money", "trip"], pinned: ["today"] });
});

test("All spaces: Pinned, More, and From members for the owner only", () => {
  const list = [
    space({ id: "today", pinned: true }),
    space({ id: "money", pinned: false }),
    space({ id: "maya-trip", pinned: false, mine: false, by: maya }),
    space({ id: "maya-pinned", pinned: true, mine: false, by: maya }),
  ];
  const ids = (l) => l.map((s) => s.id);
  const owner = spaceSections(list, true);
  assert.deepEqual([ids(owner.pinned), ids(owner.more), ids(owner.fromMembers)], [["today", "maya-pinned"], ["money"], ["maya-trip"]]);
  const member = spaceSections(list, false);
  assert.deepEqual([ids(member.more), ids(member.fromMembers)], [["money", "maya-trip"], []]);
  // A member's own spaces, seen by that member, are theirs: mine, so never "From members".
  assert.deepEqual(ids(spaceSections([space({ id: "own", pinned: false, by: maya })], true).fromMembers), []);
});

test("an ask goes to the first panel's bot when it is visible, else the primary bot", () => {
  const bots = [{ id: "luna" }, { id: "pip" }];
  assert.equal(askBot(bots, [{ botId: "pip" }]).id, "pip");
  assert.equal(askBot(bots, [{ botId: "gone" }]).id, "luna");
  assert.equal(askBot(bots, []).id, "luna");
});
