// The activity island: Settings › Chat › Steps or Thinking set to Open. One small card under a
// running turn shows its newest lines; clicking the header lists every step in place. When the
// turn ends it folds into a receipt under the answer. Modeled on Bighelp's Card live-work block
// (ChatLiveWorkView.swift and ChatWorkReceipt).
//
// How it stays cheap: the lines are worked out once per change of the turn's steps or thoughts,
// the clock is its own small component that ticks once a second only while the bot works, and
// only the header's label shimmers (Shimmer.tsx, which pauses off screen).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, Check, ChevronRight, ChevronUp, Hand, MessageSquareText, X } from "lucide-react";
import { StepDetailBody, stepIcon, useNow } from "./ChatActivity";
import { Shimmer } from "./Shimmer";
import { classifyStep, isStepCoveredByRail, stepHeadline } from "./activityModel";
import { type IslandLine, type IslandUpdate, islandLabel, islandLines, islandMeta, islandWindow, reasoningTail, receiptLabel } from "./island";
import type { Run, Step } from "./types";
import "./island.css";

type WaitLine = { kind: "wait"; key: string; text: string };

/** The chat shows a step: a tool's quiet bookkeeping (report_intent, think) stays out, unless it
 * failed. A helper's own steps and a background command are the crew card's (ActivityInspector.tsx). */
const shownFor = (run: Run) => (step: Step) => !step.agentId && !step.background && !!classifyStep(step) && !isStepCoveredByRail(step, run);

function stepSeconds(step: Step) {
  return step.finished ? Math.max(1, Math.round((step.finished - step.started) / 1000)) + "s" : "";
}

/** One line of the window: an icon, then the step's label or the thought's heading and snippet. */
function Line({ line }: { line: IslandLine | WaitLine }) {
  if (line.kind === "wait") {
    return (
      <div className="island-row wait">
        <span className="island-icon" aria-hidden="true"><Hand size={14} /></span>
        <span className="island-text">{line.text}</span>
      </div>
    );
  }
  if (line.kind === "update") {
    return (
      <div className="island-row update">
        <span className="island-icon" aria-hidden="true"><MessageSquareText size={14} /></span>
        <span className="island-text">{line.text.replace(/\s+/g, " ")}</span>
      </div>
    );
  }
  if (line.kind === "thought") {
    return (
      <div className="island-row thought">
        <span className="island-icon" aria-hidden="true"><Brain size={14} /></span>
        <span className="island-text">{line.heading}{line.snippet && <span className="island-tail"> · {line.snippet}</span>}</span>
      </div>
    );
  }
  const Icon = stepIcon(line.step);
  const running = line.step.status === "Running";
  const failed = line.step.status === "Failed";
  return (
    <div className={"island-row" + (running ? " running" : "") + (failed ? " failed" : "")}>
      <span className="island-icon" aria-hidden="true"><Icon size={14} /></span>
      <span className="island-text">{stepHeadline(line.step)}{running && "…"}</span>
      {failed && <X size={12} className="island-failed" aria-label="Failed" />}
    </div>
  );
}

/** Every line, each opening the side pane's Activity on it (or, without `onOpen`, its details in place). Stays pinned to the newest. */
function FullList({ lines, chatId, runId, close, onToggle, onOpen }: { lines: IslandLine[]; chatId?: string; runId?: string; close: () => void; onToggle?: () => void; onOpen?: (key?: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <>
      <div
        className="island-list"
        ref={list}
        role="list"
        aria-label="Every step"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((line) => onOpen ? (
          <div key={line.key} className="island-item" role="listitem">
            <button type="button" className="island-item-open" onClick={() => onOpen(line.key)}>
              <Line line={line} />
              {line.kind === "step" && <span className="island-seconds">{stepSeconds(line.step)}</span>}
              <ChevronRight size={13} className="island-item-chevron" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <details key={line.key} className="island-item" role="listitem" onToggle={onToggle}>
            <summary>
              <Line line={line} />
              {line.kind === "step" && <span className="island-seconds">{stepSeconds(line.step)}</span>}
              <ChevronRight size={13} className="island-item-chevron" aria-hidden="true" />
            </summary>
            {line.kind === "step" ? <StepDetailBody step={line.step} chatId={chatId} runId={runId} /> : <p className="island-thought">{line.kind === "update" ? line.text : line.snippet || line.heading}</p>}
          </details>
        ))}
      </div>
      <button className="island-less" onClick={close}>
        <ChevronUp size={13} aria-hidden="true" />
        Show less
      </button>
    </>
  );
}

