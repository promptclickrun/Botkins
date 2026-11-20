// The wiki's page editor: a formatting toolbar over a rich Markdown editor (src/wikiEditorCore.ts).
// src/Wiki.tsx loads this file on demand, so chats never load the editor.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bold, BookOpen, Code, Italic, Link, List, ListChecks, ListOrdered, Quote, Redo2, Strikethrough, Table, Undo2 } from "lucide-react";
import { createWikiEditor, type Active, type Block, type Command, type WikiEditorHandle } from "./wikiEditorCore";

export type PageChoice = { path: string; title: string; section: string };

const BLOCKS: [Block, string][] = [
  ["paragraph", "Text"],
  ["h1", "Title"],
  ["h2", "Heading"],
  ["h3", "Subheading"],
  ["h4", "Small heading"],
];
const mac = navigator.platform.toLowerCase().includes("mac");
const key = (k: string) => (mac ? "⌘" + k : "Ctrl+" + k);

/**
 * The editor for one page. `changed` gets the page's Markdown after each edit; `ready` gets the
 * Markdown as the editor first writes it, which is the text "no changes" compares with.
 */
export default function WikiEditor({
  markdown,
  label,
  pages,
  changed,
  ready,
  save,
  failed,
}: {
  markdown: string;
  label: string;
  pages: PageChoice[];
  changed: (markdown: string) => void;
  ready: (markdown: string, handle: WikiEditorHandle) => void;
  /** Cmd/Ctrl+S. */
  save: () => void;
  failed: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<WikiEditorHandle>(undefined);
  const [active, setActive] = useState<Active>({ block: "paragraph", bold: false, italic: false, strike: false, link: false });
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const pickButton = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ changed, ready, save, failed });
  callbacks.current = { changed, ready, save, failed };
  useEffect(() => {
    let live = true;
    let made: WikiEditorHandle | undefined;
    const follow = () => made && setActive(made.active());
    createWikiEditor(host.current!, markdown, {
      label,
      changed: (next) => {
        callbacks.current.changed(next);
        follow();
      },
      selection: follow,
    })
      .then((handle) => {
        made = handle;
        if (!live) return void handle.destroy();
        editor.current = handle;
        setLoading(false);
        follow();
        callbacks.current.ready(handle.markdown(), handle);
        handle.focus();
      })
      .catch((e) => live && callbacks.current.failed(String(e?.message || e)));
    return () => {
      live = false;
      editor.current = undefined;
      void made?.destroy();
    };
    // The editor is made once; a new text remounts this component (see its key in src/Wiki.tsx).
  }, []);
  const run = (command: Command) => {
    editor.current?.run(command);
    if (editor.current) setActive(editor.current.active());
  };
  function keys(e: ReactKeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      callbacks.current.save();
    } else if (e.defaultPrevented) return;
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
      e.preventDefault();
      run("link");
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPicking(true);
    }
  }
  const tool = (command: Command, title: string, icon: ReactNode, pressed?: boolean) => (
    <button
      type="button"
      className="wiki-tool"
      aria-label={title}
      title={title}
      aria-pressed={pressed}
      disabled={loading}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => run(command)}
    >
      {icon}
    </button>
  );
  return (
    <div className="wiki-editor" onKeyDown={keys}>
      <Toolbar>
        <select
          className="wiki-block-select"
          aria-label="Text style"
          disabled={loading}
          value={active.block === "other" ? "" : active.block}
          onChange={(e) => run(e.target.value as Block)}
        >
          {active.block === "other" && <option value="">—</option>}
          {BLOCKS.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <span className="wiki-tool-gap" />
        {tool("bold", "Bold (" + key("B") + ")", <Bold size={16} />, active.bold)}
        {tool("italic", "Italic (" + key("I") + ")", <Italic size={16} />, active.italic)}
        {tool("strike", "Strikethrough", <Strikethrough size={16} />, active.strike)}
        <span className="wiki-tool-gap" />
        {tool("bullets", "Bulleted list", <List size={16} />)}
        {tool("numbers", "Numbered list", <ListOrdered size={16} />)}
        {tool("tasks", "Checklist", <ListChecks size={16} />)}
        <span className="wiki-tool-gap" />
        {tool("quote", "Quote", <Quote size={16} />)}
        {tool("code", "Code block", <Code size={16} />)}
        {tool("table", "Table", <Table size={16} />)}
        <span className="wiki-tool-gap" />
        {tool("link", "Web link (" + key("K") + ")", <Link size={16} />, active.link)}
        <span className="wiki-pick-anchor">
          <button
            ref={pickButton}
            type="button"
            className="wiki-tool wiki-tool-text"
            aria-haspopup="dialog"
            aria-expanded={picking}
            disabled={loading}
            title={"Link to a wiki page (" + (mac ? "⇧⌘K" : "Ctrl+Shift+K") + ")"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPicking((p) => !p)}
          >
            <BookOpen size={16} />
            Link to page
          </button>
          {picking && pickButton.current && (
            <PagePicker
              anchor={pickButton.current}
              pages={pages}
              close={() => {
                setPicking(false);
                editor.current?.focus();
              }}
              pick={(p) => {
                setPicking(false);
                editor.current?.insertLink(p.path, p.title);
              }}
            />
          )}
        </span>
        <span className="wiki-tool-spacer" />
        {tool("undo", "Undo (" + key("Z") + ")", <Undo2 size={16} />)}
        {tool("redo", "Redo (" + (mac ? "⇧⌘Z" : "Ctrl+Y") + ")", <Redo2 size={16} />)}
      </Toolbar>
      <div className="wiki-editor-surface" ref={host} aria-busy={loading} />
      {loading && <p className="wiki-muted wiki-editor-loading">Opening the editor…</p>}
    </div>
  );
}

