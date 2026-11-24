// Pure unit tests for shared routine notification targeting (desktop/desktop/link/notify-targets.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_DEVICE_ID,
  OWNER,
  countRemovedTargets,
  discoverNotifyTargets,
  expandExplicitTargets,
  normalizeRunNotifyTargets,
  resolveRoutineTargets,
  summarizeNotifyTargets,
  validateNotifyTargets,
} from "../desktop/link/notify-targets.mjs";

const TEAM = {
  people: [{ id: OWNER, name: "Alex" }],
  roles: [
    { id: "r_all", name: "Admin", bots: "all", perms: {} },
    { id: "r_pip", name: "Pip Only", bots: ["pip"], perms: {} },
    { id: "r_scout", name: "Scout Only", bots: ["scout"], perms: {} },
  ],
  groups: [
    { id: "g_all", name: "Admins", roleId: "r_all" },
    { id: "g_pip", name: "Pip Team", roleId: "r_pip" },
    { id: "g_scout", name: "Scout Team", roleId: "r_scout" },
  ],
  members: [
    { id: "m_sarah", name: "Sarah", groupId: "g_all", profileId: "prof_sarah_secret" },
    { id: "m_maya", name: "Maya", groupId: "g_pip" },
    { id: "m_sam", name: "Sam", groupId: "g_scout" },
  ],
};

const DEVICES = [
  { id: "d_alex_phone", name: "Alex's iPhone", kind: "phone", platform: "ios", canNotify: true },
  { id: "d_alex_ipad", name: "Alex's iPad", kind: "phone", platform: "ios", canNotify: false },
  { id: "d_alex_mac", name: "Work Mac", kind: "desktop", platform: "darwin", canNotify: false },
  { id: "d_alex_gadget", name: "Desk Lamp", kind: "gadget", platform: "esp32", canNotify: true },
  { id: "d_sarah_phone", name: "Sarah's iPhone", memberId: "m_sarah", kind: "phone", platform: "ios", canNotify: true },
  { id: "d_sarah_watch", name: "Sarah's Gadget", memberId: "m_sarah", kind: "gadget", platform: "watch", canNotify: true },
  { id: "d_maya_phone", name: "Maya's iPhone", memberId: "m_maya", kind: "phone", platform: "ios", canNotify: true },
  { id: "d_sam_phone", name: "Sam's Pixel", memberId: "m_sam", kind: "phone", platform: "android", canNotify: true },
];

const HOST_INFO = { name: "Alex's MacBook Pro", platform: "darwin", headless: false, canNotify: true };

const baseCtx = (extra = {}) => ({
  team: TEAM,
  devices: DEVICES,
  host: HOST_INFO,
  ownerName: "Alex",
  botId: "pip",
  ...extra,
});

const CHAT = { id: "c_routine", botId: "pip", schedules: [] };
const DONE_RUN = { id: "r1", scheduleId: 1, trigger: "scheduled", status: "Completed" };

test("discoverNotifyTargets filters by bot visibility, excludes gadgets, protects secrets, and scopes member privacy", () => {
  const ownerView = discoverNotifyTargets(baseCtx());
  assert.deepEqual(
    ownerView.people.map((p) => [p.id, p.name, p.devices.map((d) => [d.id, d.canNotify])]),
    [
      [OWNER, "Alex", [[HOST_DEVICE_ID, true], ["d_alex_phone", true], ["d_alex_ipad", false], ["d_alex_mac", false]]],
      ["m_sarah", "Sarah", [["d_sarah_phone", true]]],
      ["m_maya", "Maya", [["d_maya_phone", true]]],
    ],
    "owner sees owner + active members with bot access, never gadgets, never Sam (scout-only)",
  );
  const serialized = JSON.stringify(ownerView);
  assert.ok(!serialized.includes("d_alex_gadget"));
  assert.ok(!serialized.includes("d_sarah_watch"));
  assert.ok(!serialized.includes("m_sam"));
  assert.ok(!serialized.includes("prof_sarah_secret"), "never leaks raw profileId");
  assert.equal(ownerView.people[1].profileLinked, true, "surfaces boolean profileLinked hint when member has a profile");

  // Headless host omits the synthetic "host" device.
  const headlessView = discoverNotifyTargets(baseCtx({ host: { ...HOST_INFO, headless: true } }));
  assert.ok(!headlessView.people[0].devices.some((d) => d.id === HOST_DEVICE_ID));

  // Member caller sees eligible people by ID + ONLY their own devices (never host or others' devices).
  const memberView = discoverNotifyTargets(baseCtx({ actor: "m_maya" }));
  assert.deepEqual(
    memberView.people.map((p) => [p.id, p.name, p.devices?.map((d) => d.id) ?? null]),
    [
      [OWNER, "Alex", null],
      ["m_sarah", "Sarah", null],
      ["m_maya", "Maya", ["d_maya_phone"]],
    ],
    "members never see the owner's or other members' devices",
  );
});

