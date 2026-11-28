// Pure logic + destructive-confirm helpers for desktop Settings › Profile.
// Mirrors mobile/src/features/profile/profileLogic.ts so desktop and phone share the same
// status badges, index subtitles/counts, device ordering, and confirm-before-API guarantees.
import type { ProfileDevice, ProfileHost } from "./types";

export const DESKTOP_CONFIRM_COPY = {
  revokeDevice: "Revoke trusted device? It will need approval before it can use this profile again.",
  disconnectHost: "Disconnect this computer from your profile? Other devices will no longer find it through your profile.",
  removePhoto: "Remove your picture? People in your chats will see your initial instead.",
  signOut: "Sign out of profile? Local bots, chats, and unrelated manual pairings stay on this computer.",
  deleteProfile: "Delete this hosted Botkins profile permanently? Local bots, chats, and unrelated manual pairings stay on this computer.",
} as const;

export type DesktopHostStatus = {
  kind: "ready" | "offline" | "add";
  label: string;
  pillClass: "ok" | "warn" | "acc";
  subtitle: string;
};

export function desktopHostStatus(host: ProfileHost, paired: boolean): DesktopHostStatus {
  const role = host.member ? "You're a member" : "Your computer";
  if (paired && host.hosts.length > 0) {
    return { kind: "ready", label: "Ready", pillClass: "ok", subtitle: role };
  }
  if (host.hosts.length === 0) {
    return {
      kind: "offline",
      label: "Offline",
      pillClass: "warn",
      subtitle: host.member ? "You're a member · offline" : "Waiting for computer to come online",
    };
  }
  return {
    kind: "add",
    label: "Add",
    pillClass: "acc",
    subtitle: host.member ? "You're a member · open to connect" : host.hosts.join(" · "),
  };
}

export function orderDesktopDevices(devices: ReadonlyArray<ProfileDevice>): ProfileDevice[] {
  const current: ProfileDevice[] = [];
  const others: ProfileDevice[] = [];
  for (const device of devices) {
    if (device.current) current.push(device);
    else others.push(device);
  }
  return [...current, ...others];
}

export function desktopProfileSummary(options: {
  hosts: ReadonlyArray<ProfileHost>;
  devices: ReadonlyArray<ProfileDevice>;
  pairedServerIds: ReadonlySet<string>;
  localServerId?: string;
}): {
  computersCount: number;
  computersReadyCount: number;
  computersSubtitle: string;
  devicesCount: number;
  devicesSubtitle: string;
} {
  const { hosts, devices, pairedServerIds, localServerId } = options;
  const computersCount = hosts.length;
  const computersReadyCount = hosts.filter(
    (h) => h.hosts.length > 0 && (pairedServerIds.has(h.serverId) || h.serverId === localServerId),
  ).length;
  const computersSubtitle =
    computersCount === 0
      ? "No computers yet"
      : `${computersReadyCount} ready on this computer`;

  const ordered = orderDesktopDevices(devices);
  const devicesCount = ordered.length;
  const current = ordered.find((d) => d.current);
  const label = (current?.label || "computer").trim().replace(/^This\s+/i, "") || "computer";
  const more = Math.max(0, devicesCount - (current ? 1 : 0));

  let devicesSubtitle: string;
  if (devicesCount === 0) {
    devicesSubtitle = "No trusted devices";
  } else if (current && more === 0) {
    devicesSubtitle = label;
  } else if (current) {
    devicesSubtitle = `${label} and ${more} more`;
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

export function desktopPendingBanner(pending: ReadonlyArray<ProfileDevice>): { title: string; subtitle: string } | null {
  if (pending.length === 0) return null;
  const first = pending[0]!;
  const name = first.label?.trim() || "Another device";
  const code = first.code?.trim();
  const codeText = code && /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  if (pending.length === 1) {
    return {
      title: "A device wants in",
      subtitle: codeText ? `${name} · code ${codeText}` : name,
    };
  }
  return {
    title: `${pending.length} devices want in`,
    subtitle: codeText ? `${name} · code ${codeText} (+${pending.length - 1} more)` : `${name} (+${pending.length - 1} more)`,
  };
}

// ---------------------------------------------------------------------------
// Destructive confirm-before-API helpers (Colt's HARD RULE).
// ---------------------------------------------------------------------------

export type ConfirmFn = (message: string) => boolean;

export function confirmRevokeDevice(device: Pick<ProfileDevice, "id" | "current">, confirm: ConfirmFn, onConfirm: (id: string) => void): boolean {
  if (device.current) return false;
  if (!confirm(DESKTOP_CONFIRM_COPY.revokeDevice)) return false;
  onConfirm(device.id);
  return true;
}

export function confirmDisconnectHost(confirm: ConfirmFn, onConfirm: () => void): boolean {
  if (!confirm(DESKTOP_CONFIRM_COPY.disconnectHost)) return false;
  onConfirm();
  return true;
}

export function confirmRemovePhoto(confirm: ConfirmFn, onConfirm: () => void): boolean {
  if (!confirm(DESKTOP_CONFIRM_COPY.removePhoto)) return false;
  onConfirm();
  return true;
}

export function confirmSignOut(confirm: ConfirmFn, onConfirm: () => void): boolean {
  if (!confirm(DESKTOP_CONFIRM_COPY.signOut)) return false;
  onConfirm();
  return true;
}

export function confirmDeleteProfile(
  typedEmail: string,
  expectedEmail: string | undefined,
  confirm: ConfirmFn,
  onConfirm: (email: string) => void,
): { ok: boolean; error?: string } {
  const clean = typedEmail.trim();
  if (!clean) return { ok: false, error: "Enter your verified email to confirm." };
  if (expectedEmail && clean.toLowerCase() !== expectedEmail.trim().toLowerCase()) {
    return { ok: false, error: "Enter the verified profile email exactly." };
  }
  if (!confirm(DESKTOP_CONFIRM_COPY.deleteProfile)) return { ok: false };
  onConfirm(clean);
  return { ok: true };
}
