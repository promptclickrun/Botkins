// Spaces ("spaces-v1"; docs/spaces.md) on the link host: who can open and change a space, what each
// person is sent, the calls and their shapes, each person's own view of the list, and an owner with
// two members against the demo computer.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { remoteArgs, REMOTE_METHODS, SPACE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { shareIdOf } from "../link-host/spaces.mjs";
import { authorize, filterParts, OWNER, panelOfFrame, panelView, spaceCan, spaceShare, spaceView, TEAM_METHODS, widensShare } from "../link-host/team.mjs";
import { checkJoin, type FetchLike, LinkClient, pair, startJoin } from "../src/link/client";
import type { SpaceContent, SpaceSummary } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const LINK_CALLS = ["link.spaces.share", "link.spaces.newLink", "link.spaces.arrange", "link.spaces.seen", "link.spaces.notify", "link.spaces.here", "link.team.setLinkSharing"];
const role = (more: Record<string, unknown> = {}) => ({ id: "r", name: "R", perms: { agents: ["view", "chat"], today: ["view", "use", "create", "manage", "delete"], skills: [], mcp: [], plugins: [], settings: [] }, bots: "all", ...more });
const teamOf = (more: Record<string, unknown> = {}) => ({ roles: [role()], groups: [{ id: "g", name: "G", roleId: "r" }], members: [{ id: "m_a", name: "Ana", groupId: "g" }, { id: "m_b", name: "Ben", groupId: "g" }], chats: {}, views: {}, spaces: {}, linkSharing: false, ...more });
const ana = { kind: "member", memberId: "m_a", name: "Ana", groupId: "g" };
const ben = { kind: "member", memberId: "m_b", name: "Ben", groupId: "g" };
const names = new Map([[OWNER, "Alex"], ["m_a", "Ana"], ["m_b", "Ben"]]);
const item = (id: string, botId = "mira", updatedAt = 100) => ({ id, botId, updatedAt });
const records = () => [
  { id: "s_today", name: "Today", builtin: "today", createdAt: 1, updatedAt: 100, rev: 4, items: [item("p1"), item("p2", "patch", 300)] },
  { id: "s_launch", name: "Launch", createdAt: 2, updatedAt: 200, rev: 9, projectId: "proj", items: [item("p3", "mira", 250)] },
  { id: "s_money", name: "Money", createdAt: 3, updatedAt: 50, rev: 1, items: [] },
  { id: "s_ana", name: "Today", builtin: "today", createdBy: "m_a", createdAt: 4, updatedAt: 60, rev: 2, items: [item("p4")] },
  { id: "s_ana_trip", name: "Trip", createdBy: "m_a", createdAt: 5, updatedAt: 70, rev: 1, items: [] },
];

test("every space call has a team policy, in both tables of the contract", () => {
  for (const method of SPACE_METHODS) {
    assert.ok(REMOTE_METHODS.has(method), method + " is a call a phone may make");
    assert.ok(TEAM_METHODS[method], method + " has a team policy");
  }
  // A `link.*` name that is missing would quietly be the owner's alone.
  for (const method of LINK_CALLS) assert.ok(TEAM_METHODS[method], method + " has a team policy");
  for (const method of ["spaces.setProject", "spaces.setPanelProject", "link.team.setLinkSharing"]) assert.equal(TEAM_METHODS[method], "owner", method);
});

test("spaceCan: the maker and the owner own a space, a grant or the team opens it, and nobody else knows of it", () => {
  const [, launch, , anas, trip] = records();
  const team = teamOf({ spaces: { s_launch: { access: "members", grants: [{ id: "m_a", can: "edit" }, { id: "m_b", can: "view" }] }, s_ana_trip: { access: "team", teamCan: "view" } } });
  assert.equal(spaceCan(team, launch, OWNER), "own");
  assert.equal(spaceCan(team, launch, "m_a"), "edit");
  assert.equal(spaceCan(team, launch, "m_b"), "view");
  assert.equal(spaceCan(team, launch, "m_c"), null);
  // A member's own space: theirs, and the owner's too (the owner can open every space on the host).
  assert.equal(spaceCan(team, anas, "m_a"), "own");
  assert.equal(spaceCan(team, anas, OWNER), "own");
  assert.equal(spaceCan(team, anas, "m_b"), null, "private: no other member");
  assert.equal(spaceCan(team, trip, "m_b"), "view", "shared with all members");
  // No entry is private; a broken entry is private; "link" lets members do what `teamCan` says.
  assert.equal(spaceCan(teamOf(), launch, "m_a"), null);
  assert.equal(spaceCan(teamOf({ spaces: { s_launch: { access: "everyone" } } }), launch, "m_a"), null);
  assert.equal(spaceCan(teamOf({ spaces: { s_launch: { access: "link", teamCan: "edit" } } }), launch, "m_a"), "edit");
  assert.equal(spaceCan(team, undefined, OWNER), null);
  assert.equal(spaceCan(team, launch, ""), null);
  // Names that are not a team's own never reach the store's prototype.
  assert.deepEqual(spaceShare(teamOf(), "__proto__"), { access: "private", grants: [], teamCan: "view" });
});

