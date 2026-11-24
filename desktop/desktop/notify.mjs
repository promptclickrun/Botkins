// Desktop notifications. `decide` is pure so the rules are testable without Electron;
// `Notifier` connects it to workspace events and a Notification class supplied by main.mjs.
import { resolveRoutineTargets } from "./link/notify-targets.mjs";
import { defaultSettings } from "./preferences.mjs";
import { mentionTitle } from "./human-mentions.mjs";

const minutes = (text) => {
  const [h, m] = text.split(":").map(Number);
  return h * 60 + m;
};

/** Whether `date` falls in the quiet window. The start is inside, the end is not; equal times make an empty window. */
export function inQuietHours(quiet, date = new Date(), timeZone) {
  if (!quiet?.enabled) return false;
  const from = minutes(quiet.from),
    to = minutes(quiet.to);
  if (from === to) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const now = +parts.hour * 60 + +parts.minute;
  return from < to ? from <= now && now < to : now >= from || now < to;
}

/** The first non-empty line of a reply, trimmed of Markdown markers and shortened. */
export function firstLine(text, max = 140) {
  const line =
    String(text ?? "")
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s`]+/, "").trim())
      .find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** What a proactive alert's notification offers, where the system shows buttons on one. */
export const ALERT_ACTIONS = [
  { action: "take", text: "Take care of it" },
  { action: "later", text: "Not now" },
];

/**
 * Decides whether an event becomes a notification.
 * event: {type: "turn", chat, run, bot, alert?}, {type: "request", request, bot, chat} or
 * {type: "reminder", reminder, bot}. `alert` is what a delivered proactive alert carries (`{ runId, offer? }`).
 * Returns {title, body, chatId, alert?} or null.
 */
export function decide(event, { settings, focused, now = new Date(), timeZone, mine = true, resolved } = {}) {
  const prefs = { ...defaultSettings.notifications, ...settings?.notifications };
  if (inQuietHours(prefs.quietHours, now, timeZone)) return null;
  const botName = event.bot?.name ?? "Botkins";
  if (event.type === "joinRequest") {
    if (!prefs.requests || focused) return null;
    return {
      title: (event.request.person || event.request.name) + " wants to join your team",
      body: "Review the request in Settings › Team.",
      settings: "Team:Requests",
    };
  }
  if (event.type === "request") {
    const ownersToAnswer = event.request.kind === "permission" || event.request.kind === "secure";
    // A question in a chat the owner is not one of the people of is for those people. A request
    // only the owner can answer still alerts the owner: nobody else can unblock the bot.
    if (!mine && !ownersToAnswer) return null;
    const memberApproval = event.request.askedBy && ownersToAnswer;
    if (!prefs.requests || (focused && !memberApproval)) return null;
    return {
      title: botName + (event.request.kind === "permission" ? " needs your approval" : " has a question"),
      body: firstLine(event.request.title) || "Open Botkins to respond.",
      chatId: event.request.chatId,
    };
  }
  if (event.type === "reminder") {
    // One plain nudge for something left waiting (desktop/reminders.mjs). It is sent once, so the window being in front doesn't hold it back.
    if (!mine || prefs.reminders === false) return null;
    return { title: event.reminder.title, body: event.reminder.body, chatId: event.reminder.chatId };
  }
  if (event.type === "mention") {
    if (!mine || !prefs.replies || focused || !event.mention?.chatId) return null;
    return {
      title: mentionTitle(event.mention.by),
      body: firstLine(event.mention.preview) || "Open Botkins to see it.",
      chatId: event.mention.chatId,
    };
  }
  if (event.type !== "turn") return null;
  const { chat, run } = event;
  if (!run || run.notify === false || run.status === "Stopped" || run.status === "Working" || chat?.temporary) return null;
  const failed = run.status !== "Completed";
  const routine = run.scheduleId != null || run.trigger === "scheduled";
  if (run.status === "Completed" && (run.silent || (routine && run.noOutput === true))) return null;
  const schedule = run.scheduleId != null ? chat?.schedules?.find((s) => s.id === run.scheduleId) : null;
  // A no-output routine is deliberately silent even when its saved notify flag is old or absent.
  if (schedule?.deliver?.to === "none") return null;
  // A proactive check goes to the one person it looked out for, never to routine targets; set to
  // deliver quietly, it puts the alert in their chat and says nothing.
  if (run.proactive && schedule?.notify === false) return null;
  const target =
    routine && !run.panelId && !run.proactive
      ? (resolved ?? resolveRoutineTargets({ run, chat, entry: schedule }))
      : null;
  if (run.panelId) {
    // Panel refreshes are frequent and quiet; only a failed scheduled one needs the person.
    if (!mine || !(routine && failed && prefs.routines)) return null;
  } else if (routine) {
    if (!prefs.routines) return null;
    if (target?.explicit) {
      if (target.silent || !target.host) return null;
    } else if (!mine) {
      return null;
    }
  } else if (!mine || !prefs.replies || focused) return null;
  const reply = chat?.messages?.findLast((m) => m.runId === run.id && m.role !== "user" && !m.interim);
  // A bot that looks out for the person speaks under its own name: the title is the bot's name alone and the
  // text is the alert's first line. A check that failed is in the bot's Proactive log, not a notification.
  if (run.proactive) {
    if (failed || !run.delivery) return null;
    return { title: botName, body: firstLine(reply?.text) || "Has something for you.", chatId: run.delivery?.chatId ?? chat?.id ?? run.chatId, ...(event.alert && chat?.botId && { alert: { botId: chat.botId, ...event.alert } }) };
  }
  const customMessage = !failed ? target?.message : null;
  return {
    title: botName + " · " + (routine ? run.title : chat?.title || "Reply"),
    body: failed
      ? (run.status === "Needs you" ? "Failed: " : run.status + ": ") + (firstLine(run.detail) || "Open the chat for details.")
      : firstLine(customMessage || reply?.text) || "Finished.",
    // A routine whose result went to another chat opens that chat.
    chatId: run.delivery?.chatId ?? chat?.id ?? run.chatId,
  };
}

export class Notifier {
  /**
   * @param workspace a Workspace
   * @param options.Notification Electron's Notification class
   * @param options.focused () => boolean, whether the window is focused
   * @param options.open (chatId) => void, shows the window on that chat
   * @param options.openSettings (tab) => void, opens one Settings section
   * @param options.act ({ botId, runId }, "take" | "later") => { chatId? }, what a proactive alert's button does
   */
  constructor(workspace, { Notification, focused, open, openSettings, act }) {
    this.act = act;
    this.ws = workspace;
    this.Notification = Notification;
    this.focused = focused;
    this.open = open;
    this.openSettings = openSettings;
    // Electron drops click handlers on notifications that are garbage-collected.
    this.live = new Set();
    // Runs that already notified the owner via an explicit @mention skip the duplicate generic reply alert.
    this.mentionedRuns = new Set();
    workspace.events.on("turn", ({ chat, run }) => {
      if (run?.id && this.mentionedRuns.delete(run.id)) return;
      this.consider({ type: "turn", chat, run, bot: this.bot(chat?.botId), ...(run?.proactive && { alert: this.alertOf(run) }) });
    });
    // A plain reminder is for one person. The computer's own notification is the owner's.
    workspace.events.on("reminder", (reminder) => reminder.person === "owner" && this.consider({ type: "reminder", reminder, bot: this.bot(reminder.botId) }));
    workspace.events.on("mention", (mention) => {
      if (mention?.person !== "owner") return;
      if (mention.runId) {
        this.mentionedRuns.add(mention.runId);
        if (this.mentionedRuns.size > 100) this.mentionedRuns.delete(this.mentionedRuns.values().next().value);
      }
      this.consider({ type: "mention", mention });
    });
    workspace.events.on("request", (request) =>
      this.consider({ type: "request", request, bot: this.bot(request.botId) }),
    );
  }
  bot(id) {
    return this.ws.state.bots.find((b) => b.id === id);
  }
  /** What a delivered proactive alert carries, read where it was delivered: a chat message or a Feed card. */
  alertOf(run) {
    const { chatId, itemId } = run.delivery ?? {};
    const held = chatId ? this.ws.state.chats.find((c) => c.id === chatId)?.messages.find((m) => m.proactiveRunId === run.id) : this.ws.state.board?.find?.((item) => item.id === itemId);
    return held?.alert;
  }
  consider(event) {
    try {
      if (event.run?.proactive) {
        const { chat } = event;
        const person = chat?.createdBy ?? "owner";
        if (!chat || !this.ws.proactive.eligible(person, chat.botId) || person !== "owner") return;
      }
      // A chat's alerts go to its people only: the computer's own are for its owner.
      const chatId =
        event.type === "turn"
          ? (event.chat?.id ?? event.run?.chatId)
          : event.type === "reminder"
            ? undefined
            : event.type === "mention"
              ? event.mention?.chatId
              : event.request?.chatId;
      const mine = !chatId || typeof this.ws.notifiesOwner !== "function" || this.ws.notifiesOwner(chatId);
      const resolved =
        event.type === "turn" && typeof this.ws.resolveRoutineTargets === "function"
          ? this.ws.resolveRoutineTargets(event.chat, event.run)
          : undefined;
      const note = decide(event, { settings: this.ws.state.settings, focused: this.focused(), mine, resolved });
      if (note) this.show(note);
    } catch (error) {
      console.error("Notification:", error.message);
    }
  }
  show({ title, body, chatId, settings, alert }) {
    if (!this.Notification?.isSupported?.()) return false;
    // Where the system shows buttons on a notification (macOS), an alert with an offer has them. Elsewhere a click opens the alert.
    const actions = alert?.offer && this.act ? ALERT_ACTIONS : [];
    const n = new this.Notification({ title, body, silent: false, ...(actions.length && { actions: actions.map(({ text }) => ({ type: "button", text })) }) });
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on("action", (_event, index) => {
      drop();
      const chosen = actions[index]?.action;
      if (!chosen) return;
      try {
        const result = this.act(alert, chosen);
        if (chosen === "take" && result?.chatId) this.open(result.chatId);
      } catch (error) {
        console.error("Notification:", error.message);
      }
    });
    n.on("click", () => {
      drop();
      if (chatId) this.open(chatId);
      else if (settings) this.openSettings?.(settings);
    });
    n.on("close", drop);
    n.on("failed", drop);
    n.show();
    return true;
  }
  /** Settings → Notifications → Send test. Ignores toggles and quiet hours so the person can see one. */
  test() {
    if (!this.Notification?.isSupported?.())
      throw new Error("Notifications aren't supported on this computer.");
    this.show({ title: "Botkins", body: "Notifications are on. Replies and routines will appear like this." });
  }
}
