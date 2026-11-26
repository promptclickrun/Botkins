// How many Task Board tasks may run at once (desktop/tasks.mjs, tick): on the whole computer, and for each bot.
// Precedence for each limit: the person's setting (Settings › General › Tasks, `botkins preferences set tasksMax`),
// else the environment variable (for a headless host), else the built-in default. A setting that is cleared
// (null, or "default" on the command line) falls back to the environment again.
export const TASK_LIMITS = {
  tasksMax: { min: 1, max: 16, fallback: 2, env: "BOTKINS_TASKS_MAX", what: "tasks at once" },
  tasksPerBot: { min: 1, max: 8, fallback: 1, env: "BOTKINS_TASKS_PER_BOT", what: "tasks at once for each bot" },
};

/** A setting's value as saved: a whole number in its range, or null to clear it. Anything else is refused. */
export function taskLimitField(key, value) {
  const spec = TASK_LIMITS[key];
  if (value === null) return null;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) throw new Error("Choose " + spec.min + " to " + spec.max + " " + spec.what + ".");
  return value;
}

/** An environment value clamped to its range, or null when it is not a whole number. */
function fromEnv(spec, env) {
  const raw = env?.[spec.env];
  if (typeof raw !== "string" || !/^\s*-?\d{1,4}\s*$/.test(raw)) return null;
  return Math.min(spec.max, Math.max(spec.min, Number(raw)));
}

/**
 * The limits in force: { tasksMax, tasksPerBot, defaults: { tasksMax, tasksPerBot } }. `defaults` is what
 * each limit is without the person's setting (the environment's, else the built-in one).
 */
export function taskLimits(settings, env = process.env) {
  const out = { defaults: {} };
  for (const [key, spec] of Object.entries(TASK_LIMITS)) {
    const fallback = fromEnv(spec, env) ?? spec.fallback;
    const saved = settings?.[key];
    out.defaults[key] = fallback;
    out[key] = Number.isInteger(saved) && saved >= spec.min && saved <= spec.max ? saved : fallback;
  }
  return out;
}
