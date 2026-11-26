import type { ReactNode } from "react";
import { ChevronRight, CirclePause, Clock, ChevronsUpDown } from "lucide-react";
import { BotAvatar, type AvatarState } from "./Avatar";
import { cadenceSummary, routineItems } from "./Routines";
import { TodoItems } from "./ChatActivity";
import type { Bot, State, Todo } from "./types";
import "./chatside.css";

/**
 * What the chat itself offers in Details: its model, its context with Compact and Reset context,
 * the main chat's threads, its todos and its people. ChatView builds it, since the actions are its
 * own; the chat header keeps only a context ring and the ⋯ menu, so these live here as well.
 */
export type ChatDetails = {
  /** The model and thinking level, and the way to change them. */
  model?: { label: string; badge: ReactNode; change: () => void };
  context?: { current: number; limit: number; percent: number };
  busy: boolean;
  compact?: () => void;
  reset?: () => void;
  /** The main chat's threads (forks); one is active. */
  forks?: { id: string; name: string }[];
  activeFork?: string;
  switchFork?: (id: string) => void;
  todos: Todo[];
  people?: { summary: string; invite?: () => void };
  botSettings?: () => void;
};

const short = (v: number) => (v >= 1000 ? Math.round(v / 1000) + "K" : String(v));

/** The quiet panel beside a one-bot chat: the bot, this chat, its todos, people and the bot's routines. */
export default function ChatSide({
  state,
  bot,
  face,
  openRoutines,
  openBot,
  details,
}: {
  state: State;
  bot: Bot;
  /** What the bot is doing now, as the header's avatar shows it. */
  face: AvatarState;
  openRoutines?: (target: { id?: string; botId?: string }) => void;
  openBot?: () => void;
  details?: ChatDetails;
}) {
  // Soonest first; paused and finished routines sink to the end.
  const items = routineItems(state, bot.id).sort((a, b) => (a.entry.nextAt ?? Infinity) - (b.entry.nextAt ?? Infinity));
  const d = details;
  const done = d?.todos.filter((t) => t.status === "done").length ?? 0;
  const showChat = d && (d.model || d.context || d.compact || d.reset || (d.forks && d.switchFork));
  return (
    <aside className="chat-side" aria-label="Details">
      <div className="group chat-side-card">
        <div className="chat-side-bot">
          <BotAvatar bot={bot} state={face} size={48} animated />
          <span className="chat-side-who">
            <strong className="chat-side-name">{bot.name}</strong>
            {bot.role && <small>{bot.role}</small>}
          </span>
        </div>
        {(openBot || d?.botSettings) && (
          <div className="chat-side-actions">
            {openBot && (
              <button type="button" className="btn soft small chat-side-link" onClick={openBot}>
                Bot page
              </button>
            )}
            {d?.botSettings && (
              <button type="button" className="btn soft small" onClick={d.botSettings}>
                Bot settings
              </button>
            )}
          </div>
        )}
      </div>

      {showChat && (
        <section className="page-section" aria-label="This chat">
          <h3 className="group-label">This chat</h3>
          <div className="group">
            {d.model && (
              <button
                type="button"
                className="group-row chat-side-model"
                aria-label={"Model: " + d.model.label + ". Change model and thinking"}
                title="Model and thinking"
                onClick={d.model.change}
              >
                <span className="row-main"><span className="row-title">Model</span></span>
                <span className="row-value">{d.model.badge}</span>
                <ChevronRight size={16} className="row-chevron" aria-hidden="true" />
              </button>
            )}
            {(d.context || d.compact || d.reset) && (
              <div className="group-row chat-side-context">
                {d.context && (
                  <>
                    <div className="chat-side-context-line">
                      <span className="row-title">Context</span>
                      <span className="row-value">
                        {short(d.context.current)} of {short(d.context.limit)} · {d.context.percent}%
                      </span>
                    </div>
                    <div className="chat-side-meter" aria-hidden="true">
                      <i className={d.context.percent >= 80 ? "high" : undefined} style={{ width: d.context.percent + "%" }} />
                    </div>
                  </>
                )}
                {(d.compact || d.reset) && (
                  <div className="chat-side-context-actions">
                    {d.compact && (
                      <button type="button" className="btn small" disabled={d.busy} title="Compact: summarize earlier turns to free up context" onClick={d.compact}>
                        Compact
                      </button>
                    )}
                    {d.reset && (
                      <button type="button" className="btn small quiet danger" disabled={d.busy} title="Start the main chat's context over; the earlier thread stays" onClick={d.reset}>
                        Reset context
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {d.forks && d.switchFork && (
              <label className="group-row chat-side-thread">
                <span className="row-main"><span className="row-title">Thread</span></span>
                <select
                  aria-label="Main chat context"
                  title="Main chat context"
                  disabled={d.busy}
                  value={d.activeFork}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id === "reset") d.reset?.();
                    else d.switchFork!(id);
                  }}
                >
                  {d.forks.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                  {d.reset && <option value="reset">Reset context</option>}
                </select>
                <ChevronsUpDown size={14} className="row-chevron" aria-hidden="true" />
              </label>
            )}
          </div>
        </section>
      )}

      {d && d.todos.length > 0 && (
        <section className="page-section chat-side-todos" aria-label="Todos">
          <h3 className="group-label">
            Todos · {done} of {d.todos.length}
          </h3>
          <div className="group padded">
            <TodoItems todos={d.todos} />
          </div>
        </section>
      )}

      {d?.people && (
        <section className="page-section" aria-label="People">
          <h3 className="group-label">People</h3>
          <div className="group">
            <div className="group-row">
              <span className="row-main"><span className="row-sub">{d.people.summary}</span></span>
              {d.people.invite && (
                <button type="button" className="btn soft small" aria-haspopup="dialog" onClick={d.people.invite}>
                  Invite
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="page-section chat-side-routines" aria-label="Routines">
        <h3 className="group-label">Routines</h3>
        <div className="group">
          {items.length ? (
            <ul>
              {items.map((i) => {
                const paused = i.entry.enabled === false;
                const body = (
                  <>
                    {paused ? <CirclePause size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
                    <span className="row-main">
                      <strong className="row-title">{i.entry.name ?? i.entry.prompt}</strong>
                      <small className="row-sub">{paused ? "Paused" : cadenceSummary(i.entry.cadence)}</small>
                    </span>
                  </>
                );
                return (
                  <li key={i.chat.id + ":" + i.entry.id} className={paused ? "paused" : undefined}>
                    {openRoutines ? (
                      <button type="button" className="group-row" onClick={() => openRoutines({ id: i.chat.id })}>
                        {body}
                      </button>
                    ) : (
                      <div className="group-row">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="group-row chat-side-none">No routines yet</p>
          )}
        </div>
      </section>
    </aside>
  );
}
