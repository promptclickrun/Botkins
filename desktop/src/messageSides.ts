// Which side of a chat a message is on, and who is named above it. The phone has the same rules.
//
// - A message is on the right only when whoever is looking wrote it: a person's message whose author
//   is the viewer. A message with no author is the owner's.
// - Everything else is on the left: a bot's reply, and another person's message. Another person's
//   message keeps the tinted bubble of a person's, with their name above it and their round picture
//   beside it, so it never reads as a bot's.
// - A run of messages from one person shows the name and the picture on the first only.

export const OWNER = "owner";

type Said = { role: string; author?: { memberId: string }; interim?: boolean; receipt?: boolean };

/** Who wrote a person's message: "owner" or a member's id. */
export const authorOf = (message: Said) => message.author?.memberId ?? OWNER;

/** "mine" on the right, "person" for someone else on the left, "other" for a bot or the computer. */
export function messageSide(message: Said, viewer: string): "mine" | "person" | "other" {
  if (message.role !== "user" || message.receipt) return "other";
  return authorOf(message) === viewer ? "mine" : "person";
}

/**
 * Whether the message at `index` starts a run of another person's messages, and so shows their name
 * and picture. A thought or receipt shown between two messages does not break a run.
 */
export function startsPersonRun(messages: readonly Said[], index: number, viewer: string): boolean {
  const message = messages[index];
  if (!message || messageSide(message, viewer) !== "person") return false;
  for (let at = index - 1; at >= 0; at--) {
    const before = messages[at];
    if (before.interim || before.receipt) continue;
    return messageSide(before, viewer) !== "person" || authorOf(before) !== authorOf(message);
  }
  return true;
}

/** A person's stable color: one of a few that read in light and dark, from their id (32-bit FNV-1a, which spreads ids that differ by a letter). */
export const PERSON_COLORS = 6;
export function personColor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PERSON_COLORS;
}

/** The letter on a person's badge when they have no picture. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}
