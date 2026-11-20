import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { catchUp, createGroupChat, groupInstructions, isGroup, markSeen, memberSessionId, responders } from "../desktop/groups.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-groups-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  return { ws, bots: ws.state.bots };
}

test("group chats hold two to six distinct bots", (t) => {
  const { ws, bots } = setup(t);
  const [a, b, c] = bots.map((x) => x.id);
  const id = createGroupChat(ws, [a, b, c]);
  const chat = ws.chat(id);
  assert.ok(isGroup(chat));
  assert.equal(chat.botId, a, "the first member leads");
  assert.equal(chat.title, "Pip, Scout, Patch");
  assert.deepEqual(Object.keys(chat.members), [a, b, c]);
  assert.notEqual(memberSessionId(chat, a), memberSessionId(chat, b));
  assert.throws(() => createGroupChat(ws, [a]), /2 to 6/);
  assert.throws(() => createGroupChat(ws, [a, a]), /each bot once/);
  assert.throws(() => createGroupChat(ws, [a, "nope"]), /Unknown bot/);
  assert.equal(isGroup(ws.chat(ws.createChat(a))), false);
});

test("mentions choose who answers; otherwise everyone does", (t) => {
  const { ws, bots } = setup(t);
  ws.addBot({ name: "Pipster", role: "R", instructions: "I", face: "idle" });
  const all = ws.state.bots;
  const chat = ws.chat(createGroupChat(ws, all.map((b) => b.id)));
  const names = (text) => responders(chat, all, text).map((b) => b.name);
  assert.deepEqual(names("hello"), ["Pip", "Scout", "Patch", "Pipster"]);
  assert.deepEqual(names("@Patch then @scout, please"), ["Patch", "Scout"]);
  assert.deepEqual(names("@Pipster only"), ["Pipster"], "a longer name wins over its prefix");
  assert.deepEqual(names("@Pip only"), ["Pip"]);
  assert.deepEqual(names("hey @everyone"), ["Pip", "Scout", "Patch", "Pipster"]);
  assert.deepEqual(names("email me@pipmail.com"), ["Pip", "Scout", "Patch", "Pipster"], "an address isn't a mention");
});

test("each member catches up on what others said since its last turn", (t) => {
  const { ws, bots } = setup(t);
  const [pip, scout] = bots;
  const chat = ws.chat(createGroupChat(ws, [pip.id, scout.id]));
  chat.messages.push({ role: "user", text: "Plan a trip" });
  assert.equal(catchUp(chat, pip, bots), "Person: Plan a trip\n\n(Reply as Pip.)");
  chat.messages.push({ role: "assistant", botId: pip.id, text: "Try Lisbon." });
  markSeen(chat, pip.id);
  assert.equal(catchUp(chat, scout, bots), "Person: Plan a trip\n\nPip: Try Lisbon.\n\n(Reply as Scout.)");
  chat.messages.push({ role: "assistant", botId: scout.id, text: "Flights are cheap in May." });
  markSeen(chat, scout.id);
  chat.messages.push({ role: "user", text: "Great" });
  assert.equal(catchUp(chat, pip, bots), "Scout: Flights are cheap in May.\n\nPerson: Great\n\n(Reply as Pip.)");
  assert.match(groupInstructions(pip, [pip, scout]), /group chat with the person and these bots: Scout \(Research partner\)/);
});
