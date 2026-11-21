import { storageKey } from "./storage";
// The Wiki section: shared Markdown pages about goals, projects and people (desktop/wiki.mjs).
// A side menu of sections and pages, a page in read or edit mode, and what links to it.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Ellipsis,
  FileText,
  FilePlus2,
  Folder,
  FolderKanban,
  FolderPlus,
  FolderInput,
  FileDown,
  History,
  House,
  LayoutTemplate,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Inbox,
} from "lucide-react";
import { RichText, type LinkRenderer } from "./RichText";
import { useAsk, useMenu, type MenuItem } from "./Pages";
import { HistoryDialog, MoveDialog, NewPageDialog } from "./WikiDialogs";
import WikiExportDialog from "./WikiExport";
import type { PageChoice } from "./WikiEditor";
import type { WikiEditorHandle } from "./wikiEditorCore";
import type { State, WikiPage, WikiPageInfo, WikiTree } from "./types";
import {
  GUIDE,
  LOG,
  byTitle,
  folderOf,
  fromTemplate,
  humanize,
  listed,
  pagesIn,
  plural,
  pageLookup,
  resolveLink,
  sectionOf,
  sections,
  slug,
  templateOf,
  when,
} from "./wikiModel";
import "./wiki.css";

const WikiEditor = lazy(() => import("./WikiEditor"));
const api = window.botkins;
const CHANGED = /changed while you were editing/i;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type WikiTarget = { path?: string; n: number };
type View = { kind: "home" } | { kind: "page"; path: string } | { kind: "section"; folder: string } | { kind: "activity" };
/** An open editor: the text it started from, its `base` for saving, and the latest text. */
type Edit = {
  path: string;
  base: string;
  /** The text the editor loaded. A new value remounts the editor. */
  text: string;
  n: number;
  /** The Markdown as the editor first wrote it; "changed" compares with this. */
  baseline?: string;
  draft?: string;
  /** Someone else saved the page since the editor opened. */
  elsewhere?: boolean;
  /** Saving found the page changed: keep mine or load theirs. */
  conflict?: boolean;
  saving?: boolean;
  /** The text is an unsaved draft brought back from an earlier visit, so it counts as changed from the start. */
  restored?: boolean;
};

// Unsaved edits are kept in the browser's storage as they are typed. Closing the window or quitting
// with a page open in the editor therefore loses nothing: the Wiki offers the draft back next time.
const DRAFT = storageKey("wiki.draft");
type Kept = { path: string; base: string; text: string; time: number };
function readDraft(): Kept | undefined {
  try {
    const kept = JSON.parse(localStorage.getItem(DRAFT) ?? "null");
    return kept && typeof kept.path === "string" && typeof kept.text === "string" && typeof kept.base === "string" ? kept : undefined;
  } catch {
    return undefined;
  }
}
function writeDraft(kept: Kept) {
  try {
    localStorage.setItem(DRAFT, JSON.stringify(kept));
  } catch {
    // Storage is full or unavailable: the draft is simply not kept.
  }
}
function dropDraft() {
  try {
    localStorage.removeItem(DRAFT);
  } catch {}
}

