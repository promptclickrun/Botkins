// The island: what Steps and Thinking set to Open show while a turn runs (the owner's approved
// mockup, 2026-11-24, modeled on Bighelp's live-work block). One small card per running turn, under
// its newest text: the bot's face in a working ring and "<Bot> is working" (or the heading of the
// thought it is on), the time and step count, and a window of the newest 4 lines (tool steps and
// thought rows, in the order they happened), or with Thinking alone the last 3 lines of the
// reasoning. A tap lists every line in the card. Once the turn ends it folds into a receipt under
// the answer ("✓ Worked 42s · 9 steps"). Updates never go inside: they stay in the chat.
// No React Native imports, so tests/island.test.ts runs it. Island.tsx draws it.
import type { Reasoning, Run, Step } from "@/link/types";
import { spentTime, stepCount } from "./fold";

type IslandPrefs = { steps: string; thinking: string };

/** Open on either setting makes the live work an island. Folded, Hidden and Failed only keep their old look. */
export const islandOn = (prefs: IslandPrefs): boolean => prefs.steps === "show" || prefs.thinking === "show";

/** At most this many lines in the window. */
export const WINDOW = 4;
/** With Thinking alone, the window holds this many lines of the reasoning. */
export const REASONING_LINES = 3;

export type IslandLine =
  | { kind: "step"; key: string; step: Step }
  | { kind: "thought"; key: string; id: string; heading: string; snippet: string };

const flat = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();

/**
 * A thought as a row: its heading ("Comparing fares") and what follows. Models that summarize their
 * reasoning start a part with a bold heading or a Markdown one; otherwise the first sentence stands in.
 */
export function thoughtParts(text: string): { heading: string; snippet: string } {
  const body = text.trim();
  const marked = /^\*\*(.+?)\*\*[ \t]*\n?/.exec(body) ?? /^#{1,6}\s+(.+)\n?/.exec(body);
  if (marked) return { heading: flat(marked[1]), snippet: flat(body.slice(marked[0].length)) };
  const line = flat(body);
  const end = /^(.{8,60}?)[.!?:](\s|$)/.exec(line);
  if (end) return { heading: end[1], snippet: line.slice(end[0].length).trim() };
  if (line.length <= 48) return { heading: line, snippet: "" };
  const cut = line.lastIndexOf(" ", 44);
  return { heading: line.slice(0, cut > 16 ? cut : 44) + "…", snippet: line.slice(cut > 16 ? cut + 1 : 44) };
}

/**
 * Every line of a turn in the order it happened. `steps`: its tool steps; `thoughts`: its thoughts
 * with words in them. A thought and a step that started together read thought first.
 */
export function islandLines(run: Pick<Run, "steps" | "reasoning"> | undefined, { steps, thoughts }: { steps: boolean; thoughts: boolean }): IslandLine[] {
  if (!run) return [];
  const lines: { at: number; order: number; line: IslandLine }[] = [];
  if (steps) for (const step of run.steps ?? []) lines.push({ at: step.started, order: 1, line: { kind: "step", key: "s:" + step.id, step } });
  if (thoughts)
    for (const thought of run.reasoning ?? []) {
      if (!/\S/.test(thought.text)) continue;
      lines.push({ at: thought.started, order: 0, line: { kind: "thought", key: "r:" + thought.id, id: thought.id, ...thoughtParts(thought.text) } });
    }
  lines.sort((a, b) => a.at - b.at || a.order - b.order);
  return lines.map((entry) => entry.line);
}

/** The newest `max` lines, and whether older ones are cut (the top line then fades). */
export function islandWindow<L>(lines: L[], max = WINDOW): { lines: L[]; clipped: boolean } {
  return lines.length > max ? { lines: lines.slice(-max), clipped: true } : { lines, clipped: false };
}

/** About this many characters fill the window's 3 lines at the phone's smallest width. */
const TAIL = 200;

/** The end of the thought being written, flattened, for the window's last 3 lines. `clipped`: there is more above. */
export function reasoningTail(reasoning: Reasoning[] | undefined, max = TAIL): { text: string; clipped: boolean } {
  const latest = reasoning?.findLast((thought) => /\S/.test(thought.text));
  if (!latest) return { text: "", clipped: false };
  // A marked heading is the header's words already; the window shows what follows it.
  const marked = /^\s*(\*\*.+?\*\*|#{1,6}\s+[^\n]+)/.exec(latest.text);
  const text = flat(marked ? latest.text.slice(marked[0].length) : latest.text) || flat(latest.text);
  if (text.length <= max) return { text, clipped: text.length > max / 2 };
  const start = text.indexOf(" ", text.length - max);
  return { text: "…" + text.slice(start < 0 ? text.length - max : start + 1), clipped: true };
}

/**
 * The words in the header. Waiting on the person: "<Bot> needs you". Only thinking (Thinking is
 * Open, no step runs and the newest line is a thought): that thought's heading. Otherwise "<Bot> is
 * working". A group chat, or a bot without a name, says it without one.
 */
export function islandLabel({ name, waiting, heading }: { name?: string; waiting: boolean; heading?: string }): string {
  if (waiting) return name ? name + " needs you" : "Needs you";
  if (heading) return heading;
  return name ? name + " is working" : "Working";
}

/** The heading to show while the bot only thinks: the newest line is a thought and no step runs. */
export function thinkingHeading(run: Pick<Run, "steps" | "reasoning"> | undefined): string | undefined {
  if (!run || run.steps?.some((step) => step.status === "Running")) return undefined;
  const thought = run.reasoning?.findLast((entry) => /\S/.test(entry.text));
  if (!thought) return undefined;
  const lastStep = run.steps?.at(-1);
  if (lastStep && lastStep.started > thought.started) return undefined;
  return thoughtParts(thought.text).heading || undefined;
}

/** "0s", "23s", "1m 5s": how long the turn has run, for the header. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? seconds + "s" : spentTime(seconds * 1000);
}

/** "23s · 7 steps" on the header's right. */
export const islandFacts = (ms: number, steps: number): string => [elapsed(ms), stepCount(steps)].filter(Boolean).join(" · ");

/** The receipt under a finished turn's answer: "Worked 42s · 9 steps", "Thought 12s", or the count alone. */
export function receiptLine({ took, steps, onlyThinking }: { took?: number; steps: number; onlyThinking: boolean }): string {
  const lead = took && took > 0 ? (onlyThinking ? "Thought " : "Worked ") + spentTime(took) : "";
  return [lead, stepCount(steps)].filter(Boolean).join(" · ") || "Show work";
}

/**
 * The glass capsule over the message box while a turn runs. With the island it shows only when the
 * island is out of view (scrolled away), so the two never say the same thing at once.
 */
export const capsuleShown = ({ working, island, islandInView }: { working: boolean; island: boolean; islandInView: boolean }): boolean => working && (!island || !islandInView);
