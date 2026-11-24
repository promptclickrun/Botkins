// Reminders: one plain notification when something is left waiting on a person. No model, and no Proactive
// agent is needed. A question or approval still open after 15 minutes, a routine or task run that ended
// needing the person, and a turn that stopped with steps of its plan left each get one, titled with the
// bot's name: "Patch is waiting on your answer", "Patch stopped with 2 steps left".
//
// Each person hears only of what is theirs (`Proactive.scope`). A reminder is sent once for each thing,
// never in quiet hours (it waits for them to end), and at most `REMINDER_CAP` times a day for each person.
// It never doubles an alert: where one of the person's own bots watches for the same kind of thing, the bot
// gets to it first, and what a bot told them is not said again here. The computer's own notification is the
// owner's (desktop/notify.mjs); a phone gets it from the link, which reads `recent()` in the snapshot and
// sends it to that person's devices by their own choices (desktop/link/push.mjs).
//
// One switch: Settings › Notifications › Reminders (`settings.notifications.reminders`, on from the start).
import { firstLine, inQuietHours } from "./notify.mjs";
import { localZone } from "./routines.mjs";
import { dayOf, latestRuns, openSteps, REQUEST_WAIT, runFailed, RUN_WINDOW } from "./proactive.mjs";

const OWNER = "owner";
/** The most reminders one person gets in a day. */
export const REMINDER_CAP = 6;
/** How long a sent reminder stays in the snapshot for the link to pick up. */
const RECENT_MS = 10 * 60_000;
const SENT_DAYS = 14;
/** How much longer than its own cadence a watching bot is given to raise a thing first, in minutes. */
const HEAD_START = 5;

const steps = (n) => n + (n === 1 ? " step" : " steps");

/**
 * What is waiting on a person now, in the words of its reminder. Pure: tests call it with a plain state.
 * `scope` is what the person may hear of (`Proactive.scope`). Each item: `{ key, kind, botId, chatId, title, body, at }`,
 * where `key` is the one the Proactive agent's gate uses for the same thing, `kind` is the watch that covers
 * it ("requests" or "runs") and `at` is since when it waits. `ownerOnly` marks a request only the owner can answer.
 */
export function waiting(state, requests, now, scope) {
  const bots = new Map((state.bots ?? []).map((bot) => [bot.id, bot]));
  const chats = new Map((state.chats ?? []).map((chat) => [chat.id, chat]));
  const named = (botId) => bots.get(botId)?.name ?? "A bot";
  const out = [];
  for (const request of requests ?? []) {
    const at = request.time ?? request.createdAt;
    if (!scope.request(request) || at == null || now - at < REQUEST_WAIT) continue;
    const chat = chats.get(request.chatId);
    const botId = request.botId ?? chat?.botId;
    const ownerOnly = request.kind === "permission" || request.kind === "secure";
    const on = request.kind === "permission" ? "your approval" : request.kind === "secure" ? "a secure input" : "your answer";
    out.push({ key: "request:" + request.id, kind: "requests", botId, chatId: request.chatId, title: named(botId) + " is waiting on " + on, body: firstLine(request.title) || chat?.title || "Open Botkins to answer.", at, ...(ownerOnly && { ownerOnly: true }) });
  }
  const latest = latestRuns(state.runs);
  for (const run of state.runs ?? []) {
    const open = openSteps(run);
    const failed = runFailed(run) && (run.scheduleId != null || run.taskId);
    const at = run.finished ?? run.time ?? 0;
    // Only the last thing that happened in a chat still waits: a later run means the person, or the routine, went on.
    if ((!failed && !open) || latest.get(run.chatId) !== run || now - at < REQUEST_WAIT || now - at > RUN_WINDOW || !scope.run(run)) continue;
    const chat = chats.get(run.chatId);
    // A routine the person made quiet says nothing, here either.
    if (failed && chat?.schedules?.find((entry) => entry.id === run.scheduleId)?.notify === false) continue;
    const botId = chat?.botId;
    if (failed) out.push({ key: "run:" + run.id, kind: "runs", botId, chatId: run.chatId, title: named(botId) + " needs you", body: firstLine((run.title || chat?.title || "A run") + (run.detail ? ": " + firstLine(run.detail) : "")), at });
    else out.push({ key: "stopped:" + run.id, kind: "runs", botId, chatId: run.chatId, title: named(botId) + " stopped with " + steps(open) + " left", body: firstLine(chat?.title || run.title) || "Open the chat to go on.", at });
  }
  return out;
}

export class Reminders {
  constructor(ws) {
    this.ws = ws;
    /** Sent lately, newest last: what the link reads from the snapshot. Not saved: a restart sends nothing twice (`sent` is saved). */
    this.sentLately = [];
  }
  /** Each person's own record: `{ day, count, sent: { key: time } }`, kept with the Proactive agent's state. */
  get state() {
    return (this.ws.state.proactive.reminders ??= {});
  }
  get on() {
    return this.ws.state.settings.notifications?.reminders !== false;
  }
  /** Everyone who can be waited on: the owner and each team member. */
  people() {
    return [OWNER, ...(this.ws.teamOf()?.members ?? []).map((member) => member.id)];
  }
  /** The reminders sent in the last few minutes. */
  recent(now = Date.now()) {
    this.sentLately = this.sentLately.filter((reminder) => now - reminder.sentAt < RECENT_MS);
    return this.sentLately.map((reminder) => ({ ...reminder }));
  }
  /** Looks for what is waiting and sends what is due. Answers what it sent. Called with the schedulers, every few seconds. */
  tick(now = Date.now()) {
    const { ws } = this;
    if (!this.on || ws.closing) return [];
    const zone = localZone();
    // Held, not dropped: what still waits when quiet hours end is sent then.
    if (inQuietHours(ws.state.settings.notifications?.quietHours, new Date(now), zone)) return [];
    const requests = ws.interactions?.snapshot?.() ?? [];
    const day = dayOf(now, zone);
    const out = [];
    for (const person of this.people()) {
      const due = waiting(ws.state, requests, now, ws.proactive.scope(person));
      const held = this.state[person];
      if (!due.length && !held) continue;
      const own = (this.state[person] ??= { sent: {} });
      own.sent ??= {};
      if (own.day !== day) Object.assign(own, { day, count: 0 });
      for (const [key, at] of Object.entries(own.sent)) if (now - at > SENT_DAYS * 86400_000) delete own.sent[key];
      if (!due.length) continue;
      const told = ws.proactive.told(person, now);
      for (const item of due) {
        if ((own.count ?? 0) >= REMINDER_CAP) break;
        if (own.sent[item.key] || told.has(item.key)) continue;
        // One of this person's own bots watches for this: it may raise it with an offer to help. Give it its turn first.
        const every = ws.proactive.watching(person, item.kind);
        if (every && now - item.at < REQUEST_WAIT + (every + HEAD_START) * 60_000) continue;
        own.sent[item.key] = now;
        own.count = (own.count ?? 0) + 1;
        const { kind: _kind, at: _at, ...words } = item;
        const reminder = { ...words, person, sentAt: now };
        this.sentLately.push(reminder);
        out.push(reminder);
      }
    }
    if (out.length) {
      ws.save();
      for (const reminder of out) ws.events?.emit("reminder", reminder);
      ws.notify?.();
    }
    return out;
  }
}
