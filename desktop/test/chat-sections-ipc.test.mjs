// The window's calls for sections on the Chats page, and what its snapshot says of them.
import test from "node:test";
import assert from "node:assert/strict";
import { chatSectionHandlers, withOwnerChatSections } from "../desktop/chat-sections-ipc.mjs";

test("each call is made on the link as the owner", async () => {
  const calls = [];
  const host = Object.fromEntries(
    ["addChatSection", "renameChatSection", "deleteChatSection", "orderChatSections", "setChatSection"].map((name) => [
      name,
      (...args) => {
        calls.push([name, ...args]);
        return name === "addChatSection" ? "cs_abcdefghijk" : null;
      },
    ]),
  );
  const handlers = chatSectionHandlers(() => host);
  assert.deepEqual(Object.keys(handlers), ["link.chats.addSection", "link.chats.renameSection", "link.chats.deleteSection", "link.chats.orderSections", "link.chats.setSection"]);
  assert.equal(await handlers["link.chats.addSection"]("Work"), "cs_abcdefghijk");
  await handlers["link.chats.renameSection"]("cs_1", "Home");
  await handlers["link.chats.deleteSection"]("cs_1");
  await handlers["link.chats.orderSections"](["cs_2", "cs_1"]);
  await handlers["link.chats.setSection"]("chat-1", "cs_2");
  await handlers["link.chats.setSection"]("chat-1", null);
  await handlers["link.chats.setSection"]("chat-1");
  assert.deepEqual(calls, [
    ["addChatSection", "owner", "Work"],
    ["renameChatSection", "owner", "cs_1", "Home"],
    ["deleteChatSection", "owner", "cs_1"],
    ["orderChatSections", "owner", ["cs_2", "cs_1"]],
    ["setChatSection", "owner", "chat-1", "cs_2"],
    ["setChatSection", "owner", "chat-1", null],
    ["setChatSection", "owner", "chat-1", null],
  ]);
});

test("the link's own sentences come through, and a missing or older link says so", () => {
  const refusing = chatSectionHandlers(() => ({
    addChatSection: () => {
      throw new Error("You already have a section with that name.");
    },
  }));
  assert.throws(() => refusing["link.chats.addSection"]("Work"), { message: "You already have a section with that name." });
  assert.throws(() => refusing["link.chats.deleteSection"]("cs_1"), { message: "Sections need a newer phone link than this copy of Botkins has." });
  assert.throws(() => chatSectionHandlers(() => null)["link.chats.addSection"]("Work"), { message: "Phone access is still opening. Try again." });
});

test("the snapshot carries the owner's sections, and nothing when the link has none", () => {
  const state = { chats: [{ id: "a", title: "A" }, { id: "b", title: "B", sectionId: "stale" }, { id: "c", title: "C" }] };
  const host = { chatSectionsFor: (person) => (assert.equal(person, "owner"), { list: [{ id: "cs_1", name: "Work", extra: 1 }], of: { a: "cs_1" } }) };
  const next = withOwnerChatSections(state, host);
  assert.deepEqual(next.chatSections, [{ id: "cs_1", name: "Work" }]);
  assert.deepEqual(next.chats, [{ id: "a", title: "A", sectionId: "cs_1" }, { id: "b", title: "B" }, { id: "c", title: "C" }]);
  assert.equal(state.chats[0].sectionId, undefined, "the workspace's own chats are not changed");
  assert.equal(withOwnerChatSections(state, {}), state);
  assert.equal(withOwnerChatSections(state, null), state);
  assert.equal("chatSections" in withOwnerChatSections(state, { team: () => ({}) }), false);
});