/** A toolbar: one tab stop, arrow keys move between its controls. */
function Toolbar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const items = () => [...(bar.current?.querySelectorAll<HTMLElement>(":scope > button, :scope > select, :scope > span > button") ?? [])];
  useEffect(() => {
    items().forEach((el, i) => (el.tabIndex = i === at ? 0 : -1));
  });
  return (
    <div
      ref={bar}
      className="wiki-toolbar"
      role="toolbar"
      aria-label="Formatting"
      onFocus={(e) => {
        const i = items().indexOf(e.target as HTMLElement);
        if (i >= 0) setAt(i);
      }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLSelectElement && (e.key === "ArrowDown" || e.key === "ArrowUp")) return;
        const list = items().filter((el) => !(el as HTMLButtonElement).disabled);
        const i = list.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        const next =
          e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
        if (next === null) return;
        e.preventDefault();
        list[(next + list.length) % list.length]?.focus();
      }}
    >
      {children}
    </div>
  );
}

/** Choose a page to link to: a search field over a list of pages. */
function PagePicker({
  anchor,
  pages,
  pick,
  close,
}: {
  anchor: HTMLElement;
  pages: PageChoice[];
  pick: (p: PageChoice) => void;
  close: () => void;
}) {
  const id = useId();
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const shown = pages
    .filter((p) => !q || p.title.toLowerCase().includes(q) || p.section.toLowerCase().includes(q) || p.path.includes(q))
    .slice(0, 60);
  const index = Math.min(at, Math.max(0, shown.length - 1));
  // Drawn over the page under its button, kept inside the window.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const box_ = box.current!.getBoundingClientRect();
    const below = r.bottom + 6;
    setPos({
      left: Math.max(8, Math.min(r.left, innerWidth - box_.width - 8)),
      top: below + box_.height > innerHeight - 8 && r.top - box_.height - 6 >= 8 ? r.top - box_.height - 6 : below,
    });
  }, [anchor]);
  useEffect(() => {
    const away = (e: Event) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) close();
    };
    const gone = () => close();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    };
  }, [anchor, close]);
  useEffect(() => {
    document.getElementById(id + "-o" + index)?.scrollIntoView({ block: "nearest" });
  }, [id, index]);
  return createPortal(
    <div className="wiki-picker" role="dialog" aria-label="Link to a wiki page" ref={box} style={pos}>
      <input
        autoFocus
        type="search"
        role="combobox"
        aria-label="Find a page"
        aria-controls={id + "-list"}
        aria-expanded="true"
        aria-activedescendant={shown.length ? id + "-o" + index : undefined}
        placeholder="Find a page"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = shown.length;
            if (n) setAt((index + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[index]) pick(shown[index]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <div className="wiki-picker-list" role="listbox" id={id + "-list"} aria-label="Pages">
        {shown.map((p, i) => (
          <button
            type="button"
            role="option"
            key={p.path}
            id={id + "-o" + i}
            tabIndex={-1}
            aria-selected={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setAt(i)}
            onClick={() => pick(p)}
          >
            <span>{p.title}</span>
            <small>{p.section}</small>
          </button>
        ))}
        {!shown.length && <p className="wiki-muted">{pages.length ? "No matching pages" : "No pages yet"}</p>}
      </div>
    </div>,
    document.body,
  );
}
