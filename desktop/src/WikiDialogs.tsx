// Dialogs for the Wiki section (src/Wiki.tsx): a new page, moving or renaming a page, and a page's history.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { History, X } from "lucide-react";
import { RichText } from "./RichText";
import type { WikiVersion } from "./types";
import { dateTime, fileOf, folderLabel, folderOf, slug } from "./wikiModel";

const api = window.botkins;

/** A modal dialog drawn as Botkins' dialogs are. Escape and Cancel close it. */
export function Modal({
  title,
  className,
  close,
  children,
}: {
  title: string;
  className?: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => from?.focus?.();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={"wiki-dialog" + (className ? " " + className : "")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>,
    document.body,
  );
}

function FolderSelect({ folders, value, change, label }: { folders: string[]; value: string; change: (v: string) => void; label: string }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => change(e.target.value)}>
        {folders.map((f) => (
          <option key={f} value={f}>
            {folderLabel(f)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** New page: a title and a section. Resolves with the new page's path. */
export function NewPageDialog({
  folders,
  folder,
  close,
  created,
}: {
  folders: string[];
  folder: string;
  close: () => void;
  created: (path: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [where, setWhere] = useState(folders.includes(folder) ? folder : (folders[0] ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="New page" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || busy) return;
          setBusy(true);
          setError("");
          api
            .createWikiPage({ folder: where, title: title.trim() })
            .then(created)
            .catch((err) => {
              setError(String(err?.message || err));
              setBusy(false);
            });
        }}
      >
        <h2>New page</h2>
        <p>The page starts from its section's outline. You can change everything.</p>
        <label>
          Title
          <input
            autoFocus
            required
            maxLength={120}
            value={title}
            placeholder="Such as Contoso or Q3 renewal"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <FolderSelect label="Section" folders={["", ...folders]} value={where} change={setWhere} />
        {error && (
          <p role="alert" className="wiki-form-error">
            {error}
          </p>
        )}
        <div className="ask-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!title.trim() || busy}>
            {busy ? "Creating…" : "Create page"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Move or rename a page: its section and its file name. Links to it follow. */
export function MoveDialog({
  path,
  title,
  folders,
  close,
  moved,
}: {
  path: string;
  title: string;
  folders: string[];
  close: () => void;
  moved: (path: string) => void;
}) {
  const [where, setWhere] = useState(folderOf(path));
  const [name, setName] = useState(fileOf(path).replace(/\.md$/i, ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = slug(name);
  const target = (where ? where + "/" : "") + file + ".md";
  return (
    <Modal title={"Move or rename “" + title + "”"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!file || busy) return;
          if (target === path) return close();
          setBusy(true);
          setError("");
          api
            .moveWiki(path, target)
            .then(moved)
            .catch((err) => {
              setError(String(err?.message || err));
              setBusy(false);
            });
        }}
      >
        <h2>Move or rename</h2>
        <p>Links to “{title}” follow it. Its title is its first heading.</p>
        <FolderSelect label="Section" folders={["", ...folders]} value={where} change={setWhere} />
        <label>
          File name
          <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} aria-describedby="wiki-move-hint" />
          <small id="wiki-move-hint" className="wiki-hint">
            {file ? "Saved as " + target : "Use letters or numbers."}
          </small>
        </label>
        {error && (
          <p role="alert" className="wiki-form-error">
            {error}
          </p>
        )}
        <div className="ask-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!file || busy}>
            {busy ? "Moving…" : "Move page"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Earlier versions of a page: pick one to see it, then restore it. */
export function HistoryDialog({ path, title, close, restored }: { path: string; title: string; close: () => void; restored: () => void }) {
  const [versions, setVersions] = useState<WikiVersion[]>();
  const [selected, setSelected] = useState("");
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .wikiHistory(path)
      .then((list) => {
        setVersions(list);
        if (list[0]) setSelected(list[0].id);
      })
      .catch((e) => setError(String(e?.message || e)));
  }, [path]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setText(undefined);
    api
      .wikiVersion(path, selected)
      .then((t) => live && setText(t))
      .catch((e) => live && setError(String(e?.message || e)));
    return () => {
      live = false;
    };
  }, [path, selected]);
  const label = (v: WikiVersion) => "Before " + (v.by === "You" ? "your" : v.by + "'s") + " change";
  return (
    <Modal title={"History of “" + title + "”"} className="wiki-history" close={close}>
      <div className="wiki-dialog-head">
        <h2>History</h2>
        <button type="button" className="wiki-icon-button" aria-label="Close" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <p className="wiki-muted">Earlier versions of “{title}”, as it was before each change.</p>
      {error && (
        <p role="alert" className="wiki-form-error">
          {error}
        </p>
      )}
      {!versions ? (
        !error && <p className="wiki-muted">Loading…</p>
      ) : !versions.length ? (
        <div className="wiki-empty">
          <History size={22} aria-hidden="true" />
          <p>No earlier versions yet.</p>
        </div>
      ) : (
        <div className="wiki-history-body">
          <ul className="wiki-history-list" role="listbox" aria-label="Versions">
            {versions.map((v) => (
              <li key={v.id}>
                <button type="button" role="option" aria-selected={v.id === selected} onClick={() => setSelected(v.id)}>
                  <span>{label(v)}</span>
                  <small>{dateTime(v.time)}</small>
                </button>
              </li>
            ))}
          </ul>
          <div className="wiki-history-preview" aria-label="Preview" role="region" tabIndex={0}>
            {text === undefined ? <p className="wiki-muted">Loading…</p> : <RichText text={text} />}
          </div>
        </div>
      )}
      <div className="ask-actions">
        <button type="button" className="secondary" onClick={close}>
          Close
        </button>
        {!!versions?.length && (
          <button
            type="button"
            className="primary"
            disabled={!selected || busy || text === undefined}
            onClick={() => {
              setBusy(true);
              api
                .restoreWikiVersion(path, selected)
                .then(restored)
                .catch((e) => {
                  setError(String(e?.message || e));
                  setBusy(false);
                });
            }}
          >
            {busy ? "Restoring…" : "Restore this version"}
          </button>
        )}
      </div>
    </Modal>
  );
}
