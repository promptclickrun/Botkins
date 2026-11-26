// Routines: named, pausable scheduled tasks for any bot. Each routine is a `chat.schedules[]` entry with
// `routine: true` in its own "Routine · <name>" chat, so `tickChatSchedules` is the only dispatcher.
// A routine runs its instructions as a bot's turn, or a script (`script`) on this computer with no
// model. A script routine may also have a follow-up action (`followUp` with instructions in
// `prompt`): the bot then takes the run's turn with the script's output. A routine's own model is its
// chat's (`chat.model`); without one it uses the Default routines model (`settings.routineModel`).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "./providers/provider.mjs";
import { askToSchedule, scriptInvocation } from "./script-commands.mjs";
import { shownText } from "./shown-text.mjs";
import { validateSelection } from "./preferences.mjs";
import { runScript, scriptEnding, sleepsAgent, SCRIPT_LENGTH } from "./routine-script.mjs";
import { CronExpressionParser } from "cron-parser";
import { nextTime, textField } from "./panels.mjs";
import { BOARD_KINDS, GOAL_CATEGORIES } from "./board.mjs";
import { spaceShare } from "./link/team.mjs";
import { isGroup } from "./groups.mjs";
import {
  ROUTINE_NOTIFY_TARGETS,
  discoverNotifyTargets,
  normalizeRunNotifyTargets,
  resolveRoutineTargets,
  summarizeNotifyTargets,
  validateNotifyTargets,
} from "./link/notify-targets.mjs";

export { ROUTINE_NOTIFY_TARGETS };

export const CADENCES = ["once", "daily", "weekdays", "weekly", "custom"];
/** The version of routine destinations (`deliver`), for a phone to check before it offers them. */
export const ROUTINE_DELIVERY = "routine-delivery-v1";
/**
 * Says that a routine a team member makes carries their id (`createdBy` on its `chat.schedules[]`
 * entry and on its chat). The link turns on its check with this name: a member may change, run,
 * enable or delete only a routine they made. A routine made before the stamp has no name on it
 * and is the owner's.
 */
export const ROUTINE_OWNER = "routine-owner-v1";
/**
 * Says that a routine can run a script with no model (`script`), with an optional follow-up action
 * (`followUp`), for a phone to check before it offers them. Only the owner adds or changes a script.
 */
export const ROUTINE_SCRIPTS = "routine-scripts-v1";
/**
 * Says that a routine can have its own model (`model` in createRoutine and updateRoutine, kept on
 * its chat) and that setModel takes the scope "routines" (the Default routines model).
 */
export const ROUTINE_MODELS = "routine-models-v1";
/** Where a routine's result can land. "routine" is its own chat and the historical default. */
export const DELIVER_TARGETS = ["none", "routine", "chat", ...BOARD_KINDS];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function zoneField(value) {
  const zone = value || localZone();
  if (typeof zone !== "string" || zone.length > 64) throw new Error("Unknown time zone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    throw new Error("Unknown time zone: " + zone);
  }
  return zone;
}

function timeField(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error("Use a 24-hour time such as 09:00");
  return { hour: +m[1], minute: +m[2], text: m[1].padStart(2, "0") + ":" + m[2] };
}

function daysField(value) {
  if (!Array.isArray(value) || !value.length || value.length > 7) throw new Error("Choose at least one day");
  const days = value.map((d) => {
    const n = typeof d === "number" ? d : DAY_NAMES.indexOf(String(d).slice(0, 3).toLowerCase());
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error("Unknown day: " + d);
    return n;
  });
  return [...new Set(days)].sort((a, b) => a - b);
}

/** The time zone's offset from UTC, in ms, at instant `t`. */
function offsetAt(t, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(t / 1000) * 1000;
}

/** The instant a wall-clock date and time occur in `zone`. A time skipped by DST lands within an hour of it. */
export function zonedTime(date, time, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!m) throw new Error("Use a date such as 2026-11-18");
  const { hour, minute } = timeField(time);
  const wall = Date.UTC(+m[1], m[2] - 1, +m[3], hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== m[2] - 1 || check.getUTCDate() !== +m[3]) throw new Error("That date doesn't exist");
  const first = wall - offsetAt(wall, zone);
  return wall - offsetAt(first, zone);
}

/** True when a five-field cron never fires more than once in 15 minutes (checked over its next runs). */
export function slowEnough(cron) {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: new Date() });
    let last = it.next().getTime();
    for (let k = 0; k < 20; k++) {
      const t = it.next().getTime();
      if (t - last < 15 * 60 * 1000) return false;
      last = t;
    }
    return true;
  } catch {
    return false;
  }
}
/** Validates a cadence and returns its canonical form. */
export function cadenceField(value) {
  const kind = value?.kind;
  if (!CADENCES.includes(kind)) throw new Error("Choose Once, Daily, Weekdays, Weekly or Custom");
  switch (kind) {
    case "once":
      return { kind, date: String(value.date ?? ""), time: timeField(value.time).text };
    case "daily":
    case "weekdays":
      return { kind, time: timeField(value.time).text };
    case "weekly":
      return { kind, time: timeField(value.time).text, days: daysField(value.days) };
    case "custom": {
      const cron = textField(value.cron, 160, "cron").replace(/\s+/g, " ");
      return { kind, cron };
    }
  }
}

/** Compiles a cadence to the schedule fields `tickChatSchedules` reads: `cron` or a one-time `nextAt`. */
export function compileCadence(value, zone, now = Date.now()) {
  const cadence = cadenceField(value);
  const timezone = zoneField(zone);
  if (cadence.kind === "once") {
    const nextAt = zonedTime(cadence.date, cadence.time, timezone);
    if (nextAt <= now) throw new Error("Choose a time in the future");
    return { cadence, timezone, recurring: false, cron: undefined, nextAt };
  }
  let cron = cadence.cron;
  if (!cron) {
    const { hour, minute } = timeField(cadence.time);
    const dow = cadence.kind === "daily" ? "*" : cadence.kind === "weekdays" ? "1-5" : cadence.days.join(",");
    cron = minute + " " + hour + " * * " + dow;
  }
  return { cadence, timezone, recurring: true, cron, nextAt: nextTime(cron, timezone, now) };
}

