import { ChevronRight, CirclePause, Clock } from "lucide-react";
import { BotAvatar, type AvatarState } from "./Avatar";
import { cadenceSummary, routineItems } from "./Routines";
import type { Bot, State } from "./types";
import "./chatside.css";

/** The quiet panel beside a one-bot chat: the bot itself, then its routines. */
export default function ChatSide({
  state,
  bot,
  face,
  openRoutines,
  openBot,
}: {
  state: State;
  bot: Bot;
  /** What the bot is doing now, as the header's avatar shows it. */
  face: AvatarState;
  openRoutines?: (target: { id?: string; botId?: string }) => void;
  openBot?: () => void;
}) {
  // Soonest first; paused and finished routines sink to the end.
  const items = routineItems(state, bot.id).sort((a, b) => (a.entry.nextAt ?? Infinity) - (b.entry.nextAt ?? Infinity));
  return (
    <aside className="chat-side" aria-label="Details">
      <div className="chat-side-bot">
        <BotAvatar bot={bot} state={face} size={112} animated={face !== "idle"} />
        <strong className="chat-side-name">{bot.name}</strong>
        {bot.role && <small>{bot.role}</small>}
      </div>
      <section className="chat-side-routines" aria-label="Routines">
        <p className="chat-side-label">Routines</p>
        {items.length ? (
          <ul>
            {items.map((i) => {
              const paused = i.entry.enabled === false;
              const body = (
                <>
                  {paused ? <CirclePause size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
                  <span>
                    <strong>{i.entry.name ?? i.entry.prompt}</strong>
                    <small>{paused ? "Paused" : cadenceSummary(i.entry.cadence)}</small>
                  </span>
                </>
              );
              return (
                <li key={i.chat.id + ":" + i.entry.id} className={paused ? "paused" : undefined}>
                  {openRoutines ? <button onClick={() => openRoutines({ id: i.chat.id })}>{body}</button> : <div>{body}</div>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="chat-side-none">No routines yet</p>
        )}
      </section>
      {openBot && (
        <button className="textbutton chat-side-link" onClick={openBot}>
          Bot page
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </aside>
  );
}
