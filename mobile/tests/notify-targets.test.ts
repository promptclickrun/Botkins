// Pure unit tests for Mobile routine notification-targeting helpers.
import assert from "node:assert/strict";
import test from "node:test";
import type { Meta, PhoneRecord, Preferences, TeamPart } from "../src/link/types";
import {
  activeTargetsOnly,
  buildNotifyTargetView,
  canTargetRoutineNotifications,
  countRemovedTargetIds,
  hasSelectedTargets,
  HOST_DEVICE_ID,
  initialNotifyMode,
  isDeviceChecked,
  isPersonChecked,
  isPersonIndeterminate,
  normalizeTargets,
  OWNER,
  routineNotifyBadge,
  runNotifyChip,
  toggleDeviceTarget,
  togglePersonTarget,
} from "../src/features/work/notifyTargets";

const OWNER_META: Meta = {
  app: "Botkins",
  version: "1.0.0",
  name: "Studio Mac",
  serverId: "srv_1",
  protocol: 1,
  capabilities: ["devices-v1", "routine-notify-targets-v1"],
  you: { kind: "owner" },
};

const MEMBER_META: Meta = {
  app: "Botkins",
  version: "1.0.0",
  name: "Studio Mac",
  serverId: "srv_1",
  protocol: 1,
  capabilities: ["devices-v1", "routine-notify-targets-v1"],
  you: { kind: "member", memberId: "m_maya", name: "Maya" },
};

const OWNER_TEAM: TeamPart = {
  roles: [
    { id: "r_all", name: "Admin", bots: "all", permissions: { chat: true, tools: true, routines: true, manage: true } },
    { id: "r_pip", name: "Pip Only", bots: ["pip"], permissions: { chat: true, tools: true, routines: true, manage: false } },
    { id: "r_scout", name: "Scout Only", bots: ["scout"], permissions: { chat: true, tools: true, routines: true, manage: false } },
  ],
  groups: [
    { id: "g_all", name: "Admins", roleId: "r_all" },
    { id: "g_pip", name: "Pip Ops", roleId: "r_pip" },
    { id: "g_scout", name: "Scout Ops", roleId: "r_scout" },
  ],
  members: [
    {
      id: "m_sarah",
      name: "Sarah",
      groupId: "g_all",
      joinedAt: 1,
      deviceIds: ["d_sarah_phone"],
      devices: [{ id: "d_sarah_phone", name: "Sarah's iPhone", kind: "phone", platform: "ios", online: true, canNotify: true }],
    },
    {
      id: "m_maya",
      name: "Maya",
      groupId: "g_pip",
      joinedAt: 2,
      deviceIds: ["d_maya_phone"],
      devices: [{ id: "d_maya_phone", name: "Maya's iPhone", kind: "phone", platform: "ios", online: false, canNotify: false }],
    },
    {
      id: "m_sam",
      name: "Sam",
      groupId: "g_scout",
      joinedAt: 3,
      deviceIds: ["d_sam_phone"],
      devices: [{ id: "d_sam_phone", name: "Sam's Pixel", kind: "phone", platform: "android", online: true, canNotify: true }],
    },
  ],
  invites: [],
  requests: [],
  people: [
    { id: OWNER, name: "Alex" },
    { id: "m_sarah", name: "Sarah" },
    { id: "m_maya", name: "Maya" },
    { id: "m_sam", name: "Sam" },
  ],
};

const MEMBER_TEAM: TeamPart = {
  me: {
    memberId: "m_maya",
    name: "Maya",
    groupId: "g_pip",
    groupName: "Pip Ops",
    roleName: "Pip Only",
    permissions: { chat: true, tools: true, routines: true, manage: false },
    devices: [{ id: "d_maya_phone", name: "Maya's iPhone", kind: "phone", platform: "ios", online: true, canNotify: true }],
  },
  people: [
    { id: OWNER, name: "Alex" },
    { id: "m_maya", name: "Maya" },
    { id: "m_sarah", name: "Sarah" },
  ],
};

const PHONES: Record<string, PhoneRecord> = {
  d_alex_phone: { name: "Alex's iPhone", kind: "phone", platform: "ios", sources: {}, push: { replies: true, requests: true, routines: true, previews: true, activities: true } },
  d_alex_ipad: { name: "Alex's iPad", kind: "phone", platform: "ios", sources: {}, push: { replies: true, requests: true, routines: false, previews: true, activities: true } },
  d_alex_gadget: { name: "Desk Lamp", kind: "gadget", platform: "esp32", sources: {} },
  d_sarah_phone: { name: "Sarah's iPhone", kind: "phone", platform: "ios", sources: {}, push: { replies: true, requests: true, routines: true, previews: true, activities: true } },
};

const SETTINGS: Preferences = { notifications: { routines: true } };

test("canTargetRoutineNotifications checks host capability", () => {
  assert.equal(canTargetRoutineNotifications(OWNER_META.capabilities), true);
  assert.equal(canTargetRoutineNotifications(["devices-v1"]), false);
  assert.equal(canTargetRoutineNotifications(undefined), false);
});

