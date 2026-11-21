// The composer's plain logic, with no React Native imports so the tests can run it: the "/", "@"
// and "#" trigger, how a mention reads in the text, a Today card as message text, the bots a
// one-bot chat can address, and how dictated words join the field's text.
import type { Bot, BoardItem, MentionInput } from "@/link/types";

export type Sigil = "/" | "@" | "#";
export type Trigger = { sigil: Sigil; query: string; start: number; end: number };

/** The "/", "@" or "#" word ending at the caret: at the start of the text or after a space, never inside a word. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([/@#])([^\s/@#]{0,60})$/.exec(before);
  if (!match) return null;
  return { sigil: match[1] as Sigil, query: match[2], start: caret - match[2].length - 1, end: caret };
}

/**
 * A record picked with "#" or "@": a project, wiki page or file. It reads "#label" in the text, as
 * on the desktop (in a group chat "@name" addresses a bot, so a record never reads like one), and
 * is sent as a MentionInput.
 */
export type DraftMention = { kind: "project"; id: string; label: string } | { kind: "file" | "wiki"; path: string; label: string };
export const MAX_MENTIONS = 12;
export const tokenOf = (mention: DraftMention) => "#" + mention.label;
export const mentionKey = (mention: DraftMention) => mention.kind + ":" + ("id" in mention ? mention.id : mention.path);
export const toInput = (mention: DraftMention): MentionInput => ("path" in mention ? { kind: mention.kind, path: mention.path } : { kind: "project", id: mention.id });

/**
 * The bots "@" offers in a chat with one bot: the others Teamwork lets it ask (desktop/teamwork.mjs,
 * `roster`). Empty when Teamwork is off for the app or for this bot. The desktop also leaves out a
 * bot without access to the chat's project; the phone can't see that, so the computer decides.
 */
export function teammates(bots: Bot[], ownBotId: string | undefined, teamworkOn: boolean | undefined): Bot[] {
  const own = bots.find((bot) => bot.id === ownBotId);
  if (teamworkOn === false || !own || own.teamwork === false) return [];
  return bots.filter((bot) => bot.id !== own.id && bot.teamwork !== false && !bot.hidden).slice(0, 16);
}

const KIND: Record<BoardItem["kind"], string> = { feed: "Feed", idea: "Idea", goal: "Goal" };
export const boardKindLabel = (kind: BoardItem["kind"]) => KIND[kind] ?? "Today";

/** A Today card as a quoted block for the top of a message: its kind and title in bold, its body, its links. */
export function boardQuote(item: BoardItem): string {
  const lines = [boardKindLabel(item.kind) + " · **" + item.title.trim() + "**"];
  const body = item.body.trim();
  if (body) lines.push("", ...body.split("\n"));
  const links = (item.links ?? []).filter((link) => link.url);
  if (links.length) lines.push("", ...links.map((link) => "[" + (link.title || link.url).replace(/[[\]]/g, "") + "](" + link.url + ")"));
  return lines.map((line) => (line ? "> " + line : ">")).join("\n");
}

/** The message the desktop's Today sends or drafts for a card (src/Board.tsx `message`). */
export const boardMessage = (item: BoardItem, lead: string) => lead + " **" + item.title + "**" + (item.body ? "\n\n" + item.body : "");

/** The text sent with a pinned card on a computer that can't take it as a mention. */
export function withBoardQuote(item: BoardItem, typed: string): string {
  return boardQuote(item) + "\n\n" + (typed.trim() || "Let's talk about this.");
}

/** A Today card that was sent at the top of a message, read back out of the text. */
export type QuotedCard = { kind: string; title: string; body: string };
/**
 * Splits a message that begins with a Today card (boardQuote) into the card and what the person
 * wrote. `card` is null for any other message, which comes back whole.
 */
export function splitBoardQuote(text: string): { card: QuotedCard | null; rest: string } {
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && lines[end].startsWith(">")) end++;
  const head = end > 0 ? /^> ([A-Za-z]{1,12}) · \*\*(.+)\*\*$/.exec(lines[0]) : null;
  if (!head) return { card: null, rest: text };
  const body = lines
    .slice(1, end)
    .map((line) => line.replace(/^> ?/, ""))
    // A link reads as its title here; the bot got the address.
    .map((line) => line.replace(/^\[([^\]]+)\]\([^)]+\)$/, "$1"))
    .join("\n")
    .trim();
  return { card: { kind: head[1], title: head[2], body }, rest: lines.slice(end).join("\n").trim() };
}

/** Dictated words after what is already in the field, with a space between when one is needed. */
export function joinDictation(base: string, heard: string): string {
  const words = heard.trim();
  if (!words) return base;
  if (!base || /\s$/.test(base)) return base + words;
  return base + " " + words;
}

/** How many copies of `text` wait their turn in a chat. */
export const waitingCopies = (text: string, queued: { text: string }[] | undefined) => (queued ?? []).filter((item) => item.text === text).length;

/**
 * Whether a message the phone sent is on the computer although its send seemed to fail (the answer
 * was lost on the way back): it is a person's message at or after `before.length`, the chat's length
 * when it was sent, or one more copy of it waits its turn than `before.waiting`. `text` is what was sent.
 */
export function arrived(
  text: string,
  before: { length: number; waiting: number },
  view: { from: number; messages: { role: string; text: string }[] } | undefined,
  queued: { text: string }[] | undefined,
): boolean {
  if (!text) return false;
  if (waitingCopies(text, queued) > before.waiting) return true;
  if (!view) return false;
  for (let i = Math.max(0, before.length - view.from); i < view.messages.length; i++) {
    const message = view.messages[i];
    if (message.role === "user" && message.text === text) return true;
  }
  return false;
}
