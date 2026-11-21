import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  FolderGit2,
  FolderKanban,
  FolderOpen,
  GitCompareArrows,
  LayoutDashboard,
  ListTodo,
  MessagesSquare,
  Paperclip,
  Plus,
  ShieldCheck,
  SquarePen,
  Trash2,
  X,
  Info,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import { Block } from "./Today";
import { ChatRow, useAsk } from "./Pages";
import ProjectChanges, { modeLabels } from "./ProjectChanges";
import { accessVia, canUseProject, globalAccess, grantOf } from "./access";
import type { Bot, ChatMode, Project, ProjectColor, ProjectTodo, State } from "./types";
import "./records.css";
import "./workspaces.css";

import { WorkBar, type WorkNav } from "./WorkBar";
import { AddChatDialog, ProjectArtifacts, chatsToAdd, hasProjectArtifacts } from "./ProjectExtras";
const api = window.botkins;
const COLORS: ProjectColor[] = ["coral", "amber", "green", "teal", "blue", "violet", "pink", "gray"];
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

export type ProjectsTarget = { projectId?: string; n: number };

/** Projects by name. */
export function sortedProjects(state: State) {
  return [...(state.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export default function Projects({
  state,
  target,
  work,
  openChat,
  botPage,
  fail,
}: {
  state: State;
  target: ProjectsTarget;
  /** Work's tabs and tools, shown above the list of projects. */
  work: WorkNav;
  openChat: (id: string, messageIndex?: number) => void;
  botPage: (id: string) => void;
  fail: (e: unknown) => void;
}) {
  const [selected, setSelected] = useState(target.projectId ?? "");
  const [creating, setCreating] = useState(false);
  const project = state.projects?.find((p) => p.id === selected);
  const projects = sortedProjects(state);
  return (
    <div className="projects-page">
      {project ? (
        <ProjectPage
          key={project.id}
          state={state}
          project={project}
          back={() => setSelected("")}
          openChat={openChat}
          botPage={botPage}
          fail={fail}
        />
      ) : (
        <>
          <WorkBar work={work} tab="Projects" add={{ label: "New project", run: () => setCreating(true) }} />
          <p className="muted page-lede">Chats, panels and a to-do list for each piece of work.</p>
          {!projects.length ? (
            <div className="empty-detail projects-empty">
              <FolderKanban size={30} />
              <h2>Start a project</h2>
              <p>Give a piece of work a home. Add a folder to make it a coding project.</p>
              <button className="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> New project
              </button>
            </div>
          ) : (
            <section className="project-group" aria-label="Projects">
              <ul className="edit-list project-list">
                {projects.map((p) => (
                  <li key={p.id} className="link-row">
                    <ProjectRow state={state} project={p} open={() => setSelected(p.id)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {creating && (
        <NewProjectDialog
          close={() => setCreating(false)}
          created={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

function ProjectRow({ state, project: p, open }: { state: State; project: Project; open: () => void }) {
  const todo = p.todos.filter((t) => !t.done).length;
  // As the project's own page counts them: an archived chat is not listed there.
  const chats = state.chats.filter((c) => c.projectId === p.id && !c.archived).length;
  const panels = state.panels.filter((x) => x.projectId === p.id).length;
  return (
    <button className="record-row" onClick={open}>
      {p.folder ? <FolderGit2 size={18} className={"project-color " + (p.color ?? "")} /> : <FolderKanban size={18} className={"project-color " + (p.color ?? "")} />}
      <span className="rowtext">
        <strong>{p.name}</strong>
        <small>
          {[plural(chats, "chat"), plural(todo, "open to-do"), panels ? plural(panels, "panel") : "", p.folder ? p.folder.split(/[\\/]/).pop() : ""]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function NewProjectDialog({
  close,
  created,
}: {
  close: () => void;
  created: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="task-dialog" aria-label="New project" onCancel={close} onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            created(await api.createProject({ name: name.trim(), description: description.trim() }));
          } catch (err) {
            setError(clean(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="sectionhead">
          <h2>New project</h2>
          <button type="button" aria-label="Close dialog" onClick={close}>
            <X size={19} />
          </button>
        </div>
        <label className="field">
          Name
          <input required autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Description
          <textarea rows={3} maxLength={2000} placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <small>You can add a folder later to make it a coding project.</small>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="ask-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            Create project
          </button>
        </div>
      </form>
    </dialog>
  );
}

type Section = "overview" | "chats" | "panels" | "todos" | "artifacts" | "access" | "changes";

function ProjectPage({
  state,
  project,
  back,
  openChat,
  botPage,
  fail,
}: {
  state: State;
  project: Project;
  back: () => void;
  openChat: (id: string, messageIndex?: number) => void;
  botPage: (id: string) => void;
  fail: (e: unknown) => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  const [repo, setRepo] = useState(false);
  const chats = state.chats.filter((c) => c.projectId === project.id && !c.archived).sort((a, b) => b.time - a.time);
  const panels = state.panels.filter((p) => p.projectId === project.id);
  const open = project.todos.filter((t) => !t.done).length;
  const allowed = state.bots.filter((b) => canUseProject(state, b, project)).length;
  // Changes shows only for a folder that is a git repository.
  useEffect(() => {
    setRepo(false);
    if (!project.folder) return;
    let live = true;
    api
      .projectChanges(project.id)
      .then((c) => live && setRepo(c.repo))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project.id, project.folder]);
  useEffect(() => {
    if (section === "changes" && !repo) setSection("overview");
  }, [repo]);
  const menu: [Section, string, typeof Info, string][] = [
    ["overview", "Overview", Info, ""],
    ["chats", "Chats", MessagesSquare, chats.length ? String(chats.length) : ""],
    ["panels", "Panels", LayoutDashboard, panels.length ? String(panels.length) : ""],
    ["todos", "To-do list", ListTodo, open ? String(open) : ""],
    ...(hasProjectArtifacts(state) ? ([["artifacts", "Artifacts", Paperclip, project.artifacts?.length ? String(project.artifacts.length) : ""]] as [Section, string, typeof Info, string][]) : []),
    ["access", "Access", ShieldCheck, globalAccess(state) ? "All" : allowed + "/" + state.bots.length],
    ...(repo ? ([["changes", "Changes", GitCompareArrows, ""]] as [Section, string, typeof Info, string][]) : []),
  ];
  return (
    <div className="project-page">
      <button className="textbutton profile-back" onClick={back}>
        <ArrowLeft size={15} />
        All projects
      </button>
      <div className="record-head project-head">
        <span className={"record-monogram project-mark " + (project.color ?? "")} aria-hidden="true">
          {project.folder ? <FolderGit2 size={21} /> : <FolderKanban size={21} />}
        </span>
        <div>
          <h1>{project.name}</h1>
          {project.folder && (
            <small className="project-meta">
              <span title={project.folder}>{project.folder}</span>
            </small>
          )}
        </div>
      </div>
      <div className="project-layout">
        <nav className="project-menu" aria-label="Project sections">
          {menu.map(([id, label, Icon, count]) => (
            <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>
              <Icon size={16} />
              <span>{label}</span>
              {count && <small>{count}</small>}
            </button>
          ))}
        </nav>
        <div className="project-section">
          {section === "overview" && <Overview key={project.id} state={state} project={project} deleted={back} fail={fail} />}
          {section === "chats" && <ProjectChats state={state} project={project} chats={chats} openChat={openChat} botPage={botPage} />}
          {section === "panels" && <ProjectPanels state={state} panels={panels} />}
          {section === "todos" && <TodoList project={project} fail={fail} />}
          {section === "artifacts" && <ProjectArtifacts state={state} project={project} openChat={openChat} />}
          {section === "access" && <ProjectAccess state={state} project={project} botPage={botPage} fail={fail} />}
          {section === "changes" && repo && (
            <ProjectChanges key={project.id} state={state} projectId={project.id} close={() => setSection("overview")} />
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, note, action, children, label }: { title: string; note?: ReactNode; action?: ReactNode; children?: ReactNode; label?: string }) {
  const id = "card-" + (label ?? title).replace(/\W+/g, "-").toLowerCase();
  return (
    <section className="form-card" aria-labelledby={id}>
      <div className="form-card-head">
        <div>
          <h3 id={id}>{title}</h3>
          {note && <small>{note}</small>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Overview({
  state,
  project,
  deleted,
  fail,
}: {
  state: State;
  project: Project;
  deleted: () => void;
  fail: (e: unknown) => void;
}) {
  const initial = useMemo(
    () => ({ name: project.name, description: project.description ?? "", color: project.color ?? "" }),
    [project.name, project.description, project.color],
  );
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialogs = useAsk();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => {
    if (!dirty) setDraft(initial);
  }, [initial]);
  const chats = state.chats.filter((c) => c.projectId === project.id).length;
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.updateProject(project.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        color: (draft.color || null) as ProjectColor | null,
      });
      setSaved(true);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  }
  const run = (p: Promise<unknown>) => void p.catch((e) => setError(clean(e)));
  return (
    <div className="record-detail">
      <Card title="Details" label="overview-details">
        <div className="field-grid">
          <label className="field">
            Name
            <input required maxLength={60} value={draft.name} onChange={(e) => (setSaved(false), setDraft({ ...draft, name: e.target.value }))} />
          </label>
          <label className="field wide">
            Description
            <textarea
              rows={3}
              maxLength={2000}
              placeholder="What this project is for"
              value={draft.description}
              onChange={(e) => (setSaved(false), setDraft({ ...draft, description: e.target.value }))}
            />
          </label>
          <div className="field wide">
            <span id="project-color-label">Color</span>
            <div className="swatches" role="radiogroup" aria-labelledby="project-color-label">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === c}
                  aria-label={c[0].toUpperCase() + c.slice(1)}
                  className={"swatch " + c}
                  onClick={() => (setSaved(false), setDraft({ ...draft, color: draft.color === c ? "" : c }))}
                />
              ))}
            </div>
          </div>
        </div>
        {(dirty || saved || error) && (
          <div className="savebar inline">
            <small role={error ? "alert" : "status"} className={error ? "field-error" : ""}>
              {error || (saved && !dirty ? "Saved" : "Unsaved changes")}
            </small>
            {dirty && (
              <button className="secondary" onClick={() => setDraft(initial)}>
                Discard
              </button>
            )}
            <button className="primary" disabled={!dirty || busy || !draft.name.trim()} onClick={() => void save()}>
              Save changes
            </button>
          </div>
        )}
      </Card>
      <Card
        title="Folder"
        note={project.folder ? "Chats in this project run in this folder, with Default, Plan and YOLO modes." : "Optional. Add a folder to make this a coding project."}
      >
        {project.folder ? (
          <ul className="edit-list">
            <li>
              <FolderGit2 size={16} />
              <span className="grow mono" title={project.folder}>
                {project.folder}
              </span>
              <button className="icon-button" aria-label="Reveal folder" title="Show in Finder" onClick={() => run(api.revealProject(project.id))}>
                <FolderOpen size={16} />
              </button>
            </li>
          </ul>
        ) : null}
        <div className="actionrow">
          <button onClick={() => run(api.chooseProjectFolder(project.id))}>
            <FolderOpen size={15} /> {project.folder ? "Change folder…" : "Choose folder…"}
          </button>
          {project.folder && (
            <button onClick={() => run(api.updateProject(project.id, { folder: null }))}>
              <X size={15} /> Remove folder
            </button>
          )}
        </div>
      </Card>
      <Card title="Delete project" note={(chats === 1 ? "Its chat stays" : chats ? "Its " + chats + " chats stay" : "Nothing in Chats changes") + (chats ? " in Chats, outside any project." : ".") + " Its to-do list is deleted."}>
        <div className="actionrow">
          <button
            className="danger"
            onClick={async () => {
              const ok = await dialogs.ask({
                title: "Delete “" + project.name + "”?",
                body: "Chats and panels stay, outside any project. The to-do list is deleted. Nothing in the folder is touched.",
                confirm: "Delete project",
                danger: true,
              });
              if (!ok) return;
              try {
                await api.removeProject(project.id);
                deleted();
              } catch (e) {
                fail(e);
              }
            }}
          >
            <Trash2 size={15} /> Delete project…
          </button>
        </div>
      </Card>
      {dialogs.node}
    </div>
  );
}

function ProjectChats({
  state,
  project,
  chats,
  openChat,
  botPage,
}: {
  state: State;
  project: Project;
  chats: State["chats"];
  openChat: (id: string, messageIndex?: number) => void;
  botPage: (id: string) => void;
}) {
  const [mode, setMode] = useState<ChatMode>("default");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const visible = state.bots.filter((b) => !b.hidden || canUseProject(state, b, project));
  async function start(bot: Bot) {
    setBusy(bot.id);
    setError("");
    try {
      openChat(await api.startProjectChat([bot.id], project.id, project.folder ? mode : "default"));
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="record-detail">
      <Card
        title="Chats"
        note={chats.length ? plural(chats.length, "chat") : "No chats in this project yet"}
        action={
          <button type="button" className="secondary" disabled={!chatsToAdd(state, project).length} onClick={() => setAdding(true)}>
            <Plus size={14} /> Add existing chat
          </button>
        }
      >
        {chats.length > 0 && (
          <div className="project-chats">
            {chats.map((c) => (
              <ChatRow key={c.id} state={state} chat={c} open={openChat} />
            ))}
          </div>
        )}
      </Card>
      <Card
        title="New chat in this project"
        note="The bot gets the project as context, and can keep the to-do list."
        action={
          project.folder && (
            <label className="field-inline compact">
              <span>Mode</span>
              <select aria-label="Mode" className="record-select" value={mode} onChange={(e) => setMode(e.target.value as ChatMode)}>
                {(Object.keys(modeLabels) as ChatMode[]).map((m) => (
                  <option key={m} value={m}>
                    {modeLabels[m].label} – {modeLabels[m].hint}
                  </option>
                ))}
              </select>
            </label>
          )
        }
      >
        <ul className="edit-list bot-pick-list" aria-label="Bots">
          {visible.map((b) => {
            const ok = canUseProject(state, b, project);
            return (
              <li key={b.id} className={ok ? "" : "blocked"}>
                <BotAvatar bot={b} size={30} />
                <span className="grow">
                  <strong>{b.name}</strong>
                  <small>{ok ? b.role : "No access to this project"}</small>
                </span>
                {ok ? (
                  <button className="secondary" disabled={!!busy} aria-label={"Start chat with " + b.name} onClick={() => void start(b)}>
                    <SquarePen size={14} /> Start chat
                  </button>
                ) : (
                  <>
                    <button className="secondary" disabled aria-label={"Start chat with " + b.name} title={b.name + " doesn't have access to this project"}>
                      <SquarePen size={14} /> Start chat
                    </button>
                    <button className="icon-button" aria-label={"Open " + b.name + "'s access"} title="Manage access on the bot page" onClick={() => botPage(b.id)}>
                      <ShieldCheck size={16} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {error && (
          <p className="field-error list-note" role="alert">
            {error}
          </p>
        )}
      </Card>
      {adding && <AddChatDialog state={state} project={project} close={() => setAdding(false)} />}
    </div>
  );
}

function ProjectPanels({ state, panels }: { state: State; panels: State["panels"] }) {
  if (!panels.length)
    return (
      <div className="empty-detail">
        <LayoutDashboard size={28} />
        <h2>No panels yet</h2>
        <p>Ask a bot in one of this project's chats for a Today panel.</p>
      </div>
    );
  return (
    <div className="panel-grid project-panels">
      {panels.map((p) => {
        const bot = state.bots.find((b) => b.id === p.botId);
        return (
          <section className={"live-panel today-panel " + p.size} key={p.id} aria-label={p.title}>
            <div className="panel-top">
              {bot && <BotAvatar bot={bot} size={24} />}
              <small>{bot?.name}</small>
            </div>
            <h2>{p.title}</h2>
            <div className="panel-blocks">
              {p.blocks.map((b, i) => (
                <Block key={i} block={b} />
              ))}
            </div>
            <footer>
              <small>Updated {new Date(p.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
            </footer>
          </section>
        );
      })}
    </div>
  );
}

function TodoList({ project, fail }: { project: Project; fail: (e: unknown) => void }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [showDone, setShowDone] = useState(true);
  const dialogs = useAsk();
  const open = project.todos.filter((t) => !t.done);
  const done = project.todos.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const run = (p: Promise<unknown>) => void p.catch(fail);
  // Up and down move among the open items, which skip over done ones in the stored order.
  function move(t: ProjectTodo, delta: -1 | 1) {
    const all = project.todos;
    let i = all.indexOf(t),
      steps = 0;
    do {
      i += delta;
      steps++;
    } while (i >= 0 && i < all.length && all[i].done);
    if (i < 0 || i >= all.length) return;
    run(
      (async () => {
        for (let s = 0; s < steps; s++) await api.moveTodo(project.id, t.id, delta);
      })(),
    );
  }
  const row = (t: ProjectTodo, index: number, list: ProjectTodo[]) => (
    <li key={t.id} className={"todo-row" + (t.done ? " done" : "")}>
      <input
        type="checkbox"
        checked={t.done}
        aria-label={(t.done ? "Reopen " : "Check off ") + t.text}
        onChange={(e) => run(api.updateTodo(project.id, t.id, { done: e.target.checked }))}
      />
      {editing?.id === t.id ? (
        <form
          className="grow todo-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing.text.trim() && editing.text.trim() !== t.text) run(api.updateTodo(project.id, t.id, { text: editing.text.trim() }));
            setEditing(undefined);
          }}
        >
          <input
            autoFocus
            aria-label="To-do text"
            maxLength={500}
            value={editing.text}
            onChange={(e) => setEditing({ id: t.id, text: e.target.value })}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setEditing(undefined))}
          />
        </form>
      ) : (
        <button className="grow todo-text" title="Rename" onClick={() => setEditing({ id: t.id, text: t.text })}>
          {t.text}
        </button>
      )}
      {!t.done && (
        <>
          <button className="icon-button" aria-label={"Move " + t.text + " up"} disabled={index === 0} onClick={() => move(t, -1)}>
            <ArrowUp size={15} />
          </button>
          <button className="icon-button" aria-label={"Move " + t.text + " down"} disabled={index === list.length - 1} onClick={() => move(t, 1)}>
            <ArrowDown size={15} />
          </button>
        </>
      )}
      <button
        className="icon-button"
        aria-label={"Delete " + t.text}
        title="Delete"
        onClick={async () => {
          const ok = await dialogs.ask({ title: "Delete this to-do?", body: t.text, confirm: "Delete", danger: true });
          if (ok) run(api.deleteTodo(project.id, t.id));
        }}
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
  return (
    <div className="record-detail">
      <Card title="To-do list" note={plural(open.length, "open item") + (done.length ? " · " + done.length + " done" : "")}>
        <form
          className="inline-add todo-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            run(api.addTodo(project.id, text.trim()).then(() => setText("")));
          }}
        >
          <input aria-label="New to-do" placeholder="Add a to-do" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="secondary" disabled={!text.trim()}>
            <Plus size={14} /> Add
          </button>
        </form>
        {open.length ? (
          <ul className="edit-list todo-list" aria-label="Open to-dos">
            {open.map(row)}
          </ul>
        ) : (
          <p className="muted list-note">{done.length ? "Everything's done." : "Nothing to do yet. Bots in this project can add to it too."}</p>
        )}
        {done.length > 0 && (
          <>
            <button className="textbutton todo-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              <ChevronRight size={14} style={{ transform: showDone ? "rotate(90deg)" : undefined }} /> Done · {done.length}
            </button>
            {showDone && (
              <ul className="edit-list todo-list" aria-label="Done to-dos">
                {done.map(row)}
              </ul>
            )}
          </>
        )}
      </Card>
      {dialogs.node}
    </div>
  );
}

function ProjectAccess({ state, project, botPage, fail }: { state: State; project: Project; botPage: (id: string) => void; fail: (e: unknown) => void }) {
  const everyone = globalAccess(state);
  return (
    <div className="record-detail">
      <Card
        title="Access"
        note={
          everyone
            ? "All bots can use every project. Choose per bot in Settings › Access."
            : "Bots with access can chat in this project and keep its to-do list."
        }
      >
        <ul className="edit-list access-list" aria-label="Bots with access">
          {state.bots.map((b) => {
            const via = accessVia(state, b, project);
            const reason =
              via === "everyone"
                ? "All bots have access"
                : via === "all"
                  ? "Has all projects"
                  : via === "project"
                    ? "Granted for this project"
                    : "No access";
            const locked = via === "everyone" || via === "all";
            return (
              <li key={b.id}>
                <input
                  type="checkbox"
                  aria-label={"Let " + b.name + " use this project"}
                  checked={!!via}
                  disabled={locked}
                  onChange={(e) => {
                    const g = grantOf(b);
                    const projects = e.target.checked ? [...new Set([...g.projects, project.id])] : g.projects.filter((id) => id !== project.id);
                    void api.setBotAccess(b.id, { ...g, projects }).catch(fail);
                  }}
                />
                <BotAvatar bot={b} size={28} />
                <span className="grow">
                  <strong>{b.name}</strong>
                  <small className={via ? "" : "no-access"}>{reason}</small>
                </span>
                <button className="icon-button" aria-label={"Open " + b.name} title="Bot page" onClick={() => botPage(b.id)}>
                  <ChevronRight size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
