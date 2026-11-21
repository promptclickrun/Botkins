// Sections on the Chats screen ("chat-sections-v1"; docs/link-contract.md): each person's own way to
// group their chats. The link keeps them, for the owner as for a member, and nobody sees another's.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChatSections } from "../link-host/chat-sections.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { CHAT_SECTION_LIMITS, chatSectionsOf, OWNER, TEAM_METHODS, viewOf, withChatSections } from "../link-host/team.mjs";
import { arrangeChats, chatDropPlan, groupAt, listItems, moveChoices, sectionMoves } from "../src/features/chat/sections";
import { checkJoin, type FetchLike, LinkClient, pair, startJoin } from "../src/link/client";
import type { ChatSummary, Section } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

test("a person's sections: made, named, ordered and deleted, each rule with its sentence", () => {
  let team: any = { views: {}, chats: {}, members: [{ id: "m_a", name: "Ana", groupId: "g" }] };
  const chats = [{ id: "c1" }, { id: "c2", createdBy: "m_a" }];
  const sections = new ChatSections({ team: () => team, setTeam: (next: any) => void (team = next), chats: () => chats });
  assert.deepEqual(sections.for(OWNER), { list: [], of: {} });
  const work = sections.add(OWNER, "  Work ");
  const home = sections.add(OWNER, "Home");
  assert.match(work, /^cs_[A-Za-z0-9_-]{11}$/);
  assert.deepEqual(sections.for(OWNER).list, [{ id: work, name: "Work" }, { id: home, name: "Home" }]);
  // A name is 1 to 40 characters, and no two of a person's sections share one.
  for (const bad of ["", "   ", "x".repeat(41), "a\nb", 7, null]) assert.throws(() => sections.add(OWNER, bad), /Give the section a name of up to 40 characters\./);
  assert.throws(() => sections.add(OWNER, "work"), /You already have a section with that name\./);
  assert.throws(() => sections.rename(OWNER, home, "WORK"), /already have a section/);
  sections.rename(OWNER, home, "Home");
  sections.rename(OWNER, home, "House");
  assert.throws(() => sections.rename(OWNER, "cs_gone", "x"), /This section no longer exists\./);
  // Another person may use the same name: sections are each person's own.
  const hers = sections.add("m_a", "Work");
  assert.notEqual(hers, work);
  assert.deepEqual(sections.for("m_a").list.map((section: Section) => section.name), ["Work"]);
  assert.deepEqual(sections.for(OWNER).list.map((section: Section) => section.name), ["Work", "House"]);

  // A chat goes in one section, or in none. Only a chat the person is in, and only a section they have.
  sections.set(OWNER, "c1", work);
  sections.set(OWNER, "c1", home);
  assert.deepEqual(sections.for(OWNER).of, { c1: home });
  assert.throws(() => sections.set(OWNER, "c1", hers), /This section no longer exists\./);
  assert.throws(() => sections.set(OWNER, "nope", work), /This chat no longer exists\./);
  assert.throws(() => sections.set("m_a", "c1", hers), /This chat no longer exists\./, "the owner's chat is not hers");
  sections.set("m_a", "c2", hers);
  sections.set(OWNER, "c1", null);
  assert.deepEqual(sections.for(OWNER).of, {});
  sections.set(OWNER, "c1", home);

  // The person's order. Unknown ids are dropped; a section not named keeps its place after the named ones.
  sections.order(OWNER, [home, "cs_gone", home]);
  assert.deepEqual(sections.for(OWNER).list.map((section: Section) => section.id), [home, work]);
  sections.order(OWNER, "nonsense");
  assert.deepEqual(sections.for(OWNER).list.map((section: Section) => section.id), [home, work]);

  // Deleting a section leaves its chats in the list, in no section.
  sections.remove(OWNER, home);
  assert.deepEqual(sections.for(OWNER), { list: [{ id: work, name: "Work" }], of: {} });
  sections.remove(OWNER, home);
  // Thirty at most.
  for (let n = sections.for(OWNER).list.length; n < CHAT_SECTION_LIMITS.sections; n++) sections.add(OWNER, "S" + n);
  assert.throws(() => sections.add(OWNER, "One more"), /You have 30 sections\. Delete one first\./);
  // Nothing of hers changed, and a member's other marks keep their sections beside them.
  assert.deepEqual(sections.for("m_a"), { list: [{ id: hers, name: "Work" }], of: { c2: hers } });
  assert.deepEqual(viewOf(team, "m_a").chatSections, team.views.m_a.chatSections);
});

