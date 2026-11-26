import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
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
import { GlassSegmented } from "./GlisseUI";
import { BotAvatar } from "./Avatar";
import { useAsk, type PageActions } from "./Pages";
import { Choices } from "./Preferences";
import { categories as goalCategories } from "./Board";
import type { Bot, Cadence, Chat, ChatSchedule, ModelChoice, PhoneLink, Run, RoutineDelivery, State } from "./types";
import { BotChips, Folded, WorkBar, WorkNeeds, type WorkNav } from "./WorkBar";
import ModelPicker, { ModelBadge } from "./ModelPicker";
import {
  activeTargetsOnly,
  buildNotifyTargetView,
  countRemovedTargetIds,
  isDeviceChecked,
  normalizeTargets,
  routineNotifyLabel,
  runNotifyChip,
  toggleDeviceTarget,
  togglePersonTarget,
  type NotifyMode,
  type TargetPersonOption,
} from "./notifyTargets";
import { WorkflowsView } from "./Workflows";
import "./routines.css";
import "./workflows.css";

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
      <GlassSegmented
        aria-label="Repeats"
        value={value.kind}
        items={KINDS.filter(([k]) => allowOnce || k !== "once").map(([k, label]) => ({ value: k, label }))}
        onValueChange={(next) => pick(next as Cadence["kind"])}
      />
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
  const [section, setSection] = useState<"routines" | "workflows">("routines");
  const [botFilter, setBotFilter] = useState(initial?.create ? "" : initial?.botId ?? "");
  const [phoneLink, setPhoneLink] = useState<PhoneLink | null>(null);
  const remoteId = state.remote?.using?.id ?? null;
  const phonesRev = state.phones?.revision ?? 0;
  useEffect(() => {
    if (remoteId) {
      setPhoneLink(null);
      return;
    }
    let live = true;
    api
      .phoneLink()
      .then((link) => {
        if (live) setPhoneLink(link);
      })
      .catch(() => {
        if (live) setPhoneLink(null);
      });
    return () => {
      live = false;
    };
  }, [remoteId, phonesRev]);
  const items = routineItems(state);
  if (view.mode === "edit") {
    const item = view.id ? items.find((i) => i.chat.id === view.id) : undefined;
    return (
      <RoutineEditor
        state={state}
        item={item}
        phoneLink={phoneLink}
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
          phoneLink={phoneLink}
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
  const workflowCount = (state.workflows ?? []).length;
  const hasAny = shown.length > 0 || panels.length > 0 || schedules.length > 0;
  return (
    <div className={"page work-page routines" + (section === "workflows" ? " wide" : "")}>
      <WorkBar
        work={work}
        tab="Routines"
        add={section === "routines" ? { label: "New routine", run: () => setView({ mode: "edit", botId: botFilter || undefined }) } : undefined}
        filters={section === "routines" && (owners.length > 1 || botFilter) ? <BotChips bots={owners} value={botFilter} change={setBotFilter} /> : null}
        lede={
          section === "workflows"
            ? "Chain triggers, bots, deterministic conditions, approvals, and outputs on a visual canvas."
            : "Work your bots do on a schedule, each in its own chat."
        }
      />
      <div className="routines-mode-bar">
        <GlassSegmented
          aria-label="Routines view"
          value={section}
          items={[
            { value: "routines", label: "Routines" },
            { value: "workflows", label: workflowCount > 0 ? `Workflows (${workflowCount})` : "Workflows" },
          ]}
          onValueChange={(next) => setSection(next as "routines" | "workflows")}
        />
      </div>
      {section === "workflows" ? (
        <WorkflowsView state={state} fail={actions.fail} webhookPort={phoneLink?.listening ? phoneLink.port : null} />
      ) : (
        <>
          <WorkNeeds state={state} openChat={actions.open} openTask={() => work.go("Tasks")} fail={actions.fail} />
      {!shown.length && (
        <div className={"work-empty" + (hasAny ? " inline" : "")}>
          <span className="icon-tile">
            <CalendarClock size={16} aria-hidden="true" />
          </span>
          <div>
            <strong>{botFilter ? "No routines for this bot" : "No routines yet"}</strong>
            <small>Or ask a bot: “remind me every weekday at 9”.</small>
          </div>
        </div>
      )}
      {groups.map(
        (g) =>
          g.rows.length > 0 && (
            <section key={g.name} className="page-section routine-group" aria-label={g.name}>
              <h2 className="group-label">
                {g.name} · {g.rows.length}
              </h2>
              <div className="group work-avatars">
                <Folded
                  rows={g.rows.map((i) => {
                    const notifyNote =
                      i.entry.deliver?.to !== "none" && (i.entry.notify === false || i.entry.notifyTargets)
                        ? routineNotifyLabel(i.entry, buildNotifyTargetView(state, i.chat.botId, phoneLink))
                        : null;
                    const paused = g.name === "Paused";
                    return (
                      <div className={"group-row routine-row" + (paused ? " paused" : "")} key={i.chat.id}>
                        <button className="routine-open" onClick={() => setView({ mode: "detail", id: i.chat.id })}>
                          {i.bot && <BotAvatar bot={i.bot} size={36} state={i.running ? "thinking" : "idle"} />}
                          <span className="row-main">
                            <span className="row-title">{i.entry.name}</span>
                            <span className="row-sub">
                              {cadenceSummary(i.entry.cadence)} · {i.bot?.name}
                              {deliveryLabel(i.entry.deliver) && " · " + deliveryLabel(i.entry.deliver)}
                              {notifyNote && " · " + notifyNote}
                            </span>
                          </span>
                          <span className="routine-when">
                            <time className={paused ? "paused" : undefined} title={g.name === "Up next" ? "Next run" : g.name === "Finished" ? "Ran" : undefined}>
                              {g.name === "Up next"
                                ? whenLabel(i.entry.nextAt!)
                                : g.name === "Finished"
                                  ? "Ran " + whenLabel(i.entry.finishedAt ?? i.last?.time ?? i.entry.createdAt ?? Date.now())
                                  : "Paused"}
                            </time>
                            <RunChip run={i.last} running={i.running} />
                          </span>
                        </button>
                        <Switch
                          checked={i.entry.enabled !== false}
                          disabled={i.entry.nextAt == null}
                          label={"Enable " + i.entry.name}
                          onChange={(v) => act(api.setRoutineEnabled(i.chat.id, v))}
                        />
                      </div>
                    );
                  })}
                />
              </div>
            </section>
          ),
      )}
      {panels.length > 0 && (
        <section className="page-section routine-group" aria-label="Today panels">
          <h2 className="group-label">Today panels · {panels.length}</h2>
          <div className="group work-avatars">
            <Folded
              rows={panels.map((p) => {
                const bot = state.bots.find((b) => b.id === p.botId);
                const r = p.routine!;
                return (
                  <div className={"group-row routine-row" + (r.enabled ? "" : " paused")} key={p.id}>
                    <button className="routine-open" onClick={openToday}>
                      {bot && <BotAvatar bot={bot} size={36} />}
                      <span className="row-main">
                        <span className="row-title">{p.title}</span>
                        <span className="row-sub">
                          {scheduleSummary({ id: 0, prompt: "", nextAt: r.nextAt, recurring: true, cron: r.cron })} · {r.timezone} · {bot?.name}
                        </span>
                      </span>
                      <span className="routine-when">
                        <time className={r.enabled ? undefined : "paused"} title={r.enabled ? "Next run" : undefined}>
                          {r.enabled ? (r.nextAt ? whenLabel(r.nextAt) : "—") : "Paused"}
                        </time>
                        <span className="run-chip">Open Today</span>
                      </span>
                    </button>
                  </div>
                );
              })}
            />
          </div>
          <p className="group-foot">Change these from each panel on Today.</p>
        </section>
      )}
      {schedules.length > 0 && (
        <section className="page-section routine-group" aria-label="Chat schedules">
          <h2 className="group-label">Chat schedules · {schedules.length}</h2>
          <div className="group work-avatars">
            <Folded
              rows={schedules.map(({ chat, entry }) => {
                const bot = state.bots.find((b) => b.id === chat.botId);
                const paused = entry.enabled === false;
                return (
                  <div className={"group-row routine-row" + (paused ? " paused" : "")} key={chat.id + entry.id}>
                    <button className="routine-open" onClick={() => actions.open(chat.id)}>
                      {bot && <BotAvatar bot={bot} size={36} />}
                      <span className="row-main">
                        <span className="row-title">{entry.prompt}</span>
                        <span className="row-sub">
                          {scheduleSummary(entry)} · {chat.title}
                        </span>
                      </span>
                      <span className="routine-when">
                        <time className={paused ? "paused" : undefined} title={paused ? undefined : "Next run"}>
                          {paused ? "Paused" : entry.nextAt != null ? whenLabel(entry.nextAt) : "—"}
                        </time>
                      </span>
                    </button>
                    <span className="routine-row-actions">
                      <button
                        type="button"
                        className="btn soft small"
                        aria-label={(paused ? "Resume " : "Pause ") + entry.prompt}
                        onClick={() => act(api.changeSchedule(chat.id, entry.id, paused ? "resume" : "pause"))}
                      >
                        {paused ? <Play size={13} /> : <Pause size={13} />}
                        {paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Delete"
                        aria-label={"Delete " + entry.prompt}
                        onClick={() => act(api.changeSchedule(chat.id, entry.id, "delete"))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </span>
                  </div>
                );
              })}
            />
          </div>
          <p className="group-foot">Prompts scheduled in a chat with /every or /after.</p>
        </section>
      )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- detail */

function RoutineDetail({
  state,
  item,
  phoneLink,
  actions,
  back,
  edit,
  show,
}: {
  state: State;
  item: RoutineItem;
  phoneLink: PhoneLink | null;
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
  const targetView = useMemo(() => buildNotifyTargetView(state, chat.botId, phoneLink), [state, chat.botId, phoneLink]);
  const notifyNote =
    entry.deliver?.to !== "none" && (entry.notify === false || entry.notifyTargets)
      ? routineNotifyLabel(entry, targetView)
      : null;
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
  const model = chat.model ?? state.settings.routineModel ?? bot?.model ?? state.settings.model;
  return (
    <div className="page narrow work-page routines routine-detail">
      <div className="work-back">
        <button type="button" className="link-button" onClick={back}>
          <ChevronLeft size={16} aria-hidden="true" />
          All routines
        </button>
      </div>
      <header className="page-head routine-head">
        {bot && <BotAvatar bot={bot} state={item.running ? "thinking" : "idle"} size={56} />}
        <div className="page-heading">
          <h1 className="page-title">{entry.name}</h1>
          <p className="page-sub">
            <span className={"routine-state" + (paused ? " paused" : finished ? "" : " active")}>{paused ? "Paused" : finished ? "Finished" : "Active"}</span> · {bot?.name}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => actions.open(chat.id)}>
            <MessageCircle size={15} aria-hidden="true" />
            Open chat
          </button>
          <button type="button" className="btn" disabled={busy} onClick={edit}>
            <Pencil size={15} aria-hidden="true" />
            Edit
          </button>
          <button type="button" className="btn primary" disabled={busy || item.running} onClick={() => act(() => api.runRoutine(chat.id))}>
            <Zap size={15} aria-hidden="true" />
            Run now
          </button>
        </div>
      </header>
      <section className="page-section" aria-label="Schedule">
        <h2 className="group-label">Schedule</h2>
        <div className="group">
          <div className="group-row">
            <span className="icon-tile">
              <CalendarClock size={16} aria-hidden="true" />
            </span>
            <span className="row-main">
              <span className="row-title wrap">
                {cadenceSummary(entry.cadence)} · {entry.timezone}
              </span>
              <span className="row-sub wrap">
                {[deliveryLabel(entry.deliver) || "Result stays in the routine chat", notifyNote].filter(Boolean).join(" · ")}
              </span>
            </span>
          </div>
          <div className="group-row">
            <span className="icon-tile">
              {item.running ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Zap size={16} aria-hidden="true" />}
            </span>
            <span className="row-main">
              <span className="row-title wrap routine-next">
                {item.running
                  ? "Running now"
                  : paused
                    ? "Paused. Resume to schedule the next run."
                    : finished
                      ? "This one-time routine has run. Edit it to schedule it again."
                      : "Next run " + whenLabel(entry.nextAt!)}
              </span>
            </span>
            <button type="button" className="btn soft small" disabled={busy || finished} onClick={() => act(() => api.setRoutineEnabled(chat.id, paused))}>
              {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
      </section>
      {entry.script && (
        <section className="page-section routine-instructions" aria-label="Script">
          <h2 className="group-label">Script</h2>
          <div className="group padded">
            <pre className="routine-script-text">{entry.script}</pre>
          </div>
        </section>
      )}
      {(!entry.script || entry.followUp) && (
        <section className="page-section routine-instructions" aria-labelledby="routine-instructions-label">
          <h2 className="group-label" id="routine-instructions-label">{entry.script ? "Follow-up action" : "Instructions"}</h2>
          <div className="group">
            <div className="group-row">
              <p className="routine-prompt">{entry.prompt}</p>
            </div>
            <div className="group-row routine-model-line">
              <span className="row-main">
                <span className="row-title">Model</span>
                {!chat.model && <span className="row-sub">The routines default</span>}
              </span>
              <ModelBadge choice={model} size={13} />
            </div>
          </div>
        </section>
      )}
      <section className="page-section routine-group" aria-label="Runs">
        <h2 className="group-label">Runs · {runs.length}</h2>
        <div className="group">
          {runs.length ? (
            <Folded
              limit={8}
              rows={runs.map((r) => {
                const Icon = r.status === "Working" ? LoaderCircle : r.status === "Completed" ? CircleCheck : CircleAlert;
                const tone = r.status === "Working" ? "working" : r.status === "Completed" ? "ok" : "failed";
                const notifyChip = runNotifyChip(r, targetView);
                return (
                  <button className="group-row routine-run" key={r.id} onClick={() => actions.open(chat.id)}>
                    <Icon size={18} className={"run-icon " + tone} aria-hidden="true" />
                    <span className="row-main">
                      <span className="row-title">{whenLabel(r.time)}</span>
                      <span className="row-sub">
                        {r.status === "Needs you" ? "Failed" : r.status}
                        {r.trigger === "manual" ? " · Run now" : " · Scheduled"}
                        {notifyChip ? " · " + notifyChip : ""}
                        {r.detail ? " · " + r.detail : ""}
                      </span>
                    </span>
                    <ChevronRight size={15} className="row-chevron" aria-hidden="true" />
                  </button>
                );
              })}
            />
          ) : (
            <div className="group-row">
              <span className="icon-tile">
                <CalendarClock size={16} aria-hidden="true" />
              </span>
              <span className="row-sub">No runs yet. Use Run now to try it.</span>
            </div>
          )}
        </div>
      </section>
      <section className="page-section" aria-label="More">
        <div className="group">
          <button
            type="button"
            className="group-row"
            disabled={busy || !others.length}
            aria-expanded={copyTo !== null}
            onClick={() => setCopyTo(copyTo === null ? others[0]?.id ?? "" : null)}
          >
            <span className="icon-tile">
              <Copy size={16} aria-hidden="true" />
            </span>
            <span className="row-main">
              <span className="row-title">Duplicate for…</span>
              <span className="row-sub">{others.length ? "Run the same routine with another bot" : "There's no other bot to run it"}</span>
            </span>
          </button>
          {copyTo !== null && (
            <form
              className="group-row routine-copy"
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
              <button className="btn primary small" disabled={busy}>
                Duplicate
              </button>
              <button type="button" className="btn small" onClick={() => setCopyTo(null)}>
                Cancel
              </button>
            </form>
          )}
          <button
            type="button"
            className="group-row routine-delete"
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
            <span className="icon-tile danger-tile">
              <Trash2 size={16} aria-hidden="true" />
            </span>
            <span className="row-main">
              <span className="row-title">Delete…</span>
            </span>
          </button>
        </div>
      </section>
      {dialogs.node}
    </div>
  );
}

/* ------------------------------------------------------------- editor */

function RoutineEditor({
  state,
  item,
  phoneLink,
  botId,
  fail,
  done,
}: {
  state: State;
  item?: RoutineItem;
  phoneLink: PhoneLink | null;
  botId: string;
  fail: (e: unknown) => void;
  done: (id?: string) => void;
}) {
  const [bot, setBot] = useState(item?.chat.botId ?? botId);
  const [name, setName] = useState(item?.entry.name ?? "");
  const [prompt, setPrompt] = useState(item?.entry.prompt ?? "");
  // What runs: the instructions as a bot's turn, or a script with no model ("routine-scripts-v1").
  // A computer this window reaches over the link may be older, and a team member never writes a script.
  const using = state.remote?.using;
  const scriptsAllowed = (!using || !!using.capabilities?.includes("routine-scripts-v1")) && !using?.member;
  const modelsAllowed = !using || !!using.capabilities?.includes("routine-models-v1");
  const [runs, setRuns] = useState<"instructions" | "script">(item?.entry.script ? "script" : "instructions");
  const [script, setScript] = useState(item?.entry.script ?? "");
  const [followUp, setFollowUp] = useState(item?.entry.followUp === true);
  // The routine's own model; undefined uses the Default routines model.
  const [model, setModel] = useState<ModelChoice | undefined>(item?.chat.model);
  const [allowReadyTasks, setAllowReadyTasks] = useState(item?.entry.allowReadyTasks === true);
  const scripted = runs === "script";
  const needsPrompt = !scripted || followUp;
  const botName = state.bots.find((b) => b.id === bot)?.name ?? "the bot";
  const routinesDefault = state.settings.routineModel ?? state.bots.find((b) => b.id === bot)?.model ?? state.settings.model;
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
  // Routine notifications: Everyone, Specific people/devices ("routine-notify-targets-v1"), or Quiet.
  const targetView = useMemo(() => buildNotifyTargetView(state, bot, phoneLink), [state, bot, phoneLink]);
  const [notifyMode, setNotifyMode] = useState<NotifyMode>(() =>
    item?.entry.notify === false ? "quiet" : item?.entry.notifyTargets ? "specific" : "everyone",
  );
  const [targets, setTargets] = useState<{ people: string[]; devices: string[] }>(() => normalizeTargets(item?.entry.notifyTargets));
  const effectiveNotifyMode: NotifyMode = to === "none" ? "quiet" : notifyMode;
  const activeTargets = useMemo(() => activeTargetsOnly(targets, targetView), [targets, targetView]);
  const removedTargetCount = useMemo(() => countRemovedTargetIds(targets, targetView), [targets, targetView]);
  const specificEmpty = targetView.canTarget && effectiveNotifyMode === "specific" && activeTargets.people.length === 0 && activeTargets.devices.length === 0;
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
      className="page narrow work-page routines routine-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (specificEmpty) return;
        setSaving(true);
        try {
          const deliver: RoutineDelivery | null =
            to === "routine" ? null : to === "chat" ? { to, ...(picked && { chatId: picked }) } : to === "goal" ? { to, category } : { to };
          // A model is sent only when it changed, so an edit never waits on the model list for nothing.
          const modelChanged = JSON.stringify(model ?? null) !== JSON.stringify(item?.chat.model ?? null);
          const notify = effectiveNotifyMode !== "quiet";
          const data = {
            name: name.trim(),
            prompt: prompt.trim(),
            cadence,
            timezone: zone.trim(),
            deliver,
            notify,
            ...(targetView.canTarget
              ? { notifyTargets: effectiveNotifyMode === "specific" ? activeTargets : null }
              : {}),
            ...(scripted ? { script, followUp } : item?.entry.script ? { script: null } : {}),
            ...(!using?.member && { allowReadyTasks }),
            ...(modelsAllowed && modelChanged && { model: model ?? null }),
          };
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
      <div className="work-back">
        <button type="button" className="link-button" onClick={() => done()}>
          <ChevronLeft size={16} aria-hidden="true" />
          {item ? "Back to routine" : "All routines"}
        </button>
      </div>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">{item ? "Edit routine" : "New routine"}</h1>
        </div>
      </header>
      {/* The fields in the phone's groups: what it is, what it does, when, and where the result goes. */}
      <section className="page-section" aria-label="Routine">
        <h2 className="group-label">Routine</h2>
        <div className="group padded routine-form">
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
          {(scriptsAllowed || scripted) && (
            <fieldset className="cadence routine-runs">
              <legend>What runs</legend>
              <Choices
                label="What runs"
                value={runs}
                options={[
                  { id: "instructions", name: "Instructions" },
                  { id: "script", name: "Script" },
                ]}
                onChange={setRuns}
              />
              <small className="muted">
                {scripted
                  ? "A script runs on this computer with no model. Turn on a follow-up action to have " + botName + " act on its output."
                  : botName + " follows your instructions in a model turn."}
              </small>
            </fieldset>
          )}
        </div>
      </section>
      <section className="page-section">
        <h2 className="group-label">{scripted ? "Script" : "Instructions"}</h2>
        <div className="group padded routine-form">
          {scripted ? (
            <>
              <label>
                Script
                <textarea
                  className="routine-script"
                  required
                  rows={6}
                  maxLength={20000}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={script}
                  placeholder={"df -h /\nls ~/Downloads | wc -l"}
                  onChange={(e) => setScript(e.target.value)}
                />
                <small className="muted">Runs with your shell in {botName}'s folder. Stops after 10 minutes. The output is kept with the run.</small>
              </label>
              <div className="routine-followup">
                <label className="routine-notify">
                  <input type="checkbox" role="switch" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
                  <span>
                    Follow-up action
                    <small className="muted">After the script, {botName} gets its output and exit code, then follows these instructions.</small>
                  </span>
                </label>
                {followUp && (
                  <>
                    <label>
                      Instructions
                      <textarea
                        required
                        rows={4}
                        maxLength={4000}
                        value={prompt}
                        placeholder={'If the disk is over 90% full, tell me what to clean up. Otherwise reply "All good".'}
                        onChange={(e) => setPrompt(e.target.value)}
                      />
                    </label>
                    <small className="counter" aria-live="off">
                      {prompt.length.toLocaleString()} / 4,000
                    </small>
                    {modelsAllowed && <RoutineModel key={bot} value={model} inherited={routinesDefault} change={setModel} />}
                  </>
                )}
              </div>
            </>
          ) : (
            <>
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
              {modelsAllowed && <RoutineModel key={bot} value={model} inherited={routinesDefault} change={setModel} />}
            </>
          )}
        </div>
      </section>
      <section className="page-section" aria-label="Schedule">
        <h2 className="group-label">Schedule</h2>
        <div className="group padded routine-form">
          <CadencePicker value={cadence} onChange={setCadence} />
          <ZoneInput value={zone} onChange={setZone} />
          <p className={"routine-preview" + (preview.error ? " danger" : "")} role="status">
            <CalendarClock size={15} />
            {cadenceSummary(cadence)}
            {preview.text ? " · " + preview.text : ""}
          </p>
        </div>
      </section>
      <section className="page-section" aria-label="Result">
        <h2 className="group-label">Result</h2>
        <div className="group padded routine-form">
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
          {targetView.canTarget ? (
            <fieldset className="cadence routine-notify-fieldset" disabled={to === "none"}>
              <legend>Notifications</legend>
              <Choices
                label="Notifications"
                value={effectiveNotifyMode}
                options={[
                  { id: "everyone", name: "Everyone" },
                  { id: "specific", name: "Specific" },
                  { id: "quiet", name: "Quiet" },
                ]}
                onChange={(mode) => setNotifyMode(mode)}
              />
              <small className="muted">
                {to === "none"
                  ? "No-output routines never publish or notify."
                  : effectiveNotifyMode === "everyone"
                    ? "Alerts everyone who can see the routine, wherever notifications are on."
                    : effectiveNotifyMode === "quiet"
                      ? "This routine runs quietly. Its result still goes where you chose."
                      : "Choose which people or individual devices receive alerts when a run finishes."}
              </small>
              {to !== "none" && effectiveNotifyMode === "specific" && (
                <NotifyTargetPicker
                  people={targetView.people}
                  targets={targets}
                  removedCount={removedTargetCount}
                  empty={specificEmpty}
                  onTogglePerson={(person) => setTargets((prev) => togglePersonTarget(prev, person))}
                  onToggleDevice={(person, deviceId) => setTargets((prev) => toggleDeviceTarget(prev, person, deviceId))}
                />
              )}
            </fieldset>
          ) : (
            <label className="routine-notify">
              <input
                type="checkbox"
                role="switch"
                checked={effectiveNotifyMode !== "quiet"}
                disabled={to === "none"}
                onChange={(e) => setNotifyMode(e.target.checked ? "everyone" : "quiet")}
              />
              <span>
                Notify me when a run finishes
                <small className="muted">
                  {to === "none"
                    ? "No-output routines never publish or notify."
                    : effectiveNotifyMode !== "quiet"
                      ? "On this computer and on your phone, where notifications are on."
                      : "This routine runs quietly. Its result still goes where you chose."}
                </small>
              </span>
            </label>
          )}
          {!using?.member && (
            <label className="routine-notify">
              <input
                type="checkbox"
                role="switch"
                checked={allowReadyTasks}
                onChange={(e) => setAllowReadyTasks(e.target.checked)}
              />
              <span>
                Allow creating Ready tasks
                <small className="muted">
                  Let this routine create Ready tasks assigned to a bot so follow-up work starts automatically. Otherwise routine-created tasks wait in Later.
                </small>
              </span>
            </label>
          )}
        </div>
      </section>
      <p className="group-foot routine-cost">
          {scripted ? (followUp ? "The script runs without a model. The follow-up uses one model turn." : "The script runs without a model.") : "Each run uses one model turn."} Botkins keeps running when you close its window.
        </p>
      <div className="routine-save">
        <button type="button" className="btn" onClick={() => done()}>
          Cancel
        </button>
        <button className="btn primary" disabled={saving || specificEmpty || !name.trim() || (needsPrompt && !prompt.trim()) || (scripted && !script.trim())}>
          {saving ? "Saving…" : item ? "Save routine" : "Create routine"}
        </button>
      </div>
    </form>
  );
}

function NotifyTargetPicker({
  people,
  targets,
  removedCount,
  empty,
  onTogglePerson,
  onToggleDevice,
}: {
  people: TargetPersonOption[];
  targets: { people: string[]; devices: string[] };
  removedCount: number;
  empty: boolean;
  onTogglePerson: (person: TargetPersonOption) => void;
  onToggleDevice: (person: TargetPersonOption, deviceId: string) => void;
}) {
  return (
    <div className="routine-target-picker" role="group" aria-label="Notification recipients">
      {removedCount > 0 && (
        <p className="routine-target-note" role="status">
          {removedCount === 1
            ? "1 removed person or device is skipped. Saving cleans it up."
            : `${removedCount} removed people or devices are skipped. Saving cleans them up.`}
        </p>
      )}
      {people.map((person) => {
        const allChecked = targets.people.includes(person.id);
        const someDevicesChecked = !allChecked && person.devices.some((d) => targets.devices.includes(d.id));
        return (
          <div className="routine-target-group" key={person.id}>
            <label className="routine-target-row routine-target-person">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someDevicesChecked;
                }}
                onChange={() => onTogglePerson(person)}
              />
              <span className="routine-target-label">
                <strong>{person.name}</strong>
                {person.isMe && <span className="routine-target-tag">You</span>}
                {!person.isMe && person.isOwner && <span className="routine-target-tag">Owner</span>}
                {person.devices.length > 0 && <small className="muted">All devices</small>}
              </span>
            </label>
            {person.devices.length > 0 && (
              <div className="routine-target-devices">
                {person.devices.map((device) => (
                  <label className="routine-target-row routine-target-device" key={device.id}>
                    <input
                      type="checkbox"
                      checked={isDeviceChecked(targets, person, device.id)}
                      onChange={() => onToggleDevice(person, device.id)}
                    />
                    <span className="routine-target-label">
                      <span>{device.name}</span>
                      {!device.canNotify && (
                        <span className="routine-target-pill">
                          {device.kind === "host" ? "Alerts off" : "Push off"}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {empty && (
        <p className="routine-target-error" role="alert">
          Choose at least one person or device, or switch to Quiet.
        </p>
      )}
    </div>
  );
}

/** A routine's model and thinking, with the app's own picker; the choice is saved with the routine. */
function RoutineModel({ value, inherited, change }: { value?: ModelChoice; inherited?: ModelChoice; change: (choice: ModelChoice | undefined) => void }) {
  return (
    <div className="routine-model">
      <ModelPicker scope="routine" id={null} value={value} inherited={inherited} onChange={change} />
    </div>
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
