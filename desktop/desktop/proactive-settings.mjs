// The Proactive agent's setting (settings.proactive), checked whole. No imports, so preferences.mjs can use it.

export const WATCHES = ["runs", "tasks", "requests"];
export const EVERY = [15, 30, 60, 120];
export const SWEEP_HOURS = [0, 1, 2, 3, 6, 12];
export const MAX_PER_DAY = [3, 6, 10, 20];
export const PROACTIVE_DELIVER = ["chat", "feed"];

export const defaultProactive = {
  enabled: false,
  botId: null,
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

/** The setting checked whole. `current` is what it was; a patch changes only what it names. */
export function proactiveField(value, current = defaultProactive) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Proactive agent setting");
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(defaultProactive, key));
  if (unknown) throw new Error("Unknown Proactive agent setting: " + unknown);
  const next = { ...defaultProactive, ...current, ...value };
  if (typeof next.enabled !== "boolean") throw new Error("Choose on or off");
  if (next.botId !== null && (typeof next.botId !== "string" || !next.botId || next.botId.length > 80)) throw new Error("Choose a bot");
  if (next.enabled && !next.botId) throw new Error("Choose the bot that is the Proactive agent.");
  if (!Array.isArray(next.watch) || next.watch.some((w) => !WATCHES.includes(w))) throw new Error("Watch any of: " + WATCHES.join(", ") + ".");
  if (typeof next.instructions !== "string" || next.instructions.length > 2000) throw new Error("Use up to 2,000 characters for the Proactive agent's instructions.");
  return {
    enabled: next.enabled,
    botId: next.botId,
    every: pick(EVERY, next.every, "how often it checks, in minutes"),
    sweepHours: pick(SWEEP_HOURS, next.sweepHours, "how often it looks around, in hours (0 for never)"),
    maxPerDay: pick(MAX_PER_DAY, next.maxPerDay, "the most alerts a day"),
    deliver: pick(PROACTIVE_DELIVER, next.deliver, "where alerts go"),
    watch: [...new Set(next.watch)],
    instructions: next.instructions.trim(),
  };
}