test("what is kept is read with nothing missing, and a chat carries only its own person's section", () => {
  const team = { views: { owner: { chatSections: { list: [{ id: "a", name: "A" }, { id: 5 }, null], of: { c1: "a", c2: "gone", c3: 9 } } }, m: { chatSections: "nonsense" } } };
  assert.deepEqual(chatSectionsOf(team, OWNER), { list: [{ id: "a", name: "A" }], of: { c1: "a" } });
  assert.deepEqual(chatSectionsOf(team, "m"), { list: [], of: {} });
  assert.deepEqual(chatSectionsOf(undefined, OWNER), { list: [], of: {} });
  // Another person's section on a chat is taken off before theirs is put on.
  assert.deepEqual(withChatSections([{ id: "c1", sectionId: "theirs" }, { id: "c2", sectionId: "theirs" }], { list: [], of: { c1: "mine" } }), [{ id: "c1", sectionId: "mine" }, { id: "c2" }]);
  for (const name of ["link.chats.addSection", "link.chats.renameSection", "link.chats.deleteSection", "link.chats.orderSections", "link.chats.setSection"]) assert.deepEqual(TEAM_METHODS[name], ["agents", "view"], name);
});

test("the Chats screen: pinned, then each section, then the days; and the menu's choices", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "b", title: id, time: now - 1000, count: 1, ...more });
  const sections = [{ id: "s1", name: "Work" }, { id: "s2", name: "Home" }];
  const chats = [chat("a", { sectionId: "s1" }), chat("b", { pinned: true, sectionId: "s1" }), chat("c", { time: now - 3 * 86_400_000 }), chat("d", { sectionId: "gone" }), chat("e", { sectionId: "s1", time: now - 10 })];
  const arranged = arrangeChats(chats, sections, now);
  assert.deepEqual(arranged.map((group) => [group.key, group.title, group.chats.map((one) => one.id)]), [
    ["pinned", "Pinned", ["b"]],
    ["section:s1", "Work", ["e", "a"]],
    ["section:s2", "Home", []],
    ["day:Today", "Today", ["d"]],
    ["day:Earlier", "Earlier", ["c"]],
  ]);
  // Without sections the list is what it was: no empty groups.
  assert.deepEqual(arrangeChats(chats, undefined, now).map((group) => group.key), ["pinned", "day:Today", "day:Earlier"]);
  // While searching, a section with no match is left out.
  assert.deepEqual(arrangeChats([chats[2]!], sections, now, { searching: true }).map((group) => group.key), ["day:Earlier"]);

  // "Move to section": each section with the chat's own checked, "None", then "New section…".
  assert.deepEqual(moveChoices(chats[0]!, sections), [
    { id: "section:s1", title: "Work", on: true },
    { id: "section:s2", title: "Home", on: false },
    { id: "section:none", title: "None", on: false },
    { id: "section:new", title: "New section…", on: false },
  ]);
  assert.equal(moveChoices(chats[3]!, sections).find((choice) => choice.id === "section:none")!.on, true, "a section that is gone counts as none");
  // A section's place among the others: what Move up and Move down send.
  assert.deepEqual(sectionMoves(sections, "s1"), { up: null, down: ["s2", "s1"] });
  assert.deepEqual(sectionMoves(sections, "s2"), { up: ["s2", "s1"], down: null });
});

