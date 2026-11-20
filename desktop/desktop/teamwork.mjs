// Teamwork: in a chat with one bot, that bot can bring in other bots for the parts they do best.
// The asking bot calls ask_teammate; the teammate works in its own session (its own instructions,
// model, skills and memory) and its reply comes back as the tool's result. The asking bot still
// writes the person's answer. Each ask is recorded on the turn (run.teamwork) so the chat can
// show who was asked, what they are doing and what they answered.
//
// Rules:
// - Settings › Teamwork turns it on or off for the whole app; a bot can be kept out of it.
// - A teammate needs access to the chat's project to be asked there.
// - A teammate gets only the message written for it, never the chat.
// - A teammate can't ask further teammates, so requests never loop.
// - Up to 8 asks per reply, and the same message is never sent to the same teammate twice.
// - Anything a teammate needs approved is asked in the chat it was called from.
import { randomUUID } from "node:crypto";
import { defineTool } from "./providers/provider.mjs";
import { isGroup } from "./groups.mjs";
import { canUseProject } from "./access.mjs";
import { recordActivity } from "./activity.mjs";
import { recordCanvas } from "./canvas.mjs";

export const MAX_TEAM = 16;
export const MAX_ASKS = 8;
// Shorter than a turn's own ten minutes, so a slow teammate fails its ask before the turn times out.
const ASK_TIMEOUT = 8 * 60 * 1000;
const MESSAGE_MAX = 16000;
const REPLY_MAX = 32000;

/** The session a teammate keeps for one chat, so follow-up asks there build on earlier ones. */
export const helperSessionId = (chat, botId) => chat.id + "-team-" + botId;

const line = (bot) => "- " + bot.name + ": " + bot.role + "." + (bot.summary ? " " + bot.summary.trim().slice(0, 200) : "");

