// Alerts about spaces ("spaces-v1"; docs/spaces.md, "Notifications"). The app says what happened
// with one host-side call (`link.spaceEvent`); this module picks who is told and writes the words.
//
//   A note from another person goes right away to everyone who can open the space and has not set
//   "Notify me" to Off.
//   A change another person made goes right away to those who chose "Every change", at most once in
//   ten minutes for each space and person.
//   Once a day, at 8:00 in this computer's time zone, a person is told what changed in their spaces
//   since they last opened them (or since the last such alert), in one alert.
//
// Nobody is told of their own change, of a space they are looking at now, or of a space their
// device is not shown. Each alert is sealed for one phone, as every alert is (push.mjs), and names
// the space and the panel so a tap opens there. Nothing a person wrote is kept here.
import { OWNER, spaceNews } from "./team.mjs";

export const SPACE_ALERTS = {
  /** "Every change": at most one alert for each space and person in this long. */
  throttleMs: 10 * 60_000,
  /** The once-a-day alert is sent from this hour until noon, in the computer's time zone. A computer that wakes later waits for the next day. */
  hour: 8,
  until: 12,
  /** How often the day's alert is looked for. */
  everyMs: 5 * 60_000,
  text: 180,
  label: 80,
  /** How many names a line lists before "and 2 more". */
  names: 2,
};