test("dragging a chat: the group it is over, and what a drop there asks", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "b", title: id, time: now - 1000, count: 1, ...more });
  const sections = [{ id: "s1", name: "Work" }, { id: "s2", name: "Home" }];
  const chats = [chat("a", { sectionId: "s1" }), chat("b", { sectionId: "s1" }), chat("c")];
  // While a chat is dragged, Pinned shows also when empty.
  const groups = arrangeChats(chats, sections, now, { dragging: true });
  assert.deepEqual(groups.map((group) => group.key), ["pinned", "section:s1", "section:s2", "day:Today"]);
  // When every chat is in a section, there is a place to take one out.
  assert.deepEqual(arrangeChats(chats.slice(0, 2), sections, now, { dragging: true }).map((group) => group.key), ["pinned", "section:s1", "section:s2", "none"]);
  // A folded section is its heading only.
  const items = listItems(groups, ["s2"]);
  assert.deepEqual(items.map((item) => item.key), ["head:pinned", "head:section:s1", "chat:a", "chat:b", "head:section:s2", "head:day:Today", "chat:c"]);
  assert.deepEqual(listItems(groups, ["s1"]).map((item) => item.key), ["head:pinned", "head:section:s1", "head:section:s2", "head:day:Today", "chat:c"]);

  // Each item is 40 high, one under the other: Pinned 0–40, Work 40–160, Home 160–200, Today 200–280.
  const ys = items.map((_item, index) => index * 40);
  const hs = items.map(() => 40);
  assert.equal(groupAt(items, ys, hs, 10), "pinned");
  assert.equal(groupAt(items, ys, hs, 100), "section:s1");
  assert.equal(groupAt(items, ys, hs, 180), "section:s2");
  assert.equal(groupAt(items, ys, hs, 260), "day:Today");
  assert.equal(groupAt(items, ys, hs, 9999), "day:Today", "below the list: the last group");
  assert.equal(groupAt(items, ys, hs, -50), "pinned");
  // Archived chats are no place to drop: the nearest other group is.
  const withArchive = [...items, { key: "head:archived", kind: "head" as const, group: "archived" }, { key: "chat:z", kind: "row" as const, group: "archived", chatId: "z" }];
  assert.equal(groupAt(withArchive, withArchive.map((_item, index) => index * 40), withArchive.map(() => 40), 330), "day:Today");
  assert.equal(groupAt([], [], [], 5), "");

  // What a drop asks.
  assert.deepEqual(chatDropPlan(chats[2]!, sections, "section:s1"), { sectionId: "s1" });
  assert.equal(chatDropPlan(chats[0]!, sections, "section:s1"), undefined, "already there");
  assert.deepEqual(chatDropPlan(chats[0]!, sections, "section:s2"), { sectionId: "s2" });
  assert.deepEqual(chatDropPlan(chats[0]!, sections, "day:Today"), { sectionId: null });
  assert.deepEqual(chatDropPlan(chats[0]!, sections, "none"), { sectionId: null });
  assert.equal(chatDropPlan(chats[2]!, sections, "day:Earlier"), undefined, "in no section already");
  assert.deepEqual(chatDropPlan(chats[2]!, sections, "pinned"), { pinned: true });
  // A pinned chat dropped on a section goes there and is unpinned, so it shows there.
  assert.deepEqual(chatDropPlan(chat("p", { pinned: true }), sections, "section:s1"), { pinned: false, sectionId: "s1" });
  assert.deepEqual(chatDropPlan(chat("p", { pinned: true, sectionId: "s1" }), sections, "day:Today"), { pinned: false, sectionId: null });
  assert.equal(chatDropPlan(chats[2]!, sections, "section:gone"), undefined);
  assert.equal(chatDropPlan(chats[2]!, sections, "archived"), undefined);
});

