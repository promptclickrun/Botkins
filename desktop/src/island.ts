// What the activity island shows (ActivityIsland.tsx): one small card per running turn when
// Settings › Chat › Steps or Thinking is Open. Kept apart from React so the rules are tested alone.
import type { Reasoning, Step } from "./types";

/** The window holds this many lines at most: the newest. */
export const ISLAND_LINES = 4;
/** With Thinking alone, the window holds this many lines of the reasoning's tail. */
export const REASONING_LINES = 3;

export type IslandLine =
  | { kind: "step"; key: string; step: Step }
  | { kind: "thought"; key: string; heading: string; snippet: string; text: string }
  | { kind: "update"; key: string; text: string };

/** What the bot wrote before it moved on, for a finished turn's receipt. */
export type IslandUpdate = { key: string; at: number; text: string };

/** "12s", "1m 51s" or "1h 4m". */
export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

/** Reasoning summaries mark their headings with Markdown bold; the island shows plain text. */
function plain(text: string) {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

/**
 * A thought as one row: its heading and a snippet of what follows. A summary that starts with a
 * bold heading uses it; otherwise the first sentence (or line) is the heading.
 */
export function thoughtParts(text: string): { heading: string; snippet: string } {
  const value = text.trim();
  const bold = /^\*\*(.+?)\*\*\s*/.exec(value);
  let heading: string;
  let rest: string;
  if (bold) {
    heading = bold[1];
    rest = value.slice(bold[0].length);
  } else {
    const line = value.split("\n")[0];
    const sentence = /^(.{8,80}?[.!?])(\s|$)/.exec(line);
    heading = sentence ? sentence[1] : line;
    rest = value.slice(heading.length);
  }
  return { heading: plain(heading).trim().replace(/[.:]$/, ""), snippet: plain(rest).replace(/\s+/g, " ").trim() };
}

/**
 * The turn's lines in the order they happened: its steps and, when `thoughts`, its thoughts.
 * `keep` leaves out steps the chat never shows (a tool's quiet bookkeeping).
 */
export function islandLines(
  run: { steps?: Step[]; reasoning?: Reasoning[] },
  { thoughts, keep = () => true, updates = [] }: { thoughts: boolean; keep?: (step: Step) => boolean; updates?: IslandUpdate[] },
): IslandLine[] {
  const timed: { at: number; order: number; line: IslandLine }[] = [];
  if (thoughts) {
    (run.reasoning ?? []).forEach((reasoning, index) => {
      if (!reasoning.text.trim()) return;
      timed.push({ at: reasoning.started, order: index, line: { kind: "thought", key: "thought-" + reasoning.id, text: reasoning.text, ...thoughtParts(reasoning.text) } });
    });
  }
  // A finished turn's updates, where they came. One that came with a step reads first, as in the chat.
  const offset = timed.length;
  updates.forEach((update, index) => {
    if (update.text.trim()) timed.push({ at: update.at, order: offset + index, line: { kind: "update", key: "update-" + update.key, text: update.text.trim() } });
  });
  const stepsFrom = offset + updates.length;
  (run.steps ?? []).forEach((step, index) => {
    if (keep(step)) timed.push({ at: step.started, order: stepsFrom + index, line: { kind: "step", key: "step-" + step.id, step } });
  });
  // A thought and a step that start together: the thought led to the step.
  return timed.sort((a, b) => a.at - b.at || a.order - b.order).map((item) => item.line);
}

/** The newest lines that fit the window, and whether older ones fade out above them. */
export function islandWindow<T>(lines: T[], size = ISLAND_LINES): { shown: T[]; clipped: boolean } {
  return { shown: lines.length > size ? lines.slice(-size) : lines, clipped: lines.length > size };
}

/**
 * The tail of the reasoning for Thinking alone: about `REASONING_LINES` lines of the newest
 * words, starting at a word. The card clips it to three lines from the bottom; `clipped` says
 * that older text sits above, so the top line fades.
 */
export function reasoningTail(reasoning: Reasoning[] | undefined, chars = 260): { text: string; clipped: boolean } {
  const text = (reasoning ?? []).map((r) => plain(r.text).trim()).filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
  if (text.length <= chars) return { text, clipped: text.length > chars * 0.6 };
  const tail = text.slice(-chars);
  const start = tail.search(/\s/);
  return { text: tail.slice(start + 1), clipped: true };
}

/**
 * The header's label. Waiting on the person comes first; while the bot only thinks (its newest
 * line is a thought and no step runs) the label is that thought's heading; otherwise it is working.
 * `lines` are every line in order, with the thoughts whenever the person shows thinking.
 */
export function islandLabel({ who, waiting, lines }: { who: string; waiting: boolean; lines: IslandLine[] }): string {
  if (waiting) return who + " needs you";
  const last = lines.at(-1);
  const stepRunning = lines.some((line) => line.kind === "step" && line.step.status === "Running");
  if (!stepRunning && last?.kind === "thought" && last.heading) return last.heading;
  return who + " is working";
}

/** "23s · 7 steps", or "23s" before the first step. */
export function islandMeta(ms: number, steps: number) {
  return duration(ms) + (steps ? " · " + steps + (steps === 1 ? " step" : " steps") : "");
}

/** The finished turn's receipt under its answer: "Worked 42s · 9 steps". */
export function receiptLabel(ms: number | undefined, steps: number) {
  const count = steps ? steps + (steps === 1 ? " step" : " steps") : "";
  if (ms === undefined) return count || "Worked";
  return "Worked " + duration(ms) + (count ? " · " + count : "");
}
