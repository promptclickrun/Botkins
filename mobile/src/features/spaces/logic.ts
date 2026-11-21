// Spaces on the phone ("spaces-v1"; docs/spaces.md): the words and the order of the screens, as
// plain functions. The words are the contract's "Words on screen", final for both apps. No React
// Native imports, so tests/spaces-phone.test.ts runs it.
import type { PanelStart, PanelView, Person, SpaceAccess, SpaceNotify, SpaceShareInput, SpaceSummary } from "@/link/types";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** A space's name as a person reads it: another person's built-in space says whose it is ("Maya's Today"). */
export const spaceTitle = (space: Pick<SpaceSummary, "name" | "builtin" | "mine" | "by">) => (space.builtin && !space.mine && space.by.name ? first(space.by.name) + "'s " + space.name : space.name);

/** Names as one phrase: "Maya", "Maya and Dev", "Maya, Dev and 2 more". */
export function names(list: string[]): string {
  const shown = list.map(first);
  if (shown.length <= 2) return shown.join(" and ");
  return shown[0] + ", " + shown[1] + " and " + (shown.length - 2) + " more";
}

/** Who can open a space, as a tag and a subtitle: "Only you", the picked people's first names, "All members", "Anyone with the link". */
export function whoCanOpen(space: Pick<SpaceSummary, "access" | "mine" | "by" | "people">): string {
  if (space.access === "team") return "All members";
  if (space.access === "link") return "Anyone with the link";
  if (space.access === "members" && space.people?.length) return names(space.people.map((person) => person.name));
  return space.mine ? "Only you" : "Only " + first(space.by.name || "its maker");
}

const count = (n: number, one: string, many: string) => n + " " + (n === 1 ? one : many);

/** What a space holds, for a row: "4 panels", "3 new", "2 ideas", "3 goals". */
export function holds(space: Pick<SpaceSummary, "builtin" | "count" | "changed">): string {
  if (space.builtin === "feed") return space.changed > 0 ? space.changed + " new" : count(space.count, "item", "items");
  if (space.builtin === "ideas") return count(space.count, "idea", "ideas");
  if (space.builtin === "goals") return count(space.count, "goal", "goals");
  return count(space.count, "panel", "panels");
}

/** A row's line in All spaces: "5 panels · Maya and Dev". */
export const rowLine = (space: SpaceSummary) => holds(space) + " · " + whoCanOpen(space);

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** When a person last looked, as the end of "… changed since …": "this morning", "earlier today", "yesterday", the weekday within a week, else the date. */
export function since(seenAt: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(seenAt)) / DAY);
  if (days <= 0) return new Date(seenAt).getHours() < 12 ? "this morning" : "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(seenAt);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(seenAt);
}

/** Whether a panel changed for this person since they last looked. Their own tick or note is not news to them. */
const newTo = (panel: Pick<PanelView, "updatedAt" | "last">, seenAt: number, me?: string) => panel.updatedAt > seenAt && !(me && panel.last?.by === me && panel.last.at >= panel.updatedAt - 2000);

/** "2 panels changed since yesterday", or nothing when nothing did or the space was never opened. `me` is this phone's person. */
export function changedLine(panels: Pick<PanelView, "updatedAt" | "hidden" | "last">[], seenAt: number, now = Date.now(), me?: string): string | undefined {
  if (!seenAt) return undefined;
  const changed = panels.filter((panel) => !panel.hidden && newTo(panel, seenAt, me)).length;
  return changed ? count(changed, "panel", "panels") + " changed since " + since(seenAt, now) : undefined;
}

/** The ids of the panels that changed since the person last opened the space: each gets a dot. */
export const changedSince = (panels: Pick<PanelView, "id" | "updatedAt" | "last">[], seenAt: number, me?: string) => new Set(seenAt ? panels.filter((panel) => newTo(panel, seenAt, me)).map((panel) => panel.id) : []);

/**
 * All spaces, in sections: Pinned (in the person's order, as sent), More, and for an owner with
 * Admin mode on, From members (what members made and did not share with the owner).
 */
