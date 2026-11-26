import { BriefcaseBusiness, CalendarClock, ChevronRight } from "lucide-react";
import { formatFeedWork } from "./activityModel";
import { IconStack } from "./ChatActivity";
import { dateLabel, type PageActions } from "./Pages";
import { scheduleSummary, upcomingRuns, whenLabel } from "./Routines";
import type { Run, State } from "./types";
import { Folded, WorkBack } from "./WorkBar";
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

/** Activity: every request a bot was given, newest first, and what is scheduled next. Opened from Work. */
export function ActivityPage({
  state,
  actions,
  filter,
  setFilter,
  routines,
  back,
}: {
  state: State;
  actions: PageActions;
  filter: string;
  setFilter: (f: string) => void;
  /** Opens Routines, optionally on one routine. */
  routines: (target?: { id?: string }) => void;
  /** Back to Work. */
  back: () => void;
}) {
  const category = new Map(state.runs.map((r) => [r.id, workCategory(r, state)]));
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f, f === "All" ? state.runs.length : state.runs.filter((r) => category.get(r.id) === f).length]),
  );
  const shown = state.runs.filter((r) => filter === "All" || category.get(r.id) === filter);
  const upcoming = filter === "All" ? upcomingRuns(state) : [];
  const chatBot = (chatId: string) => state.bots.find((b) => b.id === state.chats.find((c) => c.id === chatId)?.botId);
  return (
    <div className="page work-page activity-page">
      <WorkBack back={back} />
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">Every request a bot was given, newest first, and what is scheduled next.</p>
        </div>
      </header>
      <div className="chip-row" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <button type="button" className="chip" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
            <span className="count">{counts[f]}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 && (
        <section className="page-section" aria-label="Requests">
          <h2 className="group-label">{filter === "All" ? "Requests" : filter} · {shown.length}</h2>
          <div className="group">
            <Folded
              limit={25}
              rows={shown.map((r) => {
                const kind = category.get(r.id);
                // The status shows as a small dot and word in its status color.
                const tone = kind === "Working" ? "working" : kind === "Completed" ? "done" : kind === "Needs you" ? "needs" : "";
                const work = formatFeedWork(r);
                return (
                  <button className="group-row work-row" key={r.id} onClick={() => actions.open(r.chatId)}>
                    <i className={"work-dot " + tone} aria-hidden="true" />
                    <span className="row-main">
                      <span className="row-title">{r.title}</span>
                      <span className="row-sub">
                        {chatBot(r.chatId)?.name} ·{" "}
                        <span className={"status-word " + tone}>{kind === "Needs you" && r.status === "Working" ? "Waiting for you" : r.status}</span>
                        {r.trigger === "scheduled" ? " · Scheduled" : r.scheduleId != null ? " · Routine" : ""}
                        {r.skill ? " · /" + r.skill : ""}
                      </span>
                      {(work.kinds.length > 0 || work.summary) && (
                        <span className={"work-activity" + (tone === "working" ? " live" : "")}>
                          {work.kinds.length > 0 && <IconStack kinds={work.kinds} size={11} />}
                          <span className={"work-activity-summary" + (tone === "working" ? " shimmer-text" : "")}>
                            {work.summary || (work.stepCount === 1 ? "1 step" : work.stepCount + " steps")}
                          </span>
                          {work.failedCount > 0 && <span className="work-failed">· {work.failedCount} failed</span>}
                        </span>
                      )}
                    </span>
                    <time>{dateLabel(r.time)}</time>
                    <ChevronRight size={15} className="row-chevron" aria-hidden="true" />
                  </button>
                );
              })}
            />
          </div>
        </section>
      )}
      {!shown.length && !upcoming.length && (
        <div className="work-empty">
          <span className="icon-tile">
            <BriefcaseBusiness size={16} aria-hidden="true" />
          </span>
          <div>
            <strong>{filter === "All" ? "No activity yet" : "No matching activity"}</strong>
            <small>Each request you send to a bot appears here.</small>
          </div>
        </div>
      )}
      {upcoming.length > 0 && (
        <section className="page-section work-upcoming" aria-label="Upcoming">
          <h2 className="group-label">Upcoming · {upcoming.length}</h2>
          <div className="group">
            <Folded
              rows={upcoming.map(({ chat, entry, bot, at }) => (
                <button
                  className="group-row work-row"
                  key={chat.id + ":" + entry.id}
                  onClick={() => (entry.routine ? routines({ id: chat.id }) : actions.open(chat.id))}
                >
                  <span className="icon-tile work-upcoming-icon">
                    <CalendarClock size={16} aria-hidden="true" />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{entry.routine ? entry.name : entry.prompt}</span>
                    <span className="row-sub">
                      {bot?.name} · {scheduleSummary(entry)} · {entry.routine ? "Routine" : "Chat schedule"}
                    </span>
                  </span>
                  <time>{whenLabel(at)}</time>
                  <ChevronRight size={15} className="row-chevron" aria-hidden="true" />
                </button>
              ))}
            />
          </div>
        </section>
      )}
    </div>
  );
}
