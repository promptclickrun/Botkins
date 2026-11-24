// A person's reaction to a bot's message gives that bot a quiet turn of its own (Workspace.reactionTurn).
//
// The bot is told what was reacted to, and it decides whether a reply adds anything. Most of the
// time it doesn't: then it answers only [SILENT] (desktop/routines.mjs), and the turn leaves
// nothing in the chat. No message from the person is added, nobody sees it typing, and no
// notification is sent or chat marked unread. Only a real reply is shown, as any reply is.
//
// A reaction costs a model turn on the person's plan, so a turn is spent only when one can help:
//   - only for a person's reaction (the owner or a team member), to a bot's finished message, in a chat
//     with one bot that isn't a helper chat
//   - not while that chat is working, and reactions that come together make one turn (DEBOUNCE_MS)
//   - at most PER_DAY turns for each bot each day
//   - none while the chat model's plan has a limit at USAGE_CEILING percent or more used, as the
//     provider itself reports it (desktop/providerusage.mjs); the bot is told how much is used.
import { isGroup } from "./groups.mjs";
import { SILENT } from "./link/silent-reply.mjs";

export { mayBeSilent } from "./link/silent-reply.mjs";

export const DEBOUNCE_MS = 4000;
export const PER_DAY = 24;
export const USAGE_CEILING = 90;
/** How long the turn waits for the plan's numbers before going on without them. */
export const USAGE_WAIT_MS = 3000;

/** The most used of a plan's limits, from one providerUsage entry: { percent, label } or null. */
export function mostUsed(entry) {
  let best = null;
  for (const limit of entry?.limits ?? []) {
    if (limit?.unlimited) continue;
    const used = typeof limit?.percentUsed === "number" ? limit.percentUsed : typeof limit?.percentRemaining === "number" ? 100 - limit.percentRemaining : undefined;
    if (used === undefined || !Number.isFinite(used)) continue;
    if (!best || used > best.percent) best = { percent: Math.round(used), label: String(limit.label ?? "limit") };
  }
  return best;
}

const excerpt = (text, most = 600) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > most ? flat.slice(0, most - 1) + "…" : flat;
};

/** What the bot is told in a reaction's turn. `reactions` is [{ emoji, text, latest, who }]. */
export function reactionPrompt(reactions, { usage, provider } = {}) {
  const lines = reactions.map((r) =>
    "- " + (r.who || "The person") + " reacted " + r.emoji + " to " + (r.latest ? "your latest message" : "an earlier message of yours") + ": “" + excerpt(r.text) + "”",
  );
  return [
    "[Botkins: this is not a message from the person. They reacted to your message" + (reactions.length > 1 ? "s" : "") + " in this chat, and nothing else was said.]",
    ...lines,
    usage ? "The " + (provider || "model") + " plan behind this chat has used " + usage.percent + "% of its " + usage.label + "." : "",
    "Decide what fits, as a thoughtful friend would, from what the reaction means here: read it with the message and the conversation, not by the emoji alone. It may need nothing back, a reaction of your own (react, on the person's latest message) when that is how a friend would answer, or a short reply when that adds something they would want, such as an answer to a question you asked or more on something they want to understand. Don't echo their reaction back by habit, and don't let a reaction stand in for a reply the message needs. Be warm when you answer. Don't reply just because a reaction came in, and don't thank them for it. Each reply is a model turn on their plan, so the closer it is to its limits, the more a reply has to earn its place.",
    "When you send no text, with or without a reaction of your own, reply with exactly " + SILENT + " and nothing else: the person sees nothing but your reaction, if you made one.",
  ].filter(Boolean).join("\n");
}

export class ReactionTurns {
  /**
   * @param ws  The workspace.
   * @param options.usage  (providerId) → that provider's providerUsage entry, or null. Set by the runtime.
   */
  constructor(ws, { usage = null, debounceMs = DEBOUNCE_MS, now = () => Date.now() } = {}) {
    Object.assign(this, { ws, usage, debounceMs, now });
    this.waiting = new Map();
    this.counts = new Map();
  }

