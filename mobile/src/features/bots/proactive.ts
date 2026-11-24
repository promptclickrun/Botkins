// A bot's Proactive agent ("proactive-agent-v2", and "proactive-team-v1" for several people), as the phone reads and
// words it. The computer sends each agent's settings in the `proactive` part; what it sends is read tolerantly: a
// field it leaves out or a value this phone doesn't know is the usual one, never a crash. The setup steps, their
// words and an alert's actions are in link-host/proactive-words.mjs, which the app on the computer reads too
// (desktop/src/BotProactive.tsx), so both say the same.
import type { ProactiveBot, ProactiveBotSettings, ProactiveLog, ProactivePart, ProactivePerson, ProactiveWatch } from "@/link/types";
import type { ProactiveViewer } from "../../../link-host/proactive-words.mjs";

export { ALERT, personLine, proactiveStanding, WIZARD, WIZARD_STEPS, wizardPatch, wizardPeople, wizardReady, wizardStart } from "../../../link-host/proactive-words.mjs";
export type { ProactiveViewer, WizardDraft, WizardPerson, WizardStep } from "../../../link-host/proactive-words.mjs";

export const PROACTIVE_CAPABILITY = "proactive-agent-v2";
/** One bot looks out for several people, waits for its setup steps, and an alert carries actions. */
export const PROACTIVE_TEAM = "proactive-team-v1";
export const EVERY = [15, 30, 60, 120];
export const SWEEP = [0, 1, 2, 3, 6, 12];
export const CAP = [3, 6, 10, 20];
export const WATCHES: { id: ProactiveWatch; title: string; subtitle: string }[] = [
  { id: "context", title: "Personal context", subtitle: "Wake when goals, memories or your conversations with this bot change." },
  { id: "runs", title: "Failed routines and stopped turns", subtitle: "A run that ended needing you, or stopped with steps left" },
  { id: "tasks", title: "Tasks waiting on you", subtitle: "In Review or Blocked over four hours" },
  { id: "requests", title: "Unanswered requests", subtitle: "Open for more than 15 minutes" },
];
export const OUTCOME = { alerted: "Told you", silent: "Nothing to say", failed: "Failed" } as const;
export const REASON = { review: "Planned follow-up", context: "Personal context changed", signals: "Something changed", sweep: "Look around", check: "Check now" } as const;

export const USUAL: ProactiveBotSettings = { enabled: false, setUp: false, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests", "context"], instructions: "", people: {} };

export const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));

const count = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** The people a bot looks out for, as sent: an entry in a shape this phone doesn't know is left out. */
export function peopleOf(entry?: ProactiveBot): Record<string, ProactivePerson> {
  const people = entry?.people;
  if (!people || typeof people !== "object" || Array.isArray(people)) return {};
  return Object.fromEntries(Object.entries(people).flatMap(([id, own]) => (own && typeof own === "object" ? [[id, { on: own.on === true, notify: own.notify !== false }]] : [])));
}

/** A bot's agent as it is set, with the usual settings for anything the computer left out or sent in a shape this phone doesn't know. */
export function proactiveOf(entry?: ProactiveBot): ProactiveBotSettings & ProactiveBot {
  const watch = Array.isArray(entry?.watch) ? entry.watch.filter((item): item is ProactiveWatch => WATCHES.some((known) => known.id === item)) : USUAL.watch;
  return {
    ...entry,
    enabled: entry?.enabled === true,
    setUp: entry?.setUp === true,
    every: count(entry?.every, USUAL.every),
    sweepHours: count(entry?.sweepHours, USUAL.sweepHours),
    maxPerDay: count(entry?.maxPerDay, USUAL.maxPerDay),
    deliver: entry?.deliver === "feed" ? "feed" : "chat",
    watch,
    instructions: typeof entry?.instructions === "string" ? entry.instructions : "",
    people: peopleOf(entry),
  };
}

/**
 * What the person looking may change of a bot's agent ("proactive-team-v1"). The owner: everything. A member whose role
 * manages the bot: what its people share, but neither look-around nor the tasks watch, and they may add themselves. Any
 * other member the bot looks out for: only their own alerts. The computer checks the same (link-host/proactive-rules.mjs).
 */
export function proactiveRules(entry: ProactiveBot | undefined, viewer: ProactiveViewer, learning = true) {
  const owner = viewer.id === "owner";
  const mine = peopleOf(entry)[viewer.id];
  return {
    owner,
    /** Their own entry, when the bot looks out for them. */
    mine,
    /** May run the setup steps and change what the people share. */
    shared: owner || viewer.manages,
    /** May turn the bot's own switch off, add other people and forget the settings. */
    all: owner,
    lookAround: owner,
    watches: WATCHES.filter((watch) => (learning || watch.id !== "context") && (owner || watch.id !== "tasks")),
    /** Has anything to do here at all. */
    any: owner || viewer.manages || !!mine,
  };
}

/** Whether an agent that is on waits because the computer's switch is off. */
export const isPaused = (part: ProactivePart | undefined, entry: ProactiveBot | undefined) => entry?.enabled === true && part?.enabled !== true;

/** The bots whose agent is on, in the order of `bots`, for the list in Settings › Experimental. */
export function proactiveBots<B extends { id: string }>(part: ProactivePart | undefined, bots: B[]): { bot: B; p: ReturnType<typeof proactiveOf> }[] {
  return bots.flatMap((bot) => {
    const entry = part?.bots?.[bot.id];
    return entry?.enabled === true ? [{ bot, p: proactiveOf(entry) }] : [];
  });
}

/** One line for a bot's row: how often it checks, and alerts so far today. */
export function proactiveSummary(p: ProactiveBotSettings & ProactiveBot): string {
  return "Every " + minutes(p.every) + (p.sweepHours ? ", looks around every " + minutes(p.sweepHours * 60) : "") + " · " + (p.pings ?? 0) + " of " + p.maxPerDay + " alerts today";
}

/** The log as the recent rows show it: newest first, at most `limit`, whatever shape the computer sent. */
export function recentLog(entry: ProactiveBot | undefined, limit = 8): ProactiveLog[] {
  return (Array.isArray(entry?.log) ? entry.log : []).filter((line) => line && typeof line.runId === "string" && typeof line.at === "number" && line.reason in REASON && line.outcome in OUTCOME).slice(0, limit);
}