test("widening who can open a space is told from narrowing it", () => {
  const priv = spaceShare(teamOf(), "x");
  const share = (entry: unknown) => spaceShare({ spaces: { x: entry } }, "x");
  const picked = share({ access: "members", grants: [{ id: "m_a", can: "view" }] });
  assert.equal(widensShare(priv, picked), true);
  assert.equal(widensShare(picked, priv), false);
  assert.equal(widensShare(picked, share({ access: "members", grants: [{ id: "m_a", can: "edit" }] })), true, "more for one person");
  assert.equal(widensShare(picked, share({ access: "members", grants: [{ id: "m_a", can: "view" }, { id: "m_b", can: "view" }] })), true, "one more person");
  assert.equal(widensShare(share({ access: "members", grants: [{ id: "m_a", can: "edit" }, { id: "m_b", can: "view" }] }), picked), false);
  assert.equal(widensShare(share({ access: "team", teamCan: "view" }), share({ access: "team", teamCan: "edit" })), true);
  assert.equal(widensShare(share({ access: "team", teamCan: "edit" }), share({ access: "team", teamCan: "view" })), false);
  assert.equal(widensShare(share({ access: "team", teamCan: "edit" }), share({ access: "link", teamCan: "edit" })), true, "a link is always wider");
  assert.equal(widensShare(share({ access: "link", teamCan: "view" }), share({ access: "team", teamCan: "view" })), false);
  // From everyone looking to a few changing: someone can do more than before.
  assert.equal(widensShare(share({ access: "team", teamCan: "view" }), share({ access: "members", grants: [{ id: "m_a", can: "edit" }] })), true);
});

test("the spaces part is each person's own view: what they can open, pinned first, counted for their role", () => {
  const team = teamOf({
    roles: [role({ bots: ["mira"] })],
    spaces: { s_launch: { access: "members", grants: [{ id: "m_a", can: "edit" }] }, s_today: { access: "team", teamCan: "edit" } },
    views: { m_a: { spaces: { order: ["s_launch", "s_ana_trip"], pinned: ["s_ana_trip", "s_today"], seen: { s_launch: 260, s_today: 150 }, notify: { s_today: "all" } } } },
  });
  const here = new Map([["s_launch", [{ id: "m_a" }, { id: OWNER, panelId: "p3" }]]]);
  const mine = spaceView(team, records(), "m_a", { role: team.roles[0], names, here }) as SpaceSummary[];
  // Pinned in her order, then the rest in her order; a space new to her goes last.
  assert.deepEqual(mine.map((space) => space.id), ["s_ana_trip", "s_today", "s_launch", "s_ana"]);
  assert.deepEqual(mine.map((space) => space.pinned), [true, true, false, false]);
  const [trip, today, launch] = mine;
  assert.deepEqual([trip.mine, trip.can, trip.access, trip.by], [true, "own", "private", { id: "m_a", name: "Ana" }]);
  // The owner's Today, shared with all members: named by its maker, counted without the bot her role can't see.
  assert.deepEqual([today.builtin, today.by.name, today.mine, today.can, today.teamCan, today.count, today.changed, today.notify], ["today", "Alex", false, "edit", "edit", 1, 0, "all"]);
  // Picked for Launch: "Once a day" by default, nothing changed since she opened it, the owner is looking at a panel.
  assert.deepEqual([launch.can, launch.access, launch.notify, launch.changed], ["edit", "members", "daily", 0]);
  assert.deepEqual(launch.people, [{ id: "m_a", name: "Ana", can: "edit" }]);
  assert.deepEqual(launch.here, [{ id: OWNER, name: "Alex", panelId: "p3" }]);
  // Projects are the owner's: a member is never sent one. Nor a link she didn't make.
  assert.equal(launch.projectId, undefined);
  assert.equal(launch.link, undefined);
  // Nobody is sent a space spaceCan refuses them.
  for (const person of [OWNER, "m_a", "m_b"]) {
    const sent = spaceView(team, records(), person, { role: person === OWNER ? undefined : team.roles[0], names });
    for (const space of sent) assert.ok(spaceCan(team, records().find((record) => record.id === space.id), person), person + " is sent " + space.id);
    assert.ok(sent.every((space) => !("items" in space) && !("createdBy" in space)), "never the app's own record");
  }
  // The owner sees every space, a member's too, with the project and the starting row pinned.
  const owner = spaceView(team, records(), OWNER, { names }) as SpaceSummary[];
  assert.deepEqual(owner.map((space) => space.id).sort(), ["s_ana", "s_ana_trip", "s_launch", "s_money", "s_today"]);
  assert.deepEqual(owner.filter((space) => space.pinned).map((space) => space.id), ["s_today"]);
  assert.equal(owner.find((space) => space.id === "s_launch")!.projectId, "proj");
  assert.equal(owner.find((space) => space.id === "s_ana")!.notify, "off", "a member's space, as the owner sees it");
  assert.equal(owner.find((space) => space.id === "s_today")!.changed, 2, "never opened: everything is new");
  // Ben: only what is shared with all members, and his view starts with no pins of others' spaces.
  const bens = spaceView(team, records(), "m_b", { role: team.roles[0], names }) as SpaceSummary[];
  assert.deepEqual(bens.map((space) => [space.id, space.pinned, space.notify]), [["s_today", false, "off"]]);
  // A role without Spaces is sent none.
  assert.deepEqual(spaceView(team, records(), "m_a", { role: role({ perms: { ...role().perms, today: [] } }), names }), []);
  // A link goes to its maker and the owner only.
  const linked = teamOf({ spaces: { s_ana_trip: { access: "link", teamCan: "view", share: { id: "abc", salt: "s", key: "k", createdAt: 1 } } } });
  const linkOf = (share: { id: string; key: string }) => "https://relay.test/s/" + share.id + "#k=" + share.key;
  assert.equal(spaceView(linked, records(), "m_a", { role: role(), names, linkOf }).find((space: SpaceSummary) => space.id === "s_ana_trip").link, "https://relay.test/s/abc#k=k");
  assert.equal(spaceView(linked, records(), OWNER, { names, linkOf }).find((space: SpaceSummary) => space.id === "s_ana_trip").link, "https://relay.test/s/abc#k=k");
  assert.equal(spaceView(linked, records(), "m_b", { role: role(), names, linkOf }).find((space: SpaceSummary) => space.id === "s_ana_trip").link, undefined);
});

