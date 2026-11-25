// Which side a person's message is on, the name over someone else's, and which of a person's
// messages in a row show their name and badge (chatSides.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { continuingKeys, personTag, sideOf } from "../src/features/chat/chatSides";
import { peopleLooks } from "../src/features/chat/personLook";
import type { Message } from "../src/link/types";

const owner = { role: "user", text: "Hi" } as Message;
const ana = { role: "user", text: "Hello", author: { memberId: "m_ana", name: "Ana" } } as Message;
const ben = { role: "user", text: "Hey", author: { memberId: "m_ben" } } as Message;
const bot = { role: "assistant", text: "Hi all" } as Message;
const names = peopleLooks([
  { id: "owner", name: "Studio" },
  { id: "m_ana", name: "Ana" },
  { id: "m_ben", name: "Ben" },
]);

test("the owner viewing: their own messages on the right, a member's on the left with their name", () => {
  assert.equal(sideOf(owner, "owner"), "right");
  assert.equal(personTag(owner, undefined, "owner", names), "");
  assert.equal(sideOf(ana, "owner"), "left");
  assert.equal(personTag(ana, undefined, "owner", names), "Ana");
  // A name the computer left out comes from the chat's people.
  assert.equal(personTag(ben, undefined, "owner", names), "Ben");
});

test("a member viewing: the owner's and another member's messages on the left, their own on the right", () => {
  assert.equal(sideOf(ana, "m_ana"), "right");
  assert.equal(personTag(ana, undefined, "m_ana", names), "");
  assert.equal(sideOf(owner, "m_ana"), "left");
  assert.equal(personTag(owner, undefined, "m_ana", names), "Studio");
  assert.equal(sideOf(ben, "m_ana"), "left");
  assert.equal(personTag(ben, undefined, "m_ana", names), "Ben");
  // Without the team list: "Owner", or "Member".
  assert.equal(personTag(owner, undefined, "m_ana", undefined), "Owner");
  assert.equal(personTag(ben, undefined, "m_ana", undefined), "Member");
});

test("bots are always on the left with no person's name; a message nobody typed has none either", () => {
  assert.equal(sideOf(bot, "owner"), "left");
  assert.equal(sideOf(bot, "m_ana"), "left");
  assert.equal(personTag(bot, undefined, "owner", names), "");
  assert.equal(personTag(owner, { scheduleId: 3 }, "m_ana", names), "");
  assert.equal(personTag(owner, { panelId: "p" }, "m_ana", names), "");
});

test("a person's messages in a row show their name and badge on the first only", () => {
  const item = (key: string, message: Message) => ({ kind: "message", key, message });
  const items = [
    item("1", ana),
    item("2", ana), // continues Ana's
    item("3", ben), // someone else: first again
    item("4", ben),
    { kind: "work", key: "w" }, // anything between starts again
    item("5", ben),
    item("6", bot),
    item("7", ben), // a bot's reply between
    item("8", owner),
    item("9", owner), // the viewer's own never need it
  ];
  assert.deepEqual([...continuingKeys(items, "owner")], ["2", "4"]);
  // A member viewing: the owner's run continues, their own doesn't count.
  assert.deepEqual([...continuingKeys(items, "m_ben")], ["2", "9"]);
});
