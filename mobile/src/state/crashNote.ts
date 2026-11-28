// What the phone keeps of an error nothing in the app caught, or that a screen could not draw
// through: when, what it said, and where in the code. Plain logic, so tests run it; lastCrash.ts
// writes it to the phone and Settings › About shows it.

export type CrashNote = {
  /** When, in ms. */
  at: number;
  /** "error": an error nothing caught; the app stayed open. "screen": a screen failed to draw and showed a way back. */
  kind: "error" | "screen";
  message: string;
  /** The first lines of where it happened. */
  stack: string;
  /** The app's version at the time. */
  version?: string;
};

const MAX_MESSAGE = 600;
const MAX_LINES = 30;
const MAX_LINE = 240;

/** A note from whatever was thrown: an Error, or anything else (a string, an object). Kept short enough to read on a phone. */
export function crashNote(thrown: unknown, kind: CrashNote["kind"], at: number, version?: string): CrashNote {
  const error = thrown as { message?: unknown; stack?: unknown; name?: unknown } | null | undefined;
  let message = typeof error?.message === "string" && error.message ? error.message : typeof thrown === "string" ? thrown : "";
  if (!message) {
    try {
      message = JSON.stringify(thrown) ?? String(thrown);
    } catch {
      message = String(thrown);
    }
  }
  const name = typeof error?.name === "string" && error.name && error.name !== "Error" ? error.name + ": " : "";
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const lines = stack
    .split("\n")
    .map((line) => line.trim())
    // The stack often repeats the message as its first line.
    .filter((line, index) => line && !(index === 0 && line.includes(message.slice(0, 60))))
    .slice(0, MAX_LINES)
    .map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line));
  return { at, kind, message: (name + message).slice(0, MAX_MESSAGE), stack: lines.join("\n"), ...(version && { version }) };
}

/** A note read back from the phone, or null when what was kept is not one. */
export function parseCrashNote(text: string | null | undefined): CrashNote | null {
  if (!text) return null;
  try {
    const saved = JSON.parse(text) as Partial<CrashNote> | null;
    if (!saved || typeof saved.at !== "number" || typeof saved.message !== "string") return null;
    return { at: saved.at, kind: saved.kind === "screen" ? "screen" : "error", message: saved.message, stack: typeof saved.stack === "string" ? saved.stack : "", ...(typeof saved.version === "string" && { version: saved.version }) };
  } catch {
    return null;
  }
}

/** The note as text to copy and send. */
export function crashText(note: CrashNote): string {
  return [
    (note.kind === "error" ? "An error" : "A screen failed") + " at " + new Date(note.at).toISOString() + (note.version ? " (version " + note.version + ")" : ""),
    note.message,
    note.stack,
  ]
    .filter(Boolean)
    .join("\n\n");
}
