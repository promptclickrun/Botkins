// Routines: named, pausable scheduled tasks for any bot. Each routine is a `chat.schedules[]` entry with
// `routine: true` in its own "Routine · <name>" chat, so `tickChatSchedules` is the only dispatcher.
import { defineTool } from "./providers/provider.mjs";
import { CronExpressionParser } from "cron-parser";
import { nextTime, textField } from "./panels.mjs";
import { BOARD_KINDS, GOAL_CATEGORIES } from "./board.mjs";
import { isGroup } from "./groups.mjs";

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
    // A finished routine run goes where its routine says. Delivery never fails the run.
    workspace.events?.on("turn", ({ chat, run }) => {
      try {
        this.deliver(chat, run);
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
  fields(data, now) {
    return {
      name: textField(data.name, 80, "name: use up to 80 characters"),
      prompt: textField(data.prompt, 4000, "instructions: use up to 4,000 characters"),
      ...compileCadence(data.cadence, data.timezone, now),
    };
  }
  /**
   * Makes a routine. `createdBy` is the team member who made it (never taken from `data`): it is
   * kept on the routine and on its chat, so the routine's turns run under that member's limits
   * and its result is theirs to hear of.
   */
  create(data, now = Date.now(), createdBy) {
    this.ws.bot(data.botId);
    const fields = this.fields(data, now);
    const deliver = deliveryField(data.deliver, this.ws, data.botId, personOf(createdBy));
    const notify = notifyField(data.notify);
    const chatId = this.ws.createChat(data.botId, "Routine · " + fields.name);
    const chat = this.ws.chat(chatId);
    if (createdBy) chat.createdBy = createdBy;
    const id = (chat.lastScheduleId ?? 0) + 1;
    chat.lastScheduleId = id;
    chat.schedules = [{ id, routine: true, enabled: true, createdAt: now, ...fields, ...(createdBy && { createdBy }), ...(deliver && { deliver }), ...(notify === false && { notify: false }) }];
    this.ws.save();
    return chatId;
  }
  update(chatId, data, now = Date.now()) {
    const { chat, entry } = this.find(chatId);
    // Whoever changes it, the result may only go to a chat of the routine's creator.
    const deliver = data.deliver === undefined ? undefined : (deliveryField(data.deliver, this.ws, chat.botId, personOf(entry.createdBy)) ?? null);
    const notify = notifyField(data.notify);
    // A change of destination or of notifying alone leaves the schedule as it is, so a finished one-time routine can still take it.
    if (["name", "prompt", "cadence", "timezone"].every((k) => data[k] === undefined)) {
      this.setDeliver(entry, deliver);
      this.setNotify(entry, notify);
      this.ws.save();
      return entry;
    }
    const fields = this.fields(
      {
        name: data.name ?? entry.name,
        prompt: data.prompt ?? entry.prompt,
        cadence: data.cadence ?? entry.cadence,
        timezone: data.timezone ?? entry.timezone,
      },
      now,
    );
    Object.assign(entry, fields);
    this.setDeliver(entry, deliver);
    this.setNotify(entry, notify);
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
    this.ws.save();
    return entry;
  }
  /** Deletes a routine and the chat that holds its runs. */
  async remove(chatId) {
    this.find(chatId);
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
    // A chat chosen on the old bot isn't the new bot's, so a copy for another bot goes to its latest chat.
    // Nor is a chosen chat kept when the copy's owner is not in it.
    const { chatId: picked, ...rest } = entry.deliver ?? {};
    const keep = botId === chat.botId && (picked === undefined || this.ws.inChat(picked, personOf(createdBy)));
    const deliver = entry.deliver && (keep ? entry.deliver : rest);
    return this.create(
      { botId, name: entry.name, prompt: entry.prompt, cadence: entry.cadence, timezone: entry.timezone, deliver, ...(entry.notify === false && { notify: false }) },
      now,
      createdBy,
    );
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
    };
  }
  /** The line added to a routine run's turn so the bot writes for its destination. "" for the default. */
  destinationNote(chat, scheduleId) {
    const entry = chat.schedules?.find((s) => s.id === scheduleId && s.routine);
    return (entry?.deliver && DESTINATION_NOTES[entry.deliver.to]) || "";
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
    const latest = this.ws.state.chats.filter((c) => !chatProblem(c, botId, this.ws, person)).sort((a, b) => b.time - a.time)[0];
    if (latest) return latest;
    const made = this.ws.chat(this.ws.createChat(botId, title));
    if (createdBy) made.createdBy = createdBy;
    return made;
  }
  /** Sends a finished routine run's reply where its routine says. A failure is noted on the run. */
  deliver(chat, run) {
    if (run?.scheduleId == null || run.status !== "Completed" || run.delivery) return;
    const entry = chat.schedules?.find((s) => s.id === run.scheduleId && s.routine);
    if (!entry?.deliver || entry.deliver.to === "none") return;
    const text = chat.messages.findLast((m) => m.runId === run.id && m.role === "assistant" && !m.interim)?.text?.trim();
    if (!text) return;
    const { to, category } = entry.deliver;
    try {
      if (to === "chat") {
        const target = this.chatTarget(chat.botId, entry.deliver, entry.name, entry.createdBy ?? chat.createdBy);
        const time = Date.now();
        target.messages.push({ role: "assistant", text, time });
        target.time = time;
        target.unread = true;
        // The message was written in the routine's own chat, so the session behind this chat has
        // not seen it. It is told at its next turn (Workspace.send), or the bot would not know
        // what the person is answering.
        target.posted = [...(target.posted ?? []), { text: text.slice(0, 6000), from: entry.name, time }].slice(-5);
        run.delivery = { to, chatId: target.id };
      } else {
        const item = this.ws.board.post(chat.botId, { kind: to, ...boardText(text), category, source: entry.name });
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
    const owned = (id) => {
      const found = this.find(String(id ?? ""));
      if (found.chat.botId !== bot.id) throw new Error("Unknown routine for this bot");
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
          return JSON.stringify(await handler(args));
        },
      });
    const str = { type: "string" };
    const cadenceProps = {
      cadence: { enum: CADENCES },
      time: { type: "string", description: "24-hour HH:MM, for once, daily, weekdays and weekly" },
      days: { type: "array", items: { enum: DAY_NAMES }, description: "For weekly" },
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
        properties: { to: { enum: DELIVER_TARGETS }, chatId: str, category: { enum: GOAL_CATEGORIES } },
        required: ["to"],
        additionalProperties: false,
      },
    };
    const notifyProp = { notify: { type: "boolean", description: "false makes the routine run quietly: no notification on the computer or the phone when it finishes. Leave it out to notify, which is the usual way." } };
    // "Remind me here": a result sent to a chat goes to the chat it was asked in, when that chat can take it.
    // A routine a bot makes belongs to whoever the bot is working for: the member who wrote this
    // turn's message, else the member whose chat this is, else the owner.
    const maker = task?.author?.memberId ?? chat.createdBy;
    const here = (deliver) => (deliver?.to === "chat" && deliver.chatId === undefined && !chatProblem(chat, bot.id, ws, personOf(maker)) ? { ...deliver, chatId: chat.id } : deliver);
    const cadenceOf = (a) =>
      a.cadence ? { kind: a.cadence, time: a.time, days: a.days, date: a.date, cron: a.cron } : undefined;
    const id = { id: { type: "string", description: "Routine id from routine_list" } };
    const tools = [
      tool("routine_list", "List your routines: scheduled tasks that run your instructions in their own chat.", {}, [], () =>
        this.list(bot.id).map(({ chat, entry }) => this.view(chat, entry)),
      ),
    ];
    // A scheduled, routine or task run can't create routines, so unattended work can't multiply itself.
    if (!run?.scheduleId && !run?.taskId)
      tools.push(
        tool(
          "routine_create",
          "Create a routine when the person asks you to do something on a schedule or to remind them later. " +
            "The routine runs `instructions` as a new turn in its own chat at each time, and `deliver` can send the result to your chat with the person, their Feed, Ideas or Goals. Write instructions as what you should do then, e.g. \"Remind the person to review their inbox.\" " +
            "Today is " + new Date().toISOString().slice(0, 10) + ".",
          { name: str, instructions: str, ...cadenceProps, ...deliverProp, ...notifyProp },
          ["name", "instructions", "cadence"],
          (a) => {
            if (this.list(bot.id).length >= 25) throw new Error("You already have 25 routines. Ask the person which to remove first.");
            const cadence = cadenceOf(a);
            if (cadence?.kind === "cron" && !slowEnough(cadence.cron))
              throw new Error("Bots can't create routines that run more often than every 15 minutes. The person can set that up under Routines.");
            const chatId = this.create({ botId: bot.id, name: a.name, prompt: a.instructions, cadence, timezone: a.timezone, deliver: here(a.deliver), notify: a.notify }, undefined, maker);
            const found = this.find(chatId);
            return this.view(found.chat, found.entry);
          },
        ),
      );
    tools.push(
      tool(
        "routine_update",
        "Change one of your routines: its name, instructions, schedule or where its result goes (deliver). Supply only what changes; a new schedule needs cadence and its fields.",
        { ...id, name: str, instructions: str, ...cadenceProps, ...deliverProp, ...notifyProp },
        ["id"],
        (a) => {
          owned(a.id);
          const entry = this.update(a.id, { name: a.name, prompt: a.instructions, cadence: cadenceOf(a), timezone: a.timezone, deliver: here(a.deliver), notify: a.notify });
          return this.view(ws.chat(a.id), entry);
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
        const { entry } = owned(a.id);
        await this.remove(a.id);
        return { deleted: entry.name };
      }),
    );
    return tools;
  }
}

/** Sends a schedule entry's prompt as a turn in its chat; the run carries `scheduleId`. */
export function dispatch(ws, chat, entry, trigger) {
  const title = chat.title;
  const turn = ws.send(chat.id, entry.prompt, {
    trigger,
    scheduleId: entry.id,
    title: entry.routine ? entry.name : "Scheduled · " + entry.prompt.slice(0, 80),
  });
  // The first message would otherwise rename the routine chat after its prompt.
  if (entry.routine && chat.title !== title) {
    chat.title = title;
    ws.save();
  }
  return turn;
}
