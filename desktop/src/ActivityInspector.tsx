// The turn's work beside the chat and in it.
// - ActivityPanel: the side pane's Activity tab. The turn as a story of chapters on the left (each
//   thought opens one; activityStory.ts) and the selected step, update or chapter in full on the right.
// - CrewPanel: the side pane's Crew tab. One lane per helper and background command across the
//   turn's time, then the selected one: a helper as a small chat, a command as a live terminal.
// - CrewCard: the crew in the chat, folded to one still line until it is clicked.
// - ChapterSummary: a finished turn's fold, opened in the chat: one line per chapter.
//
// How it stays cheap: the story and the crew are worked out once per change of the turn; only an
// open crew card or a pane tab on a running turn ticks a clock, once a second.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Ban, Brain, Check, ChevronRight, Copy, ExternalLink, ListChecks, MessageSquareText, Square, Terminal, Users, X } from "lucide-react";
import { StepDetailBody, stepIcon, useNow } from "./ChatActivity";
import { RichText } from "./RichText";
import { Shimmer } from "./Shimmer";
import { classifyStep, parseStepInput, stepHeadline, summarizeSteps } from "./activityModel";
import { crewLanes, crewLine, crewOf, isLive, storyChapters, thoughtHeading, type Chapter, type ChapterItem, type Crew, type CrewMember, type StoryUpdate } from "./activityStory";
import { FILTER_NAMES, clock, crewColor, filterChips, filterOf, initial, laneTicks, linkWords, outputLinks, pickSelection, thoughtBefore, took, type Filter } from "./inspector";
import { duration } from "./island";
import { useAsk } from "./Pages";
import type { Run, Step } from "./types";
import "./activity.css";

/** What a click in the chat asked the pane to show: a run, and in it a step, thought, chapter or crew member. */
export type InspectTarget = { runId: string; select?: string; seq: number };

const flat = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
/** One line of Markdown as plain words: no list mark, heading mark or emphasis. */
const plainLine = (text: string) => flat(text.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, ""));

function statusWord(status: string) {
  return status === "Working" || status === "Running" ? "Running" : status === "Completed" || status === "Done" ? "Done" : status;
}
function statusTone(status: string) {
  const word = statusWord(status);
  return word === "Running" ? "run" : word === "Done" ? "ok" : word === "Stopped" ? "quiet" : "bad";
}

