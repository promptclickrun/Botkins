// A panel's notes in a space: short notes people write on a panel. The sheet is titled with the
// panel's title and lists its notes, each with its writer and a short age. A person who may act in
// the space writes one; a person removes their own, and the space's maker and the owner remove any.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ago, canRemoveNote, firstName, initial, type PanelView, type SpaceSummary } from "./spaces";

const api = window.botkins;
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const MAX = 2000;

export default function NotesSheet({
  space,
  panel,
  me,
  canWrite,
  close,
}: {
  space: SpaceSummary;
  /** The panel as last read: new notes come in when the space is read again. */
  panel: PanelView;
  /** "owner", or the member's id. */
  me: string;
  canWrite: boolean;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notes = panel.notes ?? [];
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(clean(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={ref} className="space-sheet space-notes-sheet" aria-label={panel.title} onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>{panel.title}</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <h3 className="space-notes-label">Notes</h3>
      {notes.length > 0 && (
        <ul className="space-note-list" aria-label="Notes">
          {notes.map((n) => (
            <li key={n.id}>
              <span className="space-person" aria-hidden="true">
                {initial(n.name)}
              </span>
              <div className="space-note-text">
                <span>
                  <strong>{firstName(n.name)}</strong>
                  <small>{ago(n.at)}</small>
                </span>
                <p>{n.text}</p>
              </div>
              {canRemoveNote(n, me, space) && (
                <button
                  type="button"
                  className="textbutton space-note-remove"
                  aria-label={"Remove the note from " + firstName(n.name)}
                  disabled={busy}
                  onClick={() => void run(() => api["spaces.removeNote"](panel.id, n.id))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form
          className="space-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            const said = text.trim();
            if (!said || busy) return;
            void run(() => api["spaces.note"](panel.id, said)).then((ok) => ok && setText(""));
          }}
        >
          <textarea
            rows={2}
            aria-label="Write a note"
            placeholder="Write a note"
            maxLength={MAX}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button className="primary" disabled={busy || !text.trim()}>
            Add
          </button>
        </form>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
