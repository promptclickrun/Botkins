// The top of Work's three pages, drawn like the phone: the large title "Work" with Activity, Usage
// and the one primary button (the new thing the tab lists) at its right, then the tabs Routines ·
// Projects · Tasks with the bot filter chips beside them, then one quiet line about the tab.
// Activity is the list of every request a bot was given; it and Usage open as pages of their own
// with a way back.
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Activity, BarChart3, ChevronDown, ChevronLeft, Plus } from "lucide-react";
import { BotAvatar } from "./Avatar";
import type { BotTask, State } from "./types";
import "./work.css";

export type WorkTab = "Routines" | "Projects" | "Tasks";
export const WORK_TABS: WorkTab[] = ["Routines", "Projects", "Tasks"];

/** How Work's pages reach each other. */
export type WorkNav = {
  /** The tabs this person may open, in order. */
  tabs: WorkTab[];
  go: (tab: WorkTab) => void;
  activity: () => void;
  usage: () => void;
  /** How many tasks wait for the person (to review, or blocked). */
  waiting: number;
};

export function WorkBar({
  work,
  tab,
  add,
  filters,
  lede,
}: {
  work: WorkNav;
  tab: WorkTab;
  add?: { label: string; run: () => void };
  /** The bot filter chips, at the right of the tabs. */
  filters?: ReactNode;
  /** One quiet line under the tabs about what the tab lists. */
  lede?: ReactNode;
}) {
  // The tabs behave as one control: the arrow keys, Home and End move between them, as in any tablist.
  const onKey = (e: KeyboardEvent) => {
    const i = work.tabs.indexOf(tab);
    const next =
      e.key === "ArrowRight" ? work.tabs[(i + 1) % work.tabs.length]
      : e.key === "ArrowLeft" ? work.tabs[(i - 1 + work.tabs.length) % work.tabs.length]
      : e.key === "Home" ? work.tabs[0]
      : e.key === "End" ? work.tabs[work.tabs.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    if (next !== tab) work.go(next);
  };
  return (
    <header className="work-bar">
      <div className="page-head">
        <div className="page-heading">
          <h1 className="page-title">Work</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="btn quiet work-tool" title="Activity" onClick={work.activity}>
            <Activity size={16} aria-hidden="true" />
            Activity
          </button>
          <button type="button" className="btn quiet work-tool" title="Usage" onClick={work.usage}>
            <BarChart3 size={16} aria-hidden="true" />
            Usage
          </button>
          {add && (
            <button type="button" className="btn primary" onClick={add.run}>
              <Plus size={16} aria-hidden="true" />
              {add.label}
            </button>
          )}
        </div>
      </div>
      <div className="work-controls">
        <div role="tablist" aria-label="Work" className="work-tabs" style={{ gridTemplateColumns: `repeat(${work.tabs.length}, minmax(0, 1fr))` }} onKeyDown={onKey}>
          {work.tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === tab}
              tabIndex={name === tab ? 0 : -1}
              onClick={() => name !== tab && work.go(name)}
            >
              {name}
              {name === "Tasks" && work.waiting > 0 && <span className="count-badge waiting">{work.waiting}</span>}
            </button>
          ))}
        </div>
        {filters && <div className="work-filters">{filters}</div>}
      </div>
      {lede && <p className="work-lede">{lede}</p>}
    </header>
  );
}

/** The way back to Work from a page it opens (Activity, Usage). */
export function WorkBack({ back }: { back: () => void }) {
  return (
    <div className="work-back">
      <button type="button" className="link-button" onClick={back}>
        <ChevronLeft size={16} aria-hidden="true" />
        Work
      </button>
    </div>
  );
}

/**
 * A group's rows, folded after `limit` behind "Show n more" so a long list stays one screen.
 * The rows are `.group-row`s, so the fold button sits in the card as one more row.
 */
