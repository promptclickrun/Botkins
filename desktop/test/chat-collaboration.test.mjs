import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { findHumanMentions, mentionTitle } from "../desktop/human-mentions.mjs";
import { ChatTyping, TYPING_TTL_MS } from "../desktop/link/typing.mjs";
import { authorize, filterParts, ownerParts } from "../desktop/link/team.mjs";
import { Push } from "../desktop/link/push.mjs";
import { decide, Notifier } from "../desktop/notify.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";

test("findHumanMentions resolves full names and unambiguous first names while ignoring code and emails", () => {
  const people = [
    { id: "owner", name: "Colt Coan" },
    { id: "m_1", name: "Jordan" },
    { id: "m_2", name: "Alex Rivera" },
    { id: "m_3", name: "Alex Chen" },
  ];

  // Full name + unambiguous first name + deduplication + order preserved
  assert.deepEqual(
    findHumanMentions("Hey @Jordan and @Colt, can @jordan check with @Alex Chen?", people),
    [
      { id: "m_1", name: "Jordan" },
      { id: "owner", name: "Colt Coan" },
      { id: "m_3", name: "Alex Chen" },
    ],
  );

  // Ambiguous first name alone does not match, full name does
  assert.deepEqual(findHumanMentions("Ping @Alex about it", people), []);
  assert.deepEqual(findHumanMentions("Ping @Alex Rivera about it", people), [{ id: "m_2", name: "Alex Rivera" }]);

  // Emails, inline code, and fenced code blocks do not trigger mentions
  assert.deepEqual(
    findHumanMentions(
      "Mail jordan@example.com or run `@Jordan` or:\n```\n@Colt Coan\n```",
      people,
    ),
    [],
  );

  // Sender self-exclusion
  assert.deepEqual(
    findHumanMentions("@Jordan @Colt Coan check this", people, { excludeId: "m_1" }),
    [{ id: "owner", name: "Colt Coan" }],
  );

  assert.equal(mentionTitle("Jordan"), "Jordan mentioned you in a chat");
  assert.equal(mentionTitle("Gordie"), "Gordie mentioned you in a chat");
});

test("ChatTyping deduplicates devices per person, combines typers, and expires dropped clients", () => {
  let now = 1000;
  let changes = 0;
  const typing = new ChatTyping({ now: () => now, changed: () => { changes++; }, sweepMs: 0 });
  const names = new Map([
    ["owner", "Colt"],
    ["m_j", "Jordan"],
    ["m_a", "Alex"],
  ]);

  // Two devices for Jordan still appear once
  typing.set({ chatId: "c1", personId: "m_j", sourceId: "dev-phone", typing: true });
  typing.set({ chatId: "c1", personId: "m_j", sourceId: "dev-laptop", typing: true });
  assert.deepEqual(typing.snapshot(names), { c1: [{ id: "m_j", name: "Jordan" }] });

  // Clearing one device keeps Jordan active while the other is still fresh
  typing.set({ chatId: "c1", personId: "m_j", sourceId: "dev-phone", typing: false });
  assert.deepEqual(typing.snapshot(names), { c1: [{ id: "m_j", name: "Jordan" }] });

  // Adding Colt shows both
  typing.set({ chatId: "c1", personId: "owner", sourceId: "host", typing: true });
  assert.deepEqual(typing.snapshot(names), {
    c1: [
      { id: "m_j", name: "Jordan" },
      { id: "owner", name: "Colt" },
    ],
  });

  // Clearing person on send removes all devices for that person
  typing.clearPerson("c1", "m_j");
  assert.deepEqual(typing.snapshot(names), { c1: [{ id: "owner", name: "Colt" }] });

  // Dropped client expires after TTL
  now += TYPING_TTL_MS + 1;
  assert.equal(typing.sweep(), true);
  assert.deepEqual(typing.snapshot(names), {});
  assert.ok(changes >= 3);
  typing.dispose();
});

