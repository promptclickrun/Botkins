// Tests for Settings › Channels: status mapping, blocked-event-to-fix mapping,
// secret clearing after submit, allowlist edits, owner-only enforcement, and
// end-to-end LinkHost channelAdd/channelUpdate token scrubbing + no-leak guarantee.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { REMOTE_METHODS } from "../link-host/methods.mjs";
import { LinkClient, pair } from "../src/link/client";
import type { ChannelAuditEntry, ChannelConnection } from "../src/link/types";
import {
  addAllowlistSender,
  auditEntryDisplay,
  blockedEventFixPlan,
  buildSecretsPayload,
  CHANNEL_KIND_SPECS,
  channelStatusMeta,
  collectPendingPairings,
  computeTodayStats,
  effectivePolicy,
  filterAllowlist,
  filterAuditEntries,
  formatTimeLeft,
  groupAuditByDay,
  isBrokenConnection,
  removeAllowlistSender,
  submitAndClearSecrets,
} from "../src/features/settings/channels/logic";

const fetcher = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => {
  const response = await fetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body,
    signal: init?.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
  };
};

function makeConn(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: "ch_test",
    kind: "slack",
    label: "Acme Slack",
    transport: "socket_mode",
    enabled: true,
    paused: false,
    botId: "bot-mira",
    configuredSecrets: ["appToken", "botToken"],
    policy: {
      dm: "pairing",
      allowlist: [{ senderId: "U1", display: "Colt", addedAt: 1_700_000_000_000, source: "manual" }],
      groups: { enabled: true, mode: "mention", channels: ["#general"] },
      toolProfile: "restricted",
      notifyPhone: false,
      limits: {
        senderPerMinute: 10,
        connectionPerMinute: 60,
        maxInboundLength: 4000,
        maxAttachmentBytes: 5 * 1024 * 1024,
        allowedAttachmentTypes: ["image/*"],
        dailyTurnCap: 200,
      },
    },
    pendingPairings: [],
    status: { state: "connected", detail: "" },
    ...overrides,
  };
}

test("status mapping covers connected, auth_error, reconnecting, waiting_permission, paused, disabled, and disconnected", () => {
  const connected = channelStatusMeta(makeConn({ status: { state: "connected" } }));
  assert.equal(connected.pillLabel, "Live");
  assert.equal(connected.detailLabel, "Connected");
  assert.equal(connected.tone, "success");
  assert.equal(connected.dot, true);
  assert.equal(connected.broken, false);

  const authErr = channelStatusMeta(makeConn({ status: { state: "auth_error", detail: "Token rejected" } }));
  assert.equal(authErr.pillLabel, "Error");
  assert.equal(authErr.tone, "danger");
  assert.equal(authErr.broken, true);
  assert.equal(isBrokenConnection(makeConn({ status: { state: "auth_error" } })), true);

  const reconnecting = channelStatusMeta(makeConn({ status: { state: "reconnecting" } }));
  assert.equal(reconnecting.pillLabel, "Reconnecting");
  assert.equal(reconnecting.tone, "warning");
  assert.equal(reconnecting.broken, false);

  const waiting = channelStatusMeta(makeConn({ status: { state: "waiting_permission" } }));
  assert.equal(waiting.pillLabel, "Waiting");
  assert.equal(waiting.tone, "warning");
  assert.equal(waiting.broken, true);

  const paused = channelStatusMeta(makeConn({ paused: true, status: { state: "paused" } }));
  assert.equal(paused.pillLabel, "Paused");
  assert.equal(paused.tone, "neutral");
  assert.equal(paused.broken, false);

  const disabled = channelStatusMeta(makeConn({ enabled: false, status: { state: "disabled" } }));
  assert.equal(disabled.pillLabel, "Disabled");
  assert.equal(disabled.broken, false);

  const disconnected = channelStatusMeta(makeConn({ enabled: true, paused: false, status: { state: "disconnected" } }));
  assert.equal(disconnected.pillLabel, "Offline");
  assert.equal(disconnected.broken, true);
});

