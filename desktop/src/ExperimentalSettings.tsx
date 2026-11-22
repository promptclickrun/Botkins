import { useEffect, useState } from "react";
import type { Bot, Preferences, ProactiveSettings, ProactiveWatch, State } from "./types";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";

const api = window.botkins;

const DEFAULTS: ProactiveSettings = { enabled: false, botId: null, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests"], instructions: "" };
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

/** Settings › Experimental: features that are new and may change. */
export default function ExperimentalSettings({ state, bots, settings, change }: { state: State; bots: Bot[]; settings: Preferences; change: (patch: { proactive: Partial<ProactiveSettings> }) => Promise<void> }) {
  const p = { ...DEFAULTS, ...settings.proactive };
  const [error, setError] = useState("");
  const [instructions, setInstructions] = useState(p.instructions);
  useEffect(() => setInstructions(p.instructions), [p.instructions]);
  const set = (patch: Partial<ProactiveSettings>) => {
    setError("");
    void change({ proactive: patch }).catch((e) => setError(errorText(e)));
  };
  const chatId = state.proactive?.chatId;
  const routine = chatId ? state.chats.find((c) => c.id === chatId) : undefined;
  const running = !!chatId && state.streams[chatId] !== undefined;
  const log = state.proactive?.log ?? [];
  const bot = bots.find((b) => b.id === p.botId);
  return (
    <>
      <p className="set-status">These are new. They may change or go away, and they can use your model more than you expect.</p>
      <Group
        title="Proactive agent"
        footer="A bot that tells you what you need to know before you ask. Botkins checks for changes with no model, and wakes the bot only when something changed or a look around is due. The bot reads and drafts only: it never sends, posts, buys or deletes on its own."
      >
        <Row label="Bot" help="Its tools decide what it can look at: your inbox, calendar and messages come from the apps and MCP servers it has.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={p.botId ?? ""} onChange={(e) => set(e.target.value ? { botId: e.target.value } : { enabled: false, botId: null })}>
              <option value="">Choose a bot</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </Row>
        <SwitchRow label="Proactive agent" help={p.botId ? undefined : "Choose a bot first."} checked={p.enabled} disabled={!p.botId} onChange={(enabled) => set({ enabled })} />
        <Row label="Check for changes" help="How often Botkins looks. A check with nothing new uses no model.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={p.every} onChange={(e) => set({ every: Number(e.target.value) })}>
              {EVERY.map((m) => (
                <option key={m} value={m}>
                  Every {minutes(m)}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Look around" help="Wakes the bot to check its own sources even when Botkins saw no change. Each look uses the model.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={p.sweepHours} onChange={(e) => set({ sweepHours: Number(e.target.value) })}>
              {SWEEP.map((h) => (
                <option key={h} value={h}>
                  {h ? "Every " + minutes(h * 60) : "Never"}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Most alerts a day">
          {(id) => (
            <select id={id} value={p.maxPerDay} onChange={(e) => set({ maxPerDay: Number(e.target.value) })}>
              {CAP.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Alerts go to" help="Quiet hours in Notifications hold it back too.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={p.deliver} onChange={(e) => set({ deliver: e.target.value as ProactiveSettings["deliver"] })}>
              <option value="chat">{(bot?.name ?? "The bot") + "'s chat with you"}</option>
              <option value="feed">Your Feed</option>
            </select>
          )}
        </Row>
      </Group>
      <Group title="What Botkins watches" footer="Each change wakes the bot once.">
        {WATCH.map((w) => (
          <SwitchRow key={w.id} label={w.label} help={w.help} checked={p.watch.includes(w.id)} onChange={(on) => set({ watch: on ? [...p.watch, w.id] : p.watch.filter((x) => x !== w.id) })} />
        ))}
      </Group>
      <Group
        title="Your rules"
        footer="What is worth telling you, and what isn't. Up to 2,000 characters."
        actions={
          <button type="button" disabled={instructions.trim() === p.instructions} onClick={() => set({ instructions })}>
            Save
          </button>
        }
      >
        <Row label="Instructions" stacked>
          {(id) => <textarea id={id} rows={4} maxLength={2000} value={instructions} placeholder="Tell me about anything from my manager the same day. Skip newsletters." onChange={(e) => setInstructions(e.target.value)} />}
        </Row>
      </Group>
      {routine && (
        <Group
          title="Recent"
          footer={"Alerts today: " + (state.proactive?.pings ?? 0) + " of " + p.maxPerDay + ". Its runs are in Routines, as “Proactive agent”."}
          actions={
            <button type="button" disabled={running} onClick={() => void api.runRoutine(routine.id).catch((e) => setError(errorText(e)))}>
              {running ? "Checking…" : "Check now"}
            </button>
          }
        >
          {log.length ? (
            log.slice(0, 8).map((l) => <ValueRow key={l.runId} label={new Date(l.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) + " · " + REASON[l.reason]} value={OUTCOME[l.outcome]} help={l.said} />)
          ) : (
            <ValueRow label="Nothing yet" value="—" />
          )}
        </Group>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
