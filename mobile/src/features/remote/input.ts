// One ordered lane per viewer. Motion coalesces within a frame. On exit or a display
// switch only a button already sent down needs a final event, on its original display.
import type { ScreenInput } from "@/link/types";

export class InputSender {
  private display = "";
  private queue: ScreenInput[] = [];
  private inFlight: Promise<void> | null = null;
  private pressed: { x: number; y: number } | null = null;
  private frame: number | null = null;
  private closed = false;

  constructor(
    private send: (display: string, events: ScreenInput[]) => Promise<unknown>,
    private failed: (error: unknown) => void,
  ) {}

  setDisplay(display: string) {
    if (display === this.display) return;
    this.discard();
    this.display = display;
  }

  push(event: ScreenInput) {
    if (this.closed || !this.display) return;
    const last = this.queue.at(-1);
    if (last?.type === "move" && event.type === "move") this.queue[this.queue.length - 1] = event;
    else if (last?.type === "scroll" && event.type === "scroll") this.queue[this.queue.length - 1] = { ...event, dx: last.dx + event.dx, dy: last.dy + event.dy };
    else this.queue.push(event);
    this.schedule();
  }

  close() {
    this.closed = true;
    this.discard();
  }

  private discard() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.queue = [];
    if (this.pressed) this.dispatch(this.display, [{ type: "up", ...this.pressed }]);
  }

  private schedule() {
    if (this.frame !== null || this.inFlight || this.closed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const events = this.queue.filter(event => event.type !== "scroll" || event.dx !== 0 || event.dy !== 0);
      this.queue = [];
      if (events.length) this.dispatch(this.display, events);
    });
  }

  private dispatch(display: string, events: ScreenInput[]) {
    for (const event of events) {
      if (event.type === "down" || (event.type === "move" && this.pressed)) this.pressed = { x: event.x, y: event.y };
      else if (event.type === "up" || event.type === "click" || event.type === "doubleClick" || event.type === "rightClick") this.pressed = null;
    }
    const post = () => this.send(display, events);
    const batch = (this.inFlight ? this.inFlight.then(post) : post()).then(() => {}, error => {
      if (!this.closed) this.failed(error);
    });
    this.inFlight = batch;
    void batch.then(() => {
      if (this.inFlight !== batch) return;
      this.inFlight = null;
      if (this.queue.length) this.schedule();
    });
  }
}