test("a panel as a member is sent it", () => {
  const panel = { id: "p1", spaceId: "s", botId: "mira", chatId: "c1", refreshChatId: "c2", projectId: "proj", lastWriter: "secret", title: "T", routine: { cron: "0 8 * * *", timezone: "UTC", prompt: "Owner's words", enabled: true, nextAt: 1 }, state: { a: 1 }, notes: [] };
  assert.equal("lastWriter" in panelView(panel), false);
  assert.equal(panelView(panel).projectId, "proj", "the owner keeps the rest");
  const seen = panelView(panel, { member: true, inChat: (id: string) => id === "c2" }) as any;
  assert.deepEqual([seen.projectId, seen.chatId, seen.refreshChatId, seen.lastWriter], [undefined, undefined, "c2", undefined]);
  assert.deepEqual(seen.routine, { cron: "0 8 * * *", timezone: "UTC", enabled: true, nextAt: 1 });
  assert.equal((panelView(panel, { member: true, mayChange: true }) as any).routine.prompt, "Owner's words");
  assert.equal((panelView({ ...panel, routine: null }, { member: true }) as any).routine, null);
  // A view's panel is found by its blocks, never by what people wrote into a panel.
  const panels = [{ id: "a", blocks: [{ type: "markdown", text: "frame-9" }], notes: [{ text: "frame-9" }], state: { frame: "frame-9" } }, { id: "b", blocks: [{ type: "html", frame: "frame-9", height: 100 }] }];
  assert.equal(panelOfFrame(panels, "frame-9")!.id, "b");
  assert.equal(panelOfFrame(panels, "nope"), undefined);
});

test("a member's parts hold their view of spaces and only the panels and cards of spaces they can open", () => {
  const team = teamOf({ roles: [role({ bots: ["mira"] })], spaces: { s_today: { access: "team", teamCan: "view" } } });
  const parts = {
    meta: { name: "Studio" },
    bots: [{ id: "mira", name: "Mira" }, { id: "patch", name: "Patch" }],
    chats: [],
    spaces: "the owner's view, never a member's",
    panels: [
      { id: "p1", spaceId: "s_today", botId: "mira", chatId: "c-owner", projectId: "proj", lastWriter: "x", routine: { cron: "0 8 * * *", timezone: "UTC", prompt: "Owner's words", enabled: true, nextAt: 1 } },
      { id: "p2", spaceId: "s_today", botId: "patch", chatId: "c-owner", routine: null },
      { id: "p3", spaceId: "s_launch", botId: "mira", chatId: "c-owner", routine: null },
      { id: "p4", spaceId: "s_ana", botId: "mira", chatId: "c-ana", routine: null },
    ],
    board: [{ id: "b1", spaceId: "s_today", botId: "mira" }, { id: "b2", spaceId: "s_launch", botId: "mira" }],
    settings: {},
  };
  const seen = filterParts(parts, ben, team, { spaces: records(), names }) as any;
  assert.deepEqual(seen.spaces.map((space: SpaceSummary) => space.id), ["s_today"]);
  // `panels` and `board` stay for an app that doesn't know spaces: every Today he can open, cut for a member.
  assert.deepEqual(seen.panels.map((panel: { id: string }) => panel.id), ["p1"]);
  assert.deepEqual([seen.panels[0].projectId, seen.panels[0].chatId, seen.panels[0].lastWriter, seen.panels[0].routine.prompt], [undefined, undefined, undefined, undefined]);
  assert.deepEqual(seen.board.map((card: { id: string }) => card.id), ["b1"]);
  // Ana also gets her own Today's panels.
  assert.deepEqual((filterParts(parts, ana, team, { spaces: records(), names }) as any).panels.map((panel: { id: string }) => panel.id), ["p1", "p4"]);
  // Without spaces on the app, the old rule stays and no `spaces` part is made up.
  const old = filterParts({ ...parts, spaces: undefined }, ben, team) as any;
  assert.equal(old.spaces, undefined);
  assert.deepEqual(old.panels.map((panel: { id: string }) => panel.id), ["p1", "p3", "p4"]);
});

