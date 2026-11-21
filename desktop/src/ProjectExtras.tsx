// Two parts of a project's page (src/Projects.tsx): adding a chat that already exists, and the
// artifacts a person attached to the project (the computer's calls addProjectArtifact,
// removeProjectArtifact and projectArtifacts; capability "project-artifacts-v1").
import { useEffect, useMemo, useRef, useState } from "react";
import { File, FileAudio, FileImage, FileText, FileVideo, Folder, FolderGit2, FolderKanban, MessageCircle, Paperclip, Plus, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { dateLabel } from "./Pages";
import { memberTeam } from "./teamAccess";
import type { Artifact, Chat, Project, State } from "./types";

const api = window.botkins;
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

/** Whether the computer in use keeps artifacts on a project. Another computer may run an older Botkins. */
export const hasProjectArtifacts = (state: State) => !state.remote?.using || state.remote.using.capabilities?.includes("project-artifacts-v1");
/** Whether an artifact can be offered "Add to a project…": projects are the owner's, and there must be one. */
export const canAddToProject = (state: State) => hasProjectArtifacts(state) && !memberTeam(state) && state.remote?.using?.member !== true && !!state.projects?.length;

/** The chats a person can add to a project: their own conversations and groups, not a routine's or a panel's chat. */
export function chatsToAdd(state: State, project: Project) {
  return state.chats
    .filter(
      (c) =>
        c.projectId !== project.id &&
        !c.archived &&
        !c.panelId &&
        !c.schedules?.some((entry) => entry.routine) &&
        // A group chat can't work in a folder, so a coding project doesn't offer one.
        !(project.folder && c.botIds),
    )
    .sort((a, b) => b.time - a.time);
}

/** "Add a chat…": the chats outside this project, with a search. Adding one moves it here. */
export function AddChatDialog({ state, project, close }: { state: State; project: Project; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [added, setAdded] = useState(0);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const all = chatsToAdd(state, project);
  const words = query.trim().toLowerCase();
  const botName = (c: Chat) => (c.botIds ?? [c.botId]).map((id) => state.bots.find((b) => b.id === id)?.name).filter(Boolean).join(", ");
  const shown = all.filter((c) => !words || c.title.toLowerCase().includes(words) || botName(c).toLowerCase().includes(words)).slice(0, 100);
  async function add(chat: Chat) {
    setBusy(chat.id);
    setError("");
    try {
      await api.setChatProject(chat.id, project.id, "default");
      setAdded((n) => n + 1);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <dialog ref={ref} className="task-dialog pick-dialog" aria-label="Add chats" onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>Add chats</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <input type="search" autoFocus aria-label="Search chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
      <span className="visually-hidden" role="status">
        {added ? plural(added, "chat") + " added to " + project.name + "." : ""}
      </span>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {shown.length ? (
        <ul className="edit-list pick-list" aria-label="Chats">
          {shown.map((c) => {
            const bot = state.bots.find((b) => b.id === c.botId);
            const other = c.projectId ? state.projects?.find((p) => p.id === c.projectId)?.name : "";
            return (
              <li key={c.id}>
                {bot && <BotAvatar bot={bot} size={28} />}
                <span className="grow">
                  <strong>{c.title}</strong>
                  <small>{[botName(c), other ? "In " + other : "", dateLabel(c.time)].filter(Boolean).join(" · ")}</small>
                </span>
                <button type="button" className="secondary" disabled={!!busy} aria-label={"Add " + c.title} onClick={() => void add(c)}>
                  <Plus size={14} /> Add
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted pick-empty">{all.length ? "No chats match." : "There are no other chats to add."}</p>
      )}
      <div className="ask-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}

const iconOf = (item: Artifact) =>
  item.kind === "folder" ? Folder : item.kind === "image" ? FileImage : item.kind === "video" ? FileVideo : item.kind === "audio" ? FileAudio : /^text\/|pdf|json|xml/.test(item.mime) ? FileText : File;
const sizeLabel = (size: number | null) =>
  size == null ? "" : size < 1024 ? size + " B" : size < 1024 * 1024 ? Math.round(size / 102.4) / 10 + " KB" : Math.round(size / 104857.6) / 10 + " MB";

function ArtifactLine({ state, item }: { state: State; item: Artifact }) {
  const Icon = iconOf(item);
  const bot = state.bots.find((b) => b.id === item.botId)?.name;
  return (
    <>
      <Icon size={20} className="artifact-kind" aria-hidden="true" />
      <span className="grow">
        <strong>{item.name}</strong>
        <small>{[bot, item.chatTitle, sizeLabel(item.size), dateLabel(item.time)].filter(Boolean).join(" · ")}</small>
      </span>
    </>
  );
}

/** A project's Artifacts section: what is attached, newest first, and "Attach an artifact…". */
export function ProjectArtifacts({ state, project, openChat }: { state: State; project: Project; openChat: (id: string, messageIndex?: number) => void }) {
  const [items, setItems] = useState<Artifact[]>();
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const ids = (project.artifacts ?? []).join("\n");
  useEffect(() => {
    let live = true;
    api
      .projectArtifacts(project.id)
      .then((answer) => live && (setItems(answer.items), setError("")))
      .catch((e) => live && setError(clean(e)));
    return () => {
      live = false;
    };
  }, [project.id, ids, state.artifacts?.revision]);
  const remote = !!state.remote?.using;
  const act = (work: Promise<unknown>) => void work.then(() => setError(""), (e) => setError(clean(e)));
  const count = items?.length ?? project.artifacts?.length ?? 0;
  return (
    <div className="record-detail">
      <section className="form-card" aria-labelledby="card-artifacts">
        <div className="form-card-head">
          <div>
            <h3 id="card-artifacts">Artifacts</h3>
            <small>{count ? plural(count, "artifact") : "Nothing attached yet."}</small>
          </div>
          <button type="button" className="secondary" onClick={() => setPicking(true)}>
            <Paperclip size={14} /> Attach an artifact…
          </button>
        </div>
        {error && (
          <p className="field-error list-note" role="alert">
            {error}
          </p>
        )}
        {!!items?.length && (
          <ul className="edit-list artifact-pick-list" aria-label="Attached artifacts">
            {items.map((item) => (
              <li key={item.id}>
                <ArtifactLine state={state} item={item} />
                {!remote && (
                  <button type="button" className="secondary" aria-label={"Open " + item.name} onClick={() => act(api.openChatPath(item.path, "open"))}>
                    Open
                  </button>
                )}
                {item.chatId && state.chats.some((c) => c.id === item.chatId) && (
                  <button type="button" className="icon-button" aria-label={"Go to the chat of " + item.name} title="Go to chat" onClick={() => openChat(item.chatId!, item.messageIndex)}>
                    <MessageCircle size={16} />
                  </button>
                )}
                <button type="button" className="icon-button" aria-label={"Remove " + item.name + " from project"} title="Remove from project" onClick={() => act(api.removeProjectArtifact(project.id, item.id))}>
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {picking && <AttachArtifactDialog state={state} project={project} close={() => setPicking(false)} />}
    </div>
  );
}

/** "Attach artifacts": one bot's artifacts, newest first. A folder is attached whole. */
function AttachArtifactDialog({ state, project, close }: { state: State; project: Project; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const bots = state.bots;
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [items, setItems] = useState<Artifact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const request = useRef(0);
  const attached = useMemo(() => new Set(project.artifacts ?? []), [project.artifacts]);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function load(more = false) {
    if (!botId) return setLoading(false);
    const sequence = ++request.current;
    setLoading(true);
    try {
      const page = await api["artifacts.list"]({ botId, ...(more && cursor ? { cursor } : {}) });
      if (sequence !== request.current) return;
      setItems((old) => (more ? [...old, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError("");
    } catch (e) {
      if (sequence === request.current) setError(clean(e));
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load();
  }, [botId, state.artifacts?.revision]);
  async function attach(item: Artifact) {
    setBusy(item.id);
    setError("");
    try {
      await api.addProjectArtifact(project.id, item.id);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <dialog ref={ref} className="task-dialog pick-dialog" aria-label="Attach artifacts" onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>Attach artifacts</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      {bots.length > 1 && (
        <label className="field-inline compact">
          <span>Bot</span>
          <select aria-label="Bot" className="record-select" value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {items.length ? (
        <ul className="edit-list pick-list artifact-pick-list" aria-label="Artifacts">
          {items.map((item) => (
            <li key={item.id}>
              <ArtifactLine state={state} item={item} />
              {attached.has(item.id) ? (
                <button type="button" className="secondary" disabled aria-label={item.name + " is attached"}>
                  Attached
                </button>
              ) : (
                <button type="button" className="secondary" disabled={!!busy} aria-label={"Attach " + item.name} onClick={() => void attach(item)}>
                  <Paperclip size={14} /> Attach
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted pick-empty">{loading ? "Loading…" : "This bot has no artifacts yet."}</p>
      )}
      {cursor && (
        <button type="button" className="textbutton pick-more" disabled={loading} onClick={() => void load(true)}>
          Show more
        </button>
      )}
      <div className="ask-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}

/** "Add to a project…" on an artifact: the projects by name. Adding puts the artifact at the top of that project's list. */
export function AddToProjectDialog({ state, artifact, close }: { state: State; artifact: Artifact; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const projects = [...(state.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  async function add(project: Project) {
    setBusy(project.id);
    setError("");
    try {
      await api.addProjectArtifact(project.id, artifact.id);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <dialog ref={ref} className="task-dialog pick-dialog" aria-label="Add to a project" onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>Add to a project</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <p className="muted pick-what">{artifact.name}</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <ul className="edit-list pick-list" aria-label="Projects">
        {projects.map((p) => {
          const added = p.artifacts?.includes(artifact.id);
          return (
            <li key={p.id}>
              {p.folder ? <FolderGit2 size={18} className={"project-color " + (p.color ?? "")} /> : <FolderKanban size={18} className={"project-color " + (p.color ?? "")} />}
              <span className="grow">
                <strong>{p.name}</strong>
                <small>{p.artifacts?.length ? plural(p.artifacts.length, "artifact") : "Nothing attached yet."}</small>
              </span>
              {added ? (
                <button type="button" className="secondary" disabled aria-label={"Added to " + p.name}>
                  Added
                </button>
              ) : (
                <button type="button" className="secondary" disabled={!!busy} aria-label={"Add to " + p.name} onClick={() => void add(p)}>
                  <Plus size={14} /> Add
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="ask-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