test("blocked-event-to-fix mapping generates exact channelSetPolicy patches without exposing message bodies", () => {
  const conn = makeConn();

  // 1. Group mention_required -> Allow this person + Answer everyone in #general
  const mentionEntry: ChannelAuditEntry = {
    time: Date.now(),
    connectionId: conn.id,
    kind: "slack",
    senderId: "8812034",
    conversationId: "#general",
    decision: "denied",
    reason: "mention_required",
  };
  const mentionPlan = blockedEventFixPlan(mentionEntry, conn);
  assert.equal(mentionPlan.title, "8812034 was blocked");
  assert.equal(mentionPlan.actions.length, 2);
  assert.equal(mentionPlan.actions[0].id, "allow_sender");
  assert.ok(mentionPlan.actions[0].patch.allowlist?.some((a) => a.senderId === "8812034"));
  assert.equal(mentionPlan.actions[1].id, "group_mode_all");
  assert.equal(mentionPlan.actions[1].patch.groups?.mode, "all");
  assert.equal(mentionPlan.actions[1].patch.groups?.enabled, true);

  // 2. DM not_allowlisted -> Allow this person + Switch DMs to Pairing
  const allowlistPlan = blockedEventFixPlan(
    { time: Date.now(), connectionId: conn.id, kind: "slack", senderId: "U999", conversationId: "D999", decision: "denied", reason: "not_allowlisted" },
    conn,
  );
  assert.equal(allowlistPlan.actions[0].id, "allow_sender");
  assert.ok(allowlistPlan.actions[0].patch.allowlist?.some((a) => a.senderId === "U999"));
  assert.equal(allowlistPlan.actions[1].patch.dm, "pairing");

  // 3. DM off -> Enable allowlist with sender + Turn on Pairing
  const dmOffPlan = blockedEventFixPlan(
    { time: Date.now(), connectionId: conn.id, kind: "slack", senderId: "U888", conversationId: "D888", decision: "denied", reason: "dm_off" },
    conn,
  );
  assert.equal(dmOffPlan.actions[0].patch.dm, "allowlist");
  assert.ok(dmOffPlan.actions[0].patch.allowlist?.some((a) => a.senderId === "U888"));
  assert.equal(dmOffPlan.actions[1].patch.dm, "pairing");

  // 4. Groups off -> Enable groups + add channel
  const groupsOffPlan = blockedEventFixPlan(
    { time: Date.now(), connectionId: conn.id, kind: "slack", senderId: "U777", conversationId: "#ops", decision: "denied", reason: "groups_off" },
    makeConn({ policy: { groups: { enabled: false, mode: "mention", channels: [] } } }),
  );
  assert.equal(groupsOffPlan.actions[0].patch.groups?.enabled, true);
  assert.deepEqual(groupsOffPlan.actions[0].patch.groups?.channels, ["#ops"]);

  // 5. Group channel not listed -> Add conversation to groups.channels
  const unlistedPlan = blockedEventFixPlan(
    { time: Date.now(), connectionId: conn.id, kind: "slack", senderId: "U777", conversationId: "#random", decision: "denied", reason: "channel_not_listed" },
    conn,
  );
  assert.deepEqual(unlistedPlan.actions[0].patch.groups?.channels, ["#general", "#random"]);

  // 6. Rate limits and daily cap
  const ratePlan = blockedEventFixPlan(
    { time: Date.now(), connectionId: conn.id, kind: "discord", senderId: "spam-bot", conversationId: "DM", decision: "rate_limited", reason: "sender_rate_limit" },
    conn,
  );
  assert.equal(ratePlan.actions[0].patch.limits?.senderPerMinute, 20);

  const capPlan = blockedEventFixPlan(
    { time: Date.now(), connectionId: conn.id, kind: "slack", senderId: "U1", conversationId: "D1", decision: "rate_limited", reason: "daily_turn_cap" },
    conn,
  );
  assert.equal(capPlan.actions[0].patch.limits?.dailyTurnCap, 400);
});

test("secrets are validated per adapter spec and wiped from state and payload after submit (both success and failure)", async () => {
  // Adapter spec check
  assert.deepEqual(CHANNEL_KIND_SPECS.slack.secrets.map((s) => s.key), ["appToken", "botToken"]);
  assert.deepEqual(CHANNEL_KIND_SPECS.telegram.secrets.map((s) => s.key), ["botToken"]);
  assert.deepEqual(CHANNEL_KIND_SPECS.discord.secrets.map((s) => s.key), ["botToken"]);
  assert.deepEqual(CHANNEL_KIND_SPECS.imessage.secrets, []);

  // Missing required secret detection
  const partial = buildSecretsPayload("slack", { appToken: "  xapp-1-abc  ", botToken: "   " });
  assert.deepEqual(partial.secrets, { appToken: "xapp-1-abc" });
  assert.deepEqual(partial.missing.map((m) => m.key), ["botToken"]);

  // Success path: state cleared & passed payload wiped after submit resolves
  let stateDrafts: Record<string, string> = { appToken: "xapp-1-secret-abc", botToken: "xoxb-secret-xyz" };
  let capturedPayload: Record<string, string> | null = null;
  let seenDuringCall: Record<string, string> | null = null;

  await submitAndClearSecrets(
    stateDrafts,
    async (payload) => {
      capturedPayload = payload;
      seenDuringCall = { ...payload };
      return "ok";
    },
    () => {
      stateDrafts = {};
    },
  );
  assert.deepEqual(seenDuringCall, { appToken: "xapp-1-secret-abc", botToken: "xoxb-secret-xyz" });
  assert.deepEqual(stateDrafts, {});
  assert.deepEqual(capturedPayload, {});

  // Error path: state and payload STILL wiped even when RPC rejects
  let errorDrafts: Record<string, string> = { botToken: "tg-secret-failure-token" };
  let failedPayload: Record<string, string> | null = null;
  await assert.rejects(
    submitAndClearSecrets(
      errorDrafts,
      async (payload) => {
        failedPayload = payload;
        throw new Error("network down");
      },
      () => {
        errorDrafts = {};
      },
    ),
    /network down/,
  );
  assert.deepEqual(errorDrafts, {});
  assert.deepEqual(failedPayload, {});
});

