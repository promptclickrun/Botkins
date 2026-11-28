// Tests for per-agent push notification filtering helpers, unified mode host-scoping,
// and byte-identical mirror parity between desktop/desktop/link and mobile/link-host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanPrefs, DEFAULT_PREFS } from "../link-host/push.mjs";
import {
  hostPushRecords,
  isBotMuted,
  mergePushPrefs,
  planBotMuteUpdate,
  planPushPrefsUpdate,
  toggleAllowedBot,
} from "../src/state/pushPrefs";
import { mergeUnifiedParts, scopeId, scopePartsForHost } from "../src/state/unified";

test("mobile pushPrefs: unified mode splits scoped bot IDs to owning hosts with unscoped IDs", () => {
  const primary = "host-primary";
  const secondary = "host-secondary";
  const scopedSecondaryBot = scopeId(secondary, "glory");

  const plans = planPushPrefsUpdate(
    {
      replies: true,
      bots: { mode: "only", ids: ["alfie", scopedSecondaryBot] },
      mutedBots: ["scout", scopedSecondaryBot],
    },
    [{ serverId: primary }, { serverId: secondary }],
    primary,
  );

  assert.deepEqual(plans, [
    {
      serverId: primary,
      prefs: {
        replies: true,
        bots: { mode: "only", ids: ["alfie"] },
        mutedBots: ["scout"],
      },
    },
    {
      serverId: secondary,
      prefs: {
        replies: true,
        bots: { mode: "only", ids: ["glory"] },
        mutedBots: ["glory"],
      },
    },
  ]);
});

test("mobile pushPrefs: planBotMuteUpdate targets owning host with unscoped IDs only", () => {
  const primary = "host-primary";
  const secondary = "host-secondary";
  const secGlory = scopeId(secondary, "glory");
  const secScout = scopeId(secondary, "scout");
  const currentScoped = ["alfie", secScout];

  // Mute secondary bot -> writes to secondary host with unscoped [scout, glory]
  const muted = planBotMuteUpdate(secGlory, true, currentScoped, primary);
  assert.deepEqual(muted, { serverId: secondary, mutedBots: ["scout", "glory"] });

  // Unmute secondary bot -> writes to secondary host with unscoped []
  const unmuted = planBotMuteUpdate(secScout, false, currentScoped, primary);
  assert.deepEqual(unmuted, { serverId: secondary, mutedBots: [] });

  // Mute primary bot -> writes to primary host with unscoped [alfie, pip]
  const primaryMuted = planBotMuteUpdate("pip", true, currentScoped, primary);
  assert.deepEqual(primaryMuted, { serverId: primary, mutedBots: ["alfie", "pip"] });

  assert.equal(isBotMuted({ mutedBots: currentScoped }, secScout), true);
  assert.equal(isBotMuted({ mutedBots: currentScoped }, secGlory), false);
  assert.deepEqual(toggleAllowedBot({ mode: "only", ids: ["alfie"] }, secGlory, true), {
    mode: "only",
    ids: ["alfie", secGlory],
  });
  assert.deepEqual(toggleAllowedBot({ mode: "only", ids: ["alfie", secGlory] }, "alfie", false), {
    mode: "only",
    ids: [secGlory],
  });
});

test("mobile unified: scopePartsForHost & mergeUnifiedParts scope phones push bot IDs and merge records", () => {
  const primary = "host-a";
  const secondary = "host-b";

  const scopedB = scopePartsForHost(
    {
      phones: {
        "dev-b": {
          name: "Phone",
          push: {
            replies: true,
            requests: true,
            routines: true,
            previews: true,
            activities: true,
            bots: { mode: "only", ids: ["glory"] },
            mutedBots: ["scout"],
          },
          sources: {},
        },
      },
    },
    secondary,
    primary,
    "Host B",
  );

  const merged = mergeUnifiedParts(
    [
      {
        pairing: { serverId: primary, deviceId: "dev-a", name: "Host A" } as any,
        link: "online",
        synced: true,
        parts: {
          phones: {
            "dev-a": {
              name: "Phone",
              push: {
                replies: true,
                requests: true,
                routines: true,
                previews: true,
                activities: true,
                bots: { mode: "only", ids: ["alfie"] },
                mutedBots: ["pip"],
              },
              sources: {},
            },
          },
        },
        chats: {},
        running: {},
        texts: {},
      },
      {
        pairing: { serverId: secondary, deviceId: "dev-b", name: "Host B" } as any,
        link: "online",
        synced: true,
        parts: scopedB,
        chats: {},
        running: {},
        texts: {},
      },
    ],
    primary,
    primary,
  );

  const combined = mergePushPrefs(
    hostPushRecords(merged.phones, [
      { serverId: primary, deviceId: "dev-a" },
      { serverId: secondary, deviceId: "dev-b" },
    ]),
  );
  assert.ok(combined);
  assert.equal(combined.bots?.mode, "only");
  assert.deepEqual(combined.bots?.ids.sort(), ["alfie", scopeId(secondary, "glory")].sort());
  assert.deepEqual(combined.mutedBots?.sort(), ["pip", scopeId(secondary, "scout")].sort());
});

test("link-host push.mjs cleanPrefs matches desktop mirror and rejects bad input", () => {
  const root = join(import.meta.dirname, "..", "..");
  for (const file of ["push.mjs", "space-alerts.mjs", "server.mjs"]) {
    const desk = readFileSync(join(root, "desktop/desktop/link", file), "utf8");
    const mob = readFileSync(join(root, "mobile/link-host", file), "utf8");
    assert.equal(mob, desk, `${file} stays byte-identical between desktop/desktop/link and mobile/link-host`);
  }

  assert.deepEqual(cleanPrefs({}), DEFAULT_PREFS);
  const sanitized = cleanPrefs({
    bots: { mode: "bad", ids: [123, "", "alfie", "alfie", "x".repeat(200)] },
    mutedBots: [null, "glory", "glory", "a\0b"],
  });
  assert.deepEqual(sanitized.bots, { mode: "all", ids: ["alfie"] });
  assert.deepEqual(sanitized.mutedBots, ["glory"]);
});