test("link.chat.typing authorization and live.typing filtering enforce chat privacy", () => {
  const team = {
    roles: [{ id: "r", name: "Member", perms: { agents: ["view", "chat"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: "all" }],
    groups: [{ id: "g", name: "Group", roleId: "r" }],
    members: [
      { id: "m_a", name: "Ana", groupId: "g" },
      { id: "m_b", name: "Ben", groupId: "g" },
    ],
    chats: { "c-shared": ["m_a"] },
    views: {},
  };
  const chats = [
    { id: "c-shared", botId: "b1", createdBy: "owner" },
    { id: "c-private", botId: "b1", createdBy: "m_b" },
  ];
  const ana = { kind: "member", memberId: "m_a", name: "Ana", groupId: "g" };
  const ben = { kind: "member", memberId: "m_b", name: "Ben", groupId: "g" };
  const lookups = { chat: (id) => chats.find((c) => c.id === id), bot: (id) => ({ id }) };

  // Ana is in c-shared so she can emit typing; Ben is not
  assert.equal(authorize(ana, team, "link.chat.typing", ["c-shared", true], lookups), "");
  assert.match(authorize(ben, team, "link.chat.typing", ["c-shared", true], lookups), /belongs to/i);
  // Clearing typing is always permitted
  assert.equal(authorize(ben, team, "link.chat.typing", ["c-shared", false], lookups), "");

  const allParts = {
    meta: { name: "Home" },
    bots: [{ id: "b1", name: "Gordie" }],
    chats,
    runs: [],
    panels: [],
    board: [],
    live: {
      streams: {},
      intents: {},
      thinking: {},
      speakers: {},
      typing: {
        "c-shared": [{ id: "owner", name: "Colt" }],
        "c-private": [{ id: "m_b", name: "Ben" }],
      },
      queued: {},
      requests: [],
      active: [],
    },
  };

  const anaParts = filterParts(allParts, ana, team);
  assert.deepEqual(anaParts.live.typing, { "c-shared": [{ id: "owner", name: "Colt" }] });

  const ownerCut = ownerParts(allParts, team);
  assert.deepEqual(ownerCut.live.typing, { "c-shared": [{ id: "owner", name: "Colt" }] });
});

test("workspace emits mention alerts for human and bot @mentions and deduplicates owner notifications", async (t) => {
  const fake = fakeClient(async () => ({ data: { content: "Heads up @Colt and @Jordan, I finished checking the build." } }));
  const teamData = {
    name: "Home",
    roles: [{ id: "r", name: "Member", perms: { agents: ["view", "chat"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: "all" }],
    groups: [{ id: "g", name: "G", roleId: "r" }],
    members: [{ id: "m_jordan", name: "Jordan", groupId: "g" }],
    people: [
      { id: "owner", name: "Colt Coan" },
      { id: "m_jordan", name: "Jordan" },
    ],
  };
  const ws = new Workspace(tempDir(t), fake.client, () => {}, {
    team: () => teamData,
    people: () => ({ createdBy: "owner", invited: ["m_jordan"] }),
  });
  const chatId = ws.createChat("pip");

  const alerts = [];
  ws.events.on("mention", (m) => alerts.push(m));

  // Track desktop notifications emitted by Notifier
  const shown = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(opts) { super(); this.opts = opts; }
    show() { shown.push(this.opts); }
  }
  new Notifier(ws, {
    Notification: FakeNotification,
    focused: () => false,
    open: () => {},
  });

  // 1. Human (Jordan) mentions Colt, and bot replies mentioning both Colt and Jordan
  await ws.send(chatId, "Hey @Colt check this out", {
    author: { memberId: "m_jordan", name: "Jordan" },
  });

  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].person, "owner");
  assert.equal(alerts[0].by, "Jordan");
  assert.equal(alerts[1].person, "owner");
  assert.equal(alerts[1].by, "Pip");
  assert.ok(alerts[1].runId);
  assert.equal(alerts[2].person, "m_jordan");
  assert.equal(alerts[2].by, "Pip");
  assert.equal(ws.snapshot().mentions.length, 3);

  // Owner gets Jordan's mention + Pip's mention, and NOT a third duplicate generic reply alert for the same run
  assert.equal(shown.length, 2);
  assert.equal(shown[0].title, "Jordan mentioned you in a chat");
  assert.equal(shown[1].title, "Pip mentioned you in a chat");
});

test("decide respects mention notification preferences and focus", () => {
  const mention = { id: "m1", chatId: "c1", person: "owner", by: "Jordan", preview: "Hey @Colt look at this", time: 1 };
  assert.deepEqual(
    decide({ type: "mention", mention }, { focused: false, mine: true }),
    { title: "Jordan mentioned you in a chat", body: "Hey @Colt look at this", chatId: "c1" },
  );
  assert.equal(decide({ type: "mention", mention }, { focused: true, mine: true }), null);
  assert.equal(decide({ type: "mention", mention }, { focused: false, mine: true, settings: { notifications: { replies: false } } }), null);
  assert.equal(decide({ type: "mention", mention }, { focused: false, mine: false }), null);
});

test("Push sends mention notifications to mentioned member and suppresses duplicate bot reply push", async () => {
  const sent = [];
  const pushRecords = {
    d_owner: { token: "aa".repeat(32), env: "sandbox", prefs: { replies: true, requests: true, routines: true, previews: true, activities: false }, activities: {} },
    d_jordan: { token: "bb".repeat(32), env: "sandbox", prefs: { replies: true, requests: true, routines: true, previews: false, activities: false }, activities: {} },
  };
  const store = {
    data: {
      devices: [
        { id: "d_owner", name: "Colt iPhone" },
        { id: "d_jordan", name: "Jordan iPhone", memberId: "m_jordan" },
      ],
      team: { roles: [], groups: [], members: [{ id: "m_jordan", name: "Jordan", groupId: "g" }], chats: { c1: ["m_jordan"] }, views: {} },
    },
    push: (id) => pushRecords[id] ?? null,
    save() {},
  };

  let state = {
    bots: [{ id: "b1", name: "Gordie" }],
    chats: [{ id: "c1", botId: "b1", title: "Group", messages: [] }],
    runs: [{ id: "r1", chatId: "c1", status: "Working", time: 1 }],
    requests: [],
    mentions: [],
  };
  const push = new Push({
    store,
    deviceKey: () => new Uint8Array(32),
    relayUrl: () => "https://relay.example",
    snapshot: () => state,
    people: () => true,
  });
  push.alert = (deviceId, _record, body) => ({ deviceId, body });
  push.send = async (items) => {
    sent.push(...items);
  };

  push.look();

  // Bot finishes run r1 and mentions Jordan
  state = {
    ...state,
    chats: [{ id: "c1", botId: "b1", title: "Group", messages: [{ role: "assistant", runId: "r1", text: "@Jordan check this" }] }],
    runs: [{ id: "r1", chatId: "c1", status: "Completed", time: 2 }],
    mentions: [{ id: "m1", chatId: "c1", person: "m_jordan", by: "Gordie", preview: "@Jordan check this", time: 2, runId: "r1" }],
  };
  push.look();

  // Jordan gets the mention push (with previews disabled -> generic body), NOT a duplicate reply push.
  // Owner gets the normal reply push for run r1.
  const jordanPushes = sent.filter((p) => p.deviceId === "d_jordan");
  const ownerPushes = sent.filter((p) => p.deviceId === "d_owner");
  assert.equal(jordanPushes.length, 1);
  assert.equal(jordanPushes[0].body.t, "Gordie mentioned you in a chat");
  assert.equal(jordanPushes[0].body.k, "mention");
  assert.equal(jordanPushes[0].body.m, "Open Botkins to see it.");
  assert.equal(ownerPushes.length, 1);
  assert.equal(ownerPushes[0].body.k, "reply");
});
