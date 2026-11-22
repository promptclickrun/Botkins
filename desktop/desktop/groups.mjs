// Group chats: two to six bots in one conversation (Bighelp's group chats, without Hermes rooms).
// Each member keeps its own Copilot session. Before a member replies it receives what the others
// said since its last turn, so every bot answers from the whole conversation.
import { randomUUID } from "node:crypto";

export const GROUP_MIN = 2;
export const GROUP_MAX = 6;

export function createGroupChat(ws, botIds, title) {
  if (!Array.isArray(botIds) || new Set(botIds).size !== botIds.length)
    throw new Error("Choose each bot once.");
  if (botIds.length < GROUP_MIN || botIds.length > GROUP_MAX)
    throw new Error("A group chat holds 2 to 6 bots.");
  const bots = botIds.map((id) => ws.bot(id));
  const chat = {
    id: randomUUID(),
    botId: bots[0].id,
    botIds: bots.map((b) => b.id),
    title: (title?.trim() || bots.map((b) => b.name).join(", ")).slice(0, 120),
    time: Date.now(),
    messages: [],
    established: false,
    // Per member: the message index it has seen up to, and whether its session exists.
    members: Object.fromEntries(bots.map((b) => [b.id, { seen: 0, established: false }])),
  };
  ws.state.chats.unshift(chat);
  ws.save();
  return chat.id;
}

export const isGroup = (chat) => Array.isArray(chat?.botIds) && chat.botIds.length >= GROUP_MIN;
/** The Copilot session id for one member of a group chat. */
export const memberSessionId = (chat, botId) => chat.id + "-" + botId;

/**
 * Who answers a message. "@everyone" or "@all" asks every member. Named mentions ask those bots,
 * in the order they are mentioned. Without a mention, every member answers in order.
 */
export function responders(chat, bots, text) {
  const members = chat.botIds.map((id) => bots.find((b) => b.id === id)).filter(Boolean);
  if (/(^|\s)@(everyone|all)\b/i.test(text)) return members;
  const lower = text.toLowerCase();
  const found = [];
  for (const bot of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const at = lower.indexOf("@" + bot.name.toLowerCase());
    if (at < 0) continue;
    const after = lower[at + bot.name.length + 1];
    if (after && /[\p{L}\p{N}_]/u.test(after)) continue;
    found.push([at, bot]);
  }
  return found.length ? found.sort((a, b) => a[0] - b[0]).map(([, b]) => b) : members;
}

/** The standing instructions a member gets on top of its own. */
export function groupInstructions(bot, members) {
  const others = members.filter((b) => b.id !== bot.id).map((b) => b.name + " (" + b.role + ")");
  return (
    "\nYou are " + bot.name + " in a group chat with the person and these bots: " + others.join(", ") + ". " +
    "Messages arrive labeled with who wrote them. Reply only as yourself, in your own voice, and don't speak for the others. " +
    "Build on what the others already said instead of repeating it, and keep replies short unless asked for detail. " +
    "Mention a bot as @Name only when you want it to pick something up."
  );
}

/** What a member reads before replying: everything said since its last turn, labeled by speaker. `speakerOf` names a person's message in a chat of several people (workspace.speakerNamer). */
export function catchUp(chat, bot, bots, speakerOf = () => "") {
  const seen = chat.members?.[bot.id]?.seen ?? 0;
  const lines = [];
  for (const m of chat.messages.slice(seen)) {
    if (m.role === "assistant" && m.botId === bot.id) continue;
    if (m.role === "command" || !m.text) continue;
    const who = m.role === "user" ? speakerOf(m) || "Person" : (bots.find((b) => b.id === m.botId)?.name ?? "A bot");
    const quote = m.quote ? "(replying to: " + m.quote.trim().slice(0, 400) + ")\n" : "";
    // Records the person mentioned travel with their message (desktop/mentions.mjs).
    lines.push(who + ": " + quote + m.text + (m.role === "user" && m.context ? m.context : ""));
  }
  return lines.join("\n\n") + "\n\n(Reply as " + bot.name + ".)";
}

export function markSeen(chat, botId) {
  chat.members ??= {};
  chat.members[botId] = { ...(chat.members[botId] ?? { established: false }), seen: chat.messages.length };
}
