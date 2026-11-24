// Pure notification-targeting logic for Mobile routines (no React Native imports, so tests run it directly).
import type { ChatSchedule, Meta, PhoneRecord, Preferences, RoutineNotifyTargets, RunNotifyTargets, TeamPart } from "@/link/types";
import { NOTIFY_TARGETS } from "./delivery";

export const OWNER = "owner";
export const HOST_DEVICE_ID = "host";

export type TargetDeviceOption = {
  id: string;
  name: string;
  kind: string;
  platform?: string;
  canNotify: boolean;
};

export type TargetPersonOption = {
  id: string;
  name: string;
  isOwner: boolean;
  isMe: boolean;
  devices: TargetDeviceOption[];
};

export type NotifyTargetView = {
  canTarget: boolean;
  isMember: boolean;
  myId: string;
  people: TargetPersonOption[];
};

export type NotifyMode = "everyone" | "specific" | "quiet";

const dedupe = (ids: string[]) => [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];

export function canTargetRoutineNotifications(capabilities: string[] | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(NOTIFY_TARGETS);
}

/**
 * Build the list of eligible people and their devices for a bot's routine notification picker.
 * Owners see the host computer, their paired non-gadget devices, and eligible team members with their devices.
 * Team members see themselves (with their own devices) and other team people without other people's device details.
 */
export function buildNotifyTargetView(input: {
  meta?: Meta | null;
  team?: TeamPart | null;
  phones?: Record<string, PhoneRecord> | null;
  settings?: Preferences | null;
  botId: string | null;
}): NotifyTargetView {
  const { meta, team, phones, settings, botId } = input;
  const canTarget = canTargetRoutineNotifications(meta?.capabilities);
  const isMember = Boolean(meta?.you?.kind === "member" || (team && "me" in team));

  if (isMember && team && "me" in team) {
    const myDevices: TargetDeviceOption[] = (team.me.devices ?? []).map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind ?? "phone",
      platform: device.platform,
      canNotify: device.canNotify === true,
    }));
    const rawPeople = Array.isArray(team.people) && team.people.length > 0
      ? team.people
      : [{ id: team.me.memberId, name: team.me.name }];
    const people: TargetPersonOption[] = rawPeople.map((person) => ({
      id: person.id,
      name: person.name,
      isOwner: person.id === OWNER,
      isMe: person.id === team.me.memberId,
      devices: person.id === team.me.memberId ? myDevices : [],
    }));
    return { canTarget, isMember: true, myId: team.me.memberId, people };
  }

  // Owner view.
  const ownerTeam = team && "members" in team ? team : null;
  const ownerName = ownerTeam?.people?.find((p) => p.id === OWNER)?.name || "Owner";
  const hostName = meta?.name || "This computer";
  const hostCanNotify = settings?.notifications?.routines !== false;

  const memberDeviceIds = new Set<string>();
  for (const member of ownerTeam?.members ?? []) {
    for (const id of member.deviceIds ?? []) memberDeviceIds.add(id);
    for (const device of member.devices ?? []) memberDeviceIds.add(device.id);
  }

  const ownerDevices: TargetDeviceOption[] = [
    { id: HOST_DEVICE_ID, name: hostName, kind: "host", canNotify: hostCanNotify },
  ];
  for (const [id, phone] of Object.entries(phones ?? {})) {
    if (!phone || phone.kind === "gadget" || memberDeviceIds.has(id)) continue;
    ownerDevices.push({
      id,
      name: phone.name,
      kind: phone.kind ?? "phone",
      platform: phone.platform,
      canNotify: phone.push?.routines === true,
    });
  }

  const people: TargetPersonOption[] = [
    {
      id: OWNER,
      name: ownerName,
      isOwner: true,
      isMe: true,
      devices: ownerDevices,
    },
  ];

  if (ownerTeam && botId) {
    const groupsById = new Map(ownerTeam.groups.map((group) => [group.id, group]));
    const rolesById = new Map(ownerTeam.roles.map((role) => [role.id, role]));
    for (const member of ownerTeam.members) {
      const group = groupsById.get(member.groupId);
      const role = group ? rolesById.get(group.roleId) : undefined;
      if (!role) continue;
      const seesBot = role.bots === "all" || (Array.isArray(role.bots) && role.bots.includes(botId));
      if (!seesBot) continue;
      const devices: TargetDeviceOption[] = (member.devices ?? []).map((device) => ({
        id: device.id,
        name: device.name,
        kind: device.kind ?? "phone",
        platform: device.platform,
        canNotify: device.canNotify === true,
      }));
      people.push({
        id: member.id,
        name: member.name,
        isOwner: false,
        isMe: false,
        devices,
      });
    }
  }

  return { canTarget, isMember: false, myId: OWNER, people };
}

export function normalizeTargets(targets: RoutineNotifyTargets | null | undefined): { people: string[]; devices: string[] } {
  return {
    people: dedupe(targets?.people ?? []),
    devices: dedupe(targets?.devices ?? []),
  };
}

export function initialNotifyMode(
  routine: Pick<ChatSchedule, "notify" | "notifyTargets"> | null | undefined,
  place: string,
): NotifyMode {
  if (place === "none" || routine?.notify === false) return "quiet";
  if (routine?.notifyTargets) return "specific";
  return "everyone";
}

export function hasSelectedTargets(targets: { people: string[]; devices: string[] }): boolean {
  return targets.people.length > 0 || targets.devices.length > 0;
}

