import type { ProfileAttempt, ProfileHost, ProfileSession } from "@/link/profile";

/** The first-run explanation is deliberately explicit: a local pairing is still useful without an account. */
export const PROFILE_OPTIONAL_COPY =
  "A Botkins profile keeps your identity and trusted hosts available on your desktop and other phones. You can keep using this phone without one, but local setup will not continue across devices.";
export const PROFILE_MIGRATION_COPY =
  "Your existing computer pairings stay on this phone. Add a Botkins profile to use the same identity on your desktop and other phones, and keep these hosts together.";
export const PROFILE_BROWSER_COPY =
  "Continue in the secure Botkins page. Use your passkey, then complete either trusted-device approval or the email code, and return to Botkins to finish.";
export const PROFILE_INDEX_FOOTNOTE =
  "Your profile lets this phone find your computers and lets your bots know it's you.";

export type ProfilePrompt = "first" | "migration" | null;

export function profilePrompt(options: { pairings: number; session: ProfileSession | null; choice: string | null; pending: ProfileAttempt | null }): ProfilePrompt {
  if (options.session || options.choice) return null;
  return options.pairings > 0 ? "migration" : "first";
}

/** Renders the raw verification digits without spaces so manual selection copies cleanly into the six-digit browser field. */
export const profileCode = (code: string) => code.trim();

/** Groups a 6-digit verification code as "482 913" for display in banners and rows. */
export function profileCodeDisplay(code: string): string {
  const clean = profileCode(code);
  return /^\d{6}$/.test(clean) ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
}

/** Screen-reader label spelling out each verification digit individually. */
export const profileCodeLabel = (code: string) => {
  const clean = profileCode(code);
  return clean ? "Profile code " + clean.split("").join(" ") : "Profile code";
};

export const profileHostIsLocal = (host: ProfileHost, pairings: ReadonlyArray<{ serverId: string }>) => pairings.some((pairing) => pairing.serverId === host.serverId);

export function profileHostSubtitle(host: ProfileHost, local: boolean, enrolled: boolean) {
  if (enrolled) return "Available on this phone";
  if (local) return "This phone's local pairing · waiting for this computer to come online";
  if (host.hosts.length === 0) return "Saved in your profile · waiting for this computer to come online";
  return "Not paired on this phone · tap to enroll";
}

export type ProfileHostStatusKind = "ready" | "offline" | "add" | "removing";
export type ProfileBadgeTone = "success" | "warning" | "accent" | "neutral";

export type ProfileHostStatus = {
  kind: ProfileHostStatusKind;
  label: string;
  tone: ProfileBadgeTone;
  subtitle: string;
  selectable: boolean;
};

/**
 * Status badge + short subtitle for a profile host on the Computers subpage.
 * Keeps the row compact: status moves into the Badge while the subtitle says ownership / offline state.
 */
export function profileHostStatus(
  host: ProfileHost & { offlineSince?: string | number | null },
  options: { local: boolean; enrolled: boolean; pendingRemoval: boolean },
): ProfileHostStatus {
  const { local, enrolled, pendingRemoval } = options;
  const selectable = !pendingRemoval && (local || host.hosts.length > 0);
  if (pendingRemoval) {
    return {
      kind: "removing",
      label: "Removing…",
      tone: "warning",
      subtitle: "Will retry when online",
      selectable: false,
    };
  }
  const roleSubtitle = host.member ? "You're a member" : "Your computer";
  if (enrolled) {
    return {
      kind: "ready",
      label: "Ready",
      tone: "success",
      subtitle: roleSubtitle,
      selectable,
    };
  }
  if (local || host.hosts.length === 0) {
    const offlineSince = formatOfflineSince(host.offlineSince);
    const subtitle = offlineSince
      ? `Offline since ${offlineSince}`
      : host.member
        ? "You're a member · waiting to connect"
        : "Waiting for computer to come online";
    return {
      kind: "offline",
      label: "Offline",
      tone: "warning",
      subtitle,
      selectable,
    };
  }
  return {
    kind: "add",
    label: "Add",
    tone: "accent",
    subtitle: host.member ? "You're a member · tap to enroll" : "Tap to enroll on this phone",
    selectable: true,
  };
}