/** The demo computer with the owner's phone, and a way to let a member in. */
async function team() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-chat-sections-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
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
    return { parts, until, chat: (id: string) => (parts.chats as ChatSummary[] | undefined)?.find((one) => one.id === id), call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args) };
  };
  const owner = follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" }));
  const join_ = async (name: string) => {
    const collab = structuredClone(link.store.data.team.roles.find((one: any) => one.id === "r_collab"));
    collab.bots = "all";
    await owner.call("link.team.saveRole", collab);
    await owner.call("link.team.saveGroup", { id: "g_makers", name: "Makers", roleId: "r_collab" });
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

test("the demo: the owner and a member each keep their own sections, and a deleted chat leaves them", async () => {
  const { link, backend, owner, join: join_, stop } = await team();
  try {
    assert.ok(link.meta().capabilities.includes("chat-sections-v1"));
    await owner.until(() => owner.parts.chats?.length, "the owner is sent chats");
    assert.deepEqual(owner.parts.chatSections, []);
    const [first, second] = (owner.parts.chats as ChatSummary[]).filter((chat) => !chat.archived);
    const work = await owner.call<string>("link.chats.addSection", "Work");
    await owner.call("link.chats.addSection", "Later");
    await owner.call("link.chats.setSection", first!.id, work);
    await owner.until(() => owner.chat(first!.id)?.sectionId === work, "the chat is in the section");
    assert.deepEqual((owner.parts.chatSections as Section[]).map((section) => section.name), ["Work", "Later"]);
    assert.equal(owner.chat(second!.id)!.sectionId, undefined);
    // The app never hears of sections: they are not the workspace's.
    assert.ok(!JSON.stringify(backend.state.chats).includes(work));
    assert.ok(!backend.callContexts.some((entry: any) => String(entry.method).startsWith("link.chats")));
    // For the app's own window: the same, host-side, by person.
    assert.deepEqual(link.chatSectionsFor(OWNER).of, { [first!.id]: work });
    link.setChatSection(OWNER, second!.id, work);
    await owner.until(() => owner.chat(second!.id)?.sectionId === work, "set from the window, seen on the phone");

    // A member has none of the owner's, and makes her own.
    const ana = await join_("Ana");
    await ana.until(() => ana.parts.chatSections, "Ana is sent her sections");
    assert.deepEqual(ana.parts.chatSections, []);
    const anaId = ana.parts.meta.you.memberId as string;
    const mine = await ana.call<string>("createChat", backend.state.bots[0].id);
    const hers = await ana.call<string>("link.chats.addSection", "Work");
    await ana.call("link.chats.setSection", mine, hers);
    await ana.until(() => ana.chat(mine)?.sectionId === hers, "her chat is in her section");
    await assert.rejects(ana.call("link.chats.setSection", first!.id, hers), /chat/i, "not a chat she is in");
    await assert.rejects(ana.call("link.chats.setSection", mine, work), /This section no longer exists\./, "not her section");
    // The owner is invited to her chat: each sees it in their own section, or in none.
    await ana.call("link.team.inviteToChat", mine, OWNER);
    await owner.until(() => owner.chat(mine), "the owner is sent her chat");
    assert.equal(owner.chat(mine)!.sectionId, undefined, "her section is hers alone");
    await owner.call("link.chats.setSection", mine, work);
    await owner.until(() => owner.chat(mine)?.sectionId === work, "the owner files it too");
    assert.equal(ana.chat(mine)!.sectionId, hers);
    assert.deepEqual((owner.parts.chatSections as Section[]).map((section) => section.id).includes(hers), false);

    // The order is the person's, and deleting a section leaves its chats.
    const later = (owner.parts.chatSections as Section[])[1]!.id;
    await owner.call("link.chats.orderSections", [later, work]);
    await owner.until(() => (owner.parts.chatSections as Section[])[0]?.id === later, "the order changed");
    await owner.call("link.chats.deleteSection", work);
    await owner.until(() => !owner.chat(first!.id)?.sectionId && owner.chat(first!.id), "its chats are in no section");
    assert.equal(ana.chat(mine)!.sectionId, hers, "hers did not change");

    // A deleted chat leaves everyone's sections.
    await ana.call("deleteChat", mine);
    await ana.until(() => !ana.chat(mine), "the chat is gone");
    assert.deepEqual(link.store.data.team.views[anaId].chatSections.of, {});
    assert.deepEqual(link.chatSectionsFor(OWNER).of, {});
  } finally {
    await stop();
  }
});
