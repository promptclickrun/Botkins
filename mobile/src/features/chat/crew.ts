// The crew of a turn on the phone: the chat's crew card, the Activity sheet's chapters, and the
// helper and command sheets. The shared story and crew logic is activityStory.ts; this is what the
// phone adds around it. No React Native imports, so tests/crew.test.ts runs it.
import type { StepKind } from "./activityModel";
import { type Chapter, type Crew, crewLine, type StoryRun, type StoryStep, type StoryThought } from "./activityStory";

/**
 * What the collapsed crew card draws: its line and each member's state. The chat's row is drawn
 * again only when one of these changes, not on every step a helper takes.
 */
export function crewFace(crew: Crew): { line: string; marks: string[] } {
  return { line: crewLine(crew), marks: crew.members.map((member) => member.status) };
}

/** "0:41", "12:03", "1:02:09": a time from the turn's start. */
export function clockOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + s : m + ":" + s;
}

const NOUNS: Record<StepKind, [string, string]> = {
  command: ["command", "commands"],
  read: ["file", "files"],
  write: ["new file", "new files"],
  edit: ["edit", "edits"],
  "search-files": ["search", "searches"],
  web: ["web", "web"],
  "web-page": ["page", "pages"],
  ask: ["question", "questions"],
  helper: ["helper", "helpers"],
  plan: ["plan", "plans"],
  skill: ["skill", "skills"],
  card: ["card", "cards"],
  panel: ["panel", "panels"],
  tool: ["tool", "tools"],
};

/** One count as words: "3 files", "1 web", "2 searches". */
export const countWords = ({ kind, count }: { kind: StepKind; count: number }) => count + " " + (NOUNS[kind] ?? NOUNS.tool)[count === 1 ? 0 : 1];

/** A chapter's work in one line: "3 files · 2 searches · 1 web". */
export const countLine = (counts: Chapter["counts"]) => counts.map(countWords).join(" · ");

/**
 * Which chapters start open in the Activity sheet: one with a failed step, the one still running,
 * and the one holding the step a person tapped elsewhere (`stepId`).
 */
export function openChapters(chapters: Chapter[], stepId?: string): Set<string> {
  const open = new Set<string>();
  for (const chapter of chapters) {
    if (chapter.failed || chapter.running || (stepId && chapter.steps.some((step) => step.id === stepId))) open.add(chapter.key);
  }
  return open;
}

/** The last useful lines of a failed step's output: no blank lines, no bare prompts. */
export function failedTail(text: string | undefined, lines = 3): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .slice(-lines)
    .join("\n");
}

/**
 * Why the bot started a step: the thought that began last before the step did (the one it was on).
 * Nothing when it hadn't thought yet, or the thought is empty.
 */
export function whyThought(thoughts: StoryThought[] | undefined, started: number): string | undefined {
  let best: StoryThought | undefined;
  for (const thought of thoughts ?? []) {
    if (thought.started > started || !/\S/.test(thought.text)) continue;
    if (!best || thought.started >= best.started) best = thought;
  }
  return best?.text.trim();
}

/**
 * The links a command printed, in the order they came, once each: http(s) addresses and a bare
 * "localhost:3000" (or 127.0.0.1, 0.0.0.0), each as a full http address.
 */
export function outputLinks(text: string | undefined, max = 4): string[] {
  const found: string[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s<>"'`]*)?/gi;
  for (const match of (text ?? "").matchAll(pattern)) {
    let url = match[0].replace(/[).,;:!?\]}]+$/, "");
    if (!/^https?:\/\//i.test(url)) url = "http://" + url;
    url = url.replace(/^(https?:\/\/)0\.0\.0\.0\b/i, "$1localhost");
    // "http://localhost:3000" and "http://localhost:3000/" are one link.
    const key = url.replace(/\/$/, "").toLowerCase();
    if (found.some((seen) => seen.replace(/\/$/, "").toLowerCase() === key)) continue;
    found.push(url);
    if (found.length >= max) break;
  }
  return found;
}

/**
 * The address is on your computer itself (localhost, 127.0.0.1, ::1): on the phone that would be
 * the phone, so the sheet shows it as text instead of opening it.
 */
export function onComputer(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** "localhost:3000" for a button, from "http://localhost:3000/". */
export const linkLabel = (url: string) => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The step a command sheet is about, and who started it when. */
export function commandOf<S extends StoryStep>(run: StoryRun<S>, stepId: string): S | undefined {
  return run.steps?.find((step) => step.id === stepId);
}

/** The newest `max` lines of a command's output, and how many were left out above them. */
export function outputTail(text: string | undefined, max = 400): { text: string; hidden: number } {
  const lines = (text ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length <= max) return { text: lines.join("\n"), hidden: 0 };
  return { text: lines.slice(-max).join("\n"), hidden: lines.length - max };
}
