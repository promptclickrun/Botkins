// The wiki's names, sections and links, read the way the computer's wiki (desktop/wiki.mjs) reads them.
import type { WikiPageInfo, WikiTree } from "@/link/types";

export const GUIDE = "WIKI.md";
const GENERATED = new Set(["index.md", "log.md"]);
/** Matches the computer's refusal to overwrite a page that changed since it was read. */
export const CHANGED = /changed while you were editing/i;
export const isGenerated = (path: string) => GENERATED.has(path.toLowerCase());

/** "key-accounts" → "Key accounts". */
export function humanize(name: string) {
  const words = name.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}
/** A file or folder name made from what a person typed, as the computer makes it. */
export const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const sectionOf = (path: string) => (path.includes("/") ? path.split("/")[0]! : "");
export const fileOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const folderName = (folder: string) => humanize(fileOf(folder));

/** Top-level folders, in the order the computer lists them. */
export const sections = (tree: WikiTree) => tree.folders.filter((folder) => !folder.includes("/"));
/** Folders directly inside `parent`. */
export const foldersIn = (tree: WikiTree, parent: string) => tree.folders.filter((folder) => folderOf(folder) === parent && folder.includes("/"));
export const byTitle = (a: WikiPageInfo, b: WikiPageInfo) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
/** Pages a person browses directly in `folder`: no templates, and not the guide. */
export const pagesAt = (tree: WikiTree, folder: string) =>
  tree.pages.filter((page) => !page.template && page.path !== tree.guide && folderOf(page.path) === folder).sort(byTitle);
/** Whether the wiki holds any page a person wrote (the guide and templates don't count). */
export const hasPages = (tree: WikiTree) => tree.pages.some((page) => !page.template && page.path !== tree.guide);
/** The outline new pages in `folder` start from, as the computer looks for it. */
export const templateFor = (tree: WikiTree | undefined, folder: string) => (folder ? tree?.pages.find((page) => page.path === folder + "/_template.md") : undefined);

/** A page's name as the screens show it. */
export function pageTitle(page: { path: string; title: string; template?: boolean }) {
  if (page.path === GUIDE) return "How this wiki works";
  if (page.template) return "Template for new pages";
  return page.title;
}

/** Finds a page by path whatever its letter case. */
export function pageLookup(paths: Iterable<string>) {
  const names = new Map<string, string>();
  for (const path of paths) names.set(path.normalize("NFC").toLowerCase(), path);
  return (path: string) => names.get(path.normalize("NFC").toLowerCase());
}

function normalize(path: string) {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return "";
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * The page a link on `from` points at. "./" and "../" are relative to the page's folder, "/" is the
 * top of the wiki, and any other is tried from the top first, then from the page's folder. ".md" is
 * added when left off, "#part" is ignored and letter case doesn't matter. Null for web links.
 */
export function resolveLink(from: string, href: string, lookup: (path: string) => string | undefined): { path: string; exists: boolean } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  let text = href.split("#")[0]!.split("?")[0]!;
  try {
    text = decodeURI(text);
  } catch {
    // Kept as written.
  }
  text = text.normalize("NFC");
  if (!text) return null;
  const rooted = text.startsWith("/");
  const dotted = /^\.\.?\//.test(text);
  text = text.replace(/^\/+/, "");
  const withMd = (path: string) => (/\.[a-z0-9]{1,8}$/i.test(path) ? path : path + ".md");
  const options: string[] = [];
  if (!dotted) options.push(normalize(text));
  if (!rooted) options.push(normalize((folderOf(from) ? folderOf(from) + "/" : "") + text));
  const paths = [...new Set(options.filter(Boolean).map(withMd))];
  for (const path of paths) {
    const hit = lookup(path);
    if (hit) return { path: hit, exists: true };
  }
  const first = paths.find((path) => /\.md$/i.test(path));
  return first ? { path: first, exists: false } : null;
}

