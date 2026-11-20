// The name a person gives when they pair or join a team ("Your name"), and how a paired device is
// named in a list. The computer keeps it beside the device's model, so an owner can tell Jordan's
// phone from their own. Plain logic with no React Native imports: tests/person.test.ts runs it.
import type { PairedDevice } from "@/link/types";

/** At most this many characters, as the computer keeps it (`personName` in link-host/store.mjs). */
export const PERSON_MAX = 60;
/** Where the last name given on this phone is kept, to fill the field next time. */
export const PERSON_KEY = "botkins.person.v1";

/** The name as it is sent: control characters out, spaces at the ends trimmed. */
export function cleanPerson(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** What keeps a name from being sent, or null when it can be. */
export function personProblem(text: string): string | null {
  const clean = cleanPerson(text);
  if (!clean) return "Enter your name.";
  if (clean.length > PERSON_MAX) return "Use " + PERSON_MAX + " characters or fewer.";
  return null;
}

/** A paired device's title in a list: the person's name, else the device's own. */
export const deviceTitle = (device: Pick<PairedDevice, "name" | "person">) => device.person || device.name;

/** The line under it: the device's model when a person names it, then the status. */
export const deviceSubtitle = (device: Pick<PairedDevice, "name" | "person">, status: string) => (device.person ? device.name + " · " + status : status);
