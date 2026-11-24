// Granular notification targeting for routines ("routine-notify-targets-v1").
//
// Builds on Botkins' existing Teams/People (`team-people-v1`) and paired device inventory:
//   - Canonical person IDs: "owner" and team.members[].id ("m_...")
//   - Canonical device IDs: "host" (the host desktop app) and paired non-gadget device.id
//
// Pure module shared identically between `desktop/desktop/link/` and `mobile/link-host/` so desktop
// host notifications, remote push delivery, routine validation, and agent tools all enforce the
// exact same precedence, eligibility, and fail-closed rules.

export const OWNER = "owner";
export const HOST_DEVICE_ID = "host";
export const ROUTINE_NOTIFY_TARGETS = "routine-notify-targets-v1";
export const MAX_NOTIFY_TARGET_IDS = 50;
export const MAX_NOTIFY_MESSAGE = 240;

const cleanOneLine = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";

/** Whether a member's role currently lets them see `botId`. Removed members see none. */
export function memberSeesBot(memberId, team, botId) {
  if (!memberId || memberId === OWNER) return true;
  const member = team?.members?.find((item) => item?.id === memberId);
  if (!member) return false;
  if (!botId) return true;
  const group = team?.groups?.find((item) => item?.id === member.groupId);
  const bots = team?.roles?.find((item) => item?.id === group?.roleId)?.bots;
  return bots === "all" || (Array.isArray(bots) && bots.includes(botId));
}

/** Whether a canonical person ID is currently eligible to receive alerts for `botId`. */
export function isEligiblePerson(personId, team, botId) {
  if (personId === OWNER) return true;
  return memberSeesBot(personId, team, botId);
}

/** Gadgets (`kind === "gadget"`) are not push notification targets. */
export function isNotifiableDevice(device) {
  return !!device && typeof device.id === "string" && device.id.length > 0 && device.kind !== "gadget";
}

export function ownerOfDevice(device) {
  return typeof device?.memberId === "string" && device.memberId ? device.memberId : OWNER;
}

function deviceCanNotify(device, pushEnabled) {
  if (typeof device?.canNotify === "boolean") return device.canNotify;
  if (!pushEnabled) return false;
  if (typeof pushEnabled === "function") return Boolean(pushEnabled(device.id));
  if (pushEnabled instanceof Set) return pushEnabled.has(device.id);
  return Boolean(pushEnabled[device.id]);
}

function hasLinkedProfile(personId, { team, profiles, host }) {
  if (personId === OWNER) {
    if (host?.profileLinked === true) return true;
    if (profiles?.owner) return true;
    if (Array.isArray(profiles) && profiles.some((entry) => entry?.personId === OWNER || entry?.owner === true)) return true;
    return false;
  }
  const member = team?.members?.find((item) => item?.id === personId);
  if (member?.profileId) return true;
  if (profiles?.members?.[personId] || profiles?.[personId]) return true;
  if (Array.isArray(profiles) && profiles.some((entry) => entry?.personId === personId || entry?.memberId === personId)) return true;
  return false;
}

/**
 * Discovers the people and devices `actor` is allowed to see and target for `botId`.
 * - Owner (`actor === "owner"` or omitted): all eligible people + "host" (unless headless) + all
 *   eligible people's non-gadget paired devices.
 * - Team member (`actor === "m_..."`): all eligible people by person ID + ONLY their own non-gadget
 *   paired devices. Never reveals "host" or other people's device IDs.
 * Never exposes `profileId`, `statusKey`, `publicKey`, or push tokens.
 */
export function discoverNotifyTargets({
  team,
  devices = [],
  botId,
  actor = OWNER,
  host = null,
  pushEnabled = null,
  profiles = null,
  ownerName = "",
} = {}) {
  const isOwner = !actor || actor === OWNER;
  const hostHeadless = host?.headless === true;
  const hostName = cleanOneLine(host?.name, 80) || "This computer";
  const hostCanNotify = !hostHeadless && host?.canNotify !== false;
  const ownerDisplay =
    cleanOneLine(ownerName, 80) ||
    cleanOneLine(team?.people?.find((person) => person?.id === OWNER)?.name, 80) ||
    "Owner";

  const notifiable = (Array.isArray(devices) ? devices : []).filter(isNotifiableDevice);
  const devicesFor = (personId) =>
    notifiable
      .filter((device) => ownerOfDevice(device) === personId)
      .map((device) => ({
        id: device.id,
        name: cleanOneLine(device.name, 80) || "Device",
        kind: device.kind ?? "phone",
        platform: device.platform ?? "ios",
        canNotify: deviceCanNotify(device, pushEnabled),
      }));

  const ownerLinked = hasLinkedProfile(OWNER, { team, profiles, host });
  const ownerDevices = [
    ...(!hostHeadless
      ? [{
          id: HOST_DEVICE_ID,
          name: hostName,
          kind: "desktop",
          platform: host?.platform ?? "desktop",
          canNotify: hostCanNotify,
        }]
      : []),
    ...devicesFor(OWNER),
  ];

  const people = [
    {
      id: OWNER,
      name: ownerDisplay,
      role: "owner",
      ...(ownerLinked && { profileLinked: true }),
      ...(isOwner && { devices: ownerDevices }),
    },
  ];

  for (const member of team?.members ?? []) {
    if (!member?.id || !memberSeesBot(member.id, team, botId)) continue;
    const memberLinked = hasLinkedProfile(member.id, { team, profiles, host });
    const showDevices = isOwner || member.id === actor;
    people.push({
      id: member.id,
      name: cleanOneLine(member.name, 80) || "Member",
      role: "member",
      ...(memberLinked && { profileLinked: true }),
      ...(showDevices && { devices: devicesFor(member.id) }),
    });
  }

  return { people };
}

function cleanIdArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of IDs.`);
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error(`Each entry in ${label} must be a string.`);
    const item = raw.trim();
    if (!item) continue;
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  if (out.length > MAX_NOTIFY_TARGET_IDS) {
    throw new Error(`Too many ${label} (maximum ${MAX_NOTIFY_TARGET_IDS}).`);
  }
  return out;
}

/**
 * Validates and canonicalizes `{ people?, devices? }` against the caller's scope and bot eligibility.
 * - `resolveNames: false` (RPC/IPC): requires canonical IDs only.
 * - `resolveNames: true` (agent tools): accepts canonical IDs or unambiguous case-insensitive exact names.
 * Returns `{ targets, empty, warnings }` where `targets` is `null` when both arrays are empty.
 */
export function validateNotifyTargets(
  raw,
  context = {},
  { resolveNames = false, actor = OWNER } = {},
) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("notifyTargets must be an object with people and/or devices arrays.");
  }
  const rawPeople = cleanIdArray(raw.people, "people");
  const rawDevices = cleanIdArray(raw.devices, "devices");

  if (!rawPeople.length && !rawDevices.length) {
    return { targets: null, empty: true, warnings: [] };
  }

  const isOwner = !actor || actor === OWNER;
  const catalog = discoverNotifyTargets({ ...context, actor });
  const peopleById = new Map(catalog.people.map((person) => [person.id, person]));
  const visibleDevices = new Map();
  const visibleDeviceList = [];
  for (const person of catalog.people) {
    for (const device of person.devices ?? []) {
      visibleDevices.set(device.id, { ...device, ownerId: person.id, ownerName: person.name });
      visibleDeviceList.push({ ...device, ownerId: person.id, ownerName: person.name });
    }
  }
  const allDevicesById = new Map(
    (Array.isArray(context.devices) ? context.devices : [])
      .filter((device) => device?.id)
      .map((device) => [device.id, device]),
  );

  const resolvedPeople = [];
  const seenPeople = new Set();
  for (const token of rawPeople) {
    let matched = peopleById.get(token);
    if (!matched && resolveNames) {
      const needle = token.toLowerCase();
      const matches = catalog.people.filter((person) => person.name.toLowerCase() === needle);
      if (matches.length === 1) matched = matches[0];
      else if (matches.length > 1) {
        const list = matches.map((person) => `${person.name} (${person.id})`).join(", ");
        throw new Error(`Ambiguous person name "${token}". Use a canonical ID instead: ${list}.`);
      }
    }
    if (!matched) {
      const member = context.team?.members?.find((item) => item?.id === token);
      if (member) {
        throw new Error(`${member.name || member.id} doesn't have access to this bot.`);
      }
      throw new Error(`Unknown or ineligible notification target person: "${token}".`);
    }
    if (!seenPeople.has(matched.id)) {
      seenPeople.add(matched.id);
      resolvedPeople.push(matched.id);
    }
  }

  const resolvedDevices = [];
  const seenDevices = new Set();
  for (const token of rawDevices) {
    let matched = visibleDevices.get(token);
    if (!matched && resolveNames) {
      const needle = token.toLowerCase();
      const matches = visibleDeviceList.filter((device) => device.name.toLowerCase() === needle);
      if (matches.length === 1) matched = matches[0];
      else if (matches.length > 1) {
        const list = matches.map((device) => `${device.name} (${device.ownerName}, ${device.id})`).join(", ");
        throw new Error(`Ambiguous device name "${token}". Use a canonical ID instead: ${list}.`);
      }
    }
    if (!matched) {
      if (token === HOST_DEVICE_ID) {
        if (!isOwner) throw new Error("You can only target your own devices or team members.");
        if (context.host?.headless === true) throw new Error("This host is headless and cannot receive desktop notifications.");
      }
      const rawDevice = allDevicesById.get(token);
      if (rawDevice) {
        if (rawDevice.kind === "gadget") {
          throw new Error(`"${rawDevice.name || token}" is a gadget and cannot receive routine push notifications.`);
        }
        const devOwner = ownerOfDevice(rawDevice);
        if (!isOwner && devOwner !== actor) {
          throw new Error("You can only target your own devices or team members.");
        }
        if (!isEligiblePerson(devOwner, context.team, context.botId)) {
          throw new Error("That device's owner doesn't have access to this bot.");
        }
      }
      throw new Error(`Unknown or ineligible notification target device: "${token}".`);
    }
    if (!seenDevices.has(matched.id)) {
      seenDevices.add(matched.id);
      resolvedDevices.push(matched.id);
    }
  }

  const warnings = [];
  for (const personId of resolvedPeople) {
    const person = peopleById.get(personId);
    if (!person || !Array.isArray(person.devices)) continue;
    if (person.devices.length === 0) {
      warnings.push(`${person.name} has no paired devices that can receive notifications.`);
    } else if (person.devices.every((device) => !device.canNotify)) {
      warnings.push(`${person.name} currently has routine notifications disabled or push unregistered on all devices.`);
    }
  }
  for (const deviceId of resolvedDevices) {
    const device = visibleDevices.get(deviceId);
    if (device && !device.canNotify) {
      warnings.push(`${device.name} currently has routine notifications disabled or push unregistered.`);
    }
  }

  const targets = {
    ...(resolvedPeople.length && { people: resolvedPeople }),
    ...(resolvedDevices.length && { devices: resolvedDevices }),
  };
  return { targets, empty: false, warnings };
}