test("allowlist edits add, deduplicate, update display, filter, and remove senders cleanly", () => {
  const base = effectivePolicy(makeConn()).allowlist;
  assert.equal(base.length, 1);

  const added = addAllowlistSender(base, " U2 ", "Maya R.", 1_700_000_000_500);
  assert.equal(added.length, 2);
  assert.deepEqual(added[1], {
    senderId: "U2",
    display: "Maya R.",
    addedAt: 1_700_000_000_500,
    source: "manual",
  });

  // Duplicate ID updates display without adding a second row
  const deduped = addAllowlistSender(added, "U2", "Maya Rivera");
  assert.equal(deduped.length, 2);
  assert.equal(deduped[1].display, "Maya Rivera");

  // Search matches either name or sender ID
  assert.equal(filterAllowlist(deduped, "maya").length, 1);
  assert.equal(filterAllowlist(deduped, "u1").length, 1);
  assert.equal(filterAllowlist(deduped, "nobody").length, 0);

  // Remove strips only the requested sender
  const removed = removeAllowlistSender(deduped, "U2");
  assert.deepEqual(removed.map((e) => e.senderId), ["U1"]);
});

test("audit display, day grouping, pairing collection, and today stats", () => {
  const now = new Date(2026, 10, 27, 15, 0, 0).getTime();
  const yesterday = now - 24 * 60 * 60 * 1000;
  const entries: ChannelAuditEntry[] = [
    { time: now - 60_000, connectionId: "c1", kind: "telegram", senderId: "Jordan", decision: "reply_sent", replyParts: 2 },
    { time: now - 120_000, connectionId: "c1", kind: "telegram", senderId: "Maya", decision: "paired", reason: "pairing_code_issued" },
    { time: now - 180_000, connectionId: "c2", kind: "slack", senderId: "8812034", conversationId: "#general", decision: "denied", reason: "mention_required" },
    { time: now - 240_000, connectionId: "c2", kind: "discord", senderId: "gw", decision: "error", reason: "turn_failed" },
    { time: yesterday, connectionId: "c1", kind: "telegram", senderId: "Old", decision: "denied", reason: "dm_off" },
  ];

  assert.equal(auditEntryDisplay(entries[0]).badgeLabel, "Replied");
  assert.equal(auditEntryDisplay(entries[0]).reasonText, "2 parts");
  assert.equal(auditEntryDisplay(entries[1]).category, "pairing");
  assert.equal(auditEntryDisplay(entries[2]).blocked, true);
  assert.equal(auditEntryDisplay(entries[3]).category, "errors");

  assert.equal(filterAuditEntries(entries, "blocked").length, 2);
  assert.equal(filterAuditEntries(entries, "blocked", "c2").length, 1);

  const days = groupAuditByDay(entries, now);
  assert.equal(days.length, 2);
  assert.equal(days[0].label, "Today");
  assert.equal(days[1].label, "Yesterday");

  const conn = makeConn({
    id: "c1",
    dailyUsage: { date: "2026-11-27", turns: 311 },
    pendingPairings: [
      { code: "ABC-123", senderId: "s1", display: "Maya", conversationId: "d1", createdAt: now - 3600_000, expiresAt: now + 21 * 3600_000 },
    ],
  });
  const stats = computeTodayStats([conn], entries, now);
  assert.equal(stats.turns, 311);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.newPeople, 1);

  const pairings = collectPendingPairings([conn]);
  assert.equal(pairings.length, 1);
  assert.equal(formatTimeLeft(pairings[0].expiresAt, now), "21h left");
});

