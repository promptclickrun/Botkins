// A bot's Proactive agent as both apps show it ("proactive-team-v1"): the setup steps, their words and what
// they save, and the words of an alert's actions. The phone app and the app on the computer both read this
// file, so the steps and the words are the same in both. Plain logic, no screen code.
import { OWNER, proactiveEligible } from "./proactive-rules.mjs";

export const PROACTIVE_TEAM = "proactive-team-v1";

/** The setup steps, in order. Each has a title and one short line. */
export const WIZARD_STEPS = ["people", "notify", "matters", "often"];
export const WIZARD = {
  title: {
    people: (bot) => "Who should " + bot + " look out for?",
    notify: () => "Who gets notified?",
    matters: () => "What matters most?",
    often: () => "How often",
  },
  note: {
    people: "Each person gets their own alerts. Nobody sees another person's.",
    notify: "With this off, alerts still arrive, quietly.",
    matters: "One line in your own words helps the most.",
    often: "More often uses more of the bot's model plan.",
  },
  rules: "In your own words",
  rulesPlaceholder: "Anything from my manager, the same day",
  lookAround: "Look around",
  lookAroundNote: "Reads this computer's own inbox, calendar and tools. Only for you.",
  every: "Check for changes",
  cap: "Most alerts a day",
  setUp: "Set up",
  next: "Next",
  back: "Back",
  finish: "Turn on",
  needsOne: "Choose at least one person.",
  waiting: "Set up to turn it on. Nothing runs until then.",
};
/** An alert's actions, and what it says once the person chose. */
export const ALERT = {
  take: "Take care of it",
  later: "Not now",
  taken: "Taking care of it",
  held: "Not now. Back in a day if it still matters.",
};

const USUAL = { every: 30, sweepHours: 3, maxPerDay: 6, watch: ["runs", "tasks", "requests", "context"] };
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The people the first step lists. The owner is shown everyone whose role sees the bot, the owner first.
 * A member is shown only themselves: nobody adds another person but the owner. `viewer` is who is looking:
 * `{ id, name?, manages }` with id "owner" or a member's id.
 */
export function wizardPeople(team, botId, viewer, ownerName = "") {
  if (viewer.id !== OWNER) return [{ id: viewer.id, name: viewer.name || "You", you: true }];
  return proactiveEligible(team, botId, ownerName).map((person) => ({ ...person, you: person.id === OWNER }));
}

/**
 * What the steps start from: the bot's settings as they are, or the usual ones. The person running the
 * steps is ticked unless they were taken out before; everyone else is ticked only if the bot already
 * looks out for them. A member never has look-around or the tasks watch.
 */
export function wizardStart(entry, viewer, people) {
  const held = plain(entry?.people) ? entry.people : {};
  const owner = viewer.id === OWNER;
  const watch = Array.isArray(entry?.watch) ? entry.watch : USUAL.watch;
  return {
    people: Object.fromEntries(people.map((person) => [person.id, { on: held[person.id] ? held[person.id].on === true : person.id === viewer.id, notify: held[person.id]?.notify !== false }])),
    watch: owner ? [...watch] : watch.filter((item) => item !== "tasks"),
    instructions: typeof entry?.instructions === "string" ? entry.instructions : "",
    sweepHours: owner ? (Number.isFinite(entry?.sweepHours) ? entry.sweepHours : USUAL.sweepHours) : 0,
    every: Number.isFinite(entry?.every) ? entry.every : USUAL.every,
    maxPerDay: Number.isFinite(entry?.maxPerDay) ? entry.maxPerDay : USUAL.maxPerDay,
  };
}

/** Whether the steps can be finished: someone is ticked. */
export const wizardReady = (draft) => Object.values(draft.people).some((person) => person.on);

/**
 * What finishing the steps saves, as one change (`setBotProactive`): the bot is set up and on, each ticked
 * person is on with their notify choice, and a person who was unticked is taken out. A member's change
 * names only themselves and leaves look-around and the owner's pause alone. `entry` is the bot's settings before.
 */
export function wizardPatch(draft, entry, viewer) {
  const held = plain(entry?.people) ? entry.people : {};
  const owner = viewer.id === OWNER;
  const people = {};
  for (const [id, person] of Object.entries(draft.people)) {
    if (!owner && id !== viewer.id) continue;
    if (person.on) people[id] = { on: true, notify: person.notify !== false };
    else if (held[id]) people[id] = null;
  }
  return {
    setUp: true,
    ...((owner || entry?.pausedBy !== OWNER) && { enabled: true }),
    people,
    watch: owner ? [...draft.watch] : draft.watch.filter((item) => item !== "tasks"),
    instructions: draft.instructions.trim(),
    every: draft.every,
    maxPerDay: draft.maxPerDay,
    ...(owner && { sweepHours: draft.sweepHours }),
  };
}

/**
 * Where a bot's agent stands for the person looking: "setup" (its setup steps are not finished, so nothing
 * runs), "paused" (the computer's switch is off), "off" (the bot's switch is off), "out" (the bot doesn't look
 * out for this person), "mine-off" (their own alerts are off) or "on".
 */
export function proactiveStanding(part, entry, viewerId) {
  if (!entry || entry.setUp !== true) return "setup";
  if (entry.enabled !== true) return "off";
  if (part?.enabled !== true) return "paused";
  const mine = plain(entry.people) ? entry.people[viewerId] : undefined;
  if (!mine) return "out";
  return mine.on ? "on" : "mine-off";
}

/** One line under a person's name on the bot's Proactive page. */
export const personLine = (person) => (!person.on ? "Off" : person.notify === false ? "On · not notified" : "On · notified");
