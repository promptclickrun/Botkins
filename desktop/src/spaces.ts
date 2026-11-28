// Spaces (the link's capability "spaces-v1"): named pages of panels, private or shared. Today,
// Feed, Ideas and Goals are spaces too. The contract is spaces.md in the mobile docs. The window's
// parts are in SpacePage.tsx and SpaceShare.tsx; this part has no window in it, so a test can read it.
import type { BoardItem, Panel, ShownPanel, State } from "./types";

export const SPACES_CAPABILITY = "spaces-v1";
export type SpaceAccess = "private" | "members" | "team" | "link";
export type SpaceCan = "own" | "edit" | "view";
export type SpaceBuiltin = "today" | "feed" | "ideas" | "goals";
export type SpaceNotify = "off" | "daily" | "all";
export type SpaceStart = "checklist" | "tracker" | "chart" | "table" | "notes" | "app";

export type MergedSpaceSource = {
  hostId: string;
  hostName: string;
  spaceId: string;
  rawSpaceId: string;
  rev: number;
  online: boolean;
};

/** A space as one person is sent it, in that person's order (the `spaces` part). */
export type SpaceSummary = {
  id: string;
  name: string;
  builtin?: SpaceBuiltin;
  /** The maker. */
  by: { id: string; name: string };
  mine: boolean;
  access: SpaceAccess;
  can: SpaceCan;
  /** With access "members". */
  people?: { id: string; name: string; can: "view" | "edit" }[];
  teamCan?: "view" | "edit";
  /** To the maker and the owner. */
  link?: string;
  /**
   * What is in the way of the link, to the maker and the owner: "leaving" while an earlier link's
   * copy is still being taken back from the relay; "off" when the space is shared by link and the
   * relay is off (it keeps its level and has no `link`).
   */
  linkState?: "leaving" | "off";
  /** Owner devices only. */
  projectId?: string;
  /** Panels and open cards the person is sent. */
  count: number;
  /** Of those, changed since the person last opened it (99 at most). */
  changed: number;
  pinned: boolean;
  notify: SpaceNotify;
  /** Other people looking at it now. */
  here: { id: string; name: string; panelId?: string }[];
  rev: number;
  updatedAt: number;
  /** Unified multi-host metadata for single-host spaces. */
  hostId?: string;
  hostName?: string;
  /** Unified multi-host merged built-in space: the per-host spaces combined into this virtual space. */
  merged?: {
    sources: MergedSpaceSource[];
    offlineCount: number;
  };
};

export type PanelNote = { id: string; by: string; name: string; text: string; at: number };
/** The last change a person made to a panel. */
export type PanelLast = { by: string; name: string; label?: string; at: number };
/** What a panel gains in a space. */
export type SpacePanelFields = {
  spaceId: string;
  createdBy?: string;
  state?: Record<string, unknown>;
  stateRev?: number;
  notes?: PanelNote[];
  last?: PanelLast;
  /** Things worth asking the panel's bot next, in the bot's own words (see `asksOf`). */
  asks?: string[];
};
/**
 * A panel as `spaces.read` answers it. A member gets it without its project, without its chats
 * unless they are in them, and without its routine's prompt unless they may change the space.
 */
export type PanelView = ShownPanel &
  SpacePanelFields & {
    routine: (NonNullable<ShownPanel["routine"]> & { setBy?: string }) | null;
  };
export type SpaceCard = BoardItem & { spaceId?: string };
/** The answer of `spaces.read(id)`. `seenAt` is when the person last opened it before this read. */
/** `seenItems`: when the person opened a panel or card on its own since `seenAt` (item id → time); absent from an older link. */
export type SpaceContent = {
  id: string;
  rev: number;
  seenAt: number;
  seenItems?: Record<string, number>;
  panels: PanelView[];
  cards: SpaceCard[];
  offlineCount?: number;
  contributingHosts?: number;
};
export type SpaceGrant = { id: string; can: "view" | "edit" };
export type SpaceShareInput = { access: SpaceAccess; grants?: SpaceGrant[]; teamCan?: "view" | "edit" };

/**
 * Whether the computer in use has Spaces. On its own computer the snapshot carries `spaces`;
 * using another computer, that computer names "spaces-v1" among its capabilities.
 */