test("security: channelAdd and channelUpdate over encrypted LinkHost never leak secrets into logs, responses, or errors", async (t) => {
  // Confirm every channel RPC is exposed on REMOTE_METHODS.
  for (const name of [
    "channelsList",
    "channelAdd",
    "channelUpdate",
    "channelRemove",
    "channelBind",
    "channelSetPolicy",
    "channelPause",
    "channelResume",
    "channelPairList",
    "channelPairApprove",
    "channelPairDeny",
    "channelTest",
    "channelLogs",
  ]) {
    assert.ok(REMOTE_METHODS.has(name), `REMOTE_METHODS missing ${name}`);
  }

  const dir = mkdtempSync(join(tmpdir(), "botkins-channels-sec-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const logs: string[] = [];
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({
    dir,
    backend,
    port: 0,
    relay: false,
    extraHosts: ["127.0.0.1"],
    log: (line: string) => logs.push(String(line)),
  });
  await link.setEnabled(true);
  t.after(() => link.stop());

  const paired = await pair(
    fetcher,
    { hosts: [`127.0.0.1:${link.port}`], code: link.startPairing().code },
    { name: "Test Phone", platform: "ios" },
  );
  const client = new LinkClient(paired, {
    fetch: fetcher,
    onState() {},
    onParts() {},
  });
  t.after(() => client.stop());

  const sentinelApp = "xapp-1-SENTINEL-APP-SECRET-998877";
  const sentinelBot = "xoxb-SENTINEL-BOT-SECRET-665544";
  const sentinelReplaced = "xoxb-SENTINEL-REPLACED-SECRET-112233";

  const created = await client.call<ChannelConnection>("channelAdd", {
    kind: "slack",
    label: "Sec Slack",
    botId: backend.state.bots[0].id,
    secrets: { appToken: sentinelApp, botToken: sentinelBot },
  });

  // Returned connection and subsequent list/logs never contain raw secrets
  const serializedCreated = JSON.stringify(created);
  assert.ok(!serializedCreated.includes(sentinelApp), "channelAdd response leaked appToken");
  assert.ok(!serializedCreated.includes(sentinelBot), "channelAdd response leaked botToken");
  assert.deepEqual(created.configuredSecrets?.sort(), ["appToken", "botToken"]);

  const listed = await client.call<ChannelConnection[]>("channelsList");
  assert.ok(!JSON.stringify(listed).includes(sentinelApp), "channelsList leaked appToken");
  assert.ok(!JSON.stringify(listed).includes(sentinelBot), "channelsList leaked botToken");

  const updated = await client.call<ChannelConnection>("channelUpdate", created.id, {
    secrets: { botToken: sentinelReplaced },
  });
  assert.ok(!JSON.stringify(updated).includes(sentinelReplaced), "channelUpdate response leaked botToken");

  const auditLogs = await client.call<ChannelAuditEntry[]>("channelLogs", created.id, { limit: 50 });
  const serializedAudit = JSON.stringify(auditLogs);
  assert.ok(!serializedAudit.includes(sentinelApp));
  assert.ok(!serializedAudit.includes(sentinelBot));
  assert.ok(!serializedAudit.includes(sentinelReplaced));

  // LinkHost logs never contain any secret
  const allLogs = logs.join("\n");
  assert.ok(!allLogs.includes(sentinelApp), "LinkHost logs leaked appToken");
  assert.ok(!allLogs.includes(sentinelBot), "LinkHost logs leaked botToken");
  assert.ok(!allLogs.includes(sentinelReplaced), "LinkHost logs leaked replaced token");

  // Even if the backend throws an error echoing a passed secret, LinkHost scrubs it before returning to the phone
  const origAdd = backend.handlers.channelAdd;
  const sentinelErrSecret = "xoxb-SENTINEL-ECHOED-IN-ERROR-443322";
  backend.handlers.channelAdd = () => {
    throw new Error(`Rejected token ${sentinelErrSecret} by upstream`);
  };
  try {
    await assert.rejects(
      client.call("channelAdd", {
        kind: "telegram",
        label: "Err TG",
        secrets: { botToken: sentinelErrSecret },
      }),
      (err: Error) => {
        assert.ok(!err.message.includes(sentinelErrSecret), "Error message echoed raw secret");
        return true;
      },
    );
  } finally {
    backend.handlers.channelAdd = origAdd;
  }

  assert.ok(!logs.join("\n").includes(sentinelErrSecret), "LinkHost logs leaked error secret");
});