  /** A reaction was set. `actor` is "owner", "member:<id>" or "bot:<id>". */
  reacted(chat, index, emoji, actor) {
    if (actor !== "owner" && !String(actor).startsWith("member:")) return;
    const message = chat.messages[index];
    if (!eligible(chat, message)) return;
    const waiting = this.waiting.get(chat.id) ?? { reactions: new Map() };
    clearTimeout(waiting.timer);
    // The latest reaction of each person to each message: changing one's mind makes one turn.
    waiting.reactions.set(actor + "\n" + message.time, { actor, time: message.time, emoji });
    waiting.timer = setTimeout(() => void this.fire(chat.id).catch((error) => console.error("Reaction turn:", error.message)), this.debounceMs);
    waiting.timer.unref?.();
    this.waiting.set(chat.id, waiting);
  }

  /** The person said something before the turn began: their message is the turn, and the reaction is seen with the chat. */
  forget(chatId) {
    const waiting = this.waiting.get(chatId);
    if (waiting) clearTimeout(waiting.timer);
    this.waiting.delete(chatId);
  }

  close() {
    for (const chatId of [...this.waiting.keys()]) this.forget(chatId);
  }

  /** Runs the turn for the reactions gathered in a chat, or drops them when a turn can't help. Returns why not, or null. */
  async fire(chatId) {
    const waiting = this.waiting.get(chatId);
    this.forget(chatId);
    const ws = this.ws;
    if (!waiting || ws.closing) return "closing";
    const chat = ws.state.chats.find((c) => c.id === chatId);
    if (!chat) return "gone";
    if (ws.active.has(chatId) || ws.queues.get(chatId)?.length) return "busy";
    const bot = ws.state.bots.find((b) => b.id === chat.botId);
    if (!bot) return "gone";
    const latestBot = chat.messages.findLast((m) => m.role === "assistant" && !m.interim);
    const reactions = [];
    for (const { actor, time, emoji } of waiting.reactions.values()) {
      const message = chat.messages.find((m) => m.time === time);
      // A reaction taken back or changed since, or a message gone, isn't told.
      if (!eligible(chat, message) || !message.reactions?.some((r) => r.actor === actor && r.emoji === emoji)) continue;
      reactions.push({ emoji, text: message.text, latest: message === latestBot, who: whoIs(ws, actor) });
    }
    if (!reactions.length) return "gone";
    const day = new Date(this.now()).toDateString();
    const count = this.counts.get(bot.id);
    const today = count?.day === day ? count.n : 0;
    if (today >= PER_DAY) return "daily";
    let usage = null;
    let provider;
    try {
      const owner = ws.providers.for(ws.effectiveModel(chat));
      provider = owner?.name;
      if (this.usage && owner) {
        const entry = await Promise.race([this.usage(owner.id), new Promise((resolve) => setTimeout(resolve, USAGE_WAIT_MS).unref?.())]);
        usage = mostUsed(entry);
      }
    } catch {
      // Without the plan's numbers the bot is still careful; nothing is assumed.
    }
    if (usage && usage.percent >= USAGE_CEILING) return "limits";
    // The plan was asked while the person may have gone on.
    if (ws.closing || ws.active.has(chatId) || ws.queues.get(chatId)?.length) return "busy";
    this.counts.set(bot.id, { day, n: today + 1 });
    void ws.reactionTurn(chat.id, reactionPrompt(reactions, { usage, provider }), { emoji: reactions.at(-1).emoji }).catch((error) => console.error("Reaction turn:", error.message));
    return null;
  }
}

/** A bot's finished message in a chat where a reaction turn may run. */
function eligible(chat, message) {
  return !!message && message.role === "assistant" && !message.interim && typeof message.text === "string" && !!message.text.trim() &&
    !chat.helper && !isGroup(chat);
}

function whoIs(ws, actor) {
  if (actor === "owner") return "The person";
  const { name } = ws.memberAuthor(actor.slice("member:".length));
  return name && name !== "A member" ? name + " (a member of the person's team)" : "A member of the person's team";
}
