import { useState } from "react";
import { FolderKanban, Search } from "lucide-react";
import { globalAccess, grantOf } from "./access";
import type { Bot, BotAccessGrant, State } from "./types";
import "./records.css";
import "./access.css";

/** The bot page's Access card: all projects, or chosen ones. */
export default function BotAccess({ state, bot }: { state: State; bot: Bot }) {
  const grant = grantOf(bot);
  const everyone = globalAccess(state);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const projects = [...(state.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const q = query.trim().toLowerCase();
  const many = projects.length > 8;
  const set = (next: Partial<BotAccessGrant>) => {
    setError("");
    void window.botkins.setBotAccess(bot.id, { ...grant, ...next }).catch((e) => setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  };
  const toggle = (id: string, on: boolean) => set({ projects: on ? [...new Set([...grant.projects, id])] : grant.projects.filter((x) => x !== id) });
  return (
    <section className="profile-card bot-access" aria-labelledby="bot-access-title">
      <h2 id="bot-access-title">Access</h2>
      <p className="muted">
        {everyone
          ? "All bots can use every project right now. What you choose here applies when that's turned off in Settings › Access."
          : "The projects " + bot.name + " can chat in."}
      </p>
      <label className="switch-row compact">
        <span>
          <strong>All projects</strong>
          <small>Includes ones you add later.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="All projects"
          checked={grant.all}
          onChange={(e) => set({ all: e.target.checked })}
        />
      </label>
      {!grant.all && (
        <>
          {many && (
            <label className="record-search access-search">
              <Search size={14} />
              <input type="search" aria-label="Filter projects" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          <fieldset className="checklist">
            <legend>
              <FolderKanban size={14} /> Projects
            </legend>
            {!projects.length && <small>No projects yet.</small>}
            {projects
              .filter((p) => !q || p.name.toLowerCase().includes(q))
              .map((p) => (
                <label key={p.id}>
                  <input type="checkbox" aria-label={p.name} checked={grant.projects.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                  <span>{p.name}</span>
                </label>
              ))}
          </fieldset>
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
