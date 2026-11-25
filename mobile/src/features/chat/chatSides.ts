// Which side of the chat a message is on, and who it says wrote it. A message is on the right only
// when this phone's person wrote it; every other person's message is on the left, beside the bots',
// with their name over it and their badge at its top left, once for each run of their messages.
// Plain logic (no React Native imports; tested by tests/chat-sides.test.ts).
import type { Message, RunSummary } from "@/link/types";
import { OWNER } from "./people";

/** Who wrote a person's message: the member named on it, else the owner. */
export const authorOf = (message: Pick<Message, "author">): string => message.author?.memberId || OWNER;

/** "right" for this phone's own person's message, "left" for anyone else's and for every bot's. */
export function sideOf(message: Pick<Message, "role" | "author">, me: string): "left" | "right" {
  return message.role === "user" && authorOf(message) === me ? "right" : "left";
}

/**
 * The name over another person's message ("" for this phone's own, a bot's, and a message nobody
 * typed: a routine's or a panel refresh's). Reads tolerantly: a name the computer left out comes
 * from the chat's people, then "Owner" or "Member".
 */
export function personTag(
  message: Pick<Message, "role" | "author">,
  run: Pick<RunSummary, "scheduleId" | "panelId"> | undefined,
  me: string,
  names: { get: (id: string) => { name: string } | undefined } | undefined,
): string {
  if (message.role !== "user" || run?.scheduleId != null || run?.panelId) return "";
  const id = authorOf(message);
  if (id === me) return "";
  const named = typeof message.author?.name === "string" ? message.author.name.trim() : "";
  return named || names?.get(id)?.name || (id === OWNER ? "Owner" : "Member");
}

/**
 * The keys of the people's messages that follow one by the same person with nothing between them:
 * these show no name and no badge. `items` are in the chat's order, oldest first.
 */
export function continuingKeys(items: readonly { kind: string; key: string; message?: Pick<Message, "role" | "author"> }[], me: string): Set<string> {
  const out = new Set<string>();
  let before: string | null = null;
  for (const item of items) {
    const message = item.kind === "message" ? item.message : undefined;
    if (!message || message.role !== "user") {
      before = null;
      continue;
    }
    const who = authorOf(message);
    if (who !== me && who === before) out.add(item.key);
    before = who;
  }
  return out;
}
