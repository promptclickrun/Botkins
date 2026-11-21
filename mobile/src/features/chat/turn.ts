// A chat in the order things happened: the person's message, then the bot's thinking, steps and
// text, a steer or an answer the person gave while it worked, what the bot did next, and its reply.
// A turn that ended without a reply says how it ended. No React Native imports, so
// tests/turn.test.ts runs it. What the computer sends for this is docs/turn-timeline.md.
//
// A computer with "turn-timeline-v1" sends the text a bot wrote before a step, a steer or a
// request as interim messages, and the person's answers as messages, each with its time. An older
// computer (the desktop app up to 0.15.x) sends one growing string for the reply so far, a time on
// each step and steer but none on the reply. There the phone does the best it can: it places
// steers by their time, and while it watches a turn it notes how long the text was when each step,
// steer or thought first showed (`RunMarks`), so the text can be cut where they came.
//
// Settings › Chat › Steps decides the layout. While a turn runs, every choice draws it in order:
// each part's steps (filtered by Failed only and Hidden), thinking and interim texts in place, and
// the text being written at the bottom. "show" (Every step) keeps that once the turn ends. Every
// other choice then folds it (fold.ts): the person's message, their steers and answers, the reply,
// and one fold line under the reply that holds the rest in order. While it runs, that line is a
// status line under the text ("Working… · 3 steps"), so the reply and the line stay put as it ends.
//
// Settings › Chat › Thinking and updates decides whether the bot's thinking and its interim texts
// are in the chat at all (Hidden leaves them to the activity sheet); the reply always is.
import type { Message, PanePanel, Reasoning, Run, Step, Subagent } from "@/link/types";
import { type FoldEntry, foldLine, foldParts, liveLine, type StepsChoice, stepCount } from "./fold";

export const TIMELINE_V1 = "turn-timeline-v1";

export type TurnPrefs = { steps: StepsChoice; thinking: "show" | "folded" | "hide" };

/** How a turn ended without finishing: a short label in the desktop app's words, and its detail. */
export type Ending = { kind: "failed" | "timed-out" | "interrupted" | "stopped"; label: string; detail: string };

/** One row of the chat's list. */
export type Item =
  | {
      kind: "message";
      key: string;
      message: Message;
      /** Its place in the whole chat, for Fork from here. */
      index: number;
      run?: Run;
      /** The run's last reply: its cards go under it. */
      end: boolean;
      /** The newest message in the chat. */
      latest: boolean;
      /** A group chat's turn keeps its work line under its last reply. */
      workUnder?: boolean;
    }
  /** What the bot did between two things it said or the person said: steps, and its thinking while the turn runs. */
  /** `run` is for its id only: a row kept by `reuseItems` can hold the run as it was a moment ago. */
  | { kind: "work"; key: string; run: Run; steps: Step[]; thinking: string; live: boolean; /** A finished part's line ("Ran 2 commands"). */ label: string }
  /** Text the bot wrote before it moved on: an interim message, or a piece this phone noted from an older computer. */
  | { kind: "text"; key: string; text: string; /** The turn ended right after it. */ unfinished?: boolean }
  /** The bot's thinking in a finished turn, where it began (Every step). */
  | { kind: "thought"; key: string; text: string }
  /** The computer's screen, where a bot showed it (a side pane tab of kind "screen"). */
  | { kind: "screen"; key: string; panel: PanePanel }
  | { kind: "ended"; key: string; run: Run; ending: Ending; /** The newest turn, and nothing under way: Try again is offered. */ retry: boolean }
  /** The end of the turn under way: its latest steps and thinking, and the text being written. */
  | { kind: "live"; key: "live"; run?: Run; steps: Step[]; thinking: string; text: string; /** Room under the text for the reply's row, so it stays put when it becomes the reply. */ reserve?: true }
  /**
   * A folded turn's work in one line (fold.ts), under its reply. While a turn runs (`live`, in every
   * Steps mode), its status line: the bot's face, its typing dots and `count`. The key stays when it ends.
   */
  | {
      kind: "fold";
      key: string;
      run: Run;
      entries: FoldEntry[];
      live: boolean;
      /** The whole line, as VoiceOver reads it. */
      line: string;
      /** Finished: "Worked for 11s" (or empty). While live the bot's intent or "Working…" is drawn instead. */
      lead?: string;
      /** "7 steps", "1 step failed", or empty: the pill. The same while live and finished. */
      count: string;
    };

