// A bot's Proactive agent ("proactive-agent-v2"), as the phone reads and words it. The computer sends each agent's
// settings in the `proactive` part; what it sends is read tolerantly: a field it leaves out or a value this phone
// doesn't know is the usual one, never a crash. The same words are on the computer (desktop/src/BotProactive.tsx).
import type { ProactiveBot, ProactiveBotSettings, ProactiveLog, ProactivePart, ProactiveWatch } from "@/link/types";

export const PROACTIVE_CAPABILITY = "proactive-agent-v2";
export const EVERY = [15, 30, 60, 120];
export const SWEEP = [0, 1, 2, 3, 6, 12];
export const CAP = [3, 6, 10, 20];
export const WATCHES: { id: ProactiveWatch; title: string; subtitle: string }[] = [
  { id: "context", title: "Personal context", subtitle: "Wake when goals, memories or your conversations with this bot change." },
  { id: "runs", title: "Failed routines and tasks", subtitle: "A run that ended needing you" },
  { id: "tasks", title: "Tasks waiting on you", subtitle: "In Review or Blocked over four hours" },
  { id: "requests", title: "Unanswered requests", subtitle: "Open for more than 15 minutes" },
];
export const OUTCOME = { alerted: "Told you", silent: "Nothing to say", failed: "Failed" } as const;
export const REASON = { review: "Planned follow-up", context: "Personal context changed", signals: "Something changed", sweep: "Look around", check: "Check now" } as const;

export const USUAL: ProactiveBotSettings = { enabled: false, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests", "context"], instructions: "" };

export const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));

const count = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** A bot's agent as it is set, with the usual settings for anything the computer left out or sent in a shape this phone doesn't know. */
export function proactiveOf(entry?: ProactiveBot): ProactiveBotSettings & ProactiveBot {
  const watch = Array.isArray(entry?.watch) ? entry.watch.filter((item): item is ProactiveWatch => WATCHES.some((known) => known.id === item)) : USUAL.watch;
  return {
    ...entry,
    enabled: entry?.enabled === true,
    every: count(entry?.every, USUAL.every),
    sweepHours: count(entry?.sweepHours, USUAL.sweepHours),
    maxPerDay: count(entry?.maxPerDay, USUAL.maxPerDay),
    deliver: entry?.deliver === "feed" ? "feed" : "chat",
    watch,
    instructions: typeof entry?.instructions === "string" ? entry.instructions : "",
  };
}

/** What a person may change of an agent: not one another person set up, and as a member neither look-around nor tasks. */
export function proactiveRules(entry: ProactiveBot | undefined, member: boolean, learning = true) {
  const memberAgent = member || (!!entry?.person && entry.person !== "owner");
  return {
    taken: entry?.taken === true,
    lookAround: !memberAgent,
    watches: WATCHES.filter((watch) => (learning || watch.id !== "context") && (!memberAgent || watch.id !== "tasks")),
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