test("validateNotifyTargets validates canonical IDs, optional name resolution, and enforces member & bot scope", () => {
  // Empty target object normalizes to { targets: null, empty: true, warnings: [] }.
  assert.deepEqual(validateNotifyTargets({}, baseCtx()), { targets: null, empty: true, warnings: [] });
  assert.deepEqual(validateNotifyTargets({ people: [], devices: [] }, baseCtx()), { targets: null, empty: true, warnings: [] });

  // Explicit IDs are deduplicated and preserved.
  const valid = validateNotifyTargets(
    { people: ["m_sarah", "m_sarah"], devices: ["d_alex_phone", HOST_DEVICE_ID] },
    baseCtx(),
  );
  assert.deepEqual(valid.targets, { people: ["m_sarah"], devices: ["d_alex_phone", HOST_DEVICE_ID] });
  assert.equal(valid.empty, false);
  assert.deepEqual(valid.warnings, []);

  // Case-insensitive name resolution works when resolveNames is true, and is rejected when false.
  assert.throws(() => validateNotifyTargets({ people: ["sarah"] }, baseCtx(), { resolveNames: false }), /Unknown or ineligible/);
  const byName = validateNotifyTargets(
    { people: ["sarah"], devices: ["alex's iphone"] },
    baseCtx(),
    { resolveNames: true },
  );
  assert.deepEqual(byName.targets, { people: ["m_sarah"], devices: ["d_alex_phone"] });

  // Gadgets, unknown IDs, and members without bot access are rejected.
  assert.throws(() => validateNotifyTargets({ devices: ["d_alex_gadget"] }, baseCtx()), /Unknown or ineligible|gadget/i);
  assert.throws(() => validateNotifyTargets({ people: ["m_sam"] }, baseCtx()), /doesn't have access|Unknown or ineligible/);
  assert.throws(() => validateNotifyTargets({ people: ["m_missing"] }, baseCtx()), /Unknown or ineligible/);
  assert.throws(() => validateNotifyTargets({ devices: ["d_sam_phone"] }, baseCtx()), /doesn't have access|Unknown or ineligible|not eligible/i);

  // Member callers can target other eligible people by person id, and ONLY their own devices.
  const memberOk = validateNotifyTargets(
    { people: ["m_sarah"], devices: ["d_maya_phone"] },
    baseCtx(),
    { actor: "m_maya" },
  );
  assert.deepEqual(memberOk.targets, { people: ["m_sarah"], devices: ["d_maya_phone"] });
  assert.throws(() => validateNotifyTargets({ devices: ["d_sarah_phone"] }, baseCtx(), { actor: "m_maya" }), /own devices|Unknown|ineligible/i);
  assert.throws(() => validateNotifyTargets({ devices: [HOST_DEVICE_ID] }, baseCtx(), { actor: "m_maya" }), /own devices|Unknown|ineligible/i);

  // Ambiguous duplicate person names are rejected with an explicit message when resolveNames is true.
  const dupTeam = {
    ...TEAM,
    members: [...TEAM.members, { id: "m_sarah2", name: "Sarah", groupId: "g_all" }],
  };
  assert.throws(
    () => validateNotifyTargets({ people: ["Sarah"] }, baseCtx({ team: dupTeam }), { resolveNames: true }),
    /Ambiguous person/,
  );
});

test("resolveRoutineTargets enforces precedence, expansion, fail-closed removed targets, and per-run overrides", () => {
  // 1. Default (no notifyTargets, no override): explicit=false (existing chat-membership broadcast applies).
  const def = resolveRoutineTargets({ run: DONE_RUN, chat: CHAT, entry: { id: 1, notify: true }, ...baseCtx() });
  assert.equal(def.explicit, false);
  assert.equal(def.silent, false);

  // 2. Routine muted (notify: false): silent unless agent explicitly overrides with mode: "only".
  const quiet = resolveRoutineTargets({ run: DONE_RUN, chat: CHAT, entry: { id: 1, notify: false }, ...baseCtx() });
  assert.equal(quiet.explicit, true);
  assert.equal(quiet.silent, true);
  assert.equal(quiet.host, false);
  assert.equal(quiet.deviceIds.size, 0);

  // 3. deliver.to === "none" and run.noOutput === true stay strictly silent even with per-run override.
  const noDeliver = resolveRoutineTargets({
    run: { ...DONE_RUN, notifyTargets: { mode: "only", people: [OWNER] } },
    chat: CHAT,
    entry: { id: 1, notify: true, deliver: { to: "none" } },
    ...baseCtx(),
  });
  assert.equal(noDeliver.silent, true);
  const noOutput = resolveRoutineTargets({
    run: { ...DONE_RUN, noOutput: true, notifyTargets: { mode: "only", people: [OWNER] } },
    chat: CHAT,
    entry: { id: 1, notify: true },
    ...baseCtx(),
  });
  assert.equal(noOutput.silent, true);

  // 4. Specific member only: does NOT alert host or owner devices.
  const sarahOnly = resolveRoutineTargets({
    run: DONE_RUN,
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { people: ["m_sarah"] } },
    ...baseCtx(),
  });
  assert.equal(sarahOnly.explicit, true);
  assert.equal(sarahOnly.host, false);
  assert.deepEqual([...sarahOnly.deviceIds], ["d_sarah_phone"]);

  // 5. Owner only: alerts host + all owner non-gadget devices, NOT members.
  const ownerOnly = resolveRoutineTargets({
    run: DONE_RUN,
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { people: [OWNER] } },
    ...baseCtx(),
  });
  assert.equal(ownerOnly.host, true);
  assert.deepEqual([...ownerOnly.deviceIds].sort(), ["d_alex_ipad", "d_alex_mac", "d_alex_phone"]);

  // 6. Specific device only ("d_alex_phone"): does NOT alert host or iPad.
  const phoneOnly = resolveRoutineTargets({
    run: DONE_RUN,
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { devices: ["d_alex_phone"] } },
    ...baseCtx(),
  });
  assert.equal(phoneOnly.host, false);
  assert.deepEqual([...phoneOnly.deviceIds], ["d_alex_phone"]);

  // 7. Specific "host" device only: alerts ONLY host desktop, zero phones.
  const hostOnly = resolveRoutineTargets({
    run: DONE_RUN,
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { devices: [HOST_DEVICE_ID] } },
    ...baseCtx(),
  });
  assert.equal(hostOnly.host, true);
  assert.equal(hostOnly.deviceIds.size, 0);

  // 8. Union of person + another person's specific device.
  const union = resolveRoutineTargets({
    run: DONE_RUN,
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { people: ["m_sarah"], devices: ["d_alex_phone"] } },
    ...baseCtx(),
  });
  assert.equal(union.host, false);
  assert.deepEqual([...union.deviceIds].sort(), ["d_alex_phone", "d_sarah_phone"]);

  // 9. Fail-closed when all saved targets were removed / lost bot access: explicit=true, host=false, empty set!
  const stale = resolveRoutineTargets({
    run: DONE_RUN,
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { people: ["m_removed", "m_sam"], devices: ["d_deleted"] } },
    ...baseCtx(),
  });
  assert.equal(stale.explicit, true);
  assert.equal(stale.host, false);
  assert.equal(stale.deviceIds.size, 0);
  assert.equal(countRemovedTargets({ people: ["m_removed", "m_sam"], devices: ["d_deleted"] }, baseCtx()), 3);

  // 10. Per-run override `mode: "none"` silences alerts even when routine default alerts everyone.
  const mutedByAgent = resolveRoutineTargets({
    run: { ...DONE_RUN, notifyTargets: { mode: "none" } },
    chat: CHAT,
    entry: { id: 1, notify: true },
    ...baseCtx(),
  });
  assert.equal(mutedByAgent.silent, true);
  assert.equal(mutedByAgent.host, false);
  assert.equal(mutedByAgent.deviceIds.size, 0);

  // 11. Per-run override `mode: "only"` overrides even a quiet routine (`notify: false`) and carries custom message.
  const agentOnly = resolveRoutineTargets({
    run: { ...DONE_RUN, notifyTargets: { mode: "only", people: ["m_maya"], message: "Urgent: disk at 95%" } },
    chat: CHAT,
    entry: { id: 1, notify: false, notifyTargets: { people: [OWNER] } },
    ...baseCtx(),
  });
  assert.equal(agentOnly.explicit, true);
  assert.equal(agentOnly.silent, false);
  assert.equal(agentOnly.host, false);
  assert.deepEqual([...agentOnly.deviceIds], ["d_maya_phone"]);
  assert.equal(agentOnly.message, "Urgent: disk at 95%");

  // 12. Per-run override `mode: "default"` falls back to routine defaults.
  const agentDefault = resolveRoutineTargets({
    run: { ...DONE_RUN, notifyTargets: { mode: "default" } },
    chat: CHAT,
    entry: { id: 1, notify: true, notifyTargets: { people: ["m_sarah"] } },
    ...baseCtx(),
  });
  assert.equal(agentDefault.explicit, true);
  assert.equal(agentDefault.host, false);
  assert.deepEqual([...agentDefault.deviceIds], ["d_sarah_phone"]);
  assert.equal(agentDefault.message, null);
});

