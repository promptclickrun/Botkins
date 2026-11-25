// Admin mode for the owner's own window (desktop/admin-view.mjs): this computer's choice, and
// what the window is shown with it off and on. The rule is the link's (`ownerParts`); these tests
// run it with a real link host and a real workspace in one process, as the desktop app has them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminModeStore, hasAdminMode, ownerWindowView } from "../desktop/admin-view.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { linkCapabilities } from "../desktop/runtime.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-admin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let link;
  const ws = new Workspace(join(dir, "app"), fakeClient().client, () => {}, { team: () => link?.team(), people: (chatId) => link?.chatPeople?.(chatId), spaceCan: (space, person) => link?.spaceCan?.(space, person) });
  link = new LinkHost({
    dir: join(dir, "link"),
    port: 0,
    relay: false,
    backend: {
      info: () => ({ app: "botkins", version: "0", platform: process.platform }),
      capabilities: linkCapabilities(),
      snapshot: () => ws.snapshot(),
      subscribe: () => () => {},
      call: async () => {},
      spaces: { ensure: (person) => ws.spaces.ensure(person), release: (id) => ws.spaces.memberRemoved(id), snapshot: (id) => ws.spaces.snapshot(id) },
    },
  });
  t.after(() => link.stop?.());
  link.store.data.team.members.push({ id: "m_avery", name: "Avery", groupId: "g_everyone", joinedAt: 1, deviceIds: [] });
  // The owner's: a chat, the starter bots, and a panel in the owner's Today.
  ws.spaces.ensure("owner");
  const owners = ws.createChat("pip");
  const today = ws.spaces.ensure("owner").today.id;
  ws.state.panels.push({ id: "p_owner", key: "mine", botId: "pip", spaceId: today, title: "Mine", blocks: [], revision: 1, hidden: false });
  // A member's: a bot they made, a chat with it, and a space with a panel of that bot.
  const helper = await ws.agents.create({ name: "Avery's helper", role: "Helper", instructions: "Help." }, "m_avery");
  const averys = ws.createChat(helper);
  ws.chat(averys).createdBy = "m_avery";
  const launch = ws.spaces.create({ name: "Avery's launch" }, "m_avery");
  ws.state.panels.push({ id: "p_avery", key: "theirs", botId: helper, spaceId: launch, title: "Theirs", blocks: [], revision: 1, hidden: false });
  ws.state.runs.push({ id: "run-owner", chatId: owners, status: "Completed" }, { id: "run-avery", chatId: averys, status: "Completed" });
  ws.save();
  const view = (admin, more = {}) => ownerWindowView({ ...ws.snapshot(), ...more }, link, admin);
  return { dir, ws, link, view, owners, averys, helper, launch, today };
}

test("this computer's own choice is off at first, is kept in a file of its own, and a file that can't be read is off", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-admin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "data", "window.json");
  const store = adminModeStore(file);
  assert.equal(store.get(), false);
  assert.equal(store.set(true), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { adminMode: true });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(adminModeStore(file).get(), true, "kept when the app starts again");
  // Only `true` turns it on.
  for (const value of ["yes", 1, null, undefined, {}]) assert.equal(store.set(value), false, String(value));
  assert.equal(adminModeStore(file).get(), false);
  for (const text of ["", "not json", "[true]", '{"adminMode":"true"}', "null"]) {
    writeFileSync(file, text);
    assert.equal(adminModeStore(file).get(), false, text);
  }
});

