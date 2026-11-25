// Plain rules for the side pane's Activity and Crew tabs (ActivityInspector.tsx). No value imports,
// so desktop/test/inspector.test.mjs runs this file with plain `node --test`.
import type { StepKind } from "./activityModel";
import type { Chapter, StoryStep, StoryThought } from "./activityStory";

/** "0:41", "12:05" or "1:02:05": how far into the turn something happened. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? Math.floor(s / 3600) + ":" + two(Math.floor(s / 60) % 60) + ":" + two(s % 60) : Math.floor(s / 60) + ":" + two(s % 60);
}

/** "6.2s" or "1m 4s": how long a step took. */
export function took(ms: number): string {
  if (ms < 60_000) return Math.max(0.1, ms / 1000).toFixed(1) + "s";
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}

export type Filter = "all" | "thinking" | "commands" | "edits" | "reads" | "web" | "failed";
export const FILTER_NAMES: Record<Filter, string> = { all: "All", thinking: "Thinking", commands: "Commands", edits: "Edits", reads: "Reads", web: "Web", failed: "Failed" };

/** The chip a kind of step is counted under; other kinds show only under All. */
export function filterOf(kind: StepKind | null | undefined): Filter | null {
  switch (kind) {
    case "command":
      return "commands";
    case "edit":
    case "write":
      return "edits";
    case "read":
    case "search-files":
      return "reads";
    case "web":
    case "web-page":
      return "web";
    default:
      return null;
  }
}

/** The chips over the story: All, then each kind present with its count, in a fixed order. */
export function filterChips(chapters: Pick<Chapter, "thought" | "counts" | "failed">[]): { filter: Filter; count: number }[] {
  const counts = new Map<Filter, number>();
  const add = (filter: Filter, n: number) => n && counts.set(filter, (counts.get(filter) ?? 0) + n);
  for (const chapter of chapters) {
    add("thinking", chapter.thought ? chapter.thought.ids.length : 0);
    for (const { kind, count } of chapter.counts) {
      const filter = filterOf(kind);
      if (filter) add(filter, count);
    }
    add("failed", chapter.failed);
  }
  const order: Filter[] = ["thinking", "commands", "edits", "reads", "web", "failed"];
  const total = chapters.reduce((sum, chapter) => sum + chapter.counts.reduce((n, c) => n + c.count, 0), 0);
  return [{ filter: "all", count: total }, ...order.filter((filter) => counts.has(filter)).map((filter) => ({ filter, count: counts.get(filter)! }))];
}

/**
 * What the inspector shows first: the first failed step, else the newest step, else the first
 * chapter. `wanted` is what was clicked to open it: a step or update ("step-…", "update-…"), a
 * thought ("thought-…", which selects its chapter) or a chapter's key.
 */
export function pickSelection<S extends StoryStep>(chapters: Chapter<S>[], wanted?: string): string | undefined {
  if (wanted) {
    for (const chapter of chapters) {
      if (chapter.key === wanted || chapter.items.some((item) => item.key === wanted)) return wanted;
      if (wanted.startsWith("thought-") && chapter.thought?.ids.includes(wanted.slice(8))) return chapter.key;
    }
  }
  const steps = chapters.flatMap((chapter) => chapter.items.filter((item) => item.kind === "step"));
  const failed = steps.find((item) => item.kind === "step" && item.step.status === "Failed");
  return (failed ?? steps.at(-1))?.key ?? chapters[0]?.key;
}

/** The thought that began last at or before `at`: why the bot started a background command then. */
export function thoughtBefore(reasoning: StoryThought[] | undefined, at: number): StoryThought | undefined {
  let best: StoryThought | undefined;
  for (const thought of reasoning ?? []) {
    if (!/\S/.test(thought.text) || thought.started > at) continue;
    if (!best || thought.started >= best.started) best = thought;
  }
  return best;
}

/** The web addresses a command printed, oldest first and each once: "localhost:3000" becomes http://localhost:3000/. */
export function outputLinks(text: string | undefined, max = 4): string[] {
  const found: string[] = [];
  const pattern = /\bhttps?:\/\/[^\s"'<>`)\]]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s"'<>`)\]]*)?/g;
  for (const match of (text ?? "").replace(/\x1b\[[0-9;]*m/g, "").matchAll(pattern)) {
    let raw = match[0].replace(/[.,;:]+$/, "");
    if (!/^https?:/.test(raw)) raw = "http://" + raw;
    let url: string;
    try {
      url = new URL(raw.replace("//0.0.0.0", "//localhost")).href;
    } catch {
      continue;
    }
    if (!found.includes(url)) found.push(url);
    if (found.length >= max) break;
  }
  return found;
}

/** A link's words on its button: the host and path, without the scheme and a bare "/". */
export const linkWords = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Marks under the lanes: four evenly spaced times, the last "now" while something still runs. */
export function laneTicks(span: number, live: boolean, count = 4): { at: number; label: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const at = i / (count - 1);
    return { at, label: live && i === count - 1 ? "now" : clock(span * at) };
  });
}

/** A helper's or command's initial, for its round face. */
export const initial = (name: string) => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "?").toUpperCase();

/** One of four steady colors for a crew member, by its place in the crew. */
export const crewColor = (index: number) => "var(--crew-" + ((index % 4) + 1) + ")";
