// A bot's Proactive agent (experimental), on the bot's page. One bot looks out for several people
// ("proactive-team-v1"): each has their own alerts, and nobody sees another person's. Nothing runs until the setup
// steps are finished ("Set up"). The owner changes everything; a member whose role manages the bot changes what its
// people share; any other member the bot looks out for changes only their own alerts. The computer checks the same
// (desktop/link/proactive-rules.mjs), and its switch (Settings › Experimental) pauses every bot.
// The phone has the same card (mobile/src/features/bots/BotProactive.tsx), in the same words.
import { useEffect, useState } from "react";
import { personLine, proactiveStanding, WIZARD, type ProactiveViewer } from "../desktop/link/proactive-words.mjs";
import { hasProactiveTeam } from "./AlertActions";
import { useAsk } from "./Pages";
import ProactiveSetup from "./ProactiveSetup";
import { errorText } from "./SettingsRows";
import { memberTeam, teamCan } from "./teamAccess";
import type { Bot, ProactiveBot, ProactiveBotSettings, ProactiveLog, ProactivePatch, ProactivePerson, ProactiveWatch, State } from "./types";
import "./records.css";
import "./access.css";

const api = window.botkins;

export const PROACTIVE_DEFAULTS: ProactiveBotSettings = { enabled: false, setUp: false, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests", "context"], instructions: "", people: {} };
const EVERY = [15, 30, 60, 120];
const SWEEP = [0, 1, 2, 3, 6, 12];
const CAP = [3, 6, 10, 20];
const WATCH: { id: ProactiveWatch; label: string; help: string }[] = [
  { id: "context", label: "Personal context", help: "Wake when goals, memories or your conversations with this bot change." },
  { id: "runs", label: "Failed routines and stopped turns", help: "A run that ended needing you, or stopped with steps left." },
  { id: "tasks", label: "Tasks waiting on you", help: "In Review or Blocked for more than four hours." },
  { id: "requests", label: "Unanswered requests", help: "An approval or question open for more than 15 minutes." },
];
const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));
const OUTCOME = { alerted: "Told you", silent: "Nothing to say", failed: "Failed" } as const;
const REASON = { review: "Planned follow-up", context: "Personal context changed", signals: "Something changed", sweep: "Look around", check: "Check now" } as const;

/** Whether the computer this window uses has per-bot Proactive agents ("proactive-agent-v2"). */
export const hasProactive = (state: State) => !state.remote?.using || !!state.remote.using.capabilities?.includes("proactive-agent-v2");

/** A bot's agent as set, with the usual settings for what it leaves out. */
export const proactiveOf = (entry?: ProactiveBot): ProactiveBotSettings & ProactiveBot => ({ ...PROACTIVE_DEFAULTS, ...entry, people: { ...entry?.people } });

/** Who is looking at this window: "owner", or the member's id, and whether their role manages bots. */
export function proactiveViewer(state: State): ProactiveViewer {
  const member = memberTeam(state);
  return { id: member ? member.me.memberId : "owner", name: member?.me.name, manages: teamCan(state, "agents", "manage") };
}
/** Whether the bot's Proactive card has anything for this person: a role that manages bots, or someone the bot looks out for. */
export const showsProactive = (state: State, bot: Bot) => {
  const viewer = proactiveViewer(state);
  return hasProactive(state) && (viewer.manages || !!state.proactive?.bots[bot.id]?.people?.[viewer.id]);
};

