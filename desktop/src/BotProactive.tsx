// A bot's Proactive agent (experimental): one switch and its settings, on the bot's page. Any bot may have one,
// the computer's switch (Settings › Experimental) pauses them all, and a team member whose role manages the bot
// sets their own from a window that is connected to the computer (desktop/proactive.mjs says whose it is).
// The phone has the same card (mobile/src/features/bots/BotProactive.tsx), in the same words.
import { useEffect, useState } from "react";
import { useAsk } from "./Pages";
import { errorText } from "./SettingsRows";
import { memberTeam } from "./teamAccess";
import type { Bot, ProactiveBot, ProactiveBotSettings, ProactiveLog, ProactiveWatch, State } from "./types";
import "./records.css";
import "./access.css";

const api = window.botkins;

export const PROACTIVE_DEFAULTS: ProactiveBotSettings = { enabled: false, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests"], instructions: "" };
const EVERY = [15, 30, 60, 120];
const SWEEP = [0, 1, 2, 3, 6, 12];
const CAP = [3, 6, 10, 20];
const WATCH: { id: ProactiveWatch; label: string; help: string }[] = [
  { id: "runs", label: "Failed routines and tasks", help: "A routine or task run that ended needing you." },
  { id: "tasks", label: "Tasks waiting on you", help: "In Review or Blocked for more than four hours." },
  { id: "requests", label: "Unanswered requests", help: "An approval or question open for more than 15 minutes." },
];
const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));
const OUTCOME = { alerted: "Told you", silent: "Nothing to say", failed: "Failed" } as const;
const REASON = { signals: "Something changed", sweep: "Look around", check: "Check now" } as const;

/** Whether the computer this window uses has per-bot Proactive agents ("proactive-agent-v2"). */
export const hasProactive = (state: State) => !state.remote?.using || !!state.remote.using.capabilities?.includes("proactive-agent-v2");

/** A bot's agent as set, with the usual settings for what it leaves out. */
export const proactiveOf = (entry?: ProactiveBot): ProactiveBotSettings & ProactiveBot => ({ ...PROACTIVE_DEFAULTS, ...entry });

