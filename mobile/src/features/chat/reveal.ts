// A reply that lands whole (Settings › Chat › Text streaming) is shown word by word, as if written here.
// Only a reply that came while its chat was open and its turn was under way: the chat list arms the
// chat (`arm`) while the bot works, and the reply's row claims it when it is first drawn (`claim`).
// A touch in the chat or a message sent shows the whole text at once (`snapReveals`). A snapped
// reply stays whole: it is claimed once.
import { useEffect, useState } from "react";

export const REVEAL_TICK_MS = 30;
const GRACE_MS = 5000;

/** How long a text of this many characters takes to show. */
export const revealMs = (chars: number) => Math.min(1200, Math.max(300, chars * 4));

/** The part of `text` shown after `elapsed` ms: whole words, then the whole text when the time is up. */
export function revealedText(text: string, elapsed: number): string {
  const total = revealMs(text.length);
  if (elapsed >= total) return text;
  const want = Math.floor((text.length * Math.max(0, elapsed)) / total);
  if (want <= 0) return "";
  // To the end of the word that reaches `want`.
  const space = text.slice(want).search(/\s/);
  return space < 0 ? text : text.slice(0, want + space);
}

/**
 * By chat: messages from `end` (their place in the whole chat) may be revealed, until `until` once
 * the turn stopped. `started` keeps when each claimed one began, so a row drawn again carries on.
 */
const armed = new Map<string, { end: number; until: number; started: Map<number, number> }>();

/** The chat's turn is under way with no text streaming: its next replies are revealed. `end` is the chat's length now. */
export function arm(chatId: string, end: number) {
  const held = armed.get(chatId);
  if (held) held.until = Infinity;
  else armed.set(chatId, { end, until: Infinity, started: new Map() });
}
/** The turn stopped: a reply that lands soon after is still its own. */
export function settle(chatId: string, now = Date.now()) {
  const held = armed.get(chatId);
  if (held && held.until === Infinity) held.until = now + GRACE_MS;
}
export const disarm = (chatId: string) => void armed.delete(chatId);

/** When the reply at `index` began to be revealed, or null when it is shown whole. */
export function claim(chatId: string, index: number, now = Date.now()): number | null {
  const held = armed.get(chatId);
  const began = held?.started.get(index);
  if (began !== undefined) return began;
  if (!held || index < held.end) return null;
  if (held.until < now) {
    armed.delete(chatId);
    return null;
  }
  held.started.set(index, now);
  return now;
}

const snappers = new Set<() => void>();
/** Shows every reply being revealed in full. */
export const snapReveals = () => {
  for (const held of armed.values()) for (const index of held.started.keys()) held.started.set(index, 0);
  for (const snap of [...snappers]) snap();
};

/** The text to draw for a reply: all of it, or the part revealed so far when it was claimed. */
export function useRevealed(text: string, claimNow: () => number | null): string {
  const [start, setStart] = useState<number | null>(() => {
    const began = claimNow();
    return began !== null && Date.now() - began < revealMs(text.length) ? began : null;
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start === null) return;
    const stop = () => setStart(null);
    snappers.add(stop);
    const timer = setInterval(() => {
      const at = Date.now();
      if (at - start >= revealMs(text.length)) stop();
      else setNow(at);
    }, REVEAL_TICK_MS);
    return () => {
      clearInterval(timer);
      snappers.delete(stop);
    };
  }, [start, text]);
  return start === null ? text : revealedText(text, now - start);
}
