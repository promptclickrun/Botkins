// Helpers for the Wiki section (src/Wiki.tsx): names, sections and links, matching desktop/wiki.mjs.
import type { WikiPageInfo, WikiTree } from "./types";

export const GUIDE = "WIKI.md";
export const LOG = "log.md";

/** "key-accounts" → "Key accounts". */
export const humanize = (name: string) => {
  const words = name.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
};
/** A folder or file name made from what a person typed, as desktop/integrations.mjs makes it. */
export const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const sectionOf = (path: string) => (path.includes("/") ? path.split("/")[0] : "");
export const fileOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** "projects/archive" → "Projects › Archive". "" is the top of the wiki. */
export const folderLabel = (folder: string) => (folder ? folder.split("/").map(humanize).join(" › ") : "Top of the wiki");

/** Pages a person browses: every page but the templates. */
export const listed = (tree: WikiTree) => tree.pages.filter((p) => !p.template);
export const templateOf = (tree: WikiTree, section: string) => tree.pages.find((p) => p.path === section + "/_template.md");
/** Pages in a folder and everything under it, without the template. */
export const pagesIn = (tree: WikiTree, folder: string) => listed(tree).filter((p) => p.path.startsWith(folder + "/"));
export const sections = (tree: WikiTree) => tree.folders.filter((f) => !f.includes("/"));
export const byTitle = (a: WikiPageInfo, b: WikiPageInfo) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

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
 * The page a link on `from` points at, the way desktop/wiki.mjs reads links. A target that starts
 * with "./" or "../" is relative to the page's folder (pages are saved with these) and one that
 * starts with "/" is from the top of the wiki. Any other is read from the top first, then from the
 * page's folder. ".md" is added when left off, "#part" is ignored and letter case doesn't matter.
 * `lookup(path)` returns the path as the wiki spells it, or undefined.
 * Returns null for web links, mail links and links inside the page.
 */
export function resolveLink(
  from: string,
  href: string,
  lookup: (path: string) => string | undefined,
): { path: string; exists: boolean } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  let text = href.split("#")[0].split("?")[0];
  try {
    text = decodeURI(text);
  } catch {}
  text = text.normalize("NFC");
  if (!text) return null;
  const rooted = text.startsWith("/");
  const dotted = /^\.\.?\//.test(text);
  text = text.replace(/^\/+/, "");
  const withMd = (p: string) => (/\.[a-z0-9]{1,8}$/i.test(p) ? p : p + ".md");
  const options: string[] = [];
  if (!dotted) options.push(normalize(text));
  if (!rooted) options.push(normalize((folderOf(from) ? folderOf(from) + "/" : "") + text));
  const paths = [...new Set(options.filter(Boolean).map(withMd))];
  for (const path of paths) {
    const hit = lookup(path);
    if (hit) return { path: hit, exists: true };
  }
  const first = paths.find((p) => /\.md$/i.test(p));
  return first ? { path: first, exists: false } : null;
}
/** Finds a page by path whatever its letter case, as desktop/wiki.mjs does. */
export function pageLookup(paths: Iterable<string>) {
  const names = new Map<string, string>();
  for (const path of paths) names.set(path.normalize("NFC").toLowerCase(), path);
  return (path: string) => names.get(path.normalize("NFC").toLowerCase());
}

/** A page's text from its section's template, as desktop/wiki.mjs fills one in. */
export function fromTemplate(template: string | undefined, title: string) {
  const d = new Date();
  const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  // Functions, so "$" in a title is kept as written.
  let text = (template || "# {{title}}\n").replaceAll("{{title}}", () => title).replaceAll("{{date}}", () => day);
  if (!/^#\s+\S/m.test(text)) text = "# " + title + "\n\n" + text;
  return text.trimEnd() + "\n";
}

/** "Updated 5 minutes ago", "Updated yesterday", "Updated Mar 3". */
export function when(time: number, now = Date.now()) {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(time).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}
export const dateTime = (time: number) =>
  new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);
