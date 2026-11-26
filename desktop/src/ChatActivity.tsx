import { useEffect, useState, type ReactNode } from "react";
import {
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
  FilePenLine,
  FilePlus2,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  Search,
  Sparkles,
  SquarePen,
  Terminal,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { todoLabel } from "../desktop/link/session-todos";
import { toolKind } from "../desktop/tool-kind.mjs";
import "./apps.css";
import { ConnectCard } from "./ConnectCard";
import { McpAppCard } from "./McpAppCard";
import { RichText } from "./RichText";
import { Shimmer } from "./Shimmer";
import {
  type FoldBlock,
  type OpenWorkGroup,
  type ParsedStepInput,
  type StepKind,
  clipLines,
  formatWorkingDuration,
  groupForOpenMode,
  isCodingKind,
  parseStepInput,
  partitionForFoldMode,
  stepHeadline,
  summarizeSteps,
  summarizeToolNames,
  uniqueKinds,
  visibleSteps,
} from "./activityModel";
import { Block } from "./Today";
import type { Run, Step, Subagent, Todo } from "./types";

import { duration } from "./island";

/** "12s", "1m 51s" or "1h 4m" (island.ts, where the island's own tests can reach it). */
export { duration };

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

/** Category icon for a classified tool kind. */
export function KindIcon({ kind, size = 14 }: { kind: StepKind; size?: number }) {
  switch (kind) {
    case "command":
      return <Terminal size={size} />;
    case "read":
      return <Eye size={size} />;
    case "write":
      return <FilePlus2 size={size} />;
    case "edit":
      return <FilePenLine size={size} />;
    case "search-files":
      return <Search size={size} />;
    case "web":
    case "web-page":
      return <Globe size={size} />;
    case "ask":
      return <MessageCircleQuestion size={size} />;
    case "helper":
      return <Users size={size} />;
    case "plan":
      return <ListChecks size={size} />;
    case "skill":
      return <Sparkles size={size} />;
    case "card":
      return <LayoutGrid size={size} />;
    case "panel":
      return <LayoutDashboard size={size} />;
    default:
      return <Wrench size={size} />;
  }
}

/** OpenBot-style overlapped circular stack of tool-kind badges. */
export function IconStack({ kinds, size = 11 }: { kinds: StepKind[]; size?: number }) {
  if (!kinds.length) return null;
  return (
    <span className="icon-stack" aria-hidden="true">
      {kinds.slice(0, 4).map((kind) => (
        <span className="icon-stack-badge" key={kind}>
          <KindIcon kind={kind} size={size} />
        </span>
      ))}
    </span>
  );
}

/** Centered rounded "Working Xm Ys" status pill shown while a turn is active in Open mode. */
export function WorkingPill({ startedAt, title }: { startedAt: number; title?: string }) {
  const now = useNow(true);
  const elapsed = formatWorkingDuration(Math.max(0, now - startedAt));
  return (
    <div className="working-pill-wrap" role="status" title={title}>
      <span className="working-pill">
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
        <span className="working-pill-label">Working</span>
        <span className="working-pill-time">{elapsed}</span>
      </span>
    </div>
  );
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

/**
 * A turn's reasoning, above its tool work.
 * Open mode (`fold={false}`): T3 Code frameless inline brain + non-italic prose, expanded by default.
 * Fold mode (`fold={true}`): OpenBot quiet single-line disclosure (with live shimmer), collapsed by default.
 */
export function Reasoning({
  run,
  live,
  fold = true,
  onToggle,
}: {
  run: Run;
  live?: string;
  fold?: boolean;
  onToggle?: () => void;
}) {
  const running = run.status === "Working";
  const [open, setOpen] = useState(!fold);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setOpen(!fold);
  }, [fold]);
  const entries = run.reasoning ?? [];
  const text = running
    ? plain(live || entries.map((r) => r.text).join("\n\n"))
    : entries
        .map((r) => plain(r.text).trim())
        .filter(Boolean)
        .join("\n\n");
  if (!text.trim()) return null;
  const started = run.time;
  const ended = Math.max(...entries.map((r) => r.finished ?? r.started), started);
  const title = running ? "Thinking…" : "Thought for " + duration(ended - started);
  const long = text.length > (fold ? 520 : 900) || text.split("\n").length > (fold ? 6 : 12);

  if (!fold) {
    return (
      <section className={"reasoning reasoning-open" + (running ? " live" : "")} aria-label="Thought process">
        <button
          className="reasoning-head"
          aria-expanded={open}
          onClick={() => {
            onToggle?.();
            setOpen(!open);
          }}
        >
          <Brain size={14} className="reasoning-brain" />
          <span className={running ? "shimmer-text" : undefined}>{title}</span>
          <ChevronDown size={13} className="reasoning-chevron" />
        </button>
        {open && (
          <div className="reasoning-open-body">
            <p className={"reasoning-text open-prose" + (all || running ? "" : " folded")}>
              {running && !all ? newestWords(text, 700) : text}
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
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={"reasoning reasoning-fold" + (running ? " live" : "")} aria-label="Thought process">
      <button
        className="reasoning-head"
        aria-expanded={open}
        onClick={() => {
          onToggle?.();
          setOpen(!open);
        }}
      >
        <Brain size={14} className="reasoning-brain" />
        <span className={running ? "shimmer-text" : undefined}>{title}</span>
        <ChevronRight size={13} className="reasoning-chevron" />
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
    <Check size={14} className="step-ok" />
  ) : (
    <CircleAlert size={14} className="step-fail" />
  );
}

function stepSeconds(step: Step): string {
  if (!step.finished) return "";
  return Math.max(0.1, (step.finished - step.started) / 1000).toFixed(1) + "s";
}

function DiffLinesView({ lines, truncated }: { lines: NonNullable<ParsedStepInput["diff"]>["lines"]; truncated?: boolean }) {
  return (
    <div className="diff-body" role="region" aria-label="Diff">
      {lines.map((line, i) => (
        <div key={i} className={"diff-line " + line.kind}>
          <span className="diff-gutter" aria-hidden="true">
            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "hunk" ? "@" : " "}
          </span>
          <code>{line.text || " "}</code>
        </div>
      ))}
      {truncated && <div className="diff-truncated">…more lines omitted</div>}
    </div>
  );
}

export function StepDetailBody({ step, parsed = parseStepInput(step) }: { step: Step; parsed?: ParsedStepInput }) {
  const output = (step.output || "").trim();
  const progress = (step.progress || "").trim();
  if (parsed.command) {
    return (
      <div className="step-detail structured">
        <div className="step-cmd-line">
          <span className="cmd-prompt">$</span>
          <code>{parsed.command}</code>
        </div>
        {progress && step.status === "Running" && <pre className="step-out">{progress}</pre>}
        {output && <pre className="step-out">{output}</pre>}
        {!output && !progress && step.status !== "Running" && <p className="muted step-empty">No output</p>}
      </div>
    );
  }
  if (parsed.diff) {
    return (
      <div className="step-detail structured">
        {parsed.filePath && <div className="step-filepath">{parsed.filePath}</div>}
        <DiffLinesView lines={parsed.diff.lines} truncated={parsed.diff.truncated} />
        {output && step.status === "Failed" && <pre className="step-out">{output}</pre>}
      </div>
    );
  }
  return (
    <div className="step-detail">
      {step.input && (
        <>
          <b>Input</b>
          <pre>{step.input}</pre>
        </>
      )}
      {step.progress && <p>{step.progress}</p>}
      {step.output && (
        <>
          <b>Output</b>
          <pre>{step.output}</pre>
        </>
      )}
      {!step.input && !step.progress && !step.output && <p className="muted step-empty">No details</p>}
    </div>
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
                <strong>{stepHeadline(s)}</strong>
                {s.source && <small>{s.source}</small>}
              </span>
              <em>
                {s.status}
                {s.finished ? " · " + stepSeconds(s) : ""}
              </em>
            </summary>
            <StepDetailBody step={s} />
          </details>
          {s.status === "Running" && (s.progress || s.output) && (
            <div className="live-output">
              <Terminal size={13} />
              <code>{(s.progress || s.output || "").trim().split("\n").at(-1)?.slice(-220)}</code>
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
export function InterimUpdate({ text, onToggle }: { text: string; onToggle?: () => void }) {
  const value = text.trim();
  if (!value) return null;
  return (
    <article className="assistant interim-update" onClick={onToggle}>
      <RichText text={value} />
    </article>
  );
}

/** One timestamped thought in the canvas or the expanded activity list. */
export function ReasoningUpdate({ text }: { text: string }) {
  // A summary's heading and paragraphs read as lines, without blank lines between them.
  const value = plain(text).trim().replace(/\n\s*\n/g, "\n");
  if (!value) return null;
  return (
    <p className="work-thought" aria-label="Thinking">
      {value}
    </p>
  );
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
export function stepIcon(step: Step) {
  if (step.source) return Wrench;
  return KIND_ICONS[toolKind(step.name) ?? ""] ?? Wrench;
}

/** A turn's steps as bare rows: an icon for the kind, the label on one line. A running step is
 * muted with a band of ink sweeping across it (`Shimmer`, T3 Code's live row) while the bot is on
 * it (`live`; off while it waits for the person), a failed one has a faded danger icon and a small
 * X. A row opens to its input and output. */
export function WorkSteps({ steps, live = false, follow = false, onOpen }: { steps: Step[]; live?: boolean; follow?: boolean; /** A row opens the side pane's Activity on its step instead of opening in place. */ onOpen?: (step: Step) => void }) {
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
            {onOpen ? (
              <button type="button" className="work-step-open" title={s.name + " · " + s.status} onClick={() => onOpen(s)}>
                <Shimmer on={running && live} className="work-step-main">
                  <span className="work-step-icon" aria-hidden="true"><Icon size={16} /></span>
                  <span className="work-step-label">{label}</span>
                </Shimmer>
                {failed && <X size={12} className="work-step-failed" aria-label="Failed" />}
              </button>
            ) : (
            <details>
              <summary title={s.name + " · " + s.status}>
                <Shimmer on={running && live} className="work-step-main">
                  <span className="work-step-icon" aria-hidden="true"><Icon size={16} /></span>
                  <span className="work-step-label">{label}</span>
                </Shimmer>
                {failed && <X size={12} className="work-step-failed" aria-label="Failed" />}
              </summary>
              {(detail || follow) && (
                <div className="step-detail">
                  {!detail && <p>{running ? "Waiting for progress…" : "No additional details."}</p>}
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
            )}
            {running && (s.progress || s.output) && (
              <code className="work-step-output">{(s.progress || s.output || "").trim().split("\n").at(-1)?.slice(-220)}</code>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The top of a live turn: the bot's still face, what it is doing in ink, and its current intent.
 * `shimmer`: the bot is thinking with no step running, so this is the live line (T3 Code's
 * "Thinking" row) and the band sweeps across what it is doing. */
export function LiveLead({ avatar, label, thought, shimmer = false }: { avatar: ReactNode; label: string; thought?: string; shimmer?: boolean }) {
  return (
    <div className="work-lead" role="status">
      {avatar}
      <p>
        <Shimmer on={shimmer}><b>{label}</b></Shimmer>
        {thought && <> · {thought}</>}
      </p>
    </div>
  );
}

/** OpenBot elevated compact card for a shell/command step. */
function CommandCard({
  step,
  parsed,
  live,
  onToggle,
}: {
  step: Step;
  parsed: ParsedStepInput;
  live?: boolean;
  onToggle?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = step.status === "Running";
  const failed = step.status === "Failed";
  const cmd = parsed.command || stepHeadline(step, parsed);
  const rawOut = (step.output || step.progress || "").trim();
  const clipped = clipLines(rawOut, 4, true);
  const took = stepSeconds(step);
  const toggle = () => {
    onToggle?.();
    setExpanded(!expanded);
  };
  return (
    <div className={"coding-card command-card" + (running ? " running" : "") + (failed ? " failed" : "")}>
      <button className="coding-card-head" aria-expanded={expanded} onClick={toggle}>
        <StepGlyph step={step} />
        <span className="cmd-prompt" aria-hidden="true">$</span>
        <code className="coding-cmd" title={cmd}>
          {cmd}
        </code>
        {took && <span className="coding-meta">{took}</span>}
        {failed && !took && <span className="coding-meta danger">Failed</span>}
        <ChevronRight size={14} className="coding-chevron" />
      </button>
      {(rawOut || expanded) && (
        <div className="coding-card-body">
          {rawOut ? (
            <>
              <pre className={"coding-output" + (expanded ? " full" : "")}>
                {expanded ? rawOut : clipped.text}
              </pre>
              {clipped.clipped && (
                <button className="coding-more" onClick={toggle}>
                  {expanded ? "Show less" : `Show all ${clipped.totalLines} lines`}
                </button>
              )}
            </>
          ) : (
            !live && <div className="coding-empty">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

/** OpenBot elevated compact card for a file edit or file creation step. */
function DiffCard({
  step,
  parsed,
  onToggle,
}: {
  step: Step;
  parsed: ParsedStepInput;
  live?: boolean;
  onToggle?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = step.status === "Running";
  const failed = step.status === "Failed";
  const diff = parsed.diff;
  const previewLimit = 8;
  const previewClipped = !!diff && diff.lines.length > previewLimit;
  const shownLines = diff ? (expanded ? diff.lines : diff.lines.slice(0, previewLimit)) : [];
  const label = parsed.fileName || stepHeadline(step, parsed);
  const toggle = () => {
    onToggle?.();
    setExpanded(!expanded);
  };
  return (
    <div className={"coding-card diff-card" + (running ? " running" : "") + (failed ? " failed" : "")}>
      <button className="coding-card-head" aria-expanded={expanded} onClick={toggle}>
        {running ? <span className="activity-pulse" /> : <KindIcon kind={parsed.kind} size={13} />}
        <span className="coding-file" title={parsed.filePath || label}>
          {label}
        </span>
        {diff && (
          <span className="diff-stats" aria-label={`${diff.added} additions, ${diff.removed} deletions`}>
            {diff.added > 0 && <span className="diff-add">+{diff.added}</span>}
            {diff.removed > 0 && <span className="diff-del">-{diff.removed}</span>}
          </span>
        )}
        {failed && <span className="coding-meta danger">Failed</span>}
        <ChevronRight size={14} className="coding-chevron" />
      </button>
      {diff && shownLines.length > 0 && (
        <div className="coding-card-body">
          <DiffLinesView lines={shownLines} truncated={expanded && diff.truncated} />
          {previewClipped && (
            <button className="coding-more" onClick={toggle}>
              {expanded ? "Show fewer lines" : `Show all ${diff.lines.length} lines`}
            </button>
          )}
        </div>
      )}
      {!diff && expanded && (
        <div className="coding-card-body">
          <StepDetailBody step={step} parsed={parsed} />
        </div>
      )}
    </div>
  );
}

/** T3 Code Open-mode single expandable step inside a multi-step work group. */
function OpenStepRow({ step, onToggle }: { step: Step; onToggle?: () => void }) {
  const [open, setOpen] = useState(false);
  const parsed = parseStepInput(step);
  const took = stepSeconds(step);
  return (
    <li className={"open-step-item" + (step.status === "Failed" ? " failed" : "")}>
      <button
        className="open-step-head"
        aria-expanded={open}
        onClick={() => {
          onToggle?.();
          setOpen(!open);
        }}
      >
        <StepGlyph step={step} />
        <span className="open-step-title">{stepHeadline(step, parsed)}</span>
        {parsed.diff && (
          <span className="diff-stats">
            {parsed.diff.added > 0 && <span className="diff-add">+{parsed.diff.added}</span>}
            {parsed.diff.removed > 0 && <span className="diff-del">-{parsed.diff.removed}</span>}
          </span>
        )}
        {took && <span className="open-step-meta">{took}</span>}
        <ChevronRight size={13} className="open-work-chevron" />
      </button>
      {open && (
        <div className="open-step-detail">
          <StepDetailBody step={step} parsed={parsed} />
        </div>
      )}
    </li>
  );
}

/** T3 Code Open-mode frameless inline work-group row: [icon] [summary] [chevron]. */
function OpenWorkGroupRow({ group, onToggle }: { group: OpenWorkGroup; onToggle?: () => void }) {
  const [open, setOpen] = useState(false);
  const single = group.steps.length === 1 ? group.steps[0] : undefined;
  const singleParsed = single ? parseStepInput(single) : undefined;
  const liveCommandStep = group.running
    ? [...group.steps].reverse().find((s) => s.status === "Running" && (s.progress || s.output))
    : undefined;
  const livePreviewLine = liveCommandStep
    ? (liveCommandStep.progress || liveCommandStep.output || "").trim().split("\n").at(-1)?.slice(-160)
    : undefined;

  return (
    <div className={"open-work-group" + (group.running ? " running" : "") + (group.failedCount > 0 ? " failed" : "")}>
      <button
        className="open-work-head"
        aria-expanded={open}
        onClick={() => {
          onToggle?.();
          setOpen(!open);
        }}
      >
        <span className="open-work-icon" aria-hidden="true">
          {group.running ? <LoaderCircle size={14} className="spin" /> : <KindIcon kind={group.primaryKind} size={14} />}
        </span>
        <span className={"open-work-label" + (group.running ? " shimmer-text" : "")}>{group.label}</span>
        {singleParsed?.diff && (
          <span className="diff-stats">
            {singleParsed.diff.added > 0 && <span className="diff-add">+{singleParsed.diff.added}</span>}
            {singleParsed.diff.removed > 0 && <span className="diff-del">-{singleParsed.diff.removed}</span>}
          </span>
        )}
        {group.failedCount > 0 && <span className="open-work-failed">· {group.failedCount} failed</span>}
        <ChevronRight size={14} className="open-work-chevron" />
      </button>
      {!open && livePreviewLine && (
        <div className="open-work-live-tail">
          <code>{livePreviewLine}</code>
        </div>
      )}
      {open && (
        <div className="open-work-body">
          {single ? (
            <StepDetailBody step={single} parsed={singleParsed} />
          ) : (
            <ul className="open-work-steps">
              {group.steps.map((s) => (
                <OpenStepRow key={s.id} step={s} onToggle={onToggle} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact non-coding group inside an expanded OpenBot Fold view. */
function FoldGroupRow({
  block,
  onToggle,
}: {
  block: Extract<FoldBlock, { kind: "group" }>;
  onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const single = block.steps.length === 1 ? block.steps[0] : undefined;
  return (
    <div className={"fold-group" + (block.failedCount > 0 ? " failed" : "")}>
      <button
        className="fold-group-head"
        aria-expanded={open}
        onClick={() => {
          onToggle?.();
          setOpen(!open);
        }}
      >
        <IconStack kinds={block.kinds} size={11} />
        <span className={"fold-group-label" + (block.running ? " shimmer-text" : "")}>{block.label}</span>
        {block.failedCount > 0 && <span className="fold-line-failed">{block.failedCount} failed</span>}
        <ChevronRight size={13} className="fold-chevron" />
      </button>
      {open && (
        <div className="fold-group-body">
          {single ? (
            <StepDetailBody step={single} />
          ) : (
            <ul className="open-work-steps">
              {block.steps.map((s) => (
                <OpenStepRow key={s.id} step={s} onToggle={onToggle} />
              ))}
            </ul>
          )}
        </div>
      )}
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
 * The row under a turn. Live, it is the status line: "Crumb is coding · 0:42 · 3 steps", and a
 * click opens the side pane's Activity on the turn. Finished, it is the fold: the bot's still face,
 * "Worked for 41s · 5 steps" and a chevron, opening to the turn's chapters, with Details for the
 * whole story in the side pane.
 */
export function TimelineFold({
  line,
  live = false,
  since,
  body,
  avatar,
  count,
  onDetails,
  onToggle,
  todoRail,
}: {
  line: string;
  live?: boolean;
  /** When the live turn started, for its clock. */
  since?: number;
  body?: ReactNode;
  /** The bot's still face, at the start of the finished row. */
  avatar?: ReactNode;
  count?: string;
  /** Opens the side pane's Activity tab on this turn. */
  onDetails?: () => void;
  /** The fold opened or closed in place. */
  onToggle?: () => void;
  todoRail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (live) {
      onDetails?.();
      return;
    }
    onToggle?.();
    setOpen((value) => !value);
  };
  return (
    <section className={"timeline-fold" + (live ? " live" : "")} aria-label={live ? "Turn status" : "Turn activity"}>
      <div className="turn-rails">
        <button className="timeline-fold-line" aria-expanded={live ? undefined : open} onClick={toggle}>
          {!live && avatar}
          <span>
            {line}
            {live && since !== undefined && <> · <Elapsed since={since} /></>}
            {count && " · " + count}
          </span>
          {!live && <ChevronRight size={14} className="fold-chevron" aria-hidden="true" />}
        </button>
        {todoRail}
      </div>
      {open && !live && (
        <div className="timeline-fold-body">
          {body}
          {onDetails && <button className="timeline-details" onClick={() => onDetails()}>Details</button>}
        </div>
      )}
    </section>
  );
}

function FoldBlockList({ blocks, onToggle }: { blocks: FoldBlock[]; onToggle?: () => void }) {
  return (
    <div className="fold-blocks">
      {blocks.map((b) => {
        if (b.kind === "command") {
          return <CommandCard key={b.id} step={b.step} parsed={b.parsed} onToggle={onToggle} />;
        }
        if (b.kind === "diff") {
          return <DiffCard key={b.id} step={b.step} parsed={b.parsed} onToggle={onToggle} />;
        }
        return <FoldGroupRow key={b.id} block={b} onToggle={onToggle} />;
      })}
    </div>
  );
}

/**
 * A turn's tool work.
 * Open mode (`fold={false}`): T3 Code frameless inline work-group rows.
 * Fold mode (`fold={true}`): OpenBot icon-stack folded disclosure lines + compact elevated coding/diff frames.
 */
export function ToolTrail({
  run,
  fold,
  onToggle,
}: {
  run: Run;
  fold: boolean;
  bot?: string;
  /** The working bot's small avatar, acting out its state; kept in prop signature for compatibility. */
  avatar?: ReactNode;
  onToggle?: () => void;
}) {
  const live = run.status === "Working";
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [live, fold]);
  const now = useNow(live && fold);

  const rawSteps = run.steps ?? [];
  const shownSteps = visibleSteps(rawSteps);
  const count = shownSteps.length || run.usedTools?.length || 0;
  if (!count) return null;

  if (!fold) {
    const groups = groupForOpenMode(rawSteps);
    if (!groups.length && run.usedTools?.length) {
      const primary = uniqueKinds(undefined, run.usedTools, 1)[0] ?? "tool";
      const summary = run.summary || summarizeToolNames(run.usedTools) || (count === 1 ? "Used a tool" : `Used ${count} tools`);
      return (
        <section className="tool-trail tool-trail-open" aria-label="Tool activity">
          <div className="open-work-group">
            <button
              className="open-work-head"
              aria-expanded={expanded}
              onClick={() => {
                onToggle?.();
                setExpanded(!expanded);
              }}
            >
              <span className="open-work-icon" aria-hidden="true">
                <KindIcon kind={primary} size={14} />
              </span>
              <span className="open-work-label">{summary}</span>
              <ChevronRight size={14} className="open-work-chevron" />
            </button>
            {expanded && (
              <div className="open-work-body">
                <ul className="open-work-steps">
                  {run.usedTools.map((name) => (
                    <li className="open-step-item" key={name}>
                      <div className="open-step-static">
                        <Check size={13} className="step-ok" />
                        <span>{name}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      );
    }
    return (
      <section className="tool-trail tool-trail-open" aria-label="Tool activity">
        {groups.map((g) => (
          <OpenWorkGroupRow key={g.id} group={g} onToggle={onToggle} />
        ))}
      </section>
    );
  }

  // Fold mode (OpenBot style)
  const toggle = () => {
    onToggle?.();
    setExpanded(!expanded);
  };
  const failedCount = shownSteps.filter((s) => s.status === "Failed").length;

  if (live) {
    // Surface currently running coding steps (or the most recent step if it is a coding step) as elevated CodingFrames.
    const runningCoding = shownSteps.filter((s) => s.status === "Running" && isCodingKind(parseStepInput(s).kind));
    const latestStep = shownSteps.at(-1);
    const liveCodingSteps =
      runningCoding.length > 0
        ? runningCoding
        : latestStep && isCodingKind(parseStepInput(latestStep).kind)
          ? [latestStep]
          : [];
    const liveCodingIds = new Set(liveCodingSteps.map((s) => s.id));
    const foldedSteps = liveCodingIds.size > 0 ? shownSteps.filter((s) => !liveCodingIds.has(s.id)) : shownSteps;
    const foldedKinds = uniqueKinds(foldedSteps, run.usedTools, 4);
    const foldedLabel =
      liveCodingIds.size > 0
        ? foldedSteps.length === 1
          ? stepHeadline(foldedSteps[0])
          : summarizeSteps(foldedSteps)
        : shownSteps.length === 1
          ? stepHeadline(shownSteps[0])
          : summarizeSteps(shownSteps, { running: true });

    return (
      <section className="tool-trail tool-trail-fold work-live" aria-label="Tool activity">
        {foldedSteps.length > 0 && (
          <>
            <button className="fold-tool-line" aria-expanded={expanded} onClick={toggle}>
              <IconStack kinds={foldedKinds} size={11} />
              <span className={"fold-line-label" + (liveCodingIds.size === 0 ? " shimmer-text" : "")}>
                {foldedLabel || (count === 1 ? "1 step" : count + " steps")}
              </span>
              {failedCount > 0 && <span className="fold-line-failed">{failedCount} failed</span>}
              <span className="fold-line-meta">{duration(now - run.time)}</span>
              <ChevronRight size={14} className="fold-chevron" />
            </button>
            {expanded && <FoldBlockList blocks={partitionForFoldMode(foldedSteps)} onToggle={onToggle} />}
          </>
        )}
        {liveCodingSteps.map((s) => {
          const parsed = parseStepInput(s);
          return parsed.kind === "command" ? (
            <CommandCard key={s.id} step={s} parsed={parsed} live onToggle={onToggle} />
          ) : (
            <DiffCard key={s.id} step={s} parsed={parsed} live onToggle={onToggle} />
          );
        })}
      </section>
    );
  }

  const kinds = uniqueKinds(rawSteps, run.usedTools, 4);
  const blocks = partitionForFoldMode(rawSteps);
  const last = Math.max(run.time, ...rawSteps.map((s) => s.finished ?? s.started));
  const elapsed = (run.finished ?? last) - run.time;
  const summary =
    run.summary ||
    summarizeSteps(shownSteps) ||
    summarizeToolNames(run.usedTools) ||
    (count === 1 ? "1 step" : count + " steps");

  return (
    <section className="tool-trail tool-trail-fold work-done" aria-label="Tool activity">
      <button className="fold-tool-line" aria-expanded={expanded} onClick={toggle}>
        {kinds.length > 0 && <IconStack kinds={kinds} size={11} />}
        <span className="fold-line-label">{summary}</span>
        {failedCount > 0 && <span className="fold-line-failed">{failedCount} failed</span>}
        <span className="fold-line-meta">{duration(elapsed)}</span>
        <ChevronRight size={14} className="fold-chevron" />
      </button>
      {expanded &&
        (blocks.length > 0 ? (
          <FoldBlockList blocks={blocks} onToggle={onToggle} />
        ) : (
          <div className="fold-blocks">
            <ul className="open-work-steps">
              {run.usedTools?.map((name) => (
                <li className="open-step-item" key={name}>
                  <div className="open-step-static">
                    <Check size={13} className="step-ok" />
                    <span>{name}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

function TodoGlyph({ status }: { status: Todo["status"] }) {
  if (status === "done") return <Check size={14} aria-label="Done" />;
  if (status === "in_progress") return <LoaderCircle size={14} className="spin" aria-label="In progress" />;
  if (status === "failed") return <CircleAlert size={14} aria-label="Failed" />;
  if (status === "blocked" || status === "cancelled")
    return <Ban size={14} aria-label={status === "blocked" ? "Blocked" : "Cancelled"} />;
  return <Circle size={14} aria-label="Pending" />;
}

/** The session’s tracked todos, including the closed count. */
export function TaskChip({
  todos,
  open,
  toggle,
}: {
  todos: Todo[];
  open: boolean;
  toggle: () => void;
}) {
  const active = todos.some((t) => t.status === "in_progress");
  return (
    <button className="canvas-chip" aria-expanded={open} aria-controls="task-drawer" onClick={toggle}>
      {active ? <LoaderCircle size={14} className="spin" /> : <ListChecks size={14} />}
      {todoLabel(todos)}
    </button>
  );
}

export function TodoItems({ todos }: { todos: Todo[] }) {
  return (
    <ol>
      {todos.map((t) => (
        <li key={t.id} className={"todo " + t.status}>
          <TodoGlyph status={t.status} />
          <span>{t.title}</span>
          {t.status === "blocked" && <em>Blocked</em>}
          {t.status === "failed" && <em>Failed</em>}
        </li>
      ))}
    </ol>
  );
}

export function TaskDrawer({ todos, transfer }: { todos: Todo[]; transfer?: () => void }) {
  return (
    <section className="canvas-drawer" id="task-drawer" aria-label="Tasks">
      <TodoItems todos={todos} />
      {transfer && <button className="secondary" onClick={transfer}>Transfer and continue todos</button>}
    </section>
  );
}

/** "In the background · 2 running" for the latest turn's helpers and background commands. It opens the side pane's Crew tab. */
export function HelperChip({ running, total, onOpen }: { running: number; total: number; onOpen: () => void }) {
  return (
    <button className="canvas-chip" onClick={onOpen}>
      {running ? <LoaderCircle size={14} className="spin" /> : <Users size={14} />}
      In the background · {running ? running + " running" : total + " finished"}
    </button>
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