/** The chat makes the receipt's updates afresh on each draw: the receipt draws again only when they changed. */
function sameUpdates(a: IslandUpdate[] = [], b: IslandUpdate[] = []) {
  return a.length === b.length && a.every((update, i) => update.key === b[i].key && update.at === b[i].at && update.text === b[i].text);
}

/** Opening the card brings all of it into view, above the message box (`scroll-margin` in island.css). */
function reveal(card: HTMLElement | null) {
  requestAnimationFrame(() => card?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

/** "23s · 7 steps", ticking once a second while the bot works (`useNow` only re-renders this).
 * It holds still while the bot waits for the person, and that wait is not counted. */
function Clock({ since, waiting, steps }: { since: number; waiting: boolean; steps: number }) {
  useNow(!waiting);
  const pause = useRef({ total: 0, from: 0 });
  if (waiting && !pause.current.from) pause.current.from = Date.now();
  if (!waiting && pause.current.from) {
    pause.current.total += Date.now() - pause.current.from;
    pause.current.from = 0;
  }
  const end = waiting ? pause.current.from : Date.now();
  return <>{islandMeta(Math.max(0, end - since - pause.current.total), steps)}</>;
}

export type IslandProps = {
  run: Run;
  /** The bot's name, for "Pip is working". */
  who: string;
  /** The bot's still face. */
  avatar: ReactNode;
  /** A step waits for the person (an approval or a question in the chat). */
  waiting: boolean;
  /** What it waits for, as the request's card titles it. */
  waitingFor?: string;
  /** Steps is Open: the window shows the newest lines. Otherwise it shows the reasoning's tail. */
  steps: boolean;
  /** Thinking is Open. */
  thinking: boolean;
  /** Thinking is not Hidden: the full list keeps the thoughts. */
  thoughts: boolean;
  onToggle?: () => void;
  /** Opens the side pane's Activity on this turn, at a line's key ("step-…", "thought-…", "update-…"). */
  onOpen?: (key?: string) => void;
  /** Reports whether the live island card is visible inside the chat scroller. */
  onVisibility?: (visible: boolean) => void;
};

/** The live island under a running turn. */
export const ActivityIsland = memo(function ActivityIsland({ run, who, avatar, waiting, waitingFor, steps, thinking, thoughts, onToggle, onOpen, onVisibility }: IslandProps) {
  const [open, setOpen] = useState(false);
  // Every line in order (the thoughts too, unless Thinking is Hidden), for the label and the full list.
  const all = useMemo(() => islandLines(run, { thoughts, keep: shownFor(run) }), [run.steps, run.reasoning, run.teamwork, run.taskHandoffs, thoughts]);
  const stepCount = useMemo(() => all.filter((line) => line.kind === "step").length, [all]);
  const view = useMemo(() => {
    if (!steps) return null;
    const lines: (IslandLine | WaitLine)[] = thinking ? all : all.filter((line) => line.kind === "step");
    return islandWindow(waiting ? [...lines, { kind: "wait", key: "wait", text: "Waiting for you" + (waitingFor ? ": " + waitingFor : "") } as WaitLine] : lines);
  }, [all, steps, thinking, waiting, waitingFor]);
  const tail = useMemo(() => (steps || !thinking ? null : reasoningTail(run.reasoning)), [steps, thinking, run.reasoning]);
  const label = islandLabel({ who, waiting, lines: all });
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!onVisibility) return;
    const el = card.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      onVisibility(true);
      return () => onVisibility(false);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        onVisibility(entries.some((entry) => entry.isIntersecting));
      },
      { root: el.closest(".messages"), threshold: 0.1 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      onVisibility(false);
    };
  }, [onVisibility]);
  const toggle = () => {
    onToggle?.();
    if (!open) reveal(card.current);
    setOpen(!open);
  };
  return (
    <section ref={card} className={"island" + (waiting ? " waiting" : "") + (open ? " expanded" : "")} aria-label="Turn status">
      <button className="island-head" aria-expanded={open} onClick={toggle}>
        {waiting ? (
          <span className="island-wait-glyph" aria-hidden="true"><Hand size={12} /></span>
        ) : (
          <span className="island-face" aria-hidden="true">{avatar}</span>
        )}
        <Shimmer on={!waiting} className="island-label"><span role="status">{label}</span></Shimmer>
        <span className="island-meta"><Clock since={run.time} waiting={waiting} steps={stepCount} /></span>
        <ChevronRight size={14} className="island-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <FullList lines={all} chatId={run.chatId} runId={run.id} close={toggle} onToggle={onToggle} onOpen={onOpen} />
      ) : view ? (
        !!view.shown.length && (
          <div className={"island-window" + (view.clipped ? " clipped" : "")} aria-hidden="true">
            {view.shown.map((line) => <Line key={line.key} line={line} />)}
          </div>
        )
      ) : (
        !!tail?.text && (
          <div className={"island-think" + (tail.clipped ? " clipped" : "")} aria-hidden="true">
            <p><span>{tail.text}<i className="island-caret" /></span></p>
          </div>
        )
      )}
    </section>
  );
});