export function spaceSections(spaces: SpaceSummary[], viewer: { owner: boolean; admin: boolean }): { title: "Pinned" | "More" | "From members"; spaces: SpaceSummary[] }[] {
  const pinned = spaces.filter((space) => space.pinned);
  const rest = spaces.filter((space) => !space.pinned);
  const theirs = (space: SpaceSummary) => viewer.owner && viewer.admin && !space.mine && space.by.id !== "owner" && !sharedWith(space, "owner");
  const sections = [
    { title: "Pinned" as const, spaces: pinned },
    { title: "More" as const, spaces: rest.filter((space) => !theirs(space)) },
    { title: "From members" as const, spaces: rest.filter(theirs) },
  ];
  return sections.filter((section) => section.spaces.length);
}

/** Whether a space is shared with a person by a pick, with all members, or by link. */
const sharedWith = (space: Pick<SpaceSummary, "access" | "people">, person: string) => space.access === "team" || space.access === "link" || (space.access === "members" && !!space.people?.some((one) => one.id === person));

/** The pins and the order to send after a space is pinned or unpinned: pins keep their order, a new pin goes last. */
export function withPin(spaces: SpaceSummary[], id: string, pinned: boolean): { order: string[]; pinned: string[] } {
  const pins = spaces.filter((space) => space.pinned && space.id !== id).map((space) => space.id);
  return { order: spaces.map((space) => space.id), pinned: pinned ? [...pins, id] : pins };
}

/** The order to send after "Move up" or "Move down" among the pinned or the others, or null at either end. */
export function withMove(spaces: SpaceSummary[], id: string, by: -1 | 1): { order: string[]; pinned: string[] } | null {
  const space = spaces.find((one) => one.id === id);
  if (!space) return null;
  const group = spaces.filter((one) => one.pinned === space.pinned).map((one) => one.id);
  const at = group.indexOf(id);
  const other = at + by;
  if (other < 0 || other >= group.length) return null;
  [group[at], group[other]] = [group[other]!, group[at]!];
  const pins = space.pinned ? group : spaces.filter((one) => one.pinned).map((one) => one.id);
  const rest = space.pinned ? spaces.filter((one) => !one.pinned).map((one) => one.id) : group;
  return { order: [...pins, ...rest], pinned: pins };
}

// ── Dragging a space ─────────────────────────────────────────────────────────

/** Where a dragged space can land: among the pinned (Home's row) or among the others. What members made is no place to drop. */
export type SpaceZone = "pinned" | "more";
export type Arrangement = { order: string[]; pinned: string[] };
type Viewer = { owner: boolean; admin: boolean };

/** All spaces as one run of items, top to bottom: each section's heading, then its spaces. A dragged space lands only among "row" items. */
export type SpaceItem = { key: string; kind: "head"; zone: SpaceZone } | { key: string; kind: "row"; zone: SpaceZone; id: string } | { key: string; kind: "fixed"; id?: string; title?: string };

/**
 * The list for the board. While a space is dragged (`dragging`), Pinned and More show their heading
 * also when empty, so a space can be dropped into them.
 */
export function spaceItems(spaces: SpaceSummary[], viewer: Viewer, dragging: boolean): SpaceItem[] {
  const sections = spaceSections(spaces, viewer);
  const of = (title: string) => sections.find((section) => section.title === title)?.spaces ?? [];
  const items: SpaceItem[] = [];
  for (const [zone, title] of [["pinned", "Pinned"], ["more", "More"]] as const) {
    const list = of(title);
    if (!list.length && !dragging) continue;
    items.push({ key: "head:" + zone, kind: "head", zone });
    for (const space of list) items.push({ key: "space:" + space.id, kind: "row", zone, id: space.id });
  }
  const theirs = of("From members");
  if (theirs.length) items.push({ key: "head:theirs", kind: "fixed", title: "From members" }, ...theirs.map((space): SpaceItem => ({ key: "space:" + space.id, kind: "fixed", id: space.id })));
  return items;
}

