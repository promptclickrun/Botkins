import { BarChart3, BriefcaseBusiness, CalendarClock, ChevronRight, KanbanSquare } from "lucide-react";
import { dateLabel, type PageActions } from "./Pages";
import { scheduleSummary, upcomingRuns, whenLabel } from "./Routines";
import type { Run, State } from "./types";
import "./routines.css";

const FILTERS = ["All", "Working", "Needs you", "Completed"] as const;

/** Which Work filter a run belongs to. A run waiting on the person, or a failed scheduled run, needs you. */
export function workCategory(run: Run, state: Pick<State, "requests">) {
  if (run.status === "Working") return state.requests.some((r) => r.chatId === run.chatId) ? "Needs you" : "Working";
  if (run.status === "Completed") return "Completed";
  if (run.status === "Needs you") return "Needs you";
  if ((run.trigger === "scheduled" || run.scheduleId != null) && run.status !== "Stopped") return "Needs you";
  return "Other";
}

export function WorkPage({
  state,
  actions,
  filter,
  setFilter,
  routines,
  usage,
  tasks,
}: {
  state: State;
  actions: PageActions;
  filter: string;
  setFilter: (f: string) => void;
  /** Opens Routines, optionally on one routine. */
  routines: (target?: { id?: string }) => void;
  usage: () => void;
  /** Opens the Tasks board. */
  tasks?: () => void;
}) {
  const category = new Map(state.runs.map((r) => [r.id, workCategory(r, state)]));
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f, f === "All" ? state.runs.length : state.runs.filter((r) => category.get(r.id) === f).length]),
  );
  const shown = state.runs.filter((r) => filter === "All" || category.get(r.id) === filter);
  const upcoming = filter === "All" ? upcomingRuns(state) : [];
  const chatBot = (chatId: string) => state.bots.find((b) => b.id === state.chats.find((c) => c.id === chatId)?.botId);
  return (
    <>
      <div className="sectionhead work-head">
        <h1>Work</h1>
        <div className="work-doors">
          {tasks && (
            <button onClick={tasks}>
              <KanbanSquare size={15} />
              Tasks
              {!!state.tasks?.filter((t) => t.status === "review" || t.status === "blocked").length && (
                <span className="count">{state.tasks.filter((t) => t.status === "review" || t.status === "blocked").length}</span>
              )}
            </button>
          )}
          <button onClick={() => routines()}>
            <CalendarClock size={15} />
            Routines
          </button>
          <button onClick={usage}>
            <BarChart3 size={15} />
            Usage
          </button>
        </div>
      </div>
      <div className="filters chips">
        {FILTERS.map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
            <span className="count">{counts[f]}</span>
          </button>
        ))}
      </div>
      {shown.map((r) => {
        const kind = category.get(r.id);
        // The status shows as a small dot and word in its status color.
        const tone = kind === "Working" ? "working" : kind === "Completed" ? "done" : kind === "Needs you" ? "needs" : "";
        return (
          <button className="row work-row" key={r.id} onClick={() => actions.open(r.chatId)}>
            <i className={"work-dot " + tone} aria-hidden="true" />
            <span className="rowtext">
              <strong>{r.title}</strong>
              <small>
                {chatBot(r.chatId)?.name} ·{" "}
                <span className={"status-word " + tone}>{kind === "Needs you" && r.status === "Working" ? "Waiting for you" : r.status}</span>
                {r.trigger === "scheduled" ? " · Scheduled" : r.scheduleId != null ? " · Routine" : ""}
                {r.skill ? " · /" + r.skill : ""}
                {r.usedTools?.length ? " · " + r.usedTools.join(", ") : ""}
              </small>
            </span>
            <time>{dateLabel(r.time)}</time>
            <ChevronRight size={15} />
          </button>
        );
      })}
      {!shown.length && !upcoming.length && (
        <div className="empty">
          <BriefcaseBusiness />
          <div>
            <strong>{filter === "All" ? "No work yet" : "No matching work"}</strong>
            <small>Each request you send to a bot appears here.</small>
          </div>
        </div>
      )}
      {upcoming.length > 0 && (
        <section className="work-upcoming" aria-label="Upcoming">
          <h2>
            Upcoming <small>{upcoming.length}</small>
          </h2>
          {upcoming.map(({ chat, entry, bot, at }) => (
            <button
              className="row work-row"
              key={chat.id + ":" + entry.id}
              onClick={() => (entry.routine ? routines({ id: chat.id }) : actions.open(chat.id))}
            >
              <CalendarClock size={20} />
              <span className="rowtext">
                <strong>{entry.routine ? entry.name : entry.prompt}</strong>
                <small>
                  {bot?.name} · {scheduleSummary(entry)} · {entry.routine ? "Routine" : "Chat schedule"}
                </small>
              </span>
              <time>{whenLabel(at)}</time>
              <ChevronRight size={15} />
            </button>
          ))}
        </section>
      )}
    </>
  );
}
