// A reply that lands whole (Settings › Chat › Text streaming) is shown word by word, as if written here.
// Only a reply that came while its chat was open and its turn was under way: the chat list arms the
// chat (`arm`) while the bot works, and the reply's row claims it when it is first drawn (`claim`).
// A touch in the chat or a message sent shows the whole text at once (`snapReveals`). A snapped
// reply stays whole: it is claimed once.
// Through the relay with Text streaming on, the reply was painted in chunks as it came (paint.ts): the
// reply then carries on from where the painting was (`notePainted`), not from its start.
import { useEffect, useState } from "react";

export const REVEAL_TICK_MS = 30;
const GRACE_MS = 5000;

/** How long a text of this many characters takes to show. */
export const revealMs = (chars: number) => Math.min(1200, Math.max(300, chars * 4));

/** The part of `text` shown after `elapsed` ms, the first `from` units at once: whole words, then the whole text when the time is up. */
export function revealedText(text: string, elapsed: number, from = 0): string {
  const total = revealMs(text.length - from);
  if (elapsed >= total) return text;
  const want = from + Math.floor(((text.length - from) * Math.max(0, elapsed)) / total);
  if (want <= from) return text.slice(0, from);
  // To the end of the word that reaches `want`.
  const space = text.slice(want).search(/\s/);
  return space < 0 ? text : text.slice(0, want + space);
}

/**
 * By chat: messages from `end` (their place in the whole chat) may be revealed, until `until` once
 * the turn stopped. `started` keeps when each claimed one began, so a row drawn again carries on.
 */
const armed = new Map<string, { end: number; until: number; chunks: boolean; started: Map<number, { at: number; from: number }> }>();
/** By chat: the text the turn under way painted last (paint.ts), so its reply goes on from there. */
const painted = new Map<string, string>();
export const notePainted = (chatId: string, text: string) => void painted.set(chatId, text);

/**
 * The chat's turn is under way with its text landing whole, or in chunks (`chunks`): its next replies are
 * revealed. `end` is the chat's length now.
 */
export function arm(chatId: string, end: number, chunks = false) {
  const held = armed.get(chatId);
  // A new turn: what an older one painted is not its own. Its painting notes itself again on the next tick.
  if (!held || held.until !== Infinity) painted.delete(chatId);
  if (held) {
    held.until = Infinity;
    held.chunks = chunks;
  } else armed.set(chatId, { end, until: Infinity, chunks, started: new Map() });
}
/** The turn stopped: a reply that lands soon after is still its own. */
export function settle(chatId: string, now = Date.now()) {
  const held = armed.get(chatId);
  if (held && held.until === Infinity) held.until = now + GRACE_MS;
}
export const disarm = (chatId: string) => {
  armed.delete(chatId);
  painted.delete(chatId);
};

/**
 * When the reply at `index` began to be revealed and from where (the text painted before it, in chunks),
 * or null when it is shown whole. A reply that doesn't go on from what was painted is shown whole.
 */
export function claimAt(chatId: string, index: number, text: string, now = Date.now()): { at: number; from: number } | null {
  const held = armed.get(chatId);
  const began = held?.started.get(index);
  if (began !== undefined) return began;
  if (!held || index < held.end) return null;
  if (held.until < now) {
    armed.delete(chatId);
    return null;
  }
  const before = held.chunks ? (painted.get(chatId) ?? "") : "";
  if (!text.startsWith(before)) return null;
  painted.delete(chatId);
  const claimed = { at: now, from: before.length };
  held.started.set(index, claimed);
  return claimed;
}
/** When the reply at `index` began to be revealed, or null when it is shown whole. */
export const claim = (chatId: string, index: number, now = Date.now()) => claimAt(chatId, index, "", now)?.at ?? null;

const snappers = new Set<() => void>();
/** `snap` runs whenever every reveal is shown in full (paint.ts shows its painting in full too). */
export function onSnap(snap: () => void) {
  snappers.add(snap);
  return () => void snappers.delete(snap);
}
/** Shows every reply being revealed in full. */
export const snapReveals = () => {
  for (const held of armed.values()) for (const [index, began] of held.started) held.started.set(index, { ...began, at: 0 });
  for (const snap of [...snappers]) snap();
};

/** The text to draw for a reply: all of it, or the part revealed so far when it was claimed. */
export function useRevealed(text: string, claimNow: () => { at: number; from: number } | null): string {
  const [began] = useState(claimNow);
  const from = began?.from ?? 0;
  const [start, setStart] = useState<number | null>(() => (began !== null && Date.now() - began.at < revealMs(text.length - from) ? began.at : null));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start === null) return;
    const stop = () => setStart(null);
    snappers.add(stop);
    const timer = setInterval(() => {
      const at = Date.now();
      if (at - start >= revealMs(text.length - from)) stop();
      else setNow(at);
    }, REVEAL_TICK_MS);
    return () => {
      clearInterval(timer);
      snappers.delete(stop);
    };
  }, [start, text, from]);
  return start === null ? text : revealedText(text, now - start, from);
}
