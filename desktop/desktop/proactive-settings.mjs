// The Proactive agent's settings, checked whole. No imports, so preferences.mjs can use them.
//
// Two levels. `settings.proactive` is `{ enabled, bots }`: `enabled` is the computer's switch (the feature is
// on or off for this computer, the owner's alone), and `bots` holds each proactive bot's own settings by
// bot id. A bot's entry is shared by everyone it looks out for: how often it checks, what it watches, its
// rules, and `setUp` (its setup steps were finished, so it may use the model). `people` says who it looks
// out for: `{ [personId | "owner"]: { on, notify } }`. `on` is that person's own check; `notify: false`
// delivers their alerts with no notification on the computer or on a phone.

export const WATCHES = ["runs", "tasks", "requests", "context"];
export const EVERY = [15, 30, 60, 120];
export const SWEEP_HOURS = [0, 1, 2, 3, 6, 12];
export const MAX_PER_DAY = [3, 6, 10, 20];
export const PROACTIVE_DELIVER = ["chat", "feed"];
export const OWNER = "owner";
/** The most people one bot looks out for: the owner and a whole team (desktop/link/TEAMS.md, "Limits"). */
export const MAX_PEOPLE = 61;
/** One person's entry before anyone has changed it. */
export const defaultPerson = { on: true, notify: true };

/** The computer's switch, and the bots that have settings. On from the start: a bot still does nothing until it is set up. */
export const defaultProactive = { enabled: true, bots: {} };

/** A bot's own settings before anyone has changed them. */
export const defaultBotProactive = {
  enabled: false,
  // Its setup steps were finished. Until then the bot's agent never wakes, whatever its switches say.
  setUp: false,
  every: 30,
  sweepHours: 3,
  maxPerDay: 6,
  deliver: "chat",
  watch: [...WATCHES],
  instructions: "",
  people: {},
};

const pick = (list, value, what) => {
  if (!list.includes(value)) throw new Error("Choose " + what + ": " + list.join(", ") + ".");
  return value;
};
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const botField = (key) => key === "pausedBy" || Object.hasOwn(defaultBotProactive, key);

/** The computer's switch checked whole. `current` is what it was; the bots' own settings are not changed here. */
export function proactiveField(value, current = defaultProactive) {
  if (!plain(value)) throw new Error("Invalid Proactive agent setting");
  const unknown = Object.keys(value).find((key) => key !== "enabled");
  if (unknown) throw new Error("Unknown Proactive agent setting: " + unknown + ". A bot's own settings are changed on its profile.");
  const enabled = value.enabled ?? current.enabled ?? defaultProactive.enabled;
  if (typeof enabled !== "boolean") throw new Error("Choose on or off");
  return { enabled, bots: plain(current.bots) ? current.bots : {} };
}

/**
 * The people a bot looks out for, checked whole. In a patch an entry changes only what it names, a new
 * person starts on and notified, and `null` takes a person out. Who may name whom is the caller's to
 * check (desktop/proactive.mjs): this only says the shape is right.
 */
export function peopleField(value, current = {}) {
  if (!plain(value)) throw new Error("Choose who this bot looks out for.");
  const next = {};
  for (const [id, entry] of Object.entries(plain(current) ? current : {})) if (plain(entry)) next[id] = { on: entry.on === true, notify: entry.notify !== false };
  for (const [id, entry] of Object.entries(value)) {
    if (!id || id.length > 200) throw new Error("Unknown person");
    if (entry === null) {
      delete next[id];
      continue;
    }
    if (!plain(entry)) throw new Error("Choose on or off for each person.");
    const unknown = Object.keys(entry).find((key) => key !== "on" && key !== "notify");
    if (unknown) throw new Error("Unknown setting for a person: " + unknown);
    const merged = { ...defaultPerson, ...next[id], ...entry };
    if (typeof merged.on !== "boolean" || typeof merged.notify !== "boolean") throw new Error("Choose on or off for each person.");
    next[id] = { on: merged.on, notify: merged.notify };
  }
  if (Object.keys(next).length > MAX_PEOPLE) throw new Error("A bot looks out for up to " + MAX_PEOPLE + " people.");
  return next;
}

/** One bot's settings checked whole. `current` is what they were; a patch changes only what it names. */
export function botProactiveField(value, current = defaultBotProactive) {
  if (!plain(value)) throw new Error("Invalid Proactive agent setting");
  const unknown = Object.keys(value).find((key) => !botField(key));
  if (unknown) throw new Error("Unknown Proactive agent setting: " + unknown);
  const next = { ...defaultBotProactive, ...current, ...value };
  if (typeof next.enabled !== "boolean" || typeof next.setUp !== "boolean") throw new Error("Choose on or off");
  if (next.pausedBy !== undefined && next.pausedBy !== OWNER) throw new Error("Only the owner can pause this bot's Proactive agent.");
  if (!Array.isArray(next.watch) || next.watch.some((w) => !WATCHES.includes(w))) throw new Error("Watch any of: " + WATCHES.join(", ") + ".");
  if (typeof next.instructions !== "string" || next.instructions.length > 2000) throw new Error("Use up to 2,000 characters for the Proactive agent's instructions.");
  return {
    enabled: next.enabled,
    ...(!next.enabled && next.pausedBy === OWNER && { pausedBy: OWNER }),
    setUp: next.setUp,
    every: pick(EVERY, next.every, "how often it checks, in minutes"),
    sweepHours: pick(SWEEP_HOURS, next.sweepHours, "how often it looks around, in hours (0 for never)"),
    maxPerDay: pick(MAX_PER_DAY, next.maxPerDay, "the most alerts a day"),
    deliver: pick(PROACTIVE_DELIVER, next.deliver, "where alerts go"),
    watch: [...new Set(next.watch)],
    instructions: next.instructions.trim(),
    people: peopleField(Object.hasOwn(value, "people") ? value.people : {}, current.people),
  };
}

