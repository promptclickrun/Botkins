import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  AppWindow,
  Ban,
  Brain,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  ListChecks,
  LoaderCircle,
  Terminal,
  Users,
} from "lucide-react";
import "./apps.css";
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
}: {
  run: Run;
  live?: string;
  onToggle?: () => void;
}) {
  const running = run.status === "Working";
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const entries = run.reasoning ?? [];
  const text = running
    ? plain(live || entries.map((r) => r.text).join("\n\n"))
    : entries
        .map((r) => plain(r.text).trim())
        .filter(Boolean)
        .join("\n\n");
  if (!text.trim()) return null;
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
          <p className={"reasoning-text" + (all || running ? "" : " folded")}>
            {running && !all ? newestWords(text) : text}
          </p>
          {long && !running && (
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
}: {
  run: Run;
  fold: boolean;
  bot?: string;
  /** The working bot's small avatar, acting out its state; shown in place of the spinner while live. */
  avatar?: ReactNode;
  onToggle?: () => void;
}) {
  const live = run.status === "Working";
  const [expanded, setExpanded] = useState(!fold);
  useEffect(() => {
    setExpanded(!fold);
  }, [live, fold]);
  const now = useNow(live);
  const steps = run.steps ?? [];
  const count = steps.length || run.usedTools?.length || 0;
  if (!count) return null;
  const toggle = () => {
    onToggle?.();
    setExpanded(!expanded);
  };
  const plural = count === 1 ? " step" : " steps";
  if (live)
    return (
      <section className="tool-trail work-live" aria-label="Tool activity">
        <button className="trail-toggle" aria-expanded={expanded} onClick={toggle}>
          {avatar ?? <LoaderCircle size={15} className="spin" />}
          <strong>{bot} is working</strong>
          <span>
            {duration(now - run.time)} · {count + plural}
          </span>
          <ChevronDown size={15} />
        </button>
        {expanded ? <StepList steps={steps} /> : <StepList steps={steps.slice(-3)} />}
      </section>
    );
  const last = Math.max(run.time, ...steps.map((s) => s.finished ?? s.started));
  const elapsed = (run.finished ?? last) - run.time;
  return (
    <section className="tool-trail work-done" aria-label="Tool activity">
      <button className="trail-toggle" aria-expanded={expanded} onClick={toggle}>
        <Activity size={15} />
        <span className="work-title">
          <strong>
            Worked for {duration(elapsed)} · {count + plural}
          </strong>
          {run.summary && <small>{run.summary}</small>}
        </span>
        <ChevronDown size={15} />
      </button>
      {expanded &&
        (steps.length ? (
          <StepList steps={steps} />
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

export function TaskDrawer({ todos }: { todos: Todo[] }) {
  return (
    <section className="canvas-drawer" id="task-drawer" aria-label="Tasks">
      <ol>
        {todos.map((t) => (
          <li key={t.id} className={"todo " + t.status}>
            <TodoGlyph status={t.status} />
            <span>{t.title}</span>
            {t.status === "blocked" && <em>Blocked</em>}
          </li>
        ))}
      </ol>
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

export function HelperDrawer({ agents }: { agents: Subagent[] }) {
  const now = useNow(agents.some((a) => a.status === "Running"));
  return (
    <section className="canvas-drawer" id="helper-drawer" aria-label="Background helpers">
      <ol>
        {agents.map((a) => (
          <li key={a.id} className={"helper " + a.status.toLowerCase()}>
            {a.status === "Running" ? (
              <LoaderCircle size={14} className="spin" />
            ) : a.status === "Done" ? (
              <Check size={14} />
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
    </section>
  );
}

export function RunCards({
  run,
  prefill,
  pickModel,
}: {
  run: Run;
  prefill: (s: string) => void;
  pickModel: () => void;
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
      {run.openModel && (
        <button className="secondary" onClick={pickModel}>
          Choose chat model
        </button>
      )}
    </>
  );
}