/**
 * What dropping space `id` into `zone`, at `index` among that group's other spaces, asks of the
 * computer: the person's whole order (pinned first) and their pins. Only the dropped space moves.
 * Undefined when nothing changes.
 */
export function spaceDropPlan(spaces: SpaceSummary[], viewer: Viewer, id: string, zone: SpaceZone, index: number): Arrangement | undefined {
  if (!spaces.some((space) => space.id === id)) return undefined;
  const was = spaces.filter((space) => space.pinned).map((space) => space.id);
  const pinned = was.filter((one) => one !== id);
  const rest = spaces.filter((space) => !space.pinned && space.id !== id).map((space) => space.id);
  if (zone === "pinned") pinned.splice(Math.max(0, Math.min(index, pinned.length)), 0, id);
  else {
    // Among "More": just before the one now at `index` there, else after its last. What members made keeps its place.
    const more = (spaceSections(spaces, viewer).find((section) => section.title === "More")?.spaces ?? []).map((space) => space.id).filter((one) => one !== id);
    const at = Math.max(0, index);
    const [before, next] = [more[at - 1], more[at]];
    // Already between its new neighbours in the person's order: it stays where it is.
    const now = spaces.filter((space) => !space.pinned).map((space) => space.id);
    const here = now.indexOf(id);
    if (here >= 0 && (!before || now.indexOf(before) < here) && (!next || now.indexOf(next) > here)) rest.splice(0, rest.length, ...now);
    else rest.splice(next ? rest.indexOf(next) : more.length ? rest.indexOf(more[more.length - 1]!) + 1 : 0, 0, id);
  }
  const order = [...pinned, ...rest];
  const same = order.every((one, i) => one === spaces[i]?.id) && pinned.length === was.length && pinned.every((one, i) => one === was[i]);
  return same ? undefined : { order, pinned };
}

/** The spaces as they will be once the computer has taken an arrangement: shown at once, until its own list arrives. */
export function applyArrangement(spaces: SpaceSummary[], plan: Arrangement): SpaceSummary[] {
  const by = new Map(spaces.map((space) => [space.id, space]));
  const pins = new Set(plan.pinned);
  const moved = plan.order.flatMap((id) => (by.has(id) ? [{ ...by.get(id)!, pinned: pins.has(id) }] : []));
  // A space the plan does not name (it arrived meanwhile) keeps its place at the end.
  return [...moved, ...spaces.filter((space) => !plan.order.includes(space.id))];
}

// ── Share ───────────────────────────────────────────────────────────────────

export type ShareChoice = { access: SpaceAccess; title: string; line: string; disabled?: string };

/**
 * The four choices of "Who can open it", each with its line. `member` is this phone's person when
 * it is not the owner; a member shares by link only when their role may manage spaces and the owner
 * turned "Members may share by link" on.
 */
export function shareChoices(space: Pick<SpaceSummary, "people">, team: { people: Person[]; computer: string; linkSharing: boolean; relay: boolean }, me: { member: boolean; manage: boolean }): ShareChoice[] {
  const picked = space.people ?? [];
  const others = team.people.length;
  const link: ShareChoice = { access: "link", title: "Anyone with the link", line: "They can look, not change" };
  if (!team.relay) link.disabled = "Turn on the relay on your computer to share by link.";
  else if (me.member && !team.linkSharing) link.disabled = "The owner hasn't turned on sharing by link for members.";
  else if (me.member && !me.manage) link.disabled = "Your team role can't share by link.";
  return [
    { access: "private", title: "Only you", line: me.member ? "The owner can open it too" : "Private" },
    { access: "members", title: "Members you pick", line: picked.length ? (picked.length <= 3 ? picked.map((person) => person.name).join(", ") : picked.length + " picked") : "Pick who can open it" },
    { access: "team", title: "All members", line: count(others, "person", "people") + " on " + team.computer },
    link,
  ];
}