const first = (name) => String(name ?? "").trim().split(/\s+/)[0] || "Someone";
const count = (n, one, many) => n + " " + (n === 1 ? one : many);
/** One line of what a person wrote, with no Markdown marks, cut for a banner. */
const line = (text, max = SPACE_ALERTS.text) => {
  const found = String(text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const plain = (found ?? "").replace(/^#{1,6}\s+/, "").replace(/[*_`~]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
};
/** "Signups", "Signups and Runway", "Signups, Runway and 2 more". */
const listed = (names, total = names.length) => {
  const shown = names.slice(0, SPACE_ALERTS.names);
  const more = total - shown.length;
  if (more > 0) return shown.join(", ") + " and " + more + " more";
  return shown.length <= 1 ? (shown[0] ?? "") : shown.slice(0, -1).join(", ") + " and " + shown.at(-1);
};

/** A space's name as this person reads it: another person's built-in space says whose it is ("Maya's Today"). */
export const spaceName = (space) => (space.builtin && !space.mine && space.by?.name ? first(space.by.name) + "'s " + space.name : space.name);

/** What the app may say happened, cut to its shape, or null. */
export function cleanSpaceEvent(event) {
  const text = (value, max) => (typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0") ? value : null);
  if (!event || typeof event !== "object") return null;
  const spaceId = text(event.spaceId, 200);
  const by = text(event.by, 200);
  if (!spaceId || !by || (event.kind !== "note" && event.kind !== "change")) return null;
  const panelId = text(event.panelId, 200);
  return {
    spaceId,
    by,
    kind: event.kind,
    ...(panelId && { panelId }),
    ...(typeof event.text === "string" && event.text.trim() && { text: event.text.slice(0, 4_000) }),
    ...(typeof event.label === "string" && event.label.trim() && { label: event.label.replace(/\s+/g, " ").trim().slice(0, SPACE_ALERTS.label) }),
  };
}

/**
 * A note or a change, as an alert for one person. `previews` off keeps what was written out of it:
 * the title still says who and where.
 */
export function eventAlert(event, space, byName, panelTitle, previews = true) {
  const t = (first(byName) + " in " + spaceName(space)).slice(0, 80);
  if (event.kind === "note") return { t, m: previews ? line(event.text) || "Wrote a note." : "Wrote a note." };
  const label = event.label ? event.label[0].toUpperCase() + event.label.slice(1) : "";
  return { t, m: previews && label ? label : panelTitle && previews ? "Changed " + line(panelTitle, 80) : "Changed a panel." };
}

/**
 * The once-a-day alert for one person. `news` is `{ space, titles, cards }[]`: each space that
 * changed, the titles of what changed in it, and whether those are cards (Feed, Ideas, Goals) and
 * not panels. One space: its name, and "3 panels changed overnight: Signups, Runway and 1 more."
 * Several: "Spaces", and "Launch and Money changed overnight."
 */
export function digestAlert(news, previews = true) {
  if (!news.length) return null;
  if (news.length > 1) return { t: "Spaces", m: previews ? listed(news.map((one) => spaceName(one.space))) + " changed overnight." : count(news.length, "space", "spaces") + " changed overnight." };
  const [{ space, titles, total = titles.length, cards }] = news;
  const what = cards ? count(total, "card", "cards") : count(total, "panel", "panels");
  const named = titles.map((title) => line(title, 40)).filter(Boolean);
  return { t: spaceName(space).slice(0, 80), m: what + " changed overnight" + (previews && named.length ? ": " + listed(named, total) + "." : ".") };
}

/** The day of a time in this computer's own time zone, as "2026-11-21", and its hour. */
const localDay = (time) => {
  const date = new Date(time);
  const two = (n) => String(n).padStart(2, "0");
  return { day: date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate()), hour: date.getHours() };
};

export class SpaceAlerts {
  /**
   * @param spaces    the link's Spaces (who can open what, each person's "Notify me", who is looking)
   * @param team      () => the team, as saved; setTeam(team) saves it (the day of the last daily alert is kept there)
   * @param devices   () => the paired devices
   * @param shown     (device) => the spaces that device is shown, as `SpaceSummary[]` (an owner device with Admin mode off is shown fewer)
   * @param context   (person) => what `spaceView` needs for that person (their role, the names)
   * @param records   () => the app's spaces with their items, or null
   * @param titles    () => (item id) => a panel's or a card's title
   * @param itemBot   optional () => (item id) => botId for a panel or card
   * @param names     () => person id → name
   * @param wants     (device, botId?) => whether that device's notifications are on and its "Spaces" choice (and per-bot filter) allows it
   * @param previews  (device) => whether that device shows what was written
   * @param send      (device, content) => sends one sealed alert
   */
  constructor({ spaces, team, setTeam, devices, shown, context, records, titles, itemBot, names, wants, previews, send, now = Date.now }) {
    Object.assign(this, { spaces, team, setTeam, devices, shown, context, records, titles, itemBot, names, wants, previews, send, now });
    this.last = new Map(); // "person:space" → when an "Every change" alert last went
    this.timer = null;
  }

  /**
   * The app says a person wrote a note or changed a panel. Answers how many alerts were sent.
   * Nothing goes to the person who did it, to someone looking at the space now, to someone whose
   * "Notify me" does not ask for it, or to a device that is not shown the space.
   */
  event(input) {
    const event = cleanSpaceEvent(input);
    if (!event || !this.spaces.on) return 0;
    const looking = new Set((this.spaces.here().get(event.spaceId) ?? []).map((one) => one.id));
    const byName = this.names().get(event.by) ?? "";
    const panelTitle = event.panelId ? this.titles()(event.panelId) : undefined;
    const panelBotId = event.panelId && this.itemBot ? this.itemBot()(event.panelId) : null;
    const now = this.now();
    const told = new Set();
    let sent = 0;
    for (const device of this.devices()) {
      const person = device.memberId ?? OWNER;
      if (person === event.by || looking.has(person) || !this.wants(device, panelBotId)) continue;
      const space = this.shown(device).find((one) => one.id === event.spaceId);
      if (!space || space.notify === "off" || (event.kind === "change" && space.notify !== "all")) continue;
      const key = person + ":" + event.spaceId;
      // One alert in ten minutes for each space and person; a person's several phones each get that one.
      if (event.kind === "change" && !told.has(key) && now - (this.last.get(key) ?? 0) < SPACE_ALERTS.throttleMs) continue;
      told.add(key);
      const content = eventAlert(event, space, byName, panelTitle, this.previews(device));
      if (this.send(device, { ...content, k: "space", s: event.spaceId, ...(event.panelId && { p: event.panelId }) })) sent++;
    }
    if (event.kind === "change") for (const key of told) this.last.set(key, now);
    return sent;
  }

  /**
   * The once-a-day alert, when its time has come: from 8:00 until noon in this computer's time
   * zone, once for each day. What it tells of is what changed since each person last opened a
   * space, or since the last such alert. Answers how many alerts were sent.
   */
  daily() {
    if (!this.spaces.on) return 0;
    const now = this.now();
    const { day, hour } = localDay(now);
    const team = this.team();
    const before = team.spaceDigest;
    // The first look only notes the time. Without it, the first morning would tell everyone that
    // every space they never opened "changed overnight".
    if (!before) {
      this.setTeam({ ...team, spaceDigest: { day: "", at: now } });
      return 0;
    }
    if (hour < SPACE_ALERTS.hour || hour >= SPACE_ALERTS.until || before.day === day) return 0;
    const records = this.records();
    if (!records) return 0;
    const titleOf = this.titles();
    const botOf = this.itemBot ? this.itemBot() : null;
    const since = Number(before.at) || 0;
    const here = this.spaces.here();
    const byPerson = new Map();
    let sent = 0;
    for (const device of this.devices()) {
      const person = device.memberId ?? OWNER;
      if (!this.wants(device)) continue;
      if (!byPerson.has(person)) byPerson.set(person, spaceNews(team, records, person, this.context(person), since));
      const shown = new Set(this.shown(device).map((space) => space.id));
      const news = byPerson
        .get(person)
        .filter(({ space }) => shown.has(space.id) && !(here.get(space.id) ?? []).some((one) => one.id === person))
        .map(({ space, items }) => {
          const kept = botOf ? items.filter((id) => this.wants(device, botOf(id))) : items;
          return { space, total: kept.length, titles: kept.map((id) => titleOf(id)).filter(Boolean), cards: !!space.builtin && space.builtin !== "today" };
        })
        .filter((entry) => entry.total > 0);
      const content = digestAlert(news, this.previews(device));
      if (!content) continue;
      // One space: a tap opens it. Several: the list of spaces.
      if (this.send(device, { ...content, k: "space", ...(news.length === 1 && { s: news[0].space.id }) })) sent++;
    }
    // The day is marked whether or not anything was sent: tomorrow's alert tells of what changes from now.
    this.setTeam({ ...this.team(), spaceDigest: { day, at: now } });
    return sent;
  }

  start() {
    if (this.timer) return;
    const look = () => {
      try {
        this.daily();
      } catch {
        // A day's alert that failed is tried again at the next look.
      }
    };
    this.timer = setInterval(look, SPACE_ALERTS.everyMs);
    this.timer.unref?.();
    look();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