/** The bot page's Proactive card. */
export default function BotProactive({ state, bot }: { state: State; bot: Bot }) {
  const entry = state.proactive?.bots[bot.id];
  const p = proactiveOf(entry);
  // A member's agent never looks around the computer's own accounts, and tasks are the owner's.
  const member = !!memberTeam(state) || state.remote?.using?.member === true;
  const [error, setError] = useState("");
  const dialogs = useAsk();
  const [instructions, setInstructions] = useState(p.instructions);
  useEffect(() => setInstructions(p.instructions), [p.instructions]);
  const set = (patch: Partial<ProactiveBotSettings> | null) => {
    setError("");
    void api.setBotProactive(bot.id, patch).catch((e) => setError(errorText(e)));
  };
  const turnOn = async () => {
    const yes = await dialogs.ask({
      title: "Turn on the Proactive agent for " + bot.name + "?",
      body: bot.name + " wakes on its own" + (member ? " and reads what Botkins tells it about your chats" : ", reads what its tools reach (such as your inbox and calendar)") + ", and messages you, with nobody watching. Each wake uses the model.",
      confirm: "Turn on",
    });
    if (yes) set({ enabled: true });
  };
  const forget = async () => {
    const yes = await dialogs.ask({ title: "Forget " + bot.name + "'s Proactive settings?", body: "Its routine and what it already told you are removed too.", confirm: "Forget", danger: true });
    if (yes) set(null);
  };
  const routine = p.chatId ? state.chats.find((c) => c.id === p.chatId) : undefined;
  const running = !!p.chatId && state.streams[p.chatId] !== undefined;
  const paused = p.enabled && state.proactive?.enabled !== true;
  const log: ProactiveLog[] = p.log ?? [];
  const watches = WATCH.filter((w) => !member || w.id !== "tasks");
  return (
    <section className="profile-card" aria-labelledby="bot-proactive-title">
      <h2 id="bot-proactive-title">Proactive</h2>
      <p className="muted">
        {bot.name} tells you what you need to know before you ask. Botkins checks for changes with no model, and wakes {bot.name} only when something changed{member ? "" : " or a look around is due"}. It reads and drafts only: it never sends, posts, buys or deletes on its own.
      </p>
      {entry?.taken ? (
        <p className="muted">Another person has set up a Proactive agent for this bot.</p>
      ) : (
        <>
          <label className="switch-row compact">
            <span>
              <strong>Proactive agent</strong>
              <small>
                {paused
                  ? "Paused: the owner has the Proactive agent off on this computer."
                  : p.person && p.person !== "owner" && !entry?.mine
                    ? "Set up by a team member: its alerts go to them."
                    : "Its alerts go to " + (p.deliver === "feed" ? "your Feed." : "its chat with you.")}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              aria-label="Proactive agent"
              checked={p.enabled}
              onChange={(e) => (e.target.checked ? turnOn() : set({ enabled: false }))}
            />
          </label>
          <label>
            Check for changes
            <select value={p.every} onChange={(e) => set({ every: Number(e.target.value) })}>
              {EVERY.map((m) => (
                <option key={m} value={m}>
                  Every {minutes(m)}
                </option>
              ))}
            </select>
          </label>
          {!member && (
            <label>
              Look around
              <select value={p.sweepHours} onChange={(e) => set({ sweepHours: Number(e.target.value) })}>
                {SWEEP.map((h) => (
                  <option key={h} value={h}>
                    {h ? "Every " + minutes(h * 60) : "Never"}
                  </option>
                ))}
              </select>
              <small>Wakes it to check its own sources even when Botkins saw no change. Each look uses the model.</small>
            </label>
          )}
          <label>
            Most alerts a day
            <select value={p.maxPerDay} onChange={(e) => set({ maxPerDay: Number(e.target.value) })}>
              {CAP.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Alerts go to
            <select value={p.deliver} onChange={(e) => set({ deliver: e.target.value as ProactiveBotSettings["deliver"] })}>
              <option value="chat">{bot.name + "'s chat with you"}</option>
              <option value="feed">Your Feed</option>
            </select>
            <small>Quiet hours in Notifications hold it back too.</small>
          </label>
          <fieldset className="checklist">
            <legend>What Botkins watches</legend>
            {watches.map((w) => (
              <label key={w.id}>
                <input type="checkbox" aria-label={w.label} checked={p.watch.includes(w.id)} onChange={(e) => set({ watch: e.target.checked ? [...p.watch, w.id] : p.watch.filter((x) => x !== w.id) })} />
                <span>
                  {w.label} <small>{w.help}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            Your rules
            <textarea rows={3} maxLength={2000} value={instructions} placeholder="Tell me about anything from my manager the same day. Skip newsletters." onChange={(e) => setInstructions(e.target.value)} />
            <small>What is worth telling you, and what isn't. Up to 2,000 characters.</small>
          </label>
          <div className="profile-save">
            <button type="button" className="secondary" disabled={instructions.trim() === p.instructions} onClick={() => set({ instructions })}>
              Save rules
            </button>
            {entry && (
              <button type="button" className="textbutton" onClick={() => void forget()}>
                Forget settings
              </button>
            )}
          </div>
          {routine && (
            <>
              <h3>Recent</h3>
              {log.length ? (
                <ul className="muted">
                  {log.slice(0, 5).map((l) => (
                    <li key={l.runId}>
                      {new Date(l.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {REASON[l.reason]} · {OUTCOME[l.outcome]}
                      {l.said ? ": " + l.said : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing yet.</p>
              )}
              <p className="muted">
                Alerts today: {p.pings ?? 0} of {p.maxPerDay}. Its runs are in Routines, as “Proactive agent”.
              </p>
              <button type="button" className="secondary" disabled={running || !p.enabled || paused} onClick={() => void api.runRoutine(routine.id).catch((e) => setError(errorText(e)))}>
                {running ? "Checking…" : "Check now"}
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {dialogs.node}
    </section>
  );
}
