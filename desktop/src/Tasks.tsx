import { useEffect, useRef, useState } from "react";
import { Check, MessageCircle, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { RichText } from "./RichText";
import type { BotTask, State, TaskPriority, TaskStatus } from "./types";
import { WorkBar, type WorkNav } from "./WorkBar";
import "./tasks.css";

const api = window.botkins;
const lanes: { status: TaskStatus; label: string; hint: string }[] = [
  { status: "later", label: "Later", hint: "Not scheduled yet." },
  { status: "ready", label: "Ready", hint: "Starts when its bot is free." },
  { status: "working", label: "Working", hint: "A bot is on it." },
  { status: "review", label: "Needs you", hint: "Review or unblock." },
  { status: "done", label: "Done", hint: "Approved." },
];
const laneOf = (t: BotTask): TaskStatus => (t.status === "blocked" ? "review" : (t.status as TaskStatus));
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
  const [dragged, setDragged] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const tasks = (state.tasks ?? []).filter((t) => t.status !== "archived");
  useEffect(() => {
    if (editing) dialog.current?.showModal();
    else dialog.current?.close();
  }, [!!editing]);
  const current = editing && "id" in editing ? state.tasks?.find((t) => t.id === editing.id) : undefined;
  async function act(fn: () => Promise<unknown>, close = false) {
    try {
      await fn();
      if (close) setEditing(null);
    } catch (e) {
      fail(e);
    }
  }
  return (
    <div className="tasks-page">
      <WorkBar work={work} tab="Tasks" add={{ label: "New task", run: () => setEditing({ status: "ready" }) }} />
      <p className="muted tasks-intro">A Ready task starts when its bot is free. Finished ones wait here for you.</p>
      <div className="task-lanes">
        {lanes.map((lane) => {
          const items = tasks.filter((t) => laneOf(t) === lane.status);
          const droppable = ["later", "ready", "done"].includes(lane.status);
          return (
            <section
              key={lane.status}
              className={"task-lane" + (dragged && droppable ? " drop" : "")}
              aria-label={lane.label}
              onDragOver={(e) => droppable && dragged && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (droppable && dragged) void act(() => api.moveTask(dragged, lane.status));
                setDragged("");
              }}
            >
              <div className="lane-head">
                <strong>{lane.label}</strong>
                <span className="count">{items.length}</span>
              </div>
              <small className="lane-hint">{lane.hint}</small>
              {items.map((t) => {
                const bot = state.bots.find((b) => b.id === t.botId);
                return (
                  <button
                    key={t.id}
                    className={"task-card priority-" + t.priority + (t.status === "blocked" ? " blocked" : "")}
                    draggable={t.status !== "working"}
                    onDragStart={() => setDragged(t.id)}
                    onDragEnd={() => setDragged("")}
                    onClick={() => setEditing(t)}
                  >
                    <strong>{t.title}</strong>
                    <span className="task-meta">
                      {bot ? <BotAvatar bot={bot} size={20} state={t.status === "working" ? "thinking" : "idle"} /> : null}
                      <small>{bot?.name ?? "Anyone"}</small>
                      {t.priority !== "normal" && <em>{t.priority}</em>}
                    </span>
                    {t.status === "blocked" && <small className="task-problem">Stuck · {t.problem}</small>}
                    {t.status === "review" && <small className="task-review">Ready for review</small>}
                  </button>
                );
              })}
              {(lane.status === "later" || lane.status === "ready") && (
                <button className="textbutton lane-add" onClick={() => setEditing({ status: lane.status as "later" | "ready" })}>
                  <Plus size={14} /> Add
                </button>
              )}
            </section>
          );
        })}
      </div>
      <dialog ref={dialog} onCancel={() => setEditing(null)} className="task-dialog">
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
              <button type="button" aria-label="Close" onClick={() => setEditing(null)}>
                <X size={18} />
              </button>
            </div>
            {current?.status === "blocked" && <p role="alert">Stuck: {current.problem}</p>}
            {current?.result && current.status !== "working" && (
              <div className="task-result panel-prose">
                <small>Result</small>
                <RichText text={current.result} />
              </div>
            )}
            <label>
              Title
              <input name="title" required maxLength={160} defaultValue={current?.title} autoFocus={!current} disabled={current?.status === "working"} />
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
                <button type="button" onClick={() => void act(() => api.moveTask(current.id, "done"), true)}>
                  <Check size={15} /> Approve
                </button>
              )}
              {current && ["review", "blocked", "done"].includes(current.status) && (
                <button type="button" onClick={() => void act(() => api.moveTask(current.id, "ready"), true)}>
                  <RotateCcw size={15} /> Try again
                </button>
              )}
              {current && current.status !== "working" && (
                <button type="button" className="danger" onClick={() => void act(() => api.deleteTask(current.id), true)}>
                  <Trash2 size={15} /> Delete
                </button>
              )}
              {current?.status !== "working" && <button className="primary">{current ? "Save" : "Add task"}</button>}
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
