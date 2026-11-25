// "team-people-v1": the people in a chat (its starter and those invited), each member's own view of
// bots and chats, what a member receives, and what each may do. The rules are in link-host/team.mjs;
// the last test runs an owner and two members against the demo computer.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { authorize, chatPeople, filterParts, inChat, OWNER, personOf, sharedBotFlags, TEAM_METHODS, viewOf, withBotFlags, withChatFlags } from "../link-host/team.mjs";
import { checkJoin, type FetchLike, LinkClient, pair, startJoin } from "../src/link/client";
import { myPlace, myself, peopleRows, sharedLine, speakerLabel, starterOf } from "../src/features/chat/people";
import type { Bot, ChatSummary } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const role = (more: Record<string, unknown> = {}) => ({ id: "r", name: "R", perms: { agents: ["view", "chat"], today: ["view", "use", "manage", "delete", "create"], skills: [], mcp: [], plugins: [], settings: [] }, bots: "all", ...more });
const teamOf = (more: Record<string, unknown> = {}) => ({ roles: [role()], groups: [{ id: "g", name: "G", roleId: "r" }], members: [{ id: "m_a", name: "Ana", groupId: "g" }, { id: "m_b", name: "Ben", groupId: "g" }], chats: {}, views: {}, ...more });
const ana = { kind: "member", memberId: "m_a", name: "Ana", groupId: "g" };
const ben = { kind: "member", memberId: "m_b", name: "Ben", groupId: "g" };

test("a stale team invitation cannot expose a cross-host Teamwork chat or its approval", () => {
  const team = teamOf({ chats: { c: ["m_a"] } });
  const chat = { id: "c", botId: "b", hostDispatch: true };
  const request = { id: "r", chatId: "c", kind: "permission", dispatch: true, detail: "private text" };
  const parts = { chats: [chat], bots: [{ id: "b" }], live: { requests: [request] }, "chat:c": { messages: [request.detail] } };
  const view = filterParts(parts, ana, team);
  assert.deepEqual(view.chats, []);
  assert.deepEqual(view.live.requests, []);
  assert.equal(view["chat:c"], null);
  assert.match(authorize(ana, team, "respond", ["r", { action: "today" }], { request: [request], chat: [chat] }), /owner/);
  assert.match(authorize(ana, team, "link.messages", ["c", 0], { chat: [{ ...chat, createdBy: ana.memberId }] }), /owner/);
});

test("a chat's people are its starter and those invited", () => {
  const team = teamOf({ chats: { "c-ana": ["m_b"], "c-owner": ["m_a"] } });
  assert.equal(personOf({ kind: "owner" }), OWNER);
  assert.equal(inChat(team, { id: "c-owner", hostDispatch: true }, "m_a"), false);
  assert.equal(personOf(ana), "m_a");
  assert.deepEqual(chatPeople(team, { id: "c-ana", createdBy: "m_a" }), { createdBy: "m_a", invited: ["m_b"] });
  assert.deepEqual(chatPeople(team, { id: "c-owner" }), { createdBy: OWNER, invited: ["m_a"] });
  assert.deepEqual(chatPeople(team, { id: "nobody" }), { createdBy: OWNER, invited: [] });
  assert.equal(inChat(team, { id: "c-ana", createdBy: "m_a" }, "m_a"), true);
  assert.equal(inChat(team, { id: "c-ana", createdBy: "m_a" }, "m_b"), true);
  // The owner is not in a member's chat unless invited; a member is not in the owner's unless invited.
  assert.equal(inChat(team, { id: "c-ana", createdBy: "m_a" }, OWNER), false);
  assert.equal(inChat(team, { id: "c-owner" }, OWNER), true);
  assert.equal(inChat(team, { id: "c-owner" }, "m_a"), true);
  assert.equal(inChat(team, { id: "c-owner" }, "m_b"), false);
  assert.equal(inChat(team, undefined, OWNER), false);
});