test("a call needs the space of what it names, on top of the role", () => {
  const team = teamOf({ spaces: { s_launch: { access: "members", grants: [{ id: "m_a", can: "edit" }, { id: "m_b", can: "view" }] } } });
  const panels: Record<string, unknown> = { p3: { id: "p3", spaceId: "s_launch", botId: "mira" }, p4: { id: "p4", spaceId: "s_ana", botId: "mira", createdBy: "m_a" }, p9: { id: "p9", spaceId: "s_money", botId: "mira" }, pb: { id: "pb", spaceId: "s_launch", botId: "mira", createdBy: "m_b" } };
  const cards: Record<string, unknown> = { b2: { id: "b2", spaceId: "s_launch", botId: "mira" }, b9: { id: "b9", spaceId: "s_money", botId: "mira" } };
  const lookups = { space: (id: string) => records().find((space) => space.id === id), panel: (id: string) => panels[id], card: (id: string) => cards[id], bot: (id: string) => ({ id }), chat: () => undefined };
  const may = (who: unknown, method: string, ...args: unknown[]) => authorize(who, team, method, args, lookups);
  // Opening: what you can't open doesn't exist.
  assert.equal(may(ana, "spaces.read", "s_launch"), "");
  assert.equal(may(ben, "spaces.read", "s_launch"), "");
  assert.match(may(ana, "spaces.read", "s_money"), /no longer exists/);
  assert.match(may(ben, "spaces.read", "s_ana"), /no longer exists/);
  // Acting and changing need "edit" or "own"; looking is not enough.
  for (const [method, ...args] of [["spaces.patchState", "p3", {}], ["spaces.note", "p3", "hi"], ["refreshPanel", "p3"], ["changePanel", "p3", "wide"], ["routine", "p3", { action: "pause" }], ["boardAct", "b2", "done"], ["spaces.newPanel", { spaceId: "s_launch", botId: "mira", prompt: "x" }], ["spaces.ask", { spaceId: "s_launch", botId: "mira", text: "x" }]] as [string, ...unknown[]][]) {
    assert.equal(may(ana, method, ...args), "", method + " with edit");
    assert.match(may(ben, method, ...args), /look at this space, not change it/, method + " with view");
  }
  // A panel or a card in a space you can't open answers as an unknown id does.
  assert.match(may(ana, "spaces.patchState", "p9", {}), /panel no longer exists/);
  assert.match(may(ana, "boardAct", "b9", "done"), /item no longer exists/);
  assert.match(may(ana, "spaces.ask", { spaceId: "s_launch", botId: "mira", text: "x", panelId: "p9" }), /panel no longer exists/);
  // Renaming, deleting and sharing are the maker's.
  assert.match(may(ana, "spaces.rename", "s_launch", "x"), /made this space/);
  assert.equal(may(ana, "spaces.rename", "s_ana_trip", "x"), "");
  assert.equal(may(ana, "spaces.remove", "s_ana_trip"), "");
  assert.match(may(ana, "link.spaces.share", "s_launch", { access: "team" }), /made this space/);
  // Moving a panel: own the space it leaves or have asked for the panel; change the one it enters.
  assert.equal(may(ana, "spaces.movePanel", "p4", { spaceId: "s_launch", before: null }), "");
  assert.match(may(ana, "spaces.movePanel", "p3", { spaceId: "s_ana", before: null }), /made this space/);
  assert.match(may(ben, "spaces.movePanel", "pb", { spaceId: "s_launch", before: null }), /look at this space/, "his own panel, but he may not change where it lands");
  assert.match(may(ana, "spaces.movePanel", "p4", { spaceId: "s_money", before: null }), /space no longer exists/);
  // The role applies on top, own spaces included.
  const viewer = teamOf({ roles: [role({ perms: { ...role().perms, today: ["view"] } })] });
  assert.match(authorize(ana, viewer, "spaces.remove", ["s_ana_trip"], lookups), /role can't do that/);
  assert.match(authorize(ana, viewer, "spaces.patchState", ["p4", {}], lookups), /role can't do that/);
  assert.equal(authorize(ana, viewer, "spaces.read", ["s_ana"], lookups), "");
  const noChat = teamOf({ roles: [role({ perms: { ...role().perms, agents: ["view"] } })] });
  assert.match(authorize(ana, noChat, "spaces.newPanel", [{ spaceId: "s_ana", botId: "mira", prompt: "x" }], lookups), /role can't do that/);
  const noManage = teamOf({ roles: [role({ perms: { ...role().perms, today: ["view", "use", "create"] } })] });
  assert.match(authorize(ana, noManage, "spaces.newPanel", [{ spaceId: "s_ana", botId: "mira", prompt: "x", refresh: { cron: "0 8 * * *", timezone: "UTC" } }], lookups), /role can't do that/, "a refresh is a routine");
  assert.equal(authorize(ana, noManage, "spaces.newPanel", [{ spaceId: "s_ana", botId: "mira", prompt: "x" }], lookups), "");
  // The bot of a new panel or an ask has to be one the role sees.
  assert.match(authorize(ana, teamOf({ roles: [role({ bots: ["patch"] })] }), "spaces.ask", [{ spaceId: "s_ana", botId: "mira", text: "x" }], lookups), /bot isn't available/);
  // Sharing: a maker narrows freely; widening needs "manage"; a link also needs the owner's switch.
  const shared = teamOf({ roles: [role({ perms: { ...role().perms, today: ["view"] } })], spaces: { s_ana_trip: { access: "team", teamCan: "edit" } } });
  assert.equal(authorize(ana, shared, "link.spaces.share", ["s_ana_trip", { access: "private" }], lookups), "", "taking sharing back needs nothing");
  assert.match(authorize(ana, shared, "link.spaces.share", ["s_ana_trip", { access: "link" }], lookups), /role can't do that/);
  assert.match(may(ana, "link.spaces.share", "s_ana_trip", { access: "link" }), /hasn't turned on sharing by link/);
  assert.equal(authorize(ana, teamOf({ linkSharing: true }), "link.spaces.share", ["s_ana_trip", { access: "link" }], lookups), "");
  assert.equal(may(ana, "link.spaces.share", "s_ana_trip", { access: "team", teamCan: "edit" }), "");
  // The owner's own: projects, and the switch.
  assert.match(may(ana, "spaces.setProject", "s_ana_trip", "proj"), /Only the owner/);
  assert.match(may(ana, "link.team.setLinkSharing", true), /Only the owner/);
  assert.equal(may({ kind: "owner" }, "spaces.remove", "s_ana_trip"), "");
  // An app without spaces: the old rules, no space needed.
  assert.equal(authorize(ana, team, "refreshPanel", ["p9"], { bot: (id: string) => ({ id }), chat: () => undefined }), "");
});

test("the link cuts each space call to its shape", () => {
  assert.deepEqual(remoteArgs("spaces.create", [{ name: "  Launch  ", access: "link" }]), [{ name: "Launch" }]);
  assert.throws(() => remoteArgs("spaces.create", [{ name: "x".repeat(41) }]), /up to 40 characters/);
  assert.throws(() => remoteArgs("spaces.rename", ["s1", "  "]), /up to 40 characters/);
  assert.deepEqual(remoteArgs("spaces.read", ["s1", { all: true }]), ["s1"]);
  assert.throws(() => remoteArgs("spaces.read", [{ id: "s1" }]), /space no longer exists/);
  assert.deepEqual(remoteArgs("spaces.setProject", ["s1", null]), ["s1", null]);
  assert.deepEqual(remoteArgs("spaces.movePanel", ["p1", { spaceId: "s2", before: null, as: "owner" }]), ["p1", { spaceId: "s2", before: null }]);
  assert.deepEqual(remoteArgs("spaces.ask", [{ spaceId: "s1", botId: "b", text: " why? ", panelId: "p1", createdBy: "owner" }]), [{ spaceId: "s1", botId: "b", text: "why?", panelId: "p1" }]);
  assert.throws(() => remoteArgs("spaces.newPanel", [{ spaceId: "s1", botId: "b", prompt: "x", start: "game" }]), /starts from/);
  assert.throws(() => remoteArgs("spaces.newPanel", [{ spaceId: "s1", botId: "b", prompt: "x", refresh: { cron: "every day", timezone: "UTC" } }]), /refresh schedule/);
  // An app panel's state: a small plain object, and a short label.
  assert.deepEqual(remoteArgs("spaces.patchState", ["p1", { ticked: { a: true }, gone: null }, "  Ticked   Press kit "]), ["p1", { ticked: { a: true }, gone: null }, "Ticked Press kit"]);
  assert.deepEqual(remoteArgs("spaces.patchState", ["p1", { a: 1 }, "x".repeat(200)])[2], "x".repeat(80));
  assert.throws(() => remoteArgs("spaces.patchState", ["p1", "ticked"]), /can't be saved/);
  assert.throws(() => remoteArgs("spaces.patchState", ["p1", { big: "x".repeat(70_000) }]), /too large/);
  assert.throws(() => remoteArgs("spaces.patchState", ["p1", Object.fromEntries(Array.from({ length: 201 }, (_, i) => ["k" + i, 1]))]), /too large/);
  assert.throws(() => remoteArgs("spaces.note", ["p1", "x".repeat(2001)]), /2,000 characters/);
  assert.deepEqual(remoteArgs("spaces.removeNote", ["p1", "n1", "extra"]), ["p1", "n1"]);
});

test("a link's id belongs to the host's relay key and a salt", () => {
  const id = shareIdOf("relay-public-key", "salt-one");
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(shareIdOf("relay-public-key", "salt-one"), id);
  assert.notEqual(shareIdOf("relay-public-key", "salt-two"), id);
  assert.notEqual(shareIdOf("another-key", "salt-one"), id);
});

/** The demo computer with an owner's phone and two members' phones. */
async function team(options: Record<string, unknown> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-spaces-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false, ...options });
  await link.setEnabled(true);
  link.setName("Studio");
  const clients: LinkClient[] = [];
  const follow = (pairing: any) => {
    const parts: Record<string, any> = {};
    const client = new LinkClient(pairing, { fetch: real, onState() {}, onParts: (next) => void Object.assign(parts, next) });
    clients.push(client);
    client.start();
    const until = async (check: () => unknown, what: string) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(check(), what);
    };
    const space = (name: string, by?: string) => (parts.spaces as SpaceSummary[] | undefined)?.find((one) => one.name === name && (by === undefined || one.by.id === by));
    return { client, parts, until, space, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args) };
  };
  const owner = follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" }));
  const collab = structuredClone(link.store.data.team.roles.find((one: any) => one.id === "r_collab"));
  collab.bots = "all";
  await owner.call("link.team.saveRole", collab);
  await owner.call("link.team.saveGroup", { id: "g_makers", name: "Makers", roleId: "r_collab" });
  const join_ = async (name: string) => {
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_makers", days: 7, maxUses: 1 });
    const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    const started = await startJoin(real, target, { name, platform: "ios", kind: "phone" });
    if (started.result.status !== "pending") throw new Error("not pending");
    await owner.call("link.team.approve", started.result.requestId);
    const checked = await checkJoin(real, started.attempt);
    if (checked.status !== "approved") throw new Error("not approved");
    return follow(checked.pairing);
  };
  return { link, backend, owner, join: join_, stop: async () => (clients.forEach((client) => client.stop()), await link.stop()) };
}

test("the demo: an owner and two members make, share, open and change spaces, each with their own view", async () => {
  const { link, backend, owner, join: join_, stop } = await team({ demoSpaceLinks: true });
  try {
    assert.ok(link.meta().capabilities.includes("spaces-v1"));
    await owner.until(() => owner.space("Launch"), "the owner is sent spaces");
    // The owner's view: every space, the four built-in ones pinned first, in their order.
    assert.deepEqual((owner.parts.spaces as SpaceSummary[]).filter((space) => space.pinned).map((space) => space.name), ["Today", "Feed", "Ideas", "Goals"]);
    assert.ok((owner.parts.spaces as SpaceSummary[]).every((space) => space.can === "own" && space.mine && space.access === "private"), "with no member yet, everything is private");
    assert.equal(owner.space("Money")!.projectId, backend.state.projects[0].id);
    // The app's own list never reaches a device.
    assert.ok((owner.parts.spaces as any[]).every((space) => !("items" in space)));
    const launch = owner.space("Launch")!;
    const content = await owner.call<SpaceContent>("spaces.read", launch.id);
    assert.deepEqual(content.panels.map((panel) => panel.title), ["Launch checklist", "Signups"]);
    assert.equal(content.seenAt, 0);
    assert.deepEqual(content.panels[0].state, { ticked: { "Pricing page copy": true, "Press kit": true } });

    // Two members join. Each gets their own four built-in spaces, and nothing of the owner's.
    const ana = await join_("Ana");
    const ben = await join_("Ben");
    await ana.until(() => (ana.parts.spaces as SpaceSummary[] | undefined)?.length === 4, "Ana has her four built-in spaces");
    await ben.until(() => (ben.parts.spaces as SpaceSummary[] | undefined)?.length === 4, "Ben has his");
    const anaId = ana.parts.meta.you.memberId as string;
    const benId = ben.parts.meta.you.memberId as string;
    assert.ok((ana.parts.spaces as SpaceSummary[]).every((space) => space.mine && space.pinned && space.by.name === "Ana"));
    assert.equal(ana.parts.panels.length, 0, "the owner's panels are the owner's until shared");
    await assert.rejects(ana.call("spaces.read", launch.id), /space no longer exists/);
    // The owner sees the members' spaces too ("From members").
    await owner.until(() => owner.space("Today", anaId) && owner.space("Today", benId), "the owner sees members' spaces");
    assert.equal(owner.space("Today", anaId)!.can, "own");

    // The owner picks Ana for Launch, to change it, and Ben to look.
    assert.deepEqual(await owner.call("link.spaces.share", launch.id, { access: "members", grants: [{ id: anaId, can: "edit" }, { id: benId, can: "view" }] }), {});
    await ana.until(() => ana.space("Launch"), "Ana is sent Launch");
    await ben.until(() => ben.space("Launch"), "Ben is sent Launch");
    assert.deepEqual([ana.space("Launch")!.can, ana.space("Launch")!.pinned, ana.space("Launch")!.notify, ana.space("Launch")!.by.id], ["edit", false, "daily", OWNER]);
    assert.equal(ben.space("Launch")!.can, "view");
    assert.deepEqual(owner.space("Launch")!.people!.map((person) => person.can), ["edit", "view"]);
    // Ana opens it: a member gets a panel without its chat and its routine's prompt.
    const anas = await ana.call<SpaceContent>("spaces.read", launch.id);
    const signups = anas.panels.find((panel) => panel.title === "Signups")!;
    assert.equal(signups.chatId, undefined);
    assert.equal(anas.panels[0].projectId, undefined);
    // A routine's prompt is for someone who may change the space: Ana may, Ben only looks.
    assert.equal(signups.routine!.prompt, "Refresh the signup count");
    const bens = await ben.call<SpaceContent>("spaces.read", launch.id);
    assert.equal(bens.panels.find((panel) => panel.title === "Signups")!.routine!.prompt, undefined);
    // She ticks an item and writes a note; Ben may only look.
    const checklist = anas.panels[0];
    assert.deepEqual(await ana.call("spaces.patchState", checklist.id, { ticked: { ...(checklist.state!.ticked as object), "Support macros": true } }, "Ticked Support macros"), { rev: 4 });
    const noteId = await ana.call<string>("spaces.note", checklist.id, "Macros are done.");
    await assert.rejects(ben.call("spaces.patchState", checklist.id, { ticked: {} }), /look at this space, not change it/);
    await assert.rejects(ben.call("spaces.note", checklist.id, "me too"), /look at this space/);
    await assert.rejects(ben.call("spaces.removeNote", checklist.id, noteId), /look at this space/);
    const after = await owner.call<SpaceContent>("spaces.read", launch.id);
    assert.equal((after.panels[0].state!.ticked as Record<string, boolean>)["Support macros"], true);
    assert.deepEqual(after.panels[0].last && [after.panels[0].last.name, after.panels[0].last.label], ["Ana", "Wrote a note"]);
    assert.equal(after.panels[0].notes!.at(-1)!.text, "Macros are done.");
    // The space's `rev` went up, so an app reads it again; for Ben two things changed since he never opened it.
    await ben.until(() => ben.space("Launch")!.rev > launch.rev, "the change reaches Ben");
    assert.ok(ben.space("Launch")!.changed >= 1);
    await ben.call("link.spaces.seen", launch.id);
    await ben.until(() => ben.space("Launch")!.changed === 0, "seen: nothing is new for Ben");
    assert.ok((await ben.call<SpaceContent>("spaces.read", launch.id)).seenAt > 0);
    assert.ok(owner.space("Launch")!.changed > 0, "the owner's own mark is the owner's");
    // Who is looking: each sees the others, never themselves.
    await ana.call("link.spaces.here", launch.id, checklist.id);
    await owner.until(() => owner.space("Launch")!.here.length === 1, "the owner sees Ana there");
    assert.deepEqual(owner.space("Launch")!.here[0], { id: anaId, name: "Ana", panelId: checklist.id });
    assert.deepEqual(ana.space("Launch")!.here, []);
    await ana.call("link.spaces.here", null);
    await owner.until(() => owner.space("Launch")!.here.length === 0, "she left");

    // Ana's own view: she pins Launch first and asks for every change.
    await ana.call("link.spaces.arrange", { order: (ana.parts.spaces as SpaceSummary[]).map((space) => space.id), pinned: [launch.id, "s_not_hers"] });
    await ana.call("link.spaces.notify", launch.id, "all");
    await ana.until(() => ana.space("Launch")!.pinned && ana.space("Launch")!.notify === "all", "Ana's pins and Notify me");
    assert.deepEqual((ana.parts.spaces as SpaceSummary[]).filter((space) => space.pinned).map((space) => space.name), ["Launch"]);
    assert.equal(ben.space("Launch")!.pinned, false);
    await assert.rejects(ana.call("link.spaces.notify", launch.id, "hourly"), /Off, Once a day or Every change/);

    // Ana makes a space: private, pinned for her, hers to share. The owner can open it; Ben can't.
    const tripId = await ana.call<string>("spaces.create", { name: "Trip" });
    await ana.until(() => ana.space("Trip")?.pinned, "her new space is pinned for her");
    assert.deepEqual([ana.space("Trip")!.access, ana.space("Trip")!.can], ["private", "own"]);
    await owner.until(() => owner.space("Trip"), "the owner sees it");
    assert.ok(!ben.space("Trip"));
    // A new panel in it starts a chat with the bot there; the chat is hers.
    const bot = ana.parts.bots[0].id as string;
    const made = await ana.call<{ chatId: string }>("spaces.newPanel", { spaceId: tripId, botId: bot, prompt: "Packing list", start: "checklist" });
    assert.equal(backend.state.chats.find((chat: any) => chat.id === made.chatId).createdBy, anaId);
    await ana.until(() => ana.space("Trip")!.count === 1, "the panel is in her space");
    const trip = await ana.call<SpaceContent>("spaces.read", tripId);
    assert.equal(trip.panels[0].chatId, made.chatId, "her own chat is named to her");
    // She shares it with everyone; a link needs the owner's switch, then it is made.
    await ana.call("link.spaces.share", tripId, { access: "team", teamCan: "view" });
    await ben.until(() => ben.space("Trip")?.can === "view", "Ben is sent Trip");
    assert.equal(ben.space("Trip")!.notify, "off");
    await assert.rejects(ana.call("link.spaces.share", tripId, { access: "link" }), /hasn't turned on sharing by link/);
    assert.equal(await owner.call("link.team.setLinkSharing", true), true);
    const linked = await ana.call<{ link: string }>("link.spaces.share", tripId, { access: "link" });
    assert.match(linked.link, /^https:\/\/relay\.botkins\.app\/s\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$/);
    await ana.until(() => ana.space("Trip")!.link === linked.link, "the link is hers to copy");
    assert.equal(owner.space("Trip")!.link, linked.link);
    assert.equal(ben.space("Trip")!.link, undefined);
    assert.equal(ben.space("Trip")!.can, "view", "members keep what they could do");
    // A new link replaces the old one, whose copy is queued to leave the relay.
    const fresh = await ana.call<{ link: string }>("link.spaces.newLink", tripId);
    assert.notEqual(fresh.link, linked.link);
    assert.equal(link.store.data.team.spaceCopies.length, 1);
    // Taking it back to private: Ben loses it, and the second copy is queued too.
    await ana.call("link.spaces.share", tripId, { access: "private" });
    await ben.until(() => !ben.space("Trip"), "private again");
    assert.equal(link.store.data.team.spaceCopies.length, 2);
    assert.equal(ana.space("Trip")!.link, undefined);

    // A grant never widens a role: someone whose role has no Spaces can't be picked.
    const guest = structuredClone(link.store.data.team.roles.find((one: any) => one.id === "r_collab"));
    guest.perms.today = [];
    await owner.call("link.team.saveRole", guest);
    await assert.rejects(owner.call("link.spaces.share", launch.id, { access: "members", grants: [{ id: benId, can: "view" }] }), /role can't open spaces/);
    await ben.until(() => (ben.parts.spaces as SpaceSummary[]).length === 0, "a role without Spaces is sent none");
    guest.perms.today = ["view", "use", "create", "manage", "delete"];
    await owner.call("link.team.saveRole", guest);

    // A member is removed: their grants go, and what they made passes to the owner, private.
    await ana.call("link.spaces.share", tripId, { access: "team", teamCan: "edit" });
    await owner.call("link.team.removeMember", anaId);
    await owner.until(() => owner.space("Trip")?.mine, "Trip is the owner's now");
    assert.equal(owner.space("Trip")!.access, "private");
    assert.ok(!owner.space("Launch")!.people!.some((person) => person.id === anaId));
    assert.equal(link.store.data.team.views[anaId], undefined);
    assert.ok(!owner.space("Today", anaId), "her empty built-in spaces are gone");
    // For the app on the host: the same lists, by person.
    assert.deepEqual(link.spacesFor(OWNER).map((space: SpaceSummary) => space.id), (owner.parts.spaces as SpaceSummary[]).map((space) => space.id));
    assert.equal(link.spaceCan(tripId, benId), null);
    assert.equal(link.spaceCan(launch.id, benId), "view");
    // Deleting a space takes its sharing along.
    await owner.call("spaces.remove", launch.id);
    assert.equal(link.store.data.team.spaces[launch.id], undefined);
    await ben.until(() => !ben.space("Launch"), "Launch is gone for Ben");
  } finally {
    await stop();
  }
});

test("the first time an app with spaces is seen, the owner's built-in spaces are shared with a team that has members", async () => {
  const { link, owner, join: join_, stop } = await team();
  try {
    // A team with a member before spaces arrive: nobody loses what their role shows them now.
    link.store.set({ team: { ...link.store.data.team, spacesMoved: undefined, members: [...link.store.data.team.members, { id: "m_old", name: "Old", groupId: "g_makers", deviceIds: [] }] } });
    const ana = await join_("Ana");
    await ana.until(() => ana.space("Today", OWNER), "the owner's Today is shared with her");
    assert.deepEqual([ana.space("Today", OWNER)!.can, ana.space("Today", OWNER)!.access], ["edit", "team"]);
    assert.equal(ana.space("Launch"), undefined, "only the four built-in ones");
    assert.equal(link.store.data.team.spacesMoved, true);
    // `panels` stays for an app that doesn't know spaces: every Today she can open.
    await ana.until(() => ana.parts.panels.length === 2, "the owner's Today panels, as before");
    // Without a relay, a link is refused with the sentence that says what to do.
    await assert.rejects(owner.call("link.spaces.share", owner.space("Launch")!.id, { access: "link" }), /Turn on the relay on your computer to share by link/);
  } finally {
    await stop();
  }
});

test("a custom view on a panel is its space's: a member who can't open the space can't load it", async () => {
  const { backend, owner, join: join_, stop } = await team();
  try {
    await owner.until(() => owner.space("Launch"), "spaces");
    const ana = await join_("Ana");
    await ana.until(() => (ana.parts.spaces as SpaceSummary[] | undefined)?.length === 4, "Ana is in");
    const frame = backend.state.panels.find((panel: any) => panel.id === "panel-checklist").blocks[0].frame;
    assert.ok((await owner.call<{ html: string }>("link.frame.page", frame)).html.includes("botkins.state"));
    await assert.rejects(ana.call("link.frame.page", frame), /view no longer exists/);
    // Writing the view's id into a note of a panel she can open gets her nothing.
    const own = (await ana.call<string>("spaces.create", { name: "Mine" }));
    const bot = ana.parts.bots[0].id as string;
    await ana.call("spaces.newPanel", { spaceId: own, botId: bot, prompt: "Anything" });
    const panel = (await ana.call<SpaceContent>("spaces.read", own)).panels[0];
    await ana.call("spaces.note", panel.id, frame);
    await assert.rejects(ana.call("link.frame.page", frame), /view no longer exists/);
    // Shared with her, it loads.
    await owner.call("link.spaces.share", owner.space("Launch")!.id, { access: "team", teamCan: "view" });
    await ana.until(() => ana.space("Launch"), "Launch is shared");
    assert.ok((await ana.call<{ html: string }>("link.frame.page", frame)).html.includes("botkins.state"));
  } finally {
    await stop();
  }
});
