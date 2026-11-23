import { useEffect, useState } from "react";
import { ArrowLeft, FolderGit2, FolderOpen, FolderPlus, GitBranch, GitCommitHorizontal, RefreshCw, X } from "lucide-react";
import type { Bot, ChatMode, Project, ProjectChanges as Changes, State } from "./types";
import { canUseProject } from "./access";
import { sortedProjects } from "./Projects";
import { FolderChoice, projectCapability } from "./ProjectFolders";
import "./projects.css";

const api = window.botkins;
export const modeLabels: Record<ChatMode, { label: string; hint: string }> = {
  default: { label: "Default", hint: "Asks before risky commands." },
  plan: { label: "Plan", hint: "Writes a plan first. Changes no code." },
  yolo: { label: "YOLO", hint: "Runs commands without asking." },
};

/**
 * Chooses a project and, for a project with a folder, a mode for a chat. Used in New chat and in a
 * chat that has not started. Projects the chosen bots can't use are listed but disabled.
 */
export function ProjectPicker({
  state,
  projectId,
  mode, folder,
  change,
  fail,
  botIds = [],
}: {
  state: State;
  projectId?: string;
  mode: ChatMode;
  folder?: string;
  change: (projectId: string | undefined, mode: ChatMode, folder?: string) => void;
  fail: (e: unknown) => void;
  /** The bots that will answer. A group can't use a project with a folder. */
  botIds?: string[];
}) {
  const group = botIds.length > 1;
  const bots = botIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const projects = sortedProjects(state);
  const chosen = state.projects?.find((p) => p.id === projectId);
  const why = (p: Project) => {
    const blocked = bots.filter((b) => !canUseProject(state, b, p));
    if (blocked.length) return blocked.map((b) => b.name).join(", ") + " can't use it";
    if (group && p.folder) return "has a folder; group chats are text only";
    return "";
  };
  return (
    <div className="project-picker">
      <label>
        Project
        <select
          aria-label="Project"
          value={projectId ?? ""}
          onChange={(e) => change(e.target.value || undefined, projects.find((p) => p.id === e.target.value)?.mode ?? "default")}
        >
          <option value="">No project</option>
          {projects.map((p) => {
            const reason = why(p);
            return (
              <option key={p.id} value={p.id} disabled={!!reason && p.id !== projectId}>
                {p.name}
                {reason ? " (" + reason + ")" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {!group && (
        <button
          type="button"
          className="textbutton"
          onClick={() =>
            api
              .addProject()
              .then((id) => id && change(id, projects.find((p) => p.id === id)?.mode ?? "default"))
              .catch(fail)
          }
        >
          <FolderPlus size={15} /> Add folder…
        </button>
      )}
      {!group && <FolderChoice project={chosen} value={folder} change={(path) => change(projectId, mode, path)} />}
      {chosen?.folder && !group && (
        <div className="filters mode-picker" role="radiogroup" aria-label="Mode">
          {(Object.keys(modeLabels) as ChatMode[]).map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={mode === m}
              aria-pressed={mode === m}
              title={modeLabels[m].hint}
              onClick={() => {
                if (projectCapability(state, "project-mode-v1")) void api.updateProject(chosen.id, { mode: m }).then(() => change(projectId, m, folder)).catch(fail);
                else change(projectId, m, folder);
              }}
            >
              {modeLabels[m].label}
            </button>
          ))}
        </div>
      )}
      {chosen?.folder && !group && <small className="mode-hint">{modeLabels[mode].hint}</small>}
      {chosen && !chosen.folder && <small className="mode-hint">The bot gets the project as context.</small>}
    </div>
  );
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff-view" aria-label="Diff">
      {text.split("\n").map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith("+++") || line.startsWith("---")
              ? "diff-file"
              : line.startsWith("+")
                ? "diff-add"
                : line.startsWith("-")
                  ? "diff-del"
                  : line.startsWith("@@")
                    ? "diff-hunk"
                    : ""
          }
        >
          {line + "\n"}
        </span>
      ))}
    </pre>
  );
}