function formatOfflineSince(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return trimmed;
    return formatShortDate(parsed);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatShortDate(value);
  }
  return null;
}

function formatShortDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
  } catch {
    return "";
  }
}

export type ProfileDeviceLike = { id: string; label: string; current?: boolean };

/**
 * Orders trusted devices with the current device first, preserving relative order among others.
 */
export function orderTrustedDevices<T extends ProfileDeviceLike>(devices: ReadonlyArray<T>): T[] {
  const current: T[] = [];
  const others: T[] = [];
  for (const device of devices) {
    if (device.current) current.push(device);
    else others.push(device);
  }
  return [...current, ...others];
}

export type ProfileIndexSummary = {
  computersCount: number;
  computersReadyCount: number;
  computersSubtitle: string;
  devicesCount: number;
  devicesSubtitle: string;
};

/**
 * Computes the two index rows' subtitles and counts on the signed-in Profile screen.
 */
export function profileIndexSummary(options: {
  hosts: ReadonlyArray<ProfileHost>;
  devices: ReadonlyArray<ProfileDeviceLike>;
  enrolledServerIds: ReadonlySet<string>;
  currentDeviceLabel?: string;
}): ProfileIndexSummary {
  const { hosts, devices, enrolledServerIds, currentDeviceLabel } = options;
  const computersCount = hosts.length;
  const computersReadyCount = hosts.filter((host) => enrolledServerIds.has(host.serverId)).length;
  const computersSubtitle =
    computersCount === 0
      ? "No computers yet"
      : `${computersReadyCount} ready on this phone`;

  const ordered = orderTrustedDevices(devices);
  const devicesCount = ordered.length;
  const current = ordered.find((d) => d.current);
  const deviceLabel = (current?.label || currentDeviceLabel || "device").trim();
  const shortDevice = deviceLabel.replace(/^This\s+/i, "") || "device";
  const more = Math.max(0, devicesCount - (current ? 1 : 0));

  let devicesSubtitle: string;
  if (devicesCount === 0) {
    devicesSubtitle = "No trusted devices";
  } else if (current && more === 0) {
    devicesSubtitle = `This ${shortDevice}`;
  } else if (current) {
    devicesSubtitle = `This ${shortDevice} and ${more} more`;
  } else {
    devicesSubtitle = `${devicesCount} trusted ${devicesCount === 1 ? "device" : "devices"}`;
  }

  return {
    computersCount,
    computersReadyCount,
    computersSubtitle,
    devicesCount,
    devicesSubtitle,
  };
}

/**
 * Two-letter initials for the Profile hero avatar when there is no photo or emoji.
 */
export function profileInitials(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]!][0]!.toLocaleUpperCase();
  return ([...parts[0]!][0]! + [...parts[parts.length - 1]!][0]!).toLocaleUpperCase();
}

export function pendingDeviceLabel(label: string) {
  return label.trim() || "Another device";
}

export function pendingBannerCopy(pending: ReadonlyArray<{ id: string; label: string; code: string }>): { title: string; subtitle: string } | null {
  if (pending.length === 0) return null;
  const first = pending[0]!;
  const label = pendingDeviceLabel(first.label);
  const code = profileCodeDisplay(first.code);
  if (pending.length === 1) {
    return {
      title: "A device wants in",
      subtitle: `${label} · code ${code}`,
    };
  }
  return {
    title: `${pending.length} devices want in`,
    subtitle: `${label} · code ${code} (+${pending.length - 1} more)`,
  };
}

const NO_HOSTS: ProfileHost[] = [];
/**
 * The profile's hosts for a store selector. With no profile this is always the same empty list: a
 * selector that makes a new array on each read never settles, and React stops the screen with
 * "Maximum update depth exceeded".
 */
export const profileHostsOf = (state: { home: { hosts: ProfileHost[] } | null }): ProfileHost[] => state.home?.hosts ?? NO_HOSTS;

