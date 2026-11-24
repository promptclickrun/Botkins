// One frame in flight, including the native image's draw acknowledgement. A preview samples
// once per visible visit. The pane samples on its own clock; the full viewer long-polls.
import type { ScreenFrame } from "@/link/types";

export type FeedState = "starting" | "live" | "retrying" | "failed";

function wait(ms: number, signal: AbortSignal) {
  if (ms <= 0 || signal.aborted) return;
  return new Promise<void>(resolve => {
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

export async function runScreenFeed({ signal, once, gapMs, read, draw, report }: {
  signal: AbortSignal;
  once: boolean;
  gapMs: number;
  read: (after?: number) => Promise<ScreenFrame>;
  draw: (frame: ScreenFrame) => Promise<boolean>;
  report: (state: FeedState, error?: string) => void;
}) {
  let after: number | undefined;
  let failures = 0;
  while (!signal.aborted) {
    const start = Date.now();
    try {
      const frame = await read(after);
      if (signal.aborted) return;
      if (frame.jpeg) {
        if (!await draw(frame)) throw new Error("Couldn't display the picture.");
      } else if (after === undefined || after !== frame.seq) {
        throw new Error("Couldn't get the picture.");
      }
      if (signal.aborted) return;
      if (after === undefined) report("live");
      after = frame.seq;
      failures = 0;
      if (once) return;
      // An unchanged paced feed checks at most as often as the old host long poll.
      const interval = frame.jpeg ? gapMs : gapMs ? Math.max(1500, gapMs) : 250;
      await wait(interval - (Date.now() - start), signal);
    } catch (error) {
      if (signal.aborted) return;
      after = undefined; // A failed decode must request the bytes again.
      if (once || ++failures > 5) {
        report("failed", error instanceof Error ? error.message : "Couldn't get the picture.");
        return;
      }
      if (failures === 1) report("retrying");
      await wait(1000, signal);
    }
  }
}
