// Through the relay with Text streaming on, a reply's text comes in complete sentences every couple of
// seconds ("text-chunks-v1"). The turn under way paints each chunk word by word in about the time until
// the next one, so it reads as if it streamed. A chunk only adds to the text; a text that doesn't go on
// from what was painted (a new message in the turn) is painted from its start. What was painted is noted
// for the reply (reveal.ts `notePainted`), so the reply goes on from there. A touch shows it all (`snapReveals`).
import { useEffect, useRef, useState } from "react";
import { notePainted, onSnap, REVEAL_TICK_MS } from "./reveal";

/** How long a chunk takes to paint: a little less than the computer's 2 s between chunks. */
export const PAINT_MS = 1800;

/** The end of the word at or after `at`, or `text.length` when the text ends first. */
const wordEnd = (text: string, at: number) => {
  const space = text.slice(at).search(/\s/);
  return space < 0 ? text.length : at + space;
};

/**
 * How much of `text` is painted `elapsed` ms after a chunk came, painting from `base` (what was painted
 * then): whole words, all of it in `ms`. A chunk that comes before the last one is painted carries
 * on faster, so painting is never more than a chunk behind.
 */
export function paintedLength(text: string, base: number, elapsed: number, ms = PAINT_MS): number {
  if (elapsed >= ms || base >= text.length) return text.length;
  const want = base + Math.floor(((text.length - base) * Math.max(0, elapsed)) / ms);
  if (want <= base) return base;
  // To the end of the word that reaches `want`; a word still being written waits for its end.
  const end = wordEnd(text, want);
  if (end < text.length) return end;
  const last = text.slice(0, want).search(/\s\S*$/);
  return Math.max(base, last);
}

/** The text to draw for the turn under way's reply: all of it, or the part painted so far when `on`. */
export function usePainted(chatId: string, text: string, on: boolean): string {
  const held = useRef({ text: "", base: 0, at: 0, painted: 0 });
  const [, tick] = useState(0);
  const now = Date.now();
  const state = held.current;
  if (text !== state.text) {
    const goesOn = text.startsWith(state.text.slice(0, state.painted));
    const painted = goesOn ? state.painted : 0;
    held.current = { text, base: painted, at: now, painted };
  }
  const current = held.current;
  current.painted = on ? Math.max(current.painted, paintedLength(text, current.base, now - current.at)) : text.length;
  const shown = text.slice(0, current.painted);
  const done = current.painted >= text.length;
  useEffect(() => {
    notePainted(chatId, shown);
  }, [chatId, shown]);
  useEffect(() => {
    if (done) return;
    const stop = onSnap(() => {
      held.current.painted = held.current.text.length;
      tick((n) => n + 1);
    });
    const timer = setInterval(() => tick((n) => n + 1), REVEAL_TICK_MS);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [done]);
  return shown;
}
