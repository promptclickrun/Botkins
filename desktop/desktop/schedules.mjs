// Prompts a chat scheduled with /every or /after. Botkins owns the clock (the provider only parses the time).
import { nextTime } from "./panels.mjs";
import { dispatch } from "./routines.mjs";

export function tickChatSchedules(workspace, now = Date.now()) {
  if (workspace.closing) return;
  for (const chat of workspace.state.chats) {
    if (workspace.active.has(chat.id)) continue;
    // Paused entries and finished one-time routines (nextAt null) never run.
    const due = chat.schedules?.find(
      (s) => s.enabled !== false && s.nextAt != null && s.nextAt <= now,
    );
    if (!due) continue;
    if (due.recurring)
      due.nextAt = due.cron
        ? nextTime(due.cron, due.timezone, now)
        : due.nextAt +
          (1 + Math.floor((now - due.nextAt) / due.intervalMs)) *
            due.intervalMs;
    else if (due.routine) {
      // A finished one-time routine stays listed under Finished with its runs.
      due.nextAt = null;
      due.finishedAt = now;
    } else chat.schedules = chat.schedules.filter((s) => s.id !== due.id);
    // send writes schedule advancement and its Work row together before starting any async work.
    try {
      dispatch(workspace, chat, due, "scheduled").catch((error) =>
        console.error("Chat schedule:", error.message),
      );
    } catch (error) {
      console.error("Chat schedule:", error.message);
    }
  }
}
