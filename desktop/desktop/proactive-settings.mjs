// The Proactive agent's settings, checked whole. No imports, so preferences.mjs can use them.
//
// Two levels. `settings.proactive` is `{ enabled, bots }`: `enabled` is the computer's switch (the feature is
// on or off for this computer, the owner's alone), and `bots` holds each proactive bot's own settings by
// bot id. A bot's entry is its settings plus `person`: who its agent works for ("owner", or a team member's
// id). It is set when the agent is first set up and never taken from a caller.

export const WATCHES = ["runs", "tasks", "requests"];
export const EVERY = [15, 30, 60, 120];
export const SWEEP_HOURS = [0, 1, 2, 3, 6, 12];
export const MAX_PER_DAY = [3, 6, 10, 20];
export const PROACTIVE_DELIVER = ["chat", "feed"];

/** The computer's switch, and the bots that have settings. Off until the owner turns it on. */
export const defaultProactive = { enabled: false, bots: {} };

/** A bot's own settings before anyone has changed them. */
export const defaultBotProactive = {
  enabled: false,
  every: 30,
  sweepHours: 3,
  maxPerDay: 6,
  deliver: "chat",
  watch: [...WATCHES],
  instructions: "",
};

const pick = (list, value, what) => {
  if (!list.includes(value)) throw new Error("Choose " + what + ": " + list.join(", ") + ".");
  return value;
};
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** The computer's switch checked whole. `current` is what it was; the bots' own settings are not changed here. */
export function proactiveField(value, current = defaultProactive) {
  if (!plain(value)) throw new Error("Invalid Proactive agent setting");
  const unknown = Object.keys(value).find((key) => key !== "enabled");
  if (unknown) throw new Error("Unknown Proactive agent setting: " + unknown + ". A bot's own settings are changed on its profile.");
  const enabled = value.enabled ?? current.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("Choose on or off");
  return { enabled, bots: plain(current.bots) ? current.bots : {} };
}

/** One bot's settings checked whole. `current` is what they were; a patch changes only what it names. */
export function botProactiveField(value, current = defaultBotProactive) {
  if (!plain(value)) throw new Error("Invalid Proactive agent setting");
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(defaultBotProactive, key));
  if (unknown) throw new Error("Unknown Proactive agent setting: " + unknown);
  const next = { ...defaultBotProactive, ...current, ...value };
  if (typeof next.enabled !== "boolean") throw new Error("Choose on or off");
  if (!Array.isArray(next.watch) || next.watch.some((w) => !WATCHES.includes(w))) throw new Error("Watch any of: " + WATCHES.join(", ") + ".");
  if (typeof next.instructions !== "string" || next.instructions.length > 2000) throw new Error("Use up to 2,000 characters for the Proactive agent's instructions.");
  return {
    enabled: next.enabled,
    every: pick(EVERY, next.every, "how often it checks, in minutes"),
    sweepHours: pick(SWEEP_HOURS, next.sweepHours, "how often it looks around, in hours (0 for never)"),
    maxPerDay: pick(MAX_PER_DAY, next.maxPerDay, "the most alerts a day"),
    deliver: pick(PROACTIVE_DELIVER, next.deliver, "where alerts go"),
    watch: [...new Set(next.watch)],
    instructions: next.instructions.trim(),
  };
}

/** A saved bot entry made whole, or null when it is not one. A value that is no longer valid is the usual one. */
function savedBot(entry) {
  if (!plain(entry)) return null;
  const { person, ...own } = entry;
  const fields = {};
  for (const [key, value] of Object.entries(own)) {
    if (!Object.hasOwn(defaultBotProactive, key)) continue;
    try {
      fields[key] = botProactiveField({ [key]: value }, defaultBotProactive)[key];
    } catch {
      // Kept at its usual value.
    }
  }
  return { ...botProactiveField(fields, defaultBotProactive), person: typeof person === "string" && person ? person.slice(0, 200) : "owner" };
}

/**
 * The settings and the state of the Proactive agent as saved, brought to the current shape. Before bots
 * had their own, one bot was the agent: `settings.proactive` held `{ enabled, botId, every, … }` and the
 * state `{ chatId, seen, … }`. That bot is now a proactive bot with the same settings, its routine
 * (`chatId`) and gate state kept, and the computer's switch carries the old `enabled`. A shape that can't
 * be read gives the usual one. Pure, and the same shape in gives the same shape out.
 */
export function migrateProactive(saved, state) {
  const old = plain(saved) ? saved : {};
  const gate = plain(state) ? state : {};
  const bots = {};
  const gates = {};
  if (plain(old.bots)) {
    for (const [id, entry] of Object.entries(old.bots)) {
      const kept = savedBot(entry);
      if (kept) bots[id] = kept;
    }
    for (const [id, held] of Object.entries(plain(gate.bots) ? gate.bots : {})) if (plain(held)) gates[id] = held;
  } else if (typeof old.botId === "string" && old.botId) {
    // The bot that was the agent: its settings were the whole of `old`, and its state the whole of `gate`.
    const { enabled: _on, botId: _bot, ...rest } = old;
    bots[old.botId] = { ...savedBot({ ...rest, enabled: old.enabled === true }) };
    const { botId: _drop, bots: _none, ...held } = gate;
    if (Object.keys(held).length) gates[old.botId] = held;
  }
  return { settings: { enabled: old.enabled === true, bots }, state: { bots: gates } };
}