/** Toggle a person's "all devices" selection. */
export function togglePersonTarget(
  current: { people: string[]; devices: string[] },
  person: TargetPersonOption,
): { people: string[]; devices: string[] } {
  const personDeviceIds = new Set(person.devices.map((d) => d.id));
  if (current.people.includes(person.id)) {
    return {
      people: current.people.filter((id) => id !== person.id),
      devices: current.devices.filter((id) => !personDeviceIds.has(id)),
    };
  }
  return {
    people: dedupe([...current.people, person.id]),
    devices: current.devices.filter((id) => !personDeviceIds.has(id)),
  };
}

/**
 * Toggle one specific device under a person.
 * If the person is selected at the person level, unchecking one device expands the person
 * into their remaining devices so only that device is removed.
 */
export function toggleDeviceTarget(
  current: { people: string[]; devices: string[] },
  person: TargetPersonOption,
  deviceId: string,
): { people: string[]; devices: string[] } {
  if (current.people.includes(person.id)) {
    const remaining = person.devices.map((d) => d.id).filter((id) => id !== deviceId);
    return {
      people: current.people.filter((id) => id !== person.id),
      devices: dedupe([...current.devices, ...remaining]),
    };
  }
  const hasDevice = current.devices.includes(deviceId);
  return {
    people: current.people,
    devices: hasDevice
      ? current.devices.filter((id) => id !== deviceId)
      : dedupe([...current.devices, deviceId]),
  };
}

export function isPersonChecked(current: { people: string[]; devices: string[] }, person: TargetPersonOption): boolean {
  return current.people.includes(person.id);
}

export function isPersonIndeterminate(current: { people: string[]; devices: string[] }, person: TargetPersonOption): boolean {
  if (current.people.includes(person.id)) return false;
  return person.devices.some((device) => current.devices.includes(device.id));
}

export function isDeviceChecked(
  current: { people: string[]; devices: string[] },
  person: TargetPersonOption,
  deviceId: string,
): boolean {
  return current.people.includes(person.id) || current.devices.includes(deviceId);
}

/** Count IDs in `targets` that are no longer in `view`. */
export function countRemovedTargetIds(
  targets: RoutineNotifyTargets | null | undefined,
  view: NotifyTargetView,
): number {
  if (!targets) return 0;
  const knownPeople = new Set(view.people.map((p) => p.id));
  const knownDevices = new Set<string>();
  for (const person of view.people) {
    for (const device of person.devices) knownDevices.add(device.id);
  }
  let removed = 0;
  for (const id of targets.people ?? []) if (!knownPeople.has(id)) removed++;
  for (const id of targets.devices ?? []) if (!knownDevices.has(id)) removed++;
  return removed;
}

/** Remove stale/ineligible IDs from `targets` against the current `view`. */
export function activeTargetsOnly(
  targets: { people: string[]; devices: string[] },
  view: NotifyTargetView,
): { people: string[]; devices: string[] } {
  const knownPeople = new Set(view.people.map((p) => p.id));
  const knownDevices = new Set<string>();
  for (const person of view.people) {
    for (const device of person.devices) knownDevices.add(device.id);
  }
  return {
    people: targets.people.filter((id) => knownPeople.has(id)),
    devices: targets.devices.filter((id) => knownDevices.has(id)),
  };
}

function formatTargetNames(targets: RoutineNotifyTargets, view: NotifyTargetView, verb: string, fallback: string): string {
  const peopleById = new Map(view.people.map((p) => [p.id, p]));
  const devicesById = new Map<string, TargetDeviceOption>();
  for (const person of view.people) {
    for (const device of person.devices) devicesById.set(device.id, device);
  }
  const names: string[] = [];
  for (const id of targets.people ?? []) {
    const person = peopleById.get(id);
    if (person) names.push(person.name);
  }
  for (const id of targets.devices ?? []) {
    const device = devicesById.get(id);
    if (device) names.push(device.name);
  }
  if (names.length === 0) return fallback;
  if (names.length <= 2) return `${verb} ${names.join(", ")}`;
  return `${verb} ${names[0]}, ${names[1]} +${names.length - 2}`;
}

/** Concise alert target label for a routine row (only non-default modes return a label). */
export function routineNotifyBadge(
  entry: Pick<ChatSchedule, "notify" | "notifyTargets" | "deliver"> & { notifySummary?: string },
  view?: NotifyTargetView | null,
): string | null {
  if (entry.deliver?.to === "none" || entry.notify === false) return "Quiet";
  if (entry.notifySummary) return entry.notifySummary;
  if (!entry.notifyTargets) return null;
  if (!view) return "Specific targets";
  return formatTargetNames(entry.notifyTargets, view, "Alerts", "No active targets");
}

/** Human-readable chip text for a run's dynamic `run.notifyTargets` override. */
export function runNotifyChip(
  notifyTargets: RunNotifyTargets | undefined,
  view?: NotifyTargetView | null,
): string | null {
  if (!notifyTargets) return null;
  if (notifyTargets.mode === "none") return "Muted by agent";
  if (notifyTargets.mode === "default") return "Default targets";
  if (notifyTargets.mode === "only") {
    if (!view) return "Targeted alert";
    return formatTargetNames({ people: notifyTargets.people, devices: notifyTargets.devices }, view, "Alerted", "Targeted alert");
  }
  return null;
}
