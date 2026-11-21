// Admin mode (docs/link-contract.md, "Admin mode"; docs/spaces.md): with it off, an owner device is
// sent what the owner is part of, not every member's chats, spaces and bots. It changes what the
// owner is shown, never what the owner may do. It is each owner device's own, and off at first.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { authorize, OWNER, ownerParts, spaceCan, spaceView, TEAM_METHODS } from "../link-host/team.mjs";
import { checkJoin, type FetchLike, LinkClient, pair, startJoin } from "../src/link/client";
import type { Bot, ChatSummary, SpaceContent, SpaceSummary } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const teamOf = (more: Record<string, unknown> = {}) => ({ roles: [], groups: [], members: [{ id: "m_a", name: "Ana", groupId: "g" }], chats: {}, views: {}, spaces: {}, ...more });
const names = new Map([[OWNER, "Alex"], ["m_a", "Ana"]]);

test("with Admin mode off an owner device is sent what the owner is part of", () => {
  const team = teamOf({ chats: { "c-shared": [OWNER] }, spaces: { s_trip: { access: "members", grants: [{ id: OWNER, can: "view" }] }, s_all: { access: "team", teamCan: "view" } } });
  const records = [
    { id: "s_today", name: "Today", builtin: "today", createdAt: 1, updatedAt: 1, rev: 1, items: [{ id: "p1", botId: "mira", updatedAt: 1 }] },
    { id: "s_ana", name: "Today", builtin: "today", createdBy: "m_a", createdAt: 1, updatedAt: 1, rev: 1, items: [{ id: "p2", botId: "anas-bot", updatedAt: 1 }] },
    { id: "s_trip", name: "Trip", createdBy: "m_a", createdAt: 1, updatedAt: 1, rev: 1, items: [{ id: "p3", botId: "trip-bot", updatedAt: 1 }] },
    { id: "s_all", name: "Everyone", createdBy: "m_a", createdAt: 1, updatedAt: 1, rev: 1, items: [] },
  ];
  const parts = {
    meta: { name: "Studio", you: { kind: "owner", admin: true } },
    settings: { appearance: "dark" },
    team: { members: [{ id: "m_a" }] },
    projects: [{ id: "proj" }],
    bots: [{ id: "mira" }, { id: "anas-bot", createdBy: "m_a" }, { id: "trip-bot", createdBy: "m_a" }, { id: "shared-bot", createdBy: "m_a" }, { id: "asking-bot", createdBy: "m_a" }, { id: "old-bot" }],
    chats: [
      { id: "c-mine", botId: "mira" },
      { id: "c-ana", botId: "anas-bot", createdBy: "m_a" },
      { id: "c-shared", botId: "shared-bot", createdBy: "m_a" },
      { id: "c-asking", botId: "asking-bot", createdBy: "m_a" },
    ],
    live: { streams: { "c-mine": "…", "c-ana": "…" }, intents: {}, thinking: {}, speakers: {}, queued: {}, active: ["c-mine", "c-ana"], requests: [{ id: "q1", chatId: "c-ana", kind: "question" }, { id: "q2", chatId: "c-asking", kind: "permission" }, { id: "q3", chatId: "c-mine", kind: "question" }] },
    runs: [{ id: "r1", chatId: "c-mine" }, { id: "r2", chatId: "c-ana" }, { id: "r3", chatId: "c-asking" }],
    panels: [{ id: "p1", spaceId: "s_today", botId: "mira" }, { id: "p2", spaceId: "s_ana", botId: "anas-bot" }, { id: "legacy", botId: "mira" }],
    board: [{ id: "b1", spaceId: "s_today", botId: "mira" }, { id: "b2", spaceId: "s_ana", botId: "anas-bot" }],
    projectPanels: [{ id: "p1", spaceId: "s_today", botId: "mira", projectId: "proj" }, { id: "p2", spaceId: "s_ana", botId: "anas-bot", projectId: "proj" }],
    "chat:c-mine": { id: "c-mine" },
    "chat:c-ana": { id: "c-ana" },
    "run:c-ana": { id: "r2" },
  };
  const seen = ownerParts(parts, team, { spaces: records, names }) as any;
  // Chats: the owner's own, one the owner was invited to, and one where a bot waits for the owner's approval.
  assert.deepEqual(seen.chats.map((chat: ChatSummary) => chat.id), ["c-mine", "c-shared", "c-asking"]);
  assert.deepEqual(Object.keys(seen.live.streams), ["c-mine"]);
  assert.deepEqual(seen.live.active, ["c-mine"]);
  // A request only the owner can answer still reaches the owner, with its chat; a member's question does not.
  assert.deepEqual(seen.live.requests.map((request: { id: string }) => request.id), ["q2", "q3"]);
  assert.deepEqual(seen.runs.map((run: { id: string }) => run.id), ["r1", "r3"]);
  assert.deepEqual([seen["chat:c-mine"], seen["chat:c-ana"], seen["run:c-ana"]], [{ id: "c-mine" }, null, null]);
  // Spaces: the owner's own and those shared with the owner. Not a member's private one.
  assert.deepEqual(seen.spaces.map((space: SpaceSummary) => space.id).sort(), ["s_all", "s_today", "s_trip"]);
  assert.deepEqual(seen.panels.map((panel: { id: string }) => panel.id), ["p1", "legacy"]);
  assert.deepEqual(seen.board.map((card: { id: string }) => card.id), ["b1"]);
  // A panel with a project in a member's private space is not listed on the project either.
  assert.deepEqual(seen.projectPanels.map((panel: { id: string }) => panel.id), ["p1"]);
  // Bots: a member's bot is left out unless something listed uses it. One with no mark counts as the owner's.
  assert.deepEqual(seen.bots.map((bot: Bot) => bot.id), ["mira", "trip-bot", "shared-bot", "asking-bot", "old-bot"]);
  // What is the owner's alone stays, and the device is told which way it looks.
  assert.deepEqual([seen.settings, seen.team, seen.projects], [parts.settings, parts.team, parts.projects]);
  assert.deepEqual(seen.meta.you, { kind: "owner", admin: false });
  assert.equal(parts.chats.length, 4, "the full parts are untouched");
  // It is a way of looking, not a lock: the owner may still do everything.
  assert.equal(spaceCan(team, records[1], OWNER), "own");
  assert.equal(spaceCan(team, records[1], OWNER, { plain: true }), null);
  assert.equal(spaceCan(team, records[2], OWNER, { plain: true }), "view");
  assert.equal(authorize({ kind: "owner" }, team, "send", ["c-ana"], {}), "");
  // The same list for the app on the host, and "From members" only with Admin mode on.
  assert.equal(spaceView(team, records, OWNER, { names }).length, 4);
  assert.equal(spaceView(team, records, OWNER, { names, partOnly: true }).length, 3);
  // An app without spaces: chats and bots are cut the same way, and no `spaces` part is made up.
  const plain = ownerParts({ ...parts, spaces: undefined }, team) as any;
  assert.equal(plain.spaces, undefined);
  assert.deepEqual(plain.panels.length, 3);
  assert.equal(TEAM_METHODS["link.team.setAdminMode"], "owner");
});

