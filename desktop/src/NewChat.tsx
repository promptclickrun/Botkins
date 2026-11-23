import { useState } from "react";
import { ArrowRight, Users } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { ProjectPicker } from "./ProjectChanges";
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
  open,
  fail,
}: {
  state: State;
  /** Shows the new chat. */
  open: (id: string) => Promise<void>;
  fail: (e: unknown) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string>();
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
      if (project && picked.length && ids.length === picked.length) id = await api.startProjectChat(ids, project.id, project.folder ? mode : "default", folder);
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
  return (
    <>
      <p>Pick a bot. Tick bots to add a project or start a group chat.</p>
      <div className="chat-pick">
        {state.bots.map((b) => {
          const on = picked.includes(b.id);
          const full = !on && picked.length >= GROUP_MAX;
          return (
            <div className="rowwrap" key={b.id}>
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
                <ArrowRight size={16} />
              </button>
            </div>
          );
        })}
      </div>
      {picked.length > 0 && (
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
          <button className="primary" disabled={busy} onClick={() => void start(picked)}>
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