/** A routine's script: undefined for none, else its text. Up to SCRIPT_LENGTH characters. */
export function scriptField(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("Write the script, or choose Instructions.");
  if (value.length > SCRIPT_LENGTH) throw new Error("A script can have up to " + SCRIPT_LENGTH.toLocaleString("en-US") + " characters.");
  return value.replace(/\r\n/g, "\n");
}

/** Whether a routine is a script routine with a follow-up action that has its instructions. */
export const followsUp = (entry) => !!entry?.script && entry.followUp === true && !!entry.prompt;

/** The person a routine belongs to: the team member who made it, else the computer's owner. */
const personOf = (createdBy) => createdBy ?? "owner";

/**
 * Why a chat can't receive a routine's result, or "" when it can. With `ws` and `person` (the
 * routine's creator), the chat must also be one that person is in: a routine never writes into
 * somebody else's chat.
 */
function chatProblem(chat, botId, ws, person) {
  if (!chat) return "That chat no longer exists.";
  if (ws && person && !ws.inChat(chat.id, person)) return "That chat belongs to someone else. Choose a chat the routine's creator is in.";
  if (isGroup(chat)) return "Group chats can't receive a routine's result.";
  if (chat.botId !== botId) return "Choose a chat with this bot.";
  if (chat.schedules?.some((s) => s.routine)) return "A routine's chat can't receive a result. Choose another chat.";
  if (chat.temporary) return "A temporary chat can't receive a result.";
  if (chat.panelId || chat.helper) return "That chat can't receive a result.";
  if (chat.archived) return "That chat is archived.";
  return "";
}

/**
 * Validates where a routine's result goes and returns it in canonical form, or undefined for the
 * default (the routine's own chat), which is never saved. `ws` and `botId` let it check a chosen
 * chat, and `person` (the routine's creator: "owner" or a member's id) that the chat is theirs.
 */
export function deliveryField(value, ws, botId, person) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose where the result goes.");
  const unknown = Object.keys(value).find((k) => !["to", "chatId", "category"].includes(k));
  if (unknown) throw new Error("Unknown delivery setting: " + unknown + ". Use to, chatId and category.");
  const { to, chatId, category } = value;
  if (!DELIVER_TARGETS.includes(to))
    throw new Error('Send the result to "' + DELIVER_TARGETS.slice(0, -1).join('", "') + '" or "' + DELIVER_TARGETS.at(-1) + '".');
  if (chatId !== undefined && to !== "chat") throw new Error("A chat can only be chosen when the result goes to a chat.");
  if (category !== undefined && to !== "goal") throw new Error("A category only applies when the result goes to a goal.");
  if (to === "routine") return undefined;
  if (to === "none") return { to };
  if (to === "chat" && chatId !== undefined) {
    if (typeof chatId !== "string" || !chatId) throw new Error("Choose a chat.");
    const problem = chatProblem(ws?.state.chats.find((c) => c.id === chatId), botId, ws, person);
    if (problem) throw new Error(problem);
  }
  if (category !== undefined && !GOAL_CATEGORIES.includes(category))
    throw new Error("Use one of these goal categories: " + GOAL_CATEGORIES.join(", "));
  return { to, ...(chatId !== undefined && { chatId }), ...(category !== undefined && { category }) };
}

/**
 * Whether a routine's runs notify the person: undefined (leave as it is), true or false. A routine
 * notifies unless it was told not to, so only `false` is ever saved.
 */
export function notifyField(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error("Choose whether this routine notifies: true or false.");
  return value;
}

/** What a bot is told about where its reply goes. */
/**
 * A routine's reply of exactly this word says the run found nothing worth saying: the run completes
 * with no message, no delivery and no notification. A failed run still notifies. Bots are not told
 * of it by default, so a reminder never goes quiet; a routine's instructions opt in by asking for it.
 */
export { SILENT, isSilent } from "./link/silent-reply.mjs";
export const ROUTINE_SILENT = "routine-silent-v1";
const MANAGED = "Botkins keeps this routine for a bot that looks out for someone. Change it on the bot's profile, under Proactive.";

const DESTINATION_NOTES = {
  none: "This routine has no output. Do the work, then finish without a reply.",
  chat: "Your reply will be sent to the person as a message in your chat with them.",
  feed: "Your reply will be posted to the person's Feed. Begin with a one-line title, then the details.",
  idea: "Your reply will be posted to the person's Ideas. Begin with a one-line title, then the details.",
  goal: "Your reply will be posted to the person's Goals. Begin with a one-line title, then the details.",
};

