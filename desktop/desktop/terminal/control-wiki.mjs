// The wiki: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// A page is named by its path (`projects/website.md`, or `projects/website`), or by its title when
// only one page has it. A section (a folder) is named by its path. The app's own calls do the work
// and check what they are given; these calls find the page, and say what is wrong in plain words.
//
// A page's text is a person's or a bot's text. It goes through here as it is. The command line
// makes a title safe to show; the text of a page it prints as it is.
import { PAGE_MAX } from "../wiki.mjs";
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const fold = (value) => value.normalize("NFC").toLowerCase();
/** One of a list by its id, or by its name when exactly one has it. */
function pick(list, ref, what, see) {
  const wanted = text(ref, 200, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const named = list.filter((entry) => String(entry.name ?? "").toLowerCase() === wanted.toLowerCase());
  if (named.length > 1) throw new ControlError("More than one " + what + " is called " + wanted + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  if (!named.length) throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
  return named[0];
}
const GENERATED = ["index.md", "log.md"];
// What the app says when the page is not the one that was read (desktop/wiki.mjs).
const CHANGED = "This page changed while you were editing it.";

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 */
export function wikiApi({ workspace, handlers }) {
  /**
   * A page or a section by what a person typed: its path (with or without .md, in any letter
   * case), else the title that only one page has. `only` is "page" or "section" to refuse the other.
   */
  const find = (ref, only) => {
    const wanted = text(ref, 240, "a page's path or title");
    const tree = handlers.wikiTree();
    const key = fold(wanted.replace(/\\/g, "/").replace(/^(\.?\/)+/, "").replace(/\/+$/, ""));
    const pages = tree.pages;
    const byPath = (path) => pages.find((page) => fold(page.path) === path);
    const folder = tree.folders.find((path) => fold(path) === key);
    const made = GENERATED.find((path) => path === key);
    let found;
    if (key.endsWith(".md") && byPath(key)) found = { kind: "page", path: byPath(key).path, title: byPath(key).title };
    else if (made) found = { kind: "page", path: made, title: made === "index.md" ? "Index" : "Log", generated: true };
    else if (folder) found = { kind: "section", path: folder, pages: pages.filter((page) => page.path.startsWith(folder + "/") && !page.template).length };
    else if (byPath(key + ".md")) found = { kind: "page", path: byPath(key + ".md").path, title: byPath(key + ".md").title };
    else {
      const titled = pages.filter((page) => !page.template && fold(page.title.trim()) === fold(wanted));
      if (titled.length > 1) throw new ControlError("More than one page is called " + wanted + ". Use its path: " + titled.map((page) => page.path).join(", ") + ".", "AMBIGUOUS");
      if (titled.length) found = { kind: "page", path: titled[0].path, title: titled[0].title };
    }
    if (!found) throw new ControlError("There is no page or section called " + wanted + ". See `botkins wiki tree`.", "NOT_FOUND");
    if (only === "page" && found.kind !== "page") throw new ControlError(found.path + " is a section, not a page. See `botkins wiki tree`.", "BAD_ARGUMENT");
    if (only === "section" && found.kind !== "section") throw new ControlError(found.path + " is a page, not a section. See `botkins wiki tree`.", "BAD_ARGUMENT");
    return found;
  };
  /** A page without its text: what the command line shows after a change. */
  const plain = ({ content: _content, links: _links, backlinks: _backlinks, missing: _missing, ...page }) => page;
  const view = (path) => plain(handlers.wikiPage(path));
  /** The version of a page by its id, or by the start of its id when only one version has it. */
  const version = (path, ref) => {
    const wanted = text(ref, 100, "a version (its id from `botkins wiki history`)");
    const list = handlers.wikiHistory(path);
    const exact = list.find((entry) => entry.id === wanted);
    const some = exact ? [exact] : list.filter((entry) => entry.id.startsWith(wanted));
    if (some.length > 1) throw new ControlError("More than one version starts with " + wanted + ". Give more of its id.", "AMBIGUOUS");
    if (!some.length) throw new ControlError("There is no version " + wanted + " of " + path + ". See `botkins wiki history`.", "NOT_FOUND");
    return { ...some[0], time: new Date(some[0].time).toISOString() };
  };
  const body = (value) => {
    if (typeof value !== "string" || !value.trim()) throw new ControlError("Give the page's text. A page needs some text.", "BAD_ARGUMENT");
    if (value.length > PAGE_MAX) throw new ControlError("A page holds up to " + PAGE_MAX.toLocaleString("en-US") + " characters. Split this one into several pages.", "BAD_ARGUMENT");
    return value;
  };
  /** The pages that an export of this scope holds: a whole wiki, or a page with the pages around it. */
  const plan = ({ scope, page } = {}) => {
    if (!["all", "page", "project"].includes(scope)) throw new ControlError("Choose what to export: all, page or project.", "BAD_ARGUMENT");
    if (scope === "all") return handlers.wikiExportPlan({ scope });
    return handlers.wikiExportPlan({ scope, path: find(page, "page").path });
  };

  return {
    /** Every section and page, with each page's title, summary and links, and the projects that have no page yet. */
    "wiki.tree": () => handlers.wikiTree(),
    /** What a name stands for: { kind: "page" | "section", path, title? , pages? }. */
    "wiki.find": ([ref]) => find(ref),
    /** One page with its text. `base` is its revision, for a later save. */
    "wiki.page": ([ref]) => handlers.wikiPage(find(ref, "page").path),
    /** The pages that hold every word: [{ path, title, snippet }], best first, at most 30. */
    "wiki.search": ([query]) => handlers.searchWiki(text(query, 500, "some words to search for")),
    /**
     * A new page. `data` is { title, folder?, text? } or { for: <project> }. A page for a project
     * starts from the project's record. The text, when it is given, replaces the folder's template.
     */
    "wiki.add"([data = {}]) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ControlError("Give the page's title.", "BAD_ARGUMENT");
      if (data.for !== undefined) {
        if (data.title !== undefined || data.folder !== undefined || data.text !== undefined) throw new ControlError("A page for a project takes its title and its place from the project. Give only the project, and change the page afterwards with `botkins wiki save`.", "BAD_ARGUMENT");
        const project = pick(workspace.state.projects ?? [], data.for, "project", "botkins projects list");
        return view(handlers.createWikiPageFor({ kind: "project", id: project.id }));
      }
      const title = text(data.title, 120, "the page's title, up to 120 characters");
      const folder = data.folder === undefined ? "" : find(data.folder, "section").path;
      // Checked before the page is made, so that a text that is too long leaves no empty page.
      const content = data.text === undefined ? undefined : body(data.text);
      const path = handlers.createWikiPage({ folder, title });
      if (content !== undefined) {
        try {
          handlers.saveWikiPage(path, content);
        } catch (error) {
          // The page that was just made is of no use without its text.
          try {
            handlers.deleteWiki(path);
          } catch {}
          throw error;
        }
      }
      return view(path);
    },
    /** A new section. `data` is { name, parent? }; `parent` is a section. */
    "wiki.addFolder"([data = {}]) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ControlError("Give the section's name.", "BAD_ARGUMENT");
      const parent = data.parent === undefined ? "" : find(data.parent, "section").path;
      return { path: handlers.createWikiFolder({ parent, name: text(data.name, 120, "the section's name") }) };
    },
    /**
     * Replaces a page's text. `base` is the revision that the caller read: a page that changed
     * since is not overwritten. The app keeps the text it had as an earlier version.
     */
    "wiki.save"([ref, value, base]) {
      const page = find(ref, "page");
      const content = body(value);
      if (base !== undefined && base !== null && (typeof base !== "string" || !base.trim() || base.length > 64)) throw new ControlError("Give the revision as it was read.", "BAD_ARGUMENT");
      const before = handlers.wikiPage(page.path).base;
      try {
        const saved = handlers.saveWikiPage(page.path, content, typeof base === "string" ? base.trim() : undefined);
        return { ...plain(saved), changed: saved.base !== before };
      } catch (error) {
        if (error?.message === CHANGED) throw new ControlError("The page " + page.path + " changed after revision " + String(base).trim() + ".", "CHANGED");
        throw error;
      }
    },
    /** Moves or renames a page or a section to a new path. Links to it in other pages follow. */
    "wiki.move"([ref, to]) {
      const item = find(ref);
      const path = handlers.moveWiki(item.path, text(to, 240, "the new path, such as projects/new-name.md"));
      return { kind: item.kind, from: item.path, to: path };
    },
    /** Removes a page, or a section with its pages. The app keeps what it removed in the wiki's own trash folder. */
    "wiki.remove"([ref]) {
      const item = find(ref);
      handlers.deleteWiki(item.path);
      return { removed: item.path, kind: item.kind, ...(item.kind === "section" && { pages: item.pages }) };
    },
    /** A page's earlier versions, newest first: { path, title, versions: [{ id, time, by }] }. */
    "wiki.history"([ref]) {
      const page = find(ref, "page");
      return { path: page.path, title: page.title, versions: handlers.wikiHistory(page.path).map((entry) => ({ ...entry, time: new Date(entry.time).toISOString() })) };
    },
    /** The text of one earlier version, by its id or the start of it. */
    "wiki.version"([ref, id]) {
      const page = find(ref, "page");
      const found = version(page.path, id);
      return { path: page.path, ...found, text: handlers.wikiVersion(page.path, found.id) };
    },
    /** Puts an earlier version back. The text the page has now is kept as a version too. */
    "wiki.restore"([ref, id]) {
      const page = find(ref, "page");
      const found = version(page.path, id);
      return { ...view(handlers.restoreWikiVersion(page.path, found.id).path), restored: found.id };
    },
    /** The pages that an export would hold, and why each is in it: { title, pages: [{ path, title, section, why }] }. `options` is { scope: "all" | "page" | "project", page? }. */
    "wiki.exportPlan": ([options]) => plan(options),
    /**
     * An export as a file in the answer: { name, pages, text } for a web page or { name, pages, base64 }
     * for a zip of Markdown files. `options` is { scope, page?, format: "zip" | "html" }. The caller
     * writes the file. The window's own save dialog is not used here. A PDF is laid out by the window, so it is not offered.
     * The app also keeps a copy of the export among the artifacts of the first bot, as it does for a phone.
     */
    async "wiki.export"([options]) {
      const { format } = options ?? {};
      if (format === "pdf") throw new ControlError("A PDF is laid out by the app's window. Export a web page (--format html) and print it to PDF in a browser.", "UNSUPPORTED");
      if (!["zip", "html"].includes(format)) throw new ControlError("Choose a format: zip or html.", "BAD_ARGUMENT");
      const chosen = plan(options);
      if (!chosen.pages.length) throw new ControlError("The wiki has no pages to export.", "NOT_FOUND");
      const file = await handlers.exportWikiFile({ format, paths: chosen.pages.map((page) => page.path), title: chosen.title });
      return { pages: chosen.pages.length, ...file };
    },
  };
}
