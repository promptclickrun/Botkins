import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Copy,
  LoaderCircle,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import { useAsk, type PageActions } from "./Pages";
import { Choices } from "./Preferences";
import { categories as goalCategories } from "./Board";
import type { Bot, Cadence, Chat, ChatSchedule, Run, RoutineDelivery, State } from "./types";
import { WorkBar, type WorkNav } from "./WorkBar";
import "./routines.css";

const api = window.botkins;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ------------------------------------------------------------- cadence */

function clock(time: string) {
  const [h, m] = time.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Weekdays at 9:00 AM". Mirrors describeCadence in desktop/routines.mjs. */
export function cadenceSummary(c?: Cadence) {
  switch (c?.kind) {
    case "once":
      return "Once on " + new Date(c.date + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + " at " + clock(c.time);
    case "daily":
      return "Daily at " + clock(c.time);
    case "weekdays":
      return "Weekdays at " + clock(c.time);
    case "weekly":
      return (c.days.length === 7 ? "Every day" : "Weekly on " + c.days.map((d) => DAY_LABELS[d]).join(", ")) + " at " + clock(c.time);
    case "custom":
      return "Custom · " + c.cron;
    default:
      return "Scheduled";
  }
}

function every(ms: number) {
  const units: [number, string][] = [
    [86400000, "day"],
    [3600000, "hour"],
    [60000, "minute"],
    [1000, "second"],
  ];
  const [size, name] = units.find(([u]) => ms % u === 0 && ms >= u) ?? [1000, "second"];
  const n = Math.round(ms / size);
  return "Every " + (n === 1 ? name : n + " " + name + "s");
}

/** A summary for any chat schedule: routines by cadence, /every entries by interval or cron. */
export function scheduleSummary(s: ChatSchedule) {
  if (s.cadence) return cadenceSummary(s.cadence);
  const c = s.cron && cadenceFromCron(s.cron);
  if (c && c.kind !== "custom") return cadenceSummary(c);
  if (s.cron) return "Cron · " + s.cron;
  if (s.recurring && s.intervalMs) return every(s.intervalMs);
  return "Once";
}

/** Reads a cron string back into the picker when it is one of the simple shapes. */
export function cadenceFromCron(cron: string): Cadence {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(cron.trim().replace(/\s+/g, " "));
  if (!m || +m[1] > 59 || +m[2] > 23) return { kind: "custom", cron };
  const time = m[2].padStart(2, "0") + ":" + m[1].padStart(2, "0");
  if (m[3] === "*") return { kind: "daily", time };
  if (m[3] === "1-5") return { kind: "weekdays", time };
  return { kind: "weekly", time, days: [...new Set(m[3].split(",").map(Number))].sort() };
}

/** Panel routines need cron; this is the same compile the desktop uses. */
export function cronFromCadence(c: Cadence) {
  if (c.kind === "custom") return c.cron.trim();
  if (c.kind === "once") throw new Error("Panel routines repeat. Choose Daily, Weekdays, Weekly or Custom.");
  const [h, m] = c.time.split(":").map(Number);
  return m + " " + h + " * * " + (c.kind === "weekly" ? c.days.join(",") : c.kind === "daily" ? "*" : "1-5");
}

const pad = (n: number) => String(n).padStart(2, "0");
function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

const KINDS: [Cadence["kind"], string][] = [
  ["once", "Once"],
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["custom", "Custom"],
];

/** Once, Daily, Weekdays, Weekly or Custom. Switching keeps the time. */
export function CadencePicker({
  value,
  onChange,
  allowOnce = true,
}: {
  value: Cadence;
  onChange: (c: Cadence) => void;
  allowOnce?: boolean;
}) {
  const time = "time" in value ? value.time : "09:00";
  const pick = (kind: Cadence["kind"]) => {
    if (kind === value.kind) return;
    if (kind === "once") onChange({ kind, date: tomorrow(), time });
    else if (kind === "weekly") onChange({ kind, time, days: [new Date().getDay()] });
    else if (kind === "custom") onChange({ kind, cron: value.kind === "once" ? "0 9 * * *" : cronFromCadence(value) });
    else onChange({ kind, time });
  };
  return (
    <fieldset className="cadence">
      <legend>Repeats</legend>
      <div className="segmented" role="radiogroup" aria-label="Repeats">
        {KINDS.filter(([k]) => allowOnce || k !== "once").map(([k, label]) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={value.kind === k}
            onClick={() => pick(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {value.kind === "weekly" && (
        <div className="daypicker" role="group" aria-label="Days">
          {DAY_LABELS.map((d, i) => (
            <button
              type="button"
              key={d}
              aria-pressed={value.days.includes(i)}
              aria-label={d}
              onClick={() => {
                const days = value.days.includes(i) ? value.days.filter((x) => x !== i) : [...value.days, i].sort();
                if (days.length) onChange({ ...value, days });
              }}
            >
              {d.slice(0, 2)}
            </button>
          ))}
        </div>
      )}
      <div className="cadence-fields">
        {value.kind === "once" && (
          <label>
            Date
            <input type="date" required value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
          </label>
        )}
        {value.kind !== "custom" ? (
          <label>
            Time
            <input type="time" required value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
          </label>
        ) : (
          <label className="wide">
            Cron schedule
            <input
              required
              value={value.cron}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
              onChange={(e) => onChange({ kind: "custom", cron: e.target.value })}
            />
            <small>Minute · hour · day of month · month · weekday</small>
          </label>
        )}
      </div>
    </fieldset>
  );
}

const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();
export function ZoneInput({ value, onChange }: { value: string; onChange: (z: string) => void }) {
  return (
    <label>
      Time zone
      <input list="routine-zones" required value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <datalist id="routine-zones">
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </label>
  );
}

/* ------------------------------------------------------------- destination */

type Destination = RoutineDelivery["to"];
const DESTINATIONS: { id: Destination; name: string; note: string }[] = [
  { id: "none", name: "No output", note: "The routine does its work quietly and publishes no reply or notification." },
  { id: "routine", name: "Routine chat", note: "Results stay in this routine's chat." },
  { id: "chat", name: "Chat with the bot", note: "Also sent as an unread message from the bot." },
  { id: "feed", name: "Feed", note: "Also posted to Feed on Today." },
  { id: "idea", name: "Ideas", note: "Also posted to Ideas on Today." },
  { id: "goal", name: "Goals", note: "Also posted to Goals on Today." },
];

/** A few words for where a routine's result goes, or "" for its own chat. */
export function deliveryLabel(d?: RoutineDelivery) {
  const to = d?.to;
  if (!to || to === "routine") return "";
  if (to === "none") return "No output";
  return "Result to " + { chat: "chat", feed: "Feed", idea: "Ideas", goal: "Goals" }[to];
}

/** A bot's chats that can take a routine's result: its own ordinary chats, not routine, group or panel chats. */
function deliveryChats(state: State, botId: string) {
  return state.chats
    .filter((c) => c.botId === botId && !c.botIds && !c.panelId && !c.archived && !c.schedules?.some((s) => s.routine))
    .sort((a, b) => b.time - a.time);
}

/* ------------------------------------------------------------- model */

export type RoutineItem = { chat: Chat; entry: ChatSchedule; bot?: Bot; last?: Run; running: boolean };

export function routineItems(state: State, botId?: string): RoutineItem[] {
  const items: RoutineItem[] = [];
  for (const chat of state.chats)
    for (const entry of chat.schedules ?? [])
      if (entry.routine && (!botId || chat.botId === botId))
        items.push({
          chat,
          entry,
          bot: state.bots.find((b) => b.id === chat.botId),
          last: state.runs.find((r) => r.chatId === chat.id && r.scheduleId === entry.id),
          running: state.streams[chat.id] !== undefined,
        });
  return items;
}
const group = (e: ChatSchedule) => (e.enabled === false ? "Paused" : e.nextAt == null ? "Finished" : "Up next");

/** Every enabled routine and chat schedule with a next run, soonest first. Work lists these as Upcoming. */
export function upcomingRuns(state: State) {
  const out: { chat: Chat; entry: ChatSchedule; bot?: Bot; at: number }[] = [];
  for (const chat of state.chats)
    for (const entry of chat.schedules ?? [])
      if (entry.enabled !== false && entry.nextAt != null)
        out.push({ chat, entry, bot: state.bots.find((b) => b.id === chat.botId), at: entry.nextAt });
  return out.sort((a, b) => a.at - b.at);
}

/** "Today, 9:00 AM", "Tomorrow, 9:00 AM" or "Wed, Nov 18, 9:00 AM". */
export function whenLabel(t: number) {
  const d = new Date(t),
    today = new Date();
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86400000,
  );
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (dayDiff === 0) return "Today, " + time;
  if (dayDiff === 1) return "Tomorrow, " + time;
  if (dayDiff === -1) return "Yesterday, " + time;
  return (
    d.toLocaleDateString(undefined, {
      weekday: Math.abs(dayDiff) < 7 ? "short" : undefined,
      month: "short",
      day: "numeric",
      year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
    }) +
    ", " +
    time
  );
}

function RunChip({ run, running }: { run?: Run; running?: boolean }) {
  if (running || run?.status === "Working")
    return (
      <span className="run-chip working">
        <LoaderCircle size={12} /> Running
      </span>
    );
  if (!run) return <span className="run-chip">No runs yet</span>;
  const ok = run.status === "Completed";
  return (
    <span className={"run-chip " + (ok ? "ok" : "failed")} title={run.detail || undefined}>
      {ok ? <CircleCheck size={12} /> : <CircleAlert size={12} />}
      {ok ? "Last run done" : run.status === "Needs you" ? "Last run failed" : "Last run " + run.status.toLowerCase()}
    </span>
  );
}

function Switch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch" title={disabled ? undefined : checked ? "Pause" : "Resume"}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

/* ------------------------------------------------------------- page */

type View = { mode: "list" } | { mode: "detail"; id: string } | { mode: "edit"; id?: string; botId?: string };

export default function RoutinesPage({
  state,
  actions,
  initial,
  work,
  openToday,
}: {
  state: State;
  actions: PageActions;
  /** Opens a routine, or the editor for a bot, when the page is reached from elsewhere. */
  initial?: { id?: string; botId?: string; create?: boolean };
  /** Work's tabs and tools, shown above the list. */
  work: WorkNav;
  openToday: () => void;
}) {
  const [view, setView] = useState<View>(
    initial?.create ? { mode: "edit", botId: initial.botId } : initial?.id ? { mode: "detail", id: initial.id } : { mode: "list" },
  );
  const [botFilter, setBotFilter] = useState(initial?.create ? "" : initial?.botId ?? "");
  const items = routineItems(state);
  if (view.mode === "edit") {
    const item = view.id ? items.find((i) => i.chat.id === view.id) : undefined;
    return (
      <RoutineEditor
        state={state}
        item={item}
        botId={view.botId ?? (botFilter || state.bots[0].id)}
        fail={actions.fail}
        done={(id) => setView(id ? { mode: "detail", id } : item ? { mode: "detail", id: item.chat.id } : { mode: "list" })}
      />
    );
  }
  if (view.mode === "detail") {
    const item = items.find((i) => i.chat.id === view.id);
    if (item)
      return (
        <RoutineDetail
          state={state}
          item={item}
          actions={actions}
          back={() => setView({ mode: "list" })}
          edit={() => setView({ mode: "edit", id: item.chat.id })}
          show={(id) => setView({ mode: "detail", id })}
        />
      );
  }
  const shown = items.filter((i) => !botFilter || i.chat.botId === botFilter);
  const groups = (["Up next", "Paused", "Finished"] as const).map((name) => ({
    name,
    rows: shown
      .filter((i) => group(i.entry) === name)
      .sort((a, b) =>
        name === "Up next"
          ? a.entry.nextAt! - b.entry.nextAt!
          : (b.entry.finishedAt ?? b.entry.createdAt ?? 0) - (a.entry.finishedAt ?? a.entry.createdAt ?? 0),
      ),
  }));
  const panels = state.panels.filter((p) => p.routine && (!botFilter || p.botId === botFilter));
  const schedules = state.chats.flatMap((chat) =>
    (chat.schedules ?? []).filter((s) => !s.routine && (!botFilter || chat.botId === botFilter)).map((entry) => ({ chat, entry })),
  );
  const owners = state.bots.filter((b) => items.some((i) => i.chat.botId === b.id) || b.id === botFilter);
  const act = (p: Promise<unknown>) => void p.catch(actions.fail);
  return (
    <div className="routines">
      <WorkBar work={work} tab="Routines" add={{ label: "New routine", run: () => setView({ mode: "edit", botId: botFilter || undefined }) }} />
      <p className="muted routines-lede">Work your bots do on a schedule, each in its own chat.</p>
      {owners.length > 1 || botFilter ? (
        <div className="filters chips" role="group" aria-label="Filter by bot">
          <button aria-pressed={!botFilter} onClick={() => setBotFilter("")}>
            All bots
          </button>
          {owners.map((b) => (
            <button key={b.id} aria-pressed={botFilter === b.id} onClick={() => setBotFilter(b.id)}>
              {b.name}
            </button>
          ))}
        </div>
      ) : null}
      {!shown.length && (
        <div className="empty routines-empty">
          <CalendarClock />
          <div>
            <strong>{botFilter ? "No routines for this bot" : "No routines yet"}</strong>
            <small>Or ask a bot: “remind me every weekday at 9”.</small>
          </div>
        </div>
      )}
      {groups.map(
        (g) =>
          g.rows.length > 0 && (
            <section key={g.name} className="routine-group" aria-label={g.name}>
              <h2>
                {g.name} <small>{g.rows.length}</small>
              </h2>
              {g.rows.map((i) => (
                <div className="routine-row" key={i.chat.id}>
                  <button className="routine-open" onClick={() => setView({ mode: "detail", id: i.chat.id })}>
                    {i.bot && <BotAvatar bot={i.bot} size={38} />}
                    <span className="rowtext">
                      <strong>{i.entry.name}</strong>
                      <small>
                        {cadenceSummary(i.entry.cadence)} · {i.bot?.name}
                        {deliveryLabel(i.entry.deliver) && " · " + deliveryLabel(i.entry.deliver)}
                        {i.entry.notify === false && " · Quiet"}
                      </small>
                    </span>
                    <span className="routine-when">
                      <small className={g.name === "Paused" ? "paused" : undefined}>
                        {g.name === "Up next" ? "Next" : g.name === "Paused" ? "Paused" : "Ran"}
                      </small>
                      <time>
                        {g.name === "Up next"
                          ? whenLabel(i.entry.nextAt!)
                          : g.name === "Finished"
                            ? whenLabel(i.entry.finishedAt ?? i.last?.time ?? i.entry.createdAt ?? Date.now())
                            : "—"}
                      </time>
                    </span>
                    <RunChip run={i.last} running={i.running} />
                  </button>
                  <Switch
                    checked={i.entry.enabled !== false}
                    disabled={i.entry.nextAt == null}
                    label={"Enable " + i.entry.name}
                    onChange={(v) => act(api.setRoutineEnabled(i.chat.id, v))}
                  />
                </div>
              ))}
            </section>
          ),
      )}
      {panels.length > 0 && (
        <section className="routine-group" aria-label="Today panels">
          <h2>
            Today panels <small>{panels.length}</small>
          </h2>
          <p className="muted">Change these from each panel on Today.</p>
          {panels.map((p) => {
            const bot = state.bots.find((b) => b.id === p.botId);
            const r = p.routine!;
            return (
              <div className="routine-row" key={p.id}>
                <button className="routine-open" onClick={openToday}>
                  {bot && <BotAvatar bot={bot} size={38} />}
                  <span className="rowtext">
                    <strong>{p.title}</strong>
                    <small>
                      {scheduleSummary({ id: 0, prompt: "", nextAt: r.nextAt, recurring: true, cron: r.cron })} · {r.timezone} · {bot?.name}
                    </small>
                  </span>
                  <span className="routine-when">
                    <small className={r.enabled ? undefined : "paused"}>{r.enabled ? "Next" : "Paused"}</small>
                    <time>{r.enabled && r.nextAt ? whenLabel(r.nextAt) : "—"}</time>
                  </span>
                  <span className="run-chip">Open Today</span>
                </button>
              </div>
            );
          })}
        </section>
      )}
      {schedules.length > 0 && (
        <section className="routine-group" aria-label="Chat schedules">
          <h2>
            Chat schedules <small>{schedules.length}</small>
          </h2>
          <p className="muted">Prompts scheduled in a chat with /every or /after.</p>
          {schedules.map(({ chat, entry }) => {
            const bot = state.bots.find((b) => b.id === chat.botId);
            const paused = entry.enabled === false;
            return (
              <div className="routine-row" key={chat.id + entry.id}>
                <button className="routine-open" onClick={() => actions.open(chat.id)}>
                  {bot && <BotAvatar bot={bot} size={38} />}
                  <span className="rowtext">
                    <strong>{entry.prompt}</strong>
                    <small>
                      {scheduleSummary(entry)} · {chat.title}
                    </small>
                  </span>
                  <span className="routine-when">
                    <small className={paused ? "paused" : undefined}>{paused ? "Paused" : "Next"}</small>
                    <time>{!paused && entry.nextAt != null ? whenLabel(entry.nextAt) : "—"}</time>
                  </span>
                </button>
                <span className="routine-row-actions">
                  <button
                    className="secondary"
                    aria-label={(paused ? "Resume " : "Pause ") + entry.prompt}
                    onClick={() => act(api.changeSchedule(chat.id, entry.id, paused ? "resume" : "pause"))}
                  >
                    {paused ? <Play size={13} /> : <Pause size={13} />}
                    {paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    className="secondary danger"
                    aria-label={"Delete " + entry.prompt}
                    onClick={() => act(api.changeSchedule(chat.id, entry.id, "delete"))}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- detail */

function RoutineDetail({
  state,
  item,
  actions,
  back,
  edit,
  show,
}: {
  state: State;
  item: RoutineItem;
  actions: PageActions;
  back: () => void;
  edit: () => void;
  show: (id: string) => void;
}) {
  const { chat, entry, bot } = item;
  const dialogs = useAsk();
  const [copyTo, setCopyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runs = state.runs.filter((r) => r.chatId === chat.id && r.scheduleId === entry.id);
  const paused = entry.enabled === false,
    finished = entry.nextAt == null;
  const others = state.bots.filter((b) => b.id !== chat.botId);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      actions.fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="routines routine-detail">
      <button className="textbutton profile-back" onClick={back}>
        <ArrowLeft size={15} />
        All routines
      </button>
      <section className="routine-hero">
        {bot && <BotAvatar bot={bot} state={item.running ? "thinking" : "idle"} size={64} />}
        <div>
          <span className="routine-state">
            <span className={paused ? "paused" : undefined}>{paused ? "Paused" : finished ? "Finished" : "Active"}</span> · {bot?.name}
          </span>
          <h1>{entry.name}</h1>
          <p className="muted">
            {cadenceSummary(entry.cadence)} · {entry.timezone}
            {deliveryLabel(entry.deliver) && " · " + deliveryLabel(entry.deliver)}
            {entry.notify === false && " · Quiet"}
          </p>
          <p className="routine-next">
            {item.running
              ? "Running now"
              : paused
                ? "Paused. Resume to schedule the next run."
                : finished
                  ? "This one-time routine has run. Edit it to schedule it again."
                  : "Next run " + whenLabel(entry.nextAt!)}
          </p>
        </div>
      </section>
      <div className="actionrow routine-actions">
        <button className="primary" disabled={busy || item.running} onClick={() => act(() => api.runRoutine(chat.id))}>
          <Zap size={15} />
          Run now
        </button>
        <button disabled={busy || finished} onClick={() => act(() => api.setRoutineEnabled(chat.id, paused))}>
          {paused ? <Play size={15} /> : <Pause size={15} />}
          {paused ? "Resume" : "Pause"}
        </button>
        <button disabled={busy} onClick={edit}>
          <Pencil size={15} />
          Edit
        </button>
        <button disabled={busy || !others.length} aria-expanded={copyTo !== null} onClick={() => setCopyTo(copyTo === null ? others[0]?.id ?? "" : null)}>
          <Copy size={15} />
          Duplicate for…
        </button>
        <button onClick={() => actions.open(chat.id)}>
          <MessageCircle size={15} />
          Open chat
        </button>
        <button
          className="danger"
          disabled={busy || item.running}
          onClick={() =>
            act(async () => {
              const ok = await dialogs.ask({
                title: "Delete " + entry.name + "?",
                body:
                  "This stops the routine and deletes its chat" +
                  (runs.length ? " and " + runs.length + (runs.length === 1 ? " run" : " runs") : "") +
                  ". You can't undo this.",
                confirm: "Delete routine",
                danger: true,
              });
              if (ok) {
                await api.deleteRoutine(chat.id);
                back();
              }
            })
          }
        >
          <Trash2 size={15} />
          Delete…
        </button>
      </div>
      {copyTo !== null && (
        <form
          className="routine-copy"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => show(await api.duplicateRoutine(chat.id, copyTo)));
          }}
        >
          <label>
            Duplicate for
            <select value={copyTo} onChange={(e) => setCopyTo(e.target.value)}>
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy}>
            Duplicate
          </button>
          <button type="button" className="secondary" onClick={() => setCopyTo(null)}>
            Cancel
          </button>
        </form>
      )}
      <section className="profile-card routine-instructions">
        <h2>Instructions</h2>
        <p>{entry.prompt}</p>
      </section>
      <section className="routine-group" aria-label="Runs">
        <h2>
          Runs <small>{runs.length}</small>
        </h2>
        {runs.length ? (
          runs.map((r) => {
            const Icon = r.status === "Working" ? LoaderCircle : r.status === "Completed" ? CircleCheck : CircleAlert;
            return (
              <button className="row" key={r.id} onClick={() => actions.open(chat.id)}>
                <Icon size={19} className={r.status === "Needs you" || r.status === "Interrupted" ? "danger" : undefined} />
                <span className="rowtext">
                  <strong>{whenLabel(r.time)}</strong>
                  <small>
                    {r.status === "Needs you" ? "Failed" : r.status}
                    {r.trigger === "manual" ? " · Run now" : " · Scheduled"}
                    {r.detail ? " · " + r.detail : ""}
                  </small>
                </span>
              </button>
            );
          })
        ) : (
          <div className="empty">
            <CalendarClock />
            <small>No runs yet. Use Run now to try it.</small>
          </div>
        )}
      </section>
      {dialogs.node}
    </div>
  );
}

/* ------------------------------------------------------------- editor */

function RoutineEditor({
  state,
  item,
  botId,
  fail,
  done,
}: {
  state: State;
  item?: RoutineItem;
  botId: string;
  fail: (e: unknown) => void;
  done: (id?: string) => void;
}) {
  const [bot, setBot] = useState(item?.chat.botId ?? botId);
  const [name, setName] = useState(item?.entry.name ?? "");
  const [prompt, setPrompt] = useState(item?.entry.prompt ?? "");
  const [cadence, setCadence] = useState<Cadence>(item?.entry.cadence ?? { kind: "weekdays", time: "09:00" });
  const [zone, setZone] = useState(item?.entry.timezone ?? localZone());
  const noOutputAllowed = !state.remote?.using || state.remote.using.capabilities?.includes("routine-no-output-v1");
  // New desktop routines are quiet by default. A saved routine without deliver is the
  // historical routine-chat default and must remain that way when it is edited.
  const [to, setTo] = useState<Destination>(item ? (item.entry.deliver?.to ?? "routine") : noOutputAllowed ? "none" : "routine");
  // Keep a saved silent choice visible even when an older remote host no longer
  // advertises the capability. New silent choices remain gated by that host.
  const destinations = noOutputAllowed || to === "none" ? DESTINATIONS : DESTINATIONS.filter((destination) => destination.id !== "none");
  // A chat chosen earlier that has since gone falls back to the latest chat.
  const [chatId, setChatId] = useState(item?.entry.deliver?.chatId ?? "");
  const [category, setCategory] = useState(item?.entry.deliver?.category ?? "other");
  // A routine notifies when a run finishes unless it was told to run quietly.
  const [notify, setNotify] = useState(item?.entry.notify !== false);
  const chats = deliveryChats(state, bot);
  const picked = chats.some((c) => c.id === chatId) ? chatId : "";
  const [preview, setPreview] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [saving, setSaving] = useState(false);
  const key = useMemo(() => JSON.stringify([cadence, zone]), [cadence, zone]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .previewCadence(cadence, zone)
        .then((p) => live && setPreview({ text: "Next run " + whenLabel(p.nextAt) }))
        .catch((e) => live && setPreview({ text: String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), error: true }));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return (
    <form
      className="routines routine-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          const deliver: RoutineDelivery | null =
            to === "routine" ? null : to === "chat" ? { to, ...(picked && { chatId: picked }) } : to === "goal" ? { to, category } : { to };
          const data = { name: name.trim(), prompt: prompt.trim(), cadence, timezone: zone.trim(), deliver, notify: to === "none" ? false : notify };
          if (item) {
            await api.updateRoutine(item.chat.id, data);
            done();
          } else done(await api.createRoutine({ botId: bot, ...data }));
        } catch (err) {
          fail(err);
        } finally {
          setSaving(false);
        }
      }}
    >
      <button type="button" className="textbutton profile-back" onClick={() => done()}>
        <ArrowLeft size={15} />
        {item ? "Back to routine" : "All routines"}
      </button>
      <h1>{item ? "Edit routine" : "New routine"}</h1>
      <div className="profile-card routine-form">
        <label>
          Bot
          <select value={bot} disabled={!!item} onChange={(e) => setBot(e.target.value)}>
            {state.bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {item && <small>To run it with another bot, use Duplicate for….</small>}
        </label>
        <label>
          Name
          <input required maxLength={80} value={name} placeholder="Morning inbox check" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Instructions
          <textarea
            required
            rows={5}
            maxLength={4000}
            value={prompt}
            placeholder="Summarize anything new in my inbox and remind me of today's deadlines."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <small className="counter" aria-live="off">
          {prompt.length.toLocaleString()} / 4,000
        </small>
        <CadencePicker value={cadence} onChange={setCadence} />
        <ZoneInput value={zone} onChange={setZone} />
        <fieldset className="cadence routine-deliver">
          <legend>Send result to</legend>
          <Choices label="Send result to" value={to} options={destinations} onChange={setTo} />
          {to === "chat" && chats.length > 1 && (
            <label className="routine-deliver-field">
              Chat
              <select value={picked} onChange={(e) => setChatId(e.target.value)}>
                <option value="">Latest chat</option>
                {chats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {to === "goal" && (
            <label className="routine-deliver-field">
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {goalCategories.map((c) => (
                  <option key={c} value={c}>
                    {c[0].toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <small className="muted">{destinations.find((d) => d.id === to)?.note}</small>
        </fieldset>
        <label className="routine-notify">
          <input type="checkbox" role="switch" checked={to === "none" ? false : notify} disabled={to === "none"} onChange={(e) => setNotify(e.target.checked)} />
          <span>
            Notify me when a run finishes
            <small className="muted">{to === "none" ? "No-output routines never publish or notify." : notify ? "On this computer and on your phone, where notifications are on." : "This routine runs quietly. Its result still goes where you chose."}</small>
          </span>
        </label>
        <p className={"routine-preview" + (preview.error ? " danger" : "")} role="status">
          <CalendarClock size={15} />
          {cadenceSummary(cadence)}
          {preview.text ? " · " + preview.text : ""}
        </p>
        <p className="muted">Each run uses one model turn. Botkins keeps running when you close its window.</p>
        <div className="profile-save">
          <button className="primary" disabled={saving || !name.trim() || !prompt.trim()}>
            {saving ? "Saving…" : item ? "Save routine" : "Create routine"}
          </button>
          <button type="button" className="secondary" onClick={() => done()}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- bot page */

/** The Routines card on a bot page. */
export function BotRoutines({ state, bot, open }: { state: State; bot: Bot; open: (target: { id?: string; botId?: string; create?: boolean }) => void }) {
  const items = routineItems(state, bot.id).sort((a, b) => (a.entry.nextAt ?? Infinity) - (b.entry.nextAt ?? Infinity));
  return (
    <section className="profile-card bot-routines">
      <div className="sectionhead">
        <h2>Routines</h2>
        <button className="textbutton" onClick={() => open({ botId: bot.id, create: true })}>
          <Plus size={14} />
          New routine
        </button>
      </div>
      {items.length ? (
        <>
          {items.slice(0, 4).map((i) => (
            <button key={i.chat.id} className="bot-routine" onClick={() => open({ id: i.chat.id })}>
              <CalendarClock size={15} />
              <span className="rowtext">
                <strong>{i.entry.name}</strong>
                <small>
                  {cadenceSummary(i.entry.cadence)}
                  {i.entry.enabled === false ? " · Paused" : i.entry.nextAt == null ? " · Finished" : ""}
                </small>
              </span>
            </button>
          ))}
          {items.length > 4 && (
            <button className="secondary" onClick={() => open({ botId: bot.id })}>
              See all {items.length} routines
            </button>
          )}
        </>
      ) : (
        <p className="muted">No routines. Ask {bot.name} to do something on a schedule, or create one.</p>
      )}
    </section>
  );
}
