import AlertActions, { hasProactiveTeam } from "./AlertActions";
import { useState } from "react";
import { Check, ExternalLink, MessageCircle, Moon, Sparkles, Target, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { RichText } from "./RichText";
import type { BoardItem, State } from "./types";
import "./board.css";

type Kind = BoardItem["kind"];
const tabs: { kind: Kind; label: string; empty: string; ask: string }[] = [
  {
    kind: "feed",
    label: "Feed",
    empty: "Nothing yet. Ask a bot for posts.",
    ask: "Post a few things to my Today feed that you think I'd find useful right now. Use board_post.",
  },
  {
    kind: "idea",
    label: "Ideas",
    empty: "No ideas yet. Ask a bot for some.",
    ask: "Suggest a few ideas on my Today board for things I could do this week. Use board_post with kind idea.",
  },
  {
    kind: "goal",
    label: "Goals",
    empty: "No goals yet. Set one with a bot.",
    ask: "Help me set two or three goals and add them to my Today board with board_post and kind goal. Ask me what matters first.",
  },
];
const reasons = ["Not relevant", "Too frequent", "Already knew", "Wrong timing"];
export const categories = ["health", "relationships", "finance", "career", "interests", "productivity", "other"];
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  return h < 24 ? h + "h" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Today's Feed, Ideas and Goals: what bots post, newest first, with the person's answers. */
export default function BoardPanel({
  state,
  startChat,
  fail,
  cards,
  only,
}: {
  state: State;
  /** A space's cards (spaces.read). Left out, the cards of Today's board. */
  cards?: BoardItem[];
  /** A Feed, Ideas or Goals space shows its one kind, without the tabs. */
  only?: Kind;
  /** Opens a new chat with the bot. `send` sends the text; otherwise it waits in the composer. */
  /** Starts a chat with a bot. With `item`, the message carries that Today item, and the chat shows a card for it. */
  startChat: (botId: string, text: string, send: boolean, item?: BoardItem) => Promise<void>;
  fail: (e: unknown) => void;
}) {
  const [picked, setKind] = useState<Kind>("feed");
  const kind = only ?? picked;
  const board = cards ?? state.board ?? [];
  const [openId, setOpenId] = useState("");
  const [finished, setFinished] = useState(false);
  const [why, setWhy] = useState("");
  const now = Date.now();
  const items = board.filter(
    (i) => i.kind === kind && (finished ? i.status !== "open" : i.status === "open" && !((i.snoozedUntil ?? 0) > now)),
  );
  const counts = Object.fromEntries(
    tabs.map((t) => [
      t.kind,
      board.filter((i) => i.kind === t.kind && i.status === "open" && !((i.snoozedUntil ?? 0) > now) && !i.read)
        .length,
    ]),
  );
  const tab = tabs.find((t) => t.kind === kind)!;
  const primary = state.bots[0];
  const act = (id: string, action: Parameters<typeof window.botkins.boardAct>[1], value?: string) => window.botkins.boardAct(id, action, value).catch(fail);
  function toggle(item: BoardItem) {
    setWhy("");
    setOpenId(openId === item.id ? "" : item.id);
    if (!item.read) void act(item.id, "read");
  }
  return (
    <section className="live-panel today-panel wide board-panel" aria-label={only ? tab.label : "Feed, Ideas and Goals"}>
      <div className="board-head">
        {only ? <span /> : <div className="chip-row board-tabs" role="tablist" aria-label="Board">
          {tabs.map((t) => (
            <button
              key={t.kind}
              role="tab"
              className="chip"
              aria-selected={kind === t.kind}
              aria-pressed={kind === t.kind}
              onClick={() => {
                setKind(t.kind);
                setOpenId("");
              }}
            >
              {t.label}
              {!!counts[t.kind] && <span className="board-count">{counts[t.kind]}</span>}
            </button>
          ))}
        </div>}
        <button className="link-button board-finished" aria-pressed={finished} onClick={() => setFinished(!finished)}>
          {finished ? "Show open" : "Show finished"}
        </button>
      </div>
      {!items.length ? (
        <div className="board-empty">
          <p>{finished ? "Nothing finished yet." : tab.empty}</p>
          {!finished && (
            <button className="link-button" onClick={() => startChat(primary.id, tab.ask, false).catch(fail)}>
              <Sparkles size={15} /> Ask {primary.name}
            </button>
          )}
        </div>
      ) : (
        <ul className="board-list">
          {items.slice(0, 30).map((item) => {
            const bot = state.bots.find((b) => b.id === item.botId);
            if (!bot) return null;
            const open = openId === item.id;
            return (
              <li key={item.id} className={"board-item" + (open ? " open" : "")}>
                <button className="board-row" aria-expanded={open} onClick={() => toggle(item)}>
                  <BotAvatar bot={bot} size={34} />
                  <span className="board-text">
                    <small>
                      {bot.name}
                      {item.kind === "goal" && item.category ? " · " + item.category : ""}
                      {item.source ? " · " + item.source : ""}
                      {item.answer === "yes" ? " · Said yes" : item.answer === "goal" ? " · Became a goal" : ""}
                      {item.status === "done" && item.kind === "goal" ? " · Done" : ""}
                    </small>
                    <strong>{item.title}</strong>
                    {!open && item.body && <span className="board-preview">{item.body}</span>}
                  </span>
                  <time>{ago(item.createdAt)}</time>
                  {!item.read && <i className="board-unread" aria-label="Unread" />}
                </button>
                {open && (
                  <div className="board-detail">
                    {item.body && (
                      <div className="panel-prose">
                        <RichText text={item.body} />
                      </div>
                    )}
                    {!!item.links?.length && (
                      <div className="board-links">
                        {item.links.map((l) => (
                          <button key={l.url} className="textbutton" onClick={() => window.botkins.openLink(l.url).catch(fail)}>
                            <ExternalLink size={14} /> {l.title}
                          </button>
                        ))}
                      </div>
                    )}
                    {item.status !== "open" ? (
                      <div className="actionrow">
                        <button onClick={() => act(item.id, "reopen")}>Reopen</button>
                        <button onClick={() => act(item.id, "delete")}>Delete</button>
                      </div>
                    ) : (
                      <div className="actionrow">
                        {item.kind === "idea" ? (
                          <>
                            <button
                              className="primary"
                              onClick={() =>
                                startChat(bot.id, "Let's do it!", true, item)
                                  .then(() => act(item.id, "yes"))
                                  .catch(fail)
                              }
                            >
                              <Check size={15} /> Let's do it
                            </button>
                            <label className="board-select">
                              <Target size={15} />
                              <select
                                aria-label="Turn into a goal"
                                value=""
                                onChange={(e) => e.target.value && act(item.id, "goal", e.target.value)}
                              >
                                <option value="">Turn into a goal…</option>
                                {categories.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button onClick={() => act(item.id, "clear")}>
                              <X size={15} /> Not now
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="primary"
                              onClick={() => startChat(bot.id, "Let's talk about this.", false, item).catch(fail)}
                            >
                              <MessageCircle size={15} /> Discuss
                            </button>
                            {item.kind === "goal" ? (
                              <>
                                <button onClick={() => act(item.id, "done")}>
                                  <Check size={15} /> Mark done
                                </button>
                                <button onClick={() => act(item.id, "notToday")}>
                                  <Moon size={15} /> Not today
                                </button>
                              </>
                            ) : (
                              <button onClick={() => act(item.id, "clear")}>
                                <X size={15} /> Clear
                              </button>
                            )}
                          </>
                        )}
                        <span className="board-rate">
                          <button
                            aria-label="More like this"
                            aria-pressed={item.rating === "up"}
                            onClick={() => act(item.id, "up")}
                          >
                            <ThumbsUp size={15} />
                          </button>
                          <button
                            aria-label="Less like this"
                            aria-pressed={item.rating === "down"}
                            onClick={() => setWhy(why === item.id ? "" : item.id)}
                          >
                            <ThumbsDown size={15} />
                          </button>
                        </span>
                      </div>
                    )}
                    {/* A proactive alert: what the bot offers to do, and "Not now". The ratings above teach it what helps. */}
                    {item.status === "open" && hasProactiveTeam(state) && <AlertActions botId={item.botId} alert={item.alert} />}
                    {why === item.id && (
                      <div className="board-why" role="group" aria-label="Less like this because">
                        <small>Less like this because…</small>
                        {reasons.map((r) => (
                          <button
                            key={r}
                            onClick={() => {
                              setWhy("");
                              void act(item.id, "down", r);
                            }}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