export default function Wiki({
  state,
  target,
  openProject,
  startChat,
  guard,
}: {
  state: State;
  target: WikiTarget;
  openProject: (id: string) => void;
  /** A new chat with the primary bot, with this text (and a page mention) waiting to be sent. */
  startChat: (text: string, page?: { path: string; title: string }) => void;
  /** Asks before the person leaves the Wiki with unsaved changes; null when there are none. */
  guard: (ask: (() => Promise<boolean>) | null) => void;
}) {
  const [tree, setTree] = useState<WikiTree>();
  const [treeError, setTreeError] = useState("");
  const [view, setView] = useState<View>(target.path ? { kind: "page", path: target.path } : { kind: "home" });
  const [page, setPage] = useState<WikiPage>();
  const [pageError, setPageError] = useState("");
  const [edit, setEdit] = useState<Edit>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ path: string; title: string; snippet: string }[]>();
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const dialogs = useAsk();
  const menu = useMenu();
  const revision = state.wiki?.revision ?? 0;
  const editor = useRef<WikiEditorHandle>(undefined);
  const editing = !!edit;
  const editRef = useRef(edit);
  editRef.current = edit;
  const dirty = !!edit && edit.draft !== undefined && edit.baseline !== undefined && (edit.restored || edit.draft !== edit.baseline);
  // An unsaved draft from an earlier visit, offered back while no page is being edited.
  const [kept, setKept] = useState<Kept | undefined>(readDraft);
  const unsaved = dirty && edit.draft !== undefined ? { path: edit.path, base: edit.base, text: edit.draft } : undefined;
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  useEffect(() => {
    if (!unsaved) return;
    // Shortly after each change, and at once when the window goes away.
    const timer = window.setTimeout(() => writeDraft({ ...unsaved, time: Date.now() }), 300);
    return () => window.clearTimeout(timer);
  }, [unsaved?.path, unsaved?.text]);
  useEffect(() => {
    const flush = () => {
      if (unsavedRef.current) writeDraft({ ...unsavedRef.current, time: Date.now() });
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);
  const fail = (e: unknown) => setError(message(e));
  // After the editor closes, focus goes back to Edit.
  const refocus = useRef(false);
  const backToEdit = () => (refocus.current = true);
  useEffect(() => {
    if (edit || !refocus.current) return;
    const button = document.querySelector<HTMLElement>(".wiki-page-head .wiki-edit");
    if (!button) return;
    refocus.current = false;
    button.focus();
  });

  // ---------------------------------------------------------------- data
  const loadTree = useCallback(() => {
    api
      .wikiTree()
      .then((t) => {
        setTree(t);
        setTreeError("");
      })
      .catch((e) => setTreeError(message(e)));
  }, []);
  useEffect(loadTree, [revision, loadTree]);
  const pagePath = view.kind === "page" ? view.path : view.kind === "activity" ? LOG : "";
  // The open page follows changes made elsewhere, except while it is being edited.
  useEffect(() => {
    if (!pagePath) {
      setPage(undefined);
      return;
    }
    let live = true;
    api
      .wikiPage(pagePath)
      .then((p) => {
        if (!live) return;
        const open = editRef.current;
        if (open && open.path === p.path) {
          if (p.base !== open.base) setEdit((e) => (e && e.path === p.path && e.base === open.base ? { ...e, elsewhere: true } : e));
          return;
        }
        setPage(p);
        setPageError("");
      })
      .catch((e) => {
        if (!live || editRef.current) return;
        setPage(undefined);
        setPageError(message(e));
      });
    return () => {
      live = false;
    };
    // Re-read on a new page or a wiki change, not when the edit's draft changes.
  }, [pagePath, revision, editing]);

  // Search runs a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(undefined);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api
        .searchWiki(q)
        .then((r) => live && setResults(r))
        .catch((e) => live && fail(e));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, revision]);

  // ---------------------------------------------------------------- leaving with changes
  const confirmDiscard = useCallback(
    () =>
      dialogs
        .ask({ title: "Discard your changes?", body: "Your edits to this page haven't been saved.", confirm: "Discard", danger: true })
        .then((ok) => {
          if (ok) dropDraft();
          return !!ok;
        }),
    [dialogs],
  );
  const confirmRef = useRef(confirmDiscard);
  confirmRef.current = confirmDiscard;
  useEffect(() => {
    if (!dirty) return;
    guard(() => confirmRef.current());
    return () => guard(null);
  }, [dirty]);

  /** Goes to another view, asking first when there are unsaved changes. */
  async function go(next: View, options: { keepQuery?: boolean } = {}) {
    if (dirty && !(await confirmDiscard())) return false;
    setEdit(undefined);
    editor.current = undefined;
    setError("");
    setNotice("");
    if (!options.keepQuery) setQuery("");
    if (next.kind === "page" && (next.path === LOG || next.path === "log.md")) next = { kind: "activity" };
    if (next.kind !== "page" || next.path !== pagePath) setPage(undefined);
    setPageError("");
    setView(next);
    if (next.kind === "page") {
      const section = sectionOf(next.path);
      if (section) setOpen((o) => ({ ...o, [section]: true }));
    }
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".wiki-main")?.scrollTo({ top: 0 }));
    return true;
  }
  const openPage = (path: string) => void go({ kind: "page", path });

  // ---------------------------------------------------------------- editing
  async function startEdit(path: string) {
    try {
      const p = await api.wikiPage(path);
      if (p.generated) return;
      setPage(p);
      setEdit({ path: p.path, base: p.base, text: p.content, n: Date.now() });
    } catch (e) {
      fail(e);
    }
  }
  async function save(force = false) {
    if (!edit || edit.saving) return;
    const text = editor.current?.markdown() ?? edit.draft;
    if (text === undefined) return;
    if (!force && edit.draft === edit.baseline && !edit.elsewhere && !edit.restored) {
      // Nothing changed: leave the page as it is on disk.
      setEdit(undefined);
      backToEdit();
      return;
    }
    if (!text.trim()) {
      setError("A page needs some text. To remove a page, use Delete in its menu.");
      return;
    }
    setEdit((e) => e && { ...e, saving: true });
    try {
      const saved = await api.saveWikiPage(edit.path, text, force ? undefined : edit.base);
      dropDraft();
      setPage(saved);
      setEdit(undefined);
      setError("");
      setNotice("Saved.");
      loadTree();
      backToEdit();
    } catch (e) {
      if (CHANGED.test(message(e))) setEdit((x) => x && { ...x, saving: false, conflict: true });
      else {
        setEdit((x) => x && { ...x, saving: false });
        fail(e);
      }
    }
  }
  async function loadTheirs() {
    if (!edit) return;
    try {
      const p = await api.wikiPage(edit.path);
      setPage(p);
      setEdit({ path: p.path, base: p.base, text: p.content, n: Date.now() });
    } catch (e) {
      fail(e);
    }
  }
  async function cancelEdit() {
    if (dirty && !(await confirmDiscard())) return;
    setEdit(undefined);
    backToEdit();
  }
  /** Opens the editor on a draft kept from an earlier visit. Saving still checks whether the page changed since. */
  async function restoreDraft(draft: Kept) {
    if (!(await go({ kind: "page", path: draft.path }))) return;
    try {
      const p = await api.wikiPage(draft.path);
      setPage(p);
      setEdit({ path: p.path, base: draft.base, text: draft.text, n: Date.now(), restored: true, elsewhere: p.base !== draft.base });
      setKept(undefined);
    } catch (e) {
      fail(e);
    }
  }

  // ---------------------------------------------------------------- changes
  // Finds a page by path in any letter case; the guide, the log and the index are pages too.
  const exists = useMemo(() => pageLookup([...(tree?.pages.map((p) => p.path) ?? []), GUIDE, LOG, "index.md"]), [tree]);
  const titleOf = (path: string) => tree?.pages.find((p) => p.path === path)?.title ?? humanize(path.split("/").pop() ?? path);

  /** Creates a page where a link expects it, from its section's outline, then opens it to edit. */
  async function createAt(path: string, label: string) {
    const section = sectionOf(path);
    const ok = await dialogs.ask({
      title: "Create “" + label + "”?",
      body:
        "There's no page for this link yet. It will be created " +
        (section ? "in " + humanize(section) : "at the top of the wiki") +
        " so the link works.",
      confirm: "Create page",
    });
    if (!ok || !tree) return;
    try {
      // A page made meanwhile is opened, not overwritten.
      const there = await api.wikiPage(path).then(
        () => true,
        () => false,
      );
      if (!there) {
        const template = section ? templateOf(tree, section) : undefined;
        const outline = template ? (await api.wikiPage(template.path)).content : undefined;
        await api.saveWikiPage(path, fromTemplate(outline, label));
      }
      if (await go({ kind: "page", path })) await startEdit(path);
    } catch (e) {
      fail(e);
    }
  }
  async function remove(info: { path: string; title: string }) {
    const ok = await dialogs.ask({
      title: "Delete “" + info.title + "”?",
      body: "The page is removed from the wiki. Links to it will show as not created yet.",
      confirm: "Delete page",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteWiki(info.path);
      setEdit(undefined);
      const folder = folderOf(info.path);
      await go(folder ? { kind: "section", folder } : { kind: "home" });
      setNotice("“" + info.title + "” was deleted.");
    } catch (e) {
      fail(e);
    }
  }
  async function newSection() {
    const name = await dialogs.ask({
      title: "New section",
      body: "A section groups pages of one kind, such as Projects or Meetings.",
      confirm: "Create section",
      field: { label: "Section name", value: "", max: 60 },
    });
    if (!name) return;
    try {
      const folder = await api.createWikiFolder({ parent: "", name });
      loadTree();
      await go({ kind: "section", folder });
    } catch (e) {
      fail(e);
    }
  }
  async function renameSection(folder: string) {
    const name = await dialogs.ask({
      title: "Rename “" + humanize(folder.split("/").pop()!) + "”",
      body: "Links to its pages are updated.",
      confirm: "Rename",
      field: { label: "Section name", value: humanize(folder.split("/").pop()!), max: 60 },
    });
    if (!name || !slug(name)) return;
    const next = (folderOf(folder) ? folderOf(folder) + "/" : "") + slug(name);
    if (next === folder) return;
    try {
      const moved = await api.moveWiki(folder, next);
      loadTree();
      setOpen((o) => ({ ...o, [moved]: true }));
      if (view.kind === "section" && view.folder === folder) setView({ kind: "section", folder: moved });
      else if (view.kind === "page" && view.path.startsWith(folder + "/"))
        setView({ kind: "page", path: moved + view.path.slice(folder.length) });
    } catch (e) {
      fail(e);
    }
  }
  async function deleteSection(folder: string) {
    if (!tree) return;
    const count = pagesIn(tree, folder).length;
    const ok = await dialogs.ask({
      title: "Delete the section “" + humanize(folder.split("/").pop()!) + "”?",
      body: count ? "Its " + plural(count, "page") + " will be deleted with it." : "It has no pages.",
      confirm: count ? "Delete section and pages" : "Delete section",
      danger: true,
    });
    if (!ok) return;
    try {
      if (view.kind === "page" && view.path.startsWith(folder + "/") && dirty) setEdit(undefined);
      await api.deleteWiki(folder);
      await go({ kind: "home" });
      setNotice(humanize(folder.split("/").pop()!) + " was deleted.");
    } catch (e) {
      fail(e);
    }
  }
  async function editTemplate(folder: string) {
    const path = folder + "/_template.md";
    try {
      if (!tree?.pages.some((p) => p.path === path))
        await api.saveWikiPage(path, "# {{title}}\n\n_One sentence on what this page is about._\n");
      if (await go({ kind: "page", path })) await startEdit(path);
    } catch (e) {
      fail(e);
    }
  }
  function newPage(folder = currentFolder()) {
    if (!tree) return;
    setDialog(
      <NewPageDialog
        folders={tree.folders}
        folder={folder}
        close={() => setDialog(null)}
        created={async (path) => {
          setDialog(null);
          loadTree();
          if (await go({ kind: "page", path })) await startEdit(path);
        }}
      />,
    );
  }
  function currentFolder() {
    if (view.kind === "section") return view.folder;
    if (view.kind === "page" && view.path !== GUIDE) return folderOf(view.path);
    return "";
  }
  async function addSuggested() {
    if (!tree) return;
    const all = tree.suggested.projects.map((p) => ({ kind: "project" as const, id: p.id }));
    let made = 0;
    try {
      for (const record of all) {
        await api.createWikiPageFor(record);
        made++;
      }
      setNotice("Added " + plural(made, "page") + ".");
    } catch (e) {
      fail(e);
    } finally {
      loadTree();
    }
  }

  function sectionMenu(folder: string): MenuItem[] {
    return [
      { label: "New page", icon: FilePlus2, run: () => newPage(folder) },
      { label: "New folder inside…", icon: FolderPlus, run: () => void newFolderIn(folder) },
      "separator",
      { label: "Rename…", icon: Pencil, run: () => void renameSection(folder) },
      ...(!folder.includes("/") ? [{ label: "Edit template", icon: LayoutTemplate, run: () => void editTemplate(folder) }] : []),
      "separator",
      { label: "Delete…", icon: Trash2, danger: true, run: () => void deleteSection(folder) },
    ];
  }
  async function newFolderIn(parent: string) {
    const name = await dialogs.ask({
      title: "New folder in " + humanize(parent.split("/").pop()!),
      confirm: "Create folder",
      field: { label: "Folder name", value: "", max: 60 },
    });
    if (!name) return;
    try {
      const folder = await api.createWikiFolder({ parent, name });
      loadTree();
      setOpen((o) => ({ ...o, [parent]: true, [folder]: true }));
    } catch (e) {
      fail(e);
    }
  }
  /** Export…: the whole wiki, or starting from a page (a project's page exports with what is related). */
  function exportFrom(start?: string) {
    if (!tree) return;
    setDialog(<WikiExportDialog tree={tree} start={start} close={() => setDialog(null)} />);
  }
  function pageMenu(p: WikiPage): MenuItem[] {
    const guide = p.path === GUIDE;
    return [
      ...(!guide && !p.template
        ? [
            {
              label: "Move or rename…",
              icon: FolderInput,
              run: () =>
                setDialog(
                  <MoveDialog
                    path={p.path}
                    title={p.title}
                    folders={tree?.folders ?? []}
                    close={() => setDialog(null)}
                    moved={(path) => {
                      setDialog(null);
                      loadTree();
                      openPage(path);
                    }}
                  />,
                ),
            } satisfies MenuItem,
          ]
        : []),
      {
        label: "History",
        icon: History,
        run: () =>
          setDialog(
            <HistoryDialog
              path={p.path}
              title={p.title}
              close={() => setDialog(null)}
              restored={() => {
                setDialog(null);
                setNotice("The earlier version was restored.");
                api.wikiPage(p.path).then(setPage, fail);
              }}
            />,
          ),
      },
      { label: "Show in Finder", icon: Folder, run: () => void api.revealWiki(p.path).catch(fail) },
      ...(!p.template ? [{ label: "Export…", icon: FileDown, run: () => exportFrom(p.path) } satisfies MenuItem] : []),
      ...(!guide
        ? [
            "separator" as const,
            { label: p.template ? "Delete template…" : "Delete…", icon: Trash2, danger: true, run: () => void remove(p) },
          ]
        : []),
    ];
  }

  // ---------------------------------------------------------------- links in a page
  const link: LinkRenderer = useCallback(
    (href, children) => {
      const from = page?.path ?? "";
      const hit = resolveLink(from, href, exists);
      if (!hit) return <span>{children}</span>;
      if (hit.exists)
        return (
          <a
            href={"#" + hit.path}
            className="wiki-link"
            title={titleOf(hit.path)}
            onClick={(e) => {
              e.preventDefault();
              openPage(hit.path);
            }}
          >
            {children}
          </a>
        );
      // A page that was never written; in the activity log it may be one that was removed.
      if (page?.generated) return <span className="wiki-link gone">{children}</span>;
      const label = page?.missing.find((m) => m.path === hit.path)?.label || humanize(hit.path.split("/").pop()!);
      return (
        <a
          href={"#" + hit.path}
          className="wiki-link missing"
          title="Not created yet. Click to create it."
          onClick={(e) => {
            e.preventDefault();
            void createAt(hit.path, label);
          }}
        >
          {children}
          <span className="sr-only"> (not created yet)</span>
        </a>
      );
    },
    [page, exists, tree],
  );

  // ---------------------------------------------------------------- render
  const pages = tree ? listed(tree) : [];
  const choices: PageChoice[] = useMemo(
    () =>
      (tree ? listed(tree) : [])
        .filter((p) => p.path !== edit?.path)
        .sort(byTitle)
        .map((p) => ({ path: p.path, title: p.title, section: p.path === GUIDE ? "Guide" : humanize(sectionOf(p.path) || "Wiki") })),
    [tree, edit?.path],
  );
  const showing = view.kind !== "home" || !!query.trim();
  let main: ReactNode;
  if (query.trim())
    main = <SearchResults query={query.trim()} results={results} open={(p) => void go({ kind: "page", path: p })} tree={tree} />;
  else if (!tree)
    main = treeError ? <Problem text={treeError} retry={loadTree} /> : <p className="wiki-muted wiki-pad">Loading the wiki…</p>;
  else if (view.kind === "home")
    main = (
      <Home
        tree={tree}
        state={state}
        open={openPage}
        openSection={(folder) => void go({ kind: "section", folder })}
        newPage={() => newPage("")}
        exportWiki={() => exportFrom()}
        addSuggested={addSuggested}
        startChat={startChat}
      />
    );
  else if (view.kind === "section")
    main = (
      <SectionView
        tree={tree}
        folder={view.folder}
        open={openPage}
        openFolder={(folder) => void go({ kind: "section", folder })}
        home={() => void go({ kind: "home" })}
        newPage={() => newPage(view.folder)}
        menu={(e) => menu.show(e, humanize(view.folder) + " options", sectionMenu(view.folder))}
      />
    );
  else if (pageError) main = <Problem text={pageError} retry={() => void go(view)} home={() => void go({ kind: "home" })} />;
  else if (!page) main = <p className="wiki-muted wiki-pad">Opening the page…</p>;
  else
    main = (
      <div className={"wiki-page" + (edit ? " editing" : "")}>
        <div className="wiki-page-head">
          <Crumbs
            page={page}
            home={() => void go({ kind: "home" })}
            section={(folder) => void go({ kind: "section", folder })}
            activity={view.kind === "activity"}
          />
          {!edit && !page.generated && (
            <div className="wiki-actions">
              <span className="wiki-updated">Updated {when(page.updatedAt)}</span>
              {!page.template && page.path !== GUIDE && (
                <button
                  type="button"
                  className="secondary wiki-ask"
                  title="Ask about this page"
                  aria-label="Ask about this page"
                  onClick={() => startChat("", { path: page.path, title: page.title })}
                >
                  <MessageSquarePlus size={15} />
                  <span>Ask about this page</span>
                </button>
              )}
              <button type="button" className="primary wiki-edit" onClick={() => void startEdit(page.path)}>
                <Pencil size={14} />
                Edit
              </button>
              <button
                type="button"
                className="wiki-icon-button menu-button"
                aria-label="More for this page"
                aria-haspopup="menu"
                onClick={(e) => menu.show(e, "Page options", pageMenu(page))}
              >
                <Ellipsis size={17} />
              </button>
            </div>
          )}
          {edit && (
            <div className="wiki-actions">
              <span className="wiki-updated" aria-live="polite">
                {edit.saving ? "Saving…" : dirty ? "Unsaved changes" : "No changes yet"}
              </span>
              <button type="button" className="secondary" onClick={() => void cancelEdit()}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={edit.saving} onClick={() => void save()}>
                Save
              </button>
            </div>
          )}
        </div>
        {page.template && !edit && (
          <p className="wiki-banner">
            <LayoutTemplate size={15} aria-hidden="true" />
            New pages in {humanize(sectionOf(page.path))} start from this outline. Lines in italics are prompts to replace.
          </p>
        )}
        {edit?.conflict ? (
          <div className="wiki-banner warn" role="alert">
            <span>Someone else changed this page while you were editing. Which version do you want?</span>
            <span className="wiki-banner-actions">
              <button type="button" className="secondary" onClick={() => void save(true)}>
                Keep my version
              </button>
              <button type="button" className="secondary" onClick={() => void loadTheirs()}>
                Load the new version
              </button>
            </span>
          </div>
        ) : (
          edit?.elsewhere && (
            <p className="wiki-banner" role="status">
              <span>This page was changed somewhere else while you were editing. Saving lets you choose which version to keep.</span>
            </p>
          )
        )}
        <div className={"wiki-page-body" + (page.generated || edit ? " single" : "")}>
          {edit ? (
            <Suspense fallback={<p className="wiki-muted">Opening the editor…</p>}>
              <WikiEditor
                key={edit.n}
                markdown={edit.text}
                label={"Editing " + page.title}
                pages={choices}
                changed={(draft) => setEdit((e) => e && { ...e, draft })}
                ready={(baseline, handle) => {
                  editor.current = handle;
                  setEdit((e) => e && { ...e, baseline, draft: baseline });
                }}
                save={() => void save()}
                failed={fail}
              />
            </Suspense>
          ) : (
            <article className="wiki-article" aria-label={page.title}>
              <RichText text={page.content} link={link} />
            </article>
          )}
          {!page.generated && !edit && (
            <Related
              page={page}
              tree={tree}
              open={openPage}
              create={(path, label) => void createAt(path, label)}
              openProject={openProject}
            />
          )}
        </div>
      </div>
    );

  return (
    <div className="wiki-frame">
      <div className={"wiki" + (showing ? " showing" : "")}>
        <WikiNav
          tree={tree}
          view={view}
          query={query}
          setQuery={setQuery}
          open={open}
          toggle={(folder, value) => setOpen((o) => ({ ...o, [folder]: value }))}
          go={(v) => void go(v)}
          newPage={() => newPage()}
          newSection={() => void newSection()}
          menu={(e, folder) => menu.show(e, humanize(folder.split("/").pop()!) + " options", sectionMenu(folder))}
        />
        <section className="wiki-main" aria-label="Wiki page">
          {showing && (
            <button type="button" className="wiki-back narrow-wiki" onClick={() => void go({ kind: "home" })}>
              <ChevronLeft size={15} />
              All pages
            </button>
          )}
          {error && (
            <div role="alert" className="wiki-banner warn">
              <span>{error}</span>
              <button type="button" className="secondary" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          {notice && !error && (
            <p role="status" className="wiki-notice">
              {notice}
            </p>
          )}
          {kept && !edit && (
            <div className="wiki-banner" role="status">
              <span>
                You have unsaved changes to “{titleOf(kept.path)}” from {when(kept.time)}.
              </span>
              <span className="wiki-banner-actions">
                <button type="button" className="secondary" onClick={() => void restoreDraft(kept)}>
                  Restore
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    dropDraft();
                    setKept(undefined);
                  }}
                >
                  Discard
                </button>
              </span>
            </div>
          )}
          {edit?.restored && !edit.conflict && (
            <p className="wiki-banner" role="status">
              <span>These are your unsaved changes from before. Save to keep them, or Cancel to discard them.</span>
            </p>
          )}
          {main}
        </section>
        {dialog}
        {dialogs.node}
        {menu.node}
        {/* Keeps the count of listed pages reachable for screen readers on the home view. */}
        <span className="sr-only" aria-live="polite">
          {tree && view.kind === "home" && !query ? plural(pages.length, "page") + " in the wiki" : ""}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ side menu */

function WikiNav({
  tree,
  view,
  query,
  setQuery,
  open,
  toggle,
  go,
  newPage,
  newSection,
  menu,
}: {
  tree?: WikiTree;
  view: View;
  query: string;
  setQuery: (q: string) => void;
  open: Record<string, boolean>;
  toggle: (folder: string, open: boolean) => void;
  go: (v: View) => void;
  newPage: () => void;
  newSection: () => void;
  menu: (e: React.MouseEvent<HTMLElement>, folder: string) => void;
}) {
  const current = view.kind === "page" ? view.path : "";
  const item = (label: string, icon: ReactNode, selected: boolean, onClick: () => void, extra?: ReactNode) => (
    <button type="button" className="wiki-nav-item" aria-current={selected ? "page" : undefined} onClick={onClick}>
      {icon}
      <span className="wiki-nav-name">{label}</span>
      {extra}
    </button>
  );
  function folderNode(folder: string, depth: number): ReactNode {
    if (!tree) return null;
    const name = humanize(folder.split("/").pop()!);
    const here = listed(tree)
      .filter((p) => folderOf(p.path) === folder)
      .sort(byTitle);
    const children = tree.folders.filter((f) => folderOf(f) === folder);
    const count = pagesIn(tree, folder).length;
    const expanded = open[folder] ?? (current.startsWith(folder + "/") || (view.kind === "section" && view.folder.startsWith(folder)));
    const id = "wiki-folder-" + folder.replace(/[^a-z0-9]+/gi, "-");
    return (
      <li key={folder} className="wiki-folder" style={{ ["--depth" as string]: depth }}>
        <div className="wiki-folder-row" onContextMenu={(e) => menu(e, folder)}>
          <button
            type="button"
            className="wiki-folder-toggle"
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={(expanded ? "Collapse " : "Expand ") + name}
            onClick={() => toggle(folder, !expanded)}
          >
            <ChevronRight size={14} className="wiki-chevron" />
          </button>
          <button
            type="button"
            className="wiki-nav-item wiki-folder-name"
            aria-current={view.kind === "section" && view.folder === folder ? "page" : undefined}
            onClick={() => {
              toggle(folder, true);
              go({ kind: "section", folder });
            }}
          >
            <span className="wiki-nav-name">{name}</span>
            <span className="wiki-count" aria-label={plural(count, "page")}>
              {count}
            </span>
          </button>
          <button
            type="button"
            className="menu-button wiki-row-menu"
            aria-label={"More for " + name}
            aria-haspopup="menu"
            onClick={(e) => menu(e, folder)}
          >
            <Ellipsis size={15} />
          </button>
        </div>
        {expanded && (
          <ul id={id} className="wiki-nav-list">
            {children.map((f) => folderNode(f, depth + 1))}
            {here.map((p) => (
              <li key={p.path}>{item(p.title, null, current === p.path, () => go({ kind: "page", path: p.path }))}</li>
            ))}
            {!here.length && !children.length && <li className="wiki-nav-empty">No pages yet</li>}
          </ul>
        )}
      </li>
    );
  }
  const loose = tree
    ? listed(tree)
        .filter((p) => !p.path.includes("/") && p.path !== GUIDE)
        .sort(byTitle)
    : [];
  return (
    <nav className="wiki-nav" aria-label="Wiki">
      <div className="wiki-nav-head">
        <h2>Wiki</h2>
      </div>
      <label className="wiki-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search the wiki"
          placeholder="Search the wiki"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
      </label>
      <div className="wiki-nav-scroll">
        {item("Home", <House size={15} />, view.kind === "home" && !query, () => go({ kind: "home" }))}
        <div className="wiki-nav-label">
          <span id="wiki-sections-label">Sections</span>
          <button
            type="button"
            className="wiki-icon-button small"
            aria-label="New section"
            title="New section"
            onClick={newSection}
            disabled={!tree}
          >
            <FolderPlus size={14} />
          </button>
        </div>
        {tree ? (
          <ul className="wiki-nav-list" aria-labelledby="wiki-sections-label">
            {sections(tree).map((f) => folderNode(f, 0))}
            {loose.map((p) => (
              <li key={p.path}>{item(p.title, <FileText size={14} />, current === p.path, () => go({ kind: "page", path: p.path }))}</li>
            ))}
          </ul>
        ) : (
          <p className="wiki-nav-empty">Loading…</p>
        )}
        <hr />
        {item("How this wiki works", <CircleHelp size={15} />, current === GUIDE, () => go({ kind: "page", path: GUIDE }))}
        {item("Activity", <Activity size={15} />, view.kind === "activity", () => go({ kind: "activity" }))}
      </div>
      <div className="wiki-nav-foot">
        <button type="button" className="secondary" onClick={newPage} disabled={!tree}>
          <Plus size={14} />
          New page
        </button>
        <button type="button" className="secondary" onClick={newSection} disabled={!tree}>
          <FolderPlus size={14} />
          New section
        </button>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ views */

function Crumbs({
  page,
  home,
  section,
  activity,
}: {
  page: WikiPage;
  home: () => void;
  section: (folder: string) => void;
  activity: boolean;
}) {
  const parts = folderOf(page.path) ? folderOf(page.path).split("/") : [];
  const title = activity ? "Activity" : page.template ? "Template for new pages" : page.path === GUIDE ? "How this wiki works" : page.title;
  return (
    <nav className="wiki-crumbs" aria-label="Breadcrumb">
      <ol>
        <li>
          <button type="button" onClick={home}>
            Wiki
          </button>
        </li>
        {parts.map((part, i) => (
          <li key={i}>
            <ChevronRight size={13} aria-hidden="true" />
            <button type="button" onClick={() => section(parts.slice(0, i + 1).join("/"))}>
              {humanize(part)}
            </button>
          </li>
        ))}
        <li>
          <ChevronRight size={13} aria-hidden="true" />
          <span aria-current="page">{title}</span>
        </li>
      </ol>
    </nav>
  );
}

function Home({
  tree,
  state,
  open,
  openSection,
  newPage,
  exportWiki,
  addSuggested,
  startChat,
}: {
  tree: WikiTree;
  state: State;
  open: (path: string) => void;
  openSection: (folder: string) => void;
  newPage: () => void;
  exportWiki: () => void;
  addSuggested: () => Promise<void>;
  startChat: (text: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const recent = listed(tree)
    .filter((p) => p.path !== GUIDE)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  const { projects } = tree.suggested;
  const missing = projects.length;
  const names = projects.map((r) => r.name);
  const bot = state.bots[0]?.name ?? "your bot";
  return (
    <div className="wiki-home">
      <div className="wiki-home-head">
        <div>
          <h1>Wiki</h1>
          <p className="wiki-muted">What your team knows, kept current by you and your bots.</p>
        </div>
        <span className="wiki-home-actions">
          <button type="button" className="secondary" onClick={exportWiki}>
            <FileDown size={15} />
            Export…
          </button>
          <button type="button" className="primary" onClick={newPage}>
            <Plus size={15} />
            New page
          </button>
        </span>
      </div>
      {missing > 0 && (
        <div className="wiki-suggest" role="region" aria-label="Records without a page">
          <Inbox size={18} aria-hidden="true" />
          <div>
            <strong>
              {plural(projects.length, "project")} {missing === 1 ? "has" : "have"} no page yet
            </strong>
            <small>{names.length > 3 ? names.slice(0, 3).join(", ") + " and " + (names.length - 3) + " more" : names.join(", ")}</small>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={adding}
            onClick={() => {
              setAdding(true);
              void addSuggested().finally(() => setAdding(false));
            }}
          >
            {adding ? "Adding…" : missing === 1 ? "Add page" : "Add pages"}
          </button>
        </div>
      )}
      <section className="wiki-block" aria-labelledby="wiki-sections-title">
        <h2 id="wiki-sections-title">Sections</h2>
        {sections(tree).length ? (
          <ul className="wiki-section-grid">
            {sections(tree).map((folder) => {
              const n = pagesIn(tree, folder).length;
              return (
                <li key={folder}>
                  <button type="button" className="wiki-section-card" onClick={() => openSection(folder)}>
                    <SectionIcon folder={folder} />
                    <span>
                      <strong>{humanize(folder)}</strong>
                      <small>{n ? plural(n, "page") : "No pages yet"}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="wiki-muted">No sections yet. Add one with New section.</p>
        )}
      </section>
      <section className="wiki-block" aria-labelledby="wiki-recent-title">
        <h2 id="wiki-recent-title">Recently updated</h2>
        {recent.length ? (
          <ul className="wiki-rows">
            {recent.map((p) => (
              <li key={p.path}>
                <PageRow page={p} open={open} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="wiki-muted">No pages yet. Create one, or ask {bot} to write down what it learns.</p>
        )}
      </section>
      {state.bots[0] && (
        <section className="wiki-block" aria-labelledby="wiki-bots-title">
          <h2 id="wiki-bots-title">Ask {bot}</h2>
          <div className="wiki-bot-actions">
            <button
              type="button"
              className="wiki-bot-action"
              onClick={() =>
                startChat(
                  "Please file this into the wiki. Put each fact on the page where it belongs, add the links, and tell me what you changed:\n\n",
                )
              }
            >
              <FileText size={16} aria-hidden="true" />
              <span>
                <strong>File something into the wiki</strong>
                <small>Paste notes, an email or a document</small>
              </span>
            </button>
            <button
              type="button"
              className="wiki-bot-action"
              onClick={() =>
                startChat(
                  "Please tidy the wiki: look for pages that disagree, facts that are out of date, pages nothing links to, and names mentioned often that have no page yet. Tell me what you find and fix what is clear.",
                )
              }
            >
              <Sparkles size={16} aria-hidden="true" />
              <span>
                <strong>Tidy the wiki</strong>
                <small>Find gaps, conflicts and stale facts</small>
              </span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function SectionIcon({ folder }: { folder: string }) {
  const Icon = folder === "projects" ? FolderKanban : BookOpen;
  return (
    <span className="wiki-section-icon" aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}

function PageRow({ page, open, detail }: { page: WikiPageInfo; open: (path: string) => void; detail?: string }) {
  const section = sectionOf(page.path);
  return (
    <button type="button" className="wiki-row" onClick={() => open(page.path)}>
      <FileText size={15} aria-hidden="true" />
      <span className="wiki-row-text">
        <strong>{page.title}</strong>
        <small>{detail ?? page.summary ?? ""}</small>
      </span>
      <span className="wiki-row-meta">
        {section && <span>{humanize(section)}</span>}
        <time dateTime={new Date(page.updatedAt).toISOString()}>{when(page.updatedAt)}</time>
      </span>
    </button>
  );
}

function SectionView({
  tree,
  folder,
  open,
  openFolder,
  home,
  newPage,
  menu,
}: {
  tree: WikiTree;
  folder: string;
  open: (path: string) => void;
  openFolder: (folder: string) => void;
  home: () => void;
  newPage: () => void;
  menu: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  if (!tree.folders.includes(folder)) return <Problem text="This section no longer exists." home={home} />;
  const parts = folder.split("/");
  const here = listed(tree)
    .filter((p) => folderOf(p.path) === folder)
    .sort(byTitle);
  const children = tree.folders.filter((f) => folderOf(f) === folder);
  const template = templateOf(tree, sectionOf(folder + "/x"));
  return (
    <div className="wiki-section-view">
      <nav className="wiki-crumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <button type="button" onClick={home}>
              Wiki
            </button>
          </li>
          {parts.map((part, i) => (
            <li key={i}>
              <ChevronRight size={13} aria-hidden="true" />
              {i === parts.length - 1 ? (
                <span aria-current="page">{humanize(part)}</span>
              ) : (
                <button type="button" onClick={() => openFolder(parts.slice(0, i + 1).join("/"))}>
                  {humanize(part)}
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="wiki-home-head">
        <div>
          <h1>{humanize(parts.at(-1)!)}</h1>
          <p className="wiki-muted">
            {plural(pagesIn(tree, folder).length, "page")}
            {template && !folder.includes("/") ? " · New pages start from this section's template" : ""}
          </p>
        </div>
        <div className="wiki-actions">
          <button type="button" className="primary" onClick={newPage}>
            <Plus size={15} />
            New page
          </button>
          <button
            type="button"
            className="wiki-icon-button menu-button"
            aria-label={"More for " + humanize(parts.at(-1)!)}
            aria-haspopup="menu"
            onClick={menu}
          >
            <Ellipsis size={17} />
          </button>
        </div>
      </div>
      {children.length > 0 && (
        <ul className="wiki-rows folders">
          {children.map((f) => (
            <li key={f}>
              <button type="button" className="wiki-row" onClick={() => openFolder(f)}>
                <Folder size={15} aria-hidden="true" />
                <span className="wiki-row-text">
                  <strong>{humanize(f.split("/").pop()!)}</strong>
                  <small>{plural(pagesIn(tree, f).length, "page")}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {here.length ? (
        <ul className="wiki-rows">
          {here.map((p) => (
            <li key={p.path}>
              <PageRow page={p} open={open} />
            </li>
          ))}
        </ul>
      ) : (
        !children.length && (
          <div className="wiki-empty">
            <FileText size={22} aria-hidden="true" />
            <p>No pages in this section yet.</p>
            <button type="button" className="secondary" onClick={newPage}>
              <Plus size={14} /> New page
            </button>
          </div>
        )
      )}
    </div>
  );
}

function SearchResults({
  query,
  results,
  open,
  tree,
}: {
  query: string;
  results?: { path: string; title: string; snippet: string }[];
  open: (path: string) => void;
  tree?: WikiTree;
}) {
  return (
    <div className="wiki-search-view" role="region" aria-label="Search results">
      <h2 className="wiki-view-title">Results for “{query}”</h2>
      {!results ? (
        <p className="wiki-muted">Searching…</p>
      ) : !results.length ? (
        <p className="wiki-muted">No pages match “{query}”.</p>
      ) : (
        <ul className="wiki-rows" aria-live="polite">
          {results.map((r) => {
            const info = tree?.pages.find((p) => p.path === r.path);
            return (
              <li key={r.path}>
                {info ? (
                  <PageRow page={info} open={open} detail={r.snippet} />
                ) : (
                  <button type="button" className="wiki-row" onClick={() => open(r.path)}>
                    <FileText size={15} aria-hidden="true" />
                    <span className="wiki-row-text">
                      <strong>{r.title}</strong>
                      <small>{r.snippet}</small>
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What relates to the open page: what links to it, what it links to, its record and its missing links. */
function Related({
  page,
  tree,
  open,
  create,
  openProject,
}: {
  page: WikiPage;
  tree: WikiTree;
  open: (path: string) => void;
  create: (path: string, label: string) => void;
  openProject: (id: string) => void;
}) {
  const info = (path: string) => tree.pages.find((p) => p.path === path);
  const group = (paths: string[]) => {
    const out = new Map<string, WikiPageInfo[]>();
    for (const path of paths) {
      const p = info(path);
      if (!p) continue;
      const key = p.path === GUIDE ? "Guide" : humanize(sectionOf(p.path) || "Wiki");
      out.set(key, [...(out.get(key) ?? []), p]);
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b));
  };
  const list = (title: string, paths: string[], empty: string) => {
    const groups = group(paths);
    return (
      <section className="wiki-related-block" aria-label={title}>
        <h3>{title}</h3>
        {groups.length ? (
          groups.map(([name, items]) => (
            <div key={name} className="wiki-related-group">
              <span className="wiki-related-section">{name}</span>
              <ul>
                {items.sort(byTitle).map((p) => (
                  <li key={p.path}>
                    <button type="button" className="wiki-related-link" onClick={() => open(p.path)}>
                      {p.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="wiki-muted">{empty}</p>
        )}
      </section>
    );
  };
  if (page.template) return <aside className="wiki-related" aria-label="Related" />;
  return (
    <aside className="wiki-related" aria-label="Related">
      {page.record && (
        <section className="wiki-related-block" aria-label="Record">
          <h3>Project record</h3>
          <button type="button" className="wiki-record" onClick={() => openProject(page.record!.id)}>
            <FolderKanban size={15} aria-hidden="true" />
            <span>{page.record.name}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </section>
      )}
      {list("Linked from", page.backlinks, "No other pages link here yet.")}
      {list("Links to", page.links, "This page doesn't link to other pages.")}
      {page.missing.length > 0 && (
        <section className="wiki-related-block" aria-label="Not created yet">
          <h3>Not created yet</h3>
          <ul>
            {page.missing.map((m) => (
              <li key={m.path}>
                <button type="button" className="wiki-related-link missing" onClick={() => create(m.path, m.label)}>
                  <Plus size={13} aria-hidden="true" />
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function Problem({ text, retry, home }: { text: string; retry?: () => void; home?: () => void }) {
  return (
    <div className="wiki-empty" role="alert">
      <p>{text}</p>
      <span className="wiki-banner-actions">
        {retry && (
          <button type="button" className="secondary" onClick={retry}>
            Try again
          </button>
        )}
        {home && (
          <button type="button" className="secondary" onClick={home}>
            Wiki home
          </button>
        )}
      </span>
    </div>
  );
}
