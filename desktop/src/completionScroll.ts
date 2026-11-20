import type { Chat, Run } from "./types";
import type { ChatDisplay } from "./chatDisplay";

type SeenTurn = { id: string; time: number; phase: "working" | "pending" | "done" };

/** One window's observations for one computer. Keep them across chat switches. */
export class CompletionScroll {
  private chats = new Map<string, SeenTurn | null>();

  observe(chats: Pick<Chat, "id" | "messages" | "count">[], runs: Run[], position: ChatDisplay["completionPosition"]) {
    // The runs list is newest first. A later turn supersedes a deferred jump in the same chat.
    const newest = new Map<string, Run>();
    for (const run of runs) if (!newest.has(run.chatId)) newest.set(run.chatId, run);
    for (const { id, count, messages } of chats) {
      const previous = this.chats.get(id);
      const run = newest.get(id);
      if (!run) {
        // A remote chat summary can arrive before its old runs. Only an empty transcript
        // establishes that a subsequently observed completed run is new.
        if (previous === undefined && (count ?? messages.length) === 0) this.chats.set(id, null);
        continue;
      }
      if (previous && run.time < previous.time) continue;
      const same = previous?.id === run.id;
      if (same && previous.phase === "done") continue;
      const successful = run.status === "Completed" && !run.ending && !run.noOutput;
      const phase = run.status === "Working" ? "working"
        : successful && previous !== undefined && position === "beginning" ? "pending" : "done";
      if (!same || previous.phase !== phase) this.chats.set(id, { id: run.id, time: run.time, phase });
    }
  }

  readerMoved(chatId: string, runId: string) {
    const turn = this.chats.get(chatId);
    if (turn?.id === runId) turn.phase = "done";
  }

  pending(chatId: string) {
    const turn = this.chats.get(chatId);
    return turn?.phase === "pending" ? turn.id : undefined;
  }

  take(chatId: string, { visible, rendered }: { visible: boolean; rendered: string }) {
    const turn = this.chats.get(chatId);
    if (!visible || turn?.phase !== "pending" || turn.id !== rendered) return false;
    turn.phase = "done";
    return true;
  }
}

export function finalReplyIndex(chat: Pick<Chat, "messages" | "loaded" | "count">, runId: string) {
  const { messages, loaded } = chat;
  if (loaded === null) return;
  if (loaded && loaded.from + messages.length < Math.max(loaded.total, chat.count ?? 0)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.runId === runId && m.role === "assistant" && !m.interim) return (loaded?.from ?? 0) + i;
  }
}
