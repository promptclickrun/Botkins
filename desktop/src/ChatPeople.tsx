// The people in a chat (the link's capability "team-people-v1"). A chat's people are whoever
// started it, plus those invited; its alerts go to them and nobody else. The chat header's
// "Invite" opens "People in this chat": a switch for each person on the team. Whoever started
// the chat, and the computer's owner, may invite and remove; an invited person may leave.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { canLeave, chatPeopleView } from "./peopleView";
import type { Chat, State, TeamPerson } from "./types";

const api = window.botkins;
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
export function PeopleDialog({ state, chat, close, left }: { state: State; chat: Chat; close: () => void; /** After "Leave chat": the chat is no longer this person's. */ left: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const view = chatPeopleView(state, chat);
  const [invited, setInvited] = useState<string[]>(chat.invited ?? []);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    api
      .chatPeople(chat.id)
      .then((answer) => live && (setInvited(answer.invited), setLoaded(true)))
      .catch((e) => live && (setError(clean(e)), setLoaded(true)));
    return () => {
      live = false;
    };
  }, [chat.id]);
  if (!view) return null;
  const { people, me, createdBy, mayInvite } = view;
  const mayLeave = canLeave(view, invited);
  async function set(person: TeamPerson, on: boolean) {
    setBusy(person.id);
    setError("");
    // The switch moves at once; the computer's answer is the list that counts, and a refusal moves it back.
    const before = invited;
    setInvited(on ? [...invited.filter((id) => id !== person.id), person.id] : invited.filter((id) => id !== person.id));
    try {
      setInvited(await (on ? api.inviteToChat(chat.id, person.id) : api.removeFromChat(chat.id, person.id)));
    } catch (e) {
      setInvited(before);
      setError(clean(e));
    } finally {
      setBusy("");
    }
  }
  async function leave() {
    setBusy(me);
    setError("");
    try {
      await api.removeFromChat(chat.id, me);
      left();
    } catch (e) {
      setError(clean(e));
      setBusy("");
    }
  }
  return (
    <dialog ref={ref} className="task-dialog pick-dialog people-dialog" aria-label="People in this chat" onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>People in this chat</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <p className="muted people-lede">Replies and questions in this chat go to these people only.</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <ul className="edit-list pick-list people-list" aria-label="People">
        {people.map((person) => {
          const started = person.id === createdBy;
          const inChat = started || invited.includes(person.id);
          // The owner is listed under the computer's name; whoever is looking is simply "You".
          const label = person.id === me ? "You" : person.name;
          return (
            <li key={person.id}>
              <span className="grow">
                <strong>{label}</strong>
                <small>{started ? "Started this chat" : inChat ? "Invited" : "Not in this chat"}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                aria-label={label}
                checked={inChat}
                // Whoever started the chat is always in it. Others are changed by the starter or the owner.
                disabled={started || !mayInvite || !loaded || !!busy}
                onChange={(e) => void set(person, e.target.checked)}
              />
            </li>
          );
        })}
      </ul>
      <div className="ask-actions">
        {mayLeave && (
          <button type="button" className="secondary danger" disabled={!!busy} onClick={() => void leave()}>
            Leave chat
          </button>
        )}
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
