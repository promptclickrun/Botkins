// Tests for per-agent notification filters and one voice per delegated job.
// Covers:
// 1. Worker turn in a creator-reviewed task chat sends no notification; creator reviewer's reply does.
//    Failed worker turn notifies person directly only if creator bot is gone; approval/question unaffected.
// 2. "only" mode filters replies, routines, and spaces, but not requests, @mentions, or update notices.
// 3. mutedBots filters replies, routines, and spaces, but not requests, @mentions, or update notices.
// 4. cleanPrefs sanitizes and rejects bad input (non-strings, invalid modes, over-length/count, duplicates).
// 5. Desktop decide() mirrors one-voice and per-agent filters.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Push, DEFAULT_PREFS, cleanPrefs, allowsBot, isCreatorReviewedWorkerRun } from "../desktop/link/push.mjs";
import { SpaceAlerts } from "../desktop/link/space-alerts.mjs";
import { decide } from "../desktop/notify.mjs";
import { defaultSettings } from "../desktop/preferences.mjs";
import { hkdf, open } from "../desktop/link/crypto.mjs";

const TOKEN = "aa".repeat(32);

function makePushHarness(initialState, initialPrefs = {}) {
  let state = initialState;
  const deviceKey = randomBytes(32);
  let pushRecord = { token: TOKEN, env: "production", prefs: cleanPrefs(initialPrefs), activities: {} };
  const devices = [{ id: "dev-1", name: "Phone", platform: "ios" }];
  const sent = [];

  const store = {
    name: "Test Mac",
    data: { devices, team: { roles: [], groups: [], members: [] }, looks: {} },
    push: (id) => (id === "dev-1" ? pushRecord : null),
    setPush: (id, rec) => {
      if (id === "dev-1") pushRecord = rec;
      return true;
    },
    relayKey: () => ({
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  };

  const push = new Push({
    store,
    deviceKey: (id) => (id === "dev-1" ? deviceKey : null),
    relayUrl: () => "https://relay.test",
    snapshot: () => state,
  });

  // Intercept `send` directly so tests stay pure, synchronous, and inspect sealed payloads.
  push.send = async (items) => {
    sent.push(...items);
    return items.map(() => ({ status: 200 }));
  };

  const unseal = (item) => {
    const key = hkdf(deviceKey, Buffer.from("dev-1", "utf8"), "botkins/push/v1");
    const raw = Buffer.from(item.payload.b, "base64");
    return JSON.parse(open(key, raw.subarray(0, 12), raw.subarray(12), "botkins-push-v1").toString("utf8"));
  };

  return {
    push,
    sent,
    unseal,
    setState: (next) => {
      state = next;
    },
    setPrefs: (patch) => push.setPrefs("dev-1", patch),
    getRecord: () => pushRecord,
  };
}

test("one voice per delegated job: worker completion is silent, creator reviewer's reply notifies", () => {
  const bots = [
    { id: "alfie", name: "Alfie" },
    { id: "glory", name: "Glory" },
  ];
  const task = {
    id: "task-1",
    title: "Build filter",
    botId: "glory",
    chatId: "chat-worker",
    createdBy: "alfie",
    createdChatId: "chat-alfie",
    review: "creator",
    status: "working",
  };
  const workerChat = { id: "chat-worker", botId: "glory", title: "Task · Build filter", messages: [] };
  const reviewerChat = { id: "chat-alfie", botId: "alfie", title: "Main", messages: [] };

  const h = makePushHarness({
    bots,
    tasks: [task],
    chats: [workerChat, reviewerChat],
    runs: [{ id: "run-worker", chatId: "chat-worker", taskId: "task-1", status: "Working", time: 1000 }],
    requests: [],
  });
  h.push.start();

  // 1. Worker finishes its delegated task turn -> status moves to review with reviewerBotId = alfie.
  const finishedTask = { ...task, status: "review", reviewerBotId: "alfie" };
  h.setState({
    bots,
    tasks: [finishedTask],
    chats: [
      { ...workerChat, messages: [{ id: "m1", role: "assistant", botId: "glory", runId: "run-worker", text: "Worker PR ready." }] },
      reviewerChat,
    ],
    runs: [
      { id: "run-worker", chatId: "chat-worker", taskId: "task-1", status: "Completed", time: 1000, finished: 2000 },
      { id: "run-review", chatId: "chat-alfie", taskReviewId: "task-1", status: "Working", time: 2100 },
    ],
    requests: [],
  });
  h.push.look();
  assert.equal(h.sent.filter((s) => s.type === "alert").length, 0, "worker turn sends no notification");

  // 2. Creator reviewer bot finishes its review reply -> person IS notified.
  h.setState({
    bots,
    tasks: [{ ...finishedTask, status: "done" }],
    chats: [
      { ...workerChat, messages: [{ id: "m1", role: "assistant", botId: "glory", runId: "run-worker", text: "Worker PR ready." }] },
      { ...reviewerChat, messages: [{ id: "m2", role: "assistant", botId: "alfie", runId: "run-review", text: "Reviewed and merged #42." }] },
    ],
    runs: [
      { id: "run-worker", chatId: "chat-worker", taskId: "task-1", status: "Completed", time: 1000, finished: 2000 },
      { id: "run-review", chatId: "chat-alfie", taskReviewId: "task-1", status: "Completed", time: 2100, finished: 3000 },
    ],
    requests: [],
  });
  h.push.look();
  const alerts = h.sent.filter((s) => s.type === "alert");
  assert.equal(alerts.length, 1, "reviewer reply notifies the person");
  const payload = h.unseal(alerts[0]);
  assert.equal(payload.c, "chat-alfie");
  assert.match(payload.t, /^Alfie/);
  assert.match(payload.m, /Reviewed and merged/);
});

test("one voice per delegated job: failed worker notifies directly only if no creator bot exists; approvals still notify", () => {
  const bots = [
    { id: "alfie", name: "Alfie" },
    { id: "glory", name: "Glory" },
  ];
  const taskWithCreator = {
    id: "task-c",
    title: "With creator",
    botId: "glory",
    chatId: "chat-c",
    createdBy: "alfie",
    review: "creator",
    status: "working",
  };
  const taskWithoutCreator = {
    id: "task-p",
    title: "Person task",
    botId: "glory",
    chatId: "chat-p",
    createdBy: "person",
    review: "person",
    status: "working",
  };
  const taskDeletedCreator = {
    id: "task-gone",
    title: "Deleted creator",
    botId: "glory",
    chatId: "chat-gone",
    createdBy: "deleted-bot",
    review: "creator",
    status: "working",
  };
  const chats = [
    { id: "chat-c", botId: "glory", title: "Task · With creator", messages: [] },
    { id: "chat-p", botId: "glory", title: "Task · Person task", messages: [] },
    { id: "chat-gone", botId: "glory", title: "Task · Deleted creator", messages: [] },
  ];

  const h = makePushHarness({
    bots,
    tasks: [taskWithCreator, taskWithoutCreator, taskDeletedCreator],
    chats,
    runs: [
      { id: "r-c", chatId: "chat-c", taskId: "task-c", status: "Working", time: 1000 },
      { id: "r-p", chatId: "chat-p", taskId: "task-p", status: "Working", time: 1000 },
      { id: "r-gone", chatId: "chat-gone", taskId: "task-gone", status: "Working", time: 1000 },
    ],
    requests: [],
  });
  h.push.start();

  // Approval request in creator-reviewed worker chat is NOT suppressed.
  h.setState({
    bots,
    tasks: [taskWithCreator, taskWithoutCreator, taskDeletedCreator],
    chats,
    runs: [
      { id: "r-c", chatId: "chat-c", taskId: "task-c", status: "Working", time: 1000 },
      { id: "r-p", chatId: "chat-p", taskId: "task-p", status: "Working", time: 1000 },
      { id: "r-gone", chatId: "chat-gone", taskId: "task-gone", status: "Working", time: 1000 },
    ],
    requests: [{ id: "req-1", chatId: "chat-c", botId: "glory", kind: "permission", title: "Run git push?" }],
  });
  h.push.look();
  assert.equal(h.sent.length, 1);
  assert.equal(h.unseal(h.sent[0]).k, "request");

  // All three worker runs fail: creator-backed stays quiet (handed to creator), person & deleted-creator notify directly.
  h.sent.length = 0;
  h.setState({
    bots,
    tasks: [
      { ...taskWithCreator, status: "blocked", problem: "boom" },
      { ...taskWithoutCreator, status: "blocked", problem: "boom" },
      { ...taskDeletedCreator, status: "blocked", problem: "boom" },
    ],
    chats,
    runs: [
      { id: "r-c", chatId: "chat-c", taskId: "task-c", status: "Failed", detail: "boom", time: 1000, finished: 2000 },
      { id: "r-p", chatId: "chat-p", taskId: "task-p", status: "Failed", detail: "boom", time: 1000, finished: 2000 },
      { id: "r-gone", chatId: "chat-gone", taskId: "task-gone", status: "Failed", detail: "boom", time: 1000, finished: 2000 },
    ],
    requests: [{ id: "req-1", chatId: "chat-c", botId: "glory", kind: "permission", title: "Run git push?" }],
  });
  h.push.look();
  const chatIds = h.sent.map((item) => h.unseal(item).c).sort();
  assert.deepEqual(chatIds, ["chat-gone", "chat-p"]);
});

test('"only" mode filters replies, routines, and spaces but not requests, @mentions, or updates', () => {
  const bots = [
    { id: "alfie", name: "Alfie" },
    { id: "glory", name: "Glory" },
  ];
  const chats = [
    { id: "c-alfie", botId: "alfie", title: "Alfie chat", messages: [], schedules: [{ id: 1, routine: true }] },
    { id: "c-glory", botId: "glory", title: "Glory chat", messages: [], schedules: [{ id: 2, routine: true }] },
  ];
  const h = makePushHarness(
    {
      bots,
      chats,
      runs: [
        { id: "r-a", chatId: "c-alfie", status: "Working", time: 1000 },
        { id: "r-g", chatId: "c-glory", status: "Working", time: 1000 },
        { id: "rt-a", chatId: "c-alfie", scheduleId: 1, trigger: "scheduled", title: "Morning", status: "Working", time: 1000 },
        { id: "rt-g", chatId: "c-glory", scheduleId: 2, trigger: "scheduled", title: "Nightly", status: "Working", time: 1000 },
      ],
      requests: [],
      mentions: [],
    },
    { bots: { mode: "only", ids: ["alfie"] } },
  );
  h.push.start();

  h.setState({
    bots,
    chats: [
      {
        ...chats[0],
        messages: [
          { id: "m1", role: "assistant", botId: "alfie", runId: "r-a", text: "Alfie reply" },
          { id: "m3", role: "assistant", botId: "alfie", runId: "rt-a", text: "Alfie routine" },
        ],
      },
      {
        ...chats[1],
        messages: [
          { id: "m2", role: "assistant", botId: "glory", runId: "r-g", text: "Glory reply" },
          { id: "m4", role: "assistant", botId: "glory", runId: "rt-g", text: "Glory routine" },
        ],
      },
    ],
    runs: [
      { id: "r-a", chatId: "c-alfie", status: "Completed", time: 1000, finished: 2000 },
      { id: "r-g", chatId: "c-glory", status: "Completed", time: 1000, finished: 2000 },
      { id: "rt-a", chatId: "c-alfie", scheduleId: 1, trigger: "scheduled", title: "Morning", status: "Completed", time: 1000, finished: 2000 },
      { id: "rt-g", chatId: "c-glory", scheduleId: 2, trigger: "scheduled", title: "Nightly", status: "Completed", time: 1000, finished: 2000 },
    ],
    // Request and @mention from non-allowlisted bot Glory must still notify.
    requests: [{ id: "req-g", chatId: "c-glory", botId: "glory", kind: "question", title: "Which branch?" }],
    mentions: [{ id: "men-1", person: "owner", chatId: "c-glory", by: "Glory", preview: "@Colt check this" }],
  });
  h.push.look();

  const decoded = h.sent.map((item) => h.unseal(item));
  const kinds = decoded.map((d) => `${d.k}:${d.c}`).sort();
  assert.deepEqual(kinds, [
    "mention:c-glory",
    "reply:c-alfie",
    "request:c-glory",
    "routine:c-alfie",
  ]);

  // Update notice is never filtered by bot prefs.
  h.sent.length = 0;
  assert.equal(h.push.updateAvailable("0.18.0"), 1);
  assert.equal(h.unseal(h.sent[0]).k, "update");

  // Spaces filter skips panels owned by non-allowlisted bots, allows allowlisted bot panels.
  const spaceSent = [];
  const spaceAlerts = new SpaceAlerts({
    spaces: { on: true, here: () => new Map() },
    team: () => ({}),
    setTeam: () => {},
    devices: () => [{ id: "dev-1" }],
    shown: () => [{ id: "sp-1", name: "Team", notify: "all" }],
    context: () => ({}),
    records: () => [],
    titles: () => (id) => (id === "p-alfie" ? "Alfie Panel" : "Glory Panel"),
    itemBot: () => (id) => (id === "p-alfie" ? "alfie" : "glory"),
    names: () => new Map([["m_1", "Maya"]]),
    wants: (device, botId) => h.push.wants(device, "spaces", botId),
    previews: () => true,
    send: (_device, content) => {
      spaceSent.push(content);
      return true;
    },
  });
  assert.equal(spaceAlerts.event({ spaceId: "sp-1", panelId: "p-glory", by: "m_1", kind: "change", label: "Edited" }), 0);
  assert.equal(spaceAlerts.event({ spaceId: "sp-1", panelId: "p-alfie", by: "m_1", kind: "change", label: "Edited" }), 1);
  assert.equal(spaceSent.length, 1);
});

test("mutedBots filters replies, routines, and spaces but not requests or @mentions", () => {
  const bots = [
    { id: "alfie", name: "Alfie" },
    { id: "glory", name: "Glory" },
  ];
  const chats = [
    { id: "c-alfie", botId: "alfie", title: "Alfie chat", messages: [] },
    { id: "c-glory", botId: "glory", title: "Glory chat", messages: [], schedules: [{ id: 2, routine: true }] },
  ];
  const h = makePushHarness(
    {
      bots,
      chats,
      runs: [
        { id: "r-a", chatId: "c-alfie", status: "Working", time: 1000 },
        { id: "r-g", chatId: "c-glory", status: "Working", time: 1000 },
        { id: "rt-g", chatId: "c-glory", scheduleId: 2, trigger: "scheduled", title: "Check", status: "Working", time: 1000 },
      ],
      requests: [],
      mentions: [],
    },
    { mutedBots: ["glory"] },
  );
  h.push.start();

  h.setState({
    bots,
    chats: [
      { ...chats[0], messages: [{ id: "m1", role: "assistant", botId: "alfie", runId: "r-a", text: "Hi" }] },
      {
        ...chats[1],
        messages: [
          { id: "m2", role: "assistant", botId: "glory", runId: "r-g", text: "Done" },
          { id: "m3", role: "assistant", botId: "glory", runId: "rt-g", text: "Routine done" },
        ],
      },
    ],
    runs: [
      { id: "r-a", chatId: "c-alfie", status: "Completed", time: 1000, finished: 2000 },
      { id: "r-g", chatId: "c-glory", status: "Completed", time: 1000, finished: 2000 },
      { id: "rt-g", chatId: "c-glory", scheduleId: 2, trigger: "scheduled", title: "Check", status: "Completed", time: 1000, finished: 2000 },
    ],
    requests: [{ id: "req-g", chatId: "c-glory", botId: "glory", kind: "permission", title: "Approve?" }],
    mentions: [{ id: "men-g", person: "owner", chatId: "c-glory", by: "Glory", preview: "@Colt look" }],
  });
  h.push.look();

  const kinds = h.sent.map((item) => {
    const d = h.unseal(item);
    return `${d.k}:${d.c}`;
  }).sort();
  assert.deepEqual(kinds, ["mention:c-glory", "reply:c-alfie", "request:c-glory"]);

  // Space alerts for muted bot are skipped; unmuted bot allowed.
  assert.equal(h.push.wants({ id: "dev-1" }, "spaces", "glory"), false);
  assert.equal(h.push.wants({ id: "dev-1" }, "spaces", "alfie"), true);
});

test("cleanPrefs sanitizes and rejects bad input", () => {
  // Defaults
  assert.deepEqual(cleanPrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(cleanPrefs(null), DEFAULT_PREFS);
  assert.deepEqual(cleanPrefs({}), DEFAULT_PREFS);

  // Invalid mode, non-array ids, non-string entries, empty strings, NUL bytes, over-length ids, duplicates
  const bad = cleanPrefs({
    replies: "yes",
    bots: {
      mode: "invalid-mode",
      ids: ["  alfie ", "", "   ", 42, null, { id: "x" }, "bad\0id", "a".repeat(129), "alfie", "glory"],
    },
    mutedBots: [null, 123, "", "glory", "glory", "b".repeat(130), "x\0y", "scout"],
  });
  assert.equal(bad.replies, true, "non-boolean ignored");
  assert.deepEqual(bad.bots, { mode: "all", ids: ["alfie", "glory"] });
  assert.deepEqual(bad.mutedBots, ["glory", "scout"]);

  // Non-object bots / non-array mutedBots preserve base
  const base = cleanPrefs({ bots: { mode: "only", ids: ["alfie"] }, mutedBots: ["scout"] });
  const afterBad = cleanPrefs({ bots: "only", mutedBots: "glory" }, base);
  assert.deepEqual(afterBad.bots, { mode: "only", ids: ["alfie"] });
  assert.deepEqual(afterBad.mutedBots, ["scout"]);

  // Count cap at 200
  const many = Array.from({ length: 300 }, (_, i) => `bot-${i}`);
  const capped = cleanPrefs({ bots: { mode: "only", ids: many }, mutedBots: many });
  assert.equal(capped.bots.ids.length, 200);
  assert.equal(capped.mutedBots.length, 200);

  // allowsBot edge cases
  assert.equal(allowsBot(capped, "bot-0"), false, "mutedBots wins over bots.only allowlist");
  assert.equal(allowsBot({ bots: { mode: "only", ids: ["alfie"] }, mutedBots: [] }, "alfie"), true);
  assert.equal(allowsBot({ bots: { mode: "only", ids: ["alfie"] }, mutedBots: [] }, "glory"), false);
  assert.equal(allowsBot({ bots: { mode: "all", ids: [] }, mutedBots: ["glory"] }, "glory"), false);
  assert.equal(allowsBot({ bots: { mode: "all", ids: [] }, mutedBots: ["glory"] }, "alfie"), true);
});

test("desktop decide() respects one-voice delegated jobs and per-agent filters", () => {
  const settings = {
    notifications: {
      ...defaultSettings.notifications,
      bots: { mode: "only", ids: ["alfie"] },
      mutedBots: ["scout"],
    },
  };
  const chatGlory = { id: "c-g", botId: "glory", title: "Work", messages: [{ runId: "r1", role: "assistant", botId: "glory", text: "Hi" }] };
  const chatAlfie = { id: "c-a", botId: "alfie", title: "Main", messages: [{ runId: "r2", role: "assistant", botId: "alfie", text: "Ready" }] };

  assert.equal(
    decide({ type: "turn", chat: chatGlory, run: { id: "r1", chatId: "c-g", status: "Completed" }, bot: { id: "glory", name: "Glory" } }, { settings, focused: false }),
    null,
    "non-allowlisted bot reply suppressed on desktop",
  );
  assert.ok(
    decide({ type: "turn", chat: chatAlfie, run: { id: "r2", chatId: "c-a", status: "Completed" }, bot: { id: "alfie", name: "Alfie" } }, { settings, focused: false }),
    "allowlisted bot reply notifies on desktop",
  );
  assert.ok(
    decide({ type: "request", request: { id: "q1", chatId: "c-g", kind: "permission", title: "Run?" }, bot: { id: "glory", name: "Glory" }, chat: chatGlory }, { settings, focused: false }),
    "requests are not filtered on desktop",
  );
  assert.ok(
    decide({ type: "mention", mention: { id: "m1", chatId: "c-g", by: "Glory", preview: "@Colt hi" } }, { settings, focused: false }),
    "mentions are not filtered on desktop",
  );

  // One voice per job on desktop
  const state = {
    bots: [{ id: "alfie", name: "Alfie" }, { id: "glory", name: "Glory" }],
    tasks: [{ id: "t1", botId: "glory", chatId: "c-g", createdBy: "alfie", review: "creator", status: "review", reviewerBotId: "alfie" }],
  };
  assert.equal(isCreatorReviewedWorkerRun({ id: "r1", chatId: "c-g", taskId: "t1" }, chatGlory, state), true);
  assert.equal(
    decide(
      { type: "turn", chat: chatGlory, run: { id: "r1", chatId: "c-g", taskId: "t1", status: "Completed" }, bot: { id: "glory", name: "Glory" } },
      { settings: defaultSettings, focused: false, state },
    ),
    null,
    "worker turn suppressed on desktop when creator bot reviews",
  );
});