/** A finished turn's island, folded into a receipt under the answer: "Worked 42s · 9 steps".
 * Clicking it opens the side pane's Activity on the turn (`onOpen`), or else the same full list in place. */
export const IslandReceipt = memo(function IslandReceipt({ run, thoughts, updates, extra, onToggle, onOpen }: { run: Run; thoughts: boolean; /** What the bot wrote before it moved on: it folds in here with the thinking. */ updates?: IslandUpdate[]; /** Optional finished helper/command summary appended to the receipt line. */ extra?: string; onToggle?: () => void; onOpen?: (key?: string) => void }) {
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  const all = useMemo(() => islandLines(run, { thoughts, keep: shownFor(run), updates }), [run.steps, run.reasoning, run.teamwork, run.taskHandoffs, thoughts, updates]);
  useLayoutEffect(() => {
    if (open) reveal(card.current);
  }, [open]);
  if (!all.length && !extra) return null;
  const elapsed = run.finished === undefined ? run.usage?.durationMs : run.finished - run.time;
  const baseLabel = all.length ? receiptLabel(elapsed, all.filter((line) => line.kind === "step").length) : "";
  const label = [baseLabel, extra].filter(Boolean).join(" · ");
  const toggle = () => {
    if (onOpen) return onOpen();
    onToggle?.();
    setOpen((value) => !value);
  };
  if (!open) {
    return (
      <div className="island-receipt">
        <button className="island-rc" aria-expanded={false} onClick={toggle}>
          <Check size={13} className="island-check" aria-hidden="true" />
          <span>{label}</span>
          <ChevronRight size={12} className="island-chevron" aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <section ref={card} className="island expanded done" aria-label="Turn activity">
      <button className="island-head" aria-expanded onClick={toggle}>
        <span className="island-done-glyph" aria-hidden="true"><Check size={13} /></span>
        <span className="island-label">{label}</span>
        <ChevronRight size={14} className="island-chevron" aria-hidden="true" />
      </button>
      <FullList lines={all} chatId={run.chatId} runId={run.id} close={toggle} onToggle={onToggle} onOpen={onOpen} />
    </section>
  );
}, (a, b) => a.run === b.run && a.thoughts === b.thoughts && a.extra === b.extra && a.onToggle === b.onToggle && a.onOpen === b.onOpen && sameUpdates(a.updates, b.updates));