test("normalizeRunNotifyTargets validates modes, warns on unnotifiable targets, and trims custom messages", () => {
  const muted = normalizeRunNotifyTargets({ mode: "none" }, baseCtx());
  assert.deepEqual(muted, { override: { mode: "none" }, warnings: [] });

  const def = normalizeRunNotifyTargets({ mode: "default" }, baseCtx());
  assert.deepEqual(def, { override: { mode: "default" }, warnings: [] });

  // Targeting a device with canNotify: false produces an advisory warning without failing.
  const warnDevice = normalizeRunNotifyTargets({ mode: "only", devices: ["d_alex_ipad"] }, baseCtx());
  assert.deepEqual(warnDevice.override, { mode: "only", devices: ["d_alex_ipad"] });
  assert.equal(warnDevice.warnings.length, 1);
  assert.match(warnDevice.warnings[0], /Alex's iPad/);

  // Person with zero notifiable devices produces a warning.
  const noDevTeam = { ...TEAM, members: [...TEAM.members, { id: "m_empty", name: "NoPhone", groupId: "g_all" }] };
  const warnPerson = normalizeRunNotifyTargets({ mode: "only", people: ["m_empty"] }, baseCtx({ team: noDevTeam }));
  assert.equal(warnPerson.warnings.length, 1);
  assert.match(warnPerson.warnings[0], /NoPhone/);

  // Long messages are clipped to 240 chars.
  const longMsg = normalizeRunNotifyTargets({ mode: "only", people: ["m_sarah"], message: "a".repeat(300) }, baseCtx());
  assert.equal(longMsg.override.message.length, 240);

  // Invalid mode or empty `only` throws.
  assert.throws(() => normalizeRunNotifyTargets({ mode: "bogus" }, baseCtx()), /mode must be/);
  assert.throws(() => normalizeRunNotifyTargets({ mode: "only" }, baseCtx()), /at least one person or device/);
});

test("expandExplicitTargets and summarizeNotifyTargets format readable summaries", () => {
  const expanded = expandExplicitTargets({ people: [OWNER], devices: ["d_sarah_phone"] }, baseCtx());
  assert.equal(expanded.host, true);
  assert.deepEqual([...expanded.deviceIds].sort(), ["d_alex_ipad", "d_alex_mac", "d_alex_phone", "d_sarah_phone"]);

  assert.equal(summarizeNotifyTargets(null, baseCtx({ notify: false })), "Quiet");
  assert.equal(summarizeNotifyTargets(null, baseCtx({ notify: true })), "Everyone");
  assert.equal(summarizeNotifyTargets({ people: ["m_sarah"] }, baseCtx()), "Sarah");
  assert.equal(summarizeNotifyTargets({ people: ["m_sarah"], devices: ["d_alex_phone"] }, baseCtx()), "Sarah, Alex's iPhone");
  assert.equal(summarizeNotifyTargets({ people: [OWNER, "m_sarah", "m_maya"] }, baseCtx()), "Alex, Sarah, Maya");
  assert.equal(summarizeNotifyTargets({ people: ["m_gone"] }, baseCtx()), "1 removed target");
  assert.equal(summarizeNotifyTargets({ mode: "none" }, baseCtx()), "Quiet");
});