/** Bighelp's Project Changes: the branch, changed files, each file's diff, and Commit all. */
type ChangesProps = { state: State; projectId: string; close: () => void; chatId?: string };
export default function ProjectChanges(props: ChangesProps) {
  const project = props.state.projects?.find((p) => p.id === props.projectId);
  const [picked, pick] = useState<string>();
  const [working, setWorking] = useState<string | null>();
  const chatId = props.chatId && projectCapability(props.state, "project-folders-v1") ? props.chatId : undefined;
  useEffect(() => {
    if (!chatId) return;
    let live = true;
    api.chatProjectFolder(chatId).then((path) => { if (live) setWorking(path); }, () => { if (live) setWorking(null); });
    return () => { live = false; };
  }, [chatId, project?.folders?.join("\n")]);
  if (chatId && working === undefined) return null;
  const selected = picked ?? working;
  const folder = selected && project?.folders?.includes(selected) ? selected : project?.folder;
  return <><FolderChoice project={project} value={folder} change={pick} /><ChangesBody key={folder} {...props} folder={folder} /></>;
}
function ChangesBody({ state, projectId, close, folder }: ChangesProps & { folder?: string }) {
  const project = state.projects?.find((p) => p.id === projectId);
  const [changes, setChanges] = useState<Changes>();
  const [file, setFile] = useState("");
  const [diff, setDiff] = useState<{ text: string; truncated: boolean }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      setChanges(await api.projectChanges(projectId, folder));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    setFile("");
    setDiff(undefined);
  }, [projectId]);
  useEffect(() => {
    if (!file) return;
    setDiff(undefined);
    api
      .projectDiff(projectId, file, folder)
      .then(setDiff)
      .catch((e) => setError(String(e)));
  }, [file, projectId]);
  if (!project) return null;
  return (
    <section className="project-changes" aria-label="Project changes">
      <div className="pc-head">
        {file ? (
          <button aria-label="Back to files" onClick={() => setFile("")}>
            <ArrowLeft size={16} />
          </button>
        ) : (
          <FolderGit2 size={18} />
        )}
        <strong>{file || "Project Changes"}</strong>
        <span className="pc-actions">
          <button aria-label="Open folder" title={project.folder} onClick={() => api.revealProject(projectId, folder).catch((e) => setError(String(e)))}>
            <FolderOpen size={16} />
          </button>
          <button aria-label="Refresh changes" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={16} />
          </button>
          <button aria-label="Close changes" onClick={close}>
            <X size={16} />
          </button>
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {note && <p role="status">{note}</p>}
      {!changes ? (
        <p className="muted">Reading changes…</p>
      ) : !changes.repo ? (
        <p className="muted">{project.name} isn't a git repository, so there are no changes to show.</p>
      ) : file ? (
        diff ? (
          <>
            <DiffView text={diff.text || "No differences."} />
            {diff.truncated && <small>This diff is long; the rest is not shown.</small>}
          </>
        ) : (
          <p className="muted">Loading diff…</p>
        )
      ) : (
        <>
          <div className="pc-summary">
            <span>
              <GitBranch size={14} /> {changes.branch || "detached"}
              {changes.upstream && (
                <small>
                  {" "}
                  · {changes.ahead} ahead, {changes.behind} behind {changes.upstream}
                </small>
              )}
            </span>
            <span>
              {changes.files.length} {changes.files.length === 1 ? "file" : "files"} ·{" "}
              <b className="diff-add">+{changes.added}</b> <b className="diff-del">−{changes.removed}</b>
            </span>
          </div>
          {!changes.files.length ? (
            <p className="muted">Working tree clean.</p>
          ) : (
            <ul className="pc-files">
              {changes.files.map((f) => (
                <li key={f.path}>
                  <button onClick={() => setFile(f.path)}>
                    <span className={"pc-kind " + f.kind}>{f.kind[0].toUpperCase()}</span>
                    <span className="pc-path">{f.from ? f.from + " → " + f.path : f.path}</span>
                    <b className="diff-add">+{f.added}</b>
                    <b className="diff-del">−{f.removed}</b>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!!changes.files.length &&
            (committing ? (
              <form
                className="pc-commit"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const sha = await api.projectCommit(projectId, message, folder);
                    setNote("Committed " + sha + " on " + changes.branch + ".");
                    setMessage("");
                    setCommitting(false);
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Commit message
                  <textarea rows={2} required maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
                </label>
                <small>
                  Stages all {changes.files.length} changed files and commits them to {changes.branch}. Nothing is pushed.
                </small>
                <div className="actionrow">
                  <button type="button" onClick={() => setCommitting(false)}>
                    Cancel
                  </button>
                  <button className="primary" disabled={busy || !message.trim()}>
                    Commit all
                  </button>
                </div>
              </form>
            ) : (
              <button className="secondary" onClick={() => setCommitting(true)}>
                <GitCommitHorizontal size={16} /> Commit…
              </button>
            ))}
        </>
      )}
    </section>
  );
}
