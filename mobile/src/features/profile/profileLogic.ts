import type { ProfileAttempt, ProfileHost, ProfileSession } from "@/link/profile";

/** The first-run explanation is deliberately explicit: a local pairing is still useful without an account. */
export const PROFILE_OPTIONAL_COPY =
  "A Botkins profile keeps your identity and trusted hosts available on your desktop and other phones. You can keep using this phone without one, but local setup will not continue across devices.";
export const PROFILE_MIGRATION_COPY =
  "Your existing computer pairings stay on this phone. Add a Botkins profile to use the same identity on your desktop and other phones, and keep these hosts together.";
export const PROFILE_BROWSER_COPY =
  "Continue in the secure Botkins page. Use your passkey, then complete either trusted-device approval or the email code, and return to Botkins to finish.";

export type ProfilePrompt = "first" | "migration" | null;

export function profilePrompt(options: { pairings: number; session: ProfileSession | null; choice: string | null; pending: ProfileAttempt | null }): ProfilePrompt {
  if (options.session || options.choice) return null;
  return options.pairings > 0 ? "migration" : "first";
}

export const profileCode = (code: string) => code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code;

export const profileHostIsLocal = (host: ProfileHost, pairings: ReadonlyArray<{ serverId: string }>) => pairings.some((pairing) => pairing.serverId === host.serverId);

export function profileHostSubtitle(host: ProfileHost, local: boolean, enrolled: boolean) {
  if (enrolled) return "Available on this phone";
  if (local) return "This phone's local pairing · waiting for this computer to come online";
  if (host.hosts.length === 0) return "Saved in your profile · waiting for this computer to come online";
  return "Not paired on this phone · tap to enroll";
}

export function pendingDeviceLabel(label: string) {
  return label.trim() || "Another device";
}
