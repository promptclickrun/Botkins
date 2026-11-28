// A person's Main chat has one public chat id for the life of the bot. Its provider
// conversations can come and go independently. Ordinary chats never acquire this mark.
import { randomUUID } from "node:crypto";

export function makeMainChat(botId, person = "owner") {
  return {
    id: randomUUID(), botId, ...(person !== "owner" && { createdBy: person }),
    main: true, title: "Main chat", time: 0, messages: [], established: false,
    activeFork: "original", forks: [{ id: "original", name: "Original" }],
  };
}

/** Preserve every existing thread and add a private Main chat for each bot's creator and previous correspondents. */
export function migrateMainChats(bots, chats) {
  const missing = new Map(bots.map(bot => [bot.id, new Set([bot.createdBy ?? "owner"])]));
  for (const chat of chats) {
    if (!chat.botIds && !chat.temporary && !chat.helper)
      missing.get(chat.botId)?.add(chat.createdBy ?? "owner");
  }
  for (const chat of chats) if (chat.main) missing.get(chat.botId)?.delete(chat.createdBy ?? "owner");
  for (const [botId, people] of missing) for (const person of people) chats.push(makeMainChat(botId, person));
}

export function findMainChat(chats, botId, person) {
  return chats.find(c => c.main && c.botId === botId && (c.createdBy ?? "owner") === person);
}

// These belong to the conversation the bot is continuing. The address, recipient,
// model choice, chat flags, schedules and work history remain attached to the chat.
const forkFields = ["messages", "sessionId", "sessionProvider", "sessionFolder", "sessions", "established", "forkContext", "restartSession",
  "context", "compacted", "posted", "helpers", "todos", "planApplied", "planModel"];

/** What a Main chat shows where its context was cleared. */
export const CONTEXT_CLEARED = "Context cleared. The bot starts fresh from here; the messages above stay for you.";

/**
 * Clears what the bot carries into its next turn and keeps the conversation on screen, in the same
 * chat: the next turn opens a new provider session that starts after this point (mainTranscript reads
 * from `compacted.through`). A Main chat never looks new because of it.
 */
function clearMainContext(chat) {
  if (chat.messages.length) chat.messages.push({ role: "command", plain: true, time: Date.now(), text: CONTEXT_CLEARED });
  chat.compacted = { text: "", through: chat.messages.length };
  chat.restartSession = true;
  for (const key of ["forkContext", "context", "posted", "todos", "planApplied", "planModel"]) delete chat[key];
  chat.time = Date.now();
}

/**
 * Archiving or deleting is the only way a person's Main chat changes. An archived one becomes an
 * ordinary chat with its messages, so it can never compete with the Main chat made next.
 */
export function retireMainChat(chat) {
  delete chat.main;
  delete chat.activeFork;
  delete chat.forks;
  if (!chat.titleSet) chat.title = "Earlier Main chat";
}

export function changeMainContext(chat, action, value, transcript) {
  if (!chat.main) throw new Error("Choose a Main chat.");
  if (action === "reset") return clearMainContext(chat);
  let id, next;
  if (action === "switch") {
    if (!chat.forks.some(fork => fork.id === value)) throw new Error("Choose a fork of this Main chat.");
    if (value === chat.activeFork) return;
    id = value;
    next = chat.savedForks?.[id];
    if (!next) throw new Error("This fork is no longer available.");
  } else {
    if (action !== "fork") throw new Error("Choose reset, fork or switch.");
    if (!Number.isInteger(value) || value < 0 || value >= chat.messages.length) throw new Error("Choose a message to fork from.");
    id = randomUUID();
    const messages = structuredClone(chat.messages.slice(0, value + 1));
    next = { sessionId: id, established: false, messages };
    if (chat.compacted && messages.length >= chat.compacted.through) next.compacted = chat.compacted;
    if (messages.length && transcript) next.forkContext = transcript(messages);
    chat.forks.push({ id, name: "Fork " + (chat.forks.length + 1) });
  }
  const held = {};
  for (const key of forkFields) {
    if (Object.hasOwn(chat, key)) held[key] = chat[key];
    delete chat[key];
  }
  (chat.savedForks ??= {})[chat.activeFork] = held;
  delete chat.savedForks[id];
  Object.assign(chat, next, { activeFork: id, time: Date.now() });
}

/** Inactive transcripts stay in the workspace file. Clients get the fork picker and the active conversation. */
export function visibleChat(chat) {
  if (!chat.main && !chat.sessions && !chat.savedForks) return chat;
  if (!chat.main) {
    // An earlier Main chat keeps its other forks' transcripts for its sessions' cleanup only.
    const { sessions: _sessions, savedForks: _forks, ...active } = chat;
    return active;
  }
  if (!(chat.savedForks || chat.compacted || chat.forkContext || chat.sessions)) return chat;
  const { savedForks, compacted, forkContext, sessions, ...active } = chat;
  return active;
}

/** All conversations for provider session adoption, release and deletion. */
export function conversations(chat) {
  return [chat, ...Object.values(chat.savedForks ?? {}).map(fork => ({ id: chat.id, botId: chat.botId, ...fork }))];
}
