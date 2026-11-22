import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  AppWindow,
  Ban,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Eye,
  Globe,
  ListChecks,
  LoaderCircle,
  Search,
  SquarePen,
  Terminal,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { toolKind } from "../desktop/tool-kind.mjs";
import "./apps.css";
import { ConnectCard } from "./ConnectCard";
import { McpAppCard } from "./McpAppCard";
import { RichText } from "./RichText";
import { Block } from "./Today";
import type { Run, Step, Subagent, Todo } from "./types";

/** "12s", "1m 51s" or "1h 4m". */
export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

/** The current time, ticking once a second only while `active`. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The end of a long thought: from a line or word start, so it never opens mid-word. */
function newestWords(text: string, length = 320) {
  if (text.length <= length) return text;
  const tail = text.slice(-length);
  const half = tail.slice(0, length / 2);
  const cut = half.indexOf("\n") >= 0 ? half.indexOf("\n") : tail.search(/\s/);
  return "…" + tail.slice(Math.max(0, cut)).trim();
}

/** Reasoning summaries use Markdown bold for headings; show them as plain lines. */
function plain(text: string) {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

/** A turn's reasoning, above its tool work: "Thinking…" live, then "Thought for 12s". */
export function Reasoning({
  run,
  live,
  onToggle,
  display = "open",
}: {
  run: Run;
  live?: string;
  onToggle?: () => void;
  /** Thinking and updates setting. `hide` leaves the work available in the activity view. */
  display?: "open" | "folded" | "hidden";
}) {
  const running = run.status === "Working";
  const [open, setOpen] = useState(display !== "hidden");
  const [all, setAll] = useState(false);
  const entries = run.reasoning ?? [];
  const text = running
    ? plain(live || entries.map((r) => r.text).join("\n\n"))
    : entries
        .map((r) => plain(r.text).trim())
        .filter(Boolean)
        .join("\n\n");
  if (!text.trim() || display === "hidden") return null;
  // Thinking starts with the turn, before the first summary word arrives.
  const started = run.time;
  const ended = Math.max(...entries.map((r) => r.finished ?? r.started), started);
  const title = running ? "Thinking…" : "Thought for " + duration(ended - started);
  const long = text.length > 520 || text.split("\n").length > 6;
  return (
    <section className={"reasoning" + (running ? " live" : "")} aria-label="Thought process">
      <button
        className="reasoning-head"
        aria-expanded={open}
        onClick={() => {
          onToggle?.();
          setOpen(!open);
        }}
      >
        {running ? <span className="activity-pulse" /> : <Brain size={14} />}
        <span>{title}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
            <p className={"reasoning-text" + (all || (running && display === "open") ? "" : " folded")}>
            {running && !all ? newestWords(text) : text}
          </p>
          {long && (!running || display === "folded") && (
            <button
              className="show-more"
              onClick={() => {
                onToggle?.();
                setAll(!all);
              }}
            >
              {all ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function StepGlyph({ step }: { step: Step }) {
  return step.status === "Running" ? (
    <span className="activity-pulse" />
  ) : step.status === "Done" ? (
    <Check size={14} />
  ) : (
    <CircleAlert size={14} />
  );
}

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol>
      {steps.map((s) => (
        <li key={s.id}>
          <details>
            <summary>
              <StepGlyph step={s} />
              <span>
                <strong>
                  {s.source ? s.source + " / " : ""}
                  {s.name}
                </strong>
                {s.label !== s.name && <small>{s.label}</small>}
              </span>
              <em>
                {s.status}
                {s.finished
                  ? " · " + Math.max(0.1, (s.finished - s.started) / 1000).toFixed(1) + "s"
                  : ""}
              </em>
            </summary>
            <div className="step-detail">
              {s.input && (
                <>
                  <b>Input</b>
                  <pre>{s.input}</pre>
                </>
              )}
              {s.progress && <p>{s.progress}</p>}
              {s.output && (
                <>
                  <b>Output</b>
                  <pre>{s.output}</pre>
                </>
              )}
            </div>
          </details>
          {s.status === "Running" && (s.progress || s.output) && (
            <div className="live-output">
              <Terminal size={13} />
              <code>
                {(s.progress || s.output || "").trim().split("\n").at(-1)?.slice(-220)}
              </code>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Text the bot wrote while a turn was moving between tools. It reads like a reply (the same
 * Markdown at the same size) in the second ink, with no box, label or mark, and keeps its place
 * in the turn, apart from the bot's thinking. */
export function InterimUpdate({ text, onToggle, display = "open" }: { text: string; onToggle?: () => void; display?: "open" | "folded" | "hidden" }) {
  const value = text.trim();
  if (!value || display === "hidden") return null;
  return (
    <article className="assistant interim-update" onClick={onToggle}>
      <RichText text={display === "folded" ? newestWords(value, 320) : value} />
    </article>
  );
}

/** One thought in a turn's work: quiet muted text, no box. The live turn shows only its newest
 * thought, in the lead row (`latestThought`); an opened fold or every-step mode shows each one. */
export function ReasoningUpdate({ text, title = "Thinking", display = "open" }: { text: string; title?: string; display?: "open" | "folded" | "hidden" }) {
  // A summary's heading and paragraphs read as lines, without blank lines between them.
  const value = plain(text).trim().replace(/\n\s*\n/g, "\n");
  if (!value || display === "hidden") return null;
  return (
    <p className={"work-thought" + (display === "folded" ? " folded" : "")} aria-label={title}>
      {display === "folded" ? newestWords(value) : value}
    </p>
  );
}

/** The last line of the bot's thinking so far, for the live lead row. */
export function latestThought(text = "") {
  const line = plain(text).split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return newestWords(line, 280);
}

/** The icon for each kind of work (tool-kind.mjs, which the work summaries use too). */
const KIND_ICONS: Record<string, typeof Wrench> = {
  command: Terminal,
  read: Eye,
  write: SquarePen,
  edit: SquarePen,
  "search-files": Search,
  web: Globe,
  "web-page": Globe,
  helper: Bot,
};

/** The icon for what a step did: a server's tool, or a kind without its own icon, is a wrench. */
function stepIcon(step: Step) {
  if (step.source) return Wrench;
  return KIND_ICONS[toolKind(step.name) ?? ""] ?? Wrench;
}

/** A turn's steps as bare rows: an icon for the kind, the label on one line. A running step is
 * drawn in ink, a failed one with a faded danger icon and a small X. A row opens to its input
 * and output. */
export function WorkSteps({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <ol className="work-steps">
      {steps.map((s) => {
        const Icon = stepIcon(s);
        const failed = s.status === "Failed";
        const running = s.status === "Running";
        const label = (s.source ? s.source + " / " : "") + (s.label || s.name);
        const detail = s.input || s.progress || s.output;
        return (
          <li key={s.id} className={"work-step" + (running ? " running" : "") + (failed ? " failed" : "")}>
            <details>
              <summary title={s.name + " · " + s.status}>
                <span className="work-step-icon" aria-hidden="true"><Icon size={16} /></span>
                <span className="work-step-label">{label}</span>
                {failed && <X size={12} className="work-step-failed" aria-label="Failed" />}
              </summary>
              {detail && (
                <div className="step-detail">
                  {s.input && (
                    <>
                      <b>Input</b>
                      <pre>{s.input}</pre>
                    </>
                  )}
                  {s.progress && <p>{s.progress}</p>}
                  {s.output && (
                    <>
                      <b>Output</b>
                      <pre>{s.output}</pre>
                    </>
                  )}
                </div>
              )}
            </details>
            {running && (s.progress || s.output) && (
              <code className="work-step-output">{(s.progress || s.output || "").trim().split("\n").at(-1)?.slice(-220)}</code>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The top of a live turn: the bot's still face, what it is doing in ink, then its newest thought. */
export function LiveLead({ avatar, label, thought }: { avatar: ReactNode; label: string; thought?: string }) {
  return (
    <div className="work-lead" role="status">
      {avatar}
      <p>
        <b>{label}</b>
        {thought && <> · {thought}</>}
      </p>
    </div>
  );
}

/** "0:42" or "1:04:05", counting up once a second from `since`. Only this text re-renders. */
function Elapsed({ since }: { since: number }) {
  const s = Math.max(0, Math.floor((useNow(true) - since) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return <>{s >= 3600 ? Math.floor(s / 3600) + ":" + two(Math.floor(s / 60) % 60) : Math.floor(s / 60)}:{two(s % 60)}</>;
}

/**
 * The row under a turn. Live, it is the status line: "Crumb is coding · 0:42 · 3 steps".
 * Finished, it is the fold: the bot's still face, "Worked for 41s · 5 steps" and a chevron,
 * opening to the turn's work in order, with Details for everything the chat settings hide.
 */
export function TimelineFold({
  line,
  live = false,
  since,
  body,
  detailsBody,
  avatar,
  count,
  onDetails,
}: {
  line: string;
  live?: boolean;
  /** When the live turn started, for its clock. */
  since?: number;
  body?: ReactNode;
  /** The complete work timeline, including content hidden by the chat preferences. */
  detailsBody?: ReactNode;
  /** The bot's still face, at the start of the finished row. */
  avatar?: ReactNode;
  count?: string;
  onDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const toggle = () => {
    if (live) return onDetails?.();
    setOpen((value) => !value);
  };
  const showDetails = () => {
    onDetails?.();
    setDetailsOpen(true);
  };
  return (
    <section className={"timeline-fold" + (live ? " live" : "")} aria-label={live ? "Turn status" : "Turn activity"}>
      <button className="timeline-fold-line" aria-expanded={live ? undefined : open} onClick={toggle}>
        {!live && avatar}
        <span>
          {line}
          {live && since !== undefined && <> · <Elapsed since={since} /></>}
          {count && " · " + count}
        </span>
        {!live && <ChevronRight size={14} className="fold-chevron" aria-hidden="true" />}
      </button>
      {open && !live && (
        <div className="timeline-fold-body">
          {body}
          <button className="timeline-details" onClick={showDetails}>Details</button>
        </div>
      )}
      {detailsOpen && !live && (
        <div className="timeline-activity" role="dialog" aria-label="Work activity">
          <div className="timeline-activity-head">
            <strong>Work activity</strong>
            <button className="timeline-activity-close" aria-label="Close work activity" onClick={() => setDetailsOpen(false)}>Close</button>
          </div>
          <div className="timeline-activity-body">{detailsBody ?? body}</div>
        </div>
      )}
    </section>
  );
}

/**
 * A turn's tool work. Live: "<Bot> is working" with the newest steps. Done: one row,
 * "Worked for 1m 51s · 7 steps" over a plain summary, opening to every step.
 */
export function ToolTrail({
  run,
  fold,
  bot = "Bot",
  avatar,
  onToggle,
  mode,
  intent,
}: {
  run: Run;
  fold: boolean;
  bot?: string;
  /** The working bot's small still face, shown while live. */
  avatar?: ReactNode;
  onToggle?: () => void;
  /** The four Settings › Chat › Steps choices. `fold` remains for older callers. */
  mode?: "folded" | "every" | "failed" | "hidden";
  intent?: string;
}) {
  const live = run.status === "Working";
  const choice = mode ?? (fold ? "folded" : "every");
  const [expanded, setExpanded] = useState(choice === "every");
  useEffect(() => {
    setExpanded(choice === "every");
  }, [live, choice]);
  const now = useNow(live);
  const steps = run.steps ?? [];
  const visibleSteps = choice === "hidden" ? [] : choice === "failed" ? steps.filter((step) => step.status === "Failed") : steps;
  const count = visibleSteps.length || (choice === "hidden" ? 0 : run.usedTools?.length || 0);
  // Keep a stable status row even before the first tool arrives. This is the anchor that becomes
  // the finished work line when the turn ends.
  if (!live && !count && !run.summary) return null;
  const toggle = () => {
    onToggle?.();
    setExpanded(!expanded);
  };
  const plural = count === 1 ? " step" : " steps";
  if (live)
    return (
      <section className="tool-trail work-live" aria-label="Tool activity">
        <button className="trail-toggle" aria-expanded={expanded} onClick={toggle}>
          {avatar ?? <Activity size={15} />}
          <strong>{bot}</strong>
          <span className="work-intent">{intent?.trim() || "Working…"}</span>
          {count > 0 && <span className="work-count">{count + plural}</span>}
        </button>
        {expanded && <StepList steps={visibleSteps} />}
      </section>
    );
  const last = Math.max(run.time, ...steps.map((s) => s.finished ?? s.started));
  const elapsed = (run.finished ?? last) - run.time;
  return (
    <section className="tool-trail work-done" aria-label="Tool activity">
      <button className="trail-toggle" aria-expanded={expanded} onClick={toggle}>
        <Activity size={15} />
        <span className="work-title">
          <strong>Worked for {duration(elapsed)}</strong>
          {run.summary && <small>{run.summary}</small>}
        </span>
        {count > 0 && <span className="work-count">{count + plural}</span>}
      </button>
      {expanded && <RunLead agents={run.agents} todos={run.todos} />}
      {expanded &&
        (steps.length ? (
          <StepList steps={visibleSteps} />
        ) : (
          <ol>
            {run.usedTools?.map((name) => (
              <li key={name}>{name} · Done</li>
            ))}
          </ol>
        ))}
    </section>
  );
}

function TodoGlyph({ status }: { status: Todo["status"] }) {
  if (status === "done") return <Check size={14} aria-label="Done" />;
  if (status === "in_progress") return <LoaderCircle size={14} className="spin" aria-label="In progress" />;
  if (status === "blocked" || status === "cancelled")
    return <Ban size={14} aria-label={status === "blocked" ? "Blocked" : "Cancelled"} />;
  return <Circle size={14} aria-label="Pending" />;
}

/** "Tasks 3/5" above the composer, opening the chat's task list. */
export function TaskChip({
  todos,
  open,
  toggle,
}: {
  todos: Todo[];
  open: boolean;
  toggle: () => void;
}) {
  const done = todos.filter((t) => t.status === "done").length;
  const active = todos.some((t) => t.status === "in_progress");
  return (
    <button className="canvas-chip" aria-expanded={open} aria-controls="task-drawer" onClick={toggle}>
      {active ? <LoaderCircle size={14} className="spin" /> : <ListChecks size={14} />}
      Tasks {done}/{todos.length}
    </button>
  );
}

function TodoItems({ todos }: { todos: Todo[] }) {
  return (
    <ol>
      {todos.map((t) => (
        <li key={t.id} className={"todo " + t.status}>
          <TodoGlyph status={t.status} />
          <span>{t.title}</span>
          {t.status === "blocked" && <em>Blocked</em>}
        </li>
      ))}
    </ol>
  );
}

export function TaskDrawer({ todos }: { todos: Todo[] }) {
  return (
    <section className="canvas-drawer" id="task-drawer" aria-label="Tasks">
      <TodoItems todos={todos} />
    </section>
  );
}

/** "In the background · 2 running" for the latest turn's helpers. */
export function HelperChip({
  agents,
  open,
  toggle,
}: {
  agents: Subagent[];
  open: boolean;
  toggle: () => void;
}) {
  const running = agents.filter((a) => a.status === "Running").length;
  return (
    <button className="canvas-chip" aria-expanded={open} aria-controls="helper-drawer" onClick={toggle}>
      {running ? <LoaderCircle size={14} className="spin" /> : <Users size={14} />}
      In the background · {running ? running + " running" : agents.length + " finished"}
    </button>
  );
}

function HelperItems({ agents }: { agents: Subagent[] }) {
  const now = useNow(agents.some((a) => a.status === "Running"));
  return (
    <ol>
      {agents.map((a) => (
        <li key={a.id} className={"helper " + a.status.toLowerCase()}>
          {a.status === "Running" ? (
            <LoaderCircle size={14} className="spin" />
          ) : a.status === "Done" ? (
            <Check size={14} />
          ) : a.status === "Stopped" ? (
            <Ban size={14} />
          ) : (
            <CircleAlert size={14} />
          )}
          <span>
            <strong>{a.name}</strong>
            {(a.detail || a.description) && <small>{a.detail || a.description}</small>}
          </span>
          <em>
            {a.status === "Running" ? "Running" : a.status} · {duration((a.finished ?? now) - a.started)}
          </em>
        </li>
      ))}
    </ol>
  );
}

export function HelperDrawer({ agents }: { agents: Subagent[] }) {
  return (
    <section className="canvas-drawer" id="helper-drawer" aria-label="Background helpers">
      <HelperItems agents={agents} />
    </section>
  );
}

/**
 * What a turn's work list starts with: its helpers, then its to-do list, and after them the steps
 * and everything else (the owner's order, 2026-11-20; the phone's Activity sheet has the same).
 * Nothing when the turn had neither.
 */
export function RunLead({ agents, todos }: { agents?: Subagent[]; todos?: Todo[] }) {
  if (!agents?.length && !todos?.length) return null;
  return (
    <>
      {!!agents?.length && (
        <section className="run-lead" aria-label="Helpers">
          <h4>Helpers</h4>
          <HelperItems agents={agents} />
        </section>
      )}
      {!!todos?.length && (
        <section className="run-lead" aria-label="To do">
          <h4>To do</h4>
          <TodoItems todos={todos} />
        </section>
      )}
    </>
  );
}

export function RunCards({
  run,
  prefill,
  pickModel,
}: {
  run: Run;
  prefill: (s: string) => void;
  pickModel?: () => void;
}) {
  return (
    <>
      {run.apps?.map((app) => (
        <section className="chat-card app-card" key={app.id} aria-label={app.title}>
          <span className="app-card-icon" aria-hidden="true">
            <AppWindow size={20} />
          </span>
          <span className="app-card-text">
            <strong>{app.title}</strong>
            <small>{app.description}</small>
            {app.sendsAnswers && <em>Sends answers</em>}
          </span>
          <button className="secondary" onClick={() => void window.botkins.openApp(app.id)}>
            Open app
          </button>
        </section>
      ))}
      {run.connects?.map((card) => (
        <ConnectCard key={card.id} chatId={run.chatId} card={card} />
      ))}
      {run.mcpApps?.map((card) => (
        <McpAppCard key={card.id} chatId={run.chatId} card={card} />
      ))}
      {run.cards?.map((card) => (
        <section className="chat-card" key={card.id} aria-label={card.title}>
          <h3>{card.title}</h3>
          <div className="panel-blocks">
            {card.blocks.map((b, i) => (
              <Block key={b.type === "html" ? b.frame : i} block={b} title={card.title} />
            ))}
          </div>
          {!!card.replies.length && (
            <div className="actionrow">
              {card.replies.map((r, i) => (
                <button key={i} onClick={() => prefill(r)}>
                  {r}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
      {!!run.options?.length && (
        <div className="actionrow">
          {run.options.map((o) => (
            <button key={o.prompt} title={o.description} onClick={() => prefill(o.prompt + " ")}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {run.openModel && pickModel && (
        <button className="secondary" onClick={pickModel}>
          Choose chat model
        </button>
      )}
    </>
  );
}
