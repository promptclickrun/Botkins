// Spaces ("spaces-v1") as the phone reads them. The list comes by itself in the `spaces` part; a
// space's content is asked for (`spaces.read`) and asked again when the list says its `rev` passed
// the one held. Nothing here is kept past the computer in use: `onComputerChange` empties it.
import { type Href, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { PanelView, SpaceContent, SpaceSummary } from "@/link/types";
import { useCapability, useOnline, usePart } from "@/state/hooks";
import { api, attempt, boundApi } from "@/state/link";
import { openPlace } from "@/features/all/open";
import { DRAG } from "@/features/home/drag";
import { runMarkSpacesRead } from "@/features/chat/unread";
import { onComputerChange, showToast, useApp } from "@/state/store";
import type { FrameState } from "@/ui";
import { type PanelPin, setPrefs, usePrefs } from "@/state/prefs";
import { applyArrangement, type Arrangement, hasPanelPin, spaceRoute, withPanelPin, withPin } from "./logic";

const NONE: SpaceSummary[] = [];

/** Whether the computer has spaces. Without them the phone keeps today's Today page. */
export const useSpacesOn = () => useCapability("spaces-v1");

/** The spaces this person can open, pinned first, in their order. Empty until the computer has answered. */
export const useSpaces = (): SpaceSummary[] => usePart("spaces") ?? NONE;
export const useSpace = (id: string | undefined): SpaceSummary | undefined => useSpaces().find((space) => space.id === id);

type Held = { content?: SpaceContent; error?: string; asking?: boolean; sig?: string };
const useContents = create<Record<string, Held>>(() => ({}));
onComputerChange(() => useContents.setState({}, true));

function spaceReadSig(space: SpaceSummary | undefined): string | undefined {
  if (!space) return undefined;
  if (!space.merged) return String(space.rev);
  const parts = space.merged.sources.map((s) => `${s.hostId}:${s.rev}`).join(",");
  return `${space.rev}|${parts}|off:${space.merged.offlineCount}`;
}

const asking = new Set<string>();
/** Reads a space's content, once at a time for each space. */
function read(id: string, sig?: string) {
  if (asking.has(id)) return;
  asking.add(id);
  useContents.setState((all) => ({ ...all, [id]: { ...all[id], asking: true } }));
  api["spaces.read"](id)
    .then(
      (content) => useContents.setState((all) => ({ ...all, [id]: { content, sig: sig ?? String(content.rev) } })),
      (error: unknown) => useContents.setState((all) => ({ ...all, [id]: { content: all[id]?.content, sig: all[id]?.sig, error: error instanceof Error && error.message ? error.message : "Couldn't open this space." } })),
    )
    .finally(() => asking.delete(id));
}

/** Each space's panels as the phone has read them since it started, by space id (for the widgets' snapshot). */
export const readPanels = (): Record<string, PanelView[]> => Object.fromEntries(Object.entries(useContents.getState()).flatMap(([id, held]) => (held.content ? [[id, held.content.panels]] : [])));
/** Calls `listener` when a space's content was read. Answers a function that stops it. */
export const watchSpaceContents = (listener: () => void) => useContents.subscribe(listener);
/** Reads a space the phone has not read since it started, quietly (a panel widget is on show). */
export function readSpaceOnce(id: string) {
  if (!useContents.getState()[id]?.content) read(id);
}

/**
 * A space's panels and cards. Read when first asked for, and again when the space changed on the
 * computer (the list's `rev` passed the one held, or a merged space's contributing hosts changed)
 * or the computer came back. What is held stays on screen while a fresh read is on its way.
 */
export function useSpaceContent(id: string | undefined): { content?: SpaceContent; error?: string; loading: boolean; retry: () => void } {
  const on = useSpacesOn();
  const online = useOnline();
  const space = useSpace(id);
  const rev = space?.rev;
  const sig = spaceReadSig(space);
  const held = useContents((all) => (id ? all[id] : undefined));
  const heldRev = held?.content?.rev;
  const heldSig = held?.sig;
  useEffect(() => {
    if (!on || !online || !id || rev === undefined || sig === undefined) return;
    if (heldRev === undefined || (space?.merged ? sig !== heldSig : rev > heldRev)) read(id, sig);
  }, [on, online, id, rev, sig, heldRev, heldSig, space?.merged]);
  return { content: held?.content, error: held?.content ? undefined : held?.error, loading: !held?.content && !held?.error, retry: () => id && read(id, sig) };
}

/**
 * What this phone marked seen since the space was last read: a space up to the newest change it
 * showed, and a panel or card opened on its own up to its change (by id). A read does not follow a
 * mark (the space's `rev` does not move), so the screens hold these on top of the read's `seenAt`.
 * Times are the computer's (`updatedAt`), never this phone's clock.
 */
type Marks = { spaces: Record<string, number>; items: Record<string, number> };
export const useSeenMarks = create<Marks>(() => ({ spaces: {}, items: {} }));
onComputerChange(() => useSeenMarks.setState({ spaces: {}, items: {} }, true));

const newest = (content: SpaceContent | undefined) => Math.max(0, ...(content?.panels ?? []).map((panel) => panel.updatedAt), ...(content?.cards ?? []).map((card) => card.updatedAt ?? 0));

/** The person has looked at this space now: its dots clear. Quietly: a failed mark is not worth a toast. */
export function markSeen(id: string) {
  const upTo = newest(useContents.getState()[id]?.content);
  if (upTo) useSeenMarks.setState((marks) => ({ spaces: { ...marks.spaces, [id]: Math.max(marks.spaces[id] ?? 0, upTo) } }));
  api["link.spaces.seen"](id).catch(() => {});
}

/** Explicit mark-as-read for one or more spaces: captures pre-send timestamps and computer so in-flight updates stay unread. */
export async function markSpacesRead(ids: string[]) {
  const { api: bound, isCurrent: clientCurrent } = boundApi();
  const computer = useApp.getState().pairing?.serverId;
  const isCurrent = () => clientCurrent() && useApp.getState().pairing?.serverId === computer;
  const result = await runMarkSpacesRead(ids, (id) => bound["link.spaces.seen"](id), {
    snapshotUpTo: (id) => newest(useContents.getState()[id]?.content),
    isCurrent,
    applyMarks: (captured) => {
      useSeenMarks.setState((marks) => {
        const next = { ...marks.spaces };
        let changed = false;
        for (const [id, upTo] of Object.entries(captured)) {
          if (upTo > (next[id] ?? 0)) {
            next[id] = upTo;
            changed = true;
          }
        }
        return changed ? { spaces: next } : marks;
      });
    },
  });
  if (result.failed > 0 && isCurrent()) {
    showToast(result.error instanceof Error && result.error.message ? result.error.message : "Couldn't mark as read.", "error");
  }
}

/**
 * The person opened one panel (or card) of a space: its dot clears, on this phone at once and on
 * their other devices. `upTo` is the change it showed (`updatedAt`); a newer one brings the dot back.
 * An older computer takes the mark as one for the whole space.
 */
export function markItemSeen(spaceId: string, itemId: string, upTo: number) {
  if ((useSeenMarks.getState().items[itemId] ?? 0) >= upTo) return;
  useSeenMarks.setState((marks) => ({ items: { ...marks.items, [itemId]: upTo } }));
  api["link.spaces.seen"](spaceId, itemId).catch(() => {});
}

/** The person is looking at this space (and this panel) now, or at none. The computer forgets after a while, so a screen says it again. */
export function lookingAt(id: string | null, panelId?: string) {
  api["link.spaces.here"](id, panelId).catch(() => {});
}

export const setPinned = (spaces: SpaceSummary[], id: string, pinned: boolean) => void attempt(api["link.spaces.arrange"](withPin(spaces, id, pinned)));

/**
 * The person's order and pins, changed by a drop: the new list is shown at once and kept until the
 * computer's own arrives (the list changes once more after the call, or DRAG.HOLD_ORDER_MS). A call
 * that failed shows its toast and the computer's list comes back. Home holds a dropped bot's order
 * the same way.
 */
export function useArranging(spaces: SpaceSummary[]) {
  const [pending, setPending] = useState<{ plan: Arrangement; done?: SpaceSummary[] } | null>(null);
  const live = useApp((state) => state.parts.spaces);
  const stale = !!pending?.done && pending.done !== live;
  useEffect(() => {
    if (stale) setPending(null);
  }, [stale]);
  useEffect(() => {
    if (!pending?.done) return;
    const timer = setTimeout(() => setPending(null), DRAG.HOLD_ORDER_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const arrange = (plan: Arrangement | undefined) => {
    if (!plan) return;
    const mine = { plan };
    setPending(mine);
    void attempt(api["link.spaces.arrange"](plan).then(() => true)).then((ok) => setPending((now) => (now === mine ? (ok ? { ...mine, done: useApp.getState().parts.spaces ?? [] } : null) : now)));
  };
  const shown = useMemo(() => (pending && !stale ? applyArrangement(spaces, pending.plan) : spaces), [spaces, pending, stale]);
  return { shown, arrange };
}

// The routes are new: typed routes learn them the next time Metro starts.
export const openSpace = (id: string) => router.push(spaceRoute(id) as unknown as Href);
/** The list of spaces: its tab while Spaces is on the bar, otherwise its page. */
export const openSpaces = () => openPlace("spaces");
export const openShare = (id: string) => router.push(("/space/share?id=" + encodeURIComponent(id)) as unknown as Href);
export const openNewPanel = (spaceId: string) => router.push(("/space/new-panel?spaceId=" + encodeURIComponent(spaceId)) as unknown as Href);
export const openPanel = (spaceId: string, panelId: string) => router.push(spaceRoute(spaceId, panelId) as unknown as Href);

/**
 * A panel's saved state for its app: what it is, and how to change it when the person may act in
 * the space. The computer's own sentence shows when it refuses ("Wait a moment before you change
 * this panel again."); the change itself comes back through the space's content.
 */
export function panelState(panel: Pick<PanelView, "id" | "state" | "stateRev">, space: Pick<SpaceSummary, "can">, mayUse: boolean): FrameState {
  const acts = mayUse && (space.can === "own" || space.can === "edit");
  return {
    value: panel.state ?? {},
    rev: panel.stateRev ?? 0,
    ...(acts && { set: (patch: Record<string, unknown>, label?: string) => attempt(api["spaces.patchState"](panel.id, patch, label).then(() => true)).then((saved) => saved === true) }),
  };
}

/** Whether a space's panels show open on its page. Every other space shows them as cards. Kept on this phone. */
export const useSpaceOpen = (id: string) => usePrefs((prefs) => prefs.openSpaces.includes(id));
export function setSpaceOpen(id: string, open: boolean) {
  const rest = usePrefs.getState().openSpaces.filter((one) => one !== id);
  setPrefs({ openSpaces: open ? [...rest, id].slice(-200) : rest });
}

/** Whether a panel is pinned to Home, and the way to pin it or take it off. Kept on this phone. */
export const usePanelPinned = (spaceId: string, panelId: string) => usePrefs((prefs) => hasPanelPin(prefs.homePanels, { spaceId, panelId }));
/** `quiet`: nothing is said (a panel that is gone takes its pin with it). */
export function setPanelPinned(pin: PanelPin, on: boolean, quiet = false) {
  setPrefs({ homePanels: withPanelPin(usePrefs.getState().homePanels, pin, on) });
  if (!quiet) showToast(on ? "Pinned to Home" : "Taken off Home", "success");
}