/** The people who can be picked for a space: everyone on the team but its maker, each with what they hold now. */
export function pickRows(people: Person[], space: Pick<SpaceSummary, "by" | "people">, me: string): { id: string; name: string; initials: string; can: "view" | "edit" | null }[] {
  return people
    .filter((person) => person.id !== space.by.id && person.id !== me)
    .map((person) => ({ id: person.id, name: person.name, initials: initials(person.name), can: space.people?.find((one) => one.id === person.id)?.can ?? null }));
}

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** What `link.spaces.share` is sent when a pick changes: the picked people, each to view or to edit. */
export function withPick(space: Pick<SpaceSummary, "people">, id: string, can: "view" | "edit" | null): SpaceShareInput {
  const kept = (space.people ?? []).filter((person) => person.id !== id).map((person) => ({ id: person.id, can: person.can }));
  return { access: "members", grants: can ? [...kept, { id, can }] : kept };
}

export const NOTIFY: { value: SpaceNotify; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Once a day" },
  { value: "all", label: "Every change" },
];

/** What the sheet says about a link that is not out. */
export const linkNote = (space: Pick<SpaceSummary, "linkState">) => (space.linkState === "leaving" ? "Taking the link back…" : space.linkState === "off" ? "Links are off while the relay is off." : undefined);

// ── New panel ───────────────────────────────────────────────────────────────

export const STARTS: { value: PanelStart; label: string }[] = [
  { value: "checklist", label: "Checklist" },
  { value: "tracker", label: "Tracker" },
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
  { value: "notes", label: "Notes" },
  { value: "app", label: "App" },
];

/** How often a new panel refreshes, as the sheet offers it. `cron` is what the computer is sent. */
export const REFRESH: { value: string; label: string; cron?: string }[] = [
  { value: "never", label: "Never" },
  { value: "hourly", label: "Every hour", cron: "0 * * * *" },
  { value: "morning", label: "Every morning", cron: "0 9 * * *" },
  { value: "weekdays", label: "Weekday mornings", cron: "0 9 * * 1-5" },
  { value: "weekly", label: "Every Monday", cron: "0 9 * * 1" },
];

/**
 * The new panel's project, for the owner's "Project" row: what the person picked (null is "None"),
 * else the space's own project when the space has one. A project that is gone counts as none.
 */
export function panelProject(picked: string | null | undefined, space: Pick<SpaceSummary, "projectId"> | undefined, projects: { id: string }[] | undefined): string | undefined {
  const id = picked === undefined ? space?.projectId : (picked ?? undefined);
  return id && projects?.some((project) => project.id === id) ? id : undefined;
}

// ── Asks under an opened panel ──────────────────────────────────────────────

export const ASKS_MAX = 3;
export const ASK_LENGTH = 60;

/**
 * What a panel's bot says is worth asking next, as chips: its own words, each on one line, at most
 * three of at most 60 characters. Empty when the bot gave none: the app never makes any up.
 */
export function asksOf(panel: { asks?: unknown } | undefined): string[] {
  if (!Array.isArray(panel?.asks)) return [];
  return panel.asks
    .flatMap((ask: unknown) => (typeof ask === "string" ? [ask.replace(/\s+/g, " ").trim().slice(0, ASK_LENGTH).trim()] : []))
    .filter(Boolean)
    .slice(0, ASKS_MAX);
}

/** The last line of a panel: "Maya ticked Press kit · 2m", or "Maya changed this · 2m" without a label. */
export function lastLine(last: PanelView["last"], ago: (time: number) => string): string | undefined {
  if (!last) return undefined;
  const label = last.label?.trim();
  return first(last.name) + " " + (label ? label[0]!.toLowerCase() + label.slice(1) : "changed this") + " · " + ago(last.at);
}

/** Panels laid out for a phone: small ones two up, wide and tall ones a row of their own. */
export function panelRows<P extends Pick<PanelView, "size">>(panels: P[]): P[][] {
  const rows: P[][] = [];
  let pair: P[] = [];
  for (const panel of panels) {
    if (panel.size !== "small") {
      if (pair.length) rows.push(pair);
      pair = [];
      rows.push([panel]);
    } else {
      pair.push(panel);
      if (pair.length === 2) {
        rows.push(pair);
        pair = [];
      }
    }
  }
  if (pair.length) rows.push(pair);
  return rows;
}
