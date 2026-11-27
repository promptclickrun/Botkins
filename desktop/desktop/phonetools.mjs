// Tools a bot runs on the person's phone: its calendar, contacts, health data, location, photos
// and a mail draft. The phone link carries them (desktop/link/device.mjs). Which ones exist is the
// person's choice on the phone, source by source (Tools › Device access there: Off, Read, or Read
// and interact), so the list here is whatever some paired phone allows right now.
//
// Approval follows the phone's own switches:
//   a tool that only looks   runs without asking again: switching the source to Read was the consent.
//   a tool that adds or      asks first, at whatever level the chat is set to, like any other tool
//   changes something        that changes something. It isn't offered at all in a turn nobody is
//                            watching (a routine, a panel refresh, a task, a teammate's help),
//                            where it would wait for an approval nobody can give.
//
// The tools' names, descriptions and parameters are the link's (DEVICE_TOOLS in device.mjs). The
// descriptions say what comes back; text that comes from the phone is the person's data and other
// people's writing, never instructions.
import { defineTool } from "./providers/index.mjs";

/** A tool name the link may hand over: "phone_…", small letters and underscores, 50 characters at most. */
const NAME = /^phone_[a-z_]{1,44}$/;
// How often a waiting call looks whether its turn was stopped.
const WATCH_MS = 500;

/** The tools of the link's list that are well formed. Anything else is left out, never repaired. */
export function listedPhoneTools(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((tool) => {
    if (!tool || typeof tool.name !== "string" || !NAME.test(tool.name) || seen.has(tool.name)) return false;
    if (typeof tool.description !== "string" || !tool.description.trim()) return false;
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object") return false;
    seen.add(tool.name);
    return true;
  });
}

export class PhoneTools {
  /**
   * @param ws      The workspace.
   * @param source  () => { tools(), call(name, args, { signal, botId, chatId }) } | null: the phone
   *                link, once there is one. Tests pass a stand-in.
   */
  constructor(ws, source = () => null) {
    this.ws = ws;
    this.source = typeof source === "function" ? source : () => source;
  }
  /** What some paired phone allows now: [{ name, description, parameters, readOnly, source }]. */
  listed() {
    try {
      return listedPhoneTools(this.source()?.tools?.());
    } catch {
      // A link that is locked or still starting has no tools to offer.
      return [];
    }
  }
  /** For Settings and the app's state: how many tools a phone offers, and how many of them only look. */
  summary() {
    const list = this.listed();
    return { tools: list.length, readOnly: list.filter((tool) => tool.readOnly === true).length };
  }
  /** The session tools for one turn. */
  tools(bot, chat, run, task) {
    const attended = !(chat.helper || run?.panelId || run?.scheduleId || run?.taskId || run?.workflowRunId);
    return this.listed()
      .filter((tool) => tool.readOnly === true || attended)
      .map((tool) =>
        defineTool(tool.name, {
          description: tool.description,
          parameters: tool.parameters,
          // Only a tool the link itself marks as looking skips the approval.
          skipPermission: tool.readOnly === true,
          handler: async (args) => {
            const active = () => !(task?.stopped || this.ws.closing || !run || this.ws.active?.get(chat.id) !== task);
            if (!active()) throw new Error("This turn is no longer active");
            const link = this.source();
            if (!link?.call) throw new Error("The phone link isn't running.");
            // A phone can take most of a minute to answer: stopping the turn stops the wait.
            const gone = new AbortController();
            const watch = setInterval(() => !active() && gone.abort(), WATCH_MS);
            try {
              const result = await link.call(tool.name, args && typeof args === "object" ? args : {}, { signal: gone.signal, botId: bot?.id, chatId: chat.id });
              return typeof result === "string" ? result : JSON.stringify(result ?? null);
            } finally {
              clearInterval(watch);
            }
          },
        }),
      );
  }
}
