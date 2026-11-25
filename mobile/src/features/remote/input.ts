// One ordered lane per viewer. Motion coalesces within a frame. On exit or a display
// switch only a button already sent down needs a final event, on its original display.
import type { ScreenInput } from "@/link/types";

export class InputSender {
  private display = "";
  private generation = 0;
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
    this.generation++;
    this.display = display;
  }

  /** Reading the phone's clipboard can involve a system prompt. Only its original viewer may paste. */
  async paste(read: () => Promise<string>) {
    if (this.closed || !this.display) return;
    const generation = this.generation;
    let text: string | undefined;
    try {
      text = await read();
    } catch {
      // Never put a native clipboard error or its contents in a notice.
    }
    if (this.closed || generation !== this.generation) return;
    if (text === undefined) return "Couldn't read the phone's clipboard.";
    if (!text) return "The phone's clipboard is empty.";
    // The host accepts up to 2,000 UTF-16 code units. Keep a cut emoji whole.
    const piece = text.length <= 2000 ? text : text.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, "");
    // The host expands line breaks and tabs into keys. Make them explicit so long multiline
    // pastes follow the same bounded, ordered batches as keyboard input.
    for (const part of piece.replace(/\r\n?/g, "\n").split(/([\n\t])/)) {
      if (part === "\n" || part === "\t") this.push({ type: "key", key: part === "\n" ? "enter" : "tab" });
      else if (part) this.push({ type: "text", text: part });
    }
    return piece.length === text.length ? "Sent clipboard text" : "Sent the first " + piece.length.toLocaleString() + " characters";
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
      const events = this.queue.splice(0, 64).filter(event => event.type !== "scroll" || event.dx !== 0 || event.dy !== 0);
      if (events.length) this.dispatch(this.display, events);
      else if (this.queue.length) this.schedule();
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