/** What the phone noted about a turn it watched: the text's length when each thing first showed, and the last text it saw. */
export type RunMarks = { marks: Record<string, number>; text: string };

export type TimelineInput = {
  /** The chat's messages as loaded, oldest first; `from` is the first one's place in the whole chat. */
  messages: Message[];
  from: number;
  /** Finished runs, by id (they come with the chat's messages). */
  runs: Record<string, Run>;
  /** The chat's run part: the turn under way, or its newest turn when that ended without a reply. */
  running?: Run | null;
  /** `stream` is the reply so far; missing when no turn is under way. `thinking` is the live thinking text. */
  live?: { stream?: string; thinking?: string };
  marks?: Record<string, RunMarks>;
  /** The computer has "turn-timeline-v1". */
  timeline: boolean;
  group: boolean;
  /** The side pane's tabs of kind "screen". */
  screens?: PanePanel[];
  prefs: TurnPrefs;
};

/** The run part is the turn under way only while it is working; otherwise it is a turn that ended without a reply. */
export const underWay = (run: Run | null | undefined): Run | undefined => (run?.status === "Working" ? run : undefined);

const ENDED = new Set(["Needs you", "Interrupted", "Stopped"]);
const TIMED_OUT = /stall|timed? ?out|didn't finish in time|did not finish in time|took too long|no (event|answer|response) for/i;

/** How a run ended, when it didn't finish. The label is the desktop app's status word, or "Timed out". */
export function endingOf(run: Run): Ending | null {
  if (!ENDED.has(run.status) && !run.ending) return null;
  if (run.status === "Completed" || run.status === "Working") return null;
  const detail = run.detail?.trim() || "Reply stopped.";
  const kind: Ending["kind"] = run.ending ?? (run.status === "Stopped" ? "stopped" : run.status === "Interrupted" ? "interrupted" : TIMED_OUT.test(run.detail ?? "") ? "timed-out" : "failed");
  const label = kind === "timed-out" ? "Timed out" : kind === "stopped" ? "Stopped" : kind === "interrupted" ? "Interrupted" : "Needs you";
  return { kind, label, detail };
}

// ── The desktop app's words for work (desktop/canvas.mjs, workSummary) ───────────────────────────

const KINDS: [RegExp, string][] = [
  [/^(bash|powershell|shell|terminal|run_command|exec|write_bash|write_powershell|read_bash|read_powershell)$/, "command"],
  [/^(view|read|read_file|cat|open_file)$/, "read"],
  [/^(create|write|write_file|create_file)$/, "write"],
  [/^(edit|str_replace|str_replace_editor|apply_patch|patch|multi_edit|insert)$/, "edit"],
  [/^(grep|glob|search|search_files|find|rg|ls|list_dir|list_directory)$/, "search-files"],
  [/^(web_search|search_web|bing_search|google_search)$/, "web"],
  [/^(web_fetch|fetch|fetch_url|browse|browser_navigate)$/, "web-page"],
  [/^(ask_user|ask)$/, "ask"],
  [/^(task|subagent|run_subagent|delegate)$/, "helper"],
  [/^(sql|update_todo|todo|todo_write|todowrite|manage_todo_list)$/, "plan"],
  [/^(skill|read_skill|use_skill)$/, "skill"],
  [/^render_card$/, "card"],
  [/^today_/, "panel"],
];
const WORDS: Record<string, [string, string]> = {
  command: ["Ran a command", "Ran %d commands"],
  read: ["Read a file", "Read %d files"],
  write: ["Wrote a file", "Wrote %d files"],
  edit: ["Edited a file", "Edited %d files"],
  "search-files": ["Searched files", "Searched files %d times"],
  web: ["Searched the web", "Searched the web %d times"],
  "web-page": ["Read a web page", "Read %d web pages"],
  ask: ["Asked you a question", "Asked you %d questions"],
  helper: ["Started a helper", "Started %d helpers"],
  plan: ["Updated the plan", "Updated the plan"],
  skill: ["Used a skill", "Used %d skills"],
  card: ["Made a card", "Made %d cards"],
  panel: ["Updated a panel", "Updated panels %d times"],
  tool: ["Used a tool", "Used %d tools"],
};
const QUIET = /^(report_intent|think|thinking|task_complete|read_agent|list_agents)$/;

