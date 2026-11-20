// Sends pointer and key events to the computer: at most one call per animation frame and never
// more than one call in flight. Consecutive moves collapse into the last one and consecutive
// scrolls add up, so a fast finger doesn't flood the link.
import type { ScreenInput } from "@/link/types";
import { api } from "@/state/link";

export class InputSender {
  private queue: ScreenInput[] = [];
  private busy = false;
  private frame: number | null = null;
  private closed = false;

  constructor(
    private display: string,
    private failed: (error: unknown) => void,
  ) {}

  /** Events for another display start fresh. */
  setDisplay(display: string) {
    if (display === this.display) return;
    this.display = display;
    this.queue = [];
  }

  push(event: ScreenInput) {
    if (this.closed) return;
    const last = this.queue[this.queue.length - 1];
    if (last?.type === "move" && event.type === "move") this.queue[this.queue.length - 1] = event;
    else if (last?.type === "scroll" && event.type === "scroll") this.queue[this.queue.length - 1] = { ...event, dx: last.dx + event.dx, dy: last.dy + event.dy };
    else this.queue.push(event);
    this.schedule();
  }

  /** Sends what is still waiting (a mouse button let go, say) and stops. */
  close() {
    if (this.closed) return;
    this.closed = true;
    const left = this.queue;
    this.queue = [];
    if (left.length > 0 && this.display) void api["link.screen.input"](this.display, left).catch(() => {});
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private schedule() {
    if (this.frame !== null || this.busy || this.closed) return;
    this.frame = requestAnimationFrame(this.flush);
  }

  private flush = () => {
    this.frame = null;
    if (this.busy || this.closed || this.queue.length === 0 || !this.display) return;
    const events = this.queue.filter((event) => event.type !== "scroll" || event.dx !== 0 || event.dy !== 0);
    this.queue = [];
    if (events.length === 0) return;
    this.busy = true;
    api["link.screen.input"](this.display, events)
      .catch((error: unknown) => {
        if (!this.closed) this.failed(error);
      })
      .finally(() => {
        this.busy = false;
        if (this.queue.length > 0) this.schedule();
      });
  };
}