/** The bot page's Proactive card. `setUpNow` opens the setup steps as the card appears (the shell's `proactiveSetup`). */
export default function BotProactive({ state, bot, setUpNow }: { state: State; bot: Bot; setUpNow?: boolean }) {
  const learning = !state.remote?.using || state.remote.using.capabilities?.includes("proactive-learning-v1");
  const teams = hasProactiveTeam(state);
  const entry = state.proactive?.bots[bot.id];
  const p = proactiveOf(entry);
  const viewer = proactiveViewer(state);
  const me = viewer.id;
  const owner = me === "owner";
  const shared = owner || viewer.manages;
  const mine: ProactivePerson | undefined = p.people?.[me];
  const [error, setError] = useState("");
  const dialogs = useAsk();
  const [instructions, setInstructions] = useState(p.instructions);
  useEffect(() => setInstructions(p.instructions), [p.instructions]);
  const [settingUp, setSettingUp] = useState(setUpNow === true && shared && teams);
  const set = (patch: ProactivePatch | null) => {
    setError("");
    void api.setBotProactive(bot.id, patch).catch((e) => setError(errorText(e)));
  };
  const forget = async () => {
    const yes = await dialogs.ask({ title: "Forget " + bot.name + "'s Proactive settings?", body: "This removes everyone's alerts, planned follow-ups and everything it learned from ratings.", confirm: "Forget", danger: true });
    if (yes) set(null);
  };
  const routine = p.chatId ? state.chats.find((c) => c.id === p.chatId) : undefined;
  const description = learning
    ? bot.name + " uses your goals and previous conversations" + (owner ? " and its saved memory" : "") + " to find what you could do next, and offers to take care of it. Rate an alert in your Feed or react with 👍 or 👎 in chat to teach it what helps."
    : bot.name + " checks for changes and tells you what needs your attention.";
  const running = !!p.chatId && state.streams[p.chatId] !== undefined;
  const standing = proactiveStanding(state.proactive, entry, me);
  const paused = standing === "paused";
  const log: ProactiveLog[] = p.log ?? [];
  const watched = p.watch.filter((w) => learning || w !== "context");
  const watches = WATCH.filter((w) => (learning || w.id !== "context") && (owner || w.id !== "tasks"));
  const names = new Map((state.team?.people ?? []).map((person) => [person.id, person.name]));
  const nameOf = (person: string) => (person === me ? "You" : (names.get(person) ?? (person === "owner" ? "Owner" : "A member")));
  const others = Object.entries(p.people ?? {}).filter(([person]) => person !== me);
  const choose = (person: string, value: string) => set({ people: { [person]: value === "remove" ? null : { on: value !== "off", ...(value !== "off" && { notify: value === "notified" }) } } });
  const setup = settingUp && <ProactiveSetup state={state} bot={bot} entry={entry} viewer={viewer} watches={watches} close={() => setSettingUp(false)} />;
  const head = (
    <>
      <h2 id="bot-proactive-title">Proactive</h2>
      <p className="muted">{description}</p>
    </>
  );
  if (!teams)
    return (
      <section className="profile-card" aria-labelledby="bot-proactive-title">
        {head}
        <p className="muted">Update the app on your computer.</p>
      </section>
    );
  if (standing === "setup")
    return (
      <section className="profile-card" aria-labelledby="bot-proactive-title">
        {head}
        <p className="muted">{shared ? WIZARD.waiting : "The owner hasn't set this up yet."}</p>
        <div className="profile-save">
          {shared && (
            <button type="button" className="primary" onClick={() => setSettingUp(true)}>
              {WIZARD.setUp}
            </button>
          )}
          {owner && entry && (
            <button type="button" className="textbutton" onClick={() => void forget()}>
              Forget settings
            </button>
          )}
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {setup}
        {dialogs.node}
      </section>
    );
  return (
    <section className="profile-card" aria-labelledby="bot-proactive-title">
      {head}
      {owner && (
        <label className="switch-row compact">
          <span>
            <strong>Proactive agent</strong>
            <small>{paused ? "Paused: the Proactive agent is off on this computer." : "For everyone " + bot.name + " looks out for."}</small>
          </span>
          <input type="checkbox" role="switch" className="switch" aria-label="Proactive agent" checked={p.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        </label>
      )}
      {!owner && (paused || standing === "off") && <p className="muted">Paused by the owner.</p>}
      {mine ? (
        <>
          <label className="switch-row compact">
            <span>
              <strong>My alerts</strong>
              <small>What {bot.name} finds for you.</small>
            </span>
            <input type="checkbox" role="switch" className="switch" aria-label="My alerts" checked={mine.on} onChange={(e) => set({ people: { [me]: { on: e.target.checked } } })} />
          </label>
          <label className="switch-row compact">
            <span>
              <strong>Notify me</strong>
              <small>Off still delivers alerts, quietly.</small>
            </span>
            <input type="checkbox" role="switch" className="switch" aria-label="Notify me" checked={mine.notify} disabled={!mine.on} onChange={(e) => set({ people: { [me]: { notify: e.target.checked } } })} />
          </label>
        </>
      ) : (
        shared && (
          <label className="switch-row compact">
            <span>
              <strong>Look out for me</strong>
              <small>Your own alerts. Nobody else sees them.</small>
            </span>
            <input type="checkbox" role="switch" className="switch" aria-label="Look out for me" checked={false} onChange={() => set({ people: { [me]: { on: true } } })} />
          </label>
        )
      )}
      {owner && (
        <>
          <h3>Who it looks out for</h3>
          {others.map(([person, own]) => (
            <label key={person}>
              {nameOf(person)}
              <select aria-label={nameOf(person)} value={!own.on ? "off" : own.notify ? "notified" : "quiet"} onChange={(e) => choose(person, e.target.value)}>
                <option value="notified">{personLine({ on: true, notify: true })}</option>
                <option value="quiet">{personLine({ on: true, notify: false })}</option>
                <option value="off">{personLine({ on: false, notify: true })}</option>
                <option value="remove">Remove</option>
              </select>
            </label>
          ))}
          <p className="muted">Each person gets their own alerts. Nobody sees another person's.</p>
          <button type="button" className="secondary" onClick={() => setSettingUp(true)}>
            Add or remove people
          </button>
        </>
      )}
      {shared ? (
        <>
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
          {owner && (
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
            <small>For each person.</small>
          </label>
          <label>
            Alerts go to
            <select value={p.deliver} onChange={(e) => set({ deliver: e.target.value as ProactiveBotSettings["deliver"] })}>
              <option value="chat">{bot.name + "'s chat with each person"}</option>
              <option value="feed">Each person's Feed</option>
            </select>
            <small>{learning && p.deliver === "feed" ? "A shared Feed sends personal suggestions to private chat." : "Quiet hours in Notifications hold it back too."}</small>
          </label>
          <fieldset className="checklist">
            <legend>What Botkins watches</legend>
            {watches.map((w) => (
              <label key={w.id}>
                <input type="checkbox" aria-label={w.label} checked={watched.includes(w.id)} onChange={(e) => set({ watch: e.target.checked ? [...watched, w.id] : watched.filter((x) => x !== w.id) })} />
                <span>
                  {w.label} <small>{w.help}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            Rules
            <textarea rows={3} maxLength={2000} value={instructions} placeholder={WIZARD.rulesPlaceholder} onChange={(e) => setInstructions(e.target.value)} />
            <small>What is worth telling people, and what isn't. Up to 2,000 characters.</small>
          </label>
          <div className="profile-save">
            <button type="button" className="secondary" disabled={instructions.trim() === p.instructions} onClick={() => set({ instructions })}>
              Save rules
            </button>
            {owner && (
              <button type="button" className="textbutton" onClick={() => void forget()}>
                Forget settings
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="muted">
          Set by the owner: checks every {minutes(p.every)}, at most {p.maxPerDay} alerts a day, to {p.deliver === "feed" ? "your Feed" : "your chat"}.
        </p>
      )}
      {!owner && mine && (
        <button type="button" className="textbutton" onClick={() => set(null)}>
          Stop looking out for me
        </button>
      )}
      {p.nextReviewAt && <p className="muted">Planned follow-up · {new Date(p.nextReviewAt).toLocaleString()}</p>}
      {p.learning && p.learning.rated > 0 && (
        <>
          <h3>What helped</h3>
          <p>{p.learning.rated} {p.learning.rated === 1 ? "rated suggestion" : "rated suggestions"}</p>
          {p.learning.preferred.length > 0 && <p>Preferred approaches · {p.learning.preferred.join(", ")}</p>}
          {p.learning.retired.length > 0 && <p>Set aside · {p.learning.retired.join(", ")}</p>}
        </>
      )}
      {routine && (
        <>
          <h3>Recent</h3>
          {log.length ? (
            <ul className="muted">
              {log.slice(0, 5).map((l) => (
                <li key={l.runId}>
                  {new Date(l.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {REASON[l.reason]} · {OUTCOME[l.outcome]}
                  {l.score != null && " · Score " + l.score + "/100"}{l.said ? " · " + l.said : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing yet.</p>
          )}
          <p className="muted">
            Alerts today: {p.pings ?? 0} of {p.maxPerDay}. Its runs are in Routines, as “{routine.title.replace(/^Routine · /, "")}”.
          </p>
          <button type="button" className="secondary" disabled={running || standing !== "on"} onClick={() => void api.runRoutine(routine.id).catch((e) => setError(errorText(e)))}>
            {running ? "Checking…" : "Check now"}
          </button>
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {setup}
      {dialogs.node}
    </section>
  );
}