function toolKind(name: string): string | null {
  const n = name.toLowerCase();
  if (QUIET.test(n)) return null;
  return KINDS.find(([pattern]) => pattern.test(n))?.[1] ?? "tool";
}

/** "Ran 3 commands, read 2 files, searched the web": from tool names only, as the desktop app says it. */
export function workSummary(steps: Step[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const kind = step.source ? "tool" : toolKind(step.name || "");
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => (n === 1 ? WORDS[kind][0] : WORDS[kind][1].replace("%d", String(n))));
  if (!parts.length) return "";
  const text = parts.slice(0, 4).join(", ").toLowerCase();
  return text[0].toUpperCase() + text.slice(1);
}

/** A field of a step's input, which the computer sends as JSON text (it may be cut short). */
export function inputField(input: string | undefined, ...names: string[]): string | undefined {
  if (!input) return undefined;
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    for (const name of names) {
      const field = value?.[name];
      if (typeof field === "string" && field.trim()) return field.trim();
    }
  } catch {
    // Cut short or not JSON: nothing to read.
  }
  return undefined;
}

/** A step as a line. A question the bot asked reads as one ("Asked you: Which one?"). */
export function stepLabel(step: Step): string {
  if (/^(ask_user|ask)$/i.test(step.name)) {
    const question = inputField(step.input, "question", "prompt", "message");
    if (question) return "Asked you: " + question;
  }
  return step.label || step.name;
}

const stepsLine = (n: number) => (n === 1 ? "1 step" : n + " steps");
const failedLine = (n: number) => (n === 1 ? "1 step failed" : n + " steps failed");

// ── What the phone notes while it watches a turn (for a computer without the capability) ────────

const personOf = (message: Message): string | undefined => message.steeredRunId ?? message.answer?.runId;
/**
 * What an answer's bubble says. The request's title is drawn above the bubble, so a receipt that
 * starts with it (a secure input's "Sign in · Provided Username, Password") is shown without it.
 */
export function answerText(message: Pick<Message, "text" | "answer">): string {
  const text = message.text ?? "";
  const title = message.answer?.title;
  return title && text.startsWith(title + " · ") ? text.slice(title.length + 3) : text;
}
export const personKey = (message: Message) => "p:" + (message.time ?? 0) + ":" + message.text.length;
const stepKey = (step: Step) => "s:" + step.id;
const thoughtKey = (thought: Reasoning) => "r:" + thought.id;

/** What in a turn the phone notes the text's length for: its own steps, its thoughts, and the person's messages in it. */
export function markKeys(run: Run, messages: Message[]): string[] {
  return [
    ...(run.steps ?? []).filter((step) => !step.agentId).map(stepKey),
    ...(run.reasoning ?? []).map(thoughtKey),
    ...messages.filter((message) => personOf(message) === run.id).map(personKey),
  ];
}

/**
 * Notes what is new. What was there the first time the phone looked counts from the start of the
 * text (it can't know better). The same object comes back when nothing changed.
 */
export function noteMarks(held: RunMarks | undefined, stream: string, keys: string[]): RunMarks {
  if (!held) return { marks: Object.fromEntries(keys.map((key) => [key, 0])), text: stream };
  let marks = held.marks;
  for (const key of keys) {
    if (key in marks) continue;
    if (marks === held.marks) marks = { ...held.marks };
    marks[key] = stream.length;
  }
  const text = stream || held.text;
  if (marks === held.marks && text === held.text) return held;
  return { marks, text };
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

type Entry =
  | { at: number; order: 0; kind: "thought"; thought: Reasoning; key: string }
  | { at: number; order: 1; kind: "message"; index: number }
  | { at: number; order: 2; kind: "step"; step: Step; key: string }
  | { at: number; order: 3; kind: "screen"; panel: PanePanel };

const timeOf = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY);
const clean = (text: string) => text.replace(/^\s+|\s+$/g, "");
const covered = (reply: string, text: string) => !!reply && reply.includes(clean(text));

