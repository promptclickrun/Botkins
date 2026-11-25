// How a person looks in a chat ("people-avatars-v1"): their stable accent color, their initial, and
// whether a picture the computer sent is one the phone draws. Plain logic (no React Native imports;
// tested by tests/person-look.test.ts).
import type { Person } from "@/link/types";

/** The biggest picture a person may have: a 256 × 256 JPEG as a data URL, at most 96 KB of base64. */
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BASE64 = 96 * 1024;
export const AVATAR_PREFIX = "data:image/jpeg;base64,";

/**
 * Six accents that read on both themes: each pair is the color on a light canvas and on a dark one.
 * The desktop app's own (desktop/src/people.css, `.person-color-N`), in the same order, so a person
 * has the same color on the computer and on every phone.
 */
export const PERSON_ACCENTS: readonly { light: string; dark: string }[] = [
  { light: "#2F6BD8", dark: "#7EAAFF" }, // blue
  { light: "#1B8A5A", dark: "#5FD09A" }, // green
  { light: "#8A4FD3", dark: "#BD93FF" }, // violet
  { light: "#C25E12", dark: "#F3A35F" }, // orange
  { light: "#C23B78", dark: "#F483B6" }, // pink
  { light: "#12838A", dark: "#5FD2D6" }, // teal
];

/** 32-bit FNV-1a over the id's UTF-16 code units, as the desktop app's `personColor` (desktop/src/messageSides.ts). */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < id.length; at++) {
    hash ^= id.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A person's color index (0–5), as the desktop app's `personColor`. */
export const personColor = (id: string): number => hashId(id) % PERSON_ACCENTS.length;

/** A person's accent color, from their id. */
export function accentOf(id: string, dark: boolean): string {
  const pair = PERSON_ACCENTS[personColor(id || "owner")]!;
  return dark ? pair.dark : pair.light;
}

/** The first letter of a name, as a badge shows it ("?" for none). */
export function initialOf(name: string | undefined): string {
  const first = [...(name ?? "").trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

/** Whether a picture the computer sent is one to draw: a JPEG or PNG data URL no bigger than the limit. */
export function isAvatar(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  return !!match && match[2]!.length <= AVATAR_MAX_BASE64;
}

/** A person as a chat draws them: their picture when it is a good one, else `emoji` (the owner's cloud profile), else their initial. */
export type PersonLook = { id: string; name: string; avatar?: string; emoji?: string };

/** The people of a chat by id, for name tags and badges. `ownerEmoji` is the cloud profile's, shown for the owner without a picture. */
export function peopleLooks(people: Person[] | undefined, ownerEmoji?: string): Map<string, PersonLook> {
  const out = new Map<string, PersonLook>();
  for (const person of people ?? []) {
    if (!person?.id) continue;
    out.set(person.id, {
      id: person.id,
      name: person.name || (person.id === "owner" ? "Owner" : "Member"),
      ...(isAvatar(person.avatar) && { avatar: person.avatar }),
      ...(person.id === "owner" && !isAvatar(person.avatar) && ownerEmoji?.trim() && { emoji: ownerEmoji.trim() }),
    });
  }
  return out;
}
