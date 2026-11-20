// Export… for the Wiki (src/Wiki.tsx): what to export, which pages, and the format. Markdown files go
// out as a .zip from the main process; a web page and a PDF are laid out here as one document
// (src/wikiExportDoc.tsx) and saved or printed by the main process.
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, Folder, Search } from "lucide-react";
import type { WikiExportPlan, WikiTree } from "./types";
import { Modal } from "./WikiDialogs";
import { GUIDE, byTitle, humanize, listed, plural } from "./wikiModel";

const api = window.botkins;
const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export type ExportScope = "all" | "project" | "page";
type Format = "zip" | "html" | "pdf";
const SCOPES: { id: ExportScope; label: string }[] = [
  { id: "all", label: "Whole wiki" },
  { id: "project", label: "A project" },
  { id: "page", label: "One page" },
];
const FORMATS: { id: Format; label: string; hint: string; short: string }[] = [
  { id: "zip", label: "Markdown files", hint: ".zip", short: ".zip" },
  { id: "html", label: "Web page", hint: ".html, one file", short: ".html" },
  { id: "pdf", label: "PDF", hint: ".pdf", short: "" },
];
const GROUPS: { why: WikiExportPlan["pages"][number]["why"]; label: string }[] = [
  { why: "start", label: "This page" },
  { why: "linked", label: "Linked with it" },
  { why: "related", label: "Related" },
];
const ABOUT: Record<ExportScope, string> = {
  all: "Every page in the wiki.",
  project: "The project's page, the pages linked with it, and the pages related to those.",
  page: "The page and the pages it is linked with.",
};

/** The scope a page's export starts on: a project's page exports with what is related to it. */
export function scopeFor(path: string): ExportScope {
  return /^projects\//i.test(path) ? "project" : "page";
}