const fold = (text: string) => text.normalize("NFC").toLowerCase().trim();
/** The page a "[[Name]]" means: by path, then by title, then by file name. Otherwise where it would be made. */
export function resolveName(pages: WikiPageInfo[], wanted: string): { path: string; exists: boolean } {
  const key = fold(wanted).replace(/\.md$/, "");
  const list = pages.filter((page) => !page.template);
  const hit =
    list.find((page) => fold(page.path).replace(/\.md$/, "") === key) ??
    list.find((page) => fold(page.title) === key) ??
    list.find((page) => fold(fileOf(page.path)).replace(/\.md$/, "") === slug(wanted));
  if (hit) return { path: hit.path, exists: true };
  return { path: wanted.split("/").map((part) => slug(part) || "page").join("/") + ".md", exists: false };
}

/** A scheme the page's text uses for a "[[Name]]" once it is turned into an ordinary link here. */
export const NAME_LINK = "wikiname:";
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
/** Turns "[[Name]]" and "[[Name|label]]" into Markdown links, outside code. */
export function plainNames(text: string) {
  if (!text.includes("[[")) return text;
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) => (index % 2 ? part : part.replace(WIKILINK, (_all, name: string, label?: string) => "[" + (label ?? name).trim().replace(/[[\]]/g, "") + "](" + NAME_LINK + encodeURIComponent(name.trim()).replace(/\(/g, "%28").replace(/\)/g, "%29") + ")")))
        .join("");
    })
    .join("\n");
}

/** A page's text from its section's template, as the computer fills one in. */
export function fromTemplate(template: string | undefined, title: string) {
  const d = new Date();
  const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  let text = (template || "# {{title}}\n").replaceAll("{{title}}", () => title).replaceAll("{{date}}", () => day);
  if (!/^#\s+\S/m.test(text)) text = "# " + title + "\n\n" + text;
  return text.trimEnd() + "\n";
}

/** The text with its first "# " heading set to `title` (one is added when there is none). */
export function withTitle(text: string, title: string) {
  if (/^#\s+\S.*$/m.test(text)) return text.replace(/^#\s+\S.*$/m, () => "# " + title);
  return "# " + title + "\n\n" + text;
}

/** "5 minutes ago", "yesterday", "Mar 3". */
export function when(time: number, now = Date.now()) {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(time).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}
export const dateTime = (time: number) => new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "1 page", "3 pages". */
export const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");
/** Pages a person wrote anywhere inside `folder`: no templates, and not the guide. */
export const pagesIn = (tree: WikiTree, folder: string) => tree.pages.filter((page) => !page.template && page.path !== tree.guide && page.path.startsWith(folder + "/"));
/** Where a folder goes when it is renamed to `name`: beside where it is. "" when the name makes no folder name. */
export function renamedFolder(folder: string, name: string) {
  const base = slug(name);
  if (!base) return "";
  return (folderOf(folder) ? folderOf(folder) + "/" : "") + base;
}
/** The outline a section's new template starts with, as the computer writes it. */
export const NEW_TEMPLATE = "# {{title}}\n\n_One sentence on what this page is about._\n";
/** The projects that have no page yet, as one line: "Website, Mobile app and 2 more". An older computer sends none. */
export function suggestedLine(tree: WikiTree) {
  const names = (tree.suggested?.projects ?? []).map((project) => project.name);
  return names.length > 3 ? names.slice(0, 3).join(", ") + " and " + (names.length - 3) + " more" : names.join(", ");
}
/** The two starts a chat with the first bot can take from the wiki, in the computer's words and prompts. */
export const WIKI_ASKS = [
  {
    id: "file",
    title: "File something into the wiki",
    subtitle: "Paste notes, an email or a document",
    prompt: "Please file this into the wiki. Put each fact on the page where it belongs, add the links, and tell me what you changed:\n\n",
  },
  {
    id: "tidy",
    title: "Tidy the wiki",
    subtitle: "Find gaps, conflicts and stale facts",
    prompt: "Please tidy the wiki: look for pages that disagree, facts that are out of date, pages nothing links to, and names mentioned often that have no page yet. Tell me what you find and fix what is clear.",
  },
] as const;
