import type { ChatSchedule, PhoneLink, RoutineNotifyTargets, Run, RunNotifyTargets, State } from "./types";

export const OWNER = "owner";
export const HOST_DEVICE_ID = "host";
export const ROUTINE_NOTIFY_TARGETS_CAP = "routine-notify-targets-v1";

export interface TargetDeviceOption {
  id: string;
  name: string;
  kind: string;
  platform?: string;
  canNotify: boolean;
}

export interface TargetPersonOption {
  id: string;
  name: string;
  isOwner: boolean;
  isMe: boolean;
  devices: TargetDeviceOption[];
}

export interface NotifyTargetView {
  canTarget: boolean;
  isMember: boolean;
  myId: string;
  people: TargetPersonOption[];
}

export type NotifyMode = "everyone" | "specific" | "quiet";

const dedupe = (ids: string[]) => [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];

export function canTargetRoutineNotifications(state: State): boolean {
  if (!state.remote?.using) return true;
  return Array.isArray(state.remote.using.capabilities) && state.remote.using.capabilities.includes(ROUTINE_NOTIFY_TARGETS_CAP);
}

/**
 * Build the list of eligible people and their devices for a bot's routine notification picker.
 * Works identically for local owner, remote owner, and remote member views.
 */
export function buildNotifyTargetView(state: State, botId: string, phoneLink?: PhoneLink | null): NotifyTargetView {
  const canTarget = canTargetRoutineNotifications(state);
  const team = state.team;
  const isRemote = Boolean(state.remote?.using);
  const isMember = Boolean(team && "me" in team);
  const myId = isMember && team && "me" in team ? team.me.memberId : OWNER;

  if (isMember && team && "me" in team) {
    const myDevices: TargetDeviceOption[] = (team.me.devices ?? [])
      .filter((device) => device.kind !== "gadget" && device.kind !== "browser")
      .map((device) => ({
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
    return { canTarget, isMember: true, myId, people };
  }

  // Owner view (local or remote).
  const ownerTeam = team && "members" in team ? team : null;
  const ownerName = ownerTeam?.people?.find((p) => p.id === OWNER)?.name || "Owner";
  const hostName = isRemote
    ? (state.remote?.using?.name || "Host computer")
    : (phoneLink?.name || "This computer");
  const hostCanNotify = state.settings?.notifications?.routines !== false;

  const memberDeviceIds = new Set<string>();
  for (const member of ownerTeam?.members ?? []) {
    for (const id of member.deviceIds ?? []) memberDeviceIds.add(id);
    for (const d of member.devices ?? []) memberDeviceIds.add(d.id);
  }

  const rawDevices = isRemote ? (state.remotePhones ?? []) : (phoneLink?.devices ?? []);
  const ownerDevices: TargetDeviceOption[] = [
    { id: HOST_DEVICE_ID, name: hostName, kind: "host", canNotify: hostCanNotify },
    ...rawDevices
      .filter((device) => device.kind !== "gadget" && device.kind !== "browser" && !memberDeviceIds.has(device.id))
      .map((device) => ({
        id: device.id,
        name: device.name,
        kind: device.kind ?? "phone",
        platform: device.platform,
        canNotify: device.canNotify === true,
      })),
  ];

  const people: TargetPersonOption[] = [
    {
      id: OWNER,
      name: ownerName,
      isOwner: true,
      isMe: true,
      devices: ownerDevices,
    },
  ];

  if (ownerTeam) {
    const groupsById = new Map(ownerTeam.groups.map((group) => [group.id, group]));
    const rolesById = new Map(ownerTeam.roles.map((role) => [role.id, role]));
    for (const member of ownerTeam.members) {
      const group = groupsById.get(member.groupId);
      const role = group ? rolesById.get(group.roleId) : undefined;
      if (!role) continue;
      const seesBot = role.bots === "all" || (Array.isArray(role.bots) && role.bots.includes(botId));
      if (!seesBot) continue;
      const devices: TargetDeviceOption[] = (member.devices ?? [])
        .filter((device) => device.kind !== "gadget" && device.kind !== "browser")
        .map((device) => ({
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

  return { canTarget, isMember: false, myId, people };
}

export function normalizeTargets(targets: RoutineNotifyTargets | null | undefined): { people: string[]; devices: string[] } {
  return {
    people: dedupe(targets?.people ?? []),
    devices: dedupe(targets?.devices ?? []),
  };
}

export function initialNotifyMode(routine: Pick<ChatSchedule, "notify" | "notifyTargets"> | null | undefined, delivery: string): NotifyMode {
  if (delivery === "none" || routine?.notify === false) return "quiet";
  if (routine?.notifyTargets) return "specific";
  return "everyone";
}

/** Toggle a person's "all devices" selection. */
export function togglePersonTarget(
  current: { people: string[]; devices: string[] },
  person: TargetPersonOption,
): { people: string[]; devices: string[] } {
  const personDeviceIds = new Set(person.devices.map((d) => d.id));
  const selected = current.people.includes(person.id);
  if (selected) {
    return {
      people: current.people.filter((id) => id !== person.id),
      devices: current.devices.filter((id) => !personDeviceIds.has(id)),
    };
  }
  return {
    people: dedupe([...current.people, person.id]),
    // Selecting a person implies all their devices; clean up redundant individual device IDs.
    devices: current.devices.filter((id) => !personDeviceIds.has(id)),
  };
}

/**
 * Toggle one specific device under a person.
 * If the person is currently selected at the person level, unchecking one device expands the
 * person into all of their OTHER devices so the user only deselected that single device.
 */
export function toggleDeviceTarget(
  current: { people: string[]; devices: string[] },
  person: TargetPersonOption,
  deviceId: string,
): { people: string[]; devices: string[] } {
  const personSelected = current.people.includes(person.id);
  if (personSelected) {
    const remaining = person.devices.map((d) => d.id).filter((id) => id !== deviceId);
    return {
      people: current.people.filter((id) => id !== person.id),
      devices: dedupe([...current.devices, ...remaining]),
    };
  }
  const hasDevice = current.devices.includes(deviceId);
  const nextDevices = hasDevice
    ? current.devices.filter((id) => id !== deviceId)
    : dedupe([...current.devices, deviceId]);

  // If all of this person's devices are now individually checked (and they have > 0 devices),
  // keep them as explicit devices rather than silently upgrading to "all future devices".
  return {
    people: current.people,
    devices: nextDevices,
  };
}

export function isDeviceChecked(
  current: { people: string[]; devices: string[] },
  person: TargetPersonOption,
  deviceId: string,
): boolean {
  return current.people.includes(person.id) || current.devices.includes(deviceId);
}

/** Count IDs in `targets` that are no longer in the eligible `view`. */
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

/** Remove any stale/ineligible IDs from `targets` against the current `view`. */
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

/**
 * Return the human-readable summary for a routine's alert targets.
 * Prefers the host's authoritative `notifySummary` when present, falling back to local resolution.
 */
export function routineNotifyLabel(
  routine: Pick<ChatSchedule, "notify" | "notifyTargets" | "deliver"> & { notifySummary?: string },
  view?: NotifyTargetView | null,
): string {
  if (routine.deliver?.to === "none" || routine.notify === false) return "Quiet";
  if (routine.notifySummary) return routine.notifySummary;
  if (!routine.notifyTargets) return "Alerts everyone";
  if (!view) return "Specific targets";
  return formatTargetsLabel(routine.notifyTargets, view, "Alerts");
}

/** Human-readable chip text for a run's dynamic `run.notifyTargets` override. */
export function runNotifyChip(run: Pick<Run, "notifyTargets">, view?: NotifyTargetView | null): string | null {
  const nt: RunNotifyTargets | undefined = run.notifyTargets;
  if (!nt) return null;
  if (nt.mode === "none") return "Muted by agent";
  if (nt.mode === "default") return "Default targets";
  if (nt.mode === "only") {
    if (!view) return "Targeted alert";
    return formatTargetsLabel({ people: nt.people, devices: nt.devices }, view, "Alerted");
  }
  return null;
}

function formatTargetsLabel(
  targets: RoutineNotifyTargets,
  view: NotifyTargetView,
  verb: string,
): string {
  const peopleById = new Map(view.people.map((p) => [p.id, p]));
  const devicesById = new Map<string, TargetDeviceOption>();
  for (const person of view.people) {
    for (const device of person.devices) devicesById.set(device.id, device);
  }
  const names: string[] = [];
  for (const id of targets.people ?? []) {
    const p = peopleById.get(id);
    if (p) names.push(p.name);
  }
  for (const id of targets.devices ?? []) {
    const d = devicesById.get(id);
    if (d) names.push(d.name);
  }
  if (names.length === 0) return "No active targets";
  if (names.length <= 2) return `${verb} ${names.join(", ")}`;
  return `${verb} ${names[0]}, ${names[1]} +${names.length - 2}`;
}