export default function WikiExportDialog({ tree, start, close }: { tree: WikiTree; start?: string; close: () => void }) {
  const pages = useMemo(() => listed(tree).sort(byTitle), [tree]);
  const inSection = (section: string) => pages.filter((p) => p.path.toLowerCase().startsWith(section + "/"));
  const projects = inSection("projects");
  const firstScope = start ? scopeFor(start) : "all";
  const [scope, setScope] = useState<ExportScope>(firstScope);
  const [picked, setPicked] = useState<Record<ExportScope, string>>({
    all: "",
    project: firstScope === "project" ? start! : (projects[0]?.path ?? ""),
    page: start ?? pages.find((p) => p.path !== GUIDE)?.path ?? "",
  });
  const path = picked[scope];
  const [find, setFind] = useState("");
  const [plan, setPlan] = useState<WikiExportPlan>();
  const [planError, setPlanError] = useState("");
  const [off, setOff] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<Format>("zip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const ask = useRef(0);

  useEffect(() => {
    const n = ++ask.current;
    setPlan(undefined);
    setPlanError("");
    setOff(new Set());
    if (scope !== "all" && !path) return;
    api
      .wikiExportPlan(scope === "all" ? { scope } : { scope, path })
      .then((p) => n === ask.current && setPlan(p))
      .catch((e) => n === ask.current && setPlanError(message(e)));
  }, [scope, path]);

  const chosen = plan ? plan.pages.filter((p) => !off.has(p.path)) : [];
  const groups =
    scope === "all"
      ? [...new Set((plan?.pages ?? []).map((p) => p.section))].sort().map((section) => ({ key: section, label: section, items: plan!.pages.filter((p) => p.section === section) }))
      : GROUPS.map((g) => ({ key: g.why, label: g.label, items: (plan?.pages ?? []).filter((p) => p.why === g.why) })).filter((g) => g.items.length);
  const toggle = (paths: string[], on: boolean) =>
    setOff((was) => {
      const next = new Set(was);
      for (const p of paths) on ? next.delete(p) : next.add(p);
      return next;
    });

  async function go() {
    if (!plan || !chosen.length || busy) return;
    setBusy(true);
    setError("");
    try {
      // The whole wiki is named after the app ("Botkins wiki export"); anything else after its first page.
      const title = scope === "all" ? "Botkins" : plan.title;
      let file: string | null;
      if (format === "zip")
        file = await api.exportWiki(
          scope === "all" && !off.size ? { format, title, everything: true } : { format, title, paths: chosen.map((p) => p.path) },
        );
      else {
        const [texts, { exportDocument }] = await Promise.all([api.wikiExportPages(chosen.map((p) => p.path)), import("./wikiExportDoc")]);
        file = await api.exportWiki({ format, title, html: exportDocument({ title, pages: texts }) });
      }
      if (file) setSaved(file);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (saved)
    return (
      <Modal title="Export finished" className="wiki-export" close={close}>
        <div className="wiki-export-done" role="status">
          <CircleCheck size={22} aria-hidden="true" />
          <div>
            <h2>Exported</h2>
            <p>
              Saved to <span className="wiki-export-path">{saved}</span>
            </p>
          </div>
        </div>
        <div className="ask-actions">
          <button type="button" className="secondary" onClick={() => void api.revealWikiExport().catch(() => {})}>
            <Folder size={14} aria-hidden="true" />
            Show in Finder
          </button>
          <button type="button" className="primary" autoFocus onClick={close}>
            Done
          </button>
        </div>
      </Modal>
    );

  const options = scope === "project" ? projects : [];
  const matches = scope === "page" ? pages.filter((p) => !find.trim() || p.title.toLowerCase().includes(find.trim().toLowerCase()) || p.path.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 60) : [];
  return (
    <Modal title="Export" className="wiki-export" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <h2>Export</h2>
        <fieldset className="wiki-export-field">
          <legend>What</legend>
          <div className="wiki-segmented" role="radiogroup" aria-label="What to export">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={scope === s.id}
                disabled={s.id === "project" && !projects.length}
                title={s.id === "project" && !projects.length ? "No project pages yet" : undefined}
                onClick={() => setScope(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {scope === "project" && (
            <label className="wiki-export-pick">
              <span className="sr-only">Project</span>
              <select value={path} onChange={(e) => setPicked((p) => ({ ...p, [scope]: e.target.value }))}>
                {options.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {scope === "page" && (
            <div className="wiki-export-find">
              <label className="wiki-export-search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">Find a page</span>
                <input type="search" placeholder="Find a page" value={find} onChange={(e) => setFind(e.target.value)} />
              </label>
              <ul className="wiki-export-pages" role="listbox" aria-label="Page">
                {matches.map((p) => (
                  <li
                    key={p.path}
                    role="option"
                    aria-selected={p.path === path}
                    tabIndex={p.path === path ? 0 : -1}
                    onClick={() => setPicked((x) => ({ ...x, page: p.path }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPicked((x) => ({ ...x, page: p.path }));
                      }
                    }}
                  >
                    <span>{p.title}</span>
                    <small>{p.path.includes("/") ? humanize(p.path.split("/")[0]) : "Top of the wiki"}</small>
                  </li>
                ))}
                {!matches.length && <li className="wiki-export-none">No page matches.</li>}
              </ul>
            </div>
          )}
          <small className="wiki-hint">{ABOUT[scope]}</small>
        </fieldset>
        <fieldset className="wiki-export-field">
          <legend>
            Which pages
            {plan && (
              <span className="wiki-export-count">
                {chosen.length === plan.pages.length ? plural(plan.pages.length, "page") : chosen.length + " of " + plan.pages.length + " pages"}
              </span>
            )}
          </legend>
          <div className="wiki-export-list" aria-busy={!plan && !planError}>
            {planError ? (
              <p className="wiki-form-error" role="alert">
                {planError}
              </p>
            ) : !plan ? (
              <p className="wiki-muted">Finding the pages…</p>
            ) : (
              groups.map((g) => {
                const all = g.items.every((p) => !off.has(p.path));
                const none = g.items.every((p) => off.has(p.path));
                return (
                  <div className="wiki-export-group" key={g.key} role="group" aria-label={g.label}>
                    <label className="wiki-export-check head">
                      <input
                        type="checkbox"
                        checked={all}
                        ref={(el) => {
                          if (el) el.indeterminate = !all && !none;
                        }}
                        onChange={(e) => toggle(g.items.map((p) => p.path), e.target.checked)}
                      />
                      <span>{g.label}</span>
                      <small>{g.items.length}</small>
                    </label>
                    {g.items.map((p) => (
                      <label className="wiki-export-check" key={p.path}>
                        <input type="checkbox" checked={!off.has(p.path)} onChange={(e) => toggle([p.path], e.target.checked)} />
                        <span>{p.title}</span>
                        {scope !== "all" && <small>{p.section}</small>}
                      </label>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </fieldset>
        <fieldset className="wiki-export-field">
          <legend>Format</legend>
          <div className="wiki-export-formats" role="radiogroup" aria-label="Format">
            {FORMATS.map((f) => (
              <label key={f.id} className={"wiki-export-format" + (format === f.id ? " on" : "")}>
                <input type="radio" name="wiki-export-format" checked={format === f.id} onChange={() => setFormat(f.id)} />
                <span>{f.label}</span>
                <small>{f.hint}</small>
                <span className="wiki-export-ext" aria-hidden="true">
                  {f.short}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="wiki-form-error">
            {error}
          </p>
        )}
        <div className="ask-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!plan || !chosen.length || busy}>
            {busy ? "Exporting…" : "Export…"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
