// A bot's Proactive agent ("proactive-agent-v2", "proactive-team-v1"): how the phone reads what the computer sends
// (tolerantly), the setup steps and what they save, and, through the link against the demo computer, who may change
// what: the owner anything, a member only their own entry, and each person is sent only their own.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { proactivePatch } from "../link-host/proactive-rules.mjs";
import { type FetchLike, LinkClient, checkJoin, pair, startJoin } from "../src/link/client";
import { ALERT, isPaused, peopleOf, personLine, proactiveBots, proactiveOf, proactiveRules, proactiveStanding, proactiveSummary, recentLog, WIZARD, WIZARD_STEPS, wizardPatch, wizardPeople, wizardReady, wizardStart } from "../src/features/bots/proactive";
import type { ProactiveBot, ProactivePart } from "../src/link/types";

const OWNER = { id: "owner", manages: true };

test("an agent is read with the usual settings for what the computer left out or sent in a shape this phone doesn't know", () => {
  assert.deepEqual(proactiveOf(undefined), { enabled: false, setUp: false, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests", "context"], instructions: "", people: {} });
  const odd = { enabled: true, setUp: "yes", every: "soon", sweepHours: -1, maxPerDay: 20, deliver: "carrier pigeon", watch: ["runs", "gossip", 5], instructions: 7, people: { owner: { on: true }, bad: 3, m_a: { on: "x", notify: false } }, extra: "kept" } as unknown as ProactiveBot;
  const read = proactiveOf(odd);
  assert.deepEqual([read.enabled, read.setUp, read.every, read.sweepHours, read.maxPerDay, read.deliver, read.watch, read.instructions], [true, false, 30, 3, 20, "chat", ["runs"], ""]);
  assert.deepEqual(read.people, { owner: { on: true, notify: true }, m_a: { on: false, notify: false } });
  assert.equal((read as { extra?: string }).extra, "kept", "what a newer computer adds is not thrown away");
  // A value this phone has no choice for is shown, not changed: the computer may offer more later.
  assert.equal(proactiveOf({ enabled: true, every: 5 }).every, 5);
  assert.deepEqual(peopleOf({ enabled: true, people: "nope" } as unknown as ProactiveBot), {});
});

test("what a person may change: the owner everything, a managing member the shared settings, anyone else only their own alerts", () => {
  const entry: ProactiveBot = { enabled: true, setUp: true, people: { owner: { on: true, notify: true }, m_b: { on: true, notify: false } } };
  const owner = proactiveRules(entry, OWNER);
  assert.deepEqual([owner.shared, owner.all, owner.lookAround, owner.any], [true, true, true, true]);
  assert.deepEqual(owner.watches.map((watch) => watch.id), ["context", "runs", "tasks", "requests"]);
  const manager = proactiveRules(entry, { id: "m_a", manages: true });
  assert.deepEqual([manager.shared, manager.all, manager.lookAround, manager.mine, manager.any], [true, false, false, undefined, true]);
  assert.deepEqual(manager.watches.map((watch) => watch.id), ["context", "runs", "requests"], "tasks are the owner's");
  const listed = proactiveRules(entry, { id: "m_b", manages: false });
  assert.deepEqual([listed.shared, listed.all, listed.any], [false, false, true]);
  assert.deepEqual(listed.mine, { on: true, notify: false });
  assert.equal(proactiveRules(entry, { id: "m_c", manages: false }).any, false, "someone the bot doesn't look out for, whose role doesn't manage it, has nothing to change");
  assert.deepEqual(proactiveRules(undefined, OWNER, false).watches.map((watch) => watch.id), ["runs", "tasks", "requests"], "an older host never gets a context watch");
});

test("where a bot's agent stands for the person looking", () => {
  const part = { enabled: true };
  assert.equal(proactiveStanding(part, undefined, "owner"), "setup");
  assert.equal(proactiveStanding(part, { enabled: true, setUp: false, people: { owner: { on: true, notify: true } } }, "owner"), "setup", "on, but its setup steps are not finished: nothing runs");
  const entry = { enabled: true, setUp: true, people: { owner: { on: true, notify: true }, m_a: { on: false, notify: true } } };
  assert.equal(proactiveStanding(part, entry, "owner"), "on");
  assert.equal(proactiveStanding({ enabled: false }, entry, "owner"), "paused");
  assert.equal(proactiveStanding(part, { ...entry, enabled: false }, "owner"), "off");
  assert.equal(proactiveStanding(part, entry, "m_a"), "mine-off");
  assert.equal(proactiveStanding(part, entry, "m_b"), "out");
  assert.deepEqual([personLine({ on: true, notify: true }), personLine({ on: true, notify: false }), personLine({ on: false, notify: true })], ["On · notified", "On · not notified", "Off"]);
});

test("the setup steps: four of them, the person running them ticked, and what finishing saves", () => {
  assert.deepEqual(WIZARD_STEPS, ["people", "notify", "matters", "often"]);
  assert.equal(WIZARD.title.people("Mira"), "Who should Mira look out for?");
  assert.equal(WIZARD.title.notify("Mira"), "Who gets notified?");
  assert.equal(WIZARD.title.matters("Mira"), "What matters most?");
  assert.equal(WIZARD.title.often("Mira"), "How often");
  assert.match(WIZARD.note.often, /more of the bot's model plan/);
  assert.deepEqual([ALERT.take, ALERT.later], ["Take care of it", "Not now"]);
  for (const words of [...Object.values(WIZARD.note), ...WIZARD_STEPS.map((step) => WIZARD.title[step]("Mira")), ...Object.values(ALERT)]) assert.doesNotMatch(words, /Proactive agent/);

  const team = {
    people: [{ id: "owner", name: "Alex" }],
    roles: [{ id: "r_see", perms: { agents: ["view", "chat"] }, bots: ["bot-mira"] }, { id: "r_none", perms: { agents: ["view"] }, bots: [] as string[] }],
    groups: [{ id: "g_see", roleId: "r_see" }, { id: "g_none", roleId: "r_none" }],
    members: [{ id: "m_sam", name: "Sam", groupId: "g_see" }, { id: "m_pat", name: "Pat", groupId: "g_none" }],
  };
  // The owner is shown everyone whose role sees the bot; they are ticked, nobody else is.
  const people = wizardPeople(team, "bot-mira", OWNER);
  assert.deepEqual(people, [{ id: "owner", name: "Alex", you: true }, { id: "m_sam", name: "Sam", you: false }]);
  const draft = wizardStart(undefined, OWNER, people);
  assert.deepEqual(draft, { people: { owner: { on: true, notify: true }, m_sam: { on: false, notify: true } }, watch: ["runs", "tasks", "requests", "context"], instructions: "", sweepHours: 3, every: 30, maxPerDay: 6 });
  assert.equal(wizardReady(draft), true);
  assert.equal(wizardReady({ ...draft, people: { owner: { on: false, notify: true } } }), false);

  // Finishing: set up and on, each ticked person on with their notify choice, the free line saved as the rules.
  const chosen = { ...draft, people: { owner: { on: true, notify: true }, m_sam: { on: true, notify: false } }, watch: ["runs", "requests"], instructions: "  Tell me about my manager the same day. ", sweepHours: 0, every: 60, maxPerDay: 3 };
  assert.deepEqual(wizardPatch(chosen, undefined, OWNER), {
    setUp: true,
    enabled: true,
    people: { owner: { on: true, notify: true }, m_sam: { on: true, notify: false } },
    watch: ["runs", "requests"],
    instructions: "Tell me about my manager the same day.",
    every: 60,
    maxPerDay: 3,
    sweepHours: 0,
  });
  // Run again later: what was set is shown, and unticking a person takes them out.
  const before = { enabled: true, setUp: true, every: 60, maxPerDay: 3, sweepHours: 0, watch: ["runs"], instructions: "Mine.", people: { owner: { on: true, notify: false }, m_sam: { on: true, notify: true } } };
  const again = wizardStart(before, OWNER, people);
  assert.deepEqual([again.people, again.every, again.instructions], [{ owner: { on: true, notify: false }, m_sam: { on: true, notify: true } }, 60, "Mine."]);
  assert.deepEqual(wizardPatch({ ...again, people: { ...again.people, m_sam: { on: false, notify: true } } }, before, OWNER).people, { owner: { on: true, notify: false }, m_sam: null });

  // A member is shown only themselves, never look-around or tasks, and their change names nobody else.
  const sam = { id: "m_sam", name: "Sam", manages: true };
  const samPeople = wizardPeople(team, "bot-mira", sam);
  assert.deepEqual(samPeople, [{ id: "m_sam", name: "Sam", you: true }]);
  const samDraft = wizardStart(undefined, sam, samPeople);
  assert.deepEqual([samDraft.people, samDraft.watch, samDraft.sweepHours], [{ m_sam: { on: true, notify: true } }, ["runs", "requests", "context"], 0]);
  const samPatch = wizardPatch(samDraft, undefined, sam);
  assert.deepEqual(samPatch.people, { m_sam: { on: true, notify: true } });
  assert.equal("sweepHours" in samPatch, false);
  // What the steps save passes the computer's own rule, for the owner and for a managing member.
  const full = { ...team, roles: [...team.roles, { id: "r_mgr", perms: { agents: ["view", "chat", "manage"] }, bots: ["bot-mira"] }], groups: [...team.groups, { id: "g_mgr", roleId: "r_mgr" }], members: [{ id: "m_sam", name: "Sam", groupId: "g_mgr" }, team.members[1]] };
  assert.ok(proactivePatch({ patch: wizardPatch(chosen, undefined, OWNER), start: { people: {}, sweepHours: 3, watch: [] }, by: "owner", team: full, botId: "bot-mira" }));
  assert.ok(proactivePatch({ patch: samPatch, start: { people: {}, sweepHours: 0, watch: [] }, by: "m_sam", team: full, botId: "bot-mira" }));
  assert.throws(() => proactivePatch({ patch: { people: { m_pat: { on: true } } }, start: { people: {} }, by: "owner", team: full, botId: "bot-mira" }), /Pat's team role can't see this bot/);
});

test("the list of bots with an agent follows the computer's switch and the bots' order", () => {
  const part: ProactivePart = { enabled: false, bots: { b: { enabled: true, every: 60, sweepHours: 0, pings: 2, maxPerDay: 6 }, a: { enabled: false }, c: { enabled: true } } };
  const listed = proactiveBots(part, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
  assert.deepEqual(listed.map((item) => item.bot.id), ["b", "c"]);
  assert.equal(proactiveSummary(listed[0].p), "Every 1 hour · 2 of 6 alerts today");
  assert.equal(isPaused(part, part.bots.b), true, "on, but the computer's switch is off");
  assert.equal(isPaused({ ...part, enabled: true }, part.bots.b), false);
  assert.equal(isPaused(part, part.bots.a), false, "an agent that is off is not paused");
  assert.deepEqual(proactiveBots(undefined, [{ id: "a" }]), []);
});

test("a member's setup steps can save their choices without ending the owner's pause", () => {
  const viewer = { id: "m_sam", manages: true };
  const paused = { enabled: false, setUp: true, pausedBy: "owner", people: { m_sam: { on: true, notify: true } } } as const;
  const draft = wizardStart(paused, viewer, [{ id: viewer.id, name: "Sam", you: true }]);
  assert.equal(wizardPatch(draft, paused, viewer).enabled, undefined);
  assert.equal(wizardPatch(draft, paused, OWNER).enabled, true);
});

test("the recent log is newest first, at most what is asked, and skips what it can't read", () => {
  const line = (n: number) => ({ at: n, reason: "sweep", signals: 0, outcome: "silent", runId: "r" + n });
  const entry = { enabled: true, log: [line(3), { at: "x", reason: "sweep", outcome: "silent", runId: "bad" }, { ...line(2), outcome: "exploded" }, line(1)] } as unknown as ProactiveBot;
  assert.deepEqual(recentLog(entry).map((l) => l.runId), ["r3", "r1"]);
  assert.equal(recentLog(entry, 1).length, 1);
  assert.deepEqual(recentLog({ enabled: true, log: "nope" } as unknown as ProactiveBot), []);
  assert.deepEqual(recentLog(undefined), []);
});

test("through the link: the owner sets anyone, a member only their own entry, each is sent only their own, and an alert is its recipient's", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-proactive-"));
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, relay: false, port: 0, extraHosts: ["127.0.0.1"] });
  (backend as any).teamOf = () => link.store.data.team;
  const clients: LinkClient[] = [];
  try {
    await link.setEnabled(true);
    const fetcher = fetch as unknown as FetchLike;
    const target = (code: string) => ({ hosts: ["127.0.0.1:" + link.port], code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name });
    const ownerPairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
    const ownerParts: Record<string, any> = {};
    const owner = new LinkClient(ownerPairing, { fetch: fetcher, onParts: (next) => Object.assign(ownerParts, next), onState() {} });
    clients.push(owner);
    owner.start();
    // Managers manage Mira; everyone else (the Guest role) only sees Mira.
    const guest = structuredClone(link.store.data.team.roles.find((role: any) => role.id === "r_guest"));
    guest.bots = ["bot-mira"];
    await owner.call("link.team.saveRole", guest);
    await owner.call("link.team.saveRole", { ...structuredClone(guest), id: "r_0123456789", name: "Manager", perms: { ...guest.perms, agents: ["view", "chat", "manage"] } });
    const managers = { id: "g_managers" };
    await owner.call("link.team.saveGroup", { id: managers.id, name: "Managers", roleId: "r_0123456789" });

    const join = async (name: string, groupId: string) => {
      const invite = await owner.call<any>("link.team.createInvite", { groupId, days: 7, maxUses: 1 });
      const started = await startJoin(fetcher, target(invite.code), { name: name + "'s phone", platform: "ios", kind: "phone" });
      if (started.result.status !== "pending") throw new Error("not pending");
      await owner.call("link.team.approve", started.result.requestId);
      const checked = await checkJoin(fetcher, started.attempt);
      if (checked.status !== "approved") throw new Error("not approved");
      const parts: Record<string, any> = {};
      const client = new LinkClient(checked.pairing, { fetch: fetcher, onParts: (next) => Object.assign(parts, next), onState() {} });
      clients.push(client);
      client.start();
      return { client, parts };
    };
    const until = async (test: () => boolean, label: string) => {
      const end = Date.now() + 6000;
      while (!test()) {
        if (Date.now() > end) throw new Error("Timed out waiting for " + label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const sam = await join("Sam", managers.id);
    const pat = await join("Pat", "g_everyone");
    const idOf = (name: string) => link.store.data.team.members.find((member: any) => member.name === name + "'s phone" || member.name === name).id as string;
    const samId = idOf("Sam");
    const patId = idOf("Pat");
    await until(() => Array.isArray(sam.parts.bots) && !!sam.parts.proactive && !!pat.parts.proactive, "the members' parts");
    assert.ok(ownerParts.meta.capabilities.includes("proactive-team-v1"));
    assert.deepEqual(sam.parts.proactive, { enabled: true, bots: {} }, "the computer's switch is on from the start; no bot is set up");

    // The computer's switch is the owner's alone.
    await assert.rejects(sam.client.call("setPreferences", { proactive: { enabled: false } }), /display preferences only|can't do that/);
    await assert.rejects(owner.call("setPreferences", { proactive: { botId: "bot-mira" } }), /Unknown Proactive agent setting/);

    // The owner finishes the setup steps for themselves and Pat. Each is sent the shared settings and only their own entry.
    const team = { ...link.store.data.team, people: [{ id: "owner", name: "Alex" }] };
    const people = wizardPeople(team, "bot-mira", OWNER);
    assert.deepEqual(people.map((person) => person.id).sort(), ["owner", patId, samId].sort());
    const draft = wizardStart(undefined, OWNER, people);
    draft.people[patId] = { on: true, notify: false };
    draft.instructions = "Skip newsletters.";
    await owner.call("setBotProactive", "bot-mira", wizardPatch(draft, undefined, OWNER));
    const mira = () => (backend as any).state.proactive.bots["bot-mira"];
    assert.deepEqual([mira().setUp, mira().enabled, mira().instructions], [true, true, "Skip newsletters."]);
    assert.deepEqual(mira().people, { owner: { on: true, notify: true }, [patId]: { on: true, notify: false } });
    await until(() => pat.parts.proactive?.bots?.["bot-mira"]?.people?.[patId]?.on === true, "Pat's entry in Pat's parts");
    assert.deepEqual(pat.parts.proactive.bots["bot-mira"].people, { [patId]: { on: true, notify: false } }, "only their own entry");
    assert.equal(pat.parts.proactive.bots["bot-mira"].instructions, "Skip newsletters.");
    await until(() => !!sam.parts.proactive?.bots?.["bot-mira"], "the bot in Sam's parts");
    assert.deepEqual(sam.parts.proactive.bots["bot-mira"].people, {}, "Sam is not one of its people yet");
    await until(() => Object.keys(ownerParts.proactive?.bots?.["bot-mira"]?.people ?? {}).length === 2, "the owner's parts");

    // Pat (sees the bot, doesn't manage it) changes only their own alerts.
    await pat.client.call("setBotProactive", "bot-mira", { people: { [patId]: { notify: true } } });
    assert.deepEqual(mira().people[patId], { on: true, notify: true });
    await assert.rejects(pat.client.call("setBotProactive", "bot-mira", { people: { owner: { on: false } } }), /only your own/);
    await assert.rejects(pat.client.call("setBotProactive", "bot-mira", { every: 15 }), /can't change this bot's Proactive settings/);
    await assert.rejects(pat.client.call("setBotProactive", "bot-patch", { people: { [patId]: { on: true } } }), /isn't available to your team role/);
    await pat.client.call("setBotProactive", "bot-mira", { people: { [patId]: { on: false } } });
    assert.equal(mira().people[patId].on, false, "they opt out");
    // Taken out by the owner, Pat can't come back alone.
    await owner.call("setBotProactive", "bot-mira", { people: { [patId]: null } });
    await assert.rejects(pat.client.call("setBotProactive", "bot-mira", { people: { [patId]: { on: true } } }), /can't add you/);

    // Sam (manages the bot) adds themselves and changes what the people share, but never look-around or another person.
    await sam.client.call("setBotProactive", "bot-mira", { people: { [samId]: { on: true } }, every: 60 });
    assert.deepEqual([mira().people[samId], mira().every], [{ on: true, notify: true }, 60]);
    await assert.rejects(sam.client.call("setBotProactive", "bot-mira", { sweepHours: 6 }), /Only the owner/);
    await assert.rejects(sam.client.call("setBotProactive", "bot-mira", { people: { owner: null } }), /only your own/);
    await assert.rejects(sam.client.call("setBotProactive", "bot-mira", { enabled: false }), /Only the owner can turn this bot's Proactive agent off/);
    await assert.rejects(sam.client.call("setBotProactive", "bot-mira", { people: { [samId]: { tell: patId } } }), /Unknown setting for a person/, "nobody is told of another person's alerts");

    // The demo sends each person it looks out for one alert with an offer. It is in their own chat, and theirs alone to act on.
    const alertIn = (parts: Record<string, any>) => parts.chats?.find((chat: any) => chat.botId === "bot-mira" && !chat.schedules);
    const alerts = [...(backend as any).proactiveAlerts.entries()] as [string, any][];
    const [samsRun, samsAlert] = alerts.find(([, alert]) => alert.person === samId)!;
    const [ownersRun] = alerts.find(([, alert]) => alert.person === "owner")!;
    await until(() => !!alertIn(sam.parts), "the chat with Sam's alert in Sam's parts");
    const message = (backend as any).state.chats.find((chat: any) => chat.id === samsAlert.chatId).messages.at(-1);
    assert.equal(message.alert.offer, "Draft who takes what");
    assert.equal(JSON.stringify(message).includes(samsAlert.prompt), false, "the offer's request stays on the computer");
    await assert.rejects(owner.call("proactiveAct", "bot-mira", samsRun, "take"), /no longer available/);
    await assert.rejects(pat.client.call("proactiveAct", "bot-mira", samsRun, "later"), /no longer available/);
    await assert.rejects(sam.client.call("proactiveAct", "bot-mira", ownersRun, "take"), /no longer available/);
    const samsChat = (backend as any).state.chats.find((chat: any) => chat.id === samsAlert.chatId);
    await t.test("a member cannot share their private alert in the demo", async () => {
      await assert.rejects(sam.client.call("link.team.inviteToChat", samsAlert.chatId, "owner"), /holds one person's alerts and can't be shared/);
      assert.equal(ownerParts.chats.some((chat: { id: string }) => chat.id === samsAlert.chatId), false);
    });
    await t.test("a demo offer starts a new chat with only its request", async () => {
      const taken = await sam.client.call<any>("proactiveAct", "bot-mira", samsRun, "take");
      assert.notEqual(taken.chatId, samsAlert.chatId);
      const work = (backend as any).state.chats.find((chat: any) => chat.id === taken.chatId);
      assert.equal(work.createdBy, samId);
      assert.equal(work.title, message.alert.offer);
      assert.equal(work.schedules, undefined);
      assert.equal(work.messages.some((item: any) => item.alert || item.text === message.text), false);
      assert.equal(samsChat.messages.find((item: any) => item.proactiveRunId === samsRun).alert.chosen, "take");
      assert.ok(work.messages.some((item: any) => item.role === "user" && item.text === samsAlert.prompt && item.author?.memberId === samId), "a normal turn, as Sam's own message");
      await assert.rejects(sam.client.call("proactiveAct", "bot-mira", samsRun, "later"), /already chose/);
    });
    await t.test("an owner phone can watch and page the approval without seeing the alert", async () => {
      const state = (backend as any).state;
      state.requests.push({ id: "approval-alert", kind: "permission", chatId: samsChat.id, title: "Approve report?" });
      samsChat.messages.push({ role: "user", text: "Please run the report.", time: Date.now() });
      owner.watch([samsChat.id]);
      backend.changed();
      try {
        const key = "chat:" + samsChat.id;
        await until(() => !!ownerParts[key], "the approval chat in the owner's parts");
        const page = await owner.call("link.messages", samsChat.id, samsChat.messages.length, 32);
        for (const view of [ownerParts[key], page]) {
          assert.ok(JSON.stringify(view).includes("Please run the report."));
          assert.ok(!JSON.stringify(view).includes(message.text));
          assert.ok(!JSON.stringify(view).includes(samsRun));
        }
      } finally {
        state.requests.pop();
        owner.watch([]);
        backend.changed();
      }
    });
    await t.test("a demo manager cannot resume a bot paused by the owner", async () => {
      await owner.call("setBotProactive", "bot-mira", { enabled: false });
      await assert.rejects(sam.client.call("setBotProactive", "bot-mira", { enabled: true }), /The owner paused this bot's Proactive agent/);
      await until(() => sam.parts.proactive?.bots?.["bot-mira"]?.pausedBy === "owner", "the owner's pause in Sam's parts");
      const viewer = { id: samId, manages: true };
      const paused = sam.parts.proactive.bots["bot-mira"];
      const draft = wizardStart(paused, viewer, wizardPeople(team, "bot-mira", viewer));
      await sam.client.call("setBotProactive", "bot-mira", wizardPatch(draft, paused, viewer));
      assert.equal(mira().enabled, false);
      await owner.call("setBotProactive", "bot-mira", { enabled: true });
      assert.equal(mira().enabled, true);
    });
    const later = await owner.call<any>("proactiveAct", "bot-mira", ownersRun, "later");
    assert.ok(later.until > Date.now());

    // A member's null takes only that member out; the owner's forgets everything.
    await sam.client.call("setBotProactive", "bot-mira", null);
    assert.deepEqual(Object.keys(mira().people), ["owner"]);
    await owner.call("setBotProactive", "bot-mira", null);
    assert.equal(mira(), undefined);

    // Reminders are one switch among the computer's notification settings, on from the start.
    assert.equal(ownerParts.settings.notifications.reminders, true);
    await owner.call("setPreferences", { notifications: { ...ownerParts.settings.notifications, reminders: false } });
    await until(() => ownerParts.settings.notifications.reminders === false, "the switch");
  } finally {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
