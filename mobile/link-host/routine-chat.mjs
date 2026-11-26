// Shared predicate for whether a chat is owned by a routine (desktop/routines.mjs).
// Matches routine chats, Proactive routine chats (proactive: true), and script routines.
// Never infers from title, and never matches ordinary chats a routine merely delivers into.
export function isRoutineChat(chat) {
  return !!chat?.schedules?.some((entry) => entry?.routine === true);
}