test("a member's view is their own: hidden and pinned bots, and a chat's flags", () => {
  let view = viewOf(teamOf(), "m_a");
  assert.deepEqual(view, { bots: {}, order: [], chats: {} });
  view = withBotFlags(view, "mira", { hidden: true, pinned: true, sectionId: "s1", teamwork: false });
  assert.deepEqual(view.bots, { mira: { hidden: true, pinned: true } });
  view = withBotFlags(view, "mira", { hidden: false });
  assert.deepEqual(view.bots, { mira: { pinned: true } });
  view = withBotFlags(view, "mira", { pinned: false });
  assert.deepEqual(view.bots, {});
  // What is not a view stays for the app, and a section is never a member's.
  assert.deepEqual(sharedBotFlags({ hidden: true, pinned: false, sectionId: "s1", teamwork: true }), { teamwork: true });
  assert.deepEqual(sharedBotFlags({ hidden: true }), {});
  view = withChatFlags(view, "c1", { pinned: true, archived: true }, 100);
  assert.deepEqual(view.chats.c1, { pinned: true, archived: true });
  // Marking read keeps the chat's time then; marking unread is kept as such.
  view = withChatFlags(view, "c1", { unread: false, archived: false }, 100);
  assert.deepEqual(view.chats.c1, { pinned: true, seen: 100 });
  view = withChatFlags(view, "c1", { unread: true }, 100);
  assert.equal(view.chats.c1.unread, true);
});

const parts = () => ({
  meta: { name: "Studio" },
  bots: [
    { id: "mira", name: "Mira", hidden: true, pinned: false, sectionId: "s1", instructions: "Owner's notes", origin: { file: "/Users/owner/agents/mira.md" } },
    { id: "patch", name: "Patch", pinned: true },
    { id: "tally", name: "Tally" },
  ],
  sections: [{ id: "s1", name: "Work" }],
  chats: [
    { id: "c-owner", botId: "mira", title: "Owner's", time: 10, count: 2, unread: true, pinned: true },
    { id: "c-ana", botId: "mira", title: "Ana's", time: 20, count: 2, createdBy: "m_a", archived: true, unread: true },
    { id: "c-ben", botId: "patch", title: "Ben's", time: 30, count: 4, createdBy: "m_b" },
    { id: "c-shared", botId: "tally", title: "Shared", time: 40, count: 6 },
  ],
  live: { streams: { "c-owner": "…", "c-shared": "…" }, intents: {}, thinking: {}, speakers: {}, queued: {}, requests: [{ id: "q1", chatId: "c-shared", kind: "question" }, { id: "q2", chatId: "c-shared", kind: "permission" }, { id: "q3", chatId: "c-owner", kind: "question" }], active: ["c-owner", "c-shared"] },
  runs: [{ id: "r1", chatId: "c-owner" }, { id: "r2", chatId: "c-shared" }, { id: "r3", chatId: "c-ben" }],
  panels: [{ id: "p1", botId: "mira", chatId: "c-owner" }, { id: "p2", botId: "tally" }],
  board: [{ id: "b1", botId: "patch" }, { id: "b2", botId: "tally" }],
  "chat:c-owner": { id: "c-owner" },
  "chat:c-shared": { id: "c-shared" },
  settings: {},
});

