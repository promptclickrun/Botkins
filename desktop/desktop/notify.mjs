// Desktop notifications. `decide` is pure so the rules are testable without Electron;
// `Notifier` connects it to workspace events and a Notification class supplied by main.mjs.
import { defaultSettings } from "./preferences.mjs";

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

/**
 * Decides whether an event becomes a notification.
 * event: {type: "turn", chat, run, bot} or {type: "request", request, bot, chat}.
 * Returns {title, body, chatId} or null.
 */
export function decide(event, { settings, focused, now = new Date(), timeZone } = {}) {
  const prefs = { ...defaultSettings.notifications, ...settings?.notifications };
  if (inQuietHours(prefs.quietHours, now, timeZone)) return null;
  const botName = event.bot?.name ?? "Botkins";
  if (event.type === "request") {
    if (!prefs.requests || focused) return null;
    return {
      title: botName + (event.request.kind === "permission" ? " needs your approval" : " has a question"),
      body: firstLine(event.request.title) || "Open Botkins to respond.",
      chatId: event.request.chatId,
    };
  }
  if (event.type !== "turn") return null;
  const { chat, run } = event;
  if (!run || run.status === "Stopped" || run.status === "Working" || chat?.temporary) return null;
  const failed = run.status !== "Completed";
  const routine = run.scheduleId != null || run.trigger === "scheduled";
  if (routine && run.status === "Completed" && run.noOutput === true) return null;
  // A no-output routine is deliberately silent even when its saved notify flag is old or absent.
  if (run.scheduleId != null && chat?.schedules?.find((s) => s.id === run.scheduleId)?.deliver?.to === "none") return null;
  // A routine the person set to run quietly says nothing, whatever came of the run.
  if (run.scheduleId != null && chat?.schedules?.find((s) => s.id === run.scheduleId)?.notify === false) return null;
  if (run.panelId) {
    // Panel refreshes are frequent and quiet; only a failed scheduled one needs the person.
    if (!(routine && failed && prefs.routines)) return null;
  } else if (routine) {
    if (!prefs.routines) return null;
  } else if (!prefs.replies || focused) return null;
  const reply = chat?.messages?.findLast((m) => m.runId === run.id && m.role !== "user");
  return {
    title: botName + " · " + (routine ? run.title : chat?.title || "Reply"),
    body: failed
      ? (run.status === "Needs you" ? "Failed: " : run.status + ": ") + (firstLine(run.detail) || "Open the chat for details.")
      : firstLine(reply?.text) || "Finished.",
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
   */
  constructor(workspace, { Notification, focused, open }) {
    this.ws = workspace;
    this.Notification = Notification;
    this.focused = focused;
    this.open = open;
    // Electron drops click handlers on notifications that are garbage-collected.
    this.live = new Set();
    workspace.events.on("turn", ({ chat, run }) =>
      this.consider({ type: "turn", chat, run, bot: this.bot(chat?.botId) }),
    );
    workspace.events.on("request", (request) =>
      this.consider({ type: "request", request, bot: this.bot(request.botId) }),
    );
  }
  bot(id) {
    return this.ws.state.bots.find((b) => b.id === id);
  }
  consider(event) {
    try {
      const note = decide(event, { settings: this.ws.state.settings, focused: this.focused() });
      if (note) this.show(note);
    } catch (error) {
      console.error("Notification:", error.message);
    }
  }
  show({ title, body, chatId }) {
    if (!this.Notification?.isSupported?.()) return false;
    const n = new this.Notification({ title, body, silent: false });
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on("click", () => {
      drop();
      if (chatId) this.open(chatId);
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