/**
 * Validates and builds a per-run `Run.notifyTargets` override from the `routine_notify` tool input.
 */
export function normalizeRunNotifyTargets(
  input,
  context = {},
  { resolveNames = true, actor = OWNER } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("routine_notify expects an object with mode.");
  }
  const mode = input.mode;
  if (mode !== "only" && mode !== "none" && mode !== "default") {
    throw new Error('mode must be "only", "none", or "default".');
  }
  if (mode === "none" || mode === "default") {
    return { override: { mode }, warnings: [] };
  }
  const { targets, empty, warnings } = validateNotifyTargets(
    { people: input.people, devices: input.devices },
    context,
    { resolveNames, actor },
  );
  if (empty || !targets) {
    throw new Error('Specify at least one person or device when mode is "only".');
  }
  const message = cleanOneLine(input.message, MAX_NOTIFY_MESSAGE);
  return {
    override: {
      mode: "only",
      ...(targets.people && { people: targets.people }),
      ...(targets.devices && { devices: targets.devices }),
      ...(message && { message }),
    },
    warnings,
  };
}

/**
 * Expands explicit `{ people?, devices? }` targets against live team membership, bot access,
 * and paired non-gadget devices. Strictly fail-closed: removed or ineligible targets are ignored.
 */
export function expandExplicitTargets(targets, { team, devices = [], botId, hostHeadless = false } = {}) {
  let host = false;
  const deviceIds = new Set();
  const byId = new Map();
  for (const device of Array.isArray(devices) ? devices : []) {
    if (isNotifiableDevice(device)) byId.set(device.id, device);
  }

  for (const personId of targets?.people ?? []) {
    if (!isEligiblePerson(personId, team, botId)) continue;
    if (personId === OWNER) {
      if (!hostHeadless) host = true;
      for (const device of byId.values()) {
        if (ownerOfDevice(device) === OWNER) deviceIds.add(device.id);
      }
    } else {
      for (const device of byId.values()) {
        if (ownerOfDevice(device) === personId) deviceIds.add(device.id);
      }
    }
  }

  for (const deviceId of targets?.devices ?? []) {
    if (deviceId === HOST_DEVICE_ID) {
      if (!hostHeadless) host = true;
      continue;
    }
    const device = byId.get(deviceId);
    if (!device) continue;
    if (!isEligiblePerson(ownerOfDevice(device), team, botId)) continue;
    deviceIds.add(device.id);
  }

  return { host, deviceIds };
}

/**
 * Single delivery resolver shared by host desktop notifications (`notify.mjs`) and remote push
 * notifications (`link/push.mjs`).
 *
 * Returns:
 * - `{ explicit: false, silent: false, host: null, deviceIds: null, message: null }` when normal
 *   chat-membership / default rules apply (non-routine turn, panel refresh, or Everyone routine).
 * - `{ explicit: true, silent: true, host: false, deviceIds: Set(), message: null }` when the
 *   run must be completely silent.
 * - `{ explicit: true, silent: false, host: boolean, deviceIds: Set<string>, message: string | null }`
 *   when explicit per-run or routine-default targeting applies (fail-closed: an empty set means
 *   notify nobody, never fall back to broadcast).
 */