export function hasSpaces(state: Pick<State, "remote" | "spaces">): boolean {
  const using = state.remote?.using;
  if (using) return !!using.capabilities?.includes(SPACES_CAPABILITY);
  return Array.isArray(state.spaces);
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** A space's shown name: its own, or "Maya's Today" for another person's built-in. */
export function spaceName(space: Pick<SpaceSummary, "name" | "builtin" | "mine" | "by">) {
  return space.builtin && !space.mine ? firstName(space.by.name) + "'s " + space.name : space.name;
}

/** "Maya", "Maya and Dev", "Maya, Dev and 2 more". */
export function namesLine(names: string[]) {
  const first = names.map(firstName);
  if (first.length <= 2) return first.join(" and ");
  return first.slice(0, 2).join(", ") + " and " + (first.length - 2) + " more";
}

/** Who can open a space, as its tag and subtitle say it. */
export function accessTag(space: Pick<SpaceSummary, "access" | "mine" | "by" | "people">) {
  if (space.access === "team") return "All members";
  if (space.access === "link") return "Anyone with the link";
  if (space.access === "members" && space.people?.length) return namesLine(space.people.map((p) => p.name));
  return space.mine ? "Only you" : "Only " + firstName(space.by.name);
}

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** When something was last seen, in words: "this morning", "earlier today", "yesterday", the weekday within a week, else the date. */
export function seenWords(seenAt: number, now = Date.now(), locale?: string) {
  const today = startOfDay(now);
  if (seenAt >= today) return new Date(seenAt).getHours() < 12 ? "this morning" : "earlier today";
  if (seenAt >= today - DAY) return "yesterday";
  if (seenAt >= today - 6 * DAY) return new Date(seenAt).toLocaleDateString(locale, { weekday: "long" });
  return new Date(seenAt).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** "2 panels changed since yesterday", or null when nothing changed. */
export function changedLine(changed: number, seenAt: number | undefined, now = Date.now(), locale?: string) {
  if (!(changed > 0)) return null;
  const what = changed === 1 ? "1 panel changed" : changed + " panels changed";
  return seenAt ? what + " since " + seenWords(seenAt, now, locale) : what;
}

/** A short age: "now", "5m", "3h", else the date. */
export function ago(t: number, now = Date.now(), locale?: string) {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  return h < 24 ? h + "h" : new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** A panel's footer time: an age for what happened ("5m"), the hour for what comes later today ("10:00 AM"), else the date and hour. */
export function spaceWhen(t: number, now = Date.now(), locale?: string) {
  if (t <= now) return ago(t, now, locale);
  const hour = new Date(t).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (t < startOfDay(now) + DAY) return hour;
  return new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric" }) + ", " + hour;
}

/** A panel's last line: "Maya ticked Press kit · 2m", or "Maya changed this · 2m" without a label. */
export function lastLine(last: PanelLast, now = Date.now(), locale?: string) {
  const label = last.label?.trim();
  const what = label ? label.charAt(0).toLowerCase() + label.slice(1) : "changed this";
  return firstName(last.name) + " " + what + " · " + ago(last.at, now, locale);
}

/** Panel or card id → when the person opened that one on its own (the link's `seenItems`, and what they opened since). */
export type OpenedItems = Readonly<Record<string, number>>;

/**
 * Whether a panel changed for this person since they last opened its space, or since they opened
 * that panel (`opened`). A person's own tick or note is not news to them: `last` is theirs and is
 * the panel's newest change (the computer stamps the two times together; the phone allows the same
 * two seconds between them).
 */
export const panelChanged = (panel: Pick<Panel, "updatedAt"> & { id?: string; last?: Pick<PanelLast, "by" | "at"> }, seenAt: number | undefined, me?: string, opened?: OpenedItems) =>
  !!seenAt && panel.updatedAt > Math.max(seenAt, (panel.id && opened?.[panel.id]) || 0) && !(!!me && panel.last?.by === me && panel.last.at >= panel.updatedAt - 2000);

/** How many of a space's panels changed for this person, for "2 panels changed since yesterday". A hidden panel is not counted. */
export const changedPanels = (panels: readonly (Pick<Panel, "updatedAt" | "hidden"> & { id?: string; last?: Pick<PanelLast, "by" | "at"> })[], seenAt: number | undefined, me?: string, opened?: OpenedItems) =>
  panels.filter((panel) => !panel.hidden && panelChanged(panel, seenAt, me, opened)).length;

/**
 * The new panel's project, for the owner's "Project" row of New panel: what the person picked
 * (null is "None"), else the chosen space's own project when it has one. A project that is gone
 * counts as none.
 */
export function panelProject(picked: string | null | undefined, space: Pick<SpaceSummary, "projectId"> | undefined, projects: readonly { id: string }[] | undefined): string | undefined {
  const id = picked === undefined ? space?.projectId : (picked ?? undefined);
  return id && projects?.some((project) => project.id === id) ? id : undefined;
}

export const ASKS_MAX = 3;
export const ASK_LENGTH = 60;
/**
 * What a panel's bot says is worth asking next, for the chips under an opened panel: the bot's own
 * words, each on one line, at most three of at most 60 characters. Empty when the bot gave none:
 * the app never makes any up.
 */
export function asksOf(panel: { asks?: unknown } | undefined): string[] {
  if (!Array.isArray(panel?.asks)) return [];
  return panel.asks
    .flatMap((ask: unknown) => (typeof ask === "string" ? [ask.replace(/\s+/g, " ").trim().slice(0, ASK_LENGTH).trim()] : []))
    .filter(Boolean)
    .slice(0, ASKS_MAX);
}

/** The icon a space wears in the menu. A built-in keeps its own, also when shared. */
export function spaceIcon(space: Pick<SpaceSummary, "builtin" | "access">): SpaceBuiltin | "shared" | "grid" {
  if (space.builtin) return space.builtin;
  return space.access === "private" ? "grid" : "shared";
}

/** A row's line in All spaces: "5 panels · Maya and Dev · Updated 5m". */
export function spaceLine(space: SpaceSummary, now = Date.now(), locale?: string) {
  const count = space.count === 1 ? "1 panel" : space.count + " panels";
  return count + " · " + accessTag(space) + " · Updated " + ago(space.updatedAt, now, locale);
}

/** "Delete Launch and its 5 panels?" */
export function deleteQuestion(name: string, panels: number) {
  if (!panels) return "Delete " + name + "?";
  return "Delete " + name + " and its " + (panels === 1 ? "1 panel" : panels + " panels") + "?";
}

/** The person's order and pins after pinning or unpinning one space, for `link.spaces.arrange`. */
export function arrangePin(spaces: Pick<SpaceSummary, "id" | "pinned">[], id: string, pin: boolean) {
  const pinned = spaces.filter((s) => s.pinned && s.id !== id).map((s) => s.id);
  if (pin) pinned.push(id);
  // Pinned first, in pinned order, then the rest as they were: the order the spaces part comes in.
  const rest = spaces.map((s) => s.id).filter((s) => !pinned.includes(s));
  return { order: [...pinned, ...rest], pinned };
}

/** `ids` with `id` taken out and put back before `target`, or after it. The same list when it does not move. */
function reorder(ids: string[], id: string, target: string, after: boolean) {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids;
  const rest = ids.filter((x) => x !== id);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, id);
  return rest;
}

/** Pinned spaces in a new order, then the rest as they were: the shape `link.spaces.arrange` takes. */
function arrangeWith(spaces: Pick<SpaceSummary, "id" | "pinned">[], pinned: string[]) {
  const rest = spaces.map((s) => s.id).filter((s) => !pinned.includes(s));
  return { order: [...pinned, ...rest], pinned };
}

/**
 * The person's order after dragging the pinned space `id` before or after the pinned space
 * `target` in the side menu. Null when nothing moves.
 */
export function arrangeMove(spaces: Pick<SpaceSummary, "id" | "pinned">[], id: string, target: string, after: boolean) {
  const pinned = spaces.filter((s) => s.pinned).map((s) => s.id);
  const next = reorder(pinned, id, target, after);
  if (next.join() === pinned.join()) return null;
  return arrangeWith(spaces, next);
}

/** Move up (-1) or Move down (1) for a pinned space. Null at the top or the bottom. */
export function arrangeStep(spaces: Pick<SpaceSummary, "id" | "pinned">[], id: string, by: -1 | 1) {
  const pinned = spaces.filter((s) => s.pinned).map((s) => s.id);
  const at = pinned.indexOf(id);
  const target = pinned[at + by];
  if (at < 0 || !target) return null;
  return arrangeMove(spaces, id, target, by > 0);
}

/**
 * Where a dragged panel lands when it is dropped before or after the panel `target`: the order the
 * page shows while dragging, and `before` for `spaces.movePanel` (the panel it lands in front of, or
 * null for the end). Null when it would stay where it is.
 */
export function panelDrop(ids: string[], id: string, target: string, after: boolean) {
  const order = reorder(ids, id, target, after);
  if (order.join() === ids.join()) return null;
  return { order, before: order[order.indexOf(id) + 1] ?? null };
}

export type PanelSize = "small" | "wide" | "tall";
export const PANEL_SIZES: { id: PanelSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "wide", label: "Wide" },
  { id: "tall", label: "Tall" },
];

/**
 * The size a panel snaps to while its corner is pulled. `width` and `height` are from the panel's
 * top left corner to the pointer. The grid has two columns: a pull that ends nearer one column than
 * both is Small; across both it is Wide, and pulled down past `tallAt` it is Tall.
 */
export function snapSize(width: number, height: number, grid: { width: number; gap: number; tallAt: number }): PanelSize {
  const column = (grid.width - grid.gap) / 2;
  if (width < (column + grid.width) / 2) return "small";
  return height >= grid.tallAt ? "tall" : "wide";
}

/** The size after an arrow key on a panel's corner: right and down make it bigger, left and up smaller. */
export function stepSize(size: PanelSize, key: string): PanelSize {
  const at = PANEL_SIZES.findIndex((s) => s.id === size);
  const by = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  return PANEL_SIZES[Math.min(PANEL_SIZES.length - 1, Math.max(0, at + by))].id;
}

/** A person removes their own notes; the space's maker and the computer's owner remove any. */
export const canRemoveNote = (note: Pick<PanelNote, "by">, me: string, space: Pick<SpaceSummary, "mine">) =>
  note.by === me || space.mine || me === "owner";

/**
 * The spaces a panel may move to from the panel's ⋯: every other space the person can change. A
 * panel leaves a space only when the person owns that space or asked for the panel.
 */
export function moveTargets<T extends Pick<SpaceSummary, "id" | "can" | "hostId" | "merged">>(
  spaces: T[],
  from: Pick<SpaceSummary, "id" | "can">,
  panel: { createdBy?: string; hostId?: string },
  me: string,
) {
  if (from.can !== "own" && panel.createdBy !== me) return [];
  const panelHost = panel.hostId;
  return spaces.filter((s) => {
    if (s.id === from.id || s.can === "view") return false;
    if (!panelHost) return true;
    if (s.merged) return s.merged.sources.some((src) => src.hostId === panelHost);
    return !s.hostId || s.hostId === panelHost;
  });
}

/** The spaces Attach offers on a project: the person's own, not the built-ins, and any already attached there. */
export function attachable<T extends Pick<SpaceSummary, "mine" | "builtin" | "projectId">>(spaces: T[], projectId: string) {
  return spaces.filter((s) => s.projectId === projectId || (s.mine && !s.builtin));
}

/** The lists of All spaces. `owner`: the person looking is the computer's owner. */
export function spaceSections<T extends Pick<SpaceSummary, "pinned" | "mine" | "by">>(spaces: T[], owner: boolean) {
  const pinned = spaces.filter((s) => s.pinned);
  let more = spaces.filter((s) => !s.pinned);
  // "From members": the spaces a member made, as the owner sees them. To drop the section, delete
  // this block (and its heading in SpacePage.tsx); those spaces then stay under More.
  let fromMembers: T[] = [];
  if (owner) {
    fromMembers = more.filter((s) => !s.mine && s.by.id !== "owner");
    more = more.filter((s) => !fromMembers.includes(s));
  }
  return { pinned, more, fromMembers };
}

/** The bot an ask goes to: the space's first panel's bot when it is visible, else the primary bot. */
export function askBot<B extends { id: string }>(bots: B[], panels: Pick<Panel, "botId">[]) {
  return bots.find((b) => b.id === panels[0]?.botId) ?? bots[0];
}

/** Quiet note shown in a merged built-in space when one or more included computers are offline. */
export function offlineComputersNote(count: number | undefined): string | null {
  if (!(count && count > 0)) return null;
  return count === 1 ? "1 computer offline" : count + " computers offline";
}

/** Signature of a space's read version so merged spaces re-read when contributing hosts or offline count change. */
export function spaceReadSignature(space: Pick<SpaceSummary, "rev" | "merged">): string {
  if (!space.merged) return String(space.rev);
  const sources = space.merged.sources.map((s) => s.hostId + ":" + s.rev).join(",");
  return space.rev + "|" + sources + "|off:" + space.merged.offlineCount;
}

export const mergedSpaceHostPicker = (
  space: Pick<SpaceSummary, "merged"> | undefined,
  preferredHostId: string | null | undefined,
  fallbackHostId?: string | null,
): { targetHostId: string | null; needsPick: boolean; choices: NonNullable<SpaceSummary["merged"]>["sources"] } => {
  const choices = space?.merged?.sources ?? [];
  if (!choices.length) return { targetHostId: null, needsPick: false, choices };
  const picked =
    (preferredHostId && choices.some((s) => s.hostId === preferredHostId) ? preferredHostId : null) ??
    (fallbackHostId && choices.some((s) => s.hostId === fallbackHostId) ? fallbackHostId : null) ??
    (choices.length === 1 ? choices[0]!.hostId : null);
  return { targetHostId: picked, needsPick: choices.length > 1 && !picked, choices };
};
/** Initials for a person's circle: their first letter. */
export const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