/** "2m 14s", counting up once a second while the turn runs. Only this text re-renders. */
function Since({ from, to }: { from: number; to?: number }) {
  const now = useNow(to === undefined);
  return <>{duration(Math.max(0, (to ?? now) - from))}</>;
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────

/** A step's right-hand mark in the story: failed, still running, lines changed, or how long it took. */
function StepMark({ step }: { step: Step }) {
  if (step.status === "Failed") return <span className="insp-mark bad">Failed</span>;
  if (step.status === "Running") return <span className="insp-mark">Running</span>;
  const diff = parseStepInput(step).diff;
  if (diff && (diff.added || diff.removed))
    return (
      <span className="insp-mark">
        <span className="ok">+{diff.added}</span> <span className="bad">−{diff.removed}</span>
      </span>
    );
  return <span className="insp-mark">{step.finished ? took(step.finished - step.started) : ""}</span>;
}

/** A step's words. A step that started a helper says which one ("Asked Code searcher"). */
function headline(step: Step, run: Run) {
  if (classifyStep(step) !== "helper") return stepHeadline(step);
  const helper = run.agents?.find((agent) => agent.id === step.id);
  const name = helper?.name ?? parseStepInput(step).description;
  if (!name) return stepHeadline(step);
  return (step.status === "Running" ? "Waiting for " : "Asked ") + name;
}

function StepIcon({ step, size = 14 }: { step: Step; size?: number }) {
  const Icon = stepIcon(step);
  return <Icon size={size} aria-hidden="true" />;
}

type Row = { key: string; kind: "chapter"; chapter: Chapter<Step> } | { key: string; kind: "item"; chapter: Chapter<Step>; item: ChapterItem<Step> };

function keep(item: ChapterItem<Step>, filter: Filter) {
  if (filter === "all") return true;
  if (item.kind === "update") return false;
  if (filter === "failed") return item.step.status === "Failed";
  if (filter === "thinking") return false;
  return filterOf(classifyStep(item.step)) === filter;
}

/** The rows the story shows under a filter, in order: each chapter's heading, then its items. */
function storyRows(chapters: Chapter<Step>[], filter: Filter): Row[] {
  const rows: Row[] = [];
  for (const chapter of chapters) {
    if (filter === "thinking" && !chapter.thought) continue;
    const items = chapter.items.filter((item) => keep(item, filter));
    if (filter !== "all" && filter !== "thinking" && !items.length) continue;
    rows.push({ key: chapter.key, kind: "chapter", chapter });
    for (const item of items) rows.push({ key: item.key, kind: "item", chapter, item });
  }
  return rows;
}

export function ActivityPanel({ run, updates, target, onCrew }: { run: Run; updates: StoryUpdate[]; target?: InspectTarget; /** Opens the Crew tab, on a helper when given its id. */ onCrew?: (id?: string) => void }) {
  const chapters = useMemo(() => storyChapters(run, updates), [run.steps, run.reasoning, run.teamwork, run.taskHandoffs, updates]);
  const chips = useMemo(() => filterChips(chapters), [chapters]);
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<string | undefined>(() => target?.select);
  // Narrow, the list and the detail take turns: a row opens the detail, Back returns.
  const [showing, setShowing] = useState<"list" | "detail">(() => (target?.select ? "detail" : "list"));
  // A new click in the chat chooses again, and shows everything so the choice is in view.
  useEffect(() => {
    if (!target) return;
    setPicked(target.select);
    setFilter("all");
    if (target.select) setShowing("detail");
  }, [target?.seq, run.id]);
  const rows = useMemo(() => storyRows(chapters, filter), [chapters, filter]);
  const chosen = pickSelection(chapters, picked);
  const selected = rows.find((row) => row.key === chosen) ?? rows.find((row) => row.kind === "item") ?? rows[0];
  const list = useRef<HTMLDivElement>(null);
  // The selected row stays in view in the list. Only the list scrolls: scrollIntoView would move the pane too.
  useLayoutEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !row) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight + 8;
  }, [selected?.key, showing]);
  const choose = (key: string, focus = false) => {
    setPicked(key);
    if (!focus) setShowing("detail");
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  };
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const at = rows.findIndex((row) => row.key === selected?.key);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    if (rows[next]) choose(rows[next].key, true);
  };
  const steps = chapters.reduce((n, chapter) => n + chapter.steps.length, 0);
  const live = run.finished === undefined && run.status === "Working";
  const end = run.finished ?? (live ? undefined : run.time + (run.usage?.durationMs ?? 0));
  const crew = !!onCrew;
  return (
    <div className={"inspector activity-inspector" + (showing === "detail" ? " showing-detail" : "")}>
      <div className="insp-head">
        <p className="insp-title" title={run.title}>{run.title || "This turn"}</p>
        <div className="insp-meta">
          <span className={"insp-pill " + statusTone(run.status)}>
            {statusTone(run.status) === "ok" && <Check size={12} aria-hidden="true" />}
            {statusWord(run.status)}
          </span>
          <span className="insp-muted">
            <Since from={run.time} to={end} /> · {steps} {steps === 1 ? "step" : "steps"}
          </span>
          {crew && (
            <button type="button" className="insp-link" onClick={() => onCrew()}>
              <Users size={13} aria-hidden="true" />
              Crew
            </button>
          )}
        </div>
        {chips.length > 1 && (
          <div className="insp-chips" role="toolbar" aria-label="Show">
            {chips.map(({ filter: f, count }) => (
              <button key={f} type="button" className={"insp-chip" + (f === "failed" ? " bad" : "")} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {FILTER_NAMES[f]}
                {f !== "all" && <span className="insp-chip-n">{count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {!rows.length ? (
        <p className="insp-empty">{chapters.length ? "Nothing of this kind." : live ? "Nothing yet. Steps show here as the bot works." : "No steps were recorded for this turn."}</p>
      ) : (
        <div className="insp-body">
          <div className="insp-list" ref={list} role="listbox" aria-label="How it went" onKeyDown={onKeys}>
            {rows.map((row) => {
              const on = row.key === selected?.key;
              const common = {
                key: row.key,
                type: "button" as const,
                role: "option",
                "aria-selected": on,
                "data-key": row.key,
                tabIndex: on ? 0 : -1,
                onClick: () => choose(row.key),
              };
              if (row.kind === "chapter")
                return (
                  <button {...common} className={"insp-chapter" + (on ? " on" : "")}>
                    {row.chapter.thought ? <Brain size={14} aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
                    <span className="insp-text">{row.chapter.heading}</span>
                    <span className="insp-mark">{clock(row.chapter.at - run.time)}</span>
                  </button>
                );
              const item = row.item;
              if (item.kind === "update")
                return (
                  <button {...common} className={"insp-row update" + (on ? " on" : "")}>
                    <MessageSquareText size={14} aria-hidden="true" />
                    <span className="insp-text">{flat(item.update.text)}</span>
                  </button>
                );
              const failed = item.step.status === "Failed";
              const command = classifyStep(item.step) === "command";
              return (
                <button {...common} className={"insp-row" + (on ? " on" : "") + (failed ? " failed" : "") + (item.step.status === "Running" ? " running" : "")}>
                  <StepIcon step={item.step} />
                  <span className={"insp-text" + (command ? " mono" : "")}>{headline(item.step, run)}</span>
                  <StepMark step={item.step} />
                </button>
              );
            })}
          </div>
          <div className="insp-detail" aria-live="polite">
            <button type="button" className="insp-back" onClick={() => setShowing("list")}>
              <ArrowLeft size={14} aria-hidden="true" />
              All steps
            </button>
            {selected && <Detail row={selected} run={run} onCrew={onCrew} />}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ row, run, onCrew }: { row: Row; run: Run; onCrew?: (id?: string) => void }) {
  const chapter = row.chapter;
  const start = run.time;
  if (row.kind === "chapter") {
    return (
      <div className="insp-sel">
        <h3 className="insp-sel-title">{chapter.heading}</h3>
        <div className="insp-kv">
          <span>Began at {clock(chapter.at - start)}</span>
          {!!chapter.steps.length && <span>{summarizeSteps(chapter.steps)}</span>}
          {!!chapter.failed && <span className="bad">{chapter.failed} failed</span>}
        </div>
        {chapter.thought ? <div className="insp-thought"><RichText text={chapter.thought.text} /></div> : <p className="insp-muted">No thinking was shared for this part.</p>}
      </div>
    );
  }
  const item = row.item;
  if (item.kind === "update") {
    return (
      <div className="insp-sel">
        <h3 className="insp-sel-title">Update</h3>
        <div className="insp-kv"><span>At {clock(item.at - start)}</span></div>
        <div className="insp-thought"><RichText text={item.update.text} /></div>
      </div>
    );
  }
  const step = item.step;
  const command = classifyStep(step) === "command";
  return (
    <div className="insp-sel">
      <div className="insp-sel-head">
        <span className={step.status === "Failed" ? "bad" : "insp-muted"}><StepIcon step={step} size={15} /></span>
        <b className={"insp-sel-title" + (command ? " mono" : "")}>{headline(step, run)}</b>
        <span className={"insp-pill " + statusTone(step.status)}>{statusWord(step.status)}</span>
      </div>
      <div className="insp-kv">
        <span>Ran at {clock(step.started - start)}</span>
        {step.finished && <span>Took {took(step.finished - step.started)}</span>}
        {step.source && <span>{step.source}</span>}
      </div>
      <StepDetailBody step={step} />
      {onCrew && classifyStep(step) === "helper" && run.agents?.some((agent) => agent.id === step.id) && (
        <button type="button" className="secondary insp-open-crew" onClick={() => onCrew(step.id)}>
          <Users size={13} aria-hidden="true" />
          Open in Crew
        </button>
      )}
      {chapter.thought && (
        <div className="insp-why">
          <b>
            <Brain size={12} aria-hidden="true" />
            Why it ran this
          </b>
          <p>{chapter.thought.snippet || chapter.heading}</p>
        </div>
      )}
    </div>
  );
}

// ── Crew ─────────────────────────────────────────────────────────────────────────────────────────

/** The face of a helper (its initial in its color) or of a command (a terminal). */
function MemberFace({ member, index, size = 22 }: { member: CrewMember<Step>; index: number; size?: number }) {
  if (member.kind === "command")
    return (
      <span className="crew-face command" style={{ width: size, height: size }} aria-hidden="true">
        <Terminal size={Math.round(size * 0.58)} />
      </span>
    );
  return (
    <span className="crew-face" style={{ width: size, height: size, background: crewColor(index), fontSize: Math.round(size * 0.5) }} aria-hidden="true">
      {initial(member.name)}
    </span>
  );
}

/** A small, still sign of how one member is doing: no motion, so a folded card never repaints. */
function Mark({ status }: { status: string }) {
  if (isLive(status)) return <i className="crew-dot" aria-hidden="true" />;
  if (status === "Done") return <Check size={12} className="ok" aria-hidden="true" />;
  if (status === "Stopped") return <Ban size={12} className="insp-muted" aria-hidden="true" />;
  return <X size={12} className="bad" aria-hidden="true" />;
}

/** Whether this window can stop a helper or command: the computer in use has "stop-helper-v1". */
export function canStopHelpers(using: { capabilities: string[] } | null | undefined) {
  return typeof window.botkins?.stopHelper === "function" && (!using || using.capabilities.includes("stop-helper-v1"));
}

/** Stop, after a yes: the helper's or command's own button. Errors show as text beside it. */
function useStop(chatId: string, botName: string) {
  const { ask, node } = useAsk();
  const [error, setError] = useState<{ id: string; text: string }>();
  const [stopping, setStopping] = useState<string>();
  const stop = async (member: CrewMember<Step>) => {
    const command = member.kind === "command";
    const yes = await ask({
      title: command ? "Stop this process?" : "Stop " + member.name + "?",
      body: command ? member.name + " stops now. " + botName + " isn't told why." : "It stops where it is, and " + botName + " gets what it found so far.",
      confirm: command ? "Stop process" : "Stop helper",
      danger: true,
    });
    if (yes === null) return;
    setError(undefined);
    setStopping(member.id);
    try {
      await window.botkins.stopHelper(chatId, member.id);
    } catch (e) {
      setError({ id: member.id, text: "Couldn't stop it. " + (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "") : String(e)) });
    } finally {
      setStopping(undefined);
    }
  };
  return { stop, node, error, stopping };
}

export function CrewPanel({ run, chatId, botName, botFace, target, canStop }: { run: Run; chatId: string; botName: string; botFace: ReactNode; target?: InspectTarget; canStop: boolean }) {
  const crew = useMemo(() => crewOf(run), [run.steps, run.agents]);
  const live = run.finished === undefined || !!crew?.running;
  const now = useNow(live);
  const lanes = useMemo(() => crewLanes(run, now, botName), [run, now, botName]);
  const [picked, setPicked] = useState<string | undefined>(() => target?.select);
  useEffect(() => {
    if (target?.select) setPicked(target.select);
  }, [target?.seq]);
  const { stop, node, error, stopping } = useStop(chatId, botName);
  if (!crew) return <p className="insp-empty">No helpers or background commands in this turn.</p>;
  const members = crew.members;
  const member = members.find((m) => m.id === picked) ?? members.find((m) => isLive(m.status)) ?? members[0];
  const index = members.indexOf(member);
  const ticks = laneTicks(lanes.end - lanes.start, live);
  const hatched = lanes.lanes.some((lane) => lane.live);
  const waited = lanes.lanes[0]?.segments.some((segment) => segment.state === "wait");
  return (
    <div className="inspector crew-inspector">
      {node}
      <div className="crew-lanes" role="group" aria-label="Who worked when">
        {lanes.lanes.map((lane) => {
          const at = members.findIndex((m) => m.id === lane.id);
          const color = lane.kind === "bot" ? "var(--accent)" : lane.kind === "command" ? "var(--success)" : crewColor(at);
          const on = lane.id === member.id;
          const label = (
            <>
              <span className="crew-lane-who">
                {lane.kind === "bot" ? botFace : <MemberFace member={members[at]} index={at} size={16} />}
                <span className={"crew-lane-name" + (lane.kind === "command" ? " mono" : "")}>{lane.label}</span>
              </span>
              <span className="crew-track" aria-hidden="true">
                {lane.segments.map((segment, i) => (
                  <span
                    key={i}
                    className={"crew-bar" + (segment.state === "wait" ? " wait" : "") + (lane.live && i === lane.segments.length - 1 ? " live" : "")}
                    style={{ left: segment.from * 100 + "%", width: Math.max(0.6, (segment.to - segment.from) * 100) + "%", ["--bar" as string]: color }}
                  />
                ))}
              </span>
            </>
          );
          return lane.kind === "bot" ? (
            <div key={lane.id} className="crew-lane bot" role="img" aria-label={lane.label + ", " + statusWord(lane.status)}>
              {label}
            </div>
          ) : (
            <button key={lane.id} type="button" className={"crew-lane" + (on ? " on" : "")} aria-pressed={on} aria-label={lane.label + ", " + statusWord(lane.status)} onClick={() => setPicked(lane.id)}>
              {label}
            </button>
          );
        })}
        <div className="crew-ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.at} style={{ left: tick.at * 100 + "%" }}>{tick.label}</span>
          ))}
        </div>
        {(waited || hatched) && (
          <div className="crew-legend" aria-hidden="true">
            {waited && <span><i className="crew-swatch wait" />{botName} waiting</span>}
            {hatched && <span><i className="crew-swatch live" />Still running</span>}
          </div>
        )}
      </div>
      <div className="crew-member" key={member.id}>
        {member.kind === "helper" ? (
          <HelperView run={run} member={member} index={index} botName={botName} botFace={botFace} now={now} />
        ) : (
          <CommandView run={run} member={member} botName={botName} now={now} />
        )}
        <div className="crew-actions">
          {member.kind === "command" && <CopyOutput text={member.step.progress || member.step.output || ""} />}
          {member.stoppable && canStop && (
            <button type="button" className="secondary danger" disabled={stopping === member.id} onClick={() => void stop(member)}>
              <Square size={12} aria-hidden="true" />
              {stopping === member.id ? "Stopping…" : member.kind === "command" ? "Stop process" : "Stop helper"}
            </button>
          )}
        </div>
        {error?.id === member.id && <p className="insp-error" role="alert">{error.text}</p>}
      </div>
    </div>
  );
}

function MemberHead({ member, face, now, mono }: { member: CrewMember<Step>; face: ReactNode; now: number; mono?: boolean }) {
  const running = isLive(member.status);
  return (
    <div className="crew-head">
      {face}
      <b className={"crew-head-name" + (mono ? " mono" : "")}>{member.name}</b>
      <span className={"insp-pill " + statusTone(member.status)}>
        {statusWord(member.status)} · {duration(Math.max(0, (member.finished ?? (running ? now : member.started)) - member.started))}
      </span>
    </div>
  );
}

function HelperView({ run, member, index, botName, botFace, now }: { run: Run; member: Extract<CrewMember<Step>, { kind: "helper" }>; index: number; botName: string; botFace: ReactNode; now: number }) {
  const helper = member.helper;
  const running = isLive(member.status);
  const own = useMemo(() => (run.steps ?? []).filter((step) => step.agentId === member.id && classifyStep(step)), [run.steps, member.id]);
  const asked = helper.prompt || helper.description;
  return (
    <>
      <MemberHead member={member} face={<MemberFace member={member} index={index} size={24} />} now={now} />
      <p className="crew-sub">Helper of {botName} · started at {clock(member.started - run.time)}</p>
      {asked && (
        <div className="crew-said">
          <span className="crew-said-who">{botFace}{botName} asked</span>
          <div className="crew-bubble asked"><RichText text={asked} /></div>
        </div>
      )}
      {own.length > 0 ? (
        <ol className="crew-steps" aria-label={member.name + "'s steps"}>
          {own.map((step) => (
            <li key={step.id}>
              <details>
                <summary className={"insp-row" + (step.status === "Failed" ? " failed" : "") + (step.status === "Running" ? " running" : "")}>
                  <StepIcon step={step} />
                  <span className="insp-text">{stepHeadline(step)}</span>
                  <StepMark step={step} />
                  <ChevronRight size={12} className="crew-step-chevron" aria-hidden="true" />
                </summary>
                <StepDetailBody step={step} />
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="insp-muted crew-none">{running ? "No steps yet." : "No steps recorded."}</p>
      )}
      {running && member.doing && (
        <p className="crew-live">
          <Shimmer on>{member.doing}</Shimmer>
        </p>
      )}
      {helper.result ? (
        <div className="crew-said reply">
          <span className="crew-said-who"><MemberFace member={member} index={index} size={16} />{member.name}</span>
          <div className="crew-bubble"><RichText text={helper.result} /></div>
        </div>
      ) : (
        !running && helper.detail && <p className="insp-muted">{helper.detail}</p>
      )}
    </>
  );
}

function CommandView({ run, member, botName, now }: { run: Run; member: Extract<CrewMember<Step>, { kind: "command" }>; botName: string; now: number }) {
  const step = member.step;
  const text = (step.progress || step.output || "").replace(/\s+$/, "");
  const links = useMemo(() => outputLinks(text), [text]);
  const thought = thoughtBefore(run.reasoning, step.started);
  const why = thought && thoughtHeading(thought.text);
  const lines = text ? text.split("\n").length : 0;
  const term = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = term.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <>
      <MemberHead member={member} face={<span className="crew-face command" aria-hidden="true"><Terminal size={14} /></span>} now={now} mono />
      <p className="crew-sub">
        Background · started by {botName} at {clock(member.started - run.time)}
        {lines > 0 && " · " + lines + (lines === 1 ? " line" : " lines")}
      </p>
      {why && (
        <div className="insp-why">
          <b>
            <Brain size={12} aria-hidden="true" />
            Why {botName} started it
          </b>
          <p>{why.snippet || why.heading}</p>
        </div>
      )}
      {links.length > 0 && (
        <div className="crew-links">
          {links.map((url) => (
            <button key={url} type="button" className="secondary" title={url} onClick={() => void window.botkins.openLink(url).catch(() => {})}>
              <ExternalLink size={13} aria-hidden="true" />
              {linkWords(url)}
            </button>
          ))}
        </div>
      )}
      <div className="crew-out-head">
        <span>Output</span>
        {isLive(member.status) && text && <span className="insp-muted">Following newest</span>}
      </div>
      <pre
        className="crew-term"
        ref={term}
        tabIndex={0}
        aria-label="Output"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text || (isLive(member.status) ? "Waiting for output…" : "No output")}
      </pre>
    </>
  );
}

function CopyOutput({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className="secondary" disabled={!text} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>
      <Copy size={12} aria-hidden="true" />
      {copied ? "Copied" : "Copy output"}
    </button>
  );
}

// ── In the chat ──────────────────────────────────────────────────────────────────────────────────

/** What the folded crew card draws from: its line and each member's status. The chat works these out per turn. */
export function crewCardProps(run: Run): { crew: Crew<Step>; line: string; marks: string } | null {
  const crew = crewOf(run);
  if (!crew) return null;
  return { crew, line: crewLine(crew), marks: crew.members.map((m) => m.status).join(",") };
}

type CrewCardProps = {
  run: Run;
  line: string;
  marks: string;
  open: boolean;
  toggle: (runId: string) => void;
  openMember: (runId: string, id: string) => void;
  botName: string;
  canStop: boolean;
};

/**
 * The crew in the chat. Folded, it is one still line ("2 helpers · 1 command · 2 working") with a
 * mark per member, and it draws again only when that line or a mark changes. Open, a row per
 * member: its name, what it is doing or came back with, its steps and time. A row opens the Crew tab.
 */
export const CrewCard = memo(
  function CrewCard({ run, line, marks, open, toggle, openMember, botName, canStop }: CrewCardProps) {
    return (
      <section className={"crew-card" + (open ? " open" : "")} aria-label="Crew">
        <button type="button" className="crew-card-head" aria-expanded={open} onClick={() => toggle(run.id)}>
          <Users size={14} aria-hidden="true" />
          <span className="crew-card-line">{line}</span>
          <span className="crew-marks">
            {marks.split(",").slice(0, 6).map((status, i) => (
              <Mark key={i} status={status} />
            ))}
          </span>
          <ChevronRight size={14} className="crew-card-chevron" aria-hidden="true" />
        </button>
        {open && <CrewRows run={run} openMember={openMember} botName={botName} canStop={canStop} />}
      </section>
    );
  },
  (a, b) =>
    a.line === b.line && a.marks === b.marks && a.open === b.open && a.toggle === b.toggle && a.openMember === b.openMember && a.canStop === b.canStop && a.botName === b.botName && (!a.open || a.run === b.run),
);

function CrewRows({ run, openMember, botName, canStop }: { run: Run; openMember: (runId: string, id: string) => void; botName: string; canStop: boolean }) {
  const crew = useMemo(() => crewOf(run), [run.steps, run.agents]);
  const now = useNow(!!crew?.running);
  const { stop, node, error } = useStop(run.chatId, botName);
  if (!crew) return null;
  return (
    <div className="crew-rows">
      {node}
      {crew.members.map((member, i) => {
        const running = isLive(member.status);
        const raw = running ? member.doing : member.kind === "helper" ? member.done : member.doing;
        const line = raw && plainLine(raw);
        const elapsed = duration(Math.max(0, (member.finished ?? (running ? now : member.started)) - member.started));
        const meta = member.kind === "helper" ? member.steps + (member.steps === 1 ? " step" : " steps") + " · " + elapsed : (running ? "running · " : statusWord(member.status).toLowerCase() + " · ") + elapsed;
        return (
          <div key={member.id} className={"crew-row" + (running ? " running" : "")}>
            <button type="button" className="crew-row-main" onClick={() => openMember(run.id, member.id)} aria-label={member.name + ", " + statusWord(member.status) + ". Open in Crew"}>
              <MemberFace member={member} index={i} />
              <span className="crew-row-body">
                <span className={"crew-row-name" + (member.kind === "command" ? " mono" : "")}>
                  {member.name}
                  {!running && <Mark status={member.status} />}
                </span>
                {line && (
                  <span className="crew-row-line">
                    <Shimmer on={running && member.kind === "helper"}>{line}</Shimmer>
                  </span>
                )}
              </span>
              <span className="crew-row-meta">{meta}</span>
            </button>
            {member.kind === "command" && member.stoppable && canStop && (
              <button type="button" className="secondary danger crew-row-stop" onClick={() => void stop(member)}>
                Stop
              </button>
            )}
            {error?.id === member.id && <p className="insp-error" role="alert">{error.text}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** A finished turn's fold opened in the chat: one line per chapter, its heading and what it did. */
export function ChapterSummary({ chapters, open }: { chapters: Chapter<Step>[]; open: (key: string) => void }) {
  if (!chapters.length) return null;
  return (
    <ol className="chapter-summary" aria-label="How it went">
      {chapters.map((chapter) => {
        // What the steps did, or what the bot wrote. Without a thought the heading already says what the steps did.
        const update = chapter.items.find((item) => item.kind === "update");
        const said = update?.kind === "update" ? flat(update.update.text) : "";
        const line = (chapter.thought && summarizeSteps(chapter.steps)) || said;
        return (
          <li key={chapter.key}>
            <button type="button" onClick={() => open(chapter.key)}>
              {chapter.thought ? <Brain size={14} aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
              <span className="chapter-summary-text">
                <span className="chapter-summary-heading">{chapter.heading}</span>
                {line && <span className="chapter-summary-line">{line}</span>}
              </span>
              {chapter.failed > 0 && <span className="bad chapter-summary-failed">{chapter.failed} failed</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