test("buildNotifyTargetView builds owner view with host, non-gadget devices, and bot-eligible members", () => {
  const view = buildNotifyTargetView({ meta: OWNER_META, team: OWNER_TEAM, phones: PHONES, settings: SETTINGS, botId: "pip" });
  assert.equal(view.canTarget, true);
  assert.equal(view.isMember, false);
  assert.deepEqual(
    view.people.map((p) => [p.id, p.name, p.devices.map((d) => [d.id, d.canNotify])]),
    [
      [OWNER, "Alex", [[HOST_DEVICE_ID, true], ["d_alex_phone", true], ["d_alex_ipad", false]]],
      ["m_sarah", "Sarah", [["d_sarah_phone", true]]],
      ["m_maya", "Maya", [["d_maya_phone", false]]],
    ],
  );
  // Desktop notifications disabled reflects on host device canNotify.
  const hostOff = buildNotifyTargetView({ meta: OWNER_META, team: OWNER_TEAM, phones: PHONES, settings: { notifications: { routines: false } }, botId: "pip" });
  assert.equal(hostOff.people[0].devices[0].canNotify, false);
});

test("buildNotifyTargetView enforces member privacy (only self devices)", () => {
  const view = buildNotifyTargetView({ meta: MEMBER_META, team: MEMBER_TEAM, phones: PHONES, settings: SETTINGS, botId: "pip" });
  assert.equal(view.isMember, true);
  assert.deepEqual(
    view.people.map((p) => [p.id, p.name, p.devices.map((d) => d.id)]),
    [
      [OWNER, "Alex", []],
      ["m_maya", "Maya", ["d_maya_phone"]],
      ["m_sarah", "Sarah", []],
    ],
  );
});

test("toggling people and devices preserves clean selection and expands when unchecking one device under a selected person", () => {
  const view = buildNotifyTargetView({ meta: OWNER_META, team: OWNER_TEAM, phones: PHONES, settings: SETTINGS, botId: "pip" });
  const alex = view.people[0];

  // Toggle person on -> selects person id.
  let t = togglePersonTarget(normalizeTargets(undefined), alex);
  assert.deepEqual(t, { people: [OWNER], devices: [] });
  assert.equal(isPersonChecked(t, alex), true);
  assert.equal(isPersonIndeterminate(t, alex), false);
  assert.equal(isDeviceChecked(t, alex, "d_alex_phone"), true);

  // Unchecking one device while whole person is selected expands to remaining devices.
  t = toggleDeviceTarget(t, alex, "d_alex_ipad");
  assert.deepEqual(t, { people: [], devices: [HOST_DEVICE_ID, "d_alex_phone"] });
  assert.equal(isPersonChecked(t, alex), false);
  assert.equal(isPersonIndeterminate(t, alex), true);
  assert.equal(isDeviceChecked(t, alex, "d_alex_ipad"), false);
  assert.equal(isDeviceChecked(t, alex, HOST_DEVICE_ID), true);

  // Re-checking the remaining device adds it; toggling person on collapses devices back to person id.
  t = toggleDeviceTarget(t, alex, "d_alex_ipad");
  assert.deepEqual(t, { people: [], devices: [HOST_DEVICE_ID, "d_alex_phone", "d_alex_ipad"] });
  t = togglePersonTarget(t, alex);
  assert.deepEqual(t, { people: [OWNER], devices: [] });

  // Toggling person off clears person and its devices.
  t = togglePersonTarget(t, alex);
  assert.equal(hasSelectedTargets(t), false);
});

test("removed targets are detected and pruned cleanly", () => {
  const view = buildNotifyTargetView({ meta: OWNER_META, team: OWNER_TEAM, phones: PHONES, settings: SETTINGS, botId: "pip" });
  const stale = { people: ["m_sarah", "m_revoked"], devices: ["d_deleted", "d_alex_phone"] };
  assert.equal(countRemovedTargetIds(stale, view), 2);
  assert.deepEqual(activeTargetsOnly(stale, view), { people: ["m_sarah"], devices: ["d_alex_phone"] });
  assert.deepEqual(activeTargetsOnly({ people: ["m_revoked"], devices: [] }, view), { people: [], devices: [] });
});

test("initialNotifyMode, routineNotifyBadge, and runNotifyChip format states accurately", () => {
  const view = buildNotifyTargetView({ meta: OWNER_META, team: OWNER_TEAM, phones: PHONES, settings: SETTINGS, botId: "pip" });

  assert.equal(initialNotifyMode({ notify: true }, "routine"), "everyone");
  assert.equal(initialNotifyMode({ notify: false }, "routine"), "quiet");
  assert.equal(initialNotifyMode({ notify: true }, "none"), "quiet");
  assert.equal(initialNotifyMode({ notify: true, notifyTargets: { people: ["m_sarah"] } }, "routine"), "specific");

  assert.equal(routineNotifyBadge({ notify: true }, view), null);
  assert.equal(routineNotifyBadge({ notify: false }, view), "Quiet");
  assert.equal(routineNotifyBadge({ deliver: { to: "none" }, notify: true }, view), "Quiet");
  assert.equal(routineNotifyBadge({ notify: true, notifyTargets: { people: ["m_sarah"] } }, view), "Alerts Sarah");
  assert.equal(
    routineNotifyBadge({ notify: true, notifyTargets: { people: [OWNER, "m_sarah", "m_maya"] } }, view),
    "Alerts Alex, Sarah +1",
  );
  assert.equal(routineNotifyBadge({ notify: true, notifyTargets: { people: ["m_gone"] } }, view), "No active targets");

  assert.equal(runNotifyChip(undefined, view), null);
  assert.equal(runNotifyChip({ mode: "none" }, view), "Muted by agent");
  assert.equal(runNotifyChip({ mode: "default" }, view), "Default targets");
  assert.equal(runNotifyChip({ mode: "only", people: ["m_sarah"], devices: ["d_alex_phone"] }, view), "Alerted Sarah, Alex's iPhone");
});