async function team() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-admin-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
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
    return { client, parts, until, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args) };
  };
  const pairOwner = async (name: string) => follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name, platform: "ios" }));
  const phone = await pairOwner("Owner phone");
  const collab = structuredClone(link.store.data.team.roles.find((one: any) => one.id === "r_collab"));
  collab.bots = "all";
  await phone.call("link.team.saveRole", collab);
  await phone.call("link.team.saveGroup", { id: "g_makers", name: "Makers", roleId: "r_collab" });
  const invite = await phone.call<any>("link.team.createInvite", { groupId: "g_makers", days: 7, maxUses: 1 });
  const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
  const started = await startJoin(real, target, { name: "Ana", platform: "ios", kind: "phone" });
  if (started.result.status !== "pending") throw new Error("not pending");
  await phone.call("link.team.approve", started.result.requestId);
  const checked = await checkJoin(real, started.attempt);
  if (checked.status !== "approved") throw new Error("not approved");
  const ana = follow(checked.pairing);
  await ana.until(() => ana.parts.meta?.you?.kind === "member" && ana.parts.spaces?.length === 4, "Ana is in");
  return { link, backend, phone, ana, pairOwner, stop: async () => (clients.forEach((client) => client.stop()), await link.stop()) };
}

test("the demo: Admin mode is each owner device's own, off at first, and changes only what is shown", async () => {
  const { link, backend, phone, ana, pairOwner, stop } = await team();
  try {
    const anaId = ana.parts.meta.you.memberId as string;
    const has = (parts: Record<string, any>, id: string) => (parts.chats as ChatSummary[] | undefined)?.some((chat) => chat.id === id);
    const spacesOf = (parts: Record<string, any>, by: string) => (parts.spaces as SpaceSummary[]).filter((space) => space.by.id === by);
    await phone.until(() => phone.parts.meta?.you, "the owner's phone is in step");
    assert.deepEqual(phone.parts.meta.you, { kind: "owner", admin: false }, "off at first");
    // Ana starts a chat. The owner's phone is not sent it, nor her spaces.
    const bot = (ana.parts.bots as Bot[])[0].id;
    const chatId = await ana.call<string>("createChat", bot);
    await ana.until(() => has(ana.parts, chatId), "Ana has her chat");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(!has(phone.parts, chatId), "a member's chat is not in the owner's list");
    assert.equal(spacesOf(phone.parts, anaId).length, 0, "nor her spaces");
    const before = (phone.parts.chats as ChatSummary[]).length;
    // It is a way of looking, not a lock: the owner may still read and write there.
    const anaToday = link.spacesFor(OWNER).find((space: SpaceSummary) => space.by.id === anaId && space.builtin === "today")!.id;
    assert.equal((await phone.call<SpaceContent>("spaces.read", anaToday)).id, anaToday);
    assert.equal(((await phone.call<any>("link.messages", chatId, 0, 10)) as { id: string }).id, chatId);
    // A bot in Ana's chat needs an approval: only the owner can give it, so it reaches the owner with its chat.
    await ana.call("send", chatId, "please approve the deploy", {});
    await phone.until(() => phone.parts.live?.requests?.some((request: any) => request.chatId === chatId), "the approval reaches the owner");
    await phone.until(() => has(phone.parts, chatId), "and its chat is listed while it waits");
    const request = phone.parts.live.requests.find((one: any) => one.chatId === chatId);
    await phone.call("respond", request.id, { action: "approve" });
    await phone.until(() => !has(phone.parts, chatId), "answered: the chat leaves the owner's list again");

    // The owner turns Admin mode on, on this phone: everything, as before, and the device says so.
    assert.equal(await phone.call("link.team.setAdminMode", true), true);
    await phone.until(() => phone.parts.meta.you.admin === true && has(phone.parts, chatId), "Admin mode on: the member's chat is listed");
    assert.equal(spacesOf(phone.parts, anaId).length, 4, "and her spaces (From members)");
    assert.ok((phone.parts.chats as ChatSummary[]).length > before);
    // A second owner device keeps its own way of looking.
    const desk = await pairOwner("Owner tablet");
    await desk.until(() => desk.parts.meta?.you && desk.parts.chats, "the second device is in step");
    assert.equal(desk.parts.meta.you.admin, false);
    assert.ok(!has(desk.parts, chatId));
    // Off again: the list is the owner's own once more.
    assert.equal(await phone.call("link.team.setAdminMode", false), false);
    await phone.until(() => phone.parts.meta.you.admin === false && !has(phone.parts, chatId), "Admin mode off");
    assert.equal(spacesOf(phone.parts, anaId).length, 0);
    // Invited to her chat, the owner has it without Admin mode.
    await ana.call("link.team.inviteToChat", chatId, OWNER);
    await phone.until(() => has(phone.parts, chatId), "invited: listed");
    // A member has no Admin mode.
    await assert.rejects(ana.call("link.team.setAdminMode", true), /Only the owner/);
    assert.equal(link.store.setAdmin(link.store.data.devices.find((device: any) => device.memberId).id, true), false);
    // For the app on the host: the same cut of its own lists, and the owner's spaces either way.
    const cut = link.ownerParts({ chats: [{ id: "x", botId: bot, createdBy: anaId }, { id: "y", botId: bot }], bots: backend.state.bots });
    assert.deepEqual(cut.chats.map((chat: { id: string }) => chat.id), ["y"]);
    assert.equal(link.spacesFor(OWNER, { admin: false }).every((space: SpaceSummary) => space.by.id === OWNER), true);
    assert.ok(link.spacesFor(OWNER).some((space: SpaceSummary) => space.by.id === anaId));
  } finally {
    await stop();
  }
});
