// The side pane a bot opens beside a chat ("side-pane-v1"; the contract is the desktop app's
// docs/SIDE_PANE.md). This file decides when the phone opens or closes its sheet. No React Native
// imports, so tests/pane.test.ts runs it.
import type { ChatPane, PanePanel } from "@/link/types";

/** What the sheet does next: show a tab, close, or nothing. */
export type PaneMove = { open: string } | { close: true } | null;

/**
 * Looks at a chat's pane after it changed. `handled` is the ask this phone last acted on for the
 * chat (undefined: the chat is being seen for the first time). `running` says whether a turn is
 * still under way.
 *
 * The rules, from the contract:
 * - The sheet opens only when `ask.seq` rises, never by itself, so it can't reopen in a loop.
 * - A chat seen for the first time counts the ask it finds as handled, unless the turn that asked
 *   is still running (the bot opened the pane a moment ago, for the person who is looking now).
 * - An ask with `close` closes the sheet; the tabs stay.
 * - An ask for the chat's own details (no panel) opens nothing here: on a phone the chat itself is that.
 * - A pane the person closed after the latest ask stays closed: coming back to the chat, or the
 *   turn still running, doesn't bring it back. Only a newer ask (the bot shows something new) or
 *   the person opening it from the chat's menu does.
 */
export function paneMove(pane: ChatPane | undefined, handled: number | undefined, running: (runId: string) => boolean): { handled: number | undefined; move: PaneMove } {
  const ask = pane?.ask;
  if (!ask || typeof ask.seq !== "number") return { handled: handled ?? 0, move: null };
  const there = (id: string | null | undefined) => (id && pane.panels.some((panel) => panel.id === id) ? id : null);
  const closedSince = !!pane.closed && pane.closed.at >= ask.at;
  if (handled === undefined) {
    const live = !ask.close && !closedSince && running(ask.runId) ? there(ask.panelId) : null;
    return { handled: ask.seq, move: live ? { open: live } : null };
  }
  if (ask.seq <= handled) return { handled, move: null };
  if (ask.close) return { handled: ask.seq, move: { close: true } };
  const panel = closedSince ? null : there(ask.panelId);
  return { handled: ask.seq, move: panel ? { open: panel } : null };
}

/** The tab to show when the sheet opens without one being named: the one in front, else the newest. */
export function paneFront(pane: ChatPane | undefined): PanePanel | undefined {
  if (!pane?.panels.length) return undefined;
  return pane.panels.find((panel) => panel.id === pane.active) ?? pane.panels[pane.panels.length - 1];
}

/** A website a panel may show: http or https, with no user name in it. Anything else is not opened. */
export function paneUrl(url: string | undefined): string | null {
  if (!url || url.length > 2000) return null;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