/** The chat's list, oldest first. ChatScreen reverses it for its inverted list. */
export function chatTimeline(input: TimelineInput): Item[] {
  const { messages, from, runs, timeline, group, prefs } = input;
  const streaming = typeof input.live?.stream === "string";
  const current = underWay(input.running);
  const working = streaming || !!current;
  const runOf = (id: string | undefined): Run | undefined => (!id ? undefined : current?.id === id ? current : (runs[id] ?? (input.running?.id === id ? input.running : undefined)));
  // The turn the person can try again: the run of their last message that started one.
  let lastAsked: string | undefined;
  for (let i = messages.length - 1; i >= 0 && !lastAsked; i--) if (messages[i].role === "user" && messages[i].runId) lastAsked = messages[i].runId;

  // Which messages belong to which run: the person's message that started it, what came in during it, its replies.
  const owners = messages.map((message) => personOf(message) ?? message.runId);
  const screens = [...(input.screens ?? [])];
  const placed = new Set<string>();
  const done = new Set<string>();
  const items: Item[] = [];
  const messageItem = (index: number, more: Partial<Extract<Item, { kind: "message" }>> = {}): Item => {
    const message = messages[index];
    return { kind: "message", key: "m" + (from + index), message, index: from + index, run: runOf(message.runId), end: false, latest: index === messages.length - 1, ...more };
  };
  const folding = prefs.steps !== "show";
  // Thinking and updates on Hidden: neither the bot's thinking nor its interim texts are in the chat.
  const asides = prefs.thinking !== "hide";
  const shownSteps = (steps: Step[]) => (prefs.steps === "hide" ? [] : prefs.steps === "failed" ? steps.filter((step) => step.status === "Failed") : steps);
  /** The newest part of the turn under way. With a run, nothing to draw means no row: the status line under it is the bot's face. */
  const live = (run: Run | undefined, steps: Step[], thinking: string, text: string): Item[] =>
    run && !text && !thinking && !shownSteps(steps).length ? [] : [{ kind: "live", key: "live", run, steps, thinking, text, ...(folding && { reserve: true as const }) }];
  /** Under a turn under way, in every mode: its status line, which becomes the fold line where the turn folds. */
  const statusLine = (run: Run): Item => {
    const own = (run.steps ?? []).filter((step) => !step.agentId);
    const failed = own.filter((step) => step.status === "Failed").length;
    return { kind: "fold", key: "f:" + run.id, run, entries: [], live: true, line: liveLine({ steps: own.length, failed, mode: prefs.steps }), count: stepCount(prefs.steps, own.length, failed) };
  };

  const block = (runId: string) => {
    done.add(runId);
    const run = runOf(runId);
    const mine = messages.map((_, i) => i).filter((i) => owners[i] === runId);
    const isLive = streaming && !!run && run.id === current?.id;
    const starts = mine.filter((i) => messages[i].role === "user" && messages[i].runId === runId && personOf(messages[i]) === undefined);
    const start = starts[0];
    if (start !== undefined) items.push(messageItem(start));
    const replies = mine.filter((i) => i !== start && personOf(messages[i]) === undefined && !messages[i].interim);
    const inside = mine.filter((i) => i !== start && !replies.includes(i));
    const ending = run && !isLive && run.id !== current?.id ? endingOf(run) : null;
    const note = (): Item[] => (run && ending ? [{ kind: "ended", key: "e" + run.id, run, ending, retry: run.id === lastAsked && !working }] : []);

    // A turn that folds is drawn in order while it runs, and folded once it ended.
    if (run && folding && !isLive) return foldTurn(run, replies, inside, note);

    // A group chat's members answer in turn; their work stays in one line under the last reply.
    if (group || !run) {
      for (const i of [...inside, ...replies].sort((a, b) => a - b)) {
        const message = messages[i];
        if (!message.interim) items.push(messageItem(i));
        else if (asides && clean(message.text)) items.push({ kind: "text", key: "i" + (from + i), text: clean(message.text) });
      }
      const last = items.at(-1);
      if (last?.kind === "message" && replies.length && messages[replies.at(-1)!] === last.message) {
        items[items.length - 1] = { ...last, end: true, workUnder: !folding && !!run && (!!run.summary || !!run.steps?.length) };
      }
      if (isLive) items.push(...live(run, run?.steps ?? [], asides ? (input.live?.thinking ?? "") : "", input.live?.stream ?? ""));
      if (isLive && run) items.push(statusLine(run));
      items.push(...note());
      return;
    }

    const entries: Entry[] = [];
    for (const i of inside) entries.push({ at: timeOf(messages[i].time), order: 1, kind: "message", index: i });
    for (const step of run.steps ?? []) if (!step.agentId) entries.push({ at: step.started, order: 2, kind: "step", step, key: stepKey(step) });
    // Thinking shows where it began (Settings › Chat › Thinking and updates says how, or not at all).
    if (asides) for (const thought of run.reasoning ?? []) entries.push({ at: thought.started, order: 0, kind: "thought", thought, key: thoughtKey(thought) });
    for (const panel of screens) {
      if (placed.has(panel.id) || panel.createdAt < run.time || panel.createdAt > timeOf(isLive ? undefined : run.finished)) continue;
      placed.add(panel.id);
      entries.push({ at: panel.createdAt, order: 3, kind: "screen", panel });
    }
    entries.sort((a, b) => a.at - b.at || a.order - b.order);

    // The text this phone noted for the turn, cut where things came (an older computer only).
    const noted = !timeline ? input.marks?.[run.id] : undefined;
    const text = isLive ? (input.live?.stream ?? "") : (noted?.text ?? "");
    const reply = replies.map((i) => messages[i].text).join("\n\n");
    let offset = 0;

    let steps: Step[] = [];
    let thoughts: Reasoning[] = [];
    let parts = 0;
    const segments: { steps: Step[]; thinking: string }[] = [];
    const flush = () => {
      if (!steps.length && !thoughts.length) return;
      const thinking = thoughts.map((thought) => thought.text.trim()).filter(Boolean).join("\n\n");
      segments.push({ steps, thinking });
      pushWork(steps, thinking, "w" + run.id + ":" + (steps[0]?.id ?? thoughts[0]?.id));
      steps = [];
      thoughts = [];
    };
    const pushWork = (list: Step[], thinking: string, key: string, whole = false) => {
      if (isLive) {
        const shown = prefs.steps === "hide" ? [] : prefs.steps === "failed" ? list.filter((step) => step.status === "Failed") : list;
        if (!shown.length && !thinking) return;
        items.push({ kind: "work", key, run, steps: list, thinking, live: true, label: "" });
        return;
      }
      if (prefs.steps === "hide") return;
      const failed = list.filter((step) => step.status === "Failed").length;
      if (prefs.steps === "failed" && !failed) return;
      if (!list.length && !(whole && run.summary)) return;
      const label = prefs.steps === "failed" ? failedLine(failed) : (whole && run.summary) || workSummary(list) || stepsLine(list.length);
      items.push({ kind: "work", key, run, steps: list, thinking: "", live: false, label });
    };
    const pushText = (piece: string, unfinished = false) => {
      const said = clean(piece);
      if (!asides || !said || covered(reply, said)) return;
      flush();
      parts++;
      items.push({ kind: "text", key: "t" + run.id + ":" + offset, text: said, ...(unfinished && { unfinished: true }) });
    };
    const textUpTo = (key: string) => {
      const mark = noted?.marks[key];
      if (mark === undefined || mark <= offset) return;
      const piece = text.slice(offset, mark);
      pushText(piece);
      offset = mark;
    };

    for (const entry of entries) {
      if (entry.kind === "step" || entry.kind === "thought") {
        textUpTo(entry.key);
        if (entry.kind === "step") steps.push(entry.step);
        else if (isLive) thoughts.push(entry.thought);
        else if (entry.thought.text.trim()) {
          // A finished turn's thinking is a row of its own where it began.
          flush();
          parts++;
          items.push({ kind: "thought", key: entry.key, text: entry.thought.text.trim() });
        }
        continue;
      }
      if (entry.kind === "message") {
        const message = messages[entry.index];
        // An interim text is drawn as the bot's update (Thinking and updates says how), not as a reply.
        if (message.interim) {
          if (!asides || !clean(message.text)) continue;
          flush();
          parts++;
          items.push({ kind: "text", key: "i" + (from + entry.index), text: clean(message.text) });
          continue;
        }
        textUpTo(personKey(message));
      }
      flush();
      parts++;
      if (entry.kind === "message") items.push(messageItem(entry.index));
      else items.push({ kind: "screen", key: "s" + entry.panel.id, panel: entry.panel });
    }

    const rest = text.slice(offset);
    if (isLive) {
      // The newest part goes with the text being written, at the bottom.
      const thinking = thoughts.map((thought) => thought.text.trim()).filter(Boolean).join("\n\n") || (!run.reasoning?.length && prefs.thinking !== "hide" ? (input.live?.thinking ?? "") : "");
      items.push(...live(run, steps, thinking, rest.replace(/^\s+/, "")));
      items.push(statusLine(run));
      return;
    }
    // A finished turn: its last part's work line, what it wrote before it ended, its reply, how it ended.
    if (steps.length) pushWork(steps, "", "w" + run.id + ":" + steps[0].id, parts === 0 && segments.length === 0);
    steps = [];
    thoughts = [];
    if (noted && !replies.length) pushText(rest, true);
    replies.forEach((i, n) => items.push(messageItem(i, { end: n === replies.length - 1 })));
    items.push(...note());
  };

  /**
   * A folded turn once it ended (or between its stream ending and its run part saying so): what the
   * person said and the reply stay in the chat, everything else goes into the fold, in the order it
   * happened. A group chat keeps its members' replies in turn.
   */
  const foldTurn = (run: Run, replies: number[], inside: number[], note: () => Item[]) => {
    const mode = prefs.steps as Exclude<StepsChoice, "show">;
    const own = (run.steps ?? []).filter((step) => !step.agentId);
    const shows = (step: Step) => mode === "folded" || (mode === "failed" && step.status === "Failed");
    const entries: Entry[] = [];
    for (const i of inside) entries.push({ at: timeOf(messages[i].time), order: 1, kind: "message", index: i });
    for (const step of own) entries.push({ at: step.started, order: 2, kind: "step", step, key: stepKey(step) });
    if (asides) for (const thought of run.reasoning ?? []) entries.push({ at: thought.started, order: 0, kind: "thought", thought, key: thoughtKey(thought) });
    if (!group)
      for (const panel of screens) {
        if (placed.has(panel.id) || panel.createdAt < run.time || panel.createdAt > timeOf(run.finished)) continue;
        placed.add(panel.id);
        entries.push({ at: panel.createdAt, order: 3, kind: "screen", panel });
      }
    entries.sort((a, b) => a.at - b.at || a.order - b.order);

    // The text this phone noted for the turn (an older computer only), cut where things came.
    const noted = !timeline && !group ? input.marks?.[run.id] : undefined;
    const text = noted?.text ?? "";
    const reply = replies.map((i) => messages[i].text).join("\n\n");
    const fold: FoldEntry[] = [];
    const shown: Item[] = [];
    let offset = 0;
    const textUpTo = (key: string) => {
      const mark = noted?.marks[key];
      if (mark === undefined || mark <= offset) return;
      const said = clean(text.slice(offset, mark));
      if (asides && said && !covered(reply, said)) fold.push({ kind: "text", key: "t" + run.id + ":" + offset, text: said });
      offset = mark;
    };
    for (const entry of entries) {
      if (entry.kind === "step") {
        textUpTo(entry.key);
        if (shows(entry.step)) fold.push({ kind: "step", key: entry.key, step: entry.step });
      } else if (entry.kind === "thought") {
        textUpTo(entry.key);
        const said = entry.thought.text.trim();
        if (said) fold.push({ kind: "thought", key: entry.key, text: said });
      } else if (entry.kind === "screen") shown.push({ kind: "screen", key: "s" + entry.panel.id, panel: entry.panel });
      else {
        const message = messages[entry.index];
        if (message.interim) {
          const said = clean(message.text);
          if (asides && said) fold.push({ kind: "text", key: "i" + (from + entry.index), text: said });
          continue;
        }
        textUpTo(personKey(message));
        if (!group) shown.push(messageItem(entry.index));
        const title = message.answer?.title;
        fold.push({ kind: "person", key: "p" + (from + entry.index), text: (title ? title + ": " : "") + answerText(message) });
      }
    }
    const rest = text.slice(offset).replace(/^\s+/, "");
    if (asides && noted && !replies.length && clean(rest)) fold.push({ kind: "text", key: "t" + run.id + ":" + offset, text: clean(rest) });
    if (group) {
      const said = [...inside, ...replies].filter((i) => !messages[i].interim).sort((a, b) => a - b);
      for (const i of said) items.push(messageItem(i, { end: i === replies.at(-1) }));
    } else {
      items.push(...shown);
      replies.forEach((i, n) => items.push(messageItem(i, { end: n === replies.length - 1 })));
    }
    const counted = own.length;
    const failed = own.filter((step) => step.status === "Failed").length;
    // Still the turn under way while the run part says so, also in the moment its stream has ended.
    const stillRunning = run.id === current?.id;
    // A finished fold shows when it holds something of the bot's, not only where the person spoke.
    if (stillRunning || fold.some((entry) => entry.kind !== "person")) {
      const took = run.finished ? run.finished - run.time : run.usage?.durationMs;
      const onlyThinking = fold.every((entry) => entry.kind === "thought");
      const facts = { took, steps: counted, failed, mode, onlyThinking };
      const line = stillRunning ? liveLine(facts) : foldLine(facts);
      const parts = stillRunning ? { count: stepCount(mode, counted, failed) } : foldParts(facts);
      items.push({ kind: "fold", key: "f:" + run.id, run, entries: fold, live: stillRunning, line, ...parts });
    }
    items.push(...note());
  };

  for (let i = 0; i < messages.length; i++) {
    const owner = owners[i];
    if (!owner) {
      items.push(messageItem(i));
      continue;
    }
    if (!done.has(owner)) block(owner);
  }
  // The turn under way when none of its messages is loaded yet.
  if (streaming && !items.some((item) => item.kind === "live" || (item.kind === "fold" && item.live))) {
    const run = current;
    items.push(...live(run, run?.steps?.filter((step) => !step.agentId) ?? [], asides ? (input.live?.thinking ?? "") : "", input.live?.stream ?? ""));
    if (run) items.push(statusLine(run));
  }

  // A screen shown outside any turn sits by its time.
  for (const panel of screens) {
    if (placed.has(panel.id)) continue;
    const before = items.findIndex((item) => itemTime(item) > panel.createdAt);
    items.splice(before < 0 ? items.length : before, 0, { kind: "screen", key: "s" + panel.id, panel });
  }
  return items;
}