export class Teamwork {
  constructor(ws) {
    this.ws = ws;
  }
  get enabled() {
    return this.ws.state.settings.teamwork !== false;
  }
  /** The bots this one may ask from this chat. Empty when Teamwork doesn't apply. */
  roster(bot, chat) {
    if (!this.enabled || bot.teamwork === false || isGroup(chat) || chat.group || chat.helper) return [];
    const project = this.ws.projects.projectOf(chat);
    return this.ws.state.bots
      .filter((b) => b.id !== bot.id && b.teamwork !== false && !b.hidden && (!project || canUseProject(this.ws.state, b, project)))
      .slice(0, MAX_TEAM);
  }
  /** What a bot is told about its team. "" when it has none here. */
  brief(bot, chat) {
    const team = this.roster(bot, chat);
    if (!team.length) return "";
    return (
      "\n\n## Your team\nYou're " + bot.name + ". Your teammates:\n" + team.map(line).join("\n") +
      "\nUse ask_teammate when a teammate fits a substantial part of the request. Split independent work across roles. Handle quick requests yourself or when the person asks for you. Say whom you're asking and why, share only the context they need, and combine their results into your reply."
    );
  }
  /** What a teammate is told while it works on an ask. */
  helperNote(asker) {
    return (
      "\n\nYour teammate " + asker.name + " (" + asker.role + ") is asking for your help on the person's behalf. " +
      "Do the work and reply to " + asker.name + " with the result; they will pass it on. " +
      "You can't ask the person anything from here, and you can't bring in other teammates. If something is missing, or another teammate fits better, say so in your reply."
    );
  }
  tools(bot, chat, run, task) {
    if (run?.panelId) return [];
    const team = this.roster(bot, chat);
    if (!team.length) return [];
    return [
      defineTool("ask_teammate", {
        description:
          "Ask one of your teammates (" + team.map((b) => b.name).join(", ") + ") to do part of the work and wait for their reply. " +
          "They see only your message, so include the goal, the facts they need and what to send back. To ask several teammates at once, call this tool once for each in the same step.",
        parameters: {
          type: "object",
          properties: {
            teammate: { type: "string", description: "The teammate's name." },
            message: { type: "string", description: "What you need them to do, with the facts they need." },
            expecting: { type: "string", description: "What you need back, such as a short summary, a list or a decision." },
            constraints: { type: "string", description: "Limits their answer must respect." },
          },
          required: ["teammate", "message"],
          additionalProperties: false,
        },
        handler: (args) => this.ask(chat, bot, run, task, args ?? {}),
      }),
    ];
  }
  async ask(chat, bot, run, task, { teammate, message, expecting, constraints }) {
    if (!run || task.stopped || this.ws.closing || this.ws.active.get(chat.id) !== task)
      throw new Error("This turn is no longer active");
    const team = this.roster(bot, chat);
    const wanted = String(teammate ?? "").trim().replace(/^@/, "").toLowerCase();
    const helper = team.find((b) => b.name.toLowerCase() === wanted) ?? team.find((b) => b.id === wanted);
    if (!helper)
      throw new Error("No teammate is named “" + String(teammate ?? "").slice(0, 60) + "”. Your teammates: " + (team.map((b) => b.name).join(", ") || "none") + ".");
    if (typeof message !== "string" || !message.trim()) throw new Error("Write the message for " + helper.name + ".");
    if (message.length > MESSAGE_MAX) throw new Error("Keep the message under " + MESSAGE_MAX.toLocaleString("en-US") + " characters.");
    const body = message.trim();
    const asks = (run.teamwork ??= []);
    if (asks.length >= MAX_ASKS) throw new Error("You can ask teammates up to " + MAX_ASKS + " times in one reply. Answer with what you have.");
    if (asks.some((a) => a.botId === helper.id && a.message === body))
      throw new Error("You already sent " + helper.name + " this exact message in this reply. Use the answer you got.");
    const optional = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : undefined);
    const entry = {
      id: randomUUID(),
      botId: helper.id,
      fromBotId: bot.id,
      message: body,
      ...(optional(expecting) && { expecting: optional(expecting) }),
      status: "waiting",
      started: Date.now(),
    };
    asks.push(entry);
    this.ws.notify();
    const prompt =
      "Message from " + bot.name + " (" + bot.role + "):\n" + body +
      (entry.expecting ? "\n\nWhat they need back: " + entry.expecting : "") +
      (optional(constraints) ? "\n\nConstraints: " + optional(constraints) : "");
    try {
      // One teammate works on one ask at a time; a second ask to it waits its turn.
      const reply = await this.ws.locked(helperSessionId(chat, helper.id), () => this.helperTurn(chat, bot, helper, run, task, entry, prompt));
      entry.reply = reply.slice(0, REPLY_MAX);
      entry.status = "answered";
      return JSON.stringify({ teammate: helper.name, reply });
    } catch (error) {
      entry.status = task.stopped || task.ended ? "stopped" : "failed";
      entry.error = String(error.message).slice(0, 600);
      throw new Error(helper.name + " couldn't answer: " + entry.error);
    } finally {
      entry.finished = Date.now();
      delete entry.intent;
      for (const step of entry.steps ?? []) if (step.status === "Running") step.status = "Interrupted";
      this.ws.notify();
    }
  }
  /** One teammate's work on one ask. Returns its reply. */
  async helperTurn(chat, asker, helper, run, task, entry, prompt) {
    const stopped = () => new Error("the reply was stopped");
    const over = () => task.stopped || task.ended;
    if (over()) throw stopped();
    entry.status = "working";
    this.ws.notify();
    chat.helpers ??= {};
    const record = (chat.helpers[helper.id] ??= { established: false });
    // The teammate's view of the chat: the chat's id for approvals, its own session and instructions,
    // and the chat's project so it has that context. Writes reach the real records.
    const view = {
      id: chat.id,
      sessionId: helperSessionId(chat, helper.id),
      botId: helper.id,
      title: chat.title,
      approval: chat.approval,
      messages: [],
      projectId: chat.projectId,
      helper: true,
      extraInstructions: this.helperNote(asker),
      get established() {
        return record.established;
      },
      set established(value) {
        record.established = value;
      },
      get sessionProvider() {
        return record.sessionProvider;
      },
      set sessionProvider(value) {
        record.sessionProvider = value;
      },
      get approvals() {
        return chat.approvals;
      },
      set approvals(value) {
        chat.approvals = value;
      },
    };
    let session, off, rootEventId;
    let failed = false;
    try {
      session = await this.ws.openSession(view, helper, run, task);
      (task.helpers ??= new Set()).add(session);
      if (over()) throw stopped();
      off = session.on((event) => {
        this.ws.artifactEvents.tool(chat, asker.id, run, event, entry);
        if (event.type === "user.message" && !event.agentId && rootEventId == null) rootEventId = event.id;
        if (event.type === "assistant.intent" && !event.agentId) {
          entry.intent = String(event.data?.intent ?? "").slice(0, 200);
          this.ws.notify();
        } else if (event.type === "assistant.usage")
          // The teammate's tokens count toward the turn, without renaming the turn's model.
          recordCanvas(run, null, null, { ...event, agentId: event.agentId ?? "teammate" });
        else recordActivity(entry, event, this.ws.notify);
      });
      const { text } = await session.send({ prompt }, ASK_TIMEOUT);
      if (over()) throw stopped();
      if (!text) throw new Error("no reply came back");
      return text;
    } catch (error) {
      if (error?.code === "BOTKINS_SESSION_STALL") {
        let recovered;
        try {
          recovered = await session?.completedReply?.(rootEventId);
        } catch {
          // A disconnected journal cannot be recovered here; preserve the original stall error.
        }
        if (typeof recovered === "string" && recovered.trim()) return recovered.trim();
      }
      failed = true;
      if (session) await session.abort().catch(() => {});
      throw error;
    } finally {
      off?.();
      if (session) {
        task.helpers.delete(session);
        await session.close({ discard: failed && !task.stopped && !task.ended });
      }
    }
  }
}
