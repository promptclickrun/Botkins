// The turn as a story (the Activity panel: the phone's sheet and the computer's inspector), its crew
// (the helpers and background commands a turn started) and the crew's lanes over time. Plain logic
// with no imports from either app's framework: the same file is in desktop/src/ and in
// mobile/src/features/chat/, and desktop/test/activity-story.test.mjs checks the two are equal.
import { classifyStep, parseStepInput, summarizeSteps, type StepKind } from "./activityModel";

/** What this file reads of a step. Both apps' `Step` fits it. */
export type StoryStep = {
  id: string;
  name: string;
  label: string;
  status: string;
  started: number;
  finished?: number;
  input?: string;
  output?: string;
  progress?: string;
  source?: string;
  agentId?: string;
  background?: boolean;
  /** The computer can stop this one on its own ("stop-helper-v1"). */
  stoppable?: boolean;
};
export type StoryThought = { id: string; text: string; started: number; finished?: number };
export type StoryHelper = {
  id: string;
  name: string;
  description?: string;
  status: string;
  started: number;
  finished?: number;
  detail?: string;
  prompt?: string;
  intent?: string;
  result?: string;
  stoppable?: boolean;
};
export type StoryRun<S extends StoryStep = StoryStep> = {
  time: number;
  finished?: number;
  status?: string;
  steps?: S[];
  reasoning?: StoryThought[];
  agents?: StoryHelper[];
};
/** Text the bot wrote before it moved on (an interim message), with its time. */
export type StoryUpdate = { key: string; at: number; text: string };

export type ChapterItem<S extends StoryStep = StoryStep> = { kind: "step"; key: string; at: number; step: S } | { kind: "update"; key: string; at: number; update: StoryUpdate };

export type Chapter<S extends StoryStep = StoryStep> = {
  key: string;
  /** When it began. */
  at: number;
  /** The thought's heading ("Finding where coupons apply"), or what the steps did when no thought led them. */
  heading: string;
  /** The thought(s) that opened it: their whole text and the words after the heading. */
  thought?: { ids: string[]; text: string; snippet: string };
  /** Its steps and updates in the order they happened. */
  items: ChapterItem<S>[];
  steps: S[];
  /** Kinds of work and how many of each, in the order they first came ("3 files · 2 searches"). */
  counts: { kind: StepKind; count: number }[];
  failed: number;
  running: boolean;
};

const flat = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();

/**
 * A thought's heading and what follows. Models that summarize their reasoning start a part with a
 * bold or Markdown heading; otherwise the first sentence stands in.
 */
export function thoughtHeading(text: string): { heading: string; snippet: string } {
  const body = text.trim();
  const marked = /^\*\*(.+?)\*\*[ \t]*\n?/.exec(body) ?? /^#{1,6}\s+(.+)\n?/.exec(body);
  if (marked) return { heading: flat(marked[1]), snippet: flat(body.slice(marked[0].length)) };
  const line = flat(body);
  const end = /^(.{8,80}?)[.!?:](\s|$)/.exec(line);
  if (end) return { heading: end[1], snippet: line.slice(end[0].length).trim() };
  if (line.length <= 60) return { heading: line, snippet: "" };
  const cut = line.lastIndexOf(" ", 56);
  return { heading: line.slice(0, cut > 20 ? cut : 56) + "…", snippet: line.slice(cut > 20 ? cut + 1 : 56) };
}

/** The bot's own steps for the story: not a helper's, not a background command's, and not quiet bookkeeping. */
export const storySteps = <S extends StoryStep>(steps: S[] | undefined): S[] => (steps ?? []).filter((step) => !step.agentId && !step.background && !!classifyStep(step));