/** When a row happened, where that is known (for placing a screen between rows). */
function itemTime(item: Item): number {
  switch (item.kind) {
    case "message":
      return item.message.time ?? Number.NaN;
    case "work":
      return item.steps[0]?.started ?? Number.NaN;
    case "thought":
      return Number.NaN;
    case "screen":
      return item.panel.createdAt;
    case "ended":
      return item.run.finished ?? Number.NaN;
    case "live":
      return Number.POSITIVE_INFINITY;
    case "fold":
      return item.live ? Number.POSITIVE_INFINITY : (item.run.finished ?? Number.NaN);
    default:
      return Number.NaN;
  }
}

/** The turn's helpers that are still running. */
export const runningHelpers = (agents: Subagent[] | undefined) => (agents ?? []).filter((agent) => agent.status === "Running");

const shallow = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
  }
  return false;
};
// A list's members are compared one level down, so a fold's entries made again from the same steps count as the same.
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => shallow(value, b[i]));
  return shallow(a, b);
};
/**
 * The list again, with each row that didn't change kept as the same object, so a row drawn from it
 * isn't drawn again while the reply streams. `held` is the rows of the last list, by key.
 */
export function reuseItems(held: Map<string, Item> | undefined, next: Item[]): { items: Item[]; byKey: Map<string, Item> } {
  const byKey = new Map<string, Item>();
  const items = next.map((item) => {
    const before = held?.get(item.key);
    const keys = Object.keys(item);
    const same = !!before && keys.length === Object.keys(before).length && keys.every((key) => {
      const now = (item as Record<string, unknown>)[key];
      const was = (before as Record<string, unknown>)[key];
      // A work row draws its own steps and reads only its run's id (LiveTurn.tsx). The run under way
      // is a new object with every step, so by the object each of its rows would be drawn again.
      if (key === "run" && item.kind === "work") return (now as Run | undefined)?.id === (was as Run | undefined)?.id;
      return sameValue(now, was);
    });
    const kept = same ? before : item;
    byKey.set(item.key, kept);
    return kept;
  });
  return { items, byKey };
}
