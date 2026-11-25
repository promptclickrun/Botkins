// Evidence is rebuilt from the bot's current, permitted sources at each wake. Only
// the bounded packet for a running check and fingerprints for deduplication are saved.
import { canUseProject } from "./access.mjs";
import { memberCanSpaces } from "./team-turn.mjs";
import { readProfile } from "./bot-profile-files.mjs";
import { digest } from "./proactive-learning.mjs";

/** How long after a conversation's last message the check leaves it alone. */
export const LIVE_CHAT = 30 * 60_000;

export function fact(kind, origin, value, at) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 550);
  const id = kind + "-" + digest(origin + "\n" + text);
  return { id, kind, key: id, text, ...(Number.isFinite(at) && Math.abs(at) <= 8.64e15 && { at }) };
}

export function personalEvidence(ws, botId, person) {
  const facts = [];
  if (person === "owner") {
    // Both files are per bot on this computer and have no per-member provenance.
    const notes = ws.memory.entries(botId).slice(-8);
    try {
      notes.push(...readProfile(ws, botId, "USER.md").split("\n").filter((s) => s.trim() && !s.startsWith("#")).slice(-4));
    } catch {
      // An unreadable optional profile must not prevent checks of other sources.
    }
    for (const note of notes) facts.push(fact("memory", botId, note));
  }
  const bot = ws.bot(botId);
  if (person === "owner" || memberCanSpaces(person, ws.teamOf(), "view")) {
    const goals = ws.state.spaces.find((s) => s.builtin === "goals" && (s.createdBy ?? "owner") === person);
    if (goals) {
      for (const item of ws.state.board.filter((i) => i.spaceId === goals.id && i.botId === botId && i.kind === "goal" && i.status === "open").slice(0, 4)) {
        facts.push(fact("goal", item.id, item.title + " " + (item.body ?? ""), item.updatedAt));
      }
    }
  }
  // A reply only travels with the person's own interactive turn. Assistant messages
  // posted by routines, including this agent's own delivered suggestions, have no such pair.
  const chats = ws.state.chats.filter((chat) => {
    if (chat.botId !== botId || (chat.createdBy ?? "owner") !== person) return false;
    if (chat.botIds || chat.temporary || chat.helper || chat.panelId || chat.forkedFrom || chat.schedules?.some((s) => s.routine)) return false;
    return !chat.projectId || canUseProject(ws.state, bot, chat.projectId);
  }).sort((a, b) => b.time - a.time);
  const runs = new Map(ws.state.runs.map((r) => [r.id, r]));
  let used = 0;
  const now = Date.now();
  for (const chat of chats) {
    if (ws.chatPeople(chat.id).invited.length) continue;
    // A conversation the person is still in belongs to that chat's turn: the check waits until it goes quiet.
    if (now - (chat.messages.at(-1)?.time ?? 0) < LIVE_CHAT) continue;
    const tail = chat.messages.slice(-24);
    const recent = tail.filter((m) => {
      if (m.role !== "user" || m.answer || !m.text?.trim() || (m.author?.memberId ?? "owner") !== person) return false;
      const id = m.runId ?? m.steeredRunId;
      const run = runs.get(id);
      return !id || (run?.status === "Completed" && !run.proactive && run.scheduleId == null && !run.taskId && !run.panelId);
    });
    if (!recent.length) continue;
    for (const message of recent.slice(-2)) {
      const id = message.runId ?? message.steeredRunId;
      const reply = id && tail.findLast((m) => m.runId === id && m.role === "assistant" && !m.interim);
      const text = reply?.text ? "Person: " + message.text.slice(0, 280) + " / Earlier bot reply: " + reply.text.slice(0, 220) : message.text;
      facts.push(fact("chat", chat.id, text, message.time));
    }
    if (++used === 6) break;
  }
  return [...new Map(facts.map((e) => [e.id, e])).values()];
}
