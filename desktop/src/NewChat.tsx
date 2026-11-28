import { useState } from "react";
import { ArrowRight, Users } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { ProjectPicker } from "./ProjectChanges";
import { canUseProject } from "./access";
import type { ChatMode, State } from "./types";
import "./groups.css";

const api = window.botkins;
const GROUP_MAX = 6;

/**
 * The New chat dialog's body. Clicking a bot starts a chat with it at once, as before.
 * Ticking bots sets up more: a project for the chat, and with two to six bots, a group chat.
 */
export default function NewChat({
  state,
  project: preset,
  open,
  fail,
}: {
  state: State;
  /** A project the chat is made in, chosen before the dialog opened (a project's Chats). Only bots that may use it are offered. */
  project?: string;
  /** Shows the new chat. */
  open: (id: string) => Promise<void>;
  fail: (e: unknown) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(preset);
  const [folder, setFolder] = useState<string>();
  const [mode, setMode] = useState<ChatMode>("default");
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < GROUP_MAX ? [...p, id] : p));
  async function start(ids: string[]) {
    if (busy) return;
    setBusy(true);
    try {
      let id: string;
      // A chat in a project is made with it, so the backend checks every bot's access first
      // and the session opens in the project's folder.
      const project = state.projects?.find((p) => p.id === projectId);
      // A project picked before the dialog opened applies to any start; the bot's own settings say what it may do.
      if (project && preset) id = await api.startProjectChat(ids, project.id);
      else if (project && picked.length && ids.length === picked.length) id = await api.startProjectChat(ids, project.id, project.folder ? mode : "default", folder);
      else if (ids.length > 1) id = await api.createGroupChat(ids);
      else id = await api.createChat(ids[0]);
      await open(id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const group = picked.length > 1;
  const fixed = preset ? state.projects?.find((p) => p.id === preset) : undefined;
  // In a project, only the bots that may use it.
  const bots = fixed ? state.bots.filter((b) => canUseProject(state, b, fixed)) : state.bots;
  return (
    <>
      <p className="chat-pick-intro">{fixed ? "Pick a bot. Tick bots to start a group chat." : "Pick a bot. Tick bots to add a project or start a group chat."}</p>
      {/* The bots as rows of one card: the tick box picks, the row starts a chat at once. */}
      {fixed && !bots.length && <p className="muted">No bot can use {fixed.name} yet. Give one access on the project's Access tab.</p>}
      <div className="chat-pick group">
        {bots.map((b) => {
          const on = picked.includes(b.id);
          const full = !on && picked.length >= GROUP_MAX;
          return (
            <div className={"rowwrap group-row" + (on ? " selected" : "")} key={b.id}>
              <input
                type="checkbox"
                aria-label={"Pick " + b.name}
                checked={on}
                disabled={full}
                title={full ? "A group chat holds up to 6 bots" : undefined}
                onChange={() => toggle(b.id)}
              />
              <button className="row" disabled={busy} onClick={() => void start([b.id])}>
                <BotAvatar bot={b} size={40} />
                <span className="rowtext">
                  <strong>{b.name}</strong>
                  <small>{b.role}</small>
                </span>
                <ArrowRight size={16} className="row-chevron" />
              </button>
            </div>
          );
        })}
      </div>
      {picked.length > 0 && !fixed && (
        <ProjectPicker
          state={state}
          botIds={picked}
          projectId={projectId}
          mode={mode}
          folder={folder}
          change={(p, m, path) => {
            setFolder(path);
            setProjectId(p);
            setMode(m);
          }}
          fail={fail}
        />
      )}
      {picked.length > 0 && (
        <div className="chat-pick-actions">
          <small>
            {group
              ? picked.length + " bots answer in turn. Group chats are text only."
              : "1 bot picked. Tick another to make a group chat."}
          </small>
          <button className="btn primary" disabled={busy} onClick={() => void start(picked)}>
            {group ? (
              <>
                <Users size={16} /> Start group chat
              </>
            ) : (
              "Start chat"
            )}
          </button>
        </div>
      )}
    </>
  );
}