/** A reply's first line as a board title, and the rest as its body. */
function boardText(text) {
  const reply = text.trim();
  const [head, ...rest] = reply.split(/\r?\n/);
  const line = head.replace(/^[#>*\-\s]+/, "").replace(/\*\*|__/g, "").trim() || head.trim();
  const clipped = line.length > 120;
  const body = (clipped ? reply : rest.join("\n").trim()).slice(0, 4000);
  return { title: clipped ? line.slice(0, 119).trimEnd() + "…" : line, body };
}

function clock(text) {
  const { hour, minute } = timeField(text);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    Date.UTC(2000, 0, 1, hour, minute),
  );
}

/** A short summary such as "Weekdays at 9:00 AM". Mirrors `cadenceSummary` in src/Routines.tsx. */
export function describeCadence(c) {
  switch (c?.kind) {
    case "once":
      return "Once on " + c.date + " at " + clock(c.time);
    case "daily":
      return "Daily at " + clock(c.time);
    case "weekdays":
      return "Weekdays at " + clock(c.time);
    case "weekly":
      return "Weekly on " + c.days.map((d) => DAY_LABELS[d]).join(", ") + " at " + clock(c.time);
    case "custom":
      return "Custom · " + c.cron;
    default:
      return "Scheduled";
  }
}

/** The next slot of a recurring entry after `now`, or null for a one-time entry. */
function upcoming(entry, now) {
  if (!entry.recurring) return entry.nextAt;
  if (entry.cron) return nextTime(entry.cron, entry.timezone, now);
  return entry.nextAt > now
    ? entry.nextAt
    : entry.nextAt + (1 + Math.floor((now - entry.nextAt) / entry.intervalMs)) * entry.intervalMs;
}

export class Routines {
  constructor(workspace) {
    this.ws = workspace;
    // The scripts running now, so that Botkins ends them when it quits (stopScripts).
    this.scripts = new Set();
    // A finished routine run goes where its routine says. Delivery never fails the run.
    workspace.events?.on("turn", ({ chat, run, proactiveCheck }) => {
      try {
        this.deliver(chat, run, proactiveCheck);
      } catch (error) {
        console.error("Routine delivery:", error.message);
      }
    });
  }
  /** Every routine, newest first, with its chat and bot. */
  list(botId) {
    const out = [];
    for (const chat of this.ws.state.chats)
      for (const entry of chat.schedules ?? [])
        if (entry.routine && (!botId || chat.botId === botId)) out.push({ chat, entry });
    return out;
  }
  find(chatId) {
    const chat = this.ws.chat(chatId);
    const entry = chat.schedules?.find((s) => s.routine);
    if (!entry) throw new Error("Unknown routine");
    return { chat, entry };
  }
  noOutput(chat, scheduleId) {
    return scheduleId != null && chat?.schedules?.some((entry) => entry.id === scheduleId && entry.routine && entry.deliver?.to === "none");
  }
  schedule(chatId, id) {
    const chat = this.ws.chat(chatId);
    const entry = chat.schedules?.find((s) => s.id === id);
    if (!entry) throw new Error("Unknown schedule");
    return { chat, entry };
  }
  /**
   * A routine's checked fields. A script routine keeps `script` and `followUp`; its instructions
   * (`prompt`, the follow-up's) are needed only when the follow-up is on, and kept when it is off.
   */
  fields(data, now) {
    const script = scriptField(data.script);
    const followUp = !!script && data.followUp === true;
    const prompt =
      script && !followUp
        ? typeof data.prompt === "string" && data.prompt.trim()
          ? textField(data.prompt, 4000, "instructions: use up to 4,000 characters")
          : ""
        : textField(data.prompt, 4000, script ? "follow-up instructions: write what the bot does with the script's output, up to 4,000 characters" : "instructions: use up to 4,000 characters");
    return {
      name: textField(data.name, 80, "name: use up to 80 characters"),
      prompt,
      ...(script && { script, followUp }),
      ...compileCadence(data.cadence, data.timezone, now),
    };
  }
  /** A model for a routine, checked against the catalog: undefined leaves it, null clears it. */
  async modelField(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return validateSelection(await this.ws.models(), value);
  }
  /** Sets a routine's own model on its chat; null clears it, so the routine uses the routines default. */
  setModel(chat, model) {
    if (model === undefined) return;
    if (model) chat.model = model;
    else delete chat.model;
  }
  /**
   * `create` with a model (`data.model`). The model is checked first, so an unavailable one saves
   * nothing. The window, the command line and a phone make routines this way.
   */
  async createWithModel(data, now = Date.now(), createdBy) {
    const model = await this.modelField(data?.model);
    const chatId = this.create(data, now, createdBy);
    if (model) {
      this.setModel(this.ws.chat(chatId), model);
      this.ws.save();
    }
    return chatId;
  }
  /** `update` with a model: `data.model` null goes back to the routines default. */
  async updateWithModel(chatId, data, now = Date.now(), actor = "owner") {
    const model = await this.modelField(data?.model);
    const entry = this.update(chatId, data, now, actor);
    if (model !== undefined) {
      this.setModel(this.ws.chat(chatId), model);
      this.ws.save();
    }
    return entry;
  }
  /** Resolves `notify` + `notifyTargets` input into canonical persisted changes. */
  notifyChange(botId, data, actor = "owner", opts = {}) {
    const notify = notifyField(data.notify);
    const hasTargets = data.notifyTargets !== undefined && data.notifyTargets !== null;
    if (notify === false && hasTargets) throw new Error("Choose either notify: false or notifyTargets, not both.");
    if (notify === false) return { notify: false, notifyTargets: null };
    if (data.notifyTargets === null) return { notify: notify ?? true, notifyTargets: null };
    if (hasTargets) {
      const validated = validateNotifyTargets(data.notifyTargets, this.ws.notifyTargetsContext(botId), {
        resolveNames: opts.resolveNames === true,
        actor,
      });
      if (Array.isArray(opts.warnings)) opts.warnings.push(...validated.warnings);
      if (validated.empty) return { notify: false, notifyTargets: null };
      return { notify: true, notifyTargets: validated.targets };
    }
    return { notify, notifyTargets: undefined };
  }
  /**
   * Makes a routine. `createdBy` is the team member who made it (never taken from `data`): it is
   * kept on the routine and on its chat, so the routine's turns run under that member's limits
   * and its result is theirs to hear of.
   */
  create(data, now = Date.now(), createdBy, opts = {}) {
    this.ws.bot(data.botId);
    const chat = this.buildChat(data, now, createdBy, opts);
    this.ws.state.chats.unshift(chat);
    this.ws.save();
    return chat.id;
  }
  /** Prepare a routine with its private chat before either becomes visible to the scheduler. */
  buildChat(data, now, createdBy, opts) {
    // A script runs on this computer, so only its owner writes one.
    if (createdBy && data.script != null) throw new Error("Only the computer's owner can add a script to a routine.");
    if (createdBy && data.allowReadyTasks === true) throw new Error("Only the computer's owner can let a routine create Ready tasks.");
    const fields = this.fields(data, now);
    const deliver = deliveryField(data.deliver, this.ws, data.botId, personOf(createdBy));
    const notifyChange = this.notifyChange(data.botId, data, personOf(createdBy), opts);
    const chat = this.ws.buildChat(data.botId, "Routine · " + fields.name, undefined, createdBy);
    chat.lastScheduleId = 1;
    chat.schedules = [
      {
        id: 1,
        routine: true,
        enabled: !opts.fromTemplate,
        ...(opts.fromTemplate && { fromTemplate: true }),
        createdAt: now,
        ...fields,
        ...(createdBy && { createdBy }),
        ...(deliver && { deliver }),
        ...(notifyChange.notify === false && { notify: false }),
        ...(notifyChange.notifyTargets && { notifyTargets: notifyChange.notifyTargets }),
        ...(data.allowReadyTasks === true && { allowReadyTasks: true }),
      },
    ];
    return chat;
  }
  update(chatId, data, now = Date.now(), actor = "owner", opts = {}) {
    const { chat, entry } = this.find(chatId);
    if (entry.proactive) throw new Error(MANAGED);
    // Whoever changes it, the result may only go to a chat of the routine's creator.
    const deliver = data.deliver === undefined ? undefined : (deliveryField(data.deliver, this.ws, chat.botId, personOf(entry.createdBy)) ?? null);
    const notifyChange = this.notifyChange(chat.botId, data, actor, opts);
    if (actor !== "owner" && data.allowReadyTasks === true) throw new Error("Only the computer's owner can let a routine create Ready tasks.");
    // A change of destination, of notifying or of the model alone leaves the schedule as it is, so a finished one-time routine can still take it.
    if (["name", "prompt", "cadence", "timezone", "script", "followUp"].every((k) => data[k] === undefined)) {
      this.setDeliver(entry, deliver);
      this.setNotifyTargets(entry, notifyChange);
      this.setAllowReadyTasks(entry, data.allowReadyTasks);
      this.ws.save();
      return entry;
    }
    const fields = this.fields(
      {
        name: data.name ?? entry.name,
        prompt: data.prompt ?? entry.prompt,
        cadence: data.cadence ?? entry.cadence,
        timezone: data.timezone ?? entry.timezone,
        // null takes the script away: the routine runs its instructions again.
        script: data.script === undefined ? entry.script : data.script,
        followUp: data.followUp ?? entry.followUp,
      },
      now,
    );
    if (!fields.script) {
      delete entry.script;
      delete entry.followUp;
    }
    Object.assign(entry, fields);
    this.setDeliver(entry, deliver);
    this.setNotifyTargets(entry, notifyChange);
    this.setAllowReadyTasks(entry, data.allowReadyTasks);
    delete entry.finishedAt;
    chat.title = "Routine · " + entry.name;
    this.ws.save();
    return entry;
  }
  /** Sets a destination, or with null removes it; undefined leaves it. The default is never saved. */
  setDeliver(entry, deliver) {
    if (deliver === undefined) return;
    if (deliver) entry.deliver = deliver;
    else delete entry.deliver;
  }
  /** Says whether the routine's runs notify; undefined leaves it. Notifying is the usual way and is never saved. */
  setNotify(entry, notify) {
    if (notify === undefined) return;
    if (notify === false) entry.notify = false;
    else delete entry.notify;
  }
  /** Applies both `notify` and `notifyTargets`. Preserves existing `notifyTargets` when undefined (older clients). */
  setNotifyTargets(entry, change) {
    if (!change) return;
    this.setNotify(entry, change.notify);
    if (change.notifyTargets === undefined) return;
    if (change.notifyTargets) entry.notifyTargets = change.notifyTargets;
    else delete entry.notifyTargets;
  }
  /** Whether this routine is allowed to create Ready tasks for bots (owner-approved opt-in). */
  setAllowReadyTasks(entry, allow) {
    if (allow === undefined) return;
    if (allow === true) entry.allowReadyTasks = true;
    else delete entry.allowReadyTasks;
  }
  /** Pauses or resumes a routine or any chat schedule. */
  setEnabled(chatId, id, enabled, now = Date.now()) {
    const { entry } = id == null ? this.find(chatId) : this.schedule(chatId, id);
    if (typeof enabled !== "boolean") throw new Error("Choose pause or resume");
    if (enabled) {
      if (entry.nextAt == null || (!entry.recurring && entry.nextAt <= now))
        throw new Error("This one-time routine has passed. Edit it to choose a new time.");
      if (entry.enabled === false) entry.nextAt = upcoming(entry, now);
    }
    entry.enabled = enabled;
    // Pausing the routine Botkins keeps for a person is that person's own alerts switch: it is kept there, so it stays as they left it.
    if (entry.proactive) this.ws.proactive.routineSwitched(this.ws.chat(chatId), enabled);
    this.ws.save();
    return entry;
  }
  /** Deletes a routine and the chat that holds its runs. */
  async remove(chatId) {
    const { chat, entry } = this.find(chatId);
    // Removing the routine a bot keeps for a person turns that person's check off, or it would come back at the next
    // change. Before the chat goes: the scheduler may look while it is being deleted.
    if (entry.proactive) this.ws.proactive.routineRemoved(chat);
    await this.ws.agents.deleteChat(chatId);
  }
  removeSchedule(chatId, id) {
    const { chat } = this.schedule(chatId, id);
    chat.schedules = chat.schedules.filter((s) => s.id !== id);
    this.ws.save();
  }
  /** Starts a run now without moving the schedule. Returns the turn. */
  run(chatId) {
    const { chat, entry } = this.find(chatId);
    if (this.ws.active.has(chatId)) throw new Error("This routine is already running");
    return dispatch(this.ws, chat, entry, "manual");
  }
  /** A copy of a routine. It belongs to whoever copies it: `createdBy` is that team member, or nothing for the owner. */
  duplicate(chatId, botId, now = Date.now(), createdBy) {
    const { chat, entry } = this.find(chatId);
    if (entry.proactive) throw new Error(MANAGED);
    // A chat chosen on the old bot isn't the new bot's, so a copy for another bot goes to its latest chat.
    // Nor is a chosen chat kept when the copy's owner is not in it.
    const { chatId: picked, ...rest } = entry.deliver ?? {};
    const keep = botId === chat.botId && (picked === undefined || this.ws.inChat(picked, personOf(createdBy)));
    const deliver = entry.deliver && (keep ? entry.deliver : rest);
    // Keep only notification targets still eligible for the destination bot and visible to the copier.
    let notifyTargets;
    if (entry.notifyTargets) {
      const available = discoverNotifyTargets({ ...this.ws.notifyTargetsContext(botId), actor: personOf(createdBy) });
      const validPeople = new Set(available.people.map((person) => person.id));
      const validDevices = new Set(available.people.flatMap((person) => (person.devices ?? []).map((device) => device.id)));
      const people = (entry.notifyTargets.people ?? []).filter((id) => validPeople.has(id));
      const devices = (entry.notifyTargets.devices ?? []).filter((id) => validDevices.has(id));
      if (people.length || devices.length) {
        notifyTargets = { ...(people.length && { people }), ...(devices.length && { devices }) };
      }
    }
    const copy = this.create(
      {
        botId,
        name: entry.name,
        prompt: entry.prompt,
        cadence: entry.cadence,
        timezone: entry.timezone,
        deliver,
        ...(entry.notify === false && { notify: false }),
        ...(notifyTargets && { notifyTargets }),
        ...(entry.script && { script: entry.script, followUp: entry.followUp === true }),
        ...(entry.allowReadyTasks === true && !createdBy && { allowReadyTasks: true }),
      },
      now,
      createdBy,
    );
    if (chat.model) {
      this.ws.chat(copy).model = structuredClone(chat.model);
      this.ws.save();
    }
    return copy;
  }
  /** Ends every script that is running (Botkins is quitting). */
  stopScripts() {
    for (const script of this.scripts) script.stop();
  }
  /** Next run for a cadence, for the editor preview. */
  preview(cadence, timezone, now = Date.now()) {
    const { nextAt, cadence: c, timezone: zone } = compileCadence(cadence, timezone, now);
    return { nextAt, summary: describeCadence(c), timezone: zone };
  }
  view(chat, entry) {
    return {
      id: chat.id,
      name: entry.name,
      instructions: entry.prompt,
      cadence: describeCadence(entry.cadence),
      timezone: entry.timezone,
      enabled: entry.enabled !== false,
      finished: entry.nextAt == null,
      nextRun: entry.enabled !== false && entry.nextAt != null ? new Date(entry.nextAt).toISOString() : null,
      ...(entry.deliver && { deliver: entry.deliver }),
      ...(entry.createdBy && { createdBy: entry.createdBy }),
      // Left out when the routine notifies, which is the usual way.
      ...(entry.notify === false && { notify: false }),
      ...(entry.notifyTargets && {
        notifyTargets: entry.notifyTargets,
        notifySummary: summarizeNotifyTargets(entry.notifyTargets, this.ws.notifyTargetsContext(chat.botId)),
      }),
      ...(entry.script && { script: entry.script, followUp: entry.followUp === true }),
      ...(entry.allowReadyTasks === true && { allowReadyTasks: true }),
      // Kept by Botkins for the bot's Proactive agent: changed on the bot's profile, not here.
      ...(entry.proactive && { proactive: true }),
      // The routine's own model; without one it uses the Default routines model.
      ...(chat.model && { model: chat.model }),
    };
  }
  /** The line added to a routine run's turn so the bot writes for its destination. "" for the default. */
  destinationNote(chat, scheduleId) {
    const entry = chat.schedules?.find((s) => s.id === scheduleId && s.routine);
    const base = (entry?.deliver && DESTINATION_NOTES[entry.deliver.to]) || "";
    if (!entry || entry.deliver?.to === "none") return base;
    const available = discoverNotifyTargets({
      ...this.ws.notifyTargetsContext(chat.botId),
      actor: personOf(entry.createdBy ?? chat.createdBy),
    });
    const totalDevices = available.people.reduce((sum, person) => sum + (person.devices?.length ?? 0), 0);
    if (available.people.length <= 1 && totalDevices <= 1) return base;
    const note =
      "[Multiple people or devices can receive alerts for this routine. Call routine_notify_targets to inspect available recipients and routine_notify before finishing if you need to notify specific people/devices or suppress alerts for this run.]";
    return base ? `${base}\n${note}` : note;
  }
  /**
   * The chat a routine's reply goes to: the one chosen, else the bot's latest chat that the
   * routine's creator is in. Makes one, theirs, when there is none.
   */
  chatTarget(botId, deliver, title, createdBy) {
    const person = personOf(createdBy);
    if (deliver.chatId) {
      const chat = this.ws.state.chats.find((c) => c.id === deliver.chatId);
      const problem = chatProblem(chat, botId, this.ws, person);
      if (problem) throw new Error(problem);
      return chat;
    }
    const latest = this.ws.state.chats.filter((c) => (!c.main || c.messages.length) && !chatProblem(c, botId, this.ws, person)).sort((a, b) => b.time - a.time)[0];
    if (latest) return latest;
    return this.ws.chat(this.ws.createChat(botId, title, undefined, createdBy));
  }
  /** Sends a finished routine run's reply where its routine says. A failure is noted on the run. */
  deliver(chat, run, proactiveCheck) {
    if (run?.scheduleId == null || run.status !== "Completed" || run.delivery) return;
    const entry = chat.schedules?.find((s) => s.id === run.scheduleId && s.routine);
    if (!entry?.deliver || entry.deliver.to === "none") return;
    const text = chat.messages.findLast((m) => m.runId === run.id && m.role === "assistant" && !m.interim)?.text?.trim();
    if (!text) return;
    const { category } = entry.deliver;
    let to = entry.deliver.to;
    const maker = entry.createdBy ?? chat.createdBy;
    try {
      if (run.proactive && !this.ws.proactive.current(chat, personOf(maker))) throw new Error("This proactive check is no longer available.");
      if (run.proactive && to === "feed") {
        const person = personOf(maker);
        const space = this.ws.spaces.forCards(person, "feed");
        const team = this.ws.teamOf();
        if (spaceShare(team, space.id).access !== "private" || team?.members?.some((m) => m.id !== person && this.ws.spaces.can(space, m.id)) ||
          (person !== "owner" && !this.ws.turnPeople(chat).sees())) to = "chat";
      }
      if (to === "chat") {
        const target = run.proactive
          ? this.ws.proactive.chatTarget(chat.botId, personOf(maker))
          : this.chatTarget(chat.botId, entry.deliver, entry.name, maker);
        const time = Date.now();
        // A proactive alert carries what the apps may do with it (desktop/proactive.mjs, `act`).
        target.messages.push({ role: "assistant", text, time, ...(run.proactive && { proactiveRunId: run.id, alert: this.ws.proactive.alertOf(run, proactiveCheck) }) });
        target.time = time;
        target.unread = true;
        // The message was written in the routine's own chat, so the session behind this chat has
        // not seen it. It is told at its next turn (Workspace.send), or the bot would not know
        // what the person is answering.
        target.posted = [...(target.posted ?? []), { text: text.slice(0, 6000), from: entry.name, time }].slice(-5);
        run.delivery = { to, chatId: target.id };
      } else {
        // The card goes to the Feed, Ideas or Goals of the person the routine is: a member's routine never writes into the owner's.
        // A proactive alert is the bot's own word: the card names the bot, not a routine.
        const item = this.ws.board.post(chat.botId, { kind: to, ...boardText(text), category, ...(!run.proactive && { source: entry.name }) }, this.ws.spaces.forCards(entry.createdBy ?? chat.createdBy ?? "owner", to).id);
        if (run.proactive) Object.assign(item, { proactiveRunId: run.id, alert: this.ws.proactive.alertOf(run, proactiveCheck) });
        run.delivery = { to, itemId: item.id };
      }
    } catch (error) {
      run.detail = "Not delivered: " + error.message;
    }
    this.ws.save();
  }
  /** Copilot tools that let a bot manage its own routines. */
  tools(bot, chat, run, task) {
    // Panel refreshes stay limited to their panel.
    if (run?.panelId) return [];
    const ws = this.ws;
    const people = ws.turnPeople(chat, task);
    const owns = (entry) => people.people.every((id) => id === "owner" || id === personOf(entry.createdBy));
    const owned = (id, action = "manage") => {
      const found = this.find(String(id ?? ""));
      if (found.chat.botId !== bot.id || !owns(found.entry)) throw new Error("Unknown routine for this bot");
      people.needs(action);
      return found;
    };
    const tool = (name, description, properties, required, handler) =>
      defineTool(name, {
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        skipPermission: true,
        defer: "never",
        handler: async (args) => {
          if (task.stopped || ws.closing || !run || ws.active.get(chat.id) !== task)
            throw new Error("This turn is no longer active");
          const result = await handler(args);
          // A plain sentence (the person declined) goes as it is.
          return typeof result === "string" ? result : JSON.stringify(result);
        },
      });
    const str = { type: "string" };
    const cadenceProps = {
      cadence: { type: "string", enum: CADENCES },
      time: { type: "string", description: "24-hour HH:MM, for once, daily, weekdays and weekly" },
      days: { type: "array", items: { type: "string", enum: DAY_NAMES }, description: "For weekly" },
      date: { type: "string", description: "YYYY-MM-DD, for once" },
      cron: { type: "string", description: "Five cron fields, for custom" },
      timezone: { type: "string", description: "IANA time zone. Defaults to " + localZone() },
    };
    const deliverProp = {
      deliver: {
        type: "object",
        description:
          "Where the result goes. Omit it, or use {\"to\":\"routine\"}, to keep it in the routine's own chat. " +
          "{\"to\":\"chat\"} sends your reply to the person as a message in your chat with them: use it when they ask to be reminded or told something in the chat, e.g. \"remind me in our chat every morning\". " +
          "{\"to\":\"feed\"}, {\"to\":\"idea\"} and {\"to\":\"goal\"} post your reply to Today's Feed, Ideas or Goals; a goal may take a category (" + GOAL_CATEGORIES.join(", ") + "). " +
          "chatId picks a particular chat of yours; leave it out for this chat (or your latest chat with the person when this one can't take it).",
        properties: { to: { type: "string", enum: DELIVER_TARGETS }, chatId: str, category: { type: "string", enum: GOAL_CATEGORIES } },
        required: ["to"],
        additionalProperties: false,
      },
    };
    const notifyProp = {
      notify: { type: "boolean", description: "false makes the routine run quietly: no notification on the computer or the phone when it finishes. Leave it out to notify, which is the usual way." },
      notifyTargets: {
        type: "object",
        description:
          "Default notification recipients for this routine. Call routine_notify_targets first to get valid person IDs (e.g. \"owner\", \"m_…\") and device IDs (e.g. \"host\", paired device IDs). " +
          "Omit to alert everyone who sees this routine; pass notify: true (without notifyTargets) on update to reset to everyone; pass notify: false to silence.",
        properties: {
          people: { type: "array", items: str, description: "Person IDs (or unique person names) whose devices should all be alerted." },
          devices: { type: "array", items: str, description: "Specific device IDs (\"host\" or paired device IDs, or unique device names) to alert." },
        },
        additionalProperties: false,
      },
    };
    // "Remind me here": a result sent to a chat goes to the chat it was asked in, when that chat can take it.
    // A routine a bot makes belongs to whoever the bot is working for: the member who wrote this
    // turn's message, else the member whose chat this is, else the owner.
    const maker = task?.author?.memberId ?? chat.createdBy;
    const actor = personOf(maker);
    const here = (deliver) => (deliver?.to === "chat" && deliver.chatId === undefined && !chatProblem(chat, bot.id, ws, actor) ? { ...deliver, chatId: chat.id } : deliver);
    const stillActive = () => {
      if (task.stopped || task.ended || ws.closing || ws.active.get(chat.id) !== task) throw new Error("This turn has ended.");
    };
    /** A routine that invokes a script command: a card read in the app, and a yes (desktop/script-commands.mjs). Throws when nobody is there. */
    const approved = async (invocation, about) => {
      if (run?.scheduleId != null || run?.taskId || run?.panelId) throw new Error("A routine that runs a script command can only be made or changed with the person there. Ask them to.");
      const yes = await askToSchedule(ws, { bot, chat, task, invocation, what: "Let a routine run the script command /" + invocation.name + "?", about });
      stillActive();
      return yes;
    };
    const whenWords = (a) => [a.cadence, a.time, a.days?.join(", "), a.date, a.cron, a.timezone].filter(Boolean).map((word) => shownText(String(word))).join(" ") || "as it is";
    const cadenceOf = (a) =>
      a.cadence ? { kind: a.cadence, time: a.time, days: a.days, date: a.date, cron: a.cron } : undefined;
    const id = { id: { type: "string", description: "Routine id from routine_list" } };
    const tools = [
      tool("routine_list", "List your routines: scheduled tasks that run your instructions in their own chat.", {}, [], () =>
        people.sees() ? this.list(bot.id).filter(({ entry }) => owns(entry)).map(({ chat, entry }) => this.view(chat, entry)) : [],
      ),
      tool(
        "routine_notify_targets",
        "List the people and devices eligible to receive routine notifications for this bot, including whether each device currently has routine alerts enabled.",
        {},
        [],
        () => discoverNotifyTargets({ ...ws.notifyTargetsContext(bot.id), actor }),
      ),
    ];
    // Per-run notification override: only available inside an active routine/scheduled run that can notify.
    // Not in a proactive check: its alert is for the one person it looked out for, and nobody else.
    const runEntry = chat.schedules?.find((s) => s.id === run?.scheduleId && s.routine);
    if ((run?.scheduleId != null || run?.trigger === "scheduled") && !this.noOutput(chat, run?.scheduleId) && !run?.proactive && !runEntry?.proactive) {
      const runActor = personOf(runEntry?.createdBy ?? chat.createdBy);
      tools.push(
        tool(
          "routine_notify",
          "Override who gets alerted when this routine run finishes. Call routine_notify_targets first to see valid person and device IDs. " +
            "Use mode \"only\" with people and/or devices to alert specific recipients (even if the routine is normally quiet), \"none\" to suppress alerts for this run, or \"default\" to fall back to the routine's default notification settings. " +
            "Calling this again during the same run replaces the previous choice.",
          {
            mode: { type: "string", enum: ["only", "none", "default"] },
            people: { type: "array", items: str, description: "For mode \"only\": person IDs (or unique names) to alert across all their devices." },
            devices: { type: "array", items: str, description: "For mode \"only\": specific device IDs (or unique names) to alert." },
            message: { type: "string", description: "Optional short alert line (up to 160 characters) shown in the notification." },
          },
          ["mode"],
          (a) => {
            const ctx = ws.notifyTargetsContext(bot.id);
            const { override, warnings } = normalizeRunNotifyTargets(a, ctx, { resolveNames: true, actor: runActor });
            if (override.mode === "default") delete run.notifyTargets;
            else run.notifyTargets = override;
            ws.save();
            const resolved = resolveRoutineTargets({
              ...ctx,
              entry: runEntry ?? { notify: true },
              run,
              chatNotifiesOwner: ws.notifiesOwner(chat.id),
            });
            return {
              ok: true,
              mode: override.mode,
              targets: resolved.explicit
                ? { host: Boolean(resolved.host), devices: [...(resolved.deviceIds ?? [])] }
                : { default: true },
              ...(warnings.length && { warnings }),
            };
          },
        ),
      );
    }
    // A scheduled, routine or task run can't create routines, so unattended work can't multiply itself.
    if (!run?.scheduleId && !run?.taskId)
      tools.push(
        tool(
          "routine_create",
          "Create a scheduled routine that runs `instructions` in its own chat, sends results to `deliver` (routine chat, this/another chat, Feed, Ideas, Goals, or none), and notifies unless `notify: false` or `notifyTargets` is set (use today_routine instead to silently refresh one fixed Today/space panel with failure-only alerts). " +
            "Write instructions as what you should do then, e.g. \"Remind the person to review their inbox.\" " +
            "Confirm only relevant settings the person has not already specified (cadence/timezone, delivery destination, notification preference). " +
            "Resolve relative dates from the current runtime date and the person's or routine's timezone.",
          { name: str, instructions: str, ...cadenceProps, ...deliverProp, ...notifyProp },
          ["name", "instructions", "cadence"],
          async (a) => {
            if (this.list(bot.id).length >= 25) throw new Error("You already have 25 routines. Ask the person which to remove first.");
            const cadence = cadenceOf(a);
            // A routine that runs a script command is not saved on a bot's word: the person sees what runs and when, and decides.
            const invocation = scriptInvocation(ws, a.instructions);
            if (invocation && !(await approved(invocation, ["Routine: " + shownText(a.name), "When: " + whenWords(a)]))) return "The person declined.";
            if (cadence?.kind === "cron" && !slowEnough(cadence.cron))
              throw new Error("Bots can't create routines that run more often than every 15 minutes. The person can set that up under Routines.");
            const warnings = [];
            const chatId = this.create(
              { botId: bot.id, name: a.name, prompt: a.instructions, cadence, timezone: a.timezone, deliver: here(a.deliver), notify: a.notify, notifyTargets: a.notifyTargets },
              undefined,
              maker,
              { resolveNames: true, warnings },
            );
            const found = this.find(chatId);
            return { ...this.view(found.chat, found.entry), ...(warnings.length && { warnings }) };
          },
        ),
      );
    tools.push(
      tool(
        "routine_update",
        "Change one of your routines: its name, instructions, schedule, where its result goes (deliver), or who it notifies (notify / notifyTargets). Supply only what changes; a new schedule needs cadence and its fields.",
        { ...id, name: str, instructions: str, ...cadenceProps, ...deliverProp, ...notifyProp },
        ["id"],
        async (a) => {
          const { entry: before } = owned(a.id);
          // The routine as it will be: a change to a routine that runs a script command (or makes it run one) is the person's to see.
          const invocation = !before.script && scriptInvocation(ws, a.instructions !== undefined ? a.instructions : before.prompt);
          if (invocation && !(await approved(invocation, ["Routine: " + shownText(a.name ?? before.name), "Change: " + (Object.keys(a).filter((key) => key !== "id").join(", ") || "none"), ...(a.cadence ? ["When: " + whenWords(a)] : [])]))) return "The person declined.";
          const warnings = [];
          const notifyTargets = a.notify === true && a.notifyTargets === undefined ? null : a.notifyTargets;
          const entry = this.update(
            a.id,
            { name: a.name, prompt: a.instructions, cadence: cadenceOf(a), timezone: a.timezone, deliver: here(a.deliver), notify: a.notify, notifyTargets },
            undefined,
            actor,
            { resolveNames: true, warnings },
          );
          return { ...this.view(ws.chat(a.id), entry), ...(warnings.length && { warnings }) };
        },
      ),
      tool("routine_pause", "Pause one of your routines.", id, ["id"], (a) => {
        owned(a.id);
        return this.view(ws.chat(a.id), this.setEnabled(a.id, null, false));
      }),
      tool("routine_resume", "Resume one of your paused routines.", id, ["id"], (a) => {
        owned(a.id);
        return this.view(ws.chat(a.id), this.setEnabled(a.id, null, true));
      }),
      tool("routine_delete", "Delete one of your routines and its run history, when the person asks.", id, ["id"], async (a) => {
        const { entry } = owned(a.id, "delete");
        await this.remove(a.id);
        return { deleted: entry.name };
      }),
    );
    return tools;
  }
}

/** Sends a schedule entry's prompt as a turn in its chat; the run carries `scheduleId`. A script routine runs its script first. */
export function dispatch(ws, chat, entry, trigger) {
  if (entry.routine && entry.proactive) {
    // The gate decides, with no model, whether this tick wakes the bot for the person this routine is kept for (desktop/proactive.mjs).
    const proactiveCheck = ws.proactive?.wake(chat.botId, trigger, Date.now(), chat.createdBy ?? "owner");
    if (!proactiveCheck) return Promise.resolve(null);
    const turn = ws.send(chat.id, "Check for a helpful suggestion.", { trigger, scheduleId: entry.id, title: entry.name, proactive: true, proactiveCheck });
    chat.title = "Routine · " + entry.name;
    return turn;
  }
  if (entry.routine && entry.script) return runScriptRoutine(ws, chat, entry, trigger);
  const title = chat.title;
  const turn = ws.send(chat.id, entry.prompt, {
    trigger,
    scheduleId: entry.id,
    title: entry.routine ? entry.name : "Scheduled · " + entry.prompt.slice(0, 80),
    // A routine's own prompt may be a script command (a bot's was shown to the person first), and so may a chat's schedule that a person made
    // (`allowScript` on the entry, kept by /every when the message that made it was a person's). A routine's follow-up turn never is.
    ...((entry.routine || entry.allowScript === true) && { allowScript: true }),
  });
  // The first message would otherwise rename the routine chat after its prompt.
  if (entry.routine && chat.title !== title) {
    chat.title = title;
    ws.save();
  }
  return turn;
}

/** What the bot is told of the script before its follow-up action. */
function scriptNote(result) {
  const output = result.output.trim();
  return (
    "[Before this turn, this routine's script ran on the person's computer. " + scriptEnding(result) +
    (output ? " Its output" + (result.output.length >= 12000 ? " (the last part)" : "") + ":]\n```\n" + output + "\n```" : " It printed nothing.]")
  );
}

/** A script-only run's reply: what the script printed, or how it failed. It goes where the routine's result goes. */
function scriptReply(result) {
  const output = result.output.trim().slice(-8000);
  if (result.exitCode === 0) return output || scriptEnding(result);
  return scriptEnding(result) + (output ? "\n\n```\n" + output + "\n```" : "");
}

/**
 * A script routine's run. The script runs first, as the run's first step, while the chat is busy
 * (a Stop ends it). With a follow-up action the bot then takes the same run's turn with the
 * instructions and the script's output; without one the script's output is the run's reply.
 */
function runScriptRoutine(ws, chat, entry, trigger) {
  if (ws.closing) throw new Error("Botkins is closing");
  if (ws.active.has(chat.id)) throw new Error("Chat unavailable or already working");
  const bot = ws.bot(chat.botId);
  const routines = ws.panels.routines;
  const followUp = followsUp(entry);
  const time = Date.now();
  const run = {
    id: randomUUID(),
    chatId: chat.id,
    trigger,
    scheduleId: entry.id,
    title: entry.name,
    time,
    status: "Working",
    detail: "",
    // Set while the script runs: a restart then ends the run instead of starting its turn.
    scriptRunning: true,
    steps: [],
    ...(routines.noOutput(chat, entry.id) && { noOutput: true }),
  };
  const message = { role: "user", text: followUp ? entry.prompt : "Run the routine's script.", runId: run.id, time };
  const step = { id: "script-" + run.id, name: "Script", label: "Running the routine's script", input: entry.script.slice(0, 12000), status: "Running", started: time };
  run.steps.push(step);
  ws.state.runs.unshift(run);
  chat.messages.push(message);
  chat.time = time;
  const folder = join(ws.dir, "files", bot.id);
  mkdirSync(folder, { recursive: true });
  const script = runScript(entry.script, { cwd: folder });
  routines.scripts.add(script);
  // The chat is busy while the script runs, as for a turn: the window shows it working, a schedule
  // or Run now waits, a message is queued, and Stop ends the script (session.abort).
  const task = {
    run,
    script: true,
    stopped: false,
    finishing: true,
    intent: "Running the script",
    stream: "",
    thinking: "",
    ready: Promise.resolve(null),
    reads: new Set(),
    helpers: [],
    session: { abort: async () => script.stop() },
  };
  ws.active.set(chat.id, task);
  ws.save();
  task.done = script.done.then((result) => {
    routines.scripts.delete(script);
    step.status = result.exitCode === 0 ? "Done" : "Failed";
    step.label = scriptEnding(result);
    step.output = result.output || "(no output)";
    step.finished = Date.now();
    ws.active.delete(chat.id);
    // A run that Botkins quit during keeps `scriptRunning`, and is ended when it opens again (Workspace's constructor).
    if (ws.closing) return;
    delete run.scriptRunning;
    run.script = { exitCode: result.exitCode, ...(result.timedOut && { timedOut: true }) };
    if (!task.stopped && sleepsAgent(result)) {
      Object.assign(run, { noOutput: true, silent: true });
      step.label = "Nothing new: the script let the run end here.";
    } else if (followUp && !task.stopped) {
      const where = routines.destinationNote(chat, entry.id);
      run.recovery = { extra: [scriptNote(result), where].filter(Boolean).join("\n\n") };
      return ws.startTurn(chat, bot, message, run, false);
    }
    const failed = result.exitCode !== 0;
    if (!run.noOutput && !task.stopped) chat.messages.push({ role: "assistant", text: scriptReply(result), runId: run.id, time: Date.now() });
    run.status = task.stopped ? "Stopped" : failed ? "Needs you" : "Completed";
    if (task.stopped) run.ending = "stopped";
    else if (failed) run.ending = "failed";
    run.detail = failed && !task.stopped ? scriptEnding(result) : "";
    delete run.stopRequested;
    run.finished = Date.now();
    chat.time = run.finished;
    if (run.status !== "Stopped") chat.unread = true;
    ws.events.emit("turn", { chat, run });
    ws.save();
    if (ws.queues.has(chat.id)) setImmediate(() => ws.drain(chat.id));
  });
  return task.done;
}