/** A saved bot entry made whole, or null when it is not one. A value that is no longer valid is the usual one. */
function savedBot(entry) {
  if (!plain(entry)) return null;
  const fields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!botField(key)) continue;
    try {
      fields[key] = botProactiveField({ [key]: value }, defaultBotProactive)[key];
    } catch {
      // Kept at its usual value.
    }
  }
  return botProactiveField(fields, defaultBotProactive);
}

/** The shape this file writes. Shape 3 had several people but still kept each person's snoozes on each bot. */
export const PROACTIVE_SHAPE = 4;

function migrateSnoozes(gates, saved) {
  const snoozed = Object.fromEntries(Object.entries(plain(saved) ? saved : {}).filter(([, keys]) => plain(keys)).map(([person, keys]) => [person, { ...keys }]));
  for (const bot of Object.values(gates)) {
    for (const [person, held] of Object.entries(bot.people)) {
      if (!plain(held.snoozed)) continue;
      const { snoozed: old, ...own } = held;
      bot.people[person] = own;
      for (const [key, until] of Object.entries(old)) {
        if (!Number.isFinite(until)) continue;
        const keys = Object.hasOwn(snoozed, person) ? snoozed[person] : (snoozed[person] = {});
        keys[key] = Math.max(keys[key] ?? 0, until);
      }
    }
  }
  return snoozed;
}

/**
 * The settings and the state of the Proactive agent as saved, brought to the current shape. Pure, and the
 * current shape in gives the same shape out. A shape that can't be read gives the usual one.
 *
 * - First, one bot was the agent: `settings.proactive` held `{ enabled, botId, every, … }` and the state
 *   `{ chatId, seen, … }`. That bot became a proactive bot with the same settings, routine and gate state.
 * - Then each bot's agent worked for one `person`. Now it looks out for several: that person becomes
 *   `people = { [person]: { on: <the bot's old switch>, notify: true } }`, and their gate state moves under
 *   `people` too. The computer's switch becomes on for everyone. So that nothing starts to use the model by
 *   surprise, only a bot that was really running (the old switch on and the bot on) counts as set up; a bot
 *   that was on while the switch was off waits for its setup steps.
 *
 * The state carries `shape`, so this happens once: afterwards the owner's own Off is kept.
 */
export function migrateProactive(saved, state) {
  const old = plain(saved) ? saved : {};
  const gate = plain(state) ? state : {};
  if (gate.shape === 3 || gate.shape === PROACTIVE_SHAPE) {
    const bots = {};
    for (const [id, entry] of Object.entries(plain(old.bots) ? old.bots : {})) {
      const kept = savedBot(entry);
      if (kept) bots[id] = { ...kept, ...(gate.shape === 3 && entry.enabled === false && { pausedBy: OWNER }) };
    }
    const gates = {};
    for (const [id, held] of Object.entries(plain(gate.bots) ? gate.bots : {})) {
      if (!plain(held)) continue;
      gates[id] = { people: Object.fromEntries(Object.entries(plain(held.people) ? held.people : {}).filter(([, own]) => plain(own))) };
    }
    return {
      settings: { enabled: old.enabled !== false, bots },
      state: {
        shape: PROACTIVE_SHAPE, bots: gates,
        ...(Array.isArray(gate.newChatPeople) && { newChatPeople: [...new Set(gate.newChatPeople.filter(id => typeof id === "string"))] }),
        reminders: plain(gate.reminders) ? gate.reminders : {},
        snoozed: migrateSnoozes(gates, gate.snoozed),
      },
    };
  }
  // Before: one entry per bot, each with the one `person` it worked for.
  const before = {};
  const gatesBefore = {};
  if (plain(old.bots)) {
    for (const [id, entry] of Object.entries(old.bots)) if (plain(entry)) before[id] = entry;
    for (const [id, held] of Object.entries(plain(gate.bots) ? gate.bots : {})) if (plain(held)) gatesBefore[id] = held;
  } else if (typeof old.botId === "string" && old.botId) {
    // The bot that was the agent: its settings were the whole of `old`, and its state the whole of `gate`.
    const { enabled: _on, botId: _bot, ...rest } = old;
    before[old.botId] = { ...rest, enabled: old.enabled === true };
    const { botId: _drop, bots: _none, ...held } = gate;
    if (Object.keys(held).length) gatesBefore[old.botId] = held;
  }
  const wasOn = old.enabled === true;
  const bots = {};
  const gates = {};
  for (const [id, entry] of Object.entries(before)) {
    const person = typeof entry.person === "string" && entry.person ? entry.person.slice(0, 200) : OWNER;
    const { people: _people, setUp: _setUp, person: _person, ...own } = entry;
    const kept = savedBot(own);
    bots[id] = { ...kept, ...(entry.enabled === false && { pausedBy: OWNER }), setUp: wasOn && kept.enabled, people: { [person]: { on: kept.enabled, notify: true } } };
    if (gatesBefore[id]) gates[id] = { people: { [person]: gatesBefore[id] } };
  }
  return { settings: { enabled: true, bots }, state: { shape: PROACTIVE_SHAPE, bots: gates, reminders: {}, snoozed: migrateSnoozes(gates) } };
}