function countKinds(steps: StoryStep[]): { kind: StepKind; count: number }[] {
  const counts = new Map<StepKind, number>();
  for (const step of steps) {
    const kind = classifyStep(step);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/**
 * The turn in chapters. Each thought opens one, and the steps and updates after it, up to the next
 * thought, are its work. A thought with nothing after it before the next one joins the next (a model
 * that thinks in several short parts makes one chapter, not five). What came before the first
 * thought is a chapter of its own. With no thinking at all, each update closes a chapter, and the
 * heading says what the steps did.
 */
export function storyChapters<S extends StoryStep>(run: StoryRun<S>, updates: StoryUpdate[] = []): Chapter<S>[] {
  type Entry = { at: number; order: number } & ({ kind: "thought"; thought: StoryThought } | ChapterItem<S>);
  const entries: Entry[] = [];
  const thoughts = (run.reasoning ?? []).filter((thought) => /\S/.test(thought.text));
  thoughts.forEach((thought, i) => entries.push({ kind: "thought", at: thought.started, order: i, thought }));
  const offset = entries.length;
  // An update that came with a step reads first, as in the chat.
  updates.filter((update) => /\S/.test(update.text)).forEach((update, i) => entries.push({ kind: "update", key: "update-" + update.key, at: update.at, order: offset + i, update }));
  const stepsFrom = entries.length;
  storySteps(run.steps).forEach((step, i) => entries.push({ kind: "step", key: "step-" + step.id, at: step.started, order: stepsFrom + i, step }));
  entries.sort((a, b) => a.at - b.at || a.order - b.order);

  type Open = { key: string; at: number; thoughts: StoryThought[]; items: ChapterItem<S>[] };
  const open: Open[] = [];
  const current = () => open[open.length - 1];
  const start = (key: string, at: number) => open.push({ key, at, thoughts: [], items: [] });
  for (const entry of entries) {
    if (entry.kind === "thought") {
      const last = current();
      if (last && !last.items.length) last.thoughts.push(entry.thought);
      else {
        start("chapter-" + entry.thought.id, entry.thought.started);
        current().thoughts.push(entry.thought);
      }
      continue;
    }
    if (!current()) start("chapter-start", entry.at);
    current().items.push(entry);
    // Without thinking, an update ends what led to it.
    if (!thoughts.length && entry.kind === "update") start("chapter-after-" + entry.key, entry.at);
  }
  return open
    .filter((chapter) => chapter.thoughts.length || chapter.items.length)
    .map((chapter): Chapter<S> => {
      const steps = chapter.items.flatMap((item) => (item.kind === "step" ? [item.step] : []));
      const text = chapter.thoughts.map((thought) => thought.text.trim()).join("\n\n");
      const parts = text ? thoughtHeading(chapter.thoughts[0].text) : undefined;
      const rest = chapter.thoughts.slice(1).map((thought) => flat(thought.text));
      const running = steps.some((step) => step.status === "Running");
      return {
        key: chapter.key,
        at: chapter.at,
        heading: parts?.heading || summarizeSteps(steps, { running }) || (chapter.items.length ? "Update" : "Working"),
        ...(parts && { thought: { ids: chapter.thoughts.map((thought) => thought.id), text, snippet: [parts.snippet, ...rest].filter(Boolean).join(" ") } }),
        items: chapter.items,
        steps,
        counts: countKinds(steps),
        failed: steps.filter((step) => step.status === "Failed").length,
        running,
      };
    });
}

// ── The crew ─────────────────────────────────────────────────────────────────────────────────────

export type CrewMember<S extends StoryStep = StoryStep> =
  | { kind: "helper"; id: string; name: string; status: string; started: number; finished?: number; doing?: string; done?: string; steps: number; stoppable: boolean; helper: StoryHelper }
  | { kind: "command"; id: string; name: string; status: string; started: number; finished?: number; doing?: string; stoppable: boolean; step: S };

export type Crew<S extends StoryStep = StoryStep> = {
  members: CrewMember<S>[];
  /** When the first of them started: where the crew card sits in the chat. */
  at: number;
  running: number;
  failed: number;
  /** Every step the helpers ran. */
  steps: number;
};

const lastLine = (text?: string) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

/** A helper or command still at work. */
export const isLive = (status: string) => status === "Running";

/**
 * The helpers and background commands a turn started, in the order they started, or null when it
 * started none. A helper's line is what it says it is doing while it runs, and what it came back
 * with once it ended; a command's is its newest line of output.
 */
export function crewOf<S extends StoryStep>(run: StoryRun<S>): Crew<S> | null {
  const steps = run.steps ?? [];
  const helpers = (run.agents ?? []).map((helper): CrewMember<S> => {
    const live = isLive(helper.status);
    const done = !live ? lastLine(helper.result) ?? lastLine(helper.detail) : undefined;
    return {
      kind: "helper",
      id: helper.id,
      name: helper.name,
      status: helper.status,
      started: helper.started,
      finished: helper.finished,
      ...(live && (helper.intent || helper.detail) ? { doing: helper.intent || helper.detail } : {}),
      ...(done ? { done } : {}),
      steps: steps.filter((step) => step.agentId === helper.id).length,
      stoppable: live && !!helper.stoppable,
      helper,
    };
  });
  const commands = steps
    .filter((step) => step.background)
    .map((step): CrewMember<S> => {
      const parsed = parseStepInput(step);
      const name = parsed.command?.split("\n")[0]?.trim() || parsed.description || step.label || step.name;
      const line = lastLine(step.progress || step.output);
      return {
        kind: "command",
        id: step.id,
        name,
        status: step.status,
        started: step.started,
        finished: step.finished,
        ...(line ? { doing: line } : {}),
        stoppable: isLive(step.status) && !!step.stoppable,
        step,
      };
    });
  const members = [...helpers, ...commands].sort((a, b) => a.started - b.started);
  if (!members.length) return null;
  return {
    members,
    at: members[0].started,
    running: members.filter((member) => isLive(member.status)).length,
    failed: members.filter((member) => member.status === "Failed").length,
    steps: helpers.reduce((sum, member) => sum + (member.kind === "helper" ? member.steps : 0), 0),
  };
}

/** The crew's line when it is folded: "2 helpers · 1 command · 2 working", "2 helpers · 11 steps". */
export function crewLine(crew: Crew): string {
  const helpers = crew.members.filter((member) => member.kind === "helper").length;
  const commands = crew.members.length - helpers;
  const parts = [
    helpers ? helpers + (helpers === 1 ? " helper" : " helpers") : "",
    commands ? commands + (commands === 1 ? " command" : " commands") : "",
  ].filter(Boolean);
  if (crew.running) parts.push(crew.running + " working");
  else if (crew.steps) parts.push(crew.steps + (crew.steps === 1 ? " step" : " steps"));
  if (crew.failed) parts.push(crew.failed + " failed");
  return parts.join(" · ");
}

// ── Lanes ────────────────────────────────────────────────────────────────────────────────────────

export type LaneSegment = { from: number; to: number; state: "work" | "wait" };
export type Lane = { id: string; kind: "bot" | "helper" | "command"; label: string; status: string; live: boolean; segments: LaneSegment[] };

/**
 * One lane for the bot and one for each helper and command, across the turn's time, as fractions
 * of it (0 to 1). The bot's lane is pale where it waited on a helper: while one of its own steps
 * that started a helper ran. `now` ends what is still running.
 */
export function crewLanes<S extends StoryStep>(run: StoryRun<S>, now: number, botName = "Bot"): { start: number; end: number; lanes: Lane[] } {
  const crew = crewOf(run);
  const start = run.time;
  const ends = [run.finished ?? now, ...(crew?.members ?? []).map((member) => member.finished ?? now)];
  const end = Math.max(start + 1, ...ends);
  const span = end - start;
  const at = (time: number) => Math.min(1, Math.max(0, (time - start) / span));
  const botEnd = run.finished ?? now;
  const waits = (run.steps ?? [])
    .filter((step) => !step.agentId && !step.background && classifyStep(step) === "helper")
    .map((step) => ({ from: at(step.started), to: at(step.finished ?? botEnd) }))
    .filter((wait) => wait.to > wait.from)
    .sort((a, b) => a.from - b.from);
  const segments: LaneSegment[] = [];
  let cursor = 0;
  const botTo = at(botEnd);
  for (const wait of waits) {
    const from = Math.max(wait.from, cursor);
    const to = Math.min(wait.to, botTo);
    if (to <= from) continue;
    if (from > cursor) segments.push({ from: cursor, to: from, state: "work" });
    segments.push({ from, to, state: "wait" });
    cursor = to;
  }
  if (botTo > cursor) segments.push({ from: cursor, to: botTo, state: "work" });
  const bot: Lane = { id: "bot", kind: "bot", label: botName, status: run.status ?? (run.finished ? "Done" : "Running"), live: run.finished === undefined, segments };
  const others = (crew?.members ?? []).map(
    (member): Lane => ({
      id: member.id,
      kind: member.kind,
      label: member.name,
      status: member.status,
      live: isLive(member.status),
      segments: [{ from: at(member.started), to: at(member.finished ?? now), state: "work" }],
    }),
  );
  return { start, end, lanes: [bot, ...others] };
}
