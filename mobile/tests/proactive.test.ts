// A bot's Proactive agent ("proactive-agent-v2"): how the phone reads what the computer sends (tolerantly), and, through
// the link against the demo computer, who may set whose agent: the owner's switch for the computer is the owner's alone,
// a member whose role manages a bot sets their own agent for it and no other, and a member is sent only their own.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, checkJoin, pair, startJoin } from "../src/link/client";
import { isPaused, proactiveBots, proactiveOf, proactiveRules, proactiveSummary, recentLog } from "../src/features/bots/proactive";
import type { ProactiveBot, ProactivePart } from "../src/link/types";

test("an agent is read with the usual settings for what the computer left out or sent in a shape this phone doesn't know", () => {
  assert.deepEqual(proactiveOf(undefined), { enabled: false, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests"], instructions: "" });
  const odd = { enabled: true, every: "soon", sweepHours: -1, maxPerDay: 20, deliver: "carrier pigeon", watch: ["runs", "gossip", 5], instructions: 7, extra: "kept" } as unknown as ProactiveBot;
  const read = proactiveOf(odd);
  assert.deepEqual([read.enabled, read.every, read.sweepHours, read.maxPerDay, read.deliver, read.watch, read.instructions], [true, 30, 3, 20, "chat", ["runs"], ""]);
  assert.equal((read as { extra?: string }).extra, "kept", "what a newer computer adds is not thrown away");
  // A value this phone has no choice for is shown, not changed: the computer may offer more later.
  assert.equal(proactiveOf({ enabled: true, every: 5 }).every, 5);
  // Another person's agent is only known to be there.
  assert.equal(proactiveOf({ enabled: true, taken: true }).every, 30);
});

test("what a person may change: not another person's agent, and as a member neither look-around nor tasks", () => {
  assert.deepEqual(proactiveRules(undefined, false).watches.map((watch) => watch.id), ["runs", "tasks", "requests"]);
  assert.equal(proactiveRules(undefined, false).lookAround, true);
  const member = proactiveRules({ enabled: false, mine: true }, true);
  assert.deepEqual(member.watches.map((watch) => watch.id), ["runs", "requests"]);
  assert.equal(member.lookAround, false);
  assert.equal(proactiveRules({ enabled: true, taken: true }, true).taken, true);
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

test("the recent log is newest first, at most what is asked, and skips what it can't read", () => {
  const line = (n: number) => ({ at: n, reason: "sweep", signals: 0, outcome: "silent", runId: "r" + n });
  const entry = { enabled: true, log: [line(3), { at: "x", reason: "sweep", outcome: "silent", runId: "bad" }, { ...line(2), outcome: "exploded" }, line(1)] } as unknown as ProactiveBot;
  assert.deepEqual(recentLog(entry).map((l) => l.runId), ["r3", "r1"]);
  assert.equal(recentLog(entry, 1).length, 1);
  assert.deepEqual(recentLog({ enabled: true, log: "nope" } as unknown as ProactiveBot), []);
  assert.deepEqual(recentLog(undefined), []);
});

test("the computer's switch is the owner's; a member sets their own agent on a bot they manage and is sent only that", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-proactive-"));
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, relay: false, port: 0, extraHosts: ["127.0.0.1"] });
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
    // Members manage Mira only.
    const manager = structuredClone(link.store.data.team.roles.find((role: any) => role.id === "r_guest"));
    manager.perms.agents = ["view", "chat", "manage"];
    manager.bots = ["bot-mira"];
    await owner.call("link.team.saveRole", manager);

    const join = async (name: string) => {
      const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
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
    const sam = await join("Sam");
    const pat = await join("Pat");
    await until(() => Array.isArray(sam.parts.bots) && !!sam.parts.proactive && !!pat.parts.proactive, "the members' parts");
    assert.deepEqual(sam.parts.proactive, { enabled: false, bots: {} });

    // The computer's switch is the owner's alone.
    await assert.rejects(sam.client.call("setPreferences", { proactive: { enabled: true } }), /display preferences only|can't do that/);
    await owner.call("setPreferences", { proactive: { enabled: true } });
    await until(() => sam.parts.proactive?.enabled === true, "the switch in a member's parts");
    // A bot's agent is not a computer setting: the old way of choosing a bot is refused.
    await assert.rejects(owner.call("setPreferences", { proactive: { botId: "bot-mira" } }), /Unknown Proactive agent setting/);

    // A member sets their own agent on the bot they manage, and not on another.
    await sam.client.call("setBotProactive", "bot-mira", { enabled: true, every: 60, instructions: "Sam's own rules" });
    await assert.rejects(sam.client.call("setBotProactive", "bot-patch", { enabled: true }), /isn't available to your team role/);
    assert.deepEqual(Object.keys(backend.state.proactive.bots), ["bot-mira"]);
    assert.equal(backend.state.proactive.bots["bot-mira"].person, link.store.data.team.members[0].id);
    await assert.rejects(sam.client.call("setBotProactive", "bot-mira", { sweepHours: 3 }), /Only the owner/, "a member's agent never looks around the computer's own accounts");

    // Sam is sent their agent, as theirs; Pat only that someone has set one up; the owner is sent whose it is.
    await until(() => sam.parts.proactive?.bots?.["bot-mira"]?.mine === true, "Sam's agent in Sam's parts");
    const mine = sam.parts.proactive.bots["bot-mira"];
    assert.deepEqual([mine.enabled, mine.every, mine.instructions, "person" in mine], [true, 60, "Sam's own rules", false]);
    await until(() => pat.parts.proactive?.bots?.["bot-mira"]?.taken === true, "Pat's parts");
    assert.deepEqual(pat.parts.proactive.bots["bot-mira"], { enabled: true, taken: true });
    assert.equal(JSON.stringify(pat.parts).includes("Sam's own rules"), false);
    await until(() => ownerParts.proactive?.bots?.["bot-mira"]?.person === link.store.data.team.members[0].id, "the owner's parts");

    // Pat may not change Sam's agent; the owner may, and forgetting it frees the bot.
    await assert.rejects(pat.client.call("setBotProactive", "bot-mira", { enabled: false }), /set up for someone else/);
    await assert.rejects(pat.client.call("setBotProactive", "bot-mira", null), /set up for someone else/);
    await owner.call("setBotProactive", "bot-mira", { maxPerDay: 3 });
    assert.equal(backend.state.proactive.bots["bot-mira"].maxPerDay, 3);
    assert.equal(backend.state.proactive.bots["bot-mira"].person, link.store.data.team.members[0].id, "the owner's change doesn't make it the owner's");
    await owner.call("setBotProactive", "bot-mira", null);
    await pat.client.call("setBotProactive", "bot-mira", { enabled: true });
    assert.equal(backend.state.proactive.bots["bot-mira"].person, link.store.data.team.members[1].id);
    assert.equal(backend.state.proactive.bots["bot-mira"].instructions, "", "Sam's rules did not go to Pat");
  } finally {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