export function resolveRoutineTargets({
  run,
  chat,
  entry,
  team,
  devices = [],
  botId,
  hostHeadless = false,
} = {}) {
  const silentResult = { explicit: true, silent: true, host: false, deviceIds: new Set(), message: null };
  const defaultResult = { explicit: false, silent: false, host: null, deviceIds: null, message: null };

  if (!run || !chat || chat.temporary || run.status === "Stopped" || run.status === "Working" || run.notify === false) {
    return silentResult;
  }

  const scheduled = run.scheduleId != null || run.trigger === "scheduled";
  if (!scheduled) return defaultResult;

  if (run.status === "Completed" && run.noOutput === true) return silentResult;

  const schedule = entry ?? (run.scheduleId != null ? (chat.schedules ?? []).find((item) => item.id === run.scheduleId) : null);
  if (schedule?.deliver?.to === "none") return silentResult;

  if (run.panelId) return defaultResult;

  const effectiveBotId = botId ?? chat.botId;
  const override = run.notifyTargets;
  if (override?.mode === "none") return silentResult;
  if (override?.mode === "only") {
    const expanded = expandExplicitTargets(override, { team, devices, botId: effectiveBotId, hostHeadless });
    const message = cleanOneLine(override.message, MAX_NOTIFY_MESSAGE) || null;
    return { explicit: true, silent: false, host: expanded.host, deviceIds: expanded.deviceIds, message };
  }

  if (schedule?.notify === false) return silentResult;

  const saved = schedule?.notifyTargets;
  if (saved && ((saved.people?.length ?? 0) > 0 || (saved.devices?.length ?? 0) > 0)) {
    const expanded = expandExplicitTargets(saved, { team, devices, botId: effectiveBotId, hostHeadless });
    return { explicit: true, silent: false, host: expanded.host, deviceIds: expanded.deviceIds, message: null };
  }

  return defaultResult;
}

/**
 * Counts how many saved IDs in `notifyTargets` are no longer eligible or paired.
 */
export function countRemovedTargets(notifyTargets, context = {}) {
  if (!notifyTargets) return 0;
  const { team, devices = [], botId, host = null } = context;
  const hostHeadless = host?.headless === true;
  const byId = new Map();
  for (const device of Array.isArray(devices) ? devices : []) {
    if (isNotifiableDevice(device)) byId.set(device.id, device);
  }
  let removed = 0;
  for (const personId of notifyTargets.people ?? []) {
    if (!isEligiblePerson(personId, team, botId)) removed++;
  }
  for (const deviceId of notifyTargets.devices ?? []) {
    if (deviceId === HOST_DEVICE_ID) {
      if (hostHeadless) removed++;
      continue;
    }
    const device = byId.get(deviceId);
    if (!device || !isEligiblePerson(ownerOfDevice(device), team, botId)) removed++;
  }
  return removed;
}

/**
 * Formats a concise human-readable summary of a routine's notification settings or a run's override.
 */
export function summarizeNotifyTargets(notifyTargets, { team, devices = [], botId, actor = OWNER, host = null, ownerName = "", notify = true } = {}) {
  if (notifyTargets?.mode === "none" || (notify === false && notifyTargets?.mode !== "only")) {
    return "Quiet";
  }
  if (!notifyTargets || notifyTargets.mode === "default") return "Everyone";

  const peopleIds = notifyTargets.people ?? [];
  const deviceIds = notifyTargets.devices ?? [];
  if (!peopleIds.length && !deviceIds.length) return notify === false ? "Quiet" : "Everyone";

  const catalog = discoverNotifyTargets({ team, devices, botId, actor, host, ownerName });
  const peopleById = new Map(catalog.people.map((person) => [person.id, person]));
  const devicesById = new Map();
  for (const person of catalog.people) {
    for (const device of person.devices ?? []) {
      devicesById.set(device.id, { ...device, ownerName: person.name });
    }
  }

  const labels = [];
  let removed = 0;
  for (const personId of peopleIds) {
    const person = peopleById.get(personId);
    if (person) labels.push(person.name);
    else removed++;
  }
  for (const deviceId of deviceIds) {
    const device = devicesById.get(deviceId);
    if (device) labels.push(device.name);
    else removed++;
  }

  if (removed > 0) {
    labels.push(removed === 1 ? "1 removed target" : `${removed} removed targets`);
  }
  if (!labels.length) return "Quiet";
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}