export function Folded({ rows, limit = 6 }: { rows: ReactNode[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  // One hidden row is not worth a button: fold only when it hides two or more.
  const folds = rows.length > limit + 1;
  return (
    <>
      {folds && !open ? rows.slice(0, limit) : rows}
      {folds && (
        <button type="button" className="group-row work-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : "Show " + (rows.length - limit) + " more"}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

/** Tasks that wait for the person: waiting for person review (not a creator bot), or stuck. */
export const waitingTasks = (state: State) =>
  (state.tasks ?? []).filter((t) => t.status === "blocked" || (t.status === "review" && !t.reviewerBotId));

/**
 * "Needs you": the requests bots are waiting on and the tasks that wait for review or are stuck,
 * above every Work tab, as on the phone. A request opens its chat; a task opens on Tasks.
 */
export function WorkNeeds({
  state,
  openChat,
  openTask,
  requestChanges,
  fail,
}: {
  state: State;
  openChat: (chatId: string) => void;
  /** Opens a task: its dialog on Tasks, or the Tasks tab from elsewhere. */
  openTask: (task: BotTask) => void;
  /** Opens the request-changes note prompt for a Review task. */
  requestChanges?: (task: BotTask) => void;
  fail: (e: unknown) => void;
}) {
  const tasks = waitingTasks(state);
  const requests = state.requests ?? [];
  if (!requests.length && !tasks.length) return null;
  const bot = (id?: string | null) => state.bots.find((b) => b.id === id);
  const rows = [
    ...requests.map((r) => {
      const b = bot(r.botId);
      const chat = state.chats.find((c) => c.id === r.chatId);
      return (
        <div className="group-row work-needs-row" key={"r" + r.id}>
          {b && <BotAvatar bot={b} size={36} />}
          <span className="row-main">
            <span className="row-title">{r.title}</span>
            <span className="row-sub">
              {(r.sourceBotName ?? b?.name ?? "A bot") + " needs you"}
              {chat ? " · " + chat.title : ""}
            </span>
          </span>
          <button type="button" className="btn soft small" aria-label={"Open " + r.title} onClick={() => openChat(r.chatId)}>
            Open
          </button>
        </div>
      );
    }),
    ...tasks.map((t) => {
      const b = bot(t.botId);
      return (
        <div className="group-row work-needs-row" key={"t" + t.id}>
          {b ? <BotAvatar bot={b} size={36} /> : <span className="work-avatar-blank" aria-hidden="true" />}
          <button type="button" className="row-main work-needs-open" onClick={() => openTask(t)}>
            <span className="row-title">{t.title}</span>
            <span className={"row-sub" + (t.status === "blocked" ? " work-problem" : "")}>
              {(b?.name ?? "Anyone") + " · "}
              {t.status === "blocked" ? "Stuck" + (t.problem ? " · " + t.problem : "") : "Task ready for review"}
            </span>
          </button>
          {t.status === "review" ? (
            <div className="work-needs-actions">
              <button
                type="button"
                className="btn soft small"
                aria-label={"Request changes for " + t.title}
                onClick={() => (requestChanges ? requestChanges(t) : openTask(t))}
              >
                Request changes
              </button>
              <button
                type="button"
                className="btn primary small"
                aria-label={"Approve " + t.title}
                onClick={() => void window.botkins.moveTask(t.id, "done").catch(fail)}
              >
                Approve
              </button>
            </div>
          ) : (
            <button type="button" className="btn soft small" aria-label={"Open " + t.title} onClick={() => openTask(t)}>
              Open
            </button>
          )}
        </div>
      );
    }),
  ];
  return (
    <section className="page-section" aria-label="Needs you">
      <h2 className="group-label">Needs you · {rows.length}</h2>
      <div className="group work-avatars">
        <Folded rows={rows} limit={4} />
      </div>
    </section>
  );
}

/** The bot filter as chips: All bots, then each bot with its face. */
export function BotChips({ bots, value, change }: { bots: State["bots"]; value: string; change: (botId: string) => void }) {
  return (
    <div className="chip-row" role="group" aria-label="Filter by bot">
      <button type="button" className="chip" aria-pressed={!value} onClick={() => change("")}>
        All bots
      </button>
      {bots.map((b) => (
        <button type="button" key={b.id} className="chip with-face" aria-pressed={value === b.id} onClick={() => change(b.id)}>
          <BotAvatar bot={b} size={20} />
          {b.name}
        </button>
      ))}
    </div>
  );
}
