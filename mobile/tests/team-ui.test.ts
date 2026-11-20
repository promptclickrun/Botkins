import assert from "node:assert/strict";
import { test } from "node:test";
import type { JoinAttempt } from "../src/link/client";
import { LinkError } from "../src/link/client";
import {
  joinRouteParams,
  parseInviteInput,
  pollJoinState,
  readJoinResume,
} from "../src/features/pair/joinLogic";
import { can, toggleRoleAction } from "../src/state/team";

test("team permissions treat a later action as implying the first action", () => {
  const member = {
    meta: { you: { kind: "member", memberId: "m_1", name: "Sam" } },
    team: {
      me: {
        memberId: "m_1",
        name: "Sam",
        group: { id: "g_1", name: "Writers" },
        role: {
          name: "Writer",
          perms: { agents: ["chat"], today: [], skills: [], mcp: [], plugins: [], settings: [] },
          bots: "all",
        },
      },
      team: { name: "Studio" },
    },
  };

  assert.equal(can(member, "agents", "view"), true);
  assert.equal(can(member, "agents", "chat"), true);
  assert.equal(can(member, "agents", "manage"), false);
  assert.equal(can({ meta: { you: { kind: "owner" } } }, "agents", "delete"), true);
});

test("role toggles keep every permission gated by its first action", () => {
  const added = toggleRoleAction({ agents: [] }, "agents", "manage", true);
  assert.deepEqual(added.agents, ["view", "manage"]);
  const more = toggleRoleAction(added, "agents", "chat", true);
  assert.deepEqual(more.agents, ["view", "chat", "manage"]);
  const hidden = toggleRoleAction(more, "agents", "view", false);
  assert.deepEqual(hidden.agents, []);
  assert.deepEqual(toggleRoleAction({ today: ["view", "use"] }, "today", "use", false).today, ["view"]);
});

test("invite input normalizes aliases and formats ten characters live", () => {
  assert.deepEqual(parseInviteInput(" il-o1234567 "), { code: "11012-34567", serverKey: undefined });
  assert.deepEqual(parseInviteInput("botkins://join?c=12345-67890&k=" + "A".repeat(43)), {
    code: "12345-67890",
    serverKey: "A".repeat(43),
  });
  assert.deepEqual(joinRouteParams({ c: "abcde-fghij", k: "B".repeat(43) }), {
    code: "ABCDE-FGH1J",
    serverKey: "B".repeat(43),
  });
});

test("join polling reaches terminal states and resumes a saved attempt", async () => {
  const attempt: JoinAttempt = {
    target: { code: "1234567890", serverKey: "A".repeat(43), serverId: "server", hosts: ["localhost:1"], name: "Studio" },
    device: { name: "Phone", platform: "ios", kind: "phone" },
    keys: { publicKey: "public", secretKey: "secret" },
  };
  const outcomes = [
    { status: "pending", requestId: "request", team: { name: "Studio" } },
    { status: "denied" },
  ] as const;
  for (const outcome of outcomes) {
    const state = await pollJoinState(attempt, async () => outcome);
    assert.equal(state.phase, outcome.status);
  }
  assert.equal((await pollJoinState(attempt, async () => {
    throw new LinkError("join_closed", "closed");
  })).phase, "closed");
  assert.equal((await pollJoinState(attempt, async () => {
    throw new LinkError("offline", "offline");
  })).phase, "offline");
  assert.equal((await pollJoinState(attempt, async () => {
    throw new LinkError("join_wait", "wait");
  })).phase, "wait");

  let reads = 0;
  const resumed = await readJoinResume(
    async () => {
      reads++;
      return JSON.stringify(attempt);
    },
    async (saved) => ({ status: "approved", pairing: { serverId: saved.target.serverId!, serverKey: saved.target.serverKey, deviceId: "device", secretKey: saved.keys.secretKey, hosts: saved.target.hosts, name: "Studio", member: true } }),
  );
  assert.equal(reads, 1);
  assert.equal(resumed?.state.phase, "approved");
  assert.equal(resumed?.attempt.target.code, "1234567890");
});
