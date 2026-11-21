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
export type SpaceContent = { id: string; rev: number; seenAt: number; panels: PanelView[]; cards: SpaceCard[] };
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

/** Whether a panel changed since the person last opened its space. */
export const panelChanged = (panel: Pick<Panel, "updatedAt">, seenAt: number | undefined) => !!seenAt && panel.updatedAt > seenAt;

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

/** Initials for a person's circle: their first letter. */
export const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
