import type { Line } from "./types";

type HistoryLine = Line & { afterVoiceId?: string };

/** Send whole snapshots serially. While the link is busy only the newest text for each line waits. */
export class VoiceHistoryWriter {
  private pending = new Map<string, HistoryLine>();
  private writing?: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly save: (line: HistoryLine) => Promise<void>, private readonly failed: () => void) {}

  put(line: HistoryLine) {
    if (!line.text.trim()) return;
    this.pending.set(line.id, line);
    if (this.writing) return;
    if (line.final) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 150);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.writing ??= this.drain().finally(() => {
      this.writing = undefined;
      if (this.pending.size) return this.flush();
    });
  }

  private async drain() {
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
  }
}