test("with Admin mode off the owner's window is shown what the owner is part of, and with it on everything", async (t) => {
  const { view, owners, averys, helper, launch, today, link } = await setup(t);
  assert.equal(hasAdminMode(link), true);
  const streams = { [owners]: "Writing…", [averys]: "Writing…" };

  const off = view(false, { streams, intents: { [owners]: "a", [averys]: "b" } });
  assert.equal(off.adminMode, false);
  assert.equal(off.chats.filter(c => c.main).length, 3);
  assert.ok(off.chats.every(c => !c.createdBy));
  assert.deepEqual(off.chats.filter(chat => !chat.main).map((chat) => chat.id), [owners], "the member's chat is not listed");
  assert.deepEqual(off.runs.map((run) => run.id), ["run-owner"]);
  assert.equal(off.bots.some((bot) => bot.id === helper), false, "nor the bot the member made");
  assert.ok(off.bots.some((bot) => bot.id === "pip"));
  assert.deepEqual(off.panels.map((panel) => panel.id), ["p_owner"]);
  assert.deepEqual([Object.keys(off.streams), Object.keys(off.intents)], [[owners], [owners]], "nor what is being written there now");
  assert.equal(off.spaces.some((space) => space.id === launch), false, "nor the member's space");
  assert.ok(off.spaces.some((space) => space.id === today));
  // Everything that is the owner's alone stays as it is.
  assert.ok(off.settings && Array.isArray(off.projects));
  // The window's `spaces` is the owner's view, never the app's own records.
  assert.equal("items" in off.spaces[0], false);
  assert.equal(typeof off.spaces[0].can, "string");

  const on = view(true, { streams });
  assert.equal(on.adminMode, true);
  assert.deepEqual(on.chats.filter(chat => !chat.main).map((chat) => chat.id).sort(), [owners, averys].sort());
  assert.ok(on.bots.some((bot) => bot.id === helper));
  assert.deepEqual(on.panels.map((panel) => panel.id), ["p_owner", "p_avery"]);
  assert.deepEqual(Object.keys(on.streams).sort(), [owners, averys].sort());
  assert.ok(on.spaces.some((space) => space.id === launch), "From members");
});

test("a chat that is not listed but waits for the owner's answer is shown while it waits, and can be answered", async (t) => {
  const { ws, view, owners, averys, helper } = await setup(t);
  assert.deepEqual(view(false).chats.filter(chat => !chat.main).map((chat) => chat.id), [owners]);
  // A bot in the member's chat asks for something only the owner can allow.
  const waiting = ws.interactions.permission(ws.chat(averys), { stopped: false }, { kind: "shell", title: "Run a command", detail: "ls" });
  const shown = view(false);
  assert.deepEqual(shown.chats.filter(chat => !chat.main).map((chat) => chat.id).sort(), [owners, averys].sort(), "listed while the request waits");
  assert.deepEqual(shown.requests.map((request) => request.chatId), [averys]);
  assert.ok(shown.bots.some((bot) => bot.id === helper), "with its bot, so the chat can be drawn");
  // The owner answers it from the window, as for any chat.
  ws.interactions.respond(shown.requests[0].id, { action: "approve" });
  assert.deepEqual(await waiting, { allow: true, interactive: true });
  const after = view(false);
  assert.deepEqual([after.chats.filter(chat => !chat.main).map((chat) => chat.id), after.requests], [[owners], []], "and it leaves the list again");
});

test("with a link from before Admin mode the window is shown everything and no switch", async (t) => {
  const { ws, link, owners, averys } = await setup(t);
  const old = { spacesFor: (person) => link.spacesFor(person), team: () => link.team() };
  assert.equal(hasAdminMode(old), false);
  for (const admin of [false, true]) {
    const shown = ownerWindowView(ws.snapshot(), old, admin);
    assert.equal("adminMode" in shown, false);
    assert.deepEqual(shown.chats.filter(chat => !chat.main).map((chat) => chat.id).sort(), [owners, averys].sort());
    assert.equal(typeof shown.spaces[0].can, "string");
  }
  // A link from before spaces: no `spaces`, which is how the window knows to show the Today page.
  assert.equal(ownerWindowView(ws.snapshot(), { team: () => ({}) }, false).spaces, undefined);
  assert.equal(ownerWindowView(ws.snapshot(), null, false).spaces, undefined);
});