test("a member receives their own and shared chats, bots as they arranged them, and nothing of the owner's arrangement", () => {
  const team = teamOf({
    roles: [role({ bots: ["mira", "tally"] })],
    chats: { "c-shared": ["m_a"] },
    views: { m_a: { bots: { tally: { hidden: true }, mira: { pinned: true } }, order: ["tally", "mira"], chats: { "c-shared": { pinned: true, seen: 40 }, "c-ana": { seen: 5 } } } },
  });
  const seen = filterParts(parts(), ana, team) as any;
  // Chats: Ana's own and the one she was invited to. Not the owner's, not Ben's.
  assert.deepEqual(seen.chats.map((chat: ChatSummary) => chat.id), ["c-ana", "c-shared"]);
  const [own, shared] = seen.chats as (ChatSummary & { invited?: string[] })[];
  // Flags are hers: the owner archived c-ana in the owner's view, not in hers; she read it at 5 and it moved on.
  assert.equal(own.archived, undefined);
  assert.equal(own.unread, true);
  assert.equal(shared.pinned, true);
  assert.equal(shared.unread, undefined, "read at its latest time");
  assert.deepEqual(shared.invited, ["m_a"]);
  // Bots: only those her role sees, in her order, with her marks. The owner hid Mira; Ana did not.
  assert.deepEqual(seen.bots.map((bot: Bot) => bot.id), ["tally", "mira"]);
  const mira = seen.bots.find((bot: Bot) => bot.id === "mira");
  assert.equal(mira.hidden, undefined);
  assert.equal(mira.pinned, true);
  assert.equal(seen.bots.find((bot: Bot) => bot.id === "tally").hidden, true);
  // Nothing of what the owner wrote for a bot, where it came from, or how the owner's Home is arranged.
  assert.equal(mira.instructions, undefined);
  assert.equal(mira.origin, undefined);
  assert.equal(mira.sectionId, undefined);
  assert.equal(seen.sections, undefined);
  // Live state, runs and details only of her chats; an approval is the owner's to answer.
  assert.deepEqual(Object.keys(seen.live.streams), ["c-shared"]);
  assert.deepEqual(seen.live.requests.map((request: { id: string }) => request.id), ["q1"]);
  assert.deepEqual(seen.runs.map((run: { id: string }) => run.id), ["r2"]);
  assert.equal(seen["chat:c-owner"], null);
  assert.deepEqual(seen["chat:c-shared"], { id: "c-shared" });
  // Today: only panels and board items of bots her role sees.
  assert.deepEqual(seen.panels.map((panel: { id: string }) => panel.id), ["p1", "p2"]);
  assert.deepEqual(seen.board.map((item: { id: string }) => item.id), ["b2"]);
  // The people a chat can be shared with: the owner, by the computer's name, and each member.
  assert.deepEqual(seen.team.people, [{ id: OWNER, name: "Studio" }, { id: "m_a", name: "Ana" }, { id: "m_b", name: "Ben" }]);
  // Both of a bot's prompts are the owner's words.
  const prompts = parts();
  (prompts.bots[0] as any).clarificationInstructions = "Ask the owner first";
  assert.equal((filterParts(prompts, ana, team) as any).bots.find((bot: Bot) => bot.id === "mira").clarificationInstructions, undefined);
  // An invite to a chat whose bot the role can't use shows nothing: Ana's role has no Patch.
  const noBot = filterParts(parts(), ana, teamOf({ roles: [role({ bots: ["mira", "tally"] })], chats: { "c-ben": ["m_a"] } })) as any;
  assert.ok(!noBot.chats.some((chat: ChatSummary) => chat.id === "c-ben"));
  // Someone who can't start a chat is told only of the owner and the people of their chats, not the whole team.
  const reader = filterParts(parts(), ana, teamOf({ roles: [role({ perms: { ...role().perms, agents: ["view"] } })], chats: { "c-shared": ["m_a"] } })) as any;
  assert.deepEqual(reader.team.people.map((person: { id: string }) => person.id), [OWNER, "m_a"]);
  // A role that manages bots still reads their instructions; nobody but the owner reads where one came from.
  const manager = filterParts(parts(), ana, teamOf({ roles: [role({ perms: { ...role().perms, agents: ["view", "chat", "create", "manage"] } })] })) as any;
  assert.equal(manager.bots[0].instructions, "Owner's notes");
  assert.equal(manager.bots[0].origin, undefined);
  // A chat nobody marked read: new to someone invited, and as the workspace says for its starter.
  const fresh = filterParts(parts(), ben, teamOf({ chats: { "c-shared": ["m_b"] } })) as any;
  assert.equal(fresh.chats.find((chat: ChatSummary) => chat.id === "c-shared").unread, true);
  assert.equal(fresh.chats.find((chat: ChatSummary) => chat.id === "c-ben").unread, undefined);
  // The owner's parts are the owner's, untouched.
  assert.equal(filterParts(parts(), { kind: "owner" }, team).sections.length, 1);
});

