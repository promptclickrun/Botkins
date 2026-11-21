import type { Message } from "@/link/types";
import type { Line } from "./types";

export type SpokenLine = Line & { at: number };

/** Keep an utterance where its first words appeared, including when two transcriptions overlap. */
export function updateSpoken(lines: SpokenLine[], next: Line, at: number): SpokenLine[] {
  const index = lines.findIndex(line => line.id === next.id);
  if (index < 0) return [...lines, { ...next, at }];
  const updated = lines.slice();
  updated[index] = { ...next, at: lines[index].at };
  return updated;
}

/** The watched page plus words heard on this phone that may still be on their way to the computer. */
export function voiceCanvas(messages: Message[], from: number, spoken: SpokenLine[]) {
  const savedAt = new Map<string, number>();
  const local = new Map(spoken.map(line => [line.id, line]));
  const rows = messages.map((message, i) => {
    const id = message.voiceId;
    const line = id && local.get(id);
    if (id) savedAt.set(id, i);
    return {
      key: id ? "v:" + id : "m:" + (from + i),
      message: line && message.voicePartial ? { ...message, text: line.text } : message,
      index: from + i,
    };
  });
  let inserted = 0;
  let after = 0;
  for (const line of spoken) {
    const saved = savedAt.get(line.id);
    if (saved !== undefined) {
      after = Math.max(after, saved + 1);
    } else if (line.at >= from) {
      // Several utterances may have arrived while the computer still had the same message count.
      after = Math.max(after, Math.min(line.at - from, messages.length));
      rows.splice(after + inserted, 0, { key: "v:" + line.id, index: line.at, message: { role: line.who === "you" ? "user" : "assistant", text: line.text, voiceId: line.id } });
      inserted++;
    }
  }
  return rows.reverse();
}

/** Send whole snapshots serially. While the link is busy only the newest text for each line waits. */
export class VoiceHistoryWriter {
  private pending = new Map<string, Line>();
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly save: (line: Line) => Promise<void>, private readonly failed: () => void) {}

  put(line: Line) {
    if (line.who !== "you" || !line.text.trim()) return;
    this.pending.set(line.id, line);
    if (this.writing) return;
    if (line.final) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.drain();
    } else {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 150);
    }
  }

  private async drain() {
    this.writing = true;
    try {
      while (this.pending.size) {
        const [id, line] = this.pending.entries().next().value!;
        this.pending.delete(id);
        try {
          await this.save(line);
        } catch {
          // A reply can be lost after the computer saved the final. The same id is safe to retry.
          if (line.final) {
            try { await this.save(line); } catch { this.failed(); }
          }
        }
      }
    } finally {
      this.writing = false;
    }
  }
}
