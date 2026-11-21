import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Ellipsis,
  EyeOff,
  FolderKanban,
  LayoutDashboard,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { RichText } from "./RichText";
import HtmlFrame from "./HtmlFrame";
import "./blocks.css";
import "./board.css";
import { BotAvatar } from "./Avatar";
import type { Cadence, Panel, PanelBlock, State, ShownPanel } from "./types";
import { CadencePicker, ZoneInput, cadenceFromCron, cadenceSummary, cronFromCadence } from "./Routines";
const api = window.botkins;
const stamp = (n: number) =>
  new Date(n).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export function Block({ block, title }: { block: PanelBlock; title?: string }) {
  switch (block.type) {
    case "html":
      return <HtmlFrame frame={block.frame} height={block.height} title={title} />;
    case "markdown":
      return (
        <div className="panel-prose">
          <RichText text={block.text} />
        </div>
      );
    case "metric":
      return (
        <div className="metric">
          <small>{block.label}</small>
          <strong>{block.value}</strong>
          {block.note && <small>{block.note}</small>}
        </div>
      );
    case "list":
      return (
        <ul>
          {block.items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="panel-table">
          <table>
            <thead>
              <tr>
                {block.columns.map((s, i) => (
                  <th key={i} scope="col">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((s, j) => (
                    <td key={j}>{s}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "bars": {
      const max = Math.max(1, ...block.items.map((b) => b.value));
      return (
        <figure className="bars">
          <figcaption>{block.label}</figcaption>
          {block.items.map((b, i) => (
            <div key={i}>
              <span>{b.label}</span>
              <i>
                <i style={{ width: (b.value / max) * 100 + "%" }} />
              </i>
              <b>{b.value.toLocaleString()}</b>
            </div>
          ))}
        </figure>
      );
    }
    case "progress":
      return (
        <div className="block-progress">
          <span>
            <small>{block.label}</small>
            <b>{Math.round((block.value / block.max) * 100)}%</b>
          </span>
          <i role="progressbar" aria-label={block.label} aria-valuenow={block.value} aria-valuemin={0} aria-valuemax={block.max}>
            <i style={{ width: (block.value / block.max) * 100 + "%" }} />
          </i>
          {block.note && <small>{block.note}</small>}
        </div>
      );
    case "badges":
      return (
        <div className="block-badges">
          {block.items.map((b, i) => (
            <span key={i} className={"badge tone-" + b.tone}>
              {b.label}
            </span>
          ))}
        </div>
      );
    case "line":
      return <LineChart block={block} />;
  }
}
// Line colors follow the theme: the action color first, then the status colors.
const seriesColors = ["var(--accent)", "var(--info)", "var(--success)", "var(--warning)", "var(--danger)", "var(--muted)"];
function LineChart({ block }: { block: Extract<PanelBlock, { type: "line" }> }) {
  const all = block.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const w = 320, h = 120, n = Math.max(1, block.labels.length - 1);
  const x = (i: number) => (i / n) * w;
  const y = (v: number) => h - ((v - lo) / (hi - lo || 1)) * h;
  return (
    <figure className="block-line">
      <figcaption>{block.label}</figcaption>
      <svg viewBox={`-4 -6 ${w + 8} ${h + 12}`} role="img" aria-label={block.label + ": " + block.series.map((s) => s.name).join(", ")}>
        <line x1={0} x2={w} y1={y(lo)} y2={y(lo)} className="axis" />
        {block.series.map((s, k) => (
          <polyline
            key={k}
            fill="none"
            stroke={seriesColors[k % seriesColors.length]}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={s.values.map((v, i) => x(i) + "," + y(v)).join(" ")}
          />
        ))}
      </svg>
      <div className="line-axis">
        <small>{block.labels[0]}</small>
        <small>{block.labels.at(-1)}</small>
      </div>
      {block.series.length > 1 && (
        <div className="line-legend">
          {block.series.map((s, k) => (
            <small key={k}>
              <i style={{ background: seriesColors[k % seriesColors.length] }} />
              {s.name}
            </small>
          ))}
        </div>
      )}
    </figure>
  );
}
function RoutineForm({ panel, done }: { panel: ShownPanel; done: () => void }) {
  const [cadence, setCadence] = useState<Cadence>(() =>
    cadenceFromCron(panel.routine?.cron || "0 9 * * 1-5"),
  );
  const [zone, setZone] = useState(
    panel.routine?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [prompt, setPrompt] = useState(
    panel.routine?.prompt || "Refresh this panel from its original sources.",
  );
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.routine(panel.id, {
            action: "set",
            cron: cronFromCadence(cadence),
            timezone: zone,
            prompt,
          });
          done();
        } catch (e) {
          setError(String(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <CadencePicker value={cadence} onChange={setCadence} allowOnce={false} />
      <ZoneInput value={zone} onChange={setZone} />
      <label>
        Refresh instructions
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          maxLength={4000}
        />
      </label>
      <p className="muted">Each refresh uses one model turn, even with the window closed.</p>
      {error && <p role="alert">{error}</p>}
      <button disabled={saving} className="primary">
        Save routine
      </button>
    </form>
  );
}
/**
 * One panel on a grid: its bot, its title, its blocks and its footer. The Today page and every space
 * draw panels with it. Without `manage` there is no ⋯; with `readOnly` there is no Refresh either.
 */
export function PanelCard({
  state,
  panel: p,
  manage,
  fail,
  readOnly,
  badges,
  foot,
  side,
  when = stamp,
}: {
  state: State;
  panel: ShownPanel;
  manage?: () => void;
  fail: (e: unknown) => void;
  readOnly?: boolean;
  /** Shown after the bot's name (a space's App badge and changed dot). */
  badges?: ReactNode;
  /** More quiet lines in the footer (a space's last line). */
  foot?: ReactNode;
  /** Beside Refresh (a space's note count). */
  side?: ReactNode;
  /** How the footer writes a time. */
  when?: (time: number) => string;
}) {
  const bot = state.bots.find((b) => b.id === p.botId);
  if (!bot) return null;
  const busy = !!p.refreshChatId && p.refreshChatId in state.streams;
  return (
    <section className={"live-panel today-panel " + p.size} aria-label={p.title}>
      <div className="panel-top">
        <BotAvatar bot={bot} state={busy ? "thinking" : "idle"} size={24} />
        <small>{bot.name}</small>
        {badges}
        {p.projectId && state.projects?.some((x) => x.id === p.projectId) && (
          <span className="panel-project" title="Project">
            <FolderKanban size={11} />
            {state.projects.find((x) => x.id === p.projectId)!.name}
          </span>
        )}
        {manage && (
          <button aria-label={"Manage " + p.title} onClick={manage}>
            <Ellipsis size={17} />
          </button>
        )}
      </div>
      <h2>{p.title}</h2>
      <div className="panel-blocks">
        {p.blocks.map((b, i) => (
          <Block key={b.type === "html" ? b.frame : i} block={b} title={p.title} />
        ))}
      </div>
      <footer>
        <div>
          <small>{busy ? "Refreshing…" : "Updated " + when(p.updatedAt)}</small>
          {p.routine && (
            <small>
              <Clock3 size={12} /> {p.routine.enabled && p.routine.nextAt ? "Next " + when(p.routine.nextAt) : "Routine paused"}
            </small>
          )}
          {p.lastCheck && (
            <small title={p.lastCheck.detail}>
              Last check · {when(p.lastCheck.time)} · {p.lastCheck.status}
            </small>
          )}
          {foot}
        </div>
        {side}
        {!readOnly && (
          <button aria-label={"Refresh " + p.title} disabled={busy} onClick={() => api.refreshPanel(p.id).catch(fail)}>
            <RefreshCw size={16} />
          </button>
        )}
      </footer>
    </section>
  );
}

/**
 * A panel's ⋯: its chats, size, order, routine, hiding and removing, in one dialog. `where` names the
 * page it hides from ("Today", or a space's name).
 */
export function usePanelManager(panels: ShownPanel[], open: (id: string) => void, where = "Today") {
  const [view, setView] = useState<"manage" | "schedule" | "remove" | null>(null);
  const [selected, select] = useState("");
  const [err, setErr] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = panels.find((p) => p.id === selected);
  useEffect(() => {
    setErr("");
    if (view) dialog.current?.showModal();
    else dialog.current?.close();
  }, [view]);
  async function change(action: string) {
    try {
      await api.changePanel(selected, action);
      setView(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  const node = (
    <dialog ref={dialog} onCancel={() => setView(null)}>
      <div className="sectionhead">
        <h2>{view === "schedule" ? "Panel routine" : view === "remove" ? "Remove panel?" : panel?.title || "Panel"}</h2>
        <button aria-label="Close dialog" onClick={() => setView(null)}>
          <X size={18} />
        </button>
      </div>
      {view === "manage" && panel && (
        <div className="panel-settings">
          {panel.chatId && (
            <button
              onClick={() => {
                if (panel.chatId) open(panel.chatId);
                setView(null);
              }}
            >
              Open original chat <ArrowRight size={15} />
            </button>
          )}
          {panel.refreshChatId && (
            <button
              onClick={() => {
                open(panel.refreshChatId!);
                setView(null);
              }}
            >
              Open refresh history <ArrowRight size={15} />
            </button>
          )}
          <label>
            Panel size
            <select value={panel.size} onChange={(e) => api.changePanel(panel.id, e.target.value).catch((e) => setErr(String(e)))}>
              <option value="small">Small</option>
              <option value="wide">Wide</option>
              <option value="tall">Tall</option>
            </select>
          </label>
          <div className="actionrow">
            <button onClick={() => change("earlier")}>
              <ChevronLeft size={15} />
              Earlier
            </button>
            <button onClick={() => change("later")}>
              Later
              <ChevronRight size={15} />
            </button>
          </div>
          <button onClick={() => setView("schedule")}>
            <CalendarClock size={16} />
            {panel.routine ? "Edit routine" : "Set a routine"}
          </button>
          {panel.routine && (
            <>
              <small>
                {cadenceSummary(cadenceFromCron(panel.routine.cron))} · {panel.routine.timezone}
              </small>
              <button
                onClick={() =>
                  api.routine(panel.id, { action: panel.routine!.enabled ? "pause" : "resume" }).catch((e) => setErr(String(e)))
                }
              >
                {panel.routine.enabled ? "Pause routine" : "Resume routine"}
              </button>
              <button onClick={() => api.routine(panel.id, { action: "remove" }).catch((e) => setErr(String(e)))}>
                Remove routine
              </button>
            </>
          )}
          <button onClick={() => change(panel.hidden ? "show" : "hide")}>
            <EyeOff size={16} />
            {panel.hidden ? "Show on " + where : "Hide from " + where}
          </button>
          <button className="danger" onClick={() => setView("remove")}>
            Remove panel
          </button>
        </div>
      )}
      {view === "schedule" && panel && <RoutineForm panel={panel} done={() => setView(null)} />}
      {view === "remove" && panel && (
        <>
          <p>Remove {panel.title} and its refresh routine?</p>
          <button className="primary" onClick={() => change("delete")}>
            Remove panel and routine
          </button>
        </>
      )}
      {err && <p role="alert">{err}</p>}
    </dialog>
  );
  return {
    manage: (id: string) => {
      select(id);
      setView("manage");
    },
    node,
  };
}

export default function Today({
  state,
  open,
  request,
  fail,
  board,
}: {
  state: State;
  open: (id: string) => void;
  request: (id: string, text: string) => Promise<void>;
  fail: (e: unknown) => void;
  /** Feed, Ideas and Goals, shown above the panels. */
  board?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [hidden, showHidden] = useState(false);
  const [asking, setAsking] = useState(false),
    [err, setErr] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const manager = usePanelManager(state.panels, open);
  const cards = state.panels.filter((p) => p.hidden === hidden);
  const hiddenCount = state.panels.filter((p) => p.hidden).length;
  useEffect(() => {
    setErr("");
    if (creating) dialog.current?.showModal();
    else dialog.current?.close();
  }, [creating]);
  useEffect(() => {
    if (!hiddenCount) showHidden(false);
  }, [hiddenCount]);
  return (
    <>
      <div className="titleline">
        <h1>Today</h1>
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={16} />
          Create panel
        </button>
      </div>
      {board}
      {hiddenCount > 0 && (
        <div className="filters">
          <button aria-pressed={!hidden} onClick={() => showHidden(false)}>
            On Today
          </button>
          <button aria-pressed={hidden} onClick={() => showHidden(true)}>
            Hidden · {hiddenCount}
          </button>
        </div>
      )}
      {!cards.length ? (
        <div className="today-empty today-blank">
          <span className="empty-icon">
            <LayoutDashboard size={34} />
          </span>
          <h2>{hidden ? "No hidden panels" : "Build your first panel"}</h2>
          <p>Ask a bot for a briefing, a table or a chart, kept fresh on a schedule.</p>
          <button className="textbutton" onClick={() => setCreating(true)}>
            Ask a bot <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <div className="panel-grid">
          {cards.map((p) => (
            <PanelCard key={p.id} state={state} panel={p} manage={() => manager.manage(p.id)} fail={fail} />
          ))}
        </div>
      )}
      {manager.node}
      <dialog ref={dialog} onCancel={() => setCreating(false)}>
        <div className="sectionhead">
          <h2>Create a panel</h2>
          <button aria-label="Close dialog" onClick={() => setCreating(false)}>
            <X size={18} />
          </button>
        </div>
        {creating && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (asking) return;
              const form = new FormData(e.currentTarget);
              setAsking(true);
              try {
                await request(String(form.get("bot")), String(form.get("request")));
                setCreating(false);
              } catch (e) {
                setErr(String(e));
              } finally {
                setAsking(false);
              }
            }}
          >
            <label>
              Bot
              <select name="bot">
                {state.bots.map((b) => (
                  <option value={b.id} key={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              What should the panel show?
              <textarea
                rows={4}
                name="request"
                maxLength={8000}
                required
                placeholder="My weekday priorities, refreshed every morning at 9"
              />
            </label>
            <button disabled={asking} className="primary">
              Ask bot <ArrowRight size={15} />
            </button>
          </form>
        )}
        {err && <p role="alert">{err}</p>}
      </dialog>
    </>
  );
}
