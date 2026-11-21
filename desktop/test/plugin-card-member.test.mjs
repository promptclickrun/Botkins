// A bot's request for a plugin change shows the plugin's whole description: each command, each
// environment value and header value as the plugin wrote it (desktop/plugin-card.mjs). A team
// member's own view of the plugins leaves those out. So the request must never reach a member's
// device, and a member must never answer it: only the owner sees and answers that card.
//
// One line of the link's cut holds that (desktop/link/team.mjs, `filterParts`: no request of the
// kind "permission" or "secure" for a member), and one line of its rules (`authorize`: "The owner
// needs to approve that request."). The link is the Mobile thread's code. This test is here so
// that a change there, which would show a member the card, fails a test that says why.
import test from "node:test";
import assert from "node:assert/strict";
import { authorize, BUILTIN_ROLES, EVERYONE_GROUP, filterParts } from "../desktop/link/index.mjs";

const team = {
  // (A guest who may use every bot and the plugins: the widest view a member's turn with the plugin tools has.)
  roles: BUILTIN_ROLES.map((role) => (role.id === "r_guest" ? { ...role, perms: { ...role.perms }, bots: "all" } : { ...role, perms: { ...role.perms } })),
  groups: [EVERYONE_GROUP],
  members: [{ id: "m_avery", name: "Avery", groupId: "g_everyone" }],
};
const member = { kind: "member", memberId: "m_avery", groupId: "g_everyone" };
const card = { id: "r-plugin", chatId: "c1", botId: "pip", kind: "permission", title: "Allow plugin change?", preview: "enable · memory", detail: 'Runs on this computer:\n  the tool files: npx -y pkg\n      with TOKEN="written-in-the-plugin"', askedBy: { memberId: "m_avery", name: "Avery" } };
const secure = { id: "r-secure", chatId: "c1", botId: "pip", kind: "secure", title: "Settings for memory", detail: "MEMORY_API_KEY" };
const question = { id: "r-question", chatId: "c1", botId: "pip", kind: "question", title: "Which folder?" };
const parts = {
  bots: [{ id: "pip", name: "Pip" }],
  chats: [{ id: "c1", botId: "pip", createdBy: "m_avery" }],
  runs: [],
  live: { streams: {}, intents: {}, thinking: {}, speakers: {}, queued: {}, active: ["c1"], requests: [card, secure, question] },
};

test("a member's device gets no request of the kind permission or secure, also for a turn that the member started", () => {
  const cut = filterParts(parts, member, team);
  assert.deepEqual(cut.live.requests.map((request) => request.id), ["r-question"], "a question is the member's to answer; the card and the secure form are not sent");
  const sent = JSON.stringify(cut);
  for (const text of ["written-in-the-plugin", "Allow plugin change?", "enable · memory", "MEMORY_API_KEY"]) assert.equal(sent.includes(text), false, text);
  // The owner gets the card whole, with the member named in it.
  const whole = filterParts(parts, { kind: "owner" }, team);
  assert.deepEqual(whole.live.requests.map((request) => request.id), ["r-plugin", "r-secure", "r-question"]);
  assert.equal(whole.live.requests[0].askedBy.memberId, "m_avery");
});

test("a member's answer to such a request is refused, though the member may answer a question", () => {
  const lookups = { bot: (id) => parts.bots.find((bot) => bot.id === id), chat: (id) => parts.chats.find((chat) => chat.id === id), request: (id) => parts.live.requests.find((request) => request.id === id) };
  assert.equal(authorize(member, team, "respond", ["r-plugin", { action: "approve" }], lookups), "The owner needs to approve that request.");
  assert.equal(authorize(member, team, "respond", ["r-secure", { action: "submit", content: {} }], lookups), "The owner needs to approve that request.");
  assert.notEqual(authorize(member, team, "respond", ["r-question", { value: "docs" }], lookups), "The owner needs to approve that request.");
});