test("someone invited may take part in a chat, and only its starter may change or share it", () => {
  const team = teamOf({ chats: { "c-ana": ["m_b"], "c-owner": ["m_a"] } });
  const chats: Record<string, unknown> = { "c-ana": { id: "c-ana", botId: "mira", createdBy: "m_a" }, "c-owner": { id: "c-owner", botId: "mira" }, "c-ben": { id: "c-ben", botId: "mira", createdBy: "m_b" } };
  const lookups = { chat: (id: string) => chats[id], bot: (id: string) => ({ id }) };
  const may = (who: unknown, method: string, ...args: unknown[]) => authorize(who, team, method, args, lookups);
  // Ben, invited to Ana's chat: reads, sends, stops, forks, sets his own flags.
  for (const method of ["send", "stop", "link.messages", "link.step", "forkChat", "setChatFlags", "warmChat", "sideQuestion"]) assert.equal(may(ben, method, "c-ana"), "", method);
  // He may not rename, delete, move, compact or share it.
  for (const method of ["renameChat", "deleteChat", "setChatProject", "compact", "link.team.inviteToChat"]) assert.match(may(ben, method, "c-ana", "x"), /started this chat|owner/i, method);
  // Its model is its starter's too (a role that can't set models is told that first).
  assert.match(may(ben, "setModel", "chat", "c-ana", {}), /started this chat|role can't do that/);
  // He may leave, and remove nobody else.
  assert.equal(may(ben, "link.team.removeFromChat", "c-ana", "m_b"), "");
  assert.match(may(ben, "link.team.removeFromChat", "c-ana", "m_a"), /started this chat/);
  // Ana, its starter, may do all of it; and is invited to the owner's chat but not to Ben's.
  for (const method of ["renameChat", "deleteChat", "link.team.inviteToChat", "link.team.removeFromChat"]) assert.equal(may(ana, method, "c-ana", "m_b"), "", method);
  assert.equal(may(ana, "send", "c-owner"), "");
  assert.match(may(ana, "send", "c-ben"), /belongs to the owner or another member/);
  assert.match(may(ana, "link.team.inviteToChat", "c-owner", "m_b"), /started this chat/);
  // An invite never widens a role: the chat's bot has to be one the role may use, invited or not.
  const narrow = teamOf({ roles: [role({ bots: ["patch"] })], chats: { "c-owner": ["m_a"] } });
  assert.match(authorize(ana, narrow, "send", ["c-owner"], lookups), /bot isn't available/);
  assert.match(authorize(ana, narrow, "send", ["c-ana"], lookups), /bot isn't available/);
  // Taking a card's address back is always a device's own to do.
  assert.equal(may(ben, "link.push.activity", "c-owner", null), "");
  // A chat's card on a phone is for its people.
  assert.equal(may(ben, "link.push.activity", "c-ana", "token"), "");
  assert.match(may(ben, "link.push.activity", "c-owner", "token"), /belongs to/);
  assert.equal(may({ kind: "owner" }, "link.team.inviteToChat", "c-ben", "m_a"), "");
});

test("arranging one's own view needs only to see bots; changing a bot for everyone needs more", () => {
  assert.deepEqual(TEAM_METHODS.setBotFlags, ["agents", "view"]);
  assert.deepEqual(TEAM_METHODS.reorderBots, ["agents", "view"]);
  const viewer = teamOf({ roles: [role({ perms: { ...role().perms, agents: ["view"] } })] });
  const lookups = { bot: (id: string) => ({ id }), chat: () => undefined };
  assert.equal(authorize(ana, viewer, "setBotFlags", ["mira", { hidden: true, pinned: true }], lookups), "");
  assert.equal(authorize(ana, viewer, "reorderBots", [["mira", "patch"]], lookups), "");
  assert.match(authorize(ana, viewer, "setBotFlags", ["mira", { teamwork: true }], lookups), /role can't do that/);
  const manager = teamOf({ roles: [role({ perms: { ...role().perms, agents: ["view", "manage"] } })] });
  assert.equal(authorize(ana, manager, "setBotFlags", ["mira", { teamwork: true }], lookups), "");
});

test("a routine is its maker's once the app says who made each one", () => {
  const team = teamOf();
  const chats: Record<string, unknown> = {
    "r-ana": { id: "r-ana", botId: "mira", createdBy: "m_a", schedules: [{ id: "s", routine: true, createdBy: "m_a" }] },
    "r-entry": { id: "r-entry", botId: "mira", schedules: [{ id: "s", routine: true, createdBy: "m_a" }] },
    "r-owner": { id: "r-owner", botId: "mira", schedules: [{ id: "s", routine: true }] },
  };
  const strict = { chat: (id: string) => chats[id], bot: (id: string) => ({ id }), routineOwners: true };
  for (const method of ["updateRoutine", "setRoutineEnabled", "deleteRoutine", "runRoutine", "duplicateRoutine"]) {
    assert.equal(authorize(ana, team, method, ["r-ana", "mira"], strict), "", method);
    assert.equal(authorize(ana, team, method, ["r-entry", "mira"], strict), "", method + " by the schedule's maker");
    assert.match(authorize(ana, team, method, ["r-owner", "mira"], strict), /routine belongs to the owner or another member/, method);
    assert.match(authorize(ben, team, method, ["r-ana", "mira"], strict), /routine belongs to/, method);
  }
  // An app that doesn't say yet keeps the role's word alone, so nobody loses a routine they made.
  assert.equal(authorize(ana, team, "runRoutine", ["r-owner"], { chat: (id: string) => chats[id], bot: (id: string) => ({ id }) }), "");
});

test("the phone's sheet lists a chat's people, and offers each person what they may do", () => {
  const people = [{ id: "owner", name: "Studio" }, { id: "m_a", name: "Ana" }, { id: "m_b", name: "Ben" }, { id: "m_c", name: "Cy" }];
  assert.equal(myself({ you: { kind: "member", memberId: "m_a", name: "Ana" } } as never), "m_a");
  assert.equal(myself({ you: { kind: "owner" } } as never), "owner");
  assert.equal(myself(undefined), "owner");
  const chat = { createdBy: "m_a", invited: ["m_b"] };
  assert.equal(starterOf(chat), "m_a");
  assert.equal(starterOf({}), "owner");
  // Its starter and the owner manage it; someone invited may leave; anyone else has no part in it.
  assert.equal(myPlace(chat, "m_a"), "manages");
  assert.equal(myPlace(chat, "owner"), "manages");
  assert.equal(myPlace(chat, "m_b"), "invited");
  assert.equal(myPlace(chat, "m_c"), "out");
  // The starter first, then those invited, then the rest of the team.
  const rows = peopleRows(people, chat, "m_b");
  assert.deepEqual(rows.map((row) => [row.name, row.place, row.note]), [["Ana", "starter", "Started this chat"], ["You", "invited", "Invited"], ["Studio", "out", "Not in this chat"], ["Cy", "out", "Not in this chat"]]);
  // Whoever is looking is "You".
  assert.deepEqual(peopleRows(people, chat, "m_a")[0], { id: "m_a", name: "You", place: "starter", self: true, note: "Started this chat" });
  assert.equal(sharedLine(people, chat), "Shared with Ben");
  assert.equal(sharedLine(people, { invited: ["m_b", "owner"] }), "Shared with Ben and Studio");
  assert.equal(sharedLine(people, { invited: ["m_b", "owner", "m_c"] }), "Shared with Ben and 2 others");
  assert.equal(sharedLine(people, {}), "");
  assert.equal(sharedLine(people, { invited: ["gone"] }), "");
});

test("a message names its writer only in a chat several people write in, and never for a routine", () => {
  const people = [{ id: "owner", name: "Studio" }, { id: "m_a", name: "Ana" }];
  const shared = { invited: ["m_a"] };
  const mine = { role: "user" as const };
  const ana = { role: "user" as const, author: { memberId: "m_a", name: "Ana" } };
  // The owner's phone sees Ana's messages named; its own are not.
  assert.equal(speakerLabel(ana, undefined, shared, people, "owner"), "Ana");
  assert.equal(speakerLabel(mine, undefined, shared, people, "owner"), "");
  // Ana's phone sees the owner's messages (no author) under the owner's name.
  assert.equal(speakerLabel(mine, undefined, shared, people, "m_a"), "Studio");
  assert.equal(speakerLabel(mine, undefined, shared, undefined, "m_a"), "Owner");
  // A chat of one looks as it did; so do a bot's reply and a message nobody typed.
  assert.equal(speakerLabel(ana, undefined, {}, people, "owner"), "");
  assert.equal(speakerLabel({ role: "assistant" }, undefined, shared, people, "m_a"), "");
  assert.equal(speakerLabel(mine, { scheduleId: 3 }, shared, people, "m_a"), "");
  assert.equal(speakerLabel(mine, { panelId: "p" }, shared, people, "m_a"), "");
  // A name the computer left out falls back to the team's list.
  assert.equal(speakerLabel({ role: "user", author: { memberId: "m_a" } } as never, undefined, shared, people, "owner"), "Ana");
});

/** A computer with an owner's phone and two members' phones. */
async function team() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-people-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
  link.setName("Studio");
  const clients: LinkClient[] = [];
  const follow = (pairing: Parameters<typeof pair>[1] extends never ? never : any) => {
    const parts: Record<string, any> = {};
    const client = new LinkClient(pairing, { fetch: real, onState() {}, onParts: (next) => void Object.assign(parts, next) });
    clients.push(client);
    client.start();
    const until = async (check: () => unknown, what: string) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(check(), what);
    };
    return { client, parts, until, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args) };
  };
  const owner = follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" }));
  // This owner looks at everything (Admin mode on); tests/admin-mode.test.ts has the owner without it.
  await owner.call("link.team.setAdminMode", true);
  const guest = structuredClone(link.store.data.team.roles.find((item: any) => item.id === "r_guest"));
  guest.bots = "all";
  await owner.call("link.team.saveRole", guest);
  const join_ = async (name: string) => {
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
    const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    const started = await startJoin(real, target, { name, platform: "ios", kind: "phone" });
    if (started.result.status !== "pending") throw new Error("not pending");
    await owner.call("link.team.approve", started.result.requestId);
    const checked = await checkJoin(real, started.attempt);
    if (checked.status !== "approved") throw new Error("not approved");
    return follow(checked.pairing);
  };
  const ana = await join_("Ana");
  const ben = await join_("Ben");
  await ana.until(() => ana.parts.meta?.you?.kind === "member", "Ana's phone is in step");
  await ben.until(() => ben.parts.meta?.you?.kind === "member", "Ben's phone is in step");
  return { link, backend, owner, ana, ben, stop: async () => (clients.forEach((client) => client.stop()), await link.stop()) };
}

test("an owner and two members: an invite shares one chat, and each person's view and flags stay their own", async () => {
  const { link, backend, owner, ana, ben, stop } = await team();
  try {
    assert.ok(link.meta().capabilities.includes("team-people-v1"));
    const anaId = ana.parts.meta.you.memberId as string;
    const benId = ben.parts.meta.you.memberId as string;
    const bot = (ana.parts.bots as Bot[])[0];
    // Ana starts a chat. Ben does not see it; the owner does (it is the owner's computer).
    const chatId = await ana.call<string>("createChat", bot.id);
    await ana.until(() => ana.parts.chats?.some((chat: ChatSummary) => chat.id === chatId), "Ana sees her chat");
    await owner.until(() => owner.parts.chats?.some((chat: ChatSummary) => chat.id === chatId), "the owner sees it");
    assert.ok(!ben.parts.chats?.some((chat: ChatSummary) => chat.id === chatId));
    await assert.rejects(ben.call("send", chatId, "hello", {}), /belongs to the owner or another member/);
    // Who is in it, as the app asks the link: the owner is not, so the owner is not told of its replies.
    assert.deepEqual(link.chatPeople(chatId), { createdBy: anaId, invited: [] });
    assert.equal(link.notifiesOwner(chatId), false);
    assert.equal(link.inChat(chatId, anaId), true);
    assert.deepEqual(link.chatPeople("no-such-chat"), { createdBy: OWNER, invited: [] });
    // Ana invites Ben. He sees the chat, marked as shared, and may write in it.
    assert.deepEqual(await ana.call("link.team.inviteToChat", chatId, benId), [benId]);
    await ben.until(() => ben.parts.chats?.some((chat: ChatSummary) => chat.id === chatId), "Ben sees the chat he was invited to");
    assert.deepEqual(ben.parts.chats.find((chat: ChatSummary) => chat.id === chatId).invited, [benId]);
    await owner.until(() => owner.parts.chats.find((chat: ChatSummary) => chat.id === chatId)?.invited?.length === 1, "the owner sees who was invited");
    await ben.call("send", chatId, "plan the launch", {});
    // A chat a member starts is read by them from the start: the workspace's unread mark is the owner's.
    assert.equal(typeof link.store.data.team.views[anaId].chats[chatId].seen, "number");
    assert.ok(ana.parts.meta.capabilities.includes("chat-title-regeneration-v1"));
    await assert.rejects(ben.call("regenerateChatTitle", chatId), /started this chat/);
    await ana.call("renameChat", chatId, "Working title");
    const title = await ana.call<string>("regenerateChatTitle", chatId);
    assert.equal(title, "plan the launch");
    await owner.until(() => owner.parts.chats.find((chat: ChatSummary) => chat.id === chatId)?.title === title, "the generated title reached the owner's phone");
    await ben.until(() => ben.parts.chats.find((chat: ChatSummary) => chat.id === chatId)?.title === title, "the generated title reached Ben");
    await assert.rejects(ben.call("deleteChat", chatId), /started this chat/);
    await assert.rejects(ben.call("link.team.inviteToChat", chatId, OWNER), /started this chat/);
    await assert.rejects(ana.call("link.team.inviteToChat", chatId, "m_nobody"), /no longer on the team/);
    // The owner invited too: now the owner's devices hear of it.
    await ana.call("link.team.inviteToChat", chatId, OWNER);
    assert.equal(link.notifiesOwner(chatId), true);
    // Ben's flags on the chat are his: he archives it, and it is not archived for Ana or in the workspace.
    await ben.call("setChatFlags", chatId, { archived: true });
    await ben.until(() => ben.parts.chats.find((chat: ChatSummary) => chat.id === chatId)?.archived === true, "archived for Ben");
    assert.equal(backend.state.chats.find((chat: any) => chat.id === chatId).archived, undefined);
    assert.equal(ana.parts.chats.find((chat: ChatSummary) => chat.id === chatId).archived, undefined);
    // Bots: the owner hides one for the owner; Ana still sees it. Ana hides another; nobody else is touched.
    await owner.call("setBotFlags", bot.id, { hidden: true });
    await owner.until(() => owner.parts.bots.find((item: Bot) => item.id === bot.id)?.hidden === true, "hidden for the owner");
    assert.equal(ana.parts.bots.find((item: Bot) => item.id === bot.id).hidden, undefined);
    const other = (ana.parts.bots as Bot[])[1];
    await ana.call("setBotFlags", other.id, { hidden: true, pinned: true });
    await ana.until(() => ana.parts.bots.find((item: Bot) => item.id === other.id)?.hidden === true, "hidden for Ana");
    assert.equal(!!backend.state.bots.find((item: any) => item.id === other.id).hidden, false);
    assert.equal(ben.parts.bots.find((item: Bot) => item.id === other.id).hidden, undefined);
    // Her order is hers.
    const order = (ana.parts.bots as Bot[]).map((item) => item.id).reverse();
    await ana.call("reorderBots", order);
    await ana.until(() => ana.parts.bots[0].id === order[0], "Ana's order");
    assert.notDeepEqual((ben.parts.bots as Bot[]).map((item) => item.id), order);
    // Ben leaves; the chat is gone for him. Removing a member takes their invitations and view along.
    assert.deepEqual(await ben.call("link.team.removeFromChat", chatId, benId), [OWNER]);
    await ben.until(() => !ben.parts.chats.some((chat: ChatSummary) => chat.id === chatId), "Ben left");
    await ana.call("link.team.inviteToChat", chatId, benId);
    await owner.call("link.team.removeMember", benId);
    assert.deepEqual(link.chatPeople(chatId).invited, [OWNER]);
    assert.equal(link.store.data.team.views[benId], undefined);
    // An invite never widens a role: with a role that has no bots, the person can't be invited.
    const none = structuredClone(link.store.data.team.roles.find((item: any) => item.id === "r_guest"));
    none.bots = [];
    await owner.call("link.team.saveRole", none);
    const ownersChat = backend.state.chats.find((chat: any) => !chat.createdBy && !chat.botIds).id;
    await assert.rejects(owner.call("link.team.inviteToChat", ownersChat, anaId), /role can't use this chat's bot/);
    none.bots = "all";
    await owner.call("link.team.saveRole", none);
    // Deleting the chat drops its people and everyone's marks on it.
    await ana.call("deleteChat", chatId);
    assert.equal(link.store.data.team.chats[chatId], undefined);
    assert.equal(link.store.data.team.views[anaId].chats[chatId], undefined);
  } finally {
    await stop();
  }
});

test("the owner renames a member, and the new name shows in the team, to the member and on their devices", async () => {
  const { link, owner, ana, ben, stop } = await team();
  try {
    // Older computers do not name it, so the phone hides "Rename".
    assert.ok(link.meta().capabilities.includes("member-rename-v1"));
    assert.equal(TEAM_METHODS["link.team.renameMember"], "owner");
    const anaId = ana.parts.meta.you.memberId as string;
    const benId = ben.parts.meta.you.memberId as string;
    await ben.until(() => ben.parts.team?.people?.some((person: { name: string }) => person.name === "Ana"), "Ben sees Ana");

    // The answer is the owner's team part, with the name cleaned.
    const after = await owner.call<{ members: { id: string; name: string; devices: { id: string; person?: string }[] }[]; people: { id: string; name: string }[] }>("link.team.renameMember", anaId, "  Ana Ortiz ");
    assert.equal(after.members.find((member) => member.id === anaId)?.name, "Ana Ortiz");
    assert.equal(after.members.find((member) => member.id === benId)?.name, "Ben", "nobody else is renamed");
    assert.equal(after.people.find((person) => person.id === anaId)?.name, "Ana Ortiz");
    assert.equal(after.members.find((member) => member.id === anaId)?.devices[0].person, "Ana Ortiz");
    // Kept by the host: the member's devices carry it, and a session's principal (author labels) uses it.
    const device = link.store.data.devices.find((item: any) => item.memberId === anaId);
    assert.equal(device.person, "Ana Ortiz");
    assert.equal(link.principal(device.id).name, "Ana Ortiz");
    // Everyone's phone is told: the member's own, and the other member's list of people.
    await ana.until(() => ana.parts.meta?.you?.name === "Ana Ortiz", "Ana's phone has her new name");
    await ben.until(() => ben.parts.team?.people?.some((person: { name: string }) => person.name === "Ana Ortiz"), "Ben sees the new name");
    assert.ok(!ben.parts.team.people.some((person: { name: string }) => person.name === "Ana"));
    // The app on the computer reads the same name.
    assert.equal(link.teamForApp().members.find((member: any) => member.id === anaId).name, "Ana Ortiz");
  } finally {
    await stop();
  }
});

test("only the owner renames a member, and the name must be a name", async () => {
  const { owner, ana, ben, stop } = await team();
  try {
    const anaId = ana.parts.meta.you.memberId as string;
    const benId = ben.parts.meta.you.memberId as string;
    // A member's device is refused, for another member and for themselves.
    await assert.rejects(ana.call("link.team.renameMember", benId, "Benny"), /owner/i);
    await assert.rejects(ana.call("link.team.renameMember", anaId, "Anya"), /owner/i);
    // Empty, blank, too long (over 60) and control characters are refused.
    for (const name of ["", "   ", "x".repeat(61), "Ana\u0007", "Ana\nOrtiz", 42, null]) await assert.rejects(owner.call("link.team.renameMember", anaId, name), /name of up to 60 characters/, JSON.stringify(name));
    await owner.call("link.team.renameMember", anaId, "x".repeat(60));
    // A member who is not on the team.
    await assert.rejects(owner.call("link.team.renameMember", "m_nobody", "Zed"), /no longer on the team/);
    // Nothing changed with the refusals.
    await ben.until(() => ben.parts.team?.people?.some((person: { name: string }) => person.name === "x".repeat(60)), "only the valid rename went through");
    assert.ok(ben.parts.team.people.some((person: { id: string; name: string }) => person.id === benId && person.name === "Ben"));
  } finally {
    await stop();
  }
});