// ---------------------------------------------------------------------------
// Destructive action confirmation contracts (Colt's HARD RULE).
// Every destructive action opens its confirmation dialog before invoking the API.
// ---------------------------------------------------------------------------

export type ConfirmButton = {
  text: string;
  style?: "cancel" | "destructive" | "default";
  onPress?: () => void;
};

export type AlertFn = (title: string, message: string, buttons: ConfirmButton[]) => void;

export const CONFIRM_COPY = {
  revokeDevice: {
    title: "Revoke trusted device?",
    message: "It will need approval before it can use this profile again.",
    confirm: "Revoke",
  },
  removeHost: {
    title: "Remove profile host?",
    message: "This revokes profile access on the host. A migrated local pairing may be removed with it; unrelated local-only pairings stay on this phone.",
    confirm: "Remove",
  },
  removePhoto: {
    title: "Remove your picture?",
    message: "People in your chats will see your initials instead.",
    confirm: "Remove",
  },
  signOut: {
    title: "Sign out of profile?",
    message: "Profile-enrolled host access and protected profile data will be removed. Unrelated local-only pairings stay; migrated profile-bound keys are removed.",
    confirm: "Sign out",
  },
  signOutOffline: {
    title: "Signed out on this phone",
    message: "The profile service was unreachable, so this device could not be revoked there. Connect to the internet and sign in again to check trusted devices.",
  },
  deleteProfile: {
    title: "Delete Botkins profile?",
    message: "This permanently deletes the profile, its host directory and trusted devices. Local-only pairings and workspaces stay on this phone.",
    confirm: "Continue",
  },
} as const;

export function requestRevokeDevice(
  device: Pick<ProfileDeviceLike, "id" | "current">,
  alert: AlertFn,
  onConfirm: (deviceId: string) => void,
): boolean {
  if (device.current) return false;
  alert(CONFIRM_COPY.revokeDevice.title, CONFIRM_COPY.revokeDevice.message, [
    { text: "Cancel", style: "cancel" },
    { text: CONFIRM_COPY.revokeDevice.confirm, style: "destructive", onPress: () => onConfirm(device.id) },
  ]);
  return true;
}

export function requestRemoveProfileHost(
  serverId: string,
  alert: AlertFn,
  onConfirm: (serverId: string) => void,
): void {
  alert(CONFIRM_COPY.removeHost.title, CONFIRM_COPY.removeHost.message, [
    { text: "Cancel", style: "cancel" },
    { text: CONFIRM_COPY.removeHost.confirm, style: "destructive", onPress: () => onConfirm(serverId) },
  ]);
}

export function requestRemovePhoto(
  alert: AlertFn,
  onConfirm: () => void,
): void {
  alert(CONFIRM_COPY.removePhoto.title, CONFIRM_COPY.removePhoto.message, [
    { text: "Cancel", style: "cancel" },
    { text: CONFIRM_COPY.removePhoto.confirm, style: "destructive", onPress: onConfirm },
  ]);
}

export function requestSignOutProfile(
  alert: AlertFn,
  onConfirm: () => void,
): void {
  alert(CONFIRM_COPY.signOut.title, CONFIRM_COPY.signOut.message, [
    { text: "Cancel", style: "cancel" },
    { text: CONFIRM_COPY.signOut.confirm, style: "destructive", onPress: onConfirm },
  ]);
}

export type DeletePromptRequest = {
  title: string;
  message: string;
  confirm: string;
  max: number;
  onSubmit: (email: string) => void;
};

export function requestDeleteProfile(
  email: string,
  alert: AlertFn,
  askEmail: (options: DeletePromptRequest) => void,
  onConfirmDelete: (typedEmail: string) => void,
): void {
  alert(CONFIRM_COPY.deleteProfile.title, CONFIRM_COPY.deleteProfile.message, [
    { text: "Cancel", style: "cancel" },
    {
      text: CONFIRM_COPY.deleteProfile.confirm,
      style: "destructive",
      onPress: () =>
        askEmail({
          title: "Confirm profile deletion",
          message: "Type your verified email: " + email,
          confirm: "Delete permanently",
          max: 254,
          onSubmit: onConfirmDelete,
        }),
    },
  ]);
}
