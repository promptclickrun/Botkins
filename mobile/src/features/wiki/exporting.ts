// The plain logic of the wiki's Export sheet (WikiExport.tsx): the choices, in the words of the app
// on the computer, and what to ask the computer for. No React Native imports, so the tests run it.
import type { WikiExportFormat, WikiExportPlan } from "@/link/types";

export type ExportScope = "all" | "project" | "page";

export const SCOPES: { value: ExportScope; label: string }[] = [
  { value: "all", label: "Whole wiki" },
  { value: "project", label: "A project" },
  { value: "page", label: "One page" },
];
export const FORMATS: { value: WikiExportFormat; label: string; hint: string }[] = [
  { value: "zip", label: "Markdown files", hint: ".zip" },
  { value: "html", label: "Web page", hint: ".html, one file" },
  { value: "pdf", label: "PDF", hint: ".pdf" },
];
export const ABOUT: Record<ExportScope, string> = {
  all: "Every page in the wiki.",
  project: "The project's page, the pages linked with it, and the pages related to those.",
  page: "The page and the pages it is linked with.",
};
const WHY: { why: WikiExportPlan["pages"][number]["why"]; label: string }[] = [
  { why: "start", label: "This page" },
  { why: "linked", label: "Linked with it" },
  { why: "related", label: "Related" },
];

/** The scope a page's export starts on: a project's page exports with what is related to it. */
export const scopeFor = (path: string): ExportScope => (/^projects\//i.test(path) ? "project" : "page");

/** An export's pages in groups: by section for the whole wiki, otherwise by how each page came in. Empty groups are left out. */
export function exportGroups(plan: WikiExportPlan, scope: ExportScope): { key: string; label: string; pages: WikiExportPlan["pages"] }[] {
  if (scope === "all") return [...new Set(plan.pages.map((page) => page.section))].sort().map((section) => ({ key: section, label: section, pages: plan.pages.filter((page) => page.section === section) }));
  return WHY.map((group) => ({ key: group.why, label: group.label, pages: plan.pages.filter((page) => page.why === group.why) })).filter((group) => group.pages.length > 0);
}

/**
 * What to ask the computer for. The whole wiki is named after the app ("Botkins wiki export"),
 * anything else after its first page. The whole wiki as Markdown, with nothing switched off, goes
 * out as the wiki folder itself (`everything`), with its guide, templates, index and log.
 */
export function exportRequest(plan: WikiExportPlan, scope: ExportScope, off: ReadonlySet<string>, format: WikiExportFormat): { format: WikiExportFormat; paths: string[]; title: string; everything?: boolean } {
  const title = scope === "all" ? "Botkins" : plan.title;
  const paths = plan.pages.filter((page) => !off.has(page.path)).map((page) => page.path);
  if (format === "zip" && scope === "all" && !plan.pages.some((page) => off.has(page.path))) return { format, paths: [], title, everything: true };
  return { format, paths, title };
}
