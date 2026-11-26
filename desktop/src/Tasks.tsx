import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, MessageCircle, Play, Plus, RotateCcw, Send, Trash2, X } from "lucide-react";
import { Button } from "glisse";
import { BotAvatar } from "./Avatar";
import { RichText } from "./RichText";
import type { BotTask, State, TaskPriority, TaskStatus } from "./types";
import { Folded, WorkBar, WorkNeeds, type WorkNav } from "./WorkBar";
import "./tasks.css";

const api = window.botkins;
// The phone's sections, top to bottom. Needs you (person review or stuck) is drawn by WorkNeeds above them.
// Orchestrated bot-reviewed tasks (status === "review" with reviewerBotId) show in a Reviewing section so the person sees them without being asked to approve.
const lanes: { status: TaskStatus; label: string; hint: string }[] = [
  { status: "review", label: "Reviewing", hint: "Waiting for the creating bot to review." },
  { status: "working", label: "Working", hint: "A bot is on it." },
  { status: "ready", label: "Ready", hint: "Starts when its bot is free." },
  { status: "later", label: "Later", hint: "Not scheduled yet." },
  { status: "done", label: "Done", hint: "Approved." },
];
const priorities: TaskPriority[] = ["low", "normal", "high", "urgent"];

/** Bighelp's Kanban for Botkins: tasks for bots, from Later to Done. */
export default function TasksPage({
  state,
  openChat,
  work,
  fail,
}: {
  state: State;
  openChat: (id: string) => void;
  /** Work's tabs and tools, shown above the board. */
  work: WorkNav;
  fail: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState<BotTask | { status: "later" | "ready" } | null>(null);
  const [changing, setChanging] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [dragged, setDragged] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const tasks = (state.tasks ?? []).filter((t) => t.status !== "archived");
  useEffect(() => {
    if (editing) dialog.current?.showModal();
    else dialog.current?.close();
  }, [!!editing]);
  const current = editing && "id" in editing ? state.tasks?.find((t) => t.id === editing.id) : undefined;
  const botName = (id?: string | null) => state.bots.find((b) => b.id === id)?.name ?? null;
  function openTask(t: BotTask, askChanges = false) {
    setChanging(askChanges);
    setChangeNote("");
    setEditing(t);
  }
  function closeDialog() {
    setChanging(false);
    setChangeNote("");
    setEditing(null);
  }
  async function act(fn: () => Promise<unknown>, close = false) {
    try {
      await fn();
      if (close) closeDialog();
    } catch (e) {
      fail(e);
    }
  }
  const row = (t: BotTask) => {
    const bot = state.bots.find((b) => b.id === t.botId);
    const reviewer = t.status === "review" && t.reviewerBotId ? botName(t.reviewerBotId) : null;
    return (
      <div
        key={t.id}
        className={"group-row task-card priority-" + t.priority + (t.status === "blocked" ? " blocked" : "")}
        draggable={t.status !== "working"}
        onDragStart={() => setDragged(t.id)}
        onDragEnd={() => setDragged("")}
      >
        {bot ? <BotAvatar bot={bot} size={36} state={t.status === "working" ? "thinking" : "idle"} /> : <span className="work-avatar-blank" aria-hidden="true" />}
        <button type="button" className="row-main work-needs-open" onClick={() => openTask(t)}>
          <span className="row-title">{t.title}</span>
          <span className="row-sub task-meta">
            {bot?.name ?? "Anyone"}
            {reviewer && (
              <>
                {" · "}
                <span className="task-reviewer-badge">Reviewing: {reviewer}</span>
              </>
            )}
            {t.priority !== "normal" && (
              <>
                {" · "}
                <em>{t.priority}</em>
              </>
            )}
          </span>
        </button>
        {t.status === "done" ? (
          <button
            type="button"
            className="btn soft small"
            aria-label={"Reopen " + t.title}
            onClick={() => void act(() => api.moveTask(t.id, "ready"))}
          >
            Reopen
          </button>
        ) : reviewer ? (
          <div className="work-needs-actions">
            <button
              type="button"
              className="btn soft small"
              aria-label={"Request changes for " + t.title}
              onClick={() => openTask(t, true)}
            >
              Request changes
            </button>
            <button
              type="button"
              className="btn soft small"
              aria-label={"Approve " + t.title}
              onClick={() => void act(() => api.moveTask(t.id, "done"))}
            >
              Approve
            </button>
          </div>
        ) : (
          <ChevronRight size={15} className="row-chevron" aria-hidden="true" />
        )}
      </div>
    );
  };
  return (
    <div className="page work-page tasks-page">
      <WorkBar work={work} tab="Tasks" add={{ label: "New task", run: () => { setChanging(false); setChangeNote(""); setEditing({ status: "ready" }); } }} lede="A Ready task starts when its bot is free. Finished ones wait here for you." />
      <WorkNeeds state={state} openChat={openChat} openTask={(t) => openTask(t)} requestChanges={(t) => openTask(t, true)} fail={fail} />
      {lanes.map((lane) => {
        const items = tasks
          .filter((t) =>
            lane.status === "review"
              ? t.status === "review" && Boolean(t.reviewerBotId)
              : t.status === lane.status,
          )
          .sort((a, b) => (lane.status === "done" ? b.updatedAt - a.updatedAt : 0));
        const droppable = ["later", "ready", "done"].includes(lane.status);
        const adds = lane.status === "later" || lane.status === "ready";
        // Reviewing, Working, and Done show only when they hold something, or Done while a task is dragged to it.
        if (!items.length && !adds && !(dragged && droppable)) return null;
        return (
          <section
            key={lane.status}
            className={"page-section task-lane" + (dragged && droppable ? " drop" : "")}
            aria-label={lane.label}
            onDragOver={(e) => droppable && dragged && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (droppable && dragged) void act(() => api.moveTask(dragged, lane.status));
              setDragged("");
            }}
          >
            <h2 className="group-label">
              {lane.label} · {items.length}
            </h2>
            <div className="group work-avatars">
              {/* Done keeps its newest few in view; the rest fold away, as the phone's done toggle does. */}
              <Folded rows={items.map(row)} limit={lane.status === "done" ? 3 : 8} />
              {adds && (
                <button type="button" className="group-row work-more" onClick={() => { setChanging(false); setChangeNote(""); setEditing({ status: lane.status as "later" | "ready" }); }}>
                  <Plus size={15} aria-hidden="true" />
                  Add task
                </button>
              )}
            </div>
            <p className="group-foot">{lane.hint}</p>
          </section>
        );
      })}
      <dialog ref={dialog} onCancel={closeDialog} className="task-dialog">
        {editing && (
          <form
            key={current?.id ?? "new"}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () =>
                  api.saveTask({
                    id: current?.id,
                    title: String(f.get("title")),
                    body: String(f.get("body") ?? ""),
                    botId: String(f.get("bot")) || null,
                    priority: String(f.get("priority")) as TaskPriority,
                    ...(!current && { status: editing.status as "later" | "ready" }),
                  }),
                true,
              );
            }}
          >
            <div className="sectionhead">
              <h2>{current ? "Task" : "New task"}</h2>
              <button type="button" aria-label="Close" onClick={closeDialog}>
                <X size={18} />
              </button>
            </div>
            {current?.status === "review" && current.reviewerBotId && (
              <p className="task-review-banner">
                Reviewing: <strong>{botName(current.reviewerBotId) ?? "Creator bot"}</strong> · You can still approve or send it back.
              </p>
            )}
            {current?.status === "blocked" && <p role="alert">Stuck: {current.problem}</p>}
            {current?.result && current.status !== "working" && (
              <div className="task-result panel-prose">
                <small>Result</small>
                <RichText text={current.result} />
              </div>
            )}
            {current?.status === "review" && changing && (
              <div className="task-change-box">
                <label>
                  Changes requested
                  <textarea
                    rows={3}
                    maxLength={4000}
                    autoFocus
                    placeholder="Tell the bot what to fix or change. It will continue in the same chat."
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                  />
                </label>
                <div className="actionrow">
                  <button type="button" className="btn soft small" onClick={() => setChanging(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={!changeNote.trim()}
                    onClick={() => void act(() => api.moveTask(current.id, "ready", { note: changeNote.trim() }), true)}
                  >
                    <Send size={14} /> Send back to Ready
                  </button>
                </div>
              </div>
            )}
            <label>
              Title
              <input name="title" required maxLength={160} defaultValue={current?.title} autoFocus={!current && !changing} disabled={current?.status === "working"} />
            </label>
            <label>
              Details
              <textarea name="body" rows={4} maxLength={8000} defaultValue={current?.body} disabled={current?.status === "working"} />
            </label>
            <div className="pref-columns">
              <label>
                Bot
                <select name="bot" defaultValue={current?.botId ?? state.bots[0]?.id} disabled={current?.status === "working"}>
                  <option value="">Anyone</option>
                  {state.bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Priority
                <select name="priority" defaultValue={current?.priority ?? "normal"} disabled={current?.status === "working"}>
                  {priorities.map((p) => (
                    <option key={p} value={p}>
                      {p[0].toUpperCase() + p.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!!current?.history?.length && (
              <div className="task-history">
                <small>History</small>
                <ul>
                  {current.history.slice(-8).reverse().map((h, idx) => (
                    <li key={h.at + "-" + idx}>
                      <span>
                        <strong>{h.byName ?? h.by}</strong> {h.from} → {h.to}
                      </span>
                      {h.note && <p>{h.note}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="actionrow task-actions">
              {current?.chatId && (
                <button type="button" onClick={() => openChat(current.chatId!)}>
                  <MessageCircle size={15} /> Open chat
                </button>
              )}
              {current && ["later", "ready", "blocked"].includes(current.status) && current.botId && (
                <button type="button" onClick={() => void act(() => api.startTask(current.id), true)}>
                  <Play size={15} /> Start now
                </button>
              )}
              {current?.status === "review" && (
                <>
                  <button type="button" onClick={() => void act(() => api.moveTask(current.id, "done"), true)}>
                    <Check size={15} /> Approve
                  </button>
                  <button type="button" onClick={() => setChanging((v) => !v)}>
                    <RotateCcw size={15} /> Request changes
                  </button>
                  <button type="button" onClick={() => void act(() => api.moveTask(current.id, "later"), true)}>
                    Move to Later
                  </button>
                </>
              )}
              {current?.status === "done" && (
                <Button variant="glass" className="lg-compact" icon={<RotateCcw size={15} />} onClick={() => void act(() => api.moveTask(current.id, "ready"), true)}>
                  Reopen
                </Button>
              )}
              {current?.status === "blocked" && (
                <Button variant="glass" className="lg-compact" icon={<RotateCcw size={15} />} onClick={() => void act(() => api.moveTask(current.id, "ready"), true)}>
                  Retry
                </Button>
              )}
              {current && current.status !== "working" && (
                <Button variant="glass" destructive className="lg-compact" icon={<Trash2 size={15} />} onClick={() => void act(() => api.deleteTask(current.id), true)}>
                  Delete
                </Button>
              )}
              {current?.status !== "working" && (
                <Button type="submit" variant="filled" className="lg-compact">
                  {current ? "Save" : "Add task"}
                </Button>
              )}
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
